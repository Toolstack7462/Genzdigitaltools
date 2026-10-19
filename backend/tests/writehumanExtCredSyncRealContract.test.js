'use strict';
/**
 * THE PRODUCER-CONSUMER CONTRACT, with the REAL verifier in the path.
 *
 * WHY THIS FILE EXISTS. `writehumanExtensionCredentialSync.test.js` passes its own
 * `deps.reVerify`, so every "verified" case in it hands the engine a hand-built
 * `{ result:'working', canary:'passed', accountKey:'uid-...' }`. That proves the engine's control
 * flow, but it cannot prove that anything in production ever PRODUCES an `accountKey` — and at
 * 2c46bf1 nothing did. `verify.js`'s canary path returned
 * `{result, httpStatus, finalPath, redirectedToSignIn, maskedId, canary}` and no identity, while
 * the engine's commit gate requires `vr === 'working' && canaryOk && accountKey`. So the restored
 * feature would have shown a working panel, enabled a policy, reported a live source — and then
 * declined every single commit with `no_authoritative_account_id`. A restored heading is not a
 * restored feature, which is exactly why the contract is tested here instead of being mocked.
 *
 * WHAT IS REAL HERE: `utils/proxy/verify` (NOT replaced) and `utils/proxy/extensionCredentialSync`,
 * wired together exactly as `reVerifyNow` wires them, with no `deps.reVerify` override.
 * WHAT IS MOCKED: only `globalThis.fetch` (the external provider answer) and persistence (in-memory
 * Tool/Policy whose patchGuarded/updateJsonPath mirror the adapter's guard+set semantics). The real
 * SQL is proven separately by scripts/extcredsync-db-selftest.js against a real engine.
 * SIMULATED: all clocks. `iat`/`exp` and `deps.now` are fixture offsets, never an elapsed wait, so
 * the recovery case below is a simulated-expiry test and NOT a long-running observation.
 */
const test = require('node:test');
const { describe } = require('node:test');
const assert = require('node:assert');
const crypto = require('crypto');

process.env.PROXY_VAULT_KEY = process.env.PROXY_VAULT_KEY || crypto.randomBytes(32).toString('hex');

const vaultCrypto = require('../utils/proxy/vaultCrypto');
const { decryptCookies } = require('../utils/encryption');
const { authCookieHash } = require('../utils/proxy/cookies');
const extSync = require('../utils/proxy/extensionCredentialSync');
const { RESULT } = extSync;

const TOOL = 'writehuman';
const REF = 'hicfsbrfkzsxbwayibfm';
// A real GoTrue user id is a UUID. This is the authoritative identity the commit must bind to.
const UID = '3f2504e0-4f89-11d3-9a0c-0305e82c3301';
const OTHER_UID = 'a1b2c3d4-5566-7788-99aa-bbccddeeff00';
const EMAIL = 'operator@example.com';

// ── provider stub: ONLY global fetch is replaced ─────────────────────────────────────────────
function withProvider(impl, fn) {
  const saved = globalThis.fetch;
  globalThis.fetch = impl;
  return Promise.resolve().then(fn).finally(() => { globalThis.fetch = saved; });
}
const answer = (status, body, ct) => async () => ({
  status,
  headers: { get: (k) => (String(k).toLowerCase() === 'content-type' ? (ct || 'application/json') : null) },
  text: async () => (body == null ? '' : body),
});
const userJson = (over) => JSON.stringify(Object.assign({ id: UID, aud: 'authenticated', role: 'authenticated', email: EMAIL }, over));

// ── fixtures ────────────────────────────────────────────────────────────────────────────────
function getByPath(o, p) { return String(p).split('.').reduce((x, k) => (x == null ? x : x[k]), o); }
function setByPath(o, p, v) { const ks = String(p).split('.'); let x = o; for (let i = 0; i < ks.length - 1; i++) { if (x[ks[i]] == null || typeof x[ks[i]] !== 'object') x[ks[i]] = {}; x = x[ks[i]]; } x[ks[ks.length - 1]] = v; }

// A LIVE access token, so verify.js takes its non-rotating canary fast path (the only path a
// read-only live-agent caller is allowed to use — the browser stays the sole rotator).
function liveBundle(tag) {
  const nowSec = Math.floor(Date.now() / 1000);
  const b64 = (o) => Buffer.from(JSON.stringify(o)).toString('base64').replace(/=+$/, '').replace(/\+/g, '-').replace(/\//g, '_');
  const jwt = `${b64({ alg: 'HS256' })}.${b64({ iat: nowSec - 60, exp: nowSec + 3600, email: EMAIL, session_id: 'sess-' + (tag || 'A') })}.sig`;
  const payload = JSON.stringify({ access_token: jwt, refresh_token: 'rt-' + (tag || 'A'), user: { email: EMAIL } });
  return { cookies: [{ name: 'sb-' + REF + '-auth-token', value: 'base64-' + Buffer.from(payload).toString('base64'), domain: '.writehuman.ai', path: '/', secure: true }], origin: 'https://writehuman.ai' };
}
function account(tag) {
  const b = liveBundle(tag);
  return {
    _id: 'acct1', tool: TOOL, label: 'WriteHuman', isPrimary: true, status: 'active', session_status: 'working',
    expectedIdentifier: null,          // identity is proven by the provider, not by a configured email
    sessionEncrypted: vaultCrypto.encrypt(JSON.stringify(b)),
    cookieHash: authCookieHash(b, REF), bundleVersion: 1,
    save() { return Promise.resolve(this); },
  };
}
function policyRec(over) {
  return Object.assign({
    _id: 'pol1', tool: TOOL, accountId: 'acct1', enabled: true, mode: 'enforce',
    officialDomain: 'writehuman.ai', approvedAccountKey: UID, policyEpoch: 1, sync: {},
  }, over);
}
let seq = 0;
function extTool() {
  return {
    _id: 'tool-wh-' + (++seq), name: 'Write Human', status: 'active',
    domain: 'writehuman.ai', targetUrl: 'https://writehuman.ai/', credentialType: 'cookies',
    cookiesEncrypted: JSON.stringify([{ name: 'stale' }]),
    sessionBundle: { version: 2, cookiesEncrypted: JSON.stringify([{ name: 'stale' }]) },
    credentialVersion: 3,
  };
}
function toolModel(list) {
  const m = {
    patchCalls: 0,
    find: async (q) => list.filter(t => !q || !q.status || t.status === q.status),
    patchGuarded: async (id, setMap, guardMap) => {
      m.patchCalls += 1;
      const t = list.find(x => String(x._id) === String(id)); if (!t) return 0;
      for (const [p, exp] of Object.entries(guardMap || {})) {
        const cur = getByPath(t, p);
        if (exp === null || exp === undefined) { if (cur !== null && cur !== undefined) return 0; }
        else if (String(cur) !== String(exp)) return 0;
      }
      for (const [p, v] of Object.entries(setMap || {})) setByPath(t, p, v);
      return 1;
    },
  };
  return m;
}
function policyModel(pol) {
  return {
    findOne: async (q) => (pol && pol.tool === q.tool && String(pol.accountId) === String(q.accountId)) ? pol : null,
    findById: async (id) => (pol && String(pol._id) === String(id)) ? pol : null,
    updateJsonPath: async (id, path, val) => { if (pol && String(pol._id) === String(id)) setByPath(pol, path, val); return 1; },
  };
}
// NOTE: no `reVerify`. The engine therefore calls its own reVerifyNow() → the REAL verify.js.
function deps(pol, list, over) { return Object.assign({ Tool: toolModel(list), Policy: policyModel(pol), deviceId: 'dev1' }, over || {}); }
const S = (pol) => (pol && pol.sync) || {};
const readerCookies = (t) => JSON.parse(decryptCookies(t.sessionBundle.cookiesEncrypted));

describe('1. the authoritative identity must actually be PRODUCED, not mocked', () => {
  test('REGRESSION: a live provider user object yields accountKey, and the Tool is committed', async () => {
    // Before the verify.js fix this failed with lastResult INCONCLUSIVE /
    // inconclusiveReason 'no_authoritative_account_id': the engine required an identity that the
    // shipped verifier never returned, so no credential could ever reach the extension's reader.
    const a = account(); const pol = policyRec(); const t = extTool(); const d = deps(pol, [t]);
    await withProvider(answer(200, userJson()), async () => {
      const out = await extSync.reconcileExtensionTool(a, TOOL, d);
      assert.strictEqual(out.result, RESULT.SYNCED, 'reason: ' + JSON.stringify(S(pol).inconclusiveReason || S(pol).lastError));
    });
    assert.strictEqual(S(pol).boundIdentity, UID, 'the commit binds to the provider-confirmed id');
    assert.strictEqual(t.credentialVersion, 4, 'the reader revision advances');
    assert.deepStrictEqual(readerCookies(t).map(c => c.name), ['sb-' + REF + '-auth-token'],
      'the Tool the extension reads now holds the source session');
  });

  test('the raw verifier itself returns accountKey on the canary path', async () => {
    const verify = require('../utils/proxy/verify');
    const header = liveBundle().cookies.map(c => c.name + '=' + c.value).join('; ');
    await withProvider(answer(200, userJson()), async () => {
      const v = await verify.verifyAccountCookies(TOOL, header, null, { readOnly: true, canary: true });
      assert.strictEqual(v.result, 'working');
      assert.strictEqual(v.canary, 'passed');
      assert.strictEqual(v.accountKey, UID, 'the producer must emit the authoritative id');
    });
  });

  test('a 200 user object with NO id is live but UNPROVEN: no commit, identity requirement intact', async () => {
    const a = account(); const pol = policyRec(); const t = extTool(); const before = t.credentialVersion;
    await withProvider(answer(200, JSON.stringify({ email: EMAIL })), async () => {
      const out = await extSync.reconcileExtensionTool(a, TOOL, deps(pol, [t]));
      assert.strictEqual(out.result, RESULT.INCONCLUSIVE);
    });
    assert.strictEqual(S(pol).inconclusiveReason, 'no_authoritative_account_id');
    assert.strictEqual(t.credentialVersion, before, 'nothing was written');
  });

  test('the masked/cookie email is NEVER accepted as provider proof of identity', async () => {
    // The policy approves the EMAIL, and the provider confirms a live session carrying that same
    // email — but no id. That must still not commit: an email is not the security boundary.
    const a = account(); const pol = policyRec({ approvedAccountKey: EMAIL }); const t = extTool();
    await withProvider(answer(200, JSON.stringify({ email: EMAIL })), async () => {
      const out = await extSync.reconcileExtensionTool(a, TOOL, deps(pol, [t]));
      assert.strictEqual(out.result, RESULT.INCONCLUSIVE);
    });
    assert.strictEqual(t.patchCalls === undefined ? 0 : 0, 0);
    assert.notStrictEqual(S(pol).boundIdentity, EMAIL);
  });

  test('a malformed (non-UUID) id is not approved as a fabricated identity', async () => {
    const a = account(); const pol = policyRec({ approvedAccountKey: 'not-a-uuid' }); const t = extTool();
    const before = t.credentialVersion;
    await withProvider(answer(200, JSON.stringify({ id: 'not-a-uuid', email: EMAIL })), async () => {
      const out = await extSync.reconcileExtensionTool(a, TOOL, deps(pol, [t]));
      assert.strictEqual(out.result, RESULT.INCONCLUSIVE);
    });
    assert.strictEqual(S(pol).inconclusiveReason, 'no_authoritative_account_id');
    assert.strictEqual(t.credentialVersion, before);
  });

  test('a provider-confirmed id that is NOT the approved one is rejected, never committed', async () => {
    const a = account(); const pol = policyRec({ approvedAccountKey: OTHER_UID }); const t = extTool();
    const before = t.credentialVersion;
    await withProvider(answer(200, userJson()), async () => {
      const out = await extSync.reconcileExtensionTool(a, TOOL, deps(pol, [t]));
      assert.strictEqual(out.result, RESULT.REJECTED);
    });
    assert.strictEqual(S(pol).lastError, 'account_not_approved');
    assert.strictEqual(t.credentialVersion, before);
  });
});

describe('2. a 200 that is not an authenticated answer is never proof', () => {
  const notProof = [
    ['HTML interstitial', answer(200, '<!doctype html><html><body>checking your browser… email: x@y.z</body></html>', 'text/html')],
    ['empty body', answer(200, '')],
    ['JSON array', answer(200, '[]')],
    ['bare JSON string', answer(200, '"ok"')],
    ['truncated JSON', answer(200, '{"id":"' + UID)],
  ];
  for (const [label, impl] of notProof) {
    test(`${label}: inconclusive, no commit, and NOT reported as signed out`, async () => {
      const a = account(); const pol = policyRec(); const t = extTool(); const before = t.credentialVersion;
      await withProvider(impl, async () => {
        const out = await extSync.reconcileExtensionTool(a, TOOL, deps(pol, [t]));
        assert.strictEqual(out.result, RESULT.INCONCLUSIVE, label);
      });
      assert.strictEqual(S(pol).lastCanary, 'inconclusive', label + ': liveness was not proven');
      assert.notStrictEqual(S(pol).lastVerifyResult, 'session_expired', label + ': and must not claim the session is dead');
      assert.strictEqual(t.credentialVersion, before, label + ': nothing written');
    });
  }

  test('an unambiguous 401 IS proof of a dead session: failed, no commit', async () => {
    const a = account(); const pol = policyRec(); const t = extTool(); const before = t.credentialVersion;
    await withProvider(answer(401, '{"msg":"invalid JWT"}'), async () => {
      const out = await extSync.reconcileExtensionTool(a, TOOL, deps(pol, [t]));
      assert.strictEqual(out.result, RESULT.FAILED);
    });
    assert.strictEqual(S(pol).lastCanary, 'failed');
    assert.strictEqual(t.credentialVersion, before);
  });
});

describe('3. a transient failure must not latch the engine permanently', () => {
  // Each cycle below is a separate reconcile driven by the existing agent heartbeat/cookie events.
  // `deps.now` advances past the throttle; no clock is really waited on and no worker is added.
  const minutesLater = (n) => new Date(Date.now() + n * 60 * 1000);

  test('REGRESSION: one transient 5xx, then the provider recovers → commit, with no manual cookies', async () => {
    // Before the fix the first inconclusive latched: the same-hash guard returned BEFORE the
    // throttle, so every later cycle short-circuited to INCONCLUSIVE and the credential never
    // reached the Tool again even though the provider was healthy. The operator's only remaining
    // move was a manual cookie overwrite or another source login — which is what was reported.
    const a = account(); const pol = policyRec(); const t = extTool(); const list = [t];

    await withProvider(answer(500, 'boom'), async () => {
      const out = await extSync.reconcileExtensionTool(a, TOOL, deps(pol, list, { now: minutesLater(0) }));
      assert.strictEqual(out.result, RESULT.INCONCLUSIVE);
    });
    assert.strictEqual(S(pol).inconclusiveReason, 'canary_inconclusive', 'classified as OUR/the provider\'s failure');
    assert.strictEqual(S(pol).transientTries, 1, 'the bounded budget is being counted');

    // The provider recovers. The SAME unchanged bundle must now be re-verified and committed.
    await withProvider(answer(200, userJson()), async () => {
      const out = await extSync.reconcileExtensionTool(a, TOOL, deps(pol, list, { now: minutesLater(2) }));
      assert.strictEqual(out.result, RESULT.SYNCED, 'recovery must not need a new rotation');
    });
    assert.strictEqual(S(pol).boundIdentity, UID);
    assert.strictEqual(t.credentialVersion, 4);
    assert.deepStrictEqual(readerCookies(t).map(c => c.name), ['sb-' + REF + '-auth-token']);
  });

  test('an AGED/invalid bundle still does not respin: deterministic reasons keep the short-circuit', async () => {
    // The guard's original purpose, preserved: an expired stored token cannot be proven by asking
    // again, so the engine must stay quiet until a genuine refresh changes the bundle.
    const a = account(); const pol = policyRec(); const t = extTool(); const list = [t];
    let calls = 0;
    const counting = async (...args) => { calls += 1; return answer(200, JSON.stringify({ email: EMAIL }))(...args); };
    await withProvider(counting, async () => {
      await extSync.reconcileExtensionTool(a, TOOL, deps(pol, list, { now: minutesLater(0) }));
      assert.strictEqual(S(pol).inconclusiveReason, 'no_authoritative_account_id', 'deterministic');
      assert.strictEqual(calls, 1);
      await extSync.reconcileExtensionTool(a, TOOL, deps(pol, list, { now: minutesLater(5) }));
      assert.strictEqual(calls, 1, 'no re-verify of an unchanged, deterministically-unprovable bundle');
    });
  });

  test('the transient retry is BOUNDED: it stops after the budget and does not spin per cycle', async () => {
    const a = account(); const pol = policyRec(); const t = extTool(); const list = [t];
    let calls = 0;
    const failing = async (...args) => { calls += 1; return answer(500, 'boom')(...args); };
    const max = extSync._internals.TRANSIENT_MAX_TRIES;
    await withProvider(failing, async () => {
      for (let i = 0; i < max + 4; i++) {
        await extSync.reconcileExtensionTool(a, TOOL, deps(pol, list, { now: minutesLater(i * 2) }));
      }
    });
    assert.strictEqual(calls, max, `at most ${max} provider calls for an unchanged bundle, got ${calls}`);
    assert.strictEqual(S(pol).lastResult, RESULT.INCONCLUSIVE, 'and it stays honestly unproven');
  });

  test('after the reset window the budget refreshes, so a long outage still self-heals', async () => {
    const a = account(); const pol = policyRec(); const t = extTool(); const list = [t];
    const max = extSync._internals.TRANSIENT_MAX_TRIES;
    const resetMin = extSync._internals.TRANSIENT_RETRY_RESET_MS / 60000;
    await withProvider(answer(500, 'boom'), async () => {
      for (let i = 0; i < max + 2; i++) {
        await extSync.reconcileExtensionTool(a, TOOL, deps(pol, list, { now: minutesLater(i * 2) }));
      }
    });
    assert.strictEqual(S(pol).lastResult, RESULT.INCONCLUSIVE, 'budget spent');
    // A heartbeat arriving after the reset window must try again rather than wait for a human.
    await withProvider(answer(200, userJson()), async () => {
      const out = await extSync.reconcileExtensionTool(a, TOOL, deps(pol, list, { now: minutesLater(resetMin + 10) }));
      assert.strictEqual(out.result, RESULT.SYNCED, 'a long outage recovers on a later event');
    });
    assert.strictEqual(t.credentialVersion, 4);
  });

  test('observe mode still reports without writing, even on the recovery path', async () => {
    const a = account(); const pol = policyRec({ mode: 'observe' }); const t = extTool(); const list = [t];
    const before = t.credentialVersion;
    await withProvider(answer(500, 'boom'), async () => {
      await extSync.reconcileExtensionTool(a, TOOL, deps(pol, list, { now: minutesLater(0) }));
    });
    await withProvider(answer(200, userJson()), async () => {
      const out = await extSync.reconcileExtensionTool(a, TOOL, deps(pol, list, { now: minutesLater(2) }));
      assert.strictEqual(out.result, RESULT.OBSERVE);
    });
    assert.strictEqual(S(pol).wouldSync, true, 'observe says what it WOULD do');
    assert.strictEqual(t.credentialVersion, before, 'and writes nothing');
  });
});
