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
const { getClientIp } = require('../../middleware/authEnhanced');
const { apiLimiter } = require('../../middleware/rateLimiter');
const { nextResetAt, RESET_LABEL } = require('../../utils/stealth/time');

router.use(apiLimiter);

// Gateway-only guard: the session endpoint returns decrypted secrets, so it
// requires a shared key that ONLY the gateway server holds (never the browser).
function requireGatewayKey(req, res, next) {
  const key = process.env.STEALTH_GATEWAY_KEY;
  if (!key) return res.status(503).json({ ok: false, code: 'vault_unconfigured' });
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

// ─── Validate ───────────────────────────────────────────────────────────────
router.post('/validate', async (req, res) => {
  try {
    const r = await resolveLease(req);
    if (!r.ok) return res.status(r.status).json({ valid: false, code: r.code });

    const snap = await access.snapshot(r.client);
    const status = access.assessStatus(r.client);
    if (!status.allowed) {
      return res.status(403).json({ valid: false, code: status.reason, plan: { status: snap.status, expired: snap.expired } });
    }
    return res.json({
      valid: true,
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
    });
  } catch (err) {
    console.error('Stealth gateway validate error:', err.message);
    return res.status(500).json({ valid: false, code: 'server_error' });
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
      account: { id: account._id, status: account.status }, // status only — no label/secrets to the browser-facing layer
      bundle, // { cookies:[{name,value,domain,path}]|string, localStorage:{}, sessionStorage:{}, origin }
    });
  } catch (err) {
    console.error('Stealth gateway session error:', err.message);
    return res.status(500).json({ ok: false, code: 'server_error' });
  }
});

module.exports = router;
