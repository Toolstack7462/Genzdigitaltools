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
 *   POST /consume   → check + atomically increment usage for one humanizer/detector action
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
const { apiLimiter, validateLimiter, gatewayServiceLimiter } = require('../../middleware/rateLimiter');
const vres = require('../../utils/proxy/validationResponse');
const { nextResetAt, RESET_LABEL } = require('../../utils/stealth/time');
const launchStore = require('../../utils/launchStore');
const launchCode = require('../../utils/launchCode');

// Every route keeps the per-IP apiLimiter it has always had, EXCEPT the gateway-to-backend
// launch redemption: that arrives from the gateway's single stable egress IP, so the 100/15min
// per-IP budget would be spent by a busy hour of legitimate launches. It gets the roomier
// gateway-service bucket on the route itself instead. No existing route's limit changes.
router.use((req, res, next) => {
  if ((req.path || '') === '/redeem-launch') return next();
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
router.post('/validate', validateLimiter, async (req, res) => {
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
router.post('/consume', async (req, res) => {
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
