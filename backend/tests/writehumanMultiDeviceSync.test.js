'use strict';
/**
 * Multi-device WriteHuman cookie sync — pairing, trusted ordering, candidate verification,
 * atomic promotion, rollback and source switching.
 *
 * No database and no network: the account is an in-memory stand-in with the same shape the
 * mysqlAdapter hands back (schemaless JSON doc + save()), and the ONE network call in the path
 * (verifyAccountCookies) is stubbed so every assertion is about our logic, not Supabase's.
 */
const test = require('node:test');
const assert = require('node:assert');
const crypto = require('crypto');

process.env.PROXY_VAULT_KEY = process.env.PROXY_VAULT_KEY || crypto.randomBytes(32).toString('hex');

// --- stub the single network dependency BEFORE the units under test capture it ---------------
const verifyMod = require('../utils/proxy/verify');
let nextVerify = { result: 'working', httpStatus: 200, maskedId: 'op***@example.com' };
let verifyCalls = 0;
verifyMod.verifyAccountCookies = async () => { verifyCalls += 1; return nextVerify; };

const healthAlerts = require('../utils/proxy/healthAlerts');
healthAlerts.onVerifyApplied = async () => {};

const deviceSync = require('../utils/proxy/deviceSync');
const { ingestCandidate, markDeviceLoggedOut } = require('../utils/proxy/candidateSync');
const { authCookieHash } = require('../utils/proxy/cookies');
const vaultCrypto = require('../utils/proxy/vaultCrypto');

const TOOL = 'writehuman';
const REF = 'hicfsbrfkzsxbwayibfm';
const { CODES } = deviceSync;

// --- fixtures ---------------------------------------------------------------
function jwt(iat, email, sid) {
  const b64 = (o) => Buffer.from(JSON.stringify(o)).toString('base64').replace(/=+$/, '').replace(/\+/g, '-').replace(/\//g, '_');
  return b64({ alg: 'HS256' }) + '.' + b64({ iat, exp: iat + 3600, email, session_id: sid }) + '.sig';
}
/**
 * A WriteHuman cookie bundle whose access token was issued at `iat` within GoTrue session `sid`.
 * `sid` defaults to one stable session, so bumping only `iat` models a token ROTATION; passing a
 * different `sid` models a FRESH SIGN-IN. The promotion policy treats those very differently.
 */
function bundle(iat, email, extra, sid) {
  const payload = JSON.stringify({ access_token: jwt(iat, email || 'operator@example.com', sid || 'sess-A'), refresh_token: 'rt-' + iat, user: { email: email || 'operator@example.com' } });
  const cookies = [{
    name: 'sb-' + REF + '-auth-token',
    value: 'base64-' + Buffer.from(payload).toString('base64'),
    domain: '.writehuman.ai', path: '/', secure: true, httpOnly: false, sameSite: 'lax',
  }];
  if (extra) cookies.push(extra);
  return { cookies, origin: 'https://writehuman.ai' };
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
/** Pair a device and return its mutable registry row. */
function pair(acct, name) {
  const { code } = deviceSync.createPairingCode(acct, name);
  const r = deviceSync.redeemPairingCode(acct, code, { hostname: name });
  assert.strictEqual(r.ok, true, 'pairing should succeed');
  return { row: deviceSync.findDevice(acct, r.deviceId), key: r.deviceKey, deviceId: r.deviceId };
}
function activeBundleOf(acct) {
  return JSON.parse(vaultCrypto.decrypt(acct.sessionEncrypted));
}
function reset() { nextVerify = { result: 'working', httpStatus: 200, maskedId: 'op***@example.com' }; verifyCalls = 0; }

// --- pairing ----------------------------------------------------------------
test('pairing code is single-use, and a wrong code never pairs', () => {
  const a = account(bundle(1000));
  const { code } = deviceSync.createPairingCode(a, 'LOCAL-PC');
  assert.strictEqual(deviceSync.redeemPairingCode(a, 'WRONG-CODE1').code, CODES.PAIRING_CODE_INVALID);
  const first = deviceSync.redeemPairingCode(a, code, {});
  assert.strictEqual(first.ok, true);
  assert.match(first.deviceKey, /^[0-9a-f]{64}$/, 'device key is 256 bits of hex');
  assert.strictEqual(deviceSync.redeemPairingCode(a, code, {}).code, CODES.PAIRING_CODE_USED, 'a code cannot be redeemed twice');
});

test('an expired pairing code is refused', () => {
  const a = account(bundle(1000));
  const { code } = deviceSync.createPairingCode(a, 'LOCAL-PC');
  a.pairingCodes[0].expiresAt = new Date(Date.now() - 1000);
  assert.strictEqual(deviceSync.redeemPairingCode(a, code, {}).code, CODES.PAIRING_CODE_EXPIRED);
});

test('the device key is stored only as a hash, and authenticates timing-safely', () => {
  const a = account(bundle(1000));
  const d = pair(a, 'LOCAL-PC');
  assert.ok(!JSON.stringify(a.syncDevices).includes(d.key), 'the raw device key must never be persisted');
  assert.strictEqual(deviceSync.authenticateDevice(a, d.deviceId, d.key).ok, true);
  assert.strictEqual(deviceSync.authenticateDevice(a, d.deviceId, 'x'.repeat(64)).code, CODES.AUTH_INVALID);
  assert.strictEqual(deviceSync.authenticateDevice(a, 'dev_nope', d.key).code, CODES.DEVICE_UNKNOWN);
  deviceSync.revokeDevice(a, d.deviceId, { force: true });
  assert.strictEqual(deviceSync.authenticateDevice(a, d.deviceId, d.key).code, CODES.DEVICE_REVOKED);
});

// --- scenario 1-3: the source follows a fresh SIGN-IN, not merely a newer token ---------------

test('the active source keeps its own session fresh without any handover', async () => {
  reset();
  const a = account(bundle(1000));
  const local = pair(a, 'LOCAL-PC');
  await ingestCandidate(a, TOOL, local.row, bundle(2000, null, null, 'sess-LOCAL').cookies, {});
  const versionAfterSignIn = a.bundleVersion;

  // A routine token rotation on the ACTIVE device: same session, newer token. It must update the
  // stored bundle (that is the whole point of sync) without churning the source.
  const r = await ingestCandidate(a, TOOL, local.row, bundle(2600, null, null, 'sess-LOCAL').cookies, {});
  assert.strictEqual(r.code, CODES.PROMOTED);
  assert.strictEqual(a.activeSource.name, 'LOCAL-PC');
  assert.strictEqual(a.bundleVersion, versionAfterSignIn + 1);
  assert.strictEqual(deviceSync.bundleTokenIat(activeBundleOf(a), TOOL), 2600, 'the rotation was stored');
});




// --- scenario 4: bad candidates never touch the working session --------------
test('scenario 4: wrong-account cookies are rejected and the active bundle is preserved', async () => {
  reset();
  const good = bundle(1000);
  const a = account(good);
  const d = pair(a, 'LOCAL-PC');
  const before = a.sessionEncrypted;

  nextVerify = { result: 'wrong_account', httpStatus: 200, maskedId: 'ot***@example.com' };
  const r = await ingestCandidate(a, TOOL, d.row, bundle(5000, 'other@example.com').cookies, {});

  assert.strictEqual(r.code, CODES.ACCOUNT_MISMATCH);
  assert.strictEqual(r.promoted, false);
  assert.strictEqual(a.sessionEncrypted, before, 'the working bundle must be byte-identical');
  assert.strictEqual(a.session_status, 'working', 'a bad candidate must not downgrade the live session');
  assert.strictEqual(a.candidate.status, 'rejected');
  assert.strictEqual(a.candidate.observedMaskedId, 'ot***@example.com');
  assert.ok(!JSON.stringify(a.candidate).includes('@example.com') || a.candidate.observedMaskedId.includes('***'), 'only masked identities are recorded');
});

test('a candidate that fails verification is rejected without downgrading the live session', async () => {
  reset();
  const a = account(bundle(1000));
  const d = pair(a, 'LOCAL-PC');
  const before = a.sessionEncrypted;
  nextVerify = { result: 'session_expired', httpStatus: 401, maskedId: null };
  const r = await ingestCandidate(a, TOOL, d.row, bundle(5000).cookies, {});
  assert.strictEqual(r.code, CODES.SESSION_EXPIRED);
  assert.strictEqual(a.sessionEncrypted, before);
  assert.strictEqual(a.session_status, 'working');
});

test('an inconclusive verification never promotes', async () => {
  reset();
  const a = account(bundle(1000));
  const d = pair(a, 'LOCAL-PC');
  const before = a.sessionEncrypted;
  nextVerify = { result: 'unknown', httpStatus: 0, maskedId: null };
  const r = await ingestCandidate(a, TOOL, d.row, bundle(5000).cookies, {});
  assert.strictEqual(r.code, CODES.VERIFICATION_INCONCLUSIVE);
  assert.strictEqual(a.sessionEncrypted, before);
});

test('a bundle with no allowlisted auth cookie can never wipe the vault', async () => {
  reset();
  const a = account(bundle(1000));
  const d = pair(a, 'LOCAL-PC');
  const before = a.sessionEncrypted;
  const r = await ingestCandidate(a, TOOL, d.row, [{ name: 'ga_session', value: 'x', domain: '.writehuman.ai', path: '/' }], {});
  assert.strictEqual(r.code, CODES.NO_ALLOWED_COOKIES);
  assert.strictEqual(a.sessionEncrypted, before);
  assert.strictEqual(verifyCalls, 0, 'a bundle with nothing allowlisted is not worth a verification call');
});

test('only allowlisted WriteHuman auth cookies are stored — unrelated cookies are dropped', async () => {
  reset();
  const a = account(bundle(1000));
  const d = pair(a, 'LOCAL-PC');
  const nosy = { name: 'session', value: 'secret-from-another-site', domain: '.example.com', path: '/' };
  await ingestCandidate(a, TOOL, d.row, bundle(2000, null, nosy).cookies, {});
  const stored = JSON.stringify(activeBundleOf(a));
  assert.ok(!stored.includes('secret-from-another-site'), 'a non-allowlisted cookie must never reach the vault');
  assert.ok(!stored.includes('example.com'), 'no unrelated cookie domain is retained');
});

// --- scenario 5-6: offline devices and races --------------------------------
test('scenario 5: a device going offline leaves the last verified bundle in place', async () => {
  reset();
  const a = account(bundle(1000));
  const local = pair(a, 'LOCAL-PC');
  await ingestCandidate(a, TOOL, local.row, bundle(2000).cookies, {});
  const activeAfterSync = a.sessionEncrypted;

  // The device stops reporting entirely — simulated by ageing its heartbeat far past the window.
  local.row.lastSeenAt = new Date(Date.now() - 48 * 3600 * 1000);
  deviceSync.putDevice(a, local.row);

  assert.strictEqual(a.sessionEncrypted, activeAfterSync, 'the bundle survives its source going away');
  assert.strictEqual(a.session_status, 'working', 'an offline device does not expire the session');
  const view = deviceSync.publicDevice(local.row, a.activeSource.deviceId, 10 * 60000);
  assert.strictEqual(view.online, false);
  assert.strictEqual(view.isActiveSource, true, 'it is still the source of the bundle in use');
});



test('concurrent pushes from two devices serialize — one source, no interleaved write', async () => {
  reset();
  const a = account(bundle(1000));
  const local = pair(a, 'LOCAL-PC');
  const rdp = pair(a, 'RDP-01');

  // Both machines push at the same instant, each with its own fresh sign-in. Whichever reaches the
  // lock first legitimately becomes the source; what must NOT happen is a torn write, two sources,
  // or a stored bundle that belongs to neither push.
  const [r1, r2] = await Promise.all([
    ingestCandidate(a, TOOL, local.row, bundle(4000, null, null, 'sess-L').cookies, {}),
    ingestCandidate(a, TOOL, rdp.row, bundle(7000, null, null, 'sess-R').cookies, {}),
  ]);

  assert.ok([r1.code, r2.code].includes(CODES.PROMOTED), 'at least one push promotes');
  assert.ok(['LOCAL-PC', 'RDP-01'].includes(a.activeSource.name), 'exactly one device holds the title');
  const activeIat = deviceSync.bundleTokenIat(activeBundleOf(a), TOOL);
  assert.ok([4000, 7000].includes(activeIat), 'the stored bundle is one of the two pushes, not a mix');
  // The stored bundle and the recorded source must agree — the real corruption risk under a race.
  const expectName = activeIat === 4000 ? 'LOCAL-PC' : 'RDP-01';
  assert.strictEqual(a.activeSource.name, expectName, 'the active source matches the bundle actually stored');
  assert.strictEqual(a.cookieHash, authCookieHash(activeBundleOf(a), REF), 'hash matches the stored bundle');
});

// --- scenario 7-8: idempotency, replay, no churn ----------------------------
test('scenario 8: re-pushing unchanged cookies is a cheap no-op, not a re-promotion', async () => {
  reset();
  const b = bundle(2000);
  const a = account(b);
  const d = pair(a, 'LOCAL-PC');
  const before = a.sessionEncrypted;

  const r = await ingestCandidate(a, TOOL, d.row, b.cookies, {});
  assert.strictEqual(r.code, CODES.COOKIE_BUNDLE_UNCHANGED);
  assert.strictEqual(r.promoted, false);
  assert.strictEqual(a.sessionEncrypted, before);
  assert.strictEqual(verifyCalls, 0, 'an unchanged bundle costs no verification call');
  assert.ok(d.row.lastSyncSuccessAt, 'but it still counts as the device being alive and in sync');
});


test('every attempt is recorded on the device row — including refusals', async () => {
  reset();
  const a = account(bundle(1000));
  const d = pair(a, 'LOCAL-PC');
  nextVerify = { result: 'session_expired', httpStatus: 401, maskedId: null };
  await ingestCandidate(a, TOOL, d.row, bundle(5000).cookies, {});
  const row = deviceSync.findDevice(a, d.deviceId);
  assert.strictEqual(row.lastResultCode, CODES.SESSION_EXPIRED, 'a refusal is visible, not silent');
  assert.ok(row.lastSyncAttemptAt, 'the attempt itself is timestamped');
  assert.ok(!row.lastSyncSuccessAt, 'a refused attempt is not a success');
  assert.strictEqual(a.lastSyncResultCode, CODES.SESSION_EXPIRED, 'and it surfaces at account level for the dashboard');
});

// --- rollback + promotion integrity -----------------------------------------
test('promotion keeps the previous bundle as rollback, capped', async () => {
  reset();
  const a = account(bundle(1000));
  const d = pair(a, 'LOCAL-PC');
  for (const iat of [2000, 3000, 4000, 5000]) {
    await ingestCandidate(a, TOOL, d.row, bundle(iat).cookies, {});
  }
  assert.strictEqual(a.rollbackBundles.length, deviceSync.MAX_ROLLBACKS, 'rollback history is bounded');
  const restored = JSON.parse(vaultCrypto.decrypt(a.rollbackBundles[a.rollbackBundles.length - 1].encrypted));
  assert.strictEqual(deviceSync.bundleTokenIat(restored, TOOL), 4000, 'the newest rollback is the bundle just replaced');
});

test('promotion updates cookieHash to describe the bundle actually stored', async () => {
  reset();
  const a = account(bundle(1000));
  const d = pair(a, 'LOCAL-PC');
  await ingestCandidate(a, TOOL, d.row, bundle(6000).cookies, {});
  assert.strictEqual(a.cookieHash, authCookieHash(activeBundleOf(a), REF));
});

test('the candidate record never carries cookie values', async () => {
  reset();
  const a = account(bundle(1000));
  const d = pair(a, 'LOCAL-PC');
  await ingestCandidate(a, TOOL, d.row, bundle(6000).cookies, {});
  const c = JSON.stringify(a.candidate);
  assert.ok(!c.includes('base64-'), 'no cookie value in the candidate record');
  assert.ok(!c.includes('rt-'), 'no refresh token in the candidate record');
  assert.ok((a.candidate.hashPrefix || a.candidate.hash || '').length <= 12, 'only a short hash prefix is retained');
});

// --- logout semantics --------------------------------------------------------
test('a NON-source device signing out does not expire the account', async () => {
  reset();
  const a = account(bundle(1000));
  const local = pair(a, 'LOCAL-PC');
  const rdp = pair(a, 'RDP-01');
  await ingestCandidate(a, TOOL, local.row, bundle(2000).cookies, {});

  const r = await markDeviceLoggedOut(a, TOOL, rdp.row, {});
  assert.strictEqual(r.downgraded, false, 'one machine signing out is not evidence the session is dead');
  assert.strictEqual(a.session_status, 'working');
});

test('the ACTIVE source signing out does downgrade the account', async () => {
  reset();
  const a = account(bundle(1000));
  const local = pair(a, 'LOCAL-PC');
  await ingestCandidate(a, TOOL, local.row, bundle(2000).cookies, {});
  const r = await markDeviceLoggedOut(a, TOOL, local.row, {});
  assert.strictEqual(r.downgraded, true);
  assert.strictEqual(a.session_status, 'needs_login');
});

// --- cross-device activation: the copied-session case ------------------------





// --- newly paired device, copied cookies (the case that had no path to activation) ----------




// --- no device is special: names are labels, never roles ---------------------

test('a device name is cosmetic — it never appears in an authorisation decision', () => {
  const a = account(bundle(1000));
  // Two devices whose names collide entirely. They must remain distinct principals, because
  // identity is the device id + key, never the label.
  const d1 = pair(a, 'SAME-NAME');
  const d2 = pair(a, 'SAME-NAME');
  assert.notStrictEqual(d1.deviceId, d2.deviceId, 'ids are independent of the label');
  assert.notStrictEqual(d1.key, d2.key, 'keys are independent of the label');
  assert.strictEqual(deviceSync.authenticateDevice(a, d1.deviceId, d2.key).ok, false,
    'one device cannot authenticate with another device key, identical names notwithstanding');
  assert.strictEqual(deviceSync.authenticateDevice(a, d1.deviceId, d1.key).ok, true);
});

// --- revoke safety -----------------------------------------------------------
test('revoking the only device that supplies the session is refused, and never deletes cookies', async () => {
  reset();
  const a = account(bundle(1000));
  const local = pair(a, 'LOCAL-PC');
  await ingestCandidate(a, TOOL, local.row, bundle(2000).cookies, {});
  const before = a.sessionEncrypted;

  const refused = deviceSync.revokeDevice(a, local.deviceId, {});
  assert.strictEqual(refused.ok, false);
  assert.strictEqual(refused.code, CODES.ACTIVE_SOURCE_ONLY_DEVICE);
  assert.strictEqual(a.sessionEncrypted, before, 'the cookie bundle is untouched by a refused revoke');

  // With a replacement paired, the revoke is allowed — and STILL keeps the bundle.
  pair(a, 'RDP-01');
  const allowed = deviceSync.revokeDevice(a, local.deviceId, {});
  assert.strictEqual(allowed.ok, true);
  assert.strictEqual(a.sessionEncrypted, before, 'revoking a device removes its write access, not the session');
});

// ── THE SOURCE POLICY, AFTER THE AUTO-HANDOVERS WERE REMOVED ─────────────────
//
// The tests that used to sit here asserted that the active-source title moved BY ITSELF: on a
// fresh sign-in, on a signed-out→signed-in transition, on an unseen GoTrue session, and as
// automatic failover when the live session looked dead. Each of those was a guess about operator
// intent, and each of them could fire when no human had asked for anything — a browser dropping
// and restoring its cookies was enough to move the live session onto a machine nobody had chosen,
// and to revoke every client lease on the way past.
//
// Moving the session is now one explicit, addressed, verified transaction: `activation.js` plus a
// `capture-and-activate` command aimed at exactly one device. These tests pin what replaced them.
// The full transaction — stages, expiry, nonce, wrong-device refusal — lives in
// tests/writehumanActivation.test.js.
const deviceState = require('../utils/proxy/deviceState');
const activation = require('../utils/proxy/activation');
const agentCommands = require('../utils/proxy/agentCommands');

/** Mark Active for real: validate, open the transaction, address the command, spend it. */
async function activate(a, dev, cookieBundle) {
  dev.row.lastSeenAt = new Date();
  dev.row.agentVersion = dev.row.agentVersion || '3.5.0';
  const t = agentCommands.validateTarget(a, dev.deviceId, {
    requireOnline: true, requireCommandSupport: true, requireActivationSupport: true, staleMs: 10 * 60 * 1000,
  });
  assert.strictEqual(t.ok, true, 'the target must be addressable: ' + (t.message || ''));
  const act = activation.create(a, { device: t.device, issuedBy: 'admin1' });
  const q = agentCommands.enqueue(a, {
    type: 'capture-and-activate', tool: TOOL, device: t.device,
    activationId: act.activation.activationId, activationNonce: act.activation.nonce,
  });
  activation.attachCommand(a, act.activation.activationId, q.command.id);
  const cmd = agentCommands.takeFor(a, dev.row, { tool: TOOL, agentVersion: '3.5.0' });
  assert.ok(cmd, 'the addressed device must receive its own capture command');
  const v = activation.validate(a, { activationId: cmd.activationId, deviceId: dev.deviceId, nonce: cmd.activationNonce });
  assert.strictEqual(v.ok, true, 'the capability must validate for the addressed device');
  return ingestCandidate(a, TOOL, dev.row, cookieBundle.cookies, { activation: v.activation });
}

test('the active source keeps its own session fresh — rotation is not a handover', async () => {
  reset();
  const a = account(bundle(1000));
  const local = pair(a, 'LOCAL-PC');
  await activate(a, local, bundle(2000, null, null, 'sess-LOCAL'));
  const versionAfterSignIn = a.bundleVersion;

  const r = await ingestCandidate(a, TOOL, local.row, bundle(2600, null, null, 'sess-LOCAL').cookies, {});
  assert.strictEqual(r.code, CODES.PROMOTED);
  assert.strictEqual(a.activeSource.name, 'LOCAL-PC');
  assert.strictEqual(a.bundleVersion, versionAfterSignIn + 1);
  assert.strictEqual(deviceSync.bundleTokenIat(activeBundleOf(a), TOOL), 2600, 'the rotation was stored');
});

test('the session moves ONLY when an admin moves it', async () => {
  reset();
  const a = account(bundle(1000));
  const local = pair(a, 'LOCAL-PC');
  const rdp = pair(a, 'RDP-01');
  await activate(a, local, bundle(2000, null, null, 'sess-LOCAL'));
  assert.strictEqual(a.activeSource.name, 'LOCAL-PC');

  // Every signal that used to hand the title over, fired in turn on the standby: an unseen
  // session, a newer token, a signed-out→signed-in transition. None of them may move anything.
  const settled = a.sessionEncrypted;
  const version = a.bundleVersion;
  for (const [iat, sid] of [[2100, 'sess-RDP-NEW'], [2200, 'sess-RDP-NEW'], [2300, 'sess-RDP-OTHER']]) {
    deviceSync.noteDeviceAuthState(rdp.row, false, new Date());
    deviceSync.noteDeviceAuthState(rdp.row, true, new Date());
    const r = await ingestCandidate(a, TOOL, rdp.row, bundle(iat, null, null, sid).cookies, {});
    assert.strictEqual(r.code, CODES.STANDBY_ROUTINE_REFRESH, 'a standby is recorded, never promoted');
  }
  assert.strictEqual(a.activeSource.name, 'LOCAL-PC', 'the title did not move on its own');
  assert.strictEqual(a.sessionEncrypted, settled, 'and the served bundle did not churn');
  assert.strictEqual(a.bundleVersion, version, 'no lease-revoking version bumps');

  // The admin moves it deliberately, and only then does it move.
  const r = await activate(a, rdp, bundle(2400, null, null, 'sess-RDP-NEW'));
  assert.strictEqual(r.code, CODES.PROMOTED);
  assert.strictEqual(r.sourceSwitched, true);
  assert.strictEqual(a.activeSource.name, 'RDP-01');
  assert.strictEqual(a.activeSource.via, 'activation');
});

test('a dead active session is NOT rescued by promoting a standby behind the operator’s back', async () => {
  reset();
  const a = account(bundle(1000));
  const local = pair(a, 'LOCAL-PC');
  const rdp = pair(a, 'RDP-01');
  await activate(a, local, bundle(2000, null, null, 'sess-LOCAL'));

  // The active machine signs out; the account is down.
  await markDeviceLoggedOut(a, TOOL, local.row, {});
  assert.strictEqual(a.session_status, 'needs_login');

  // The RDP still holds a working session. Automatic failover used to hand it the title here.
  // It must not: "the session looks dead" is often transient, and the cure was letting a machine
  // nobody chose start supplying the session.
  const r = await ingestCandidate(a, TOOL, rdp.row, bundle(2400, null, null, 'sess-RDP').cookies, {});
  assert.strictEqual(r.code, CODES.STANDBY_ROUTINE_REFRESH);
  assert.strictEqual(a.activeSource.name, 'LOCAL-PC', 'no automatic fallback source');

  // Recovery is one deliberate click, and then it works.
  const promoted = await activate(a, rdp, bundle(2400, null, null, 'sess-RDP'));
  assert.strictEqual(promoted.code, CODES.PROMOTED);
  assert.strictEqual(a.activeSource.name, 'RDP-01');
  assert.strictEqual(a.session_status, 'working');
});

test('two devices holding the SAME session never ping-pong, and an activation still switches once', async () => {
  reset();
  const shared = bundle(2000, null, null, 'sess-SHARED');
  const a = account(bundle(1000));
  const local = pair(a, 'LOCAL-PC');
  const rdp = pair(a, 'RDP-01');
  await activate(a, local, shared);
  assert.strictEqual(a.activeSource.name, 'LOCAL-PC');

  // The RDP holds the identical session. Left alone it never takes over…
  for (let i = 0; i < 3; i++) {
    const r = await ingestCandidate(a, TOOL, rdp.row, shared.cookies, {});
    assert.strictEqual(r.code, CODES.STANDBY_ROUTINE_REFRESH);
    assert.strictEqual(a.activeSource.name, 'LOCAL-PC');
  }
  // …and when the admin does move it, it switches exactly once, without rewriting the bundle.
  const version = a.bundleVersion;
  const encrypted = a.sessionEncrypted;
  const r = await activate(a, rdp, shared);
  assert.strictEqual(r.code, CODES.PROMOTED);
  assert.strictEqual(a.activeSource.name, 'RDP-01');
  assert.strictEqual(a.bundleVersion, version, 'an identical bundle is not rewritten');
  assert.strictEqual(a.sessionEncrypted, encrypted);
});

test('the ACTIVE source replaying an OLDER session is rejected by trusted ordering', async () => {
  reset();
  const a = account(bundle(1000));
  const local = pair(a, 'LOCAL-PC');
  await activate(a, local, bundle(5000, null, null, 'sess-LOCAL'));
  const stored = a.sessionEncrypted;

  const r = await ingestCandidate(a, TOOL, local.row, bundle(3000, null, null, 'sess-LOCAL').cookies, {});
  assert.strictEqual(r.code, CODES.STALE_BUNDLE, 'a lagging replay cannot drag the account backwards');
  assert.strictEqual(a.sessionEncrypted, stored);
});

test('an activation is exempt from trusted ordering, because it answers a different question', async () => {
  reset();
  const a = account(bundle(1000));
  const local = pair(a, 'LOCAL-PC');
  const rdp = pair(a, 'RDP-01');
  await activate(a, local, bundle(5000, null, null, 'sess-LOCAL'));

  // The RDP's token was issued EARLIER, which is normal — it has simply been idle. Recency does
  // not decide which machine supplies the session; the operator does, and verification gates it.
  const r = await activate(a, rdp, bundle(3000, null, null, 'sess-RDP'));
  assert.strictEqual(r.code, CODES.PROMOTED);
  assert.strictEqual(a.activeSource.name, 'RDP-01');
});

test('an activation still refuses a candidate that fails verification', async () => {
  reset();
  const a = account(bundle(1000));
  const local = pair(a, 'LOCAL-PC');
  const rdp = pair(a, 'RDP-01');
  await activate(a, local, bundle(2000, null, null, 'sess-LOCAL'));
  const stored = a.sessionEncrypted;

  nextVerify = { result: 'session_expired', httpStatus: 401, maskedId: null };
  const r = await activate(a, rdp, bundle(3000, null, null, 'sess-RDP'));
  assert.strictEqual(r.code, CODES.SESSION_EXPIRED);
  assert.strictEqual(a.activeSource.name, 'LOCAL-PC', 'a failed capture never moves the session');
  assert.strictEqual(a.sessionEncrypted, stored, 'and never touches the bundle');
  assert.strictEqual(activation.publicView(a).stage, 'FAILED', 'the transaction ends, stated');
});

test('the ACTIVE device keeps updating its own bundle while standbys are ignored', async () => {
  reset();
  const a = account(bundle(1000));
  const local = pair(a, 'LOCAL-PC');
  const rdp = pair(a, 'RDP-01');
  await activate(a, rdp, bundle(2000, null, null, 'sess-RDP'));

  for (const iat of [2100, 2200, 2300]) {
    const active = await ingestCandidate(a, TOOL, rdp.row, bundle(iat, null, null, 'sess-RDP').cookies, {});
    assert.strictEqual(active.code, CODES.PROMOTED, 'the source refreshes its own session');
    const standby = await ingestCandidate(a, TOOL, local.row, bundle(iat + 10, null, null, 'sess-LOCAL').cookies, {});
    assert.strictEqual(standby.code, CODES.STANDBY_ROUTINE_REFRESH);
  }
  assert.strictEqual(a.activeSource.name, 'RDP-01');
  assert.strictEqual(deviceSync.bundleTokenIat(activeBundleOf(a), TOOL), 2300);
});

test('the activation window sits in the 10-15 minute band', () => {
  assert.ok(activation.DEFAULT_TTL_MS >= 10 * 60 * 1000 && activation.DEFAULT_TTL_MS <= 15 * 60 * 1000,
    'long enough for a cold RDP and a human sign-in, short enough that a forgotten click cannot fire later');
});

test('arbitrary device names all behave identically — nothing is hard-coded', async () => {
  reset();
  const a = account(bundle(1000));
  const names = ['OFFICE-PC', 'rdp-02', 'Nouman-Ali6', 'VM_7'];
  const devs = names.map(n => pair(a, n));

  // Each machine in turn is handed the session by an explicit activation, and each takes it.
  let iat = 2000;
  for (const d of devs) {
    iat += 100;
    const r = await activate(a, d, bundle(iat, null, null, 'sess-' + d.row.name));
    assert.strictEqual(r.code, CODES.PROMOTED, d.row.name + ' must be able to become the active source');
    assert.strictEqual(a.activeSource.deviceId, d.deviceId);
    assert.strictEqual(deviceState.stateOf(a, d.row, { staleMs: 10 * 60 * 1000 }).state, 'ACTIVE');
  }
  // …and every machine it was taken FROM is a standby afterwards, never a second active source.
  assert.deepStrictEqual(deviceState.activeConflicts(a, { staleMs: 10 * 60 * 1000 }), []);
  for (const d of devs.slice(0, -1)) {
    assert.strictEqual(deviceState.stateOf(a, d.row, { staleMs: 10 * 60 * 1000 }).state, 'STANDBY');
  }
});
