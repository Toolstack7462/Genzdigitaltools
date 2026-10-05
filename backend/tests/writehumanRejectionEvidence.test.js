'use strict';
/**
 * Rejection evidence must outlive the next success.
 *
 * 2026-10-05: from 03:19Z to 07:12Z the active source pushed 661 candidates and every one was refused
 * VERIFICATION_INCONCLUSIVE. Whether Chrome had failed to rotate (token expired) or the server could
 * not read a fresh token was the deciding question — and the one stored candidate that could have
 * answered it was overwritten the moment a later push was promoted. The account now keeps a small,
 * NON-SECRET record of the last refusal: when, which device, the code, the verifier's own reason, and
 * the candidate token's issued/expiry TIMES. Never a token, cookie or email.
 */
const test = require('node:test');
const assert = require('node:assert');
const crypto = require('crypto');

process.env.PROXY_VAULT_KEY = process.env.PROXY_VAULT_KEY || crypto.randomBytes(32).toString('hex');

const verifyMod = require('../utils/proxy/verify');
let nextVerify = null;
verifyMod.verifyAccountCookies = async () => nextVerify;
require('../utils/proxy/healthAlerts').onVerifyApplied = async () => {};

const deviceSync = require('../utils/proxy/deviceSync');
const { ingestCandidate } = require('../utils/proxy/candidateSync');
const { authCookieHash } = require('../utils/proxy/cookies');
const vaultCrypto = require('../utils/proxy/vaultCrypto');

const TOOL = 'writehuman';
const REF = 'hicfsbrfkzsxbwayibfm';
const ago = (ms) => new Date(Date.now() - ms);

function jwt(iat, sid) {
  const b64 = (o) => Buffer.from(JSON.stringify(o)).toString('base64').replace(/=+$/, '').replace(/\+/g, '-').replace(/\//g, '_');
  return b64({ alg: 'HS256' }) + '.' + b64({ iat, exp: iat + 3600, email: 'operator@example.com', session_id: sid }) + '.sig';
}
function bundle(iat) {
  const payload = JSON.stringify({ access_token: jwt(iat, 'sess-A'), refresh_token: 'rt-secret-' + iat, expires_at: iat + 3600 });
  return { cookies: [{ name: 'sb-' + REF + '-auth-token', value: 'base64-' + Buffer.from(payload).toString('base64'), domain: '.writehuman.ai', path: '/', secure: true }], origin: 'https://writehuman.ai' };
}
function setup() {
  const now = Math.floor(Date.now() / 1000);
  const live = bundle(now - 7200);
  const acct = {
    _id: 'acct1', tool: TOOL, isPrimary: true, status: 'active', session_status: 'working',
    verification: { result: 'working', maskedId: 'op***@example.com', httpStatus: 200, checkedAt: new Date() },
    sessionEncrypted: vaultCrypto.encrypt(JSON.stringify(live)), cookieHash: authCookieHash(live, REF), bundleVersion: 5,
    save() { return Promise.resolve(this); },
  };
  const { code } = deviceSync.createPairingCode(acct, 'WIN-SRC');
  const r = deviceSync.redeemPairingCode(acct, code, { hostname: 'WIN-SRC', agentVersion: '3.5.1' });
  const row = deviceSync.findDevice(acct, r.deviceId);
  row.lastSeenAt = ago(30000);
  acct.activeSource = { deviceId: r.deviceId, name: 'WIN-SRC', promotedAt: ago(3600000), bundleVersion: 5 };
  return { acct, row, now };
}

test('bundleTokenClaims exposes the token expiry time (not the token)', () => {
  const iat = 1_800_000_000;
  const c = deviceSync.bundleTokenClaims(bundle(iat), TOOL);
  assert.strictEqual(c.iat, iat);
  assert.strictEqual(c.exp, iat + 3600);
});

test('an expired-token refusal leaves non-secret evidence: when, who, code, real reason, token times', async () => {
  const { acct, row, now } = setup();
  const issued = now - 5400;   // a candidate whose token expired 30 minutes ago
  nextVerify = { result: 'unknown', httpStatus: 0, reason: 'readonly_no_exchange' };
  const r = await ingestCandidate(acct, TOOL, row, bundle(issued).cookies, {});
  assert.strictEqual(r.code, 'VERIFICATION_INCONCLUSIVE');
  const ev = acct.lastRejectedCandidate;
  assert.ok(ev, 'evidence recorded');
  assert.strictEqual(ev.code, 'VERIFICATION_INCONCLUSIVE');
  assert.strictEqual(ev.reason, 'readonly_no_exchange', 'the verifier\'s own reason, not a bare "unknown"');
  assert.strictEqual(ev.deviceName, 'WIN-SRC');
  assert.strictEqual(new Date(ev.tokenExpiresAt).getTime(), (issued + 3600) * 1000);
  assert.strictEqual(new Date(ev.tokenIssuedAt).getTime(), issued * 1000);
  assert.strictEqual(ev.tokenExpiredAtReceipt, true);
  const s = JSON.stringify(ev);
  assert.doesNotMatch(s, /eyJ|rt-secret|operator@example\.com|base64-/, 'no token, refresh token, email or cookie value');
});

test('a later PROMOTION does not erase the evidence of the earlier refusal', async () => {
  const { acct, row, now } = setup();
  nextVerify = { result: 'unknown', httpStatus: 0, reason: 'readonly_no_exchange' };
  await ingestCandidate(acct, TOOL, row, bundle(now - 5400).cookies, {});
  const before = acct.lastRejectedCandidate;
  nextVerify = { result: 'working', httpStatus: 200, maskedId: 'op***@example.com' };
  const ok = await ingestCandidate(acct, TOOL, row, bundle(now - 60).cookies, {});
  assert.strictEqual(ok.code, 'PROMOTED');
  assert.strictEqual(acct.candidate.status, 'promoted');
  assert.deepStrictEqual(acct.lastRejectedCandidate, before, 'refusal evidence survives the next success');
});

test('the admin state publishes the evidence', () => {
  const src = require('fs').readFileSync(require('path').join(__dirname, '..', 'routes', 'admin', 'proxyTools.js'), 'utf8');
  assert.match(src, /lastRejectedCandidate:/);
});
