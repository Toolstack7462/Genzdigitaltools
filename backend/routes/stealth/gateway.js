'use strict';
/**
 * Gateway API for the StealthWriter Proxy Gateway module.
 * Mounted at /api/crm/stealth/gateway.
 *
 * These endpoints are authenticated by the LEASE TOKEN (not a session cookie):
 * the proxy gateway / overlay passes the lease as `Authorization: Bearer <lease>`
 * or in the JSON body. The backend re-validates the lease, the client's status,
 * plan expiry and daily limits on EVERY request — the overlay is never trusted.
 *
 *   POST /validate  → is this lease still usable? returns remaining + secondsRemaining
 *   POST /consume   → LEGACY charge-on-click (increments before the upstream call). Kept
 *                     working only so an older cached overlay still meters during a rollout.
 *   POST /usage/reserve | /usage/commit | /usage/cancel
 *                   → GATEWAY-ONLY (X-Gateway-Key) reserve → commit/cancel lifecycle. A
 *                     Humanizer/Detector credit is spent ONLY at /usage/commit, and only
 *                     after the gateway has verified a real result from the upstream
 *                     response — never on the click, the dispatch or a loading state.
 *   POST /session   → GATEWAY-ONLY (X-Gateway-Key): returns the decrypted account
 *                     session bundle for the lease's bound account, server-to-server.
 *                     Never reachable from a browser (key is gateway-only) and never
 *                     exposed to /validate or /consume.
 */
const crypto = require('crypto');
const express = require('express');
const router = express.Router();

const StealthClient = require('../../models/stealth/StealthClient');
const StealthLease = require('../../models/stealth/StealthLease');
const StealthUsageLog = require('../../models/stealth/StealthUsageLog');
const StealthAccount = require('../../models/stealth/StealthAccount');
const access = require('../../utils/stealth/access');
const leaseUtil = require('../../utils/stealth/lease');
const vaultCrypto = require('../../utils/stealth/vaultCrypto');
const { normalizeCookieBundle } = require('../../utils/stealth/cookies');
const { getClientIp } = require('../../middleware/authEnhanced');

const TARGET_HOST = (() => {
  try { return new URL(process.env.STEALTH_TARGET_ORIGIN || 'https://stealthwriter.ai').hostname; }
  catch (_) { return 'stealthwriter.ai'; }
})();
const { apiLimiter, leaseValidateLimiter, gatewayServiceLimiter } = require('../../middleware/rateLimiter');
const vres = require('../../utils/proxy/validationResponse');
const { nextResetAt, RESET_LABEL } = require('../../utils/stealth/time');
const launchStore = require('../../utils/launchStore');
const launchCode = require('../../utils/launchCode');

// ── Rate limiting: key by the unit that actually varies per client ───────────────────────────
// WHO CALLS THESE CHANGED, so the keying had to change with it. The StealthWriter overlay used
// to call /validate and /consume DIRECTLY FROM THE BROWSER, so a per-IP budget was per-client
// and correct — which is exactly why rateLimiter.js says validateLimiter "is left exactly as it
// is, so the StealthWriter router keeps its current per-IP behaviour".
//
// That premise is now false. The lease lives in an HttpOnly cookie the page cannot read, so the
// overlay calls the GATEWAY's same-origin /__genz/validate and /__genz/consume and the gateway
// relays them server-side — from its ONE stable egress IP. Under the old keying every
// StealthWriter client would share a single bucket: 400/15min for all validate polling, and
// just 100/15min (apiLimiter) for ALL humanize/detect actions across every user. That is the
// same shared-bucket failure that surfaced on Claude as a terminal "session ended" screen
// (see the leaseKey comment in middleware/rateLimiter.js and tests/gatewayRateLimit.test.js).
//
// Both routes carry the lease as a Bearer token, so key on THAT — one bucket per session. It is
// also correct for an OLD cached overlay still calling the backend directly during a rollout,
// because the lease is present either way. Every ceiling is still enforced; only the key
// changed. Everything else on this router keeps the per-IP apiLimiter it has always had.
const LEASE_KEYED_PATHS = new Set([
  '/validate', '/consume', '/redeem-launch',
  // Same reason as /consume: these arrive from the gateway's ONE egress IP, so a per-IP
  // budget would be shared by every StealthWriter client at once. Each is lease-keyed on
  // the route below (gatewayServiceLimiter).
  '/usage/reserve', '/usage/commit', '/usage/cancel',
]);
router.use((req, res, next) => {
  if (LEASE_KEYED_PATHS.has(req.path || '')) return next(); // limited per-lease on the route
  return apiLimiter(req, res, next);
});

// Safe debug logger — IDs / statuses / counts only. NEVER cookies, tokens or secrets.
function dbg(fields) { try { console.log('[stealth]', JSON.stringify(fields)); } catch (_) {} }

// Gateway-only guard: the session endpoint returns decrypted secrets, so it
// requires a shared key that ONLY the gateway server holds (never the browser).
function requireGatewayKey(req, res, next) {
  const key = process.env.STEALTH_GATEWAY_KEY;
  if (!key) { dbg({ evt: 'session', response_status: 503, code: 'vault_unconfigured', error_source: 'genz_api' }); return res.status(503).json({ ok: false, code: 'vault_unconfigured' }); }
  const got = String(req.headers['x-gateway-key'] || '');
  const a = Buffer.from(got);
  const b = Buffer.from(key);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) {
    dbg({ evt: 'session', response_status: 403, code: 'forbidden', error_source: 'genz_api' });
    return res.status(403).json({ ok: false, code: 'forbidden' });
  }
  next();
}

function getLeaseToken(req) {
  const auth = req.headers.authorization;
  if (auth && auth.startsWith('Bearer ')) return auth.slice(7).trim();
  return (req.body && req.body.lease) || (req.query && req.query.lease) || null;
}

// Resolve and authoritatively validate a lease from the request.
async function resolveLease(req) {
  const token = getLeaseToken(req);
  if (!token) return { ok: false, status: 401, code: 'lease_missing' };

  const payload = leaseUtil.verifyLease(token);
  if (!payload) return { ok: false, status: 401, code: 'lease_invalid' };

  const lease = await StealthLease.findById(payload.jti);
  if (!lease) return { ok: false, status: 401, code: 'lease_invalid' };
  if (lease.revoked) return { ok: false, status: 403, code: 'lease_revoked' };
  if (!lease.isActive()) return { ok: false, status: 403, code: 'lease_expired' };

  const client = await StealthClient.findById(lease.stealthClientId);
  if (!client) return { ok: false, status: 403, code: 'client_not_found' };

  return { ok: true, lease, client };
}

function secondsRemaining(lease, now = Date.now()) {
  return Math.max(0, Math.floor((new Date(lease.expiresAt).getTime() - now) / 1000));
}

// ─── One-time launch redemption (gateway-only) ───────────────────────────────
// The StealthWriter gateway POSTs the launch code it received in a form body. We redeem it
// atomically (utils/launchStore.js), RE-CHECK authorization from scratch, and only then sign
// the lease — returned server-to-server, never to the browser.
//
// Plan status, expiry and revocation are re-read here rather than trusted from click time, so
// an admin action in the seconds between the click and the landing still takes effect. Daily
// Humanizer/Detector limits are deliberately NOT re-checked here: they are enforced per action
// by /consume, exactly as before, and blocking the launch on them would change behaviour.
router.post('/redeem-launch', gatewayServiceLimiter, requireGatewayKey, async (req, res) => {
  const startedAt = Date.now();
  const rawCode = req.body && req.body.code;
  try {
    const r = await launchStore.redeem(rawCode);
    if (!r.ok) {
      dbg({ evt: 'redeem_launch', response_status: 400, code: r.code, code_ref: launchCode.ref(rawCode), latency_ms: Date.now() - startedAt });
      return res.status(400).json({ ok: false, code: r.code });
    }
    const rec = r.record;
    if (rec.module !== 'stealth' || !rec.leaseId) {
      dbg({ evt: 'redeem_launch', response_status: 400, code: 'launch_code_invalid', reason: 'module_mismatch' });
      return res.status(400).json({ ok: false, code: 'launch_code_invalid' });
    }

    const lease = await StealthLease.findById(rec.leaseId);
    if (!lease) return res.status(403).json({ ok: false, code: 'lease_invalid' });
    if (lease.revoked) return res.status(403).json({ ok: false, code: 'lease_revoked' });
    if (!lease.isActive()) return res.status(403).json({ ok: false, code: 'lease_expired' });

    const capture = !!(lease.capture || rec.capture);
    if (!capture) {
      const client = await StealthClient.findById(lease.stealthClientId);
      if (!client) return res.status(403).json({ ok: false, code: 'client_not_found' });
      const status = access.assessStatus(client);
      if (!status.allowed) return res.status(403).json({ ok: false, code: status.reason });
    }

    // Signed for exactly the remaining life of the lease ROW, which stays the authority.
    const remainingSec = Math.max(1, Math.floor((new Date(lease.expiresAt).getTime() - Date.now()) / 1000));
    const token = leaseUtil.signLease({
      jti: lease._id,
      userId: lease.userId,
      stealthClientId: lease.stealthClientId,
      accountId: lease.accountId || undefined,
      fixed: !!lease.fixedLease,
      capture,
      ttlSeconds: remainingSec,
    });
    lease.tokenHash = leaseUtil.hashToken(token); // hash only, as before
    await lease.save();

    dbg({
      evt: 'redeem_launch', response_status: 200, lease_id: lease._id,
      account_id: lease.accountId || null, capture, seconds_remaining: remainingSec,
      latency_ms: Date.now() - startedAt,
    });
    res.set('Cache-Control', 'no-store');
    return res.json({
      ok: true,
      lease: token,
      capture,
      fixedLease: !!lease.fixedLease,
      expiresAt: lease.expiresAt,
      secondsRemaining: remainingSec,
    });
  } catch (err) {
    console.error('Stealth redeem-launch error:', err.message);
    return res.status(500).json({ ok: false, code: 'server_error' });
  }
});

// ─── Validate ───────────────────────────────────────────────────────────────
// Same structured contract as the proxy-tools gateway (see
// utils/proxy/validationResponse.js): {valid, terminal, retryable, code, secondsRemaining,
// expiresAt, correlationId}. The plan/usage payload below is unchanged — StealthWriter's
// metering, limits and reset labels behave exactly as before.
router.post('/validate', leaseValidateLimiter, async (req, res) => {
  const startedAt = Date.now();
  try {
    const r = await resolveLease(req);
    if (!r.ok) {
      const body = vres.fail(r.code);
      dbg({
        evt: 'validate', route: '/validate', tool: 'stealth', response_status: r.status,
        code: r.code, terminal: body.terminal, latency_ms: Date.now() - startedAt,
        correlation_id: body.correlationId, error_source: 'lease_check',
      });
      return res.status(r.status).json(body);
    }

    const snap = await access.snapshot(r.client);
    const status = access.assessStatus(r.client);
    if (!status.allowed) {
      const body = vres.fail(status.reason, { plan: { status: snap.status, expired: snap.expired } });
      dbg({ evt: 'validate', route: '/validate', tool: 'stealth', lease_id: r.lease._id, account_id: r.lease.accountId || null, client_id: r.client._id, response_status: 403, code: status.reason, terminal: body.terminal, latency_ms: Date.now() - startedAt, correlation_id: body.correlationId, error_source: 'account_check' });
      return res.status(403).json(body);
    }
    return res.json(vres.ok(r.lease, {
      secondsRemaining: secondsRemaining(r.lease),
      fixedLease: r.lease.fixedLease,
      plan: {
        planName: snap.planName,
        limits: snap.limits,
        used: snap.used,
        remaining: snap.remaining,
        expiryDate: snap.expiryDate,
      },
      resetLabel: RESET_LABEL,
      nextResetAt: nextResetAt(),
    }));
  } catch (err) {
    // Retryable by design — a DB/backend fault must never end a live StealthWriter session.
    const body = vres.fail('server_error');
    console.error('Stealth gateway validate error:', err.message, 'cid=' + body.correlationId);
    dbg({ evt: 'validate', route: '/validate', tool: 'stealth', response_status: 500, code: 'server_error', terminal: false, latency_ms: Date.now() - startedAt, correlation_id: body.correlationId, error_source: 'exception' });
    return res.status(500).json(body);
  }
});

// ─── Consume (humanizer / detector) ─────────────────────────────────────────
// Metering, unchanged — but now relayed by the gateway, so it is limited PER LEASE rather than
// per IP. gatewayServiceLimiter is the right bucket: generous (1200/15min, far above what one
// 30-minute lease can spend on real humanize/detect actions), lease-keyed, and its 429 is
// explicitly retryable so a burst can never be read as an ended session or a lost credit.
router.post('/consume', gatewayServiceLimiter, async (req, res) => {
  try {
    const r = await resolveLease(req);
    if (!r.ok) return res.status(r.status).json({ allowed: false, code: r.code });

    const action = String((req.body && req.body.action) || '').toLowerCase();
    if (!access.ACTIONS.includes(action)) {
      return res.status(400).json({ allowed: false, code: 'invalid_action' });
    }

    const decision = await access.consume(r.client, action);

    dbg({
      evt: 'consume', action_type: action,
      lease_id: r.lease._id, account_id: r.lease.accountId || null, client_id: r.client._id,
      response_status: 200, allowed: decision.allowed, reason: decision.reason,
      error_source: decision.allowed ? null : (decision.reason === 'limit_reached' ? 'usage_limit' : 'account_check'),
    });

    await StealthUsageLog.record({
      userId: r.client.userId,
      stealthClientId: r.client._id,
      leaseId: r.lease._id,
      accountId: r.lease.accountId || null,
      accountLabel: r.lease.accountLabel || null, // internal account label only — no secrets
      action,
      allowed: decision.allowed,
      reason: decision.reason,
      remainingHumanizer: decision.remaining.humanizer,
      remainingDetector: decision.remaining.detector,
      ip: getClientIp(req),
    });

    const httpStatus = decision.allowed ? 200 : 200; // 200 with allowed:false so the overlay can render a friendly message
    return res.status(httpStatus).json({
      allowed: decision.allowed,
      code: decision.reason,
      action,
      remaining: decision.remaining,
      secondsRemaining: secondsRemaining(r.lease),
    });
  } catch (err) {
    console.error('Stealth gateway consume error:', err.message);
    return res.status(500).json({ allowed: false, code: 'server_error' });
  }
});

// ─── Usage lifecycle (humanizer / detector) — charge only after a real result ─────────
// /consume above charges on the CLICK. These three replace it: the gateway RESERVES before
// the upstream request goes out, then COMMITS only once it has verified from the real
// StealthWriter response that a result was produced, or CANCELS when it has not.
//
// GATEWAY-ONLY. All three carry the shared X-Gateway-Key on top of the lease, because only
// the gateway may declare an outcome. A browser — which never holds the lease anyway, it is
// in an opaque HttpOnly session on the gateway — therefore cannot commit an operation, and
// a page-script "success" flag cannot become a charge. The operation is additionally bound
// to the client resolved FROM THE LEASE, so one client's browser can never touch another
// client's operation.
//
// Bodies carry only { action, operationId, outcomeCode, upstreamStatus }. No text, no
// output, no cookies, no headers. Logs carry the same fields and nothing more.
const USAGE_LIFECYCLE_PATHS = ['/usage/reserve', '/usage/commit', '/usage/cancel'];

function usageBody(req) {
  const b = (req && req.body) || {};
  const action = String(b.action || '').toLowerCase();
  const operationId = typeof b.operationId === 'string' ? b.operationId.trim() : '';
  // A short, closed vocabulary — never free text from upstream.
  const outcomeCode = /^[a-z0-9_]{1,48}$/.test(String(b.outcomeCode || '')) ? String(b.outcomeCode) : null;
  const n = Math.trunc(Number(b.upstreamStatus));
  const upstreamStatus = Number.isFinite(n) && n >= 0 && n <= 599 ? n : null;
  return { action, operationId, outcomeCode, upstreamStatus };
}

// Reserve — validates lease, client status, plan expiry and available limit, then mints one
// operation. The visible used counter does NOT move here.
router.post('/usage/reserve', gatewayServiceLimiter, requireGatewayKey, async (req, res) => {
  const startedAt = Date.now();
  try {
    const r = await resolveLease(req);
    if (!r.ok) return res.status(r.status).json({ ok: false, allowed: false, code: r.code });

    const { action } = usageBody(req);
    if (!access.ACTIONS.includes(action)) {
      return res.status(400).json({ ok: false, allowed: false, code: 'invalid_action' });
    }

    const decision = await access.reserve(r.client, action, {
      leaseId: r.lease._id,
      accountId: r.lease.accountId || null,
    });

    dbg({
      evt: 'usage_reserve', action_type: action, lease_id: r.lease._id,
      account_id: r.lease.accountId || null, client_id: r.client._id,
      response_status: 200, allowed: decision.ok, reason: decision.reason,
      operation_id: decision.operationId || null, latency_ms: Date.now() - startedAt,
      error_source: decision.ok ? null : (decision.reason === 'limit_reached' ? 'usage_limit' : 'account_check'),
    });

    // Opportunistic, self-throttled cleanup of long-dead rows. Never blocks the response.
    access.sweepUsageOperations().catch(() => {});

    return res.json({
      ok: decision.ok,
      allowed: decision.ok,
      code: decision.reason,
      action,
      operationId: decision.operationId || null,
      expiresAt: decision.expiresAt || null,
      ttlSeconds: access.RESERVATION_TTL_SEC,
      remaining: decision.remaining,
      secondsRemaining: secondsRemaining(r.lease),
    });
  } catch (err) {
    console.error('Stealth usage reserve error:', err.message);
    return res.status(500).json({ ok: false, allowed: false, code: 'server_error' });
  }
});

// Commit — the ONLY place a StealthWriter credit is ever spent. Idempotent per operationId.
router.post('/usage/commit', gatewayServiceLimiter, requireGatewayKey, async (req, res) => {
  const startedAt = Date.now();
  try {
    const r = await resolveLease(req);
    if (!r.ok) return res.status(r.status).json({ ok: false, committed: false, code: r.code });

    const { action, operationId, outcomeCode, upstreamStatus } = usageBody(req);
    if (!access.ACTIONS.includes(action)) {
      return res.status(400).json({ ok: false, committed: false, code: 'invalid_action' });
    }

    const decision = await access.commit(r.client, action, operationId, { outcomeCode, upstreamStatus });

    dbg({
      evt: 'usage_commit', action_type: action, lease_id: r.lease._id,
      account_id: r.lease.accountId || null, client_id: r.client._id,
      response_status: 200, committed: !!decision.committed, duplicate: !!decision.duplicate,
      reason: decision.reason, outcome_code: outcomeCode, upstream_status: upstreamStatus,
      latency_ms: Date.now() - startedAt,
      error_source: decision.committed ? null : 'usage_operation',
    });

    // One audit row per CHARGE, in the same shape the admin usage view already renders.
    // A duplicate/retried commit does not write a second row — the charge happened once.
    if (decision.committed && !decision.duplicate) {
      await StealthUsageLog.record({
        userId: r.client.userId,
        stealthClientId: r.client._id,
        leaseId: r.lease._id,
        accountId: r.lease.accountId || null,
        accountLabel: r.lease.accountLabel || null,
        action,
        allowed: true,
        reason: outcomeCode || 'result_verified',
        remainingHumanizer: decision.remaining.humanizer,
        remainingDetector: decision.remaining.detector,
        ip: getClientIp(req),
      });
    }

    return res.json({
      ok: !!decision.ok,
      committed: !!decision.committed,
      duplicate: !!decision.duplicate,
      code: decision.reason,
      action,
      remaining: decision.remaining,
      secondsRemaining: secondsRemaining(r.lease),
    });
  } catch (err) {
    console.error('Stealth usage commit error:', err.message);
    return res.status(500).json({ ok: false, committed: false, code: 'server_error' });
  }
});

// Cancel — releases a reservation on a confirmed failure. Always leaves the counter alone.
router.post('/usage/cancel', gatewayServiceLimiter, requireGatewayKey, async (req, res) => {
  try {
    const r = await resolveLease(req);
    if (!r.ok) return res.status(r.status).json({ ok: false, code: r.code });

    const { action, operationId, outcomeCode, upstreamStatus } = usageBody(req);
    if (!access.ACTIONS.includes(action)) {
      return res.status(400).json({ ok: false, code: 'invalid_action' });
    }

    const decision = await access.cancel(r.client, action, operationId, { outcomeCode, upstreamStatus });

    dbg({
      evt: 'usage_cancel', action_type: action, lease_id: r.lease._id,
      account_id: r.lease.accountId || null, client_id: r.client._id,
      response_status: 200, cancelled: !!decision.cancelled, duplicate: !!decision.duplicate,
      already_committed: !!decision.committed, reason: decision.reason,
      outcome_code: outcomeCode, upstream_status: upstreamStatus,
      error_source: 'upstream',
    });

    // Audit the no-charge outcome so an operator can see WHY a member's action produced
    // nothing. allowed:false keeps it distinct from a real charge in the admin view.
    if (decision.cancelled && !decision.duplicate) {
      await StealthUsageLog.record({
        userId: r.client.userId,
        stealthClientId: r.client._id,
        leaseId: r.lease._id,
        accountId: r.lease.accountId || null,
        accountLabel: r.lease.accountLabel || null,
        action,
        allowed: false,
        reason: outcomeCode || 'upstream_failed',
        remainingHumanizer: decision.remaining.humanizer,
        remainingDetector: decision.remaining.detector,
        ip: getClientIp(req),
      });
    }

    return res.json({
      ok: true,
      cancelled: !!decision.cancelled,
      duplicate: !!decision.duplicate,
      committed: !!decision.committed,
      code: decision.reason,
      action,
      remaining: decision.remaining,
      secondsRemaining: secondsRemaining(r.lease),
    });
  } catch (err) {
    console.error('Stealth usage cancel error:', err.message);
    return res.status(500).json({ ok: false, code: 'server_error' });
  }
});

// ─── Session (gateway-only) ──────────────────────────────────────────────────
// Returns the decrypted session/cookie bundle for the lease's bound vault account
// so the gateway can inject it into upstream requests. Secrets leave the DB ONLY
// here, server-to-server, and are never logged.
router.post('/session', requireGatewayKey, async (req, res) => {
  try {
    const r = await resolveLease(req);
    if (!r.ok) return res.status(r.status).json({ ok: false, code: r.code });

    // Legacy / no-vault: lease has no bound account → gateway proxies without injection.
    if (!r.lease.accountId) return res.json({ ok: true, account: null });

    const account = await StealthAccount.findById(r.lease.accountId);
    if (!account) return res.json({ ok: true, account: null });

    // 'blocked' is an admin kill-switch — stop the session immediately.
    if (account.status === 'blocked') {
      return res.json({ ok: false, blocked: true, code: 'account_blocked' });
    }

    let bundle = null;
    try {
      if (account.sessionEncrypted) bundle = JSON.parse(vaultCrypto.decrypt(account.sessionEncrypted));
    } catch (_) { bundle = null; }
    if (!bundle) return res.json({ ok: false, blocked: true, code: 'account_no_session' });

    return res.json({
      ok: true,
      // label is for server-side admin logging only (gateway-key protected; never reaches the browser).
      account: { id: account._id, status: account.status, label: account.label },
      bundle, // { cookies:[{name,value,domain,path}], localStorage:{}, sessionStorage:{}, origin }
    });
  } catch (err) {
    console.error('Stealth gateway session error:', err.message);
    return res.status(500).json({ ok: false, code: 'server_error' });
  }
});

// ─── Account expired signal (gateway-only) ───────────────────────────────────
// The gateway calls this when the upstream redirects the account to /sign-in, so
// the bound account is flagged session_expired and skipped for NEW leases.
router.post('/account-expired', requireGatewayKey, async (req, res) => {
  try {
    const r = await resolveLease(req);
    if (!r.ok) return res.status(r.status).json({ ok: false, code: r.code });
    if (!r.lease.accountId) return res.json({ ok: true, updated: false });
    const account = await StealthAccount.findById(r.lease.accountId);
    if (account && account.status === 'active') {
      account.status = 'session_expired';
      account.verification = { result: 'session_expired', maskedId: account.verification?.maskedId || null, httpStatus: 0, checkedAt: new Date() };
      await account.save();
      return res.json({ ok: true, updated: true });
    }
    return res.json({ ok: true, updated: false });
  } catch (err) {
    console.error('Stealth account-expired error:', err.message);
    return res.status(500).json({ ok: false, code: 'server_error' });
  }
});

// ─── Capture session (gateway-only) — "Refresh Cookies Through Proxy" ─────────
// In capture mode the admin logs into StealthWriter through the proxy; the gateway
// posts the cookies captured in the proxy context here to (re)fill the account
// session. Requires the lease to be a capture lease (cap flag).
router.post('/capture-session', requireGatewayKey, async (req, res) => {
  try {
    const token = getLeaseToken(req);
    const payload = token ? leaseUtil.verifyLease(token) : null;
    if (!payload) return res.status(401).json({ ok: false, code: 'lease_invalid' });
    if (!payload.cap) return res.status(403).json({ ok: false, code: 'not_capture_lease' });
    const lease = await StealthLease.findById(payload.jti);
    if (!lease || lease.revoked) return res.status(403).json({ ok: false, code: 'lease_invalid' });
    const account = await StealthAccount.findById(lease.accountId || payload.acid);
    if (!account) return res.status(404).json({ ok: false, code: 'account_not_found' });

    const cookieBundle = normalizeCookieBundle(req.body && req.body.cookies);
    if (!cookieBundle || !cookieBundle.cookies || cookieBundle.cookies.length === 0) {
      return res.status(400).json({ ok: false, code: 'no_cookies_captured' });
    }
    // Stamp the captured cookies with the target host so they always attach later.
    cookieBundle.cookies = cookieBundle.cookies.map(c => ({ ...c, domain: c.domain || TARGET_HOST }));
    account.sessionEncrypted = vaultCrypto.encrypt(JSON.stringify(cookieBundle));
    account.sessionMeta = { cookieCount: cookieBundle.cookies.length, hasLocalStorage: false, origin: process.env.STEALTH_TARGET_ORIGIN || '', updatedAt: new Date() };
    account.status = 'active';
    account.verification = { result: 'working', maskedId: account.verification?.maskedId || null, httpStatus: 200, checkedAt: new Date() };
    await account.save();
    return res.json({ ok: true, cookiesSaved: cookieBundle.cookies.length });
  } catch (err) {
    console.error('Stealth capture-session error:', err.message);
    return res.status(500).json({ ok: false, code: 'server_error' });
  }
});

module.exports = router;
