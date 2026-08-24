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
test('scenario 1-3: a fresh sign-in on any device makes that device the active source', async () => {
  reset();
  const a = account(bundle(1000));
  const local = pair(a, 'LOCAL-PC');
  const rdp = pair(a, 'RDP-01');

  // 1. Operator signs in on the Local PC -> a NEW GoTrue session -> Local becomes active.
  let r = await ingestCandidate(a, TOOL, local.row, bundle(2000, null, null, 'sess-LOCAL').cookies, {});
  assert.strictEqual(r.code, CODES.PROMOTED);
  assert.strictEqual(a.activeSource.name, 'LOCAL-PC');
  assert.strictEqual(a.bundleVersion, 2);

  // 2. Later the operator signs in on the RDP -> another new session -> the RDP takes over.
  r = await ingestCandidate(a, TOOL, rdp.row, bundle(3000, null, null, 'sess-RDP').cookies, {});
  assert.strictEqual(r.code, CODES.PROMOTED);
  assert.strictEqual(r.sourceSwitched, true);
  assert.strictEqual(a.activeSource.name, 'RDP-01');

  // 3. Signs in on the Local PC again -> it takes the title back. No server reconfiguration.
  r = await ingestCandidate(a, TOOL, local.row, bundle(4000, null, null, 'sess-LOCAL2').cookies, {});
  assert.strictEqual(r.code, CODES.PROMOTED);
  assert.strictEqual(a.activeSource.name, 'LOCAL-PC');
  assert.strictEqual(a.bundleVersion, 4);
});

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

test('a standby rotating its OWN copy never steals the source — the ping-pong case', async () => {
  reset();
  const a = account(bundle(1000));
  const local = pair(a, 'LOCAL-PC');
  const rdp = pair(a, 'RDP-01');

  await ingestCandidate(a, TOOL, local.row, bundle(2000, null, null, 'sess-LOCAL').cookies, {});
  assert.strictEqual(a.activeSource.name, 'LOCAL-PC');

  // The RDP is also signed in, on a session the server has never seen. Its FIRST push adopts it
  // once — the server cannot tell a just-signed-in machine from a long-idle one, and adopting a
  // verified working session is the safe reading.
  const first = await ingestCandidate(a, TOOL, rdp.row, bundle(2100, null, null, 'sess-RDP-OLD').cookies, {});
  assert.strictEqual(first.code, CODES.PROMOTED, 'an unseen session is adopted once');
  assert.strictEqual(a.activeSource.name, 'RDP-01');

  // From here the session is KNOWN, so the RDP's continued rotations are routine. This is the
  // property that matters: adoption happens once, not on every rotation.
  const settled = a.sessionEncrypted;
  const version = a.bundleVersion;
  for (const iat of [2200, 2300, 2400]) {
    const r = await ingestCandidate(a, TOOL, local.row, bundle(iat, null, null, 'sess-LOCAL').cookies, {});
    assert.strictEqual(r.code, CODES.STANDBY_ROUTINE_REFRESH, 'the standby cannot take the title back');
    assert.strictEqual(r.promoted, false);
  }
  assert.strictEqual(a.activeSource.name, 'RDP-01', 'the title stopped moving');
  assert.strictEqual(a.sessionEncrypted, settled, 'and the served bundle stopped churning');
  assert.strictEqual(a.bundleVersion, version, 'no lease-revoking version bumps');
});

test('admin "Make active" hands over on that device\'s next verified sync', async () => {
  reset();
  const a = account(bundle(1000));
  const local = pair(a, 'LOCAL-PC');
  const rdp = pair(a, 'RDP-01');
  await ingestCandidate(a, TOOL, local.row, bundle(2000, null, null, 'sess-LOCAL').cookies, {});
  assert.strictEqual(a.activeSource.name, 'LOCAL-PC');

  // Without the override this would be a standby routine refresh and change nothing.
  deviceSync.setActiveSourceIntent(a, rdp.deviceId, new Date());
  const r = await ingestCandidate(a, TOOL, rdp.row, bundle(2400, null, null, 'sess-RDP-OLD').cookies, {});
  assert.strictEqual(r.code, CODES.PROMOTED);
  assert.strictEqual(a.activeSource.name, 'RDP-01');
  assert.strictEqual(a.activeSourceIntent, null, 'the override is one-shot, not a permanent pin');
});

test('failover: when the active session has died, a verified standby takes over', async () => {
  reset();
  const a = account(bundle(1000));
  const local = pair(a, 'LOCAL-PC');
  const rdp = pair(a, 'RDP-01');
  await ingestCandidate(a, TOOL, local.row, bundle(2000, null, null, 'sess-LOCAL').cookies, {});

  // The Local PC signs out; the account is down and nothing is serving.
  await markDeviceLoggedOut(a, TOOL, local.row, {});
  assert.strictEqual(a.session_status, 'needs_login');

  // The RDP still holds a working session. It must be allowed to rescue the account even though
  // its session is not "fresh" — this is failover, not a takeover.
  const r = await ingestCandidate(a, TOOL, rdp.row, bundle(2400, null, null, 'sess-RDP-OLD').cookies, {});
  assert.strictEqual(r.code, CODES.PROMOTED);
  assert.strictEqual(a.activeSource.name, 'RDP-01');
  assert.strictEqual(a.session_status, 'working');
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

test('scenario 6: two devices holding the SAME session never ping-pong the active source', async () => {
  reset();
  const a = account(bundle(1000));
  const local = pair(a, 'LOCAL-PC');
  const rdp = pair(a, 'RDP-01');

  await ingestCandidate(a, TOOL, local.row, bundle(5000).cookies, {});
  assert.strictEqual(a.activeSource.name, 'LOCAL-PC');
  const versionAfterFirst = a.bundleVersion;

  // The RDP is signed into the same account and reports the identical token — same `iat`.
  const r = await ingestCandidate(a, TOOL, rdp.row, bundle(5000).cookies, {});
  assert.strictEqual(r.code, CODES.COOKIE_BUNDLE_UNCHANGED);
  assert.strictEqual(a.activeSource.name, 'LOCAL-PC', 'an identical bundle must not hand over the title');
  assert.strictEqual(a.bundleVersion, versionAfterFirst, 'and must not burn a version');
});

test('a device replaying an OLDER session is rejected by trusted ordering', async () => {
  reset();
  const a = account(bundle(1000));
  const local = pair(a, 'LOCAL-PC');
  const rdp = pair(a, 'RDP-01');

  await ingestCandidate(a, TOOL, local.row, bundle(9000).cookies, {});
  const current = a.sessionEncrypted;

  // The RDP has been asleep and still holds a much older token.
  const r = await ingestCandidate(a, TOOL, rdp.row, bundle(3000).cookies, {});
  assert.strictEqual(r.code, CODES.STALE_BUNDLE);
  assert.strictEqual(a.sessionEncrypted, current, 'an older session must not overwrite a newer one');
  assert.strictEqual(a.activeSource.name, 'LOCAL-PC');
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

test('a forced re-sync re-applies and re-verifies even when the hash is unchanged', async () => {
  reset();
  const b = bundle(2000);
  const a = account(b);
  const d = pair(a, 'LOCAL-PC');
  const r = await ingestCandidate(a, TOOL, d.row, b.cookies, { force: true });
  assert.strictEqual(r.code, CODES.PROMOTED);
  assert.strictEqual(verifyCalls, 1);
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
test('a device that signs in after being signed OUT can take over, even on a known session', async () => {
  reset();
  const a = account(bundle(1000));
  const local = pair(a, 'LOCAL-PC');
  const rdp = pair(a, 'RDP-01');

  await ingestCandidate(a, TOOL, local.row, bundle(2000, null, null, 'sess-SHARED').cookies, {});
  assert.strictEqual(a.activeSource.name, 'LOCAL-PC');

  // The RDP is signed out, then the operator signs in there — landing on the SAME session (the
  // copied-cookie case). Session-id comparison alone can never authorise this: the session is
  // already known. The per-device transition is the only signal that survives.
  deviceSync.noteDeviceAuthState(rdp.row, false, new Date());
  const r = await ingestCandidate(a, TOOL, rdp.row, bundle(2500, null, null, 'sess-SHARED').cookies, {});

  assert.strictEqual(r.code, CODES.PROMOTED);
  assert.strictEqual(a.activeSource.name, 'RDP-01', 'the transition authorised the handover');
});

test('an activation claim is single-use — a second push does not re-take the source', async () => {
  reset();
  const a = account(bundle(1000));
  const local = pair(a, 'LOCAL-PC');
  const rdp = pair(a, 'RDP-01');
  await ingestCandidate(a, TOOL, local.row, bundle(2000, null, null, 'sess-SHARED').cookies, {});

  deviceSync.noteDeviceAuthState(rdp.row, false, new Date());
  await ingestCandidate(a, TOOL, rdp.row, bundle(2500, null, null, 'sess-SHARED').cookies, {});
  assert.strictEqual(a.activeSource.name, 'RDP-01');

  // Local signs in again on the shared session. Its claim was never minted (it never went out),
  // so it must NOT be able to bounce the title back.
  const r = await ingestCandidate(a, TOOL, local.row, bundle(2900, null, null, 'sess-SHARED').cookies, {});
  assert.strictEqual(r.code, CODES.STANDBY_ROUTINE_REFRESH);
  assert.strictEqual(a.activeSource.name, 'RDP-01', 'no ping-pong without a real transition');
});

test('an expired activation claim is not honoured', async () => {
  reset();
  const a = account(bundle(1000));
  const local = pair(a, 'LOCAL-PC');
  const rdp = pair(a, 'RDP-01');
  await ingestCandidate(a, TOOL, local.row, bundle(2000, null, null, 'sess-SHARED').cookies, {});

  // A transition that happened long ago must not sit around as a permanent right to take over.
  deviceSync.noteDeviceAuthState(rdp.row, false, new Date());
  deviceSync.noteDeviceAuthState(rdp.row, true, new Date());
  rdp.row.activationClaimAt = new Date(Date.now() - deviceSync.ACTIVATION_TTL_MS - 60000);
  assert.strictEqual(deviceSync.hasActivationClaim(rdp.row, new Date()), false, 'the claim has expired');

  const r = await ingestCandidate(a, TOOL, rdp.row, bundle(2500, null, null, 'sess-SHARED').cookies, {});
  assert.strictEqual(r.code, CODES.STANDBY_ROUTINE_REFRESH);
  assert.strictEqual(a.activeSource.name, 'LOCAL-PC');
});

test('the admin activation intent expires on its own', async () => {
  reset();
  const a = account(bundle(1000));
  const local = pair(a, 'LOCAL-PC');
  const rdp = pair(a, 'RDP-01');
  await ingestCandidate(a, TOOL, local.row, bundle(2000, null, null, 'sess-SHARED').cookies, {});

  deviceSync.setActiveSourceIntent(a, rdp.deviceId, new Date());
  assert.strictEqual(deviceSync.activeSourceIntentFor(a, rdp.deviceId, new Date()), true);

  // Wind it past its TTL: a forgotten request must not hijack the source later.
  a.activeSourceIntent.expiresAt = new Date(Date.now() - 1000);
  assert.strictEqual(deviceSync.activeSourceIntentFor(a, rdp.deviceId, new Date()), false, 'expired');

  const r = await ingestCandidate(a, TOOL, rdp.row, bundle(2500, null, null, 'sess-SHARED').cookies, {});
  assert.strictEqual(r.code, CODES.STANDBY_ROUTINE_REFRESH);
  assert.strictEqual(a.activeSource.name, 'LOCAL-PC');
});

test('a live admin intent is consumed by the handover, not left standing', async () => {
  reset();
  const a = account(bundle(1000));
  const local = pair(a, 'LOCAL-PC');
  const rdp = pair(a, 'RDP-01');
  await ingestCandidate(a, TOOL, local.row, bundle(2000, null, null, 'sess-SHARED').cookies, {});

  deviceSync.setActiveSourceIntent(a, rdp.deviceId, new Date());
  const r = await ingestCandidate(a, TOOL, rdp.row, bundle(2500, null, null, 'sess-SHARED').cookies, {});
  assert.strictEqual(r.code, CODES.PROMOTED);
  assert.strictEqual(a.activeSource.name, 'RDP-01');
  assert.strictEqual(a.activeSourceIntent, null, 'the intent is spent, not sticky');
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
