'use strict';
/**
 * MARK ACTIVE — the activation transaction, the canonical device state machine, and strict
 * old-source protection.
 *
 * WHAT WENT WRONG, AND WHAT THESE TESTS PIN
 * -----------------------------------------
 * "Make active" was a single field with a TTL:
 *
 *     account.activeSourceIntent = { deviceId, createdAt, expiresAt };   // and that was all
 *
 * Nothing was sent to the device. The server recorded a wish and waited for that machine to push
 * cookies of its own accord. Two failures followed:
 *
 *   1. Nothing visible happened for 15 minutes and then the request expired. The UI, having no
 *      stage to render, rendered "syncing" forever.
 *   2. In the commonest case of all — the SAME WriteHuman login already signed in on the new
 *      machine — it could never work at all: the candidate's auth-cookie hash equalled the live
 *      bundle's, so the ingest short-circuited to COOKIE_BUNDLE_UNCHANGED *before* the intent was
 *      consulted. Pressing the button any number of times changed nothing.
 *
 * And the source could move on its own, three different ways (`activeFailed`, `freshSignIn`, the
 * signed-out→signed-in `activationClaim`), none of which can tell "the operator moved machines"
 * from "a browser hiccuped" — so the machine you had just moved off could take the session back.
 *
 * No database and no network: the account is an in-memory stand-in with the same shape the
 * mysqlAdapter hands back, and the one network call in the path (verifyAccountCookies) is stubbed.
 */
const test = require('node:test');
const assert = require('node:assert');
const crypto = require('crypto');

process.env.PROXY_VAULT_KEY = process.env.PROXY_VAULT_KEY || crypto.randomBytes(32).toString('hex');

// --- stub the single network dependency BEFORE the units under test capture it ---------------
const verifyMod = require('../utils/proxy/verify');
let nextVerify = { result: 'working', httpStatus: 200, maskedId: 'op***@example.com' };
let verifyCalls = [];
verifyMod.verifyAccountCookies = async (tool, header, expected, opts) => { verifyCalls.push(opts || {}); return nextVerify; };

const healthAlerts = require('../utils/proxy/healthAlerts');
healthAlerts.onVerifyApplied = async () => {};

const deviceSync = require('../utils/proxy/deviceSync');
const deviceState = require('../utils/proxy/deviceState');
const activation = require('../utils/proxy/activation');
const agentCommands = require('../utils/proxy/agentCommands');
const { ingestCandidate } = require('../utils/proxy/candidateSync');
const { authCookieHash } = require('../utils/proxy/cookies');
const vaultCrypto = require('../utils/proxy/vaultCrypto');

const TOOL = 'writehuman';
const REF = 'hicfsbrfkzsxbwayibfm';
const { CODES } = deviceSync;
const STALE_MS = 10 * 60 * 1000;
const ago = (ms) => new Date(Date.now() - ms);

// --- fixtures ---------------------------------------------------------------
function jwt(iat, email, sid) {
  const b64 = (o) => Buffer.from(JSON.stringify(o)).toString('base64').replace(/=+$/, '').replace(/\+/g, '-').replace(/\//g, '_');
  return b64({ alg: 'HS256' }) + '.' + b64({ iat, exp: iat + 3600, email, session_id: sid }) + '.sig';
}
function bundle(iat, email, sid) {
  const payload = JSON.stringify({ access_token: jwt(iat, email || 'operator@example.com', sid || 'sess-A'), refresh_token: 'rt-' + iat });
  return {
    cookies: [{
      name: 'sb-' + REF + '-auth-token',
      value: 'base64-' + Buffer.from(payload).toString('base64'),
      domain: '.writehuman.ai', path: '/', secure: true, httpOnly: false, sameSite: 'lax',
    }],
    origin: 'https://writehuman.ai',
  };
}
function account(initialBundle) {
  const a = {
    _id: 'acct1', tool: TOOL, label: 'WriteHuman', isPrimary: true,
    status: 'active', session_status: 'working',
    verification: { result: 'working', maskedId: 'op***@example.com', httpStatus: 200, checkedAt: new Date() },
    saves: 0,
    save() { this.saves += 1; return Promise.resolve(this); },
  };
  if (initialBundle) {
    a.sessionEncrypted = vaultCrypto.encrypt(JSON.stringify(initialBundle));
    a.cookieHash = authCookieHash(initialBundle, REF);
    a.bundleVersion = 1;
  }
  return a;
}
/** Enrol a device with its own credential and a fresh heartbeat, as a live install would. */
function enrol(acct, name, opts = {}) {
  const { code } = deviceSync.createPairingCode(acct, name);
  const r = deviceSync.redeemPairingCode(acct, code, { hostname: name, agentVersion: opts.agentVersion || '3.5.0' });
  const row = deviceSync.findDevice(acct, r.deviceId);
  row.lastSeenAt = opts.lastSeenAt === null ? null : (opts.lastSeenAt || ago(30 * 1000));
  row.agentVersion = opts.agentVersion || '3.5.0';
  return { row, key: r.deviceKey, deviceId: r.deviceId };
}
/** Give a device the active-source title directly, as a completed earlier activation would have. */
function makeSourceOf(acct, dev, b) {
  acct.activeSource = { deviceId: dev.deviceId, name: dev.row.name, promotedAt: ago(60000), bundleVersion: acct.bundleVersion || 1 };
  if (b) { acct.sessionEncrypted = vaultCrypto.encrypt(JSON.stringify(b)); acct.cookieHash = authCookieHash(b, REF); }
  dev.row.promotionCount = (dev.row.promotionCount || 0) + 1;
}
/**
 * The whole admin-side Mark Active, exactly as the route performs it: validate the target, open the
 * transaction, mint the addressed command. Returns what the target device would receive.
 */
function markActive(acct, dev) {
  const st = deviceState.stateOf(acct, dev.row, { staleMs: STALE_MS });
  if (!deviceState.canActivate(st.state)) return { ok: false, code: 'DEVICE_' + st.state, state: st.state };
  const t = agentCommands.validateTarget(acct, dev.deviceId, {
    requireActiveSource: false, requireOnline: true, requireCommandSupport: true,
    requireActivationSupport: true, staleMs: STALE_MS,
  });
  if (!t.ok) return { ok: false, code: t.code, state: st.state };
  const act = activation.create(acct, { device: t.device, issuedBy: 'admin1' });
  const q = agentCommands.enqueue(acct, {
    type: 'capture-and-activate', tool: TOOL, device: t.device,
    activationId: act.activation.activationId, activationNonce: act.activation.nonce,
  });
  activation.attachCommand(acct, act.activation.activationId, q.command.id);
  return { ok: true, activation: act.activation, commandId: q.command.id };
}
/** What the device gets when it polls, and the capability it can then spend. */
function poll(acct, dev) { return agentCommands.takeFor(acct, dev.row, { tool: TOOL, agentVersion: dev.row.agentVersion }); }
/** The ingest boundary: validate the presented capability, then ingest. Mirrors agentSync.js. */
async function push(acct, dev, b, cap) {
  let act = null;
  if (cap && cap.activationId) {
    const v = activation.validate(acct, { activationId: cap.activationId, deviceId: dev.deviceId, nonce: cap.activationNonce });
    if (!v.ok) return { code: v.code, rejected: true };
    act = v.activation;
  }
  return ingestCandidate(acct, TOOL, dev.row, b.cookies, { activation: act });
}
function reset() { nextVerify = { result: 'working', httpStatus: 200, maskedId: 'op***@example.com' }; verifyCalls = []; }

// ── 1. NEW RDP ────────────────────────────────────────────────────────────────
test('a brand-new RDP is READY, and Mark Active captures, verifies and promotes it', async () => {
  reset();
  const b = bundle(1000);
  const a = account(b);
  const local = enrol(a, 'LOCAL-PC');
  makeSourceOf(a, local, b);
  const rdp = enrol(a, 'RDP-B');

  assert.strictEqual(deviceState.stateOf(a, rdp.row, { staleMs: STALE_MS }).state, 'READY',
    'a device that has never held the session and is online is READY');
  assert.strictEqual(deviceState.stateOf(a, local.row, { staleMs: STALE_MS }).state, 'ACTIVE');

  const m = markActive(a, rdp);
  assert.strictEqual(m.ok, true);
  assert.strictEqual(activation.current(a).stage, 'WAITING_FOR_AGENT', 'the transaction is open and addressed');

  // ONLY the target device may collect the capture command.
  assert.strictEqual(poll(a, local), null, 'the previous source must never receive the capture command');
  const cmd = poll(a, rdp);
  assert.ok(cmd, 'the addressed device receives it');
  assert.strictEqual(cmd.type, 'capture-and-activate');
  assert.strictEqual(cmd.targetDeviceId, rdp.deviceId);
  assert.ok(cmd.activationId && cmd.activationNonce, 'the capability travels with the command');

  const r = await push(a, rdp, bundle(2000, null, 'sess-B'), cmd);
  assert.strictEqual(r.code, CODES.PROMOTED);
  assert.strictEqual(a.activeSource.deviceId, rdp.deviceId, 'RDP-B is now the sole active source');
  assert.strictEqual(a.activeSource.via, 'activation');
  assert.strictEqual(activation.current(a).stage, 'ACTIVE', 'the transaction ended in ACTIVE, not "syncing"');
  assert.deepStrictEqual(deviceState.activeConflicts(a, { staleMs: STALE_MS }), [], 'exactly one ACTIVE device');
  assert.strictEqual(deviceState.stateOf(a, local.row, { staleMs: STALE_MS }).state, 'STANDBY',
    'the previous source is demoted to STANDBY');
  assert.ok(verifyCalls.some(o => o.canary === true), 'an activation proves the account with a REAL check, not a JWT decode');
});

// ── 2. SAME COOKIE / SAME SESSION — the case that could never work ────────────
test('Mark Active works when the new machine holds the IDENTICAL session', async () => {
  reset();
  const b = bundle(1000, null, 'sess-A');
  const a = account(b);
  const local = enrol(a, 'LOCAL-PC');
  makeSourceOf(a, local, b);
  const rdp = enrol(a, 'RDP-B');

  // Without an activation this push is the old dead end: same cookies, same hash, no switch.
  const idle = await push(a, rdp, b, null);
  assert.strictEqual(idle.code, CODES.STANDBY_ROUTINE_REFRESH, 'a standby push is recorded, never promoted');
  assert.strictEqual(a.activeSource.deviceId, local.deviceId);

  const versionBefore = a.bundleVersion;
  const encryptedBefore = a.sessionEncrypted;
  const m = markActive(a, rdp);
  const cmd = poll(a, rdp);
  const r = await push(a, rdp, b, cmd);   // byte-for-byte the SAME bundle

  assert.strictEqual(r.code, CODES.PROMOTED, 'an identical bundle still completes the activation');
  assert.strictEqual(a.activeSource.deviceId, rdp.deviceId, 'the source switched');
  assert.strictEqual(a.bundleVersion, versionBefore, 'no version inflation for an unchanged bundle');
  assert.strictEqual(a.sessionEncrypted, encryptedBefore, 'the encrypted bundle was not needlessly rewritten');
  assert.strictEqual(r.bundleRewritten, false);
  assert.strictEqual(activation.current(a).stage, 'ACTIVE');
  assert.strictEqual(m.ok, true);
});

test('an activation is single-use — the same capability cannot switch the source twice', async () => {
  reset();
  const b = bundle(1000);
  const a = account(b);
  const local = enrol(a, 'LOCAL-PC');
  makeSourceOf(a, local, b);
  const rdp = enrol(a, 'RDP-B');

  markActive(a, rdp);
  const cmd = poll(a, rdp);
  await push(a, rdp, bundle(2000, null, 'sess-B'), cmd);
  assert.strictEqual(a.activeSource.deviceId, rdp.deviceId);

  // Replaying the same capability is refused: the transaction is complete.
  const replay = await push(a, local, bundle(3000, null, 'sess-C'), cmd);
  assert.strictEqual(replay.rejected, true);
  assert.strictEqual(replay.code, activation.CODES.ACTIVATION_COMPLETE);
  assert.strictEqual(a.activeSource.deviceId, rdp.deviceId, 'no ping-pong');
});

// ── 3. OLD SOURCE ─────────────────────────────────────────────────────────────
test('the demoted source keeps rotating its own cookies and can never replace the active bundle', async () => {
  reset();
  const a = account(bundle(1000));
  const local = enrol(a, 'LOCAL-PC');
  makeSourceOf(a, local, bundle(1000));
  const rdp = enrol(a, 'RDP-B');
  const cmd = (markActive(a, rdp), poll(a, rdp));
  await push(a, rdp, bundle(2000, null, 'sess-B'), cmd);
  const afterSwitch = a.sessionEncrypted;
  const versionAfterSwitch = a.bundleVersion;

  // The old machine rotates its token repeatedly — newer `iat` every time, a different session id,
  // and even a signed-out→signed-in transition. Under the old policy each of these could seize the
  // title back. None of them may now.
  for (const [iat, sid] of [[3000, 'sess-A'], [4000, 'sess-OLD-NEW'], [5000, 'sess-OLD-NEW']]) {
    deviceSync.noteDeviceAuthState(local.row, false, new Date());   // signed out…
    deviceSync.noteDeviceAuthState(local.row, true, new Date());    // …and back in
    const r = await push(a, local, bundle(iat, null, sid), null);
    assert.strictEqual(r.code, CODES.STANDBY_ROUTINE_REFRESH, 'standby data, never a promotion');
    assert.strictEqual(r.standby, true);
  }
  assert.strictEqual(a.activeSource.deviceId, rdp.deviceId, 'the active source never moved');
  assert.strictEqual(a.sessionEncrypted, afterSwitch, 'the active bundle was never replaced');
  assert.strictEqual(a.bundleVersion, versionAfterSwitch, 'no version churn from a standby');
});

test('a standby receives no active-source command, and no rotate-token nudge', () => {
  const a = account(bundle(1000));
  const rdp = enrol(a, 'RDP-B');
  const local = enrol(a, 'LOCAL-PC');
  makeSourceOf(a, rdp, bundle(1000));
  local.row.demotedAt = new Date();

  assert.strictEqual(deviceState.stateOf(a, local.row, { staleMs: STALE_MS }).state, 'STANDBY');
  const t = agentCommands.validateTarget(a, local.deviceId, { requireActiveSource: true, staleMs: STALE_MS });
  assert.strictEqual(t.ok, false);
  assert.strictEqual(t.code, agentCommands.CODES.DEVICE_NOT_ACTIVE_SOURCE);
  assert.strictEqual(deviceState.mayRefreshActiveBundle('STANDBY'), false);
});

// ── 4. REVOKED SOURCE ─────────────────────────────────────────────────────────
test('revoking a device makes it terminal, drops its commands and cancels its activation', () => {
  const a = account(bundle(1000));
  const local = enrol(a, 'LOCAL-PC');
  makeSourceOf(a, local, bundle(1000));
  const rdp = enrol(a, 'RDP-B');
  markActive(a, rdp);
  assert.ok(activation.inFlight(a), 'an activation is running');

  deviceSync.revokeDevice(a, rdp.deviceId, {});
  agentCommands.purgeForDevice(a, rdp.deviceId, 'device_revoked');
  activation.cancelForDevice(a, rdp.deviceId, 'The target device was revoked.');

  const st = deviceState.stateOf(a, rdp.row, { staleMs: STALE_MS });
  assert.strictEqual(st.state, 'REVOKED');
  assert.strictEqual(st.terminal, true);
  assert.strictEqual(deviceState.mayAct('REVOKED'), false);
  assert.strictEqual(poll(a, rdp), null, 'a revoked device is handed nothing');
  assert.strictEqual(activation.inFlight(a), null, 'the activation was cancelled, not left hanging');
  assert.strictEqual(activation.current(a).stage, 'FAILED');
  assert.ok(a.sessionEncrypted, 'revoking never deletes the stored session');
});

test('a revoked or superseded credential cannot authenticate, and is never silently un-revoked', () => {
  const a = account(bundle(1000));
  const d = enrol(a, 'RDP-B');
  assert.strictEqual(deviceSync.authenticateDevice(a, d.deviceId, d.key).ok, true);
  deviceSync.revokeDevice(a, d.deviceId, { force: true });
  assert.strictEqual(deviceSync.authenticateDevice(a, d.deviceId, d.key).code, CODES.DEVICE_REVOKED);
  // Re-registering under the SAME id must not resurrect the row — a reinstall enrols a new one.
  assert.strictEqual(deviceSync.autoRegisterDevice(a, d.deviceId, {}).code, CODES.DEVICE_REVOKED);
});

// ── 5. UNINSTALL ──────────────────────────────────────────────────────────────
test('uninstall retires the device, clears activeSourceId and selects NO replacement', () => {
  const a = account(bundle(1000));
  const local = enrol(a, 'LOCAL-PC');
  const rdp = enrol(a, 'RDP-B');
  makeSourceOf(a, rdp, bundle(1000));

  const r = deviceSync.markUninstalled(a, rdp.deviceId, { reason: 'agent_uninstalled' });
  assert.strictEqual(r.ok, true);
  assert.strictEqual(r.activeSourceCleared, true);
  assert.strictEqual(a.activeSource, null, 'the pointer is cleared, not left aimed at a dead machine');
  assert.strictEqual(r.bundlePreserved, true);
  assert.ok(a.sessionEncrypted, 'the last verified bundle keeps serving');

  const st = deviceState.stateOf(a, rdp.row, { staleMs: STALE_MS });
  assert.strictEqual(st.state, 'UNINSTALLED');
  assert.strictEqual(st.terminal, true);
  assert.strictEqual(deviceSync.authenticateDevice(a, rdp.deviceId, rdp.key).code, CODES.DEVICE_UNINSTALLED,
    'the credential dies with the installation even if the local wipe was interrupted, and the refusal names the real reason');
  // Nothing was auto-promoted in its place.
  assert.strictEqual(deviceState.stateOf(a, local.row, { staleMs: STALE_MS }).state, 'READY');
  assert.deepStrictEqual(deviceState.fleet(a, { staleMs: STALE_MS }).filter(f => f.state === 'ACTIVE'), []);
});

// ── 6. REINSTALL AFTER REVOCATION ─────────────────────────────────────────────
test('reinstalling after a revoke enrols a NEW identity and supersedes the old row', () => {
  const a = account(bundle(1000));
  const old = enrol(a, 'RDP-B');
  deviceSync.revokeDevice(a, old.deviceId, { force: true });

  // The installer archived the old identity; the agent enrols a brand-new one.
  const fresh = deviceSync.autoRegisterDevice(a, 'agent_' + crypto.randomBytes(16).toString('hex'), { hostname: 'RDP-B', agentVersion: '3.5.0' });
  assert.strictEqual(fresh.ok, true);
  assert.notStrictEqual(fresh.device.deviceId, old.deviceId, 'a new identity, never the revoked one');
  assert.ok(fresh.issuedKey && fresh.issuedKey !== old.key, 'a new credential');

  const sup = deviceSync.supersedePriorDevices(a, fresh.device.deviceId, {});
  assert.deepStrictEqual(sup.superseded, [old.deviceId]);
  assert.strictEqual(deviceState.stateOf(a, old.row, { staleMs: STALE_MS }).state, 'REVOKED',
    'the revoked row stays revoked — supersession never un-revokes anything');
  // Exactly one operational row for the machine.
  const live = deviceSync.liveDevices(a);
  assert.strictEqual(live.length, 1);
  assert.strictEqual(live[0].deviceId, fresh.device.deviceId);
});

// ── 7. REVOKE ALL, THEN A NEW RDP ─────────────────────────────────────────────
test('with every device revoked there is no active source, and a new RDP can still take over', async () => {
  reset();
  const b = bundle(1000);
  const a = account(b);
  const one = enrol(a, 'LOCAL-PC');
  const two = enrol(a, 'RDP-A');
  makeSourceOf(a, one, b);

  for (const d of [one, two]) {
    deviceSync.revokeDevice(a, d.deviceId, { force: true });
    agentCommands.purgeForDevice(a, d.deviceId, 'device_revoked');
  }
  a.activeSource = null;                       // as the revoke route clears it
  assert.ok(a.sessionEncrypted, 'the last verified bundle is preserved through a revoke-all');
  assert.deepStrictEqual(deviceState.fleet(a, { staleMs: STALE_MS }).filter(f => f.state !== 'REVOKED'), []);

  const fresh = enrol(a, 'RDP-NEW');
  const m = markActive(a, fresh);
  assert.strictEqual(m.ok, true);
  const cmd = poll(a, fresh);
  const r = await push(a, fresh, bundle(5000, null, 'sess-NEW'), cmd);
  assert.strictEqual(r.code, CODES.PROMOTED);
  assert.strictEqual(a.activeSource.deviceId, fresh.deviceId);
});

// ── 8. ACTIVE SOURCE OFFLINE ──────────────────────────────────────────────────
test('an offline active source is reported OFFLINE, and nothing is promoted in its place', async () => {
  reset();
  const b = bundle(1000);
  const a = account(b);
  const rdp = enrol(a, 'RDP-B');
  const local = enrol(a, 'LOCAL-PC');
  makeSourceOf(a, rdp, b);
  rdp.row.lastSeenAt = ago(60 * 60 * 1000);    // switched off an hour ago

  const st = deviceState.stateOf(a, rdp.row, { staleMs: STALE_MS });
  assert.strictEqual(st.state, 'OFFLINE');
  assert.strictEqual(st.isActiveSource, true, 'still the named source — it is simply not there');
  assert.match(st.reason, /Active source is offline/);

  // The online standby keeps pushing. It must not inherit the session.
  const r = await push(a, local, bundle(9000, null, 'sess-LOCAL'), null);
  assert.strictEqual(r.code, CODES.STANDBY_ROUTINE_REFRESH);
  assert.strictEqual(a.activeSource.deviceId, rdp.deviceId, 'no automatic fallback source');
  assert.ok(a.sessionEncrypted);

  // And Open Chrome refuses with the offline wording rather than opening a browser elsewhere.
  const t = agentCommands.validateTarget(a, rdp.deviceId, { requireActiveSource: true, requireOnline: true, staleMs: STALE_MS });
  assert.strictEqual(t.code, agentCommands.CODES.ACTIVE_SOURCE_OFFLINE);
});

// ── 9. WRONG-DEVICE ROUTING ───────────────────────────────────────────────────
test('every capture command goes to the named device and to nobody else', () => {
  const a = account(bundle(1000));
  const local = enrol(a, 'LOCAL-PC', { lastSeenAt: ago(1000) });   // MORE recently seen
  const rdpA = enrol(a, 'RDP-A');
  const rdpB = enrol(a, 'RDP-B');
  makeSourceOf(a, local, bundle(1000));

  markActive(a, rdpB);
  assert.strictEqual(poll(a, local), null, 'not the admin’s own machine');
  assert.strictEqual(poll(a, rdpA), null, 'not the other online RDP');
  const got = poll(a, rdpB);
  assert.ok(got && got.targetDeviceId === rdpB.deviceId);
  assert.strictEqual(poll(a, rdpB), null, 'and it is single-use');
});

test('a device cannot spend an activation addressed to another device, even holding the id', async () => {
  reset();
  const a = account(bundle(1000));
  const local = enrol(a, 'LOCAL-PC');
  makeSourceOf(a, local, bundle(1000));
  const rdpA = enrol(a, 'RDP-A');
  const rdpB = enrol(a, 'RDP-B');

  const m = markActive(a, rdpB);
  const stolen = { activationId: m.activation.activationId, activationNonce: m.activation.nonce };
  const r = await push(a, rdpA, bundle(4000, null, 'sess-X'), stolen);
  assert.strictEqual(r.rejected, true);
  assert.strictEqual(r.code, activation.CODES.ACTIVATION_WRONG_DEVICE);
  assert.strictEqual(a.activeSource.deviceId, local.deviceId);

  // …and the right device with the wrong nonce gets nowhere either.
  const bad = await push(a, rdpB, bundle(4000, null, 'sess-X'), { activationId: m.activation.activationId, activationNonce: 'f'.repeat(64) });
  assert.strictEqual(bad.code, activation.CODES.ACTIVATION_NONCE_INVALID);
});

// ── "syncing forever" ─────────────────────────────────────────────────────────
test('every activation ends: success, stated failure, or expiry — never an open spinner', async () => {
  reset();
  const a = account(bundle(1000));
  const local = enrol(a, 'LOCAL-PC');
  makeSourceOf(a, local, bundle(1000));
  const rdp = enrol(a, 'RDP-B');

  // (a) verification fails -> FAILED with a reason, previous source untouched.
  markActive(a, rdp);
  const cmd = poll(a, rdp);
  nextVerify = { result: 'session_expired', httpStatus: 401, maskedId: null };
  const r = await push(a, rdp, bundle(2000, null, 'sess-B'), cmd);
  assert.strictEqual(r.code, CODES.SESSION_EXPIRED);
  const failed = activation.publicView(a);
  assert.strictEqual(failed.stage, 'FAILED');
  assert.strictEqual(failed.terminal, true);
  assert.ok(failed.message && failed.message.length > 0, 'a failure always carries a sentence');
  assert.strictEqual(a.activeSource.deviceId, local.deviceId, 'the previous source kept the session');

  // (b) nobody completes it -> EXPIRED on its own.
  reset();
  markActive(a, rdp);
  a.activation.expiresAt = new Date(Date.now() - 1000);
  const view = activation.publicView(a);
  assert.strictEqual(view.stage, 'EXPIRED');
  assert.strictEqual(view.inFlight, false);
});

test('the UI always has a real stage, and the required wordings are exact', () => {
  const a = account(bundle(1000));
  const rdp = enrol(a, 'RDP-B');
  markActive(a, rdp);

  assert.strictEqual(activation.stageMessage('WAITING_FOR_AGENT', { deviceOffline: true }), 'Target RDP agent is offline.');
  assert.strictEqual(activation.stageMessage('OPENING_CHROME', {}), 'Opening WriteHuman Chrome on the selected RDP.');
  assert.strictEqual(activation.stageMessage('WAITING_FOR_AUTH_COOKIES', {}), 'Waiting for a signed-in WriteHuman session on this RDP.');
  for (const stage of activation.STAGES) {
    assert.ok(activation.stageMessage(stage, {}).length > 0, stage + ' must have an operator-facing sentence');
  }
});

test('stages only move forward, and an agent cannot claim a server-side stage', () => {
  const a = account(bundle(1000));
  const rdp = enrol(a, 'RDP-B');
  const m = markActive(a, rdp);
  const id = m.activation.activationId;

  activation.advance(a, { activationId: id, deviceId: rdp.deviceId, stage: 'CAPTURING', fromAgent: true });
  assert.strictEqual(activation.current(a).stage, 'CAPTURING');
  activation.advance(a, { activationId: id, deviceId: rdp.deviceId, stage: 'OPENING_CHROME', fromAgent: true });
  assert.strictEqual(activation.current(a).stage, 'CAPTURING', 'a late report never drags the stage backwards');

  const bad = activation.advance(a, { activationId: id, deviceId: rdp.deviceId, stage: 'ACTIVE', fromAgent: true });
  assert.strictEqual(bad.ok, false, 'only the server may declare ACTIVE');
  assert.strictEqual(activation.current(a).stage, 'CAPTURING');
});

test('the activation nonce is never exposed by any read projection', () => {
  const a = account(bundle(1000));
  const rdp = enrol(a, 'RDP-B');
  const m = markActive(a, rdp);
  const nonce = m.activation.nonce;
  assert.ok(nonce && nonce.length === 64);
  assert.ok(!JSON.stringify(activation.publicView(a)).includes(nonce), 'publicView must not leak the capability');
  assert.ok(!JSON.stringify(agentCommands.publicCommands(a)).includes(nonce), 'the command list must not leak it either');
  assert.ok(!JSON.stringify(activation.publicLog(a)).includes(nonce));
});

// ── the removed auto-handovers ────────────────────────────────────────────────
test('a "failed" active session no longer hands the source to a standby on its own', async () => {
  reset();
  const b = bundle(1000);
  const a = account(b);
  const rdp = enrol(a, 'RDP-B');
  const local = enrol(a, 'LOCAL-PC');
  makeSourceOf(a, rdp, b);
  a.session_status = 'needs_login';            // the active session looks dead

  const r = await push(a, local, bundle(7000, null, 'sess-LOCAL'), null);
  assert.strictEqual(r.code, CODES.STANDBY_ROUTINE_REFRESH,
    'automatic failover is gone: a machine nobody chose must not start supplying the session');
  assert.strictEqual(a.activeSource.deviceId, rdp.deviceId);
});

test('the very first device still bootstraps without an activation', async () => {
  reset();
  const a = account(null);                     // no bundle, no source yet
  const first = enrol(a, 'RDP-B');
  const r = await push(a, first, bundle(1000), null);
  assert.strictEqual(r.code, CODES.PROMOTED, 'nothing holds the title, so the first verified push takes it');
  assert.strictEqual(a.activeSource.deviceId, first.deviceId);
  assert.strictEqual(a.activeSource.via, 'bootstrap');
});

test('an agent cannot force a promotion by putting a flag in its own request body', async () => {
  reset();
  const b = bundle(1000);
  const a = account(b);
  const rdp = enrol(a, 'RDP-B');
  const local = enrol(a, 'LOCAL-PC');
  makeSourceOf(a, rdp, b);
  // The old ingest read `force` straight off the request body. `ingestCandidate` no longer honours
  // any such option — only a validated activation can relax the rules.
  const r = await ingestCandidate(a, TOOL, local.row, bundle(8000, null, 'sess-LOCAL').cookies, { force: true });
  assert.strictEqual(r.code, CODES.STANDBY_ROUTINE_REFRESH);
  assert.strictEqual(a.activeSource.deviceId, rdp.deviceId);
});

// ── device state machine invariants ───────────────────────────────────────────
test('the state machine has exactly the eight states, and terminal states outrank everything', () => {
  assert.deepStrictEqual(
    [...deviceState.STATES].sort(),
    ['ACTIVE', 'ERROR', 'OFFLINE', 'READY', 'REVOKED', 'STANDBY', 'SUPERSEDED', 'UNINSTALLED']);

  const a = account(bundle(1000));
  const d = enrol(a, 'RDP-B');
  makeSourceOf(a, d, bundle(1000));
  assert.strictEqual(deviceState.stateOf(a, d.row, { staleMs: STALE_MS }).state, 'ACTIVE');

  // Each terminal marker wins over being the active source.
  d.row.revoked = true;
  assert.strictEqual(deviceState.stateOf(a, d.row, { staleMs: STALE_MS }).state, 'REVOKED');
  d.row.revoked = false; d.row.uninstalledAt = new Date();
  assert.strictEqual(deviceState.stateOf(a, d.row, { staleMs: STALE_MS }).state, 'UNINSTALLED');
  d.row.uninstalledAt = null; d.row.supersededBy = 'dev_other';
  assert.strictEqual(deviceState.stateOf(a, d.row, { staleMs: STALE_MS }).state, 'SUPERSEDED');
  for (const s of deviceState.TERMINAL) assert.strictEqual(deviceState.mayAct(s), false);
});

test('only ACTIVE may refresh the live bundle, and only READY/STANDBY may be activated', () => {
  for (const s of deviceState.STATES) {
    assert.strictEqual(deviceState.mayRefreshActiveBundle(s), s === 'ACTIVE');
    assert.strictEqual(deviceState.canActivate(s), s === 'READY' || s === 'STANDBY');
  }
});

test('Mark Active is refused, with a reason, for every state that cannot hold the session', () => {
  const a = account(bundle(1000));
  const src = enrol(a, 'LOCAL-PC');
  makeSourceOf(a, src, bundle(1000));

  const offline = enrol(a, 'RDP-OFF', { lastSeenAt: ago(60 * 60 * 1000) });
  assert.strictEqual(markActive(a, offline).code, 'DEVICE_OFFLINE');

  const revoked = enrol(a, 'RDP-REV');
  deviceSync.revokeDevice(a, revoked.deviceId, { force: true });
  assert.strictEqual(markActive(a, revoked).code, 'DEVICE_REVOKED');

  const old = enrol(a, 'RDP-OLD', { agentVersion: '3.4.0' });
  const r = markActive(a, old);
  assert.strictEqual(r.ok, false);
  assert.strictEqual(r.code, agentCommands.CODES.ACTIVATION_VERSION_UNSUPPORTED,
    'an agent too old to run the capture is refused up front, not left looking like a dead click');

  assert.strictEqual(markActive(a, src).code, 'DEVICE_ACTIVE', 'the current source is already active');
});
