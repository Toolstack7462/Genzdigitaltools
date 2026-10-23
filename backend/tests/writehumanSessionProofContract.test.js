'use strict';
/**
 * WHAT THE SERVER MAY CLAIM ABOUT A SESSION — the `sessionProof` contract and its subject guard.
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
 * WHAT IS REAL HERE AND WHAT IS NOT — stated plainly, because an earlier version of this file was
 * described as "only the provider was stubbed" and that was wrong:
 *
 *   REAL      the Express router (routes/proxy/agentSync), candidateSync, verifyAndApply, the
 *             verification scheduler, and the agentSync reply serialization.
 *   MOCKED    STORAGE. tests/helpers/fakeProxyAccountStore models rows, independent snapshots per
 *             read, whole-document save() and patchGuarded's guard semantics. It is not SQL, so a
 *             pass here is NOT evidence that MySQL/MariaDB accepts the adapter's statements.
 *             That is scripts/verifyguard-db-selftest.js on a restricted scratch database
 *             (workflow verifyguard-db-selftest.yml), which is the authority for the guard.
 *   STUBBED   the provider HTTP call, which must never reach WriteHuman from a test.
 *
 * No database, no network, no credential.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('crypto');
const http = require('http');
const { createStore } = require('./helpers/fakeProxyAccountStore');

const LEGACY_KEY = 'a'.repeat(64);
process.env.PROXY_VAULT_KEY = process.env.PROXY_VAULT_KEY || crypto.randomBytes(32).toString('hex');
process.env.PROXY_AGENT_SYNC_KEY = LEGACY_KEY;
delete process.env.PROXY_AGENT_SYNC_ALLOW_IPS;

const store = createStore();
const modelPath = require.resolve('../models/proxy/ProxyAccount');
require.cache[modelPath] = {
  id: modelPath, filename: modelPath, loaded: true, exports: store.asModelExports(),
};
require('../utils/proxy/healthAlerts').onVerifyApplied = async () => {};

// WHY THE INDIRECTION. utils/proxy/verifyAndApply.js DESTRUCTURES its verify import at module
// load, so reassigning the module property later does not change what it calls - it keeps the
// function it captured. One permanent stub delegating to a swappable `verifyImpl` is what lets a
// test make the provider slow, inconclusive or logged-out after everything is wired up.
const VERIFY_CALLS = [];
const CANARY_OK = { result: 'working', httpStatus: 200, finalPath: '/auth/v1/user', maskedId: 'op***@example.com', canary: 'passed', accountKey: 'acct-key-1' };
const DECODE_OK = { result: 'working', httpStatus: 200, finalPath: '/auth (jwt)', maskedId: 'op***@example.com' };
let verifyImpl = async (tool, header, expected, opts) => ((opts && opts.canary) ? CANARY_OK : DECODE_OK);
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

const ID = 'acct1';
const REF = 'hicfsbrfkzsxbwayibfm';
const PATH = '/api/crm/proxy/agent/writehuman/cookies';
const b64 = (o) => Buffer.from(JSON.stringify(o)).toString('base64').replace(/=+$/, '');
const jwt = (iat) => b64({ alg: 'HS256' }) + '.' + b64({ iat, exp: iat + 3600, session_id: 'sess-X' }) + '.sig';
function cookies(iat) {
  const payload = JSON.stringify({ access_token: jwt(iat), refresh_token: 'rt', user: { email: 'operator@example.com' } });
  return [{ name: 'sb-' + REF + '-auth-token', value: 'base64-' + Buffer.from(payload).toString('base64'), domain: '.writehuman.ai', path: '/' }];
}
/** Put the starting row in the store and hand back an independent snapshot. */
function seed(over) {
  store.clear();
  return store.seed(Object.assign({
    _id: ID, tool: 'writehuman', isPrimary: true, label: 'WriteHuman',
    status: 'active', session_status: 'working',
    sessionEncrypted: vaultCrypto.encrypt(JSON.stringify({ cookies: cookies(1000) })),
    verification: { result: 'working', maskedId: 'op***@example.com', httpStatus: 200 },
  }, over || {}));
}
const stored = () => store.stored(ID);

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

// ───────────────────────────── the proof contract ─────────────────────────────

test('a ROUTINE promotion is produced from a DECODE, and the server says so', async () => {
  seed(); VERIFY_CALLS.length = 0;
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
  seed({ cookieHash: 'hashA', bundleVersion: 7, activeSource: { deviceId: 'dev-A' } });
  const res = await verifyAndApply(store.load(ID), 'writehuman', { readOnly: true, canary: true });
  assert.equal(res.result, 'working');
  const row = stored();
  assert.equal(row.verification.canary, 'passed');
  assert.equal(row.verification.subject.bundleVersion, 7);
  assert.equal(row.verification.subject.cookieHash, 'hashA');
  assert.equal(row.verification.subject.sourceDeviceId, 'dev-A');
  assert.equal(row.verification.accountKey, 'acct-key-1', 'the authoritative identity is recorded');
  assert.ok(row.lastCanaryAt, 'and the authoritative clock is stamped');
});

test('the authoritative account identity is NOT exposed to the agent', async () => {
  seed();
  const { server, post } = await serve();
  try {
    await post(PATH, { cookies: cookies(9000) });
    await verifyAndApply(store.load(ID), 'writehuman', { readOnly: true, canary: true });
    const hb = await post(PATH, { heartbeat: true });
    assert.ok(!('accountKey' in hb.body.sessionProof), 'accountKey stays server-side');
    assert.ok(!JSON.stringify(hb.body).includes('acct-key-1'));
    assert.ok(!JSON.stringify(hb.body).includes('operator@example.com'), 'no unmasked address either');
  } finally { server.close(); }
});

// ─────────────── the independent-snapshot race (mocked storage; SQL is the selftest) ───────────────

test('NEGATIVE CONTROL: an unguarded whole-document save really does clobber a newer bundle', async () => {
  // Without this, every assertion below could pass on a harness that is not reproducing the race.
  seed({ cookieHash: 'hashA', bundleVersion: 7, activeSource: { deviceId: 'dev-A' } });
  const stale = store.load(ID);                       // worker 1's snapshot
  const other = store.load(ID);                       // worker 2's own snapshot
  other.cookieHash = 'hashB'; other.bundleVersion = 8;
  other.activeSource = { deviceId: 'dev-B' };
  await other.save();                                 // worker 2 commits B
  stale.verification = { result: 'working', canary: 'passed' };
  await stale.save();                                 // worker 1 saves its stale snapshot
  const row = stored();
  assert.equal(row.bundleVersion, 7, 'the newer bundle version is LOST');
  assert.equal(row.cookieHash, 'hashA', 'the newer hash is LOST');
  assert.equal(row.activeSource.deviceId, 'dev-A', 'the newer source is LOST');
});

test('a verification of bundle A landing LATE cannot authenticate bundle B', async () => {
  seed({ cookieHash: 'hashA', bundleVersion: 7, activeSource: { deviceId: 'dev-A' } });
  const verifier = store.load(ID);                    // loads A
  let release;
  const gate = new Promise((r) => { release = r; });
  verifyImpl = async () => { await gate; return CANARY_OK; };
  const inflight = verifyAndApply(verifier, 'writehuman', { readOnly: true, canary: true });
  verifyImpl = DEFAULT_VERIFY;

  const other = store.load(ID);                       // a genuinely separate snapshot
  other.cookieHash = 'hashB'; other.bundleVersion = 8;
  other.activeSource = { deviceId: 'dev-B' };
  other.sessionEncrypted = vaultCrypto.encrypt(JSON.stringify({ cookies: cookies(9000) }));
  await other.save();
  const bBytes = stored().sessionEncrypted;

  release();
  const res = await inflight;
  const row = stored();
  assert.equal(res.result, 'stale_subject', 'the verdict about A is reported as a stale observation');
  assert.equal(res.stale, true);
  assert.equal(row.sessionEncrypted, bBytes, 'B bundle bytes intact');
  assert.equal(row.cookieHash, 'hashB', 'B hash intact');
  assert.equal(row.bundleVersion, 8, 'B version intact');
  assert.equal(row.activeSource.deviceId, 'dev-B', 'B source intact');
  assert.ok(!row.verification || row.verification.canary !== 'passed', 'no canary invented for B');
  assert.equal(row.status, 'active');
  assert.equal(row.session_status, 'working');
});

test('a late NEGATIVE verdict cannot expire or roll back the bundle that replaced its subject', async () => {
  seed({ cookieHash: 'hashA', bundleVersion: 7, activeSource: { deviceId: 'dev-A' } });
  const verifier = store.load(ID);
  let release;
  const gate = new Promise((r) => { release = r; });
  verifyImpl = async () => {
    await gate;
    return { result: 'session_expired', httpStatus: 200, finalPath: '/auth/v1/user', loggedOut: true, maskedId: null, canary: 'failed' };
  };
  const inflight = verifyAndApply(verifier, 'writehuman', { readOnly: true, canary: true });
  verifyImpl = DEFAULT_VERIFY;

  const other = store.load(ID);
  other.cookieHash = 'hashB'; other.bundleVersion = 8;
  other.activeSource = { deviceId: 'dev-B' };
  await other.save();

  release();
  const res = await inflight;
  const row = stored();
  assert.equal(res.result, 'stale_subject');
  assert.equal(row.session_status, 'working', 'the newer session is NOT expired');
  assert.equal(row.status, 'active');
  assert.notEqual(row.session_status, 'needs_login', 'no needs_login was invented');
  assert.equal(row.cookieHash, 'hashB', 'the newer bundle is NOT rolled back');
  assert.equal(row.bundleVersion, 8);
});

test('a SOURCE handover that keeps the IDENTICAL bundle bytes still refuses the verdict', async () => {
  // The case a version/hash guard alone would miss entirely: same bytes, same hash, same version,
  // but the session now belongs to a different machine.
  seed({ cookieHash: 'hashA', bundleVersion: 7, activeSource: { deviceId: 'dev-A' } });
  const verifier = store.load(ID);
  let release;
  const gate = new Promise((r) => { release = r; });
  verifyImpl = async () => { await gate; return CANARY_OK; };
  const inflight = verifyAndApply(verifier, 'writehuman', { readOnly: true, canary: true });
  verifyImpl = DEFAULT_VERIFY;

  const other = store.load(ID);
  other.activeSource = { deviceId: 'dev-B' };          // ONLY the source changes
  await other.save();
  const bytesBefore = stored().sessionEncrypted;

  release();
  const res = await inflight;
  const row = stored();
  assert.equal(res.result, 'stale_subject');
  assert.equal(row.activeSource.deviceId, 'dev-B', 'the new source is preserved');
  assert.equal(row.sessionEncrypted, bytesBefore, 'the identical bytes are untouched');
  assert.ok(!row.verification || row.verification.canary !== 'passed',
    'no proof is attributed to the new source');
});

test('a REFUSED verdict leaves nothing behind in memory for a later caller-owned save', async () => {
  // proxyTools' Claude planDetected path calls account.save() AFTER verifyAndApply. A rejected
  // verdict still sitting on the document would be persisted by that unguarded whole-doc save.
  seed({ cookieHash: 'hashA', bundleVersion: 7, activeSource: { deviceId: 'dev-A' } });
  const verifier = store.load(ID);
  let release;
  const gate = new Promise((r) => { release = r; });
  verifyImpl = async () => {
    await gate;
    return { result: 'session_expired', httpStatus: 200, finalPath: '/auth/v1/user', loggedOut: true, maskedId: null, canary: 'failed' };
  };
  const inflight = verifyAndApply(verifier, 'writehuman', { readOnly: true, canary: true });
  verifyImpl = DEFAULT_VERIFY;
  const other = store.load(ID);
  other.cookieHash = 'hashB'; other.bundleVersion = 8; other.activeSource = { deviceId: 'dev-B' };
  await other.save();
  release();
  await inflight;

  assert.equal(verifier.session_status, 'working', 'the in-memory doc shows no rejected verdict');
  assert.ok(!verifier.verification || verifier.verification.canary !== 'failed');
  await verifier.save();                               // the caller-owned save
  const row = stored();
  assert.notEqual(row.session_status, 'needs_login',
    'a later unguarded save cannot persist the refused verdict');
  assert.ok(!row.verification || row.verification.canary !== 'failed');
});

test('no production caller passes skipSave (it would own the race itself)', () => {
  // skipSave hands the concurrency problem to the caller, and nothing in the tree takes it. This is
  // a dependency invariant, not a behaviour: if a caller ever starts using it, it must guard on the
  // returned `subject` instead of calling save().
  const fs = require('fs'); const path = require('path');
  const roots = ['routes', 'utils', 'cron', 'modules', 'services'];
  const hits = [];
  const walk = (dir) => {
    let entries = []; try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch (_) { return; }
    for (const e of entries) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) { if (e.name !== 'node_modules') walk(p); continue; }
      if (!e.name.endsWith('.js')) continue;
      const src = fs.readFileSync(p, 'utf8');
      if (!/verifyAndApply\s*\(/.test(src)) continue;
      if (/skipSave\s*:\s*true/.test(src)) hits.push(p);
    }
  };
  for (const r of roots) walk(path.join(__dirname, '..', r));
  assert.deepEqual(hits, [], 'a caller now passes skipSave — it must guard on the returned subject');
});

// ───────────────────────────── freshness and starvation ─────────────────────────────

test('a stale proof is marked stale on the wire, and a subjectless record is never proof', async () => {
  seed();
  const { server, post } = await serve();
  try {
    await post(PATH, { cookies: cookies(9000) });
    await verifyAndApply(store.load(ID), 'writehuman', { readOnly: true, canary: true });
    let hb = await post(PATH, { heartbeat: true });
    assert.equal(hb.body.sessionProof.stale, false, 'proof of the served bundle is not stale');
    assert.equal(hb.body.sessionProof.subjectBundleVersion, hb.body.sessionProof.bundleVersion);

    // Pre-correction data: a verdict with no subject at all.
    const row = stored();
    row.verification = { result: 'working', canary: 'passed', checkedAt: new Date().toISOString(), maskedId: 'op***@example.com' };
    hb = await post(PATH, { heartbeat: true });
    assert.equal(hb.body.sessionProof.stale, true, 'a record with no subject is stale, never proof');
    assert.equal(hb.body.sessionProof.subjectBundleVersion, null);
  } finally { server.close(); }
});

test('repeated routine promotions cannot starve the authoritative check', async () => {
  seed();
  await scheduler.verifyOne('writehuman');
  assert.equal(stored().verification.canary, 'passed', 'the scheduler produces real proof');
  const proofClock = stored().lastCanaryAt;
  assert.ok(proofClock);

  const { server, post } = await serve();
  try {
    for (let i = 0; i < 3; i++) {
      const r = await post(PATH, { cookies: cookies(9000 + i * 500) });
      assert.equal(r.body.code, deviceSync.CODES.PROMOTED, 'ordinary sync still works, push ' + i);
      assert.equal(stored().verification.canary, null, 'each new bundle starts unproven');
    }
    assert.equal(String(stored().lastCanaryAt), String(proofClock),
      'a decode-backed promotion must NEVER advance the authoritative proof clock');
    assert.ok(new Date(stored().lastVerifiedAt).getTime() >= new Date(proofClock).getTime(),
      'while lastVerifiedAt IS refreshed - the starvation condition, now harmless');

    // The starvation condition itself, deterministically: real proof older than the window while
    // ordinary sync keeps lastVerifiedAt fresh. The old gate read only lastVerifiedAt and skipped.
    const aged = new Date(Date.now() - 11 * 60_000).toISOString();
    stored().lastCanaryAt = aged;
    stored().lastVerifiedAt = new Date().toISOString();
    let before = VERIFY_CALLS.length;
    await scheduler.verifyOne('writehuman');
    assert.ok(VERIFY_CALLS.length > before, 'the authoritative check must not be skipped');
    assert.equal(VERIFY_CALLS[VERIFY_CALLS.length - 1].canary, true, 'and it must be the real canary');
    assert.equal(stored().verification.canary, 'passed');
    assert.equal(stored().verification.subject.bundleVersion, stored().bundleVersion);

    // Bounded: genuinely fresh proof is not re-verified, so there is no busy polling.
    before = VERIFY_CALLS.length;
    await scheduler.verifyOne('writehuman');
    assert.equal(VERIFY_CALLS.length, before, 'fresh proof is not re-verified');

    // But a new bundle never inherits it.
    await post(PATH, { cookies: cookies(12345) });
    assert.equal(stored().verification.canary, null);
    before = VERIFY_CALLS.length;
    await scheduler.verifyOne('writehuman');
    assert.ok(VERIFY_CALLS.length > before, 'a moved subject forces a fresh authoritative check');
  } finally { server.close(); }
});

test('an inconclusive canary neither proves, expires, nor fakes freshness', async () => {
  seed();
  const { server, post } = await serve();
  try {
    await post(PATH, { cookies: cookies(9000) });
    verifyImpl = async () => ({ result: 'working', httpStatus: 200, finalPath: '/auth (jwt)', maskedId: 'op***@example.com', canary: 'inconclusive' });
    await scheduler.verifyOne('writehuman');
    assert.equal(stored().verification.canary, 'inconclusive');
    assert.ok(!stored().lastCanaryAt, 'an inconclusive check does not stamp the proof clock');
    assert.equal(stored().session_status, 'working', 'nor does our own network trouble expire the bundle');
    const hb = await post(PATH, { heartbeat: true });
    assert.equal(hb.body.sessionProof.canary, 'inconclusive', 'reported honestly, not as proof');
  } finally { verifyImpl = DEFAULT_VERIFY; server.close(); }
});

test('a HEARTBEAT carries proof the scheduler already produced, without verifying anything', async () => {
  seed();
  const { server, post } = await serve();
  try {
    // A promotion is the one reply that cannot carry proof: the new bundle starts unproven.
    const push = await post(PATH, { cookies: cookies(9000) });
    assert.equal(push.body.sessionProof.canary, null);

    await scheduler.verifyOne('writehuman');
    assert.equal(stored().verification.canary, 'passed');

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
  seed();
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
    assert.equal(typeof hb.body.sessionProof, 'object');
  } finally { server.close(); }
});

test('the production ProxyAccount model exposes patchGuarded (the guard cannot silently vanish)', () => {
  // verifyAndApply falls back to an unguarded save() for a document with no model behind it, which
  // is how a dozen older suites with plain-object fixtures keep working. That fallback is only safe
  // while the REAL model genuinely has the primitive - otherwise production would quietly take the
  // unguarded path. This loads the actual model module (not the require.cache double this file
  // installs for ProxyAccount) and checks the primitive is there.
  const path = require('path');
  delete require.cache[require.resolve('../db/mysqlAdapter')];
  const adapter = require('../db/mysqlAdapter');
  const RealModel = adapter.createModel('ProxyAccount', {});
  assert.equal(typeof RealModel.patchGuarded, 'function',
    'the adapter no longer exposes patchGuarded - verifyAndApply would fall back to an unguarded save');
  assert.equal(typeof RealModel.replaceGuarded, 'function', 'the other guarded primitive is also expected');
});
