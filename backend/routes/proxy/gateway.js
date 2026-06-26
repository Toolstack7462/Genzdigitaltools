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
const { normalizeCookieBundle } = require('../../utils/proxy/cookies');
const { apiLimiter } = require('../../middleware/rateLimiter');

router.use(apiLimiter);

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
router.post('/validate', async (req, res) => {
  try {
    const r = await resolveLease(req);
    if (!r.ok) {
      dbg({ evt: 'validate', response_status: r.status, code: r.code, error_source: 'lease_check' });
      return res.status(r.status).json({ valid: false, code: r.code });
    }
    return res.json({
      valid: true,
      tool: r.tool,
      toolName: (tools.publicInfo(r.tool) || {}).name || r.tool,
      secondsRemaining: secondsRemaining(r.lease),
    });
  } catch (err) {
    console.error('Proxy gateway validate error:', err.message);
    return res.status(500).json({ valid: false, code: 'server_error' });
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

    return res.json({
      ok: true,
      account: { id: account._id, status: account.status, label: account.label }, // label for server-side logs only
      bundle,
    });
  } catch (err) {
    console.error('Proxy gateway session error:', err.message);
    return res.status(500).json({ ok: false, code: 'server_error' });
  }
});

// ─── Account expired signal (gateway-only) ───────────────────────────────────
router.post('/account-expired', requireGatewayKey, async (req, res) => {
  try {
    const r = await resolveLease(req);
    if (!r.ok) return res.status(r.status).json({ ok: false, code: r.code });
    if (!r.lease.accountId) return res.json({ ok: true, updated: false });
    const account = await ProxyAccount.findById(r.lease.accountId);
    if (account && account.status === 'active') {
      account.status = 'session_expired';
      account.session_status = 'session_expired';
      account.verification = { result: 'session_expired', maskedId: account.verification?.maskedId || null, httpStatus: 0, checkedAt: new Date() };
      await account.save();
      dbg({ evt: 'account_expired', tool: r.tool, account_id: account._id, updated: true });
      return res.json({ ok: true, updated: true });
    }
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

module.exports = router;
