'use strict';
/**
 * Machine-to-machine cookie ingest for the Cookie Sync Agent — now MULTI-DEVICE.
 *
 * Mounted at /api/crm/proxy/agent. Any PAIRED device (local PC, RDP-01, RDP-02 ...) running the
 * agent can push the operator's fresh WriteHuman auth cookies; whichever device supplies the
 * newest bundle that PASSES VERIFICATION becomes the active source automatically. Moving the
 * login between machines needs no code change, no env change and no server reconfiguration.
 *
 * Least privilege: a device key can ONLY push cookies / heartbeat / logout for its tool and read
 * its own queued command. It can never read other accounts, clients, cookies or admin data.
 * Tool-scoped, per-device hashed keys with timing-safe compare, replay + idempotency protection,
 * per-IP rate limit, optional IP allowlist. Never logs or returns cookie values or tokens.
 *
 * PAIRING KEYS LIVE IN THE DATABASE, NOT IN THE ENVIRONMENT. The previous design authenticated
 * every agent with one global env var; when that var was lost in a host incident the whole
 * pipeline answered 503 and nothing recorded the refusal, so a 38-day sync outage went unnoticed.
 * Device pairing survives an env wipe, and every refusal is now written to the device row where
 * the admin dashboard can see it.
 */
const express = require('express');
const crypto = require('crypto');
const router = express.Router();

const ProxyAccount = require('../../models/proxy/ProxyAccount');
const tools = require('../../utils/proxy/tools');
const { selectAccount } = require('../../utils/proxy/accountSelect');
const deviceSync = require('../../utils/proxy/deviceSync');
const { ingestCandidate, markDeviceLoggedOut, recordAttempt } = require('../../utils/proxy/candidateSync');

const { CODES } = deviceSync;
const LEGACY_KEY = process.env.PROXY_AGENT_SYNC_KEY || '';
// Optional. Deliberately EMPTY by default: with per-device keys an IP pin adds little and breaks
// roaming/residential devices (a changed egress IP silently 403s every push).
const ALLOW_IPS = (process.env.PROXY_AGENT_SYNC_ALLOW_IPS || '').split(',').map(s => s.trim()).filter(Boolean);
const SELECTION_MODE = process.env.PROXY_ACCOUNT_SELECTION_MODE || 'auto_failover';
const ALLOWED_COMMANDS = ['relaunch-chrome', 'reverify'];

function clientIp(req) {
  const xff = req.headers['x-forwarded-for'];
  if (xff) return String(xff).split(',')[0].trim();
  return (req.socket && req.socket.remoteAddress) || 'unknown';
}
function timingEq(got, expected) {
  const a = Buffer.from(String(got || '')); const b = Buffer.from(String(expected || ''));
  return a.length === b.length && a.length > 0 && crypto.timingSafeEqual(a, b);
}
// Tiny per-IP sliding window — brute-force guard on the keys and the pairing codes.
const RL = new Map();
const RL_MAX = Number(process.env.PROXY_AGENT_SYNC_RATE_PER_MIN || 240);
const PAIR_RL_MAX = Number(process.env.PROXY_AGENT_PAIR_RATE_PER_MIN || 10);
function rateOk(bucket, ip, max) {
  const key = bucket + '|' + ip;
  const now = Date.now(); const e = RL.get(key);
  if (!e || now - e.t > 60000) { RL.set(key, { t: now, n: 1 }); return true; }
  e.n += 1; return e.n <= max;
}
// Non-secret agent telemetry only (counts / ids / status — never cookie values).
function sanitizeReport(r) {
  if (!r || typeof r !== 'object') return undefined;
  const s = (v, n) => (v == null ? null : String(v).slice(0, n));
  const i = (v) => (Number.isFinite(Number(v)) ? Math.trunc(Number(v)) : null);
  return {
    host: s(r.host, 80), version: s(r.version, 40), cdp: s(r.cdp, 12),
    chrome: r.chrome === true || r.chrome === 'true',
    pollCount: i(r.pollCount), authCookies: i(r.authCookies), uptimeSec: i(r.uptimeSec),
    lastError: s(r.lastError, 200), lastErrorAt: s(r.lastErrorAt, 40), errorCount: i(r.errorCount),
    lastCommand: s(r.lastCommand, 40), lastCommandAt: s(r.lastCommandAt, 40),
    profile: s(r.profile, 80), receivedAt: new Date(),
  };
}

function activeSourceView(account) {
  const a = account.activeSource;
  if (!a) return null;
  return { deviceId: a.deviceId, name: a.name || null, promotedAt: a.promotedAt || null, bundleVersion: a.bundleVersion || 0 };
}
function isActive(account, device) {
  const a = account.activeSource;
  return !!(a && device && a.deviceId === device.deviceId);
}

router.param('tool', (req, res, next, tool) => {
  if (!tools.isValidTool(tool)) return res.status(404).json({ ok: false, code: 'unknown_tool' });
  req.proxyTool = tool; next();
});

async function primaryFor(tool) {
  const accounts = await ProxyAccount.find({ tool });
  if (!accounts.length) return null;
  return accounts.find(a => a.isPrimary) || selectAccount(accounts, SELECTION_MODE) || accounts[0];
}

/**
 * POST /:tool/pair — redeem a single-use pairing code created by the admin.
 * Unauthenticated by design (a brand-new device has no credentials yet); protected by the code's
 * entropy, its 15-minute TTL, single-use semantics and a tight per-IP rate limit.
 * Returns the device key ONCE — it is stored only as a hash.
 */
router.post('/:tool/pair', express.json({ limit: '8kb' }), async (req, res) => {
  try {
    const ip = clientIp(req);
    if (!rateOk('pair', ip, PAIR_RL_MAX)) return res.status(429).json({ ok: false, code: 'rate_limited' });

    const account = await primaryFor(req.proxyTool);
    if (!account) return res.status(404).json({ ok: false, code: 'no_account' });

    const body = req.body || {};
    const r = deviceSync.redeemPairingCode(account, body.code, { hostname: body.hostname, agentVersion: body.agentVersion });
    if (!r.ok) return res.status(403).json({ ok: false, code: r.code });
    await account.save();
    return res.json({ ok: true, code: CODES.OK, deviceId: r.deviceId, deviceKey: r.deviceKey, name: r.name, tool: req.proxyTool });
  } catch (err) {
    console.error('[agent-sync] pair error:', err && err.message);
    return res.status(500).json({ ok: false, code: 'INTERNAL_ERROR' });
  }
});

/**
 * POST /:tool/cookies — heartbeat, logout signal, or a cookie candidate from a paired device.
 * Auth: `x-device-id` + `x-agent-key` (per-device). The pre-multi-device global env key is still
 * accepted for the already-deployed agent, and is mapped onto a real device row so it appears in
 * the dashboard beside the paired ones and goes through exactly the same safety pipeline.
 */
router.post('/:tool/cookies', express.json({ limit: '256kb' }), async (req, res) => {
  try {
    const ip = clientIp(req);
    if (!rateOk('sync', ip, RL_MAX)) return res.status(429).json({ ok: false, code: 'rate_limited' });
    if (ALLOW_IPS.length && !ALLOW_IPS.includes(ip)) return res.status(403).json({ ok: false, code: 'ip_not_allowed' });

    const tool = req.proxyTool;
    const account = await primaryFor(tool);
    if (!account) return res.status(404).json({ ok: false, code: 'no_account' });

    const body = req.body || {};
    const report = sanitizeReport(body.agent);
    const presentedKey = req.headers['x-agent-key'];
    const deviceId = req.headers['x-device-id'] ? String(req.headers['x-device-id']).slice(0, 64) : null;

    // -- authenticate -------------------------------------------------------
    let device = null;
    if (deviceId) {
      const a = deviceSync.authenticateDevice(account, deviceId, presentedKey);
      if (!a.ok) return res.status(403).json({ ok: false, code: a.code });
      device = a.device;
    } else if (LEGACY_KEY && timingEq(presentedKey, LEGACY_KEY)) {
      device = deviceSync.findDevice(account, 'dev_legacy');
      if (!device) {
        device = {
          deviceId: 'dev_legacy', name: 'RDP-LEGACY', hostname: (report && report.host) || null,
          agentVersion: (report && report.version) || null, keyHash: deviceSync.sha256(LEGACY_KEY),
          pairedAt: new Date(), revoked: false, lastSeq: 0, syncCount: 0, promotionCount: 0, legacy: true,
        };
        account.syncDevices = deviceSync.getDevices(account).concat([device]);
      }
      if (device.revoked) return res.status(403).json({ ok: false, code: CODES.DEVICE_REVOKED });
    } else {
      // No device header and no usable legacy key. Distinguish "nothing is paired yet" from "you
      // presented bad credentials" so the operator can tell those apart at a glance.
      const anyDevice = deviceSync.getDevices(account).some(d => d && !d.revoked);
      if (!anyDevice && !LEGACY_KEY) {
        return res.status(503).json({ ok: false, code: 'agent_sync_not_configured', hint: 'No device is paired yet. Create a pairing code in Admin -> WriteHuman -> Devices.' });
      }
      return res.status(403).json({ ok: false, code: CODES.AUTH_INVALID });
    }

    const meta = { report, agentVersion: report && report.version, hostname: report && report.host, seq: null, idempotencyKey: null };

    // -- replay + idempotency ----------------------------------------------
    const seq = Number(body.seq);
    if (Number.isFinite(seq)) {
      if (device.lastSeq && seq <= device.lastSeq) {
        recordAttempt(account, device, CODES.REPLAY_REJECTED, { report, error: 'seq ' + seq + ' <= ' + device.lastSeq });
        await account.save();
        return res.status(409).json({ ok: false, code: CODES.REPLAY_REJECTED, lastSeq: device.lastSeq });
      }
      meta.seq = seq;
    }
    const idem = body.idempotencyKey ? String(body.idempotencyKey).slice(0, 80) : null;
    if (idem && device.lastIdempotencyKey && idem === device.lastIdempotencyKey) {
      // Exact repeat of the previous request — replay the previous outcome, do nothing again.
      return res.json({ ok: true, code: device.lastResultCode || CODES.OK, idempotent: true, changed: false, promoted: false, command: null });
    }
    meta.idempotencyKey = idem;

    const pending = account.pendingCommand && ALLOWED_COMMANDS.includes(account.pendingCommand) ? account.pendingCommand : null;
    const clearPending = () => { if (pending) account.pendingCommand = null; };

    // -- heartbeat: liveness + telemetry only -------------------------------
    if (body.heartbeat === true && body.cookies == null) {
      // A heartbeat reporting ZERO auth cookies is how we learn a device is signed out. Recording
      // it is what makes a later sign-in an observable TRANSITION, and therefore what lets that
      // device legitimately reclaim the active source — the copied-session case that session-id
      // comparison alone can never see. A heartbeat with no telemetry says nothing either way.
      if (report && typeof report.authCookies === 'number') {
        deviceSync.noteDeviceAuthState(device, report.authCookies > 0, new Date());
      }
      recordAttempt(account, device, 'HEARTBEAT', meta);
      clearPending();
      await account.save();
      return res.json({ ok: true, code: 'HEARTBEAT', heartbeat: true, changed: false, command: pending, activeSource: activeSourceView(account), isActiveSource: isActive(account, device) });
    }

    // -- explicit logout signal from this device ----------------------------
    if (body.loggedOut === true) {
      const r = await markDeviceLoggedOut(account, tool, device, meta);
      clearPending();
      await account.save();
      return res.json({ ok: true, code: r.code, loggedOut: true, downgraded: r.downgraded, changed: r.downgraded, command: pending });
    }

    // -- cookie candidate ---------------------------------------------------
    const r = await ingestCandidate(account, tool, device, body.cookies, Object.assign({ force: body.force === true }, meta));
    clearPending();
    await account.save();

    const httpCode = (r.code === CODES.PROMOTED || r.code === CODES.COOKIE_BUNDLE_UNCHANGED) ? 200 : 409;
    return res.status(httpCode).json({
      ok: httpCode === 200,
      code: r.code,
      changed: r.changed,
      promoted: r.promoted,
      sourceSwitched: !!r.sourceSwitched,
      bundleVersion: r.bundleVersion,
      activeSource: activeSourceView(account),
      isActiveSource: isActive(account, device),
      command: pending,
    });
  } catch (err) {
    console.error('[agent-sync] ingest error:', err && err.message);
    return res.status(500).json({ ok: false, code: 'INTERNAL_ERROR' });
  }
});

module.exports = router;
