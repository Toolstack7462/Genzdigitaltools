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
const deviceState = require('../../utils/proxy/deviceState');
const activation = require('../../utils/proxy/activation');
const { ingestCandidate, markDeviceLoggedOut, recordAttempt } = require('../../utils/proxy/candidateSync');
const agentEnroll = require('../../utils/proxy/agentEnroll');
const agentCommands = require('../../utils/proxy/agentCommands');
const vaultCrypto = require('../../utils/proxy/vaultCrypto');
const { extractSupabaseSession, jwtExp } = require('../../utils/proxy/verify');
const { buildCookieHeader } = require('../../utils/proxy/cookies');

const { CODES } = deviceSync;
// The shared agent-ingest key. Set in hPanel, never in git and never returned by any route.
const SHARED_KEY = process.env.PROXY_AGENT_SYNC_KEY || '';
// Optional. Deliberately EMPTY by default: with per-device keys an IP pin adds little and breaks
// roaming/residential devices (a changed egress IP silently 403s every push).
const ALLOW_IPS = (process.env.PROXY_AGENT_SYNC_ALLOW_IPS || '').split(',').map(s => s.trim()).filter(Boolean);
const SELECTION_MODE = process.env.PROXY_ACCOUNT_SELECTION_MODE || 'auto_failover';
// Heartbeat window, shared with the dashboard and the command router.
const AGENT_STALE_MIN = Number(process.env.PROXY_AGENT_STALE_MIN || 10);
// How close to expiry the stored access token has to be before we ask the ACTIVE SOURCE's browser
// to rotate it. WriteHuman's token lives ~1h and a backgrounded Chrome rotates late — measured at
// 63-86 minutes on a 60-minute token — which is what made the dashboard read "stale" every hour and
// forced the operator to refresh the RDP browser by hand. Nudging at ~10 minutes out keeps the
// BROWSER the sole rotator (no Supabase reuse-detection risk) and simply stops it being late.
const TOKEN_NUDGE_SEC = Math.max(120, Number(process.env.PROXY_TOKEN_NUDGE_SEC || 600));

/**
 * The refusals that mean "this installation is finished — stop, permanently".
 *
 * All three used to be handled differently or not at all, and the difference showed: only
 * DEVICE_REVOKED set `standDown`, so a SUPERSEDED duplicate (a machine that had reinstalled and
 * re-enrolled) and an UNINSTALLED row went on polling and, before 3.4.0, went on relaunching their
 * own dedicated Chrome. One list, one hint per reason, and the agent treats all three as terminal.
 */
const TERMINAL_CODES = [CODES.DEVICE_REVOKED, CODES.DEVICE_UNINSTALLED, CODES.DEVICE_SUPERSEDED];
function standDownHint(code) {
  if (code === CODES.DEVICE_UNINSTALLED) {
    return 'The agent was uninstalled on this machine. Stop syncing and stop launching Chrome. Run the installer again to enrol a new identity.';
  }
  if (code === CODES.DEVICE_SUPERSEDED) {
    return 'This installation has been replaced by a newer enrolment of the same machine. Stop syncing and stop launching Chrome; the newer agent is the live one.';
  }
  return 'This device is revoked. Stop syncing and stop launching Chrome. Reinstall the agent to enrol again — it will ask an admin to authorize a NEW identity.';
}

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

/**
 * Attach a freshly issued per-agent key to the enrolment response, and ONLY that response. The key
 * is stored as a hash, so this single reply is the one chance the agent has to keep it.
 */
function withIssuedKey(req, body) {
  if (req._issuedDeviceKey) {
    body.issuedDeviceKey = req._issuedDeviceKey;
    body.deviceId = req._issuedDeviceId || null;
  }
  return body;
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

/**
 * Seconds until the stored access token expires (negative once it has). Decoded server-side only;
 * the token itself never leaves this process. The agent uses it to know WHEN the browser should
 * rotate, so rotation stops being late — the fix for the hourly "stale" reading.
 */
function accessTokenTtlSec(account, tool) {
  try {
    if (!account.sessionEncrypted) return null;
    const b = JSON.parse(vaultCrypto.decrypt(account.sessionEncrypted));
    const ref = (tools.supabaseConfig(tool) || {}).projectRef;
    const { accessToken } = extractSupabaseSession(buildCookieHeader(b, tools.targetHost(tool)), ref);
    const exp = jwtExp(accessToken);
    return exp ? Math.round(exp - Date.now() / 1000) : null;
  } catch (_) { return null; }
}

/**
 * The reply every ingest response carries. Two fields matter beyond bookkeeping:
 *
 *   command       the ADDRESSED command for THIS device, or null. Never another device's. This is
 *                 the replacement for the old global `pendingCommand` string, which was handed to
 *                 whichever agent polled first and is why "Open Chrome" landed on the wrong box.
 *   rotateTokenIn seconds until the token should be rotated, and only ever sent to the ACTIVE
 *                 SOURCE. A standby is explicitly told `null` so it never touches its browser.
 */
function agentDirectives(account, tool, device) {
  const staleMs = AGENT_STALE_MIN * 60000;
  const st = deviceState.stateOf(account, device, { staleMs });
  // A device in a terminal state must not act. It is told so explicitly, with `standDown`, rather
  // than merely being given nothing: an agent that receives silence carries on polling and (before
  // 3.4.0) relaunching its own Chrome forever. `deviceState` is the single definition of terminal,
  // so the router, the dashboard and the promotion policy cannot disagree about it.
  if (st.terminal) {
    return {
      command: null, rotateTokenIn: null, isActiveSource: false,
      superseded: st.state === 'SUPERSEDED',
      deviceState: st.state, standDown: true, standDownReason: st.reason,
    };
  }
  const active = st.state === 'ACTIVE';
  const command = agentCommands.takeFor(account, device, { tool, agentVersion: device.agentVersion });
  // The capture command is what starts the visible part of the transaction: the moment the target
  // machine actually collects it, the operator's screen moves off "waiting for the agent".
  if (command && command.type === 'capture-and-activate' && command.activationId) {
    activation.advance(account, {
      activationId: command.activationId, deviceId: device.deviceId,
      stage: 'OPENING_CHROME', fromAgent: true,
    });
  }
  let rotateTokenIn = null;
  if (active) {
    const ttl = accessTokenTtlSec(account, tool);
    if (ttl != null && ttl <= TOKEN_NUDGE_SEC) rotateTokenIn = Math.max(0, ttl);
  }
  // `deviceState` is sent on every reply so the agent always knows what it is. A STANDBY that knows
  // it is a standby does not open a browser, does not nudge a token, and does not wonder.
  return { command, rotateTokenIn, superseded: false, isActiveSource: active, deviceState: st.state, standDown: false };
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

// -- Browser-authorized enrolment --------------------------------------------
// Two unauthenticated endpoints, both inert without an admin's approval in between. A fresh agent
// has no credential by definition, so requiring one here would be circular; what actually gates
// enrolment is that a signed-in admin must click Authorize on that specific pending request.
const ENROLL_RL_MAX = Number(process.env.PROXY_AGENT_ENROLL_RATE_PER_MIN || 12);

/** Step 1: the agent registers its intent and gets back a URL for the admin to open. */
router.post('/:tool/enroll/start', express.json({ limit: '8kb' }), async (req, res) => {
  try {
    const ip = clientIp(req);
    if (!rateOk('enroll', ip, ENROLL_RL_MAX)) return res.status(429).json({ ok: false, code: 'rate_limited' });
    const account = await primaryFor(req.proxyTool);
    if (!account) return res.status(404).json({ ok: false, code: 'no_account' });

    const b = req.body || {};
    const r = agentEnroll.start(account, {
      agentId: b.agentId, challenge: b.codeChallenge,
      name: b.name, hostname: b.hostname, agentVersion: b.agentVersion,
    });
    if (!r.ok) return res.status(400).json({ ok: false, code: r.code });
    await account.save();

    // Built from a server-side constant, never from request input - a URL assembled from what the
    // caller sent is how open redirects happen.
    const base = (process.env.FRONTEND_URL || 'https://app.genzdigitalstore.com').replace(/\/+$/, '');
    return res.json({
      ok: true, code: 'OK', enrollId: r.enrollId, expiresAt: r.expiresAt, pollIntervalMs: r.pollIntervalMs,
      authorizeUrl: base + '/admin/writehuman/agent-authorize?e=' + encodeURIComponent(r.enrollId),
    });
  } catch (err) {
    console.error('[agent-sync] enroll start error:', err && err.message);
    return res.status(500).json({ ok: false, code: 'INTERNAL_ERROR' });
  }
});

/**
 * Step 3: the agent redeems an authorized enrolment for its own credential. Answers 202 while the
 * admin has not clicked yet, so the agent keeps polling, and returns a credential exactly once -
 * redeem() marks the record consumed before any key is minted.
 */
router.post('/:tool/enroll/poll', express.json({ limit: '8kb' }), async (req, res) => {
  try {
    const ip = clientIp(req);
    if (!rateOk('enrollpoll', ip, ENROLL_RL_MAX * 20)) return res.status(429).json({ ok: false, code: 'rate_limited' });
    const account = await primaryFor(req.proxyTool);
    if (!account) return res.status(404).json({ ok: false, code: 'no_account' });

    const b = req.body || {};
    const r = agentEnroll.redeem(account, { enrollId: b.enrollId, agentId: b.agentId, verifier: b.codeVerifier });
    if (!r.ok) {
      await account.save();
      // Still waiting on the human is not an error - it is this endpoint's normal state.
      if (r.code === 'ENROLLMENT_PENDING') return res.status(202).json({ ok: false, code: r.code });
      return res.status(403).json({ ok: false, code: r.code });
    }
    const reg = deviceSync.autoRegisterDevice(account, r.record.agentId, {
      hostname: r.record.hostname, agentVersion: r.record.agentVersion,
    });
    if (!reg.ok) return res.status(403).json({ ok: false, code: reg.code });
    if (r.record.name) reg.device.name = r.record.name;
    reg.device.enrolledVia = 'browser';
    deviceSync.putDevice(account, reg.device);
    await account.save();

    console.log('[agent-sync] agent enrolled via browser authorization',
      JSON.stringify({ tool: req.proxyTool, deviceId: reg.device.deviceId, name: reg.device.name }));
    // The one and only time this credential is transmitted.
    return res.json({ ok: true, code: 'OK', deviceId: reg.device.deviceId, deviceKey: reg.issuedKey, name: reg.device.name });
  } catch (err) {
    console.error('[agent-sync] enroll poll error:', err && err.message);
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
    // Two ways in, in priority order:
    //   1. A PAIRED device presenting its own key (`x-device-id`). Kept fully working so a
    //      rollback to the manual-pairing workflow needs no code change.
    //   2. The NORMAL path: the shared ingest key plus a self-generated `x-agent-id`. The agent
    //      registers itself on first contact - no code to fetch, no approval to click, and
    //      installing on a new machine is just "give it the key once".
    // Self-registration relaxes only the ENROLMENT step. Everything that protects the live session
    // is downstream and unchanged: one-time activation claim, candidate verification before any
    // promotion, per-device revocation, replay and idempotency.
    let device = null;
    const agentId = req.headers['x-agent-id'] ? String(req.headers['x-agent-id']).slice(0, 64) : null;
    const sharedKeyOk = SHARED_KEY && timingEq(presentedKey, SHARED_KEY);

    if (deviceId) {
      const a = deviceSync.authenticateDevice(account, deviceId, presentedKey);
      if (!a.ok) {
        // STAND DOWN. A revoked agent used to just log the 403 and carry on — polling every 45s and
        // auto-relaunching the dedicated Chrome on that machine indefinitely. That is precisely how
        // WriteHuman Chrome kept opening on a computer that was no longer the source. The refusal
        // now says so explicitly so the agent can stop touching the browser and go quiet.
        return res.status(403).json({
          ok: false, code: a.code,
          standDown: TERMINAL_CODES.includes(a.code),
          hint: TERMINAL_CODES.includes(a.code) ? standDownHint(a.code) : undefined,
        });
      }
      device = a.device;
    } else if (sharedKeyOk && agentId) {
      const r = deviceSync.autoRegisterDevice(account, agentId, {
        hostname: (report && report.host) || null,
        agentVersion: (report && report.version) || null,
      });
      if (!r.ok) {
        return res.status(403).json({
          ok: false, code: r.code,
          standDown: TERMINAL_CODES.includes(r.code),
          hint: TERMINAL_CODES.includes(r.code) ? standDownHint(r.code) : undefined,
        });
      }
      device = r.device;
      if (r.created) {
        // Non-secret: an id the agent generated and the hostname it reported. No key material.
        console.log('[agent-sync] device self-registered', JSON.stringify({ tool, deviceId: device.deviceId, name: device.name }));
        // Handed back ONCE, on the enrolment response only. Stored as a hash; never retrievable.
        req._issuedDeviceKey = r.issuedKey;
        req._issuedDeviceId = device.deviceId;
      }
    } else if (sharedKeyOk) {
      // Shared key but no agent id: the pre-multi-device agent. Adopt it under a stable id so it
      // still goes through the candidate pipeline rather than getting a bypass.
      const r = deviceSync.autoRegisterDevice(account, 'agent_legacy_shared', {
        hostname: (report && report.host) || null,
        agentVersion: (report && report.version) || null,
      });
      if (!r.ok) return res.status(403).json({ ok: false, code: r.code });
      device = r.device;
    } else {
      // Tell "nothing is configured" apart from "your credentials are wrong" - the 38-day outage
      // was a 503 that said neither.
      const anyDevice = deviceSync.getDevices(account).some(d => d && !d.revoked);
      if (!anyDevice && !SHARED_KEY) {
        return res.status(503).json({
          ok: false, code: 'agent_sync_not_configured',
          hint: 'PROXY_AGENT_SYNC_KEY is not set on the server, so no agent can sync. Set it in hPanel and restart the app.',
        });
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

    // An agent may acknowledge the command it was last given. Purely observational — it never
    // grants anything — but it is what turns "we queued a Chrome launch" into "RDP-01 ran it".
    if (body.commandAck) { agentCommands.ack(account, device, body.commandAck); }

    // -- activation progress from the device --------------------------------
    // The agent narrates what it is doing on its own machine — bringing Chrome up, waiting for
    // somebody to sign in, reading cookies, uploading — so the operator sees a real stage instead
    // of an indefinite spinner. It can only claim the stages that describe its OWN work
    // (activation.AGENT_STAGES); everything from VERIFYING_ACCOUNT onwards is the server's to
    // report, so a buggy or hostile agent cannot narrate itself into ACTIVE.
    if (body.activationStage && body.activationId) {
      activation.advance(account, {
        activationId: String(body.activationId).slice(0, 64),
        deviceId: device.deviceId,
        stage: String(body.activationStage).slice(0, 40),
        note: body.activationNote ? String(body.activationNote).slice(0, 160) : null,
        fromAgent: true,
      });
    }
    // The agent gave up locally (Chrome would not start, nobody signed in before its own deadline).
    // Ending the transaction here is what turns a dead activation into a stated failure rather than
    // a UI that waits for the full window and then says nothing useful.
    if (body.activationFailed && body.activationId) {
      const v = activation.validate(account, {
        activationId: String(body.activationId).slice(0, 64),
        deviceId: device.deviceId, nonce: body.activationNonce,
      });
      if (v.ok) {
        activation.fail(account, {
          activationId: v.activation.activationId,
          code: String(body.activationFailed).slice(0, 40),
          message: body.activationNote ? String(body.activationNote).slice(0, 200) : null,
        });
      }
    }

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
      const d = agentDirectives(account, tool, device);
      await account.save();
      return res.json(withIssuedKey(req, { ok: true, code: 'HEARTBEAT', heartbeat: true, changed: false, ...d, activeSource: activeSourceView(account) }));
    }

    // -- explicit logout signal from this device ----------------------------
    if (body.loggedOut === true) {
      const r = await markDeviceLoggedOut(account, tool, device, meta);
      const d = agentDirectives(account, tool, device);
      await account.save();
      return res.json(withIssuedKey(req, { ok: true, code: r.code, loggedOut: true, downgraded: r.downgraded, changed: r.downgraded, ...d }));
    }

    // -- cookie candidate ---------------------------------------------------
    // If this push carries an activation capability, validate it HERE — the ingest module trusts
    // `opts.activation` completely, so this is the boundary where a claim becomes a capability.
    // It must be the right transaction, addressed to THIS authenticated device, with the one-time
    // nonce that only ever travelled in that device's own command delivery.
    //
    // ★ `body.force` is deliberately gone. It used to be read straight off the request as
    //   `force: body.force === true`, which let ANY agent holding a valid device key ask the server
    //   to bypass the unchanged-hash check, the trusted-ordering check and the standby rule, just
    //   by putting a boolean in its own body. Forcing is a server decision now, and the only thing
    //   that authorises it is an admin-initiated activation.
    let act = null;
    if (body.activationId) {
      const v = activation.validate(account, {
        activationId: String(body.activationId).slice(0, 64),
        deviceId: device.deviceId,
        nonce: body.activationNonce,
      });
      if (!v.ok) {
        recordAttempt(account, device, v.code, { report, error: 'activation rejected: ' + v.code });
        await account.save();
        return res.status(409).json({ ok: false, code: v.code, activation: activation.publicView(account) });
      }
      act = v.activation;
      activation.advance(account, { activationId: act.activationId, deviceId: device.deviceId, stage: 'UPLOADING', fromAgent: true });
    }
    const r = await ingestCandidate(account, tool, device, body.cookies, Object.assign({ activation: act }, meta));
    const d = agentDirectives(account, tool, device);
    await account.save();

    // STANDBY_ROUTINE_REFRESH is a SUCCESSFUL outcome, not a refusal: the server received the push,
    // judged it, and correctly declined to promote it. Answering 409 made the agent log
    // `ingest_rejected` and, because it only remembers a hash on success or on a few known-terminal
    // codes, re-offer the identical bundle on every single poll — a standby machine talking to the
    // server forever about cookies it is never allowed to write. 200 with `standby: true` lets it
    // record the hash and go quiet until something actually changes.
    const httpCode = [CODES.PROMOTED, CODES.COOKIE_BUNDLE_UNCHANGED, CODES.STANDBY_ROUTINE_REFRESH].includes(r.code) ? 200 : 409;
    return res.status(httpCode).json(withIssuedKey(req, {
      ok: httpCode === 200,
      code: r.code,
      changed: r.changed,
      promoted: r.promoted,
      standby: !!r.standby,
      hint: r.hint || undefined,
      sourceSwitched: !!r.sourceSwitched,
      bundleVersion: r.bundleVersion,
      activeSource: activeSourceView(account),
      activation: act ? activation.publicView(account) : undefined,
      ...d,
    }));
  } catch (err) {
    console.error('[agent-sync] ingest error:', err && err.message);
    return res.status(500).json({ ok: false, code: 'INTERNAL_ERROR' });
  }
});

/**
 * POST /:tool/device-status — "is my credential still good?", with no side effects.
 *
 * WHY THE INSTALLER NEEDS THIS. Re-running the installer on a machine whose device row had been
 * revoked used to reinstall happily and hand the agent back the SAME revoked credential, because
 * the creds file survived and nothing ever asked the server what it thought. The agent then 403'd
 * forever and no fresh authorization was ever offered — the "reinstalling does not re-authorize"
 * bug, exactly.
 *
 * So the installer asks first. This route deliberately does NOT touch `lastSeenAt`, does not
 * register anything, and does not create a row: a probe must not make an uninstalled machine look
 * alive, and an unknown credential must not enrol itself by asking about itself.
 */
router.post('/:tool/device-status', express.json({ limit: '4kb' }), async (req, res) => {
  try {
    const ip = clientIp(req);
    if (!rateOk('status', ip, RL_MAX)) return res.status(429).json({ ok: false, code: 'rate_limited' });
    const account = await primaryFor(req.proxyTool);
    if (!account) return res.status(404).json({ ok: false, code: 'no_account' });

    const deviceId = req.headers['x-device-id'] ? String(req.headers['x-device-id']).slice(0, 64) : null;
    if (!deviceId) return res.status(400).json({ ok: false, code: 'MISSING_DEVICE_ID' });

    const a = deviceSync.authenticateDevice(account, deviceId, req.headers['x-agent-key']);
    if (!a.ok) {
      // The installer reads exactly this to decide between "repair in place" and "archive the old
      // identity and start a fresh browser authorization". Every terminal reason says so plainly.
      return res.status(403).json({
        ok: false, code: a.code,
        terminal: TERMINAL_CODES.includes(a.code),
        reauthorize: TERMINAL_CODES.includes(a.code) || a.code === CODES.DEVICE_UNKNOWN || a.code === CODES.AUTH_INVALID,
        hint: TERMINAL_CODES.includes(a.code) ? standDownHint(a.code) : 'This credential is not recognised. Enrol a new identity.',
      });
    }
    const st = deviceState.stateOf(account, a.device, { staleMs: AGENT_STALE_MIN * 60000 });
    return res.json({
      ok: true, code: CODES.OK,
      deviceId: a.device.deviceId, name: a.device.name || null,
      deviceState: st.state, terminal: st.terminal, reason: st.reason,
      isActiveSource: st.isActiveSource, reauthorize: false,
    });
  } catch (err) {
    console.error('[agent-sync] device-status error:', err && err.message);
    return res.status(500).json({ ok: false, code: 'INTERNAL_ERROR' });
  }
});

/**
 * POST /:tool/uninstall — the agent reporting its own removal, before it deletes its credential.
 *
 * The uninstaller calls this while it still HAS the credential, because afterwards it cannot prove
 * anything. Everything it does is the mirror image of an install:
 *
 *   - the row goes to UNINSTALLED and loses its key hash, so the credential the uninstaller is
 *     about to delete is dead server-side even if the local wipe is interrupted;
 *   - every command addressed to that device is cancelled, so nothing is waiting to be picked up;
 *   - a live activation targeting it is failed, so it cannot promote after being removed;
 *   - `activeSourceId` is cleared if it pointed there — and NOTHING is chosen in its place. The
 *     last verified bundle keeps serving and a human picks the next source.
 *
 * The stored session is never touched. Uninstalling software does not sign anybody out.
 */
router.post('/:tool/uninstall', express.json({ limit: '4kb' }), async (req, res) => {
  try {
    const ip = clientIp(req);
    if (!rateOk('uninstall', ip, PAIR_RL_MAX)) return res.status(429).json({ ok: false, code: 'rate_limited' });
    const account = await primaryFor(req.proxyTool);
    if (!account) return res.status(404).json({ ok: false, code: 'no_account' });

    const deviceId = req.headers['x-device-id'] ? String(req.headers['x-device-id']).slice(0, 64) : null;
    if (!deviceId) return res.status(400).json({ ok: false, code: 'MISSING_DEVICE_ID' });

    const a = deviceSync.authenticateDevice(account, deviceId, req.headers['x-agent-key']);
    if (!a.ok) {
      // Already revoked/uninstalled/superseded: the desired end state is already true. Say so with
      // 200 so an uninstaller is never blocked from finishing its local cleanup by a server that
      // has already forgotten this machine.
      if (TERMINAL_CODES.includes(a.code)) return res.json({ ok: true, code: a.code, alreadyRetired: true });
      return res.status(403).json({ ok: false, code: a.code });
    }

    const r = deviceSync.markUninstalled(account, deviceId, { reason: (req.body && req.body.reason) || 'agent_uninstalled' });
    if (!r.ok) return res.status(404).json({ ok: false, code: r.code });
    const purged = agentCommands.purgeForDevice(account, deviceId, 'device_uninstalled');
    const activationCancelled = activation.cancelForDevice(account, deviceId, 'The target device was uninstalled.');
    await account.save();

    console.log('[agent-sync] device uninstalled', JSON.stringify({
      tool: req.proxyTool, deviceId, activeSourceCleared: r.activeSourceCleared, purgedCommands: purged,
    }));
    return res.json({
      ok: true, code: CODES.OK,
      activeSourceCleared: r.activeSourceCleared,
      bundlePreserved: r.bundlePreserved,
      purgedCommands: purged,
      activationCancelled,
      note: 'Device marked UNINSTALLED. The stored WriteHuman session is untouched and no replacement source was selected automatically.',
    });
  } catch (err) {
    console.error('[agent-sync] uninstall error:', err && err.message);
    return res.status(500).json({ ok: false, code: 'INTERNAL_ERROR' });
  }
});

module.exports = router;
