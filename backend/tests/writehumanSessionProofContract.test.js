'use strict';
/**
 * WHAT THE SERVER MAY CLAIM ABOUT A SESSION — the `sessionProof` contract.
 *
 * An agent holding a `submission_outcome_unknown` halt (a password was submitted and the outcome
 * could not be observed) may only clear it on proof that the account is authenticated NOW. The
 * reply it had to reason from could not support that:
 *
 *   candidateSync  routine pushes call verifyAccountCookies(..., {readOnly:true}); the canary is
 *                  requested on the ACTIVATION path only.
 *   verify         with no canary it returns {result:'working', finalPath:'/auth (jwt)'} - a LOCAL
 *                  JWT DECODE. A Supabase access token stays exp-valid for about an hour AFTER its
 *                  session is gone, so this answers "working" for a signed-out browser.
 *   agentSync      the reply forwarded promoted/bundleVersion/activeSource and NOT the canary
 *                  state, so `PROMOTED` looked like authentication and was not.
 *
 * This pins the corrected server half, which is additive and optional: `verification.canary` says
 * HOW a session was proven, `verification.subject` says WHAT the verdict is about (pinned before
 * the provider call), and `sessionProof` forwards both plus a `stale` flag. The agent consumer is
 * tested separately, against the agent source it ships with.
 *
 * Driven through the REAL Express router and the REAL candidateSync; only the provider boundary is
 * stubbed. No database, no network, no credential.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('crypto');
const http = require('http');

const LEGACY_KEY = 'a'.repeat(64);
process.env.PROXY_VAULT_KEY = process.env.PROXY_VAULT_KEY || crypto.randomBytes(32).toString('hex');
process.env.PROXY_AGENT_SYNC_KEY = LEGACY_KEY;
delete process.env.PROXY_AGENT_SYNC_ALLOW_IPS;

const modelPath = require.resolve('../models/proxy/ProxyAccount');
let ACCOUNTS = [];
require.cache[modelPath] = {
  id: modelPath, filename: modelPath, loaded: true,
  exports: { find: async () => ACCOUNTS },
};
require('../utils/proxy/healthAlerts').onVerifyApplied = async () => {};

// WHY THE INDIRECTION. utils/proxy/verifyAndApply.js DESTRUCTURES its verify import at module
// load, so reassigning the module property later does not change what it calls - it keeps the
// function it captured. One permanent stub that delegates to a swappable `verifyImpl` is what lets
// a test make the provider slow, inconclusive or logged-out after everything is wired up.
const VERIFY_CALLS = [];
let verifyImpl = async (tool, header, expected, opts) => (
  (opts && opts.canary)
    ? { result: 'working', httpStatus: 200, finalPath: '/auth/v1/user', maskedId: 'op***@example.com', canary: 'passed', accountKey: 'acct-key-1' }
    : { result: 'working', httpStatus: 200, finalPath: '/auth (jwt)', maskedId: 'op***@example.com' }
);
const DEFAULT_VERIFY = verifyImpl;
require('../utils/proxy/verify').verifyAccountCookies = async (tool, header, expected, opts) => {
  VERIFY_CALLS.push(Object.assign({}, opts || {}));
  return verifyImpl(tool, header, expected, opts);
};

const express = require('express');
const vaultCrypto = require('../utils/proxy/vaultCrypto');
const deviceSync = require('../utils/proxy/deviceSync');
const { verifyAndApply } = require('../utils/proxy/verifyAndApply');
const scheduler = require('../cron/proxyVerifyScheduler');
const router = require('../routes/proxy/agentSync');

const REF = 'hicfsbrfkzsxbwayibfm';
const PATH = '/api/crm/proxy/agent/writehuman/cookies';
const b64 = (o) => Buffer.from(JSON.stringify(o)).toString('base64').replace(/=+$/, '');
const jwt = (iat) => b64({ alg: 'HS256' }) + '.' + b64({ iat, exp: iat + 3600, session_id: 'sess-X' }) + '.sig';
function cookies(iat) {
  const payload = JSON.stringify({ access_token: jwt(iat), refresh_token: 'rt', user: { email: 'operator@example.com' } });
  return [{ name: 'sb-' + REF + '-auth-token', value: 'base64-' + Buffer.from(payload).toString('base64'), domain: '.writehuman.ai', path: '/' }];
}
function makeAccount() {
  const a = {
    _id: 'acct1', tool: 'writehuman', isPrimary: true, label: 'WriteHuman',
    status: 'active', session_status: 'working',
    verification: { result: 'working', maskedId: 'op***@example.com', httpStatus: 200 },
    save() { return Promise.resolve(this); },
  };
  a.sessionEncrypted = vaultCrypto.encrypt(JSON.stringify({ cookies: cookies(1000) }));
  return a;
}
function serve() {
  const app = express();
  app.use('/api/crm/proxy/agent', router);
  const server = http.createServer(app);
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const port = server.address().port;
      resolve({
        server,
        async post(p, body) {
          const res = await fetch(`http://127.0.0.1:${port}${p}`, {
            method: 'POST',
            headers: { 'content-type': 'application/json', 'x-agent-key': LEGACY_KEY },
            body: JSON.stringify(body || {}),
          });
          let json = null; try { json = await res.json(); } catch (_) {}
          return { status: res.status, body: json };
        },
      });
    });
  });
}

test('a ROUTINE promotion is produced from a DECODE, and the server says so', async () => {
  const acct = makeAccount(); ACCOUNTS = [acct];
  VERIFY_CALLS.length = 0;
  const { server, post } = await serve();
  try {
    const r = await post(PATH, { cookies: cookies(9000) });
    assert.equal(r.body.code, deviceSync.CODES.PROMOTED);
    assert.equal(r.body.promoted, true);
    assert.ok(!VERIFY_CALLS[0].canary, 'a routine push must not pay for a provider round-trip');
    assert.ok(r.body.sessionProof, 'the reply must carry the proof record');
    assert.equal(r.body.sessionProof.canary, null, 'a decode is not a canary');
  } finally { server.close(); }
});

test('the AUTHORITATIVE canary records proof BOUND to the bundle it checked', async () => {
  const acct = makeAccount(); ACCOUNTS = [acct];
  await verifyAndApply(acct, 'writehuman', { readOnly: true, canary: true });
  assert.equal(acct.verification.canary, 'passed');
  assert.equal(acct.verification.subject.bundleVersion, acct.bundleVersion || 0);
  assert.equal(acct.verification.subject.cookieHash, acct.cookieHash || null);
  assert.equal(acct.verification.accountKey, 'acct-key-1', 'the authoritative identity is recorded');
  assert.ok(acct.lastCanaryAt, 'and the authoritative clock is stamped');
});

test('the authoritative account identity is NOT exposed to the agent', async () => {
  const acct = makeAccount(); ACCOUNTS = [acct];
  await verifyAndApply(acct, 'writehuman', { readOnly: true, canary: true });
  const { server, post } = await serve();
  try {
    await post(PATH, { cookies: cookies(9000) });
    const hb = await post(PATH, { heartbeat: true });
    assert.ok(!('accountKey' in hb.body.sessionProof), 'accountKey stays server-side');
    assert.ok(!JSON.stringify(hb.body).includes('acct-key-1'));
    assert.ok(!JSON.stringify(hb.body).includes('operator@example.com'), 'no unmasked address either');
  } finally { server.close(); }
});

test('a verification of bundle A landing LATE cannot authenticate bundle B', async () => {
  const acct = makeAccount(); ACCOUNTS = [acct];
  await verifyAndApply(acct, 'writehuman', { readOnly: true, canary: true });
  const bundleA = acct.bundleVersion || 0;
  const hashA = acct.cookieHash || null;

  let release;
  const gate = new Promise((r) => { release = r; });
  verifyImpl = async () => {
    await gate;
    return { result: 'working', httpStatus: 200, finalPath: '/auth/v1/user', maskedId: 'op***@example.com', canary: 'passed', accountKey: 'acct-key-1' };
  };
  const late = verifyAndApply(acct, 'writehuman', { readOnly: true, canary: true });
  verifyImpl = DEFAULT_VERIFY;

  const { server, post } = await serve();
  try {
    const r = await post(PATH, { cookies: cookies(9000) });
    assert.equal(r.body.code, deviceSync.CODES.PROMOTED);
    assert.notEqual(acct.bundleVersion, bundleA, 'bundle B is now served');
    assert.notEqual(acct.cookieHash, hashA);
    assert.equal(acct.verification.canary, null, 'B starts unproven - it inherits nothing from A');

    release();
    const res = await late;
    assert.equal(res.result, 'stale_subject', 'the verdict about A is dropped, not applied to B');
    assert.equal(res.stale, true);
    assert.equal(acct.verification.canary, null, 'A did not mark B as provably authenticated');
    assert.equal(acct.verification.subject.bundleVersion, acct.bundleVersion);

    const hb = await post(PATH, { heartbeat: true });
    assert.notEqual(hb.body.sessionProof.canary, 'passed', 'and the wire never claims B is proven');
  } finally { server.close(); }
});

test('a late NEGATIVE verdict cannot downgrade the bundle that replaced its subject', async () => {
  const acct = makeAccount(); ACCOUNTS = [acct];
  let release;
  const gate = new Promise((r) => { release = r; });
  verifyImpl = async () => {
    await gate;
    return { result: 'session_expired', httpStatus: 200, finalPath: '/auth/v1/user', loggedOut: true, maskedId: null, canary: 'failed' };
  };
  const late = verifyAndApply(acct, 'writehuman', { readOnly: true, canary: true });
  verifyImpl = DEFAULT_VERIFY;

  const { server, post } = await serve();
  try {
    await post(PATH, { cookies: cookies(9000) });
    assert.equal(acct.session_status, 'working');
    release();
    assert.equal((await late).result, 'stale_subject');
    assert.equal(acct.session_status, 'working', 'the newer working bundle is untouched');
    assert.notEqual(acct.status, 'session_expired');
  } finally { server.close(); }
});

test('a stale proof is marked stale on the wire, and a subjectless record is never proof', async () => {
  const acct = makeAccount(); ACCOUNTS = [acct];
  const { server, post } = await serve();
  try {
    await post(PATH, { cookies: cookies(9000) });
    await verifyAndApply(acct, 'writehuman', { readOnly: true, canary: true });
    let hb = await post(PATH, { heartbeat: true });
    assert.equal(hb.body.sessionProof.stale, false, 'proof of the served bundle is not stale');
    assert.equal(hb.body.sessionProof.subjectBundleVersion, hb.body.sessionProof.bundleVersion);

    // Hand-edit the stored record the way pre-correction data looks: a verdict with no subject.
    acct.verification = { result: 'working', canary: 'passed', checkedAt: new Date(), maskedId: 'op***@example.com' };
    hb = await post(PATH, { heartbeat: true });
    assert.equal(hb.body.sessionProof.stale, true, 'a record with no subject is stale, never proof');
    assert.equal(hb.body.sessionProof.subjectBundleVersion, null);
  } finally { server.close(); }
});

test('repeated routine promotions cannot starve the authoritative check', async () => {
  const acct = makeAccount(); ACCOUNTS = [acct];
  await scheduler.verifyOne('writehuman');
  assert.equal(acct.verification.canary, 'passed');
  const proofClock = acct.lastCanaryAt;

  const { server, post } = await serve();
  try {
    for (let i = 0; i < 3; i++) {
      const r = await post(PATH, { cookies: cookies(9000 + i * 500) });
      assert.equal(r.body.code, deviceSync.CODES.PROMOTED, 'ordinary sync still works, push ' + i);
      assert.equal(acct.verification.canary, null, 'each new bundle starts unproven');
    }
    assert.equal(String(acct.lastCanaryAt), String(proofClock),
      'a decode-backed promotion must NEVER advance the authoritative proof clock');
    assert.ok(new Date(acct.lastVerifiedAt).getTime() >= new Date(proofClock).getTime(),
      'while lastVerifiedAt IS refreshed - the starvation condition, now harmless');

    // The starvation condition itself, deterministically: real proof older than the window while
    // ordinary sync keeps lastVerifiedAt fresh. The old gate read only lastVerifiedAt and skipped.
    const aged = new Date(Date.now() - 11 * 60_000);
    acct.lastCanaryAt = aged;
    acct.lastVerifiedAt = new Date();
    let before = VERIFY_CALLS.length;
    await scheduler.verifyOne('writehuman');
    assert.ok(VERIFY_CALLS.length > before, 'the authoritative check must not be skipped');
    assert.equal(VERIFY_CALLS[VERIFY_CALLS.length - 1].canary, true, 'and it must be the real canary');
    assert.equal(acct.verification.canary, 'passed');
    assert.equal(acct.verification.subject.bundleVersion, acct.bundleVersion);

    // Bounded: genuinely fresh proof is not re-verified, so there is no busy polling.
    before = VERIFY_CALLS.length;
    await scheduler.verifyOne('writehuman');
    assert.equal(VERIFY_CALLS.length, before, 'fresh proof is not re-verified');

    // But a new bundle never inherits it.
    await post(PATH, { cookies: cookies(12345) });
    assert.equal(acct.verification.canary, null);
    before = VERIFY_CALLS.length;
    await scheduler.verifyOne('writehuman');
    assert.ok(VERIFY_CALLS.length > before, 'a moved subject forces a fresh authoritative check');
  } finally { server.close(); }
});

test('an inconclusive canary neither proves, expires, nor fakes freshness', async () => {
  const acct = makeAccount(); ACCOUNTS = [acct];
  const { server, post } = await serve();
  try {
    await post(PATH, { cookies: cookies(9000) });
    verifyImpl = async () => ({
      result: 'working', httpStatus: 200, finalPath: '/auth (jwt)', maskedId: 'op***@example.com', canary: 'inconclusive',
    });
    await scheduler.verifyOne('writehuman');
    assert.equal(acct.verification.canary, 'inconclusive');
    assert.ok(!acct.lastCanaryAt, 'an inconclusive check does not stamp the proof clock');
    assert.equal(acct.session_status, 'working', 'nor does our own network trouble expire the bundle');
    const hb = await post(PATH, { heartbeat: true });
    assert.equal(hb.body.sessionProof.canary, 'inconclusive', 'reported honestly, not as proof');
  } finally { verifyImpl = DEFAULT_VERIFY; server.close(); }
});

test('a HEARTBEAT carries proof the scheduler already produced, without verifying anything', async () => {
  const acct = makeAccount(); ACCOUNTS = [acct];
  const { server, post } = await serve();
  try {
    // A promotion is the one reply that cannot carry proof: the new bundle starts unproven.
    const push = await post(PATH, { cookies: cookies(9000) });
    assert.equal(push.body.sessionProof.canary, null);

    // The scheduler proves that bundle, out of the request path.
    await scheduler.verifyOne('writehuman');
    assert.equal(acct.verification.canary, 'passed');

    // The heartbeat delivers it - and makes NO provider request of its own.
    const before = VERIFY_CALLS.length;
    const hb = await post(PATH, { heartbeat: true, report: { authCookies: 2 } });
    assert.equal(VERIFY_CALLS.length, before, 'the heartbeat path must not call the provider');
    assert.equal(hb.body.code, 'HEARTBEAT');
    assert.equal(hb.body.sessionProof.canary, 'passed');
    assert.equal(hb.body.sessionProof.stale, false);
    assert.equal(hb.body.sessionProof.subjectBundleVersion, hb.body.sessionProof.bundleVersion);
  } finally { server.close(); }
});

test('OLD AGENT + NEW BACKEND: the reply stays a strict superset', async () => {
  const acct = makeAccount(); ACCOUNTS = [acct];
  const { server, post } = await serve();
  try {
    const push = await post(PATH, { cookies: cookies(9000) });
    for (const k of ['ok', 'code', 'changed', 'promoted', 'standby', 'bundleVersion', 'activeSource',
      'command', 'rotateTokenIn', 'isActiveSource', 'deviceState', 'standDown']) {
      assert.ok(k in push.body, 'the push reply must still carry ' + k + ' for an older agent');
    }
    assert.equal(push.body.code, deviceSync.CODES.PROMOTED);
    assert.equal(push.body.promoted, true);
    assert.equal(push.body.changed, true);

    const hb = await post(PATH, { heartbeat: true });
    for (const k of ['ok', 'code', 'heartbeat', 'changed', 'activeSource', 'isActiveSource']) {
      assert.ok(k in hb.body, 'the heartbeat must still carry ' + k);
    }
    assert.equal(hb.body.code, 'HEARTBEAT');
    assert.equal(hb.body.heartbeat, true);
    assert.equal(hb.body.changed, false);
    // An agent that has never heard of sessionProof simply ignores one extra object.
    assert.equal(typeof hb.body.sessionProof, 'object');
  } finally { server.close(); }
});
