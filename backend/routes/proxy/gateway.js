'use strict';
/**
 * Gateway API for the Proxy-Tools module (HIX AI / BypassGPT).
 * Mounted at /api/crm/proxy/gateway.
 *
 * Authenticated by the LEASE TOKEN (Authorization: Bearer <lease>), re-validated on
 * EVERY request. No usage metering and no daily limits (by design):
 *
 *   POST /validate         → is this 30-min lease still usable? returns secondsRemaining + tool
 *   POST /session          → GATEWAY-ONLY (X-Gateway-Key): decrypted account cookie
 *                            bundle for the lease's bound account, server-to-server.
 *   POST /account-expired  → GATEWAY-ONLY: flag the bound account session_expired.
 *   POST /capture-session  → GATEWAY-ONLY: save cookies captured through the proxy.
 */
const crypto = require('crypto');
const express = require('express');
const router = express.Router();

const ProxyClient = require('../../models/proxy/ProxyClient');
const ProxyLease = require('../../models/proxy/ProxyLease');
const ProxyAccount = require('../../models/proxy/ProxyAccount');
const leaseUtil = require('../../utils/proxy/lease');
const vaultCrypto = require('../../utils/proxy/vaultCrypto');
const tools = require('../../utils/proxy/tools');
const { normalizeCookieBundle, buildCookieHeader } = require('../../utils/proxy/cookies');
const { verifyAccountCookies, applySupabaseRefresh } = require('../../utils/proxy/verify');
const claudeQuota = require('../../utils/proxy/claudeQuota');
const claudeUsage = require('../../utils/proxy/claudeUsage');
const claudeSettings = require('../../utils/proxy/claudeSettings');
const ActivityLog = require('../../models/ActivityLog');
const { apiLimiter, gatewayServiceLimiter, leaseValidateLimiter } = require('../../middleware/rateLimiter');
const vres = require('../../utils/proxy/validationResponse');
const launchStore = require('../../utils/launchStore');
const launchCode = require('../../utils/launchCode');

// ── Rate limiting: pick the bucket that matches who is actually calling ──────────────────────
// The blanket `router.use(apiLimiter)` this replaces keyed EVERY route on this router by client IP
// with a 100/15min budget. For Claude that is a single shared bucket for all clients at once,
// because Claude's overlay cannot read its lease JWT and so every backend call on its behalf is
// made server-to-server by the gateway, from the gateway's one stable egress IP. A single open tab
// spends that whole budget within a window, and the 429s that followed were surfaced as a terminal
// "session ended / Access could not be verified" screen (see leaseKey in middleware/rateLimiter.js).
// It also silently defeated /validate's dedicated validateLimiter, which exists precisely so
// liveness polling does not share the general API budget.
//
// Now: gateway-only endpoints (already authenticated by the shared PROXY_GATEWAY_KEY) and
// /validate are limited PER LEASE — the correct unit, since every route here carries one — and
// anything else keeps apiLimiter exactly as before. Every ceiling is still enforced.
const GATEWAY_SERVICE_PATHS = new Set([
  '/session', '/account-expired', '/capture-session',
  '/quota-precheck', '/usage-report', '/quota-release', '/quota-status',
  // One-time launch redemption is gateway-to-backend too, and arrives from the gateway's one
  // stable egress IP. It must NOT sit in the per-IP apiLimiter bucket, or a busy hour of
  // legitimate launches would rate-limit itself into "Access could not be verified".
  '/redeem-launch',
]);
router.use((req, res, next) => {
  const p = req.path || '';
  if (GATEWAY_SERVICE_PATHS.has(p)) return gatewayServiceLimiter(req, res, next);
  if (p === '/validate') return next();          // has its own per-lease limiter on the route
  return apiLimiter(req, res, next);
});

// Safe debug logger — IDs / statuses / counts only. NEVER cookies, tokens or secrets.
function dbg(fields) { try { console.log('[proxy]', JSON.stringify(fields)); } catch (_) {} }

// Gateway-only guard — the session endpoint returns decrypted secrets, so it
// requires a shared key only the gateway server holds (never the browser).
function requireGatewayKey(req, res, next) {
  const key = process.env.PROXY_GATEWAY_KEY;
  if (!key) { dbg({ evt: 'session', response_status: 503, code: 'vault_unconfigured' }); return res.status(503).json({ ok: false, code: 'vault_unconfigured' }); }
  const got = String(req.headers['x-gateway-key'] || '');
  const a = Buffer.from(got);
  const b = Buffer.from(key);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) {
    return res.status(403).json({ ok: false, code: 'forbidden' });
  }
  next();
}

function getLeaseToken(req) {
  const auth = req.headers.authorization;
  if (auth && auth.startsWith('Bearer ')) return auth.slice(7).trim();
  return (req.body && req.body.lease) || (req.query && req.query.lease) || null;
}

// Resolve + authoritatively validate a lease. For capture leases there is no client.
async function resolveLease(req) {
  const token = getLeaseToken(req);
  if (!token) return { ok: false, status: 401, code: 'lease_missing' };

  const payload = leaseUtil.verifyLease(token);
  if (!payload) return { ok: false, status: 401, code: 'lease_invalid' };
  if (!tools.isValidTool(payload.tool)) return { ok: false, status: 401, code: 'lease_invalid' };

  const lease = await ProxyLease.findById(payload.jti);
  if (!lease) return { ok: false, status: 401, code: 'lease_invalid' };
  if (String(lease.tool) !== String(payload.tool)) return { ok: false, status: 401, code: 'lease_invalid' };
  if (lease.revoked) return { ok: false, status: 403, code: 'lease_revoked' };
  if (!lease.isActive()) return { ok: false, status: 403, code: 'lease_expired' };

  // Capture leases (admin) carry no client; client leases must have an active plan.
  if (lease.capture || payload.cap) return { ok: true, lease, client: null, capture: true, tool: payload.tool };

  const client = await ProxyClient.findById(lease.proxyClientId);
  if (!client) return { ok: false, status: 403, code: 'client_not_found' };
  if (!client.isActive()) {
    return { ok: false, status: 403, code: client.isExpired() ? 'plan_expired' : 'client_disabled' };
  }
  return { ok: true, lease, client, capture: false, tool: payload.tool };
}

function secondsRemaining(lease, now = Date.now()) {
  return Math.max(0, Math.floor((new Date(lease.expiresAt).getTime() - now) / 1000));
}

// ─── Validate ───────────────────────────────────────────────────────────────
// Responses carry {valid, terminal, retryable, code, secondsRemaining, expiresAt,
// correlationId} so the overlay can tell a CONFIRMED denial (stop) from a transient
// infrastructure failure (keep retrying). Authorization itself is unchanged — every
// code that blocked before still blocks, with the same HTTP status.
router.post('/validate', leaseValidateLimiter, async (req, res) => {
  const startedAt = Date.now();
  try {
    const r = await resolveLease(req);
    if (!r.ok) {
      const body = vres.fail(r.code);
      dbg({
        evt: 'validate', route: '/validate', tool: null, response_status: r.status,
        code: r.code, terminal: body.terminal, latency_ms: Date.now() - startedAt,
        correlation_id: body.correlationId, lease_ref: vres.hashRef(getLeaseToken(req)),
        error_source: 'lease_check',
      });
      return res.status(r.status).json(body);
    }
    return res.json(vres.ok(r.lease, {
      tool: r.tool,
      toolName: (tools.publicInfo(r.tool) || {}).name || r.tool,
      secondsRemaining: secondsRemaining(r.lease),
    }));
  } catch (err) {
    // A backend fault is NOT an authorization decision. It is explicitly retryable, so a
    // DB blip or a Passenger restart can never permanently end a live session.
    const body = vres.fail('server_error');
    console.error('Proxy gateway validate error:', err.message, 'cid=' + body.correlationId);
    dbg({
      evt: 'validate', route: '/validate', response_status: 500, code: 'server_error',
      terminal: false, latency_ms: Date.now() - startedAt, correlation_id: body.correlationId,
      error_source: 'exception',
    });
    return res.status(500).json(body);
  }
});

// ─── One-time launch redemption (gateway-only) ───────────────────────────────
// The gateway POSTs the code it received in a form body; we redeem it atomically, RE-CHECK
// authorization from scratch, and only then sign the lease token — which is returned
// server-to-server and never reaches the browser.
//
// Re-validating here is the point, not ceremony: the code was minted at click time, and an
// admin may have revoked the lease, disabled the client or let the plan lapse in the seconds
// since. Every check that guards a live request guards this one too, so a launch can never
// out-run a revocation.
router.post('/redeem-launch', requireGatewayKey, async (req, res) => {
  const startedAt = Date.now();
  const rawCode = req.body && req.body.code;
  try {
    const r = await launchStore.redeem(rawCode);
    if (!r.ok) {
      // Logged by non-reversible reference only — the code itself is never written anywhere.
      dbg({ evt: 'redeem_launch', response_status: 400, code: r.code, code_ref: launchCode.ref(rawCode), latency_ms: Date.now() - startedAt });
      return res.status(400).json({ ok: false, code: r.code });
    }
    const rec = r.record;
    if (rec.module !== 'proxy' || !rec.leaseId) {
      dbg({ evt: 'redeem_launch', response_status: 400, code: 'launch_code_invalid', reason: 'module_mismatch' });
      return res.status(400).json({ ok: false, code: 'launch_code_invalid' });
    }

    const lease = await ProxyLease.findById(rec.leaseId);
    if (!lease) return res.status(403).json({ ok: false, code: 'lease_invalid' });
    if (lease.revoked) return res.status(403).json({ ok: false, code: 'lease_revoked' });
    if (!lease.isActive()) return res.status(403).json({ ok: false, code: 'lease_expired' });
    if (!tools.isValidTool(lease.tool)) return res.status(403).json({ ok: false, code: 'lease_invalid' });

    const capture = !!(lease.capture || rec.capture);
    if (!capture) {
      const client = await ProxyClient.findById(lease.proxyClientId);
      if (!client) return res.status(403).json({ ok: false, code: 'client_not_found' });
      if (!client.isActive()) {
        return res.status(403).json({ ok: false, code: client.isExpired() ? 'plan_expired' : 'client_disabled' });
      }
    }

    // Sign for exactly the remaining life of the lease ROW, which stays the authority: the
    // token can never outlive it, and /validate re-checks the row on every navigation.
    const remainingSec = Math.max(1, Math.floor((new Date(lease.expiresAt).getTime() - Date.now()) / 1000));
    const token = leaseUtil.signLease({
      jti: lease._id,
      userId: lease.userId,
      tool: lease.tool,
      accountId: lease.accountId || undefined,
      capture,
      ttlSeconds: remainingSec,
    });
    lease.tokenHash = leaseUtil.hashToken(token); // hash only, as before — never the token
    await lease.save();

    dbg({
      evt: 'redeem_launch', response_status: 200, tool: lease.tool, lease_id: lease._id,
      account_id: lease.accountId || null, capture, seconds_remaining: remainingSec,
      latency_ms: Date.now() - startedAt,
    });
    res.set('Cache-Control', 'no-store');
    return res.json({
      ok: true,
      lease: token,               // server-to-server only
      tool: lease.tool,
      capture,
      expiresAt: lease.expiresAt,
      secondsRemaining: remainingSec,
    });
  } catch (err) {
    console.error('Proxy redeem-launch error:', err.message);
    return res.status(500).json({ ok: false, code: 'server_error' });
  }
});

// ─── Session (gateway-only) ──────────────────────────────────────────────────
router.post('/session', requireGatewayKey, async (req, res) => {
  try {
    const r = await resolveLease(req);
    if (!r.ok) return res.status(r.status).json({ ok: false, code: r.code });

    if (!r.lease.accountId) return res.json({ ok: true, account: null });

    const account = await ProxyAccount.findById(r.lease.accountId);
    if (!account) return res.json({ ok: true, account: null });
    if (account.status === 'blocked') return res.json({ ok: false, blocked: true, code: 'account_blocked' });

    let bundle = null;
    try { if (account.sessionEncrypted) bundle = JSON.parse(vaultCrypto.decrypt(account.sessionEncrypted)); }
    catch (_) { bundle = null; }
    if (!bundle) return res.json({ ok: false, blocked: true, code: 'account_no_session' });

    // Claude model allowlist: hand the gateway the admin's current "Allow Fable 5" setting on
    // the call it already makes for every session, so a change in the admin panel takes effect
    // within the gateway's short session cache — no redeploy and no new endpoint. Sent only for
    // Claude, and only ever a boolean (never a secret). If the settings load fails we send
    // false, i.e. blocked, so an error can never silently re-enable the model.
    const extra = {};
    if (r.tool === 'claude') {
      let allowFable5 = false;
      try { await claudeSettings.ensureLoaded(); allowFable5 = !!claudeSettings.flags().allowFable5; } catch (_) { allowFable5 = false; }
      extra.allowFable5 = allowFable5;
    }
    return res.json(Object.assign({
      ok: true,
      account: { id: account._id, status: account.status, label: account.label }, // label for server-side logs only
      bundle,
    }, extra));
  } catch (err) {
    console.error('Proxy gateway session error:', err.message);
    return res.status(500).json({ ok: false, code: 'server_error' });
  }
});

// ─── Account expired signal (gateway-only) ───────────────────────────────────
// The gateway SIGNALS a possible logout (e.g. an upstream redirect to /sign-in on a nav).
//
// For EVERY tool EXCEPT WriteHuman the behavior is UNCHANGED: the signal is a reliable logout
// indicator (server-rendered tools redirect to /sign-in only when the session is genuinely
// dead), so the account is flagged session_expired immediately, exactly as before.
//
// WriteHuman ALONE is handled differently because it is a client-side Supabase SPA: its
// access-token JWT lapses on a ~30-min timer even though the refresh token (and thus the
// session) is still valid, which made the signal fire on a timer and falsely expire live
// accounts. For WriteHuman we AUTHORITATIVELY CONFIRM with the Supabase refresh verifier and
// flag session_expired ONLY when verification proves the session can no longer authenticate;
// a still-valid session is left active (and its rotated tokens persisted). No other tool's
// path is affected.
router.post('/account-expired', requireGatewayKey, async (req, res) => {
  try {
    const r = await resolveLease(req);
    if (!r.ok) return res.status(r.status).json({ ok: false, code: r.code });
    if (!r.lease.accountId) return res.json({ ok: true, updated: false });
    const account = await ProxyAccount.findById(r.lease.accountId);
    if (!account || account.status !== 'active') return res.json({ ok: true, updated: false });

    // Non-WriteHuman tools: ORIGINAL behavior — trust the gateway signal and expire immediately.
    if (tools.verifyMode(account.tool) !== 'supabase_refresh') {
      account.status = 'session_expired';
      account.session_status = 'session_expired';
      account.verification = { result: 'session_expired', maskedId: account.verification?.maskedId || null, httpStatus: 0, checkedAt: new Date() };
      await account.save();
      dbg({ evt: 'account_expired', tool: r.tool, account_id: account._id, updated: true });
      return res.json({ ok: true, updated: true });
    }

    // ── WriteHuman only ───────────────────────────────────────────────────────
    // Confirm with a live verification of the account's own stored cookies before expiring.
    let v = null, bundle = null;
    try {
      const host = tools.targetHost(account.tool);
      try { if (account.sessionEncrypted) bundle = JSON.parse(vaultCrypto.decrypt(account.sessionEncrypted)); } catch (_) {}
      const cookieHeader = bundle ? buildCookieHeader(bundle, host) : '';
      v = await verifyAccountCookies(account.tool, cookieHeader, account.expectedIdentifier);
    } catch (_) { v = null; }

    // Record ground-truth verification when we have it (safe fields only — never secrets).
    if (v) {
      account.verification = { result: v.result, maskedId: v.maskedId || (account.verification?.maskedId || null), httpStatus: v.httpStatus, checkedAt: new Date() };
      account.lastVerifiedAt = new Date();
    }

    // WriteHuman: if verification refreshed (rotated) the Supabase session, persist it back so
    // the stored cookies stay live and a later check doesn't fail on a consumed refresh token.
    // Fail-safe; only set for supabase_refresh, so no other tool is affected.
    if (v && v.result === 'working' && v.refreshedSession && bundle) {
      try {
        const ref = (tools.supabaseConfig(account.tool) || {}).projectRef;
        const updated = applySupabaseRefresh(bundle, ref, v.refreshedSession);
        if (updated) {
          account.sessionEncrypted = vaultCrypto.encrypt(JSON.stringify(updated));
          account.sessionMeta = Object.assign({}, account.sessionMeta || {}, { updatedAt: new Date() });
        }
      } catch (_) { /* persist is best-effort */ }
    }

    // Expire ONLY on a confirmed loss of authentication. 'working'/'wrong_account'/'unknown'/
    // 'unsupported' or a failed verification do NOT expire the account.
    if (v && v.result === 'session_expired') {
      account.status = 'session_expired';
      account.session_status = v.loggedOut ? 'needs_login' : 'session_expired';
      await account.save();
      dbg({ evt: 'account_expired', tool: r.tool, account_id: account._id, updated: true, confirmed: true, verify_result: v.result });
      return res.json({ ok: true, updated: true });
    }

    // Not confirmed → keep the account active; persist any refreshed verification info.
    if (v) { try { await account.save(); } catch (_) {} }
    dbg({ evt: 'account_expired', tool: r.tool, account_id: account._id, updated: false, confirmed: false, verify_result: v ? v.result : 'verify_failed' });
    return res.json({ ok: true, updated: false });
  } catch (err) {
    console.error('Proxy account-expired error:', err.message);
    return res.status(500).json({ ok: false, code: 'server_error' });
  }
});

// ─── Capture session (gateway-only) — "Refresh Cookies Through Proxy" ─────────
router.post('/capture-session', requireGatewayKey, async (req, res) => {
  try {
    const token = getLeaseToken(req);
    const payload = token ? leaseUtil.verifyLease(token) : null;
    if (!payload) return res.status(401).json({ ok: false, code: 'lease_invalid' });
    if (!payload.cap) return res.status(403).json({ ok: false, code: 'not_capture_lease' });
    const lease = await ProxyLease.findById(payload.jti);
    if (!lease || lease.revoked) return res.status(403).json({ ok: false, code: 'lease_invalid' });
    const account = await ProxyAccount.findById(lease.accountId || payload.acid);
    if (!account) return res.status(404).json({ ok: false, code: 'account_not_found' });

    const targetHost = tools.targetHost(account.tool);
    const cookieBundle = normalizeCookieBundle(req.body && req.body.cookies);
    if (!cookieBundle || !cookieBundle.cookies || cookieBundle.cookies.length === 0) {
      return res.status(400).json({ ok: false, code: 'no_cookies_captured' });
    }
    cookieBundle.cookies = cookieBundle.cookies.map(c => ({ ...c, domain: c.domain || targetHost }));
    account.sessionEncrypted = vaultCrypto.encrypt(JSON.stringify(cookieBundle));
    account.sessionMeta = { cookieCount: cookieBundle.cookies.length, hasSessionCookie: true, hasLocalStorage: false, origin: tools.targetOrigin(account.tool), updatedAt: new Date() };
    account.status = 'active';
    account.session_status = 'working';
    account.verification = { result: 'working', maskedId: account.verification?.maskedId || null, httpStatus: 200, checkedAt: new Date() };
    await account.save();

    // The account's cookies were just REPLACED via capture (same as the admin paste flow).
    // Revoke its in-flight leases so the next launch mints a FRESH lease (new jti → gateway
    // cache miss → re-fetch of the new bundle from the DB) instead of an open/cached lease
    // continuing on the old session. Mirrors routes/admin/proxyTools.js :id/session.
    let revokedLeases = 0;
    try {
      const r = await ProxyLease.updateMany(
        { accountId: account._id, revoked: false },
        { $set: { revoked: true, revokedReason: 'session_refreshed', revokedAt: new Date() } }
      );
      revokedLeases = (r && (r.modifiedCount != null ? r.modifiedCount : r.nModified)) || 0;
    } catch (_) { /* non-fatal: cookies saved; an open lease self-heals within ~60s */ }

    dbg({ evt: 'capture_session', tool: account.tool, account_id: account._id, cookies_count_attached: cookieBundle.cookies.length, revoked_leases: revokedLeases });
    return res.json({ ok: true, cookiesSaved: cookieBundle.cookies.length, revokedLeases });
  } catch (err) {
    console.error('Proxy capture-session error:', err.message);
    return res.status(500).json({ ok: false, code: 'server_error' });
  }
});

// ════════════════════════════════════════════════════════════════════════════
// CLAUDE TOKEN QUOTA (gateway-only) — estimated local token usage, no secrets
// ════════════════════════════════════════════════════════════════════════════
// The claude-gateway calls these server-to-server (X-Gateway-Key) around each Claude
// completion request. They ONLY ever receive integer CHARACTER COUNTS — never prompt text,
// cookies, sessions or account internals — and the numeric policy lives in claudeQuota.

const CHAR_CAP = 50 * 1000 * 1000; // clamp any single count (defensive; keys are gateway-only)
function clampChars(v) { return Math.min(CHAR_CAP, Math.max(0, Math.trunc(Number(v) || 0))); }

function charParts(body) {
  const b = body || {};
  return {
    inputChars: clampChars(b.inputChars),
    systemChars: clampChars(b.systemChars),
    contextChars: clampChars(b.contextChars),
    attachmentChars: clampChars(b.attachmentChars),
  };
}

// Resolve the client + bound account for a metering call. Claude client leases only.
async function resolveMeterContext(req) {
  const r = await resolveLease(req);
  if (!r.ok) return { ok: false, status: r.status, code: r.code };
  if (r.tool !== 'claude') return { ok: false, status: 400, code: 'not_claude' };
  if (r.capture || !r.client) return { ok: false, status: 400, code: 'capture_lease' };
  const account = r.lease.accountId ? await ProxyAccount.findById(r.lease.accountId) : null;
  return { ok: true, client: r.client, account, lease: r.lease };
}

// ─── Quota pre-check (gateway-only) — is one more request within allowance? ───
// Returns { ok, allowed, mode, estIncoming, usage }. In 'count' mode `allowed` is always true
// (never blocks a message); in 'enforce' mode `allowed` reflects the real gate. Fail-OPEN on
// any server error so a metering hiccup never blocks a Claude message.
router.post('/quota-precheck', requireGatewayKey, async (req, res) => {
  try {
    const mode = claudeQuota.quotaMode();
    const ctx = await resolveMeterContext(req);
    if (!ctx.ok) return res.status(ctx.status).json({ ok: false, code: ctx.code, allowed: true }); // fail-open
    if (mode === 'off') return res.json({ ok: true, allowed: true, mode });
    await claudeSettings.ensureLoaded(); // apply admin global defaults before resolving limits

    const parts = charParts(req.body);
    const estIncoming = claudeQuota.estimateRequestTokens(parts);
    const requestId = req.body && req.body.requestId ? String(req.body.requestId).slice(0, 80) : null;
    const enforced = mode === 'enforce';

    if (!enforced) {
      // 'count' mode: measure only — never blocks a message and takes NO reservation. Report the
      // current picture for display/telemetry.
      const u = await claudeUsage.readUsage(ctx.account, ctx.client);
      const decision = claudeUsage.resolveDecision({
        account: ctx.account, client: ctx.client,
        clientUsed: u.clientUsed, accountUsed: u.accountUsed,
        weeklyClientUsed: u.weeklyClientUsed, weeklyAccountUsed: u.weeklyAccountUsed, estIncoming,
      });
      const weekly = decision.reason === 'weekly_client_limit' || decision.reason === 'weekly_account_capacity';
      return res.json({
        ok: true, allowed: true, mode, estIncoming, requestId,
        window: weekly ? 'weekly' : '5-hour',
        resetInSeconds: claudeQuota.secondsUntilReset(weekly ? u.keys.weekWindow : u.keys.fiveWindow),
        usage: claudeQuota.presentDecision(decision),
      });
    }

    // 'enforce' mode: STRICTLY reserve the estimate atomically, then decide with
    //   used + reserved(this + earlier) + est ≤ effective limit  for BOTH windows + shared account.
    // A denied request holds NO reservation (rolled back). The reservation is settled or released
    // by /usage-report or /quota-release. Fail-OPEN inside reserveAndCheck on any DB error.
    const rc = await claudeUsage.reserveAndCheck({
      account: ctx.account, client: ctx.client, userId: ctx.client.userId,
      estTokens: estIncoming, requestId,
    });
    const decision = rc.decision || {};
    if (!rc.allowed) {
      dbg({ evt: 'quota_block', tool: 'claude', reason: rc.reason, est: estIncoming, client_used: decision.clientUsed, acct_used: decision.accountUsed });
      ActivityLog.log('CLIENT', ctx.client.userId, 'PROXY_CLAUDE_QUOTA_BLOCK_REQUEST', {
        tool: 'claude', proxyClientId: ctx.client._id, reason: rc.reason, estIncoming,
        clientUsed: decision.clientUsed, clientLimit: decision.clientLimit,
        weeklyClientUsed: decision.weeklyClientUsed, weeklyClientLimit: decision.weeklyClientLimit,
        accountUsed: decision.accountUsed, accountCapacity: decision.accountCapacity,
      }).catch(() => {});
    }
    return res.json({
      ok: true, allowed: rc.allowed, mode, estIncoming, requestId: rc.requestId || requestId,
      reserved: !!rc.reserved, window: rc.window,
      resetInSeconds: rc.resetInSeconds,
      usage: claudeQuota.presentDecision(decision),
    });
  } catch (err) {
    console.error('Proxy quota-precheck error:', err.message);
    return res.status(200).json({ ok: false, allowed: true, code: 'server_error' }); // fail-open
  }
});

// ─── Usage report (gateway-only) — settle a completed request into the ledger ─
// Appends ONE ledger row (append-only → race-safe). Fail-safe: always 200 so the gateway never
// retries in a hot loop and never surfaces an error to the client.
router.post('/usage-report', requireGatewayKey, async (req, res) => {
  try {
    if (claudeQuota.quotaMode() === 'off') return res.json({ ok: true, recorded: false });
    const ctx = await resolveMeterContext(req);
    if (!ctx.ok) return res.json({ ok: true, recorded: false, code: ctx.code });

    const parts = charParts(req.body);
    // Break the estimate into components for the admin history: input (prompt) vs context
    // (system + context + attachments) vs output. The TOTAL is identical to before (their sum).
    const inputTokens = claudeQuota.tokensFromChars(parts.inputChars);
    const contextTokens = claudeQuota.tokensFromChars(parts.systemChars + parts.contextChars + parts.attachmentChars);
    const outputTokens = claudeQuota.tokensFromChars(clampChars(req.body && req.body.outputChars));
    const requestId = req.body && req.body.requestId ? String(req.body.requestId).slice(0, 80) : null;
    // Even a zero-token completion must free its reservation (the request finished) — otherwise the
    // held estimate would linger until the TTL.
    if (inputTokens === 0 && contextTokens === 0 && outputTokens === 0) {
      const accountId = ctx.account && ctx.account._id ? String(ctx.account._id) : null;
      await claudeUsage.releaseReservation({ accountId, requestId }).catch(() => {});
      return res.json({ ok: true, recorded: false });
    }

    // Settle: release this request's reservation (if any) and record the ACTUAL usage, deduped by
    // requestId so a re-send can never double-charge.
    const r = await claudeUsage.settleUsage({
      account: ctx.account, client: ctx.client, userId: ctx.client.userId,
      inputTokens, contextTokens, outputTokens, requestId,
    });
    claudeUsage.pruneOld().catch(() => {}); // opportunistic, best-effort
    dbg({ evt: 'usage_report', tool: 'claude', in: inputTokens, ctx: contextTokens, out: outputTokens, recorded: r.recorded, duplicate: r.duplicate });
    return res.json({ ok: true, recorded: r.recorded, duplicate: r.duplicate, inputTokens, contextTokens, outputTokens });
  } catch (err) {
    console.error('Proxy usage-report error:', err.message);
    return res.status(200).json({ ok: false, recorded: false, code: 'server_error' });
  }
});

// ─── Quota release (gateway-only) — free a reservation for a request that never completed ─────
// Called by the gateway when a reserved Claude request fails/aborts upstream, so a blocked or
// dead request never holds quota until its TTL. Idempotent + fail-safe (always 200).
router.post('/quota-release', requireGatewayKey, async (req, res) => {
  try {
    if (claudeQuota.quotaMode() !== 'enforce') return res.json({ ok: true, released: false });
    const ctx = await resolveMeterContext(req);
    if (!ctx.ok) return res.json({ ok: true, released: false, code: ctx.code });
    const requestId = req.body && req.body.requestId ? String(req.body.requestId).slice(0, 80) : null;
    const accountId = ctx.account && ctx.account._id ? String(ctx.account._id) : null;
    const r = await claudeUsage.releaseReservation({ accountId, requestId });
    return res.json({ ok: true, released: !!(r && r.released), count: (r && r.count) || 0 });
  } catch (err) {
    console.error('Proxy quota-release error:', err.message);
    return res.status(200).json({ ok: false, released: false, code: 'server_error' });
  }
});

// ─── Quota status (gateway-only) — READ-ONLY usage snapshot for the widget ────
// Returns the client's current five-hour AND weekly ESTIMATED usage for display in the overlay
// widget. It records NOTHING (no ledger write, no side effects) and exposes ONLY client-safe
// figures — never an account id/label/plan-secret. Fail-safe: on any error it returns
// `synced:false` so the widget shows "Not synced" rather than a fabricated 0.
router.post('/quota-status', requireGatewayKey, async (req, res) => {
  try {
    const mode = claudeQuota.quotaMode();
    if (mode === 'off') return res.json({ ok: true, enabled: false, mode });
    const ctx = await resolveMeterContext(req);
    if (!ctx.ok) return res.json({ ok: true, enabled: true, mode, synced: false, code: ctx.code });
    await claudeSettings.ensureLoaded(); // apply admin global defaults before resolving limits

    const u = await claudeUsage.readUsage(ctx.account, ctx.client);
    const status = claudeUsage.usageStatus({ account: ctx.account, client: ctx.client, usage: u });
    return res.json({ ok: true, enabled: true, mode, synced: u.synced, status });
  } catch (err) {
    console.error('Proxy quota-status error:', err.message);
    return res.json({ ok: true, enabled: true, synced: false, code: 'server_error' });
  }
});

module.exports = router;
