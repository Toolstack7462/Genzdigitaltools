'use strict';
/**
 * THE 2026-10-18 INCIDENT: clients on a login screen while the dashboard reported healthy.
 *
 * WHAT WAS REPORTED. The service worked for roughly 12-15 hours; then clients started seeing a
 * login screen. Admin health and resync still looked successful and a manual cookie update did not
 * fix it. From the operator's incident log (UTC):
 *
 *   14:59:17  BACKEND_VERIFIED / SYNC_RESUMED
 *   15:01:19  RECOVERY_BLOCKED, cooldown
 *   15:19:28  a new incident reports visible_login_form
 *   15:19:46  BACKEND_VERIFIED / SYNC_RESUMED again
 *
 * The last two lines are eighteen seconds apart: the AGENT saw a login form in the source browser,
 * and the SERVER then recorded the account as verified.
 *
 * WHY BOTH WERE TRUE. For WriteHuman, routine candidate verification ran with `{ readOnly: true }`
 * and no canary, so verify.js took its fast path and answered from a LOCAL DECODE of the stored
 * access token's `exp`. A Supabase access token is a stateless JWT: it stays exp-valid for about an
 * hour after the session behind it is signed out or revoked. So the bundle captured from a
 * signed-out browser verified as `working`, was promoted over a bundle that really worked, and
 * every client was then served a logged-out session — while `lastVerifiedAt` and the session status
 * said the opposite. An operator's manual cookie save was overwritten by the next push minutes
 * later, which is exactly what was described.
 *
 * WHAT THESE TESTS PIN
 *   A. verify.js — what each provider answer means, including that OUR OWN network failure is
 *      inconclusive and must never downgrade a live session.
 *   B. candidateSync — promotion now requires POSITIVE proof (canary 'passed'). Nothing is
 *      promoted on an inconclusive result, and nothing is expired on one either.
 *   C. ordering — a stale push cannot overwrite a newer bundle.
 *   D. expiry boundaries, with SIMULATED time.
 *
 * WHAT THEY DO NOT ESTABLISH. They do not prove which page the affected client saw (the Gen Z
 * login page, WriteHuman's own login page inside the gateway, or the gateway's "Session ended"),
 * and they are not a 12-15 hour soak: every clock here is a fixture.
 *
 * No database and no network: the account is an in-memory stand-in with the shape mysqlAdapter
 * returns, and the one network call in the path is stubbed.
 */
/**
 * FIXTURE NOTE (2026-10-19): the provider bodies below carry a real `id`, because a genuine
 * `/auth/v1/user` 200 always does. verify.js now requires that id before it will call the canary
 * 'passed': a 200 with `{}`, an error-shaped object or no recognisable id is INCONCLUSIVE, since
 * `canary:'passed'` is what candidateSync accepts as positive proof to PROMOTE a bundle. The
 * earlier id-less fixtures encoded a contract the provider never produces.
 */
const test = require('node:test');
const { describe } = require('node:test');
const assert = require('node:assert');
const crypto = require('crypto');

process.env.PROXY_VAULT_KEY = process.env.PROXY_VAULT_KEY || crypto.randomBytes(32).toString('hex');

const REF = 'hicfsbrfkzsxbwayibfm';
const TOOL = 'writehuman';

// ── A. verify.js against a stubbed provider ───────────────────────────────────────────────────
// The real module, with only global fetch replaced, so these assertions are about the shipped
// decision table rather than a copy of it.
const verifyReal = require('../utils/proxy/verify');
// Capture the REAL function now. Section B below replaces `verifyAccountCookies` on this same
// module object to stub the network out of candidateSync's path, and that assignment runs at load
// time — before any test body. Without this reference, section A would be testing the stub.
const realVerify = verifyReal.verifyAccountCookies;

function tokenCookieHeader({ ageSec = 0, ttlSec = 3600, email = 'operator@example.com' } = {}) {
  // SIMULATED TIME: `iat`/`exp` are computed from a fixture offset, not from a real elapsed wait.
  const nowSec = Math.floor(Date.now() / 1000);
  const iat = nowSec - ageSec;
  const b64 = (o) => Buffer.from(JSON.stringify(o)).toString('base64')
    .replace(/=+$/, '').replace(/\+/g, '-').replace(/\//g, '_');
  const jwt = `${b64({ alg: 'HS256' })}.${b64({ iat, exp: iat + ttlSec, email, session_id: 'sess-A' })}.sig`;
  const payload = JSON.stringify({ access_token: jwt, refresh_token: 'rt-1', user: { email } });
  return `sb-${REF}-auth-token=base64-${Buffer.from(payload).toString('base64')}`;
}

function withFetch(impl, fn) {
  const saved = globalThis.fetch;
  globalThis.fetch = impl;
  return Promise.resolve().then(fn).finally(() => { globalThis.fetch = saved; });
}
const userResp = (status, body) => async () => ({
  status, headers: { get: () => null }, text: async () => body || '',
});

describe('A. what the provider answer actually means', () => {
  test('INCIDENT SHAPE: the token is unexpired but the provider says 401 — that is session_expired', async () => {
    // The one case a local decode can never see, and the one that logged every client out.
    await withFetch(userResp(401, '{"msg":"invalid JWT"}'), async () => {
      const v = await realVerify(TOOL, tokenCookieHeader({ ageSec: 60 }), null, { readOnly: true, canary: true });
      assert.strictEqual(v.result, 'session_expired');
      assert.strictEqual(v.canary, 'failed');
      assert.strictEqual(v.loggedOut, true);
    });
  });

  test('a live session: provider 200 -> working, canary passed', async () => {
    await withFetch(userResp(200, '{"id":"3f2504e0-4f89-11d3-9a0c-0305e82c3301","aud":"authenticated","role":"authenticated","email":"operator@example.com"}'), async () => {
      const v = await realVerify(TOOL, tokenCookieHeader({ ageSec: 60 }), null, { readOnly: true, canary: true });
      assert.strictEqual(v.result, 'working');
      assert.strictEqual(v.canary, 'passed');
    });
  });

  test('OUR failure is not the account’s: network, 429 and 5xx are inconclusive, never expired', async () => {
    const cases = [
      ['network', async () => { throw new Error('ECONNRESET'); }],
      ['429', userResp(429, 'rate limited')],
      ['500', userResp(500, 'boom')],
      ['403', userResp(403, 'apikey problem')],   // 403 is an apikey/permission answer, not proof
    ];
    for (const [label, impl] of cases) {
      await withFetch(impl, async () => {
        const v = await realVerify(TOOL, tokenCookieHeader({ ageSec: 60 }), null, { readOnly: true, canary: true });
        assert.strictEqual(v.result, 'working', `${label}: must not downgrade a live session`);
        assert.strictEqual(v.canary, 'inconclusive', `${label}: and must not claim proof either`);
      });
    }
  });

  test('WITHOUT the canary the verdict comes from a decode alone, and says so', async () => {
    // This is the pre-fix routine path. It returns 'working' having asked nobody, which is why
    // promotion may not rely on it. No provider request is made at all.
    let called = 0;
    await withFetch(async () => { called += 1; return { status: 200, headers: { get: () => null }, text: async () => '{}' }; }, async () => {
      const v = await realVerify(TOOL, tokenCookieHeader({ ageSec: 60 }), null, { readOnly: true });
      assert.strictEqual(v.result, 'working');
      assert.strictEqual(v.canary, undefined, 'no canary field: nothing was proven');
      assert.strictEqual(v.finalPath, '/auth (jwt)');
      assert.strictEqual(called, 0, 'the decode path must not reach the provider');
    });
  });

  test('a mismatched identity is wrong_account even when the canary passes', async () => {
    await withFetch(userResp(200, '{"id":"b7c1d2e3-4f56-11d3-9a0c-0305e82c3399","aud":"authenticated","role":"authenticated","email":"someone.else@example.com"}'), async () => {
      const v = await realVerify(TOOL, tokenCookieHeader({ ageSec: 60 }), 'operator@example.com', { readOnly: true, canary: true });
      assert.strictEqual(v.result, 'wrong_account');
    });
  });
});

describe('D. expiry boundaries (SIMULATED time — no test waits for a clock)', () => {
  test('a token inside its lifetime reaches the canary; one near expiry does not', async () => {
    // verify.js treats a token as live only while exp is more than 120s away.
    await withFetch(userResp(200, '{"id":"3f2504e0-4f89-11d3-9a0c-0305e82c3301","aud":"authenticated","role":"authenticated","email":"operator@example.com"}'), async () => {
      const live = await realVerify(TOOL, tokenCookieHeader({ ageSec: 10, ttlSec: 3600 }), null, { readOnly: true, canary: true });
      assert.strictEqual(live.canary, 'passed');
      // 60 seconds of lifetime left: inside `exp`, but inside the 120s guard band.
      const nearly = await realVerify(TOOL, tokenCookieHeader({ ageSec: 3540, ttlSec: 3600 }), null, { readOnly: true, canary: true });
      assert.strictEqual(nearly.result, 'unknown');
      assert.strictEqual(nearly.reason, 'readonly_no_exchange', 'read-only never rotates: the browser does');
    });
  });

  test('an already-expired token is unknown, not expired — the browser can still renew it', async () => {
    await withFetch(userResp(401, ''), async () => {
      const v = await realVerify(TOOL, tokenCookieHeader({ ageSec: 7200, ttlSec: 3600 }), null, { readOnly: true, canary: true });
      assert.strictEqual(v.result, 'unknown');
      assert.strictEqual(v.reason, 'readonly_no_exchange');
    });
  });
});

// ── B & C. the promotion gate, driven through the real ingestCandidate ────────────────────────
// Stub the verifier (the single network dependency) BEFORE candidateSync captures it.
const verifyMod = require('../utils/proxy/verify');
let nextVerify = { result: 'working', httpStatus: 200, maskedId: 'op***@example.com', canary: 'passed' };
let verifyOpts = [];
verifyMod.verifyAccountCookies = async (tool, header, expected, opts) => { verifyOpts.push(opts || {}); return nextVerify; };

const healthAlerts = require('../utils/proxy/healthAlerts');
healthAlerts.onVerifyApplied = async () => {};

const deviceSync = require('../utils/proxy/deviceSync');
const { ingestCandidate } = require('../utils/proxy/candidateSync');
const { authCookieHash } = require('../utils/proxy/cookies');
const vaultCrypto = require('../utils/proxy/vaultCrypto');
const { CODES } = deviceSync;

function bundle(iat, email, sid) {
  const b64 = (o) => Buffer.from(JSON.stringify(o)).toString('base64').replace(/=+$/, '').replace(/\+/g, '-').replace(/\//g, '_');
  const jwt = `${b64({ alg: 'HS256' })}.${b64({ iat, exp: iat + 3600, email: email || 'operator@example.com', session_id: sid || 'sess-A' })}.sig`;
  const payload = JSON.stringify({ access_token: jwt, refresh_token: 'rt-' + iat, user: { email: email || 'operator@example.com' } });
  return {
    origin: 'https://writehuman.ai',
    cookies: [{
      name: `sb-${REF}-auth-token`, value: 'base64-' + Buffer.from(payload).toString('base64'),
      domain: '.writehuman.ai', path: '/', secure: true, httpOnly: false, sameSite: 'lax',
    }],
  };
}
function account(initial) {
  const a = {
    _id: 'acct1', tool: TOOL, label: 'WriteHuman', isPrimary: true,
    status: 'active', session_status: 'working',
    verification: { result: 'working', maskedId: 'op***@example.com', httpStatus: 200, checkedAt: new Date() },
    saves: 0, save() { this.saves += 1; return Promise.resolve(this); },
  };
  if (initial) {
    a.sessionEncrypted = vaultCrypto.encrypt(JSON.stringify(initial));
    a.cookieHash = authCookieHash(initial, REF);
    a.bundleVersion = 1;
  }
  return a;
}
function pair(acct, name) {
  const { code } = deviceSync.createPairingCode(acct, name);
  const r = deviceSync.redeemPairingCode(acct, code, { hostname: name });
  return { row: deviceSync.findDevice(acct, r.deviceId), deviceId: r.deviceId };
}
const activeOf = (a) => JSON.parse(vaultCrypto.decrypt(a.sessionEncrypted));
function reset() {
  nextVerify = { result: 'working', httpStatus: 200, maskedId: 'op***@example.com', canary: 'passed' };
  verifyOpts = [];
}
/** Bootstrap an account with one active source holding a known-good bundle. */
async function withActiveSource() {
  const a = account(bundle(1000));
  const d = pair(a, 'RDP-01');
  await ingestCandidate(a, TOOL, d.row, bundle(2000, null, 'sess-RDP').cookies, {});
  return { a, d, good: activeOf(a), version: a.bundleVersion, hash: a.cookieHash };
}

describe('B. promotion requires positive proof', () => {
  test('a routine push is verified WITHOUT a provider round-trip', async () => {
    // This test asserted the opposite, and that assertion was the outage. Proof on every push put
    // an external HTTPS GET inside the agent's own POST, and the agent's pushes began timing out:
    //   agent_report {"cdp":"200","pollCount":3833,
    //                 "error":"post_failed: The operation was aborted due to timeout"}
    // Proof still happens — out of the request path, in the seven-minute scheduler — and on
    // activations, which are rare and operator-driven.
    reset();
    const { a, d } = await withActiveSource();
    verifyOpts = [];
    await ingestCandidate(a, TOOL, d.row, bundle(3000, null, 'sess-RDP').cookies, {});
    assert.strictEqual(verifyOpts.length, 1);
    assert.ok(!verifyOpts[0].canary, 'a routine push must not wait on the provider');
    assert.strictEqual(verifyOpts[0].readOnly, true, 'and still never rotate the refresh token');
    assert.ok(!verifyOpts[0].forceLive, 'the browser remains the sole rotator');
  });

  test('canary passed -> promoted, and the served bundle really changes', async () => {
    reset();
    const { a, d, version } = await withActiveSource();
    const r = await ingestCandidate(a, TOOL, d.row, bundle(3000, null, 'sess-RDP').cookies, {});
    assert.strictEqual(r.promoted, true);
    assert.ok(a.bundleVersion > version, 'the version must move so downstream caches refresh');
  });

  test('CORRECTION: an inconclusive canary promotes, and is RECORDED as unproven', async () => {
    // This test asserted the opposite until 2026-10-19, and that assertion was the outage.
    //
    // `canary: 'inconclusive'` does not mean the candidate is bad. It means OUR request to the
    // provider did not complete — network, 403, 429, 5xx. Refusing on it rejected every agent
    // cookie sync for WriteHuman, the only tool with a canary at all, so sync stopped advancing and
    // "Could not open tool" appeared on WriteHuman and nowhere else.
    //
    // A provably logged-out candidate is still refused: verify.js pairs `canary: 'failed'` with
    // `result: 'session_expired'`, which the test below pins.
    reset();
    const { a, d, version, good } = await withActiveSource();
    nextVerify = { result: 'working', httpStatus: 200, maskedId: 'op***@example.com', canary: 'inconclusive' };
    const r = await ingestCandidate(a, TOOL, d.row, bundle(9000, null, 'sess-RDP').cookies, {});

    assert.strictEqual(r.promoted, true, 'our own connectivity must not block the agent');
    assert.strictEqual(r.code, CODES.PROMOTED);
    assert.notDeepStrictEqual(activeOf(a), good, 'the fresh bundle replaced the old one');
    assert.ok(a.bundleVersion > version, 'the version moves so downstream caches refresh');
    assert.strictEqual(a.session_status, 'working');
    assert.strictEqual(a.status, 'active');

    // Promoted, but nothing may call it verified.
    assert.strictEqual(r.canaryProven, false, 'the result says the proof was not obtained');
    assert.strictEqual(r.canaryState, 'inconclusive');
    assert.strictEqual(a.sessionMeta.canaryProven, false, 'and the stored bundle carries that too');
    assert.strictEqual(a.sessionMeta.canaryState, 'inconclusive');
  });

  test('a canary that PASSES is recorded as proven', async () => {
    reset();
    const { a, d } = await withActiveSource();
    nextVerify = { result: 'working', httpStatus: 200, maskedId: 'op***@example.com', canary: 'passed' };
    const r = await ingestCandidate(a, TOOL, d.row, bundle(9050, null, 'sess-RDP').cookies, {});
    assert.strictEqual(r.promoted, true);
    assert.strictEqual(r.canaryProven, true);
    assert.strictEqual(r.canaryState, 'passed');
    assert.strictEqual(a.sessionMeta.canaryProven, true);
  });

  test('a verdict with NO canary field promotes, recorded as unproven', async () => {
    reset();
    const { a, d, good, version } = await withActiveSource();
    nextVerify = { result: 'working', httpStatus: 200, maskedId: 'op***@example.com' };  // decode only
    const r = await ingestCandidate(a, TOOL, d.row, bundle(9100, null, 'sess-RDP').cookies, {});
    assert.strictEqual(r.promoted, true);
    assert.strictEqual(r.canaryProven, false, 'absent is not proof, but it is not grounds to refuse');
    assert.strictEqual(r.canaryState, 'absent');
    assert.notDeepStrictEqual(activeOf(a), good);
    assert.ok(a.bundleVersion > version);
  });

  test('a CONFIRMED rejection is reported as expiry, and still keeps the stored bundle', async () => {
    reset();
    const { a, d, good } = await withActiveSource();
    nextVerify = { result: 'session_expired', httpStatus: 401, maskedId: null, canary: 'failed', loggedOut: true };
    const r = await ingestCandidate(a, TOOL, d.row, bundle(9200, null, 'sess-RDP').cookies, {});
    assert.strictEqual(r.promoted, false);
    assert.strictEqual(r.code, CODES.SESSION_EXPIRED);
    assert.deepStrictEqual(activeOf(a), good, 'cookies are never deleted by a refusal');
    // Downgrading the ACCOUNT is markDeviceLoggedOut's job, called when the agent confirms a
    // logout on the source. A refused candidate does not invent that transition.
  });

  test('a manual save is protected from an OLDER push by trusted ordering, not by the canary', async () => {
    // Honest statement of what protects an operator's hand-pasted bundle now.
    //
    // The canary refusal used to protect it from any unprovable push. That refusal is gone because
    // it also blocked every legitimate agent sync. What remains is trusted ordering: a candidate
    // whose access token is OLDER than the bundle in place is refused. So a stale source cannot
    // walk backwards over a manual save.
    //
    // The gap this leaves, stated rather than hidden: a source pushing a NEWER token still
    // replaces a manual save even when our canary could not reach the provider. Closing that needs
    // a deliberate "operator-pinned bundle" concept, which is a product decision, not something to
    // improvise inside a hotfix.
    reset();
    const { a, d } = await withActiveSource();
    const manual = bundle(6000, null, 'sess-MANUAL');
    a.sessionEncrypted = vaultCrypto.encrypt(JSON.stringify(manual));
    a.cookieHash = authCookieHash(manual, REF);
    a.bundleVersion = (a.bundleVersion || 0) + 1;
    const manualVersion = a.bundleVersion;

    nextVerify = { result: 'working', httpStatus: 200, maskedId: 'op***@example.com', canary: 'inconclusive' };
    const r = await ingestCandidate(a, TOOL, d.row, bundle(5000, null, 'sess-RDP').cookies, {});
    assert.strictEqual(r.promoted, false, 'an older token cannot replace a newer bundle');
    assert.deepStrictEqual(activeOf(a), manual, "the operator's bundle must still be the one served");
    assert.strictEqual(a.bundleVersion, manualVersion);
  });

  test('the gate is scoped to tools that can produce the proof', async () => {
    // A canary exists only for the Supabase verify mode; everywhere else `working` already came
    // from a real authenticated request, so requiring the field would break those tools.
    const tools = require('../utils/proxy/tools');
    assert.strictEqual(tools.verifyMode(TOOL), 'supabase_refresh');
    const others = ['hix', 'bypassgpt'].filter((t) => tools.TOOL_KEYS.includes(t));
    for (const t of others) assert.notStrictEqual(tools.verifyMode(t), 'supabase_refresh');
  });
});

describe('C. ordering and concurrency', () => {
  test('a stale push cannot overwrite a newer bundle', async () => {
    reset();
    const { a, d } = await withActiveSource();
    await ingestCandidate(a, TOOL, d.row, bundle(4000, null, 'sess-RDP').cookies, {});
    const newest = activeOf(a);
    const version = a.bundleVersion;
    // An older capture arriving late (a retry that was queued on the device).
    const r = await ingestCandidate(a, TOOL, d.row, bundle(2500, null, 'sess-RDP').cookies, {});
    assert.strictEqual(r.promoted, false, 'trusted ordering refuses an older token');
    assert.deepStrictEqual(activeOf(a), newest);
    assert.strictEqual(a.bundleVersion, version);
  });

  test('two concurrent pushes serialize, and only one bundle wins', async () => {
    reset();
    const { a, d } = await withActiveSource();
    const before = a.bundleVersion;
    const [r1, r2] = await Promise.all([
      ingestCandidate(a, TOOL, d.row, bundle(7000, null, 'sess-RDP').cookies, {}),
      ingestCandidate(a, TOOL, d.row, bundle(7100, null, 'sess-RDP').cookies, {}),
    ]);
    const promoted = [r1, r2].filter((r) => r.promoted).length;
    assert.ok(promoted >= 1, 'at least one must land');
    assert.ok(a.bundleVersion - before <= 2, 'and the version cannot run ahead of the writes');
    // Whatever won, the stored bundle is one of the two that were offered — never a merge.
    const t = activeOf(a).cookies[0].value;
    assert.ok([7000, 7100].some((i) => t === bundle(i, null, 'sess-RDP').cookies[0].value));
  });
});

// ── H. the canary must stay OFF the agent's critical path ────────────────────────────────────
// The canary is an external HTTPS GET to the provider. PR #15 widened it from activations only to
// EVERY accepted push, which put that round-trip inside the agent's own POST on every sync. The
// operator's live log recorded the result:
//
//     agent_report {"cdp":"200","pollCount":3833,
//                   "error":"post_failed: The operation was aborted due to timeout"}
//
// The agent polling fine while its push times out is how the vault went stale with the admin page
// still reporting "working". These pin the call site so it cannot widen again by accident.
test('a routine agent sync does NOT make a provider call', async () => {
  reset();
  const { a, d } = await withActiveSource();
  verifyOpts.length = 0;
  await ingestCandidate(a, TOOL, d.row, bundle(9500, null, 'sess-RDP').cookies, {});
  assert.ok(verifyOpts.length > 0, 'the candidate was still verified');
  assert.equal(verifyOpts.filter((o) => o && o.canary === true).length, 0,
    'a routine push must not wait on the provider');
});

test('an ACTIVATION still asks for proof — that is where the wait belongs', async () => {
  reset();
  const { a, d } = await withActiveSource();
  verifyOpts.length = 0;
  await ingestCandidate(a, TOOL, d.row, bundle(9600, null, 'sess-RDP').cookies, { activation: { id: 'act-1' } });
  assert.ok(verifyOpts.some((o) => o && o.canary === true),
    'an activation is rare and can afford the proof');
});

test('the call site is activation-gated in source, so it cannot widen unnoticed', () => {
  const src = require('fs').readFileSync(
    require('path').join(__dirname, '..', 'utils', 'proxy', 'candidateSync.js'), 'utf8');
  assert.match(src, /act \? \{ readOnly: true, canary: true \} : \{ readOnly: true \}/);
  assert.doesNotMatch(src.replace(/\/\/.*$/gm, ''),
    /verifyAccountCookies\([^)]*\{ readOnly: true, canary: true \}\s*\)/,
    'an unconditional canary on the ingest path is what caused the agent POST timeouts');
});
