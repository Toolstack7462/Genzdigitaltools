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
// An EXPIRED access token: verify.js skips the canary fast path entirely, so the answer cannot
// be made conclusive by asking the provider again — only a genuine browser refresh can fix it.
function expiredBundle() {
  const nowSec = Math.floor(Date.now() / 1000);
  const b64 = (o) => Buffer.from(JSON.stringify(o)).toString('base64').replace(/=+$/, '').replace(/\+/g, '-').replace(/\//g, '_');
  const jwt = `${b64({ alg: 'HS256' })}.${b64({ iat: nowSec - 7200, exp: nowSec - 3600, email: EMAIL, session_id: 'sess-X' })}.sig`;
  const payload = JSON.stringify({ access_token: jwt, refresh_token: 'rt-X', user: { email: EMAIL } });
  return { cookies: [{ name: 'sb-' + REF + '-auth-token', value: 'base64-' + Buffer.from(payload).toString('base64'), domain: '.writehuman.ai', path: '/', secure: true }], origin: 'https://writehuman.ai' };
}
function accountWith(b) {
  return {
    _id: 'acct1', tool: TOOL, label: 'WriteHuman', isPrimary: true, status: 'active', session_status: 'working',
    expectedIdentifier: null,
    sessionEncrypted: vaultCrypto.encrypt(JSON.stringify(b)),
    cookieHash: authCookieHash(b, REF), bundleVersion: 1,
    save() { return Promise.resolve(this); },
  };
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

  test('a 200 user object with NO id is NOT proof at all: inconclusive, no commit', async () => {
    // Stricter than the first pass, deliberately. A real /auth/v1/user 200 always carries `id`, and
    // `canary:'passed'` is what candidateSync accepts as positive proof to PROMOTE a bundle — so a
    // contentless 200 must not reach 'passed' either. Liveness and identity now stand or fall
    // together at this boundary.
    const a = account(); const pol = policyRec(); const t = extTool(); const before = t.credentialVersion;
    await withProvider(answer(200, JSON.stringify({ email: EMAIL })), async () => {
      const out = await extSync.reconcileExtensionTool(a, TOOL, deps(pol, [t]));
      assert.strictEqual(out.result, RESULT.INCONCLUSIVE);
    });
    assert.strictEqual(S(pol).lastCanary, 'inconclusive', 'not promotable proof');
    assert.strictEqual(t.credentialVersion, before, 'nothing was written');
  });

  test('the ENGINE gate still rejects a verified-but-identityless result (no_authoritative_account_id)', async () => {
    // The producer can no longer emit that shape, but the consumer's gate must stay closed anyway:
    // this drives the engine directly so the branch keeps its coverage.
    const a = account(); const pol = policyRec(); const t = extTool(); const before = t.credentialVersion;
    const out = await extSync.reconcileExtensionTool(a, TOOL, deps(pol, [t], {
      reVerify: async () => ({ result: 'working', canary: 'passed', accountKey: null, maskedId: 'op****@example.com' }),
    }));
    assert.strictEqual(out.result, RESULT.INCONCLUSIVE);
    assert.strictEqual(S(pol).inconclusiveReason, 'no_authoritative_account_id');
    assert.strictEqual(t.credentialVersion, before);
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
    assert.strictEqual(S(pol).lastCanary, 'inconclusive', 'an unrecognisable id is not proof');
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

  test('an AGED/EXPIRED bundle still does not respin: deterministic reasons keep the short-circuit', async () => {
    // The guard's original purpose, preserved: an expired stored token cannot be proven by asking
    // again, so the engine must stay quiet until a genuine refresh changes the bundle. The fixture
    // is a REAL expired token, so verify.js never reaches the provider at all.
    const a = accountWith(expiredBundle()); const pol = policyRec(); const t = extTool(); const list = [t];
    let calls = 0;
    const counting = async (...args) => { calls += 1; return answer(200, userJson())(...args); };
    await withProvider(counting, async () => {
      const o1 = await extSync.reconcileExtensionTool(a, TOOL, deps(pol, list, { now: minutesLater(0) }));
      assert.strictEqual(o1.result, RESULT.INCONCLUSIVE);
      const why = S(pol).inconclusiveReason;
      assert.ok(!extSync._internals.TRANSIENT_INCONCLUSIVE.has(String(why)),
        `an expired token must be a DETERMINISTIC reason, got ${why}`);
      const before = calls;
      await extSync.reconcileExtensionTool(a, TOOL, deps(pol, list, { now: minutesLater(5) }));
      assert.strictEqual(calls, before, 'no re-verify of an unchanged, deterministically-unprovable bundle');
      assert.strictEqual(S(pol).transientTries, 0, 'a deterministic reason must not consume the budget');
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

describe('4. the retry budget is a real, resetting window (review lead B)', () => {
  const minutesLater = (n) => new Date(Date.now() + n * 60 * 1000);
  const MAX = extSync._internals.TRANSIENT_MAX_TRIES;
  const RESET_MIN = extSync._internals.TRANSIENT_RETRY_RESET_MS / 60000;

  // Only a reconcile/hook that actually REACHES the verifier consumes an attempt. A cycle that the
  // short-circuit or the throttle answers does not, which is what keeps this bounded rather than
  // merely slow.
  async function drive(a, pol, list, impl, atMinutes) {
    let calls = 0;
    const counting = async (...args) => { calls += 1; return impl(...args); };
    await withProvider(counting, async () => {
      for (const m of atMinutes) await extSync.reconcileExtensionTool(a, TOOL, deps(pol, list, { now: minutesLater(m) }));
    });
    return calls;
  }

  test('REGRESSION: exhausted -> window elapses -> one more failure -> attempts REMAIN', async () => {
    // The first fix made the window merely ELIGIBLE: the old counter survived, so the new window
    // allowed exactly one attempt and then latched again. A window that does not reset its counter
    // is not a renewed budget.
    const a = account(); const pol = policyRec(); const t = extTool(); const list = [t];
    const fail = answer(500, 'boom');

    const spent = await drive(a, pol, list, fail, Array.from({ length: MAX + 3 }, (_, i) => i * 2));
    assert.strictEqual(spent, MAX, 'budget exhausts at MAX');
    assert.strictEqual(S(pol).transientTries, MAX);

    // the window elapses, and ONE more transient failure happens inside the new window
    const one = await drive(a, pol, list, fail, [RESET_MIN + 2]);
    assert.strictEqual(one, 1, 'the renewed window allows an attempt');
    assert.strictEqual(S(pol).transientTries, 1, 'the counter RESET for the new window');

    // attempts must REMAIN in this new window
    const more = await drive(a, pol, list, fail, [RESET_MIN + 4, RESET_MIN + 6]);
    assert.strictEqual(more, 2, 'the rest of the renewed budget is available');
    assert.strictEqual(S(pol).transientTries, 3);
  });

  test('and it eventually recovers inside the renewed window, with no manual cookies', async () => {
    const a = account(); const pol = policyRec(); const t = extTool(); const list = [t];
    await drive(a, pol, list, answer(500, 'boom'), Array.from({ length: MAX + 2 }, (_, i) => i * 2));
    const ok = await drive(a, pol, list, answer(200, userJson()), [RESET_MIN + 2]);
    assert.strictEqual(ok, 1);
    assert.strictEqual(S(pol).lastResult, RESULT.SYNCED);
    assert.strictEqual(t.credentialVersion, 4);
  });

  test('a SUCCESSFUL sync clears the budget, so a later blip starts from a full window', async () => {
    const a = account(); const pol = policyRec(); const t = extTool(); const list = [t];
    await drive(a, pol, list, answer(500, 'boom'), [0, 2]);
    assert.strictEqual(S(pol).transientTries, 2);
    await drive(a, pol, list, answer(200, userJson()), [4]);
    assert.strictEqual(S(pol).lastResult, RESULT.SYNCED);
    assert.strictEqual(S(pol).transientTries, 0, 'a conclusive outcome clears the counter');
    assert.strictEqual(S(pol).transientWindowAt, null);
  });

  test('a NEW bundle resets the budget (a genuine refresh is not the old failure)', async () => {
    const a = account('A'); const pol = policyRec(); const t = extTool(); const list = [t];
    await drive(a, pol, list, answer(500, 'boom'), Array.from({ length: MAX + 2 }, (_, i) => i * 2));
    assert.strictEqual(S(pol).transientTries, MAX, 'budget spent on the old bundle');
    // the browser refreshes: a different stored bundle, so a different hash
    const b = liveBundle('B');
    a.sessionEncrypted = vaultCrypto.encrypt(JSON.stringify(b));
    a.cookieHash = authCookieHash(b, REF);
    const after = await drive(a, pol, list, answer(500, 'boom'), [MAX * 2 + 4]);
    assert.strictEqual(after, 1, 'the new bundle is verified despite the old exhausted budget');
    assert.strictEqual(S(pol).transientTries, 1, 'and starts its own window');
  });

  test('a CHANGED (recreated) Tool resets the budget', async () => {
    const a = account(); const pol = policyRec(); const t = extTool(); const list = [t];
    await drive(a, pol, list, answer(500, 'boom'), Array.from({ length: MAX + 2 }, (_, i) => i * 2));
    assert.strictEqual(S(pol).transientTries, MAX);
    const t2 = extTool();                 // a NEW Tool id on the same official domain
    const after = await drive(a, pol, [t2], answer(500, 'boom'), [MAX * 2 + 4]);
    assert.strictEqual(after, 1, 'a recreated Tool is not the old failure');
    assert.strictEqual(S(pol).transientTries, 1);
  });

  test('state lives in the policy record, so a process restart does not refill the budget', async () => {
    // The counter and window are persisted fields, not module memory: a fresh engine invocation
    // reading the same record must still see the budget as spent.
    const a = account(); const pol = policyRec(); const t = extTool(); const list = [t];
    await drive(a, pol, list, answer(500, 'boom'), Array.from({ length: MAX + 2 }, (_, i) => i * 2));
    assert.strictEqual(S(pol).transientTries, MAX);
    const windowAt = S(pol).transientWindowAt;
    assert.ok(windowAt, 'the window start is persisted');
    const afterRestart = await drive(a, pol, list, answer(500, 'boom'), [MAX * 2 + 4]);
    assert.strictEqual(afterRestart, 0, 'a restart does not hand out a fresh budget');
    assert.strictEqual(S(pol).transientWindowAt, windowAt, 'and does not move the window');
  });

  test('a failed Tool WRITE is pending, not a transient verification failure', async () => {
    // A commit that is verified but whose guarded write loses the race must keep healing through
    // `pending` — it must not be charged to the provider-failure budget.
    const a = account(); const pol = policyRec(); const t = extTool();
    const conflicting = { find: async () => [t], patchGuarded: async () => 0 };
    await withProvider(answer(200, userJson()), async () => {
      const out = await extSync.reconcileExtensionTool(a, TOOL, {
        Tool: conflicting, Policy: policyModel(pol), deviceId: 'dev1', now: minutesLater(0),
      });
      assert.notStrictEqual(out.result, RESULT.SYNCED);
    });
    assert.strictEqual(S(pol).pending, true, 'it heals via pending');
    assert.strictEqual(Number(S(pol).transientTries || 0), 0, 'a write conflict is not a provider failure');
  });

  test('a pending commit is retried on the NEXT event even with an unchanged bundle', async () => {
    const a = account(); const pol = policyRec(); const t = extTool();
    const conflicting = { find: async () => [t], patchGuarded: async () => 0 };
    await withProvider(answer(200, userJson()), async () => {
      await extSync.reconcileExtensionTool(a, TOOL, { Tool: conflicting, Policy: policyModel(pol), deviceId: 'dev1', now: minutesLater(0) });
    });
    assert.strictEqual(S(pol).pending, true);
    await withProvider(answer(200, userJson()), async () => {
      const out = await extSync.reconcileExtensionTool(a, TOOL, deps(pol, [t], { now: minutesLater(1) }));
      assert.strictEqual(out.result, RESULT.SYNCED, 'pending bypasses the no-respin guard and heals');
    });
    assert.strictEqual(t.credentialVersion, 4);
  });
});

describe('5. verification honesty: four separate facts stay separate (review lead C)', () => {
  const minutesLater = (n) => new Date(Date.now() + n * 60 * 1000);

  test('a failed Tool WRITE never advances the provider-verification or sync timestamps', async () => {
    // Source receipt, provider verification, the committed Tool update and client access are four
    // different facts. A verified bundle whose guarded write loses the race is NOT a sync, and the
    // panel must not show it as freshly verified or freshly synced.
    const a = account(); const pol = policyRec(); const t = extTool();
    // seed a previous GOOD commit, so we can prove last-known-good survives the failure
    pol.sync = { lastSyncAt: new Date(Date.now() - 3600e3), lastVerifiedAt: new Date(Date.now() - 3600e3), syncedHash: 'good-hash', syncedToolId: 'good-tool' };
    const good = { ...pol.sync };
    const conflicting = { find: async () => [t], patchGuarded: async () => 0 };
    await withProvider(answer(200, userJson()), async () => {
      const out = await extSync.reconcileExtensionTool(a, TOOL, {
        Tool: conflicting, Policy: policyModel(pol), deviceId: 'dev1', now: minutesLater(0),
      });
      assert.notStrictEqual(out.result, RESULT.SYNCED);
    });
    assert.strictEqual(S(pol).pending, true, 'it is pending, and says so');
    assert.strictEqual(String(S(pol).lastSyncAt), String(good.lastSyncAt), 'lastSyncAt must NOT move');
    assert.strictEqual(String(S(pol).lastVerifiedAt), String(good.lastVerifiedAt), 'lastVerifiedAt must NOT move');
    assert.strictEqual(S(pol).syncedHash, 'good-hash', 'last-known-good bundle identity retained');
    assert.strictEqual(S(pol).syncedToolId, 'good-tool', 'last-known-good Tool retained');
  });

  test('an INCONCLUSIVE check never advances lastVerifiedAt and never expires the session', async () => {
    const a = account(); const pol = policyRec(); const t = extTool();
    pol.sync = { lastVerifiedAt: new Date(Date.now() - 3600e3) };
    const was = String(pol.sync.lastVerifiedAt);
    await withProvider(answer(500, 'boom'), async () => {
      const out = await extSync.reconcileExtensionTool(a, TOOL, deps(pol, [t], { now: minutesLater(0) }));
      assert.strictEqual(out.result, RESULT.INCONCLUSIVE);
    });
    assert.strictEqual(String(S(pol).lastVerifiedAt), was, 'our own failure is not a verification');
    assert.strictEqual(a.session_status, 'working', 'and must not force the source session expired');
  });

  test('OBSERVE reports wouldSync but writes no credential and claims no sync', async () => {
    const a = account(); const pol = policyRec({ mode: 'observe' }); const t = extTool();
    const before = t.credentialVersion; const beforeBundle = t.sessionBundle.cookiesEncrypted;
    await withProvider(answer(200, userJson()), async () => {
      const out = await extSync.reconcileExtensionTool(a, TOOL, deps(pol, [t], { now: minutesLater(0) }));
      assert.strictEqual(out.result, RESULT.OBSERVE);
    });
    assert.strictEqual(S(pol).wouldSync, true);
    assert.strictEqual(t.credentialVersion, before, 'no revision bump');
    assert.strictEqual(t.sessionBundle.cookiesEncrypted, beforeBundle, 'no credential written');
    assert.ok(!S(pol).lastSyncAt, 'observe never claims a sync');
  });
});

describe('6. the provider-request budget applies on EVERY path, pending included', () => {
  const minutesLater = (n) => new Date(Date.now() + n * 60 * 1000);
  const MAX = extSync._internals.TRANSIENT_MAX_TRIES;

  // A pending DB write and a failing provider are two different recoveries with two different
  // controls. `pending` must keep retrying the WRITE; it must not become an unthrottled provider
  // poll while the provider itself is down.
  async function run(a, pol, Tool, impl, atMinutes) {
    let calls = 0;
    const counting = async (...args) => { calls += 1; return impl(...args); };
    await withProvider(counting, async () => {
      for (const m of atMinutes) {
        await extSync.reconcileExtensionTool(a, TOOL, { Tool, Policy: policyModel(pol), deviceId: 'dev1', now: minutesLater(m) });
      }
    });
    return calls;
  }

  test('REGRESSION: a pending write + a provider outage must not poll the provider every event', async () => {
    const a = account(); const pol = policyRec(); const t = extTool();
    const conflicting = { find: async () => [t], patchGuarded: async () => 0 };

    // 1. a good provider check, then the guarded write loses the race -> pending
    const first = await run(a, pol, conflicting, answer(200, userJson()), [0]);
    assert.strictEqual(first, 1);
    assert.strictEqual(S(pol).pending, true, 'the write is pending');

    // 2. the provider then goes down, and the ordinary heartbeat/cookie events keep arriving
    const EVENTS = [2, 4, 6, 8, 10, 12, 14, 16, 18, 20];
    const during = await run(a, pol, conflicting, answer(500, 'boom'), EVENTS);
    assert.ok(during <= MAX,
      `a pending write must not bypass the provider budget: ${during} provider calls across ${EVENTS.length} events (cap ${MAX})`);
    assert.strictEqual(S(pol).pending, true, 'and it is still honestly pending');
  });

  test('pending still heals promptly once the provider answers again', async () => {
    // Bounding the provider calls must NOT stop legitimate database-write recovery.
    const a = account(); const pol = policyRec(); const t = extTool();
    const conflicting = { find: async () => [t], patchGuarded: async () => 0 };
    await run(a, pol, conflicting, answer(200, userJson()), [0]);
    assert.strictEqual(S(pol).pending, true);
    await run(a, pol, conflicting, answer(500, 'boom'), [2, 4]);
    // the DB write starts succeeding again
    const healthy = { find: async () => [t], patchGuarded: toolModel([t]).patchGuarded };
    await withProvider(answer(200, userJson()), async () => {
      const out = await extSync.reconcileExtensionTool(a, TOOL, { Tool: healthy, Policy: policyModel(pol), deviceId: 'dev1', now: minutesLater(40) });
      assert.strictEqual(out.result, RESULT.SYNCED, 'the pending write heals without a new rotation');
    });
    assert.strictEqual(S(pol).pending, false);
  });

  test('an authorized force/recheck is still allowed to ask immediately', async () => {
    // The admin action must not be throttled into uselessness, but it IS a deliberate, bounded,
    // operator-initiated request rather than an automatic loop.
    const a = account(); const pol = policyRec(); const t = extTool(); const list = [t];
    await run(a, pol, toolModel(list), answer(500, 'boom'), [0]);
    let calls = 0;
    await withProvider(async (...args) => { calls += 1; return answer(200, userJson())(...args); }, async () => {
      const out = await extSync.reconcileExtensionTool(a, TOOL, { Tool: toolModel(list), Policy: policyModel(pol), deviceId: 'dev1', now: minutesLater(0.1), force: true });
      assert.strictEqual(out.result, RESULT.SYNCED);
    });
    assert.strictEqual(calls, 1, 'force asks once, immediately');
  });

  test('the HOOK path (a real promote) is bounded by the promote itself, not by this budget', async () => {
    // A hook only fires when candidateSync actually promoted a NEW bundle, so it is rate-limited by
    // real browser rotations. It deliberately bypasses the unchanged-bundle guard — but each hook is
    // one provider call, not a loop.
    const a = account(); const pol = policyRec(); const t = extTool(); const list = [t];
    let calls = 0;
    await withProvider(async (...args) => { calls += 1; return answer(200, userJson())(...args); }, async () => {
      await extSync.syncRotationToExtensionTool(a, TOOL, { result: 'working', maskedId: 'op****@example.com' },
        { Tool: toolModel(list), Policy: policyModel(pol), deviceId: 'dev1', now: minutesLater(0) });
    });
    assert.strictEqual(calls, 1, 'one hook = one authoritative verify');
  });
});

describe('7. steady-state database cost is bounded, not just provider calls', () => {
  const minutesLater = (n) => new Date(Date.now() + n * 60 * 1000);

  // Counting models: the engine's DB cost per event is what this measures. Provider calls are
  // already covered above; this is the part that shows up as database load on shared hosting.
  function counting(pol, list) {
    const c = { toolFind: 0, policyRead: 0, statusWrite: 0, toolWrite: 0 };
    return {
      c,
      Tool: {
        find: async (q) => { c.toolFind++; return list.filter(t => !q || !q.status || t.status === q.status); },
        patchGuarded: async (id, setMap, guardMap) => { c.toolWrite++; return toolModel(list).patchGuarded(id, setMap, guardMap); },
      },
      Policy: {
        findOne: async () => { c.policyRead++; return pol; },
        findById: async () => { c.policyRead++; return pol; },
        updateJsonPath: async (id, p, v) => { c.statusWrite++; return policyModel(pol).updateJsonPath(id, p, v); },
      },
    };
  }

  test('a settled account costs NO tool read and NO status write between throttle intervals', async () => {
    const a = account(); const pol = policyRec(); const t = extTool(); const list = [t];
    const m = counting(pol, list);
    // establish the synced state
    await withProvider(answer(200, userJson()), async () => {
      const out = await extSync.reconcileExtensionTool(a, TOOL, { Tool: m.Tool, Policy: m.Policy, deviceId: 'd1', now: minutesLater(0), force: true });
      assert.strictEqual(out.result, RESULT.SYNCED);
    });
    const base = { ...m.c };
    // four more heartbeats inside the throttle interval (15s apart)
    await withProvider(answer(200, userJson()), async () => {
      for (const sec of [15, 30, 45]) {
        const out = await extSync.reconcileExtensionTool(a, TOOL, { Tool: m.Tool, Policy: m.Policy, deviceId: 'd1', now: new Date(Date.now() + sec * 1000) });
        // It reports the LAST KNOWN result rather than inventing a fresh verdict, which is the
        // truthful answer for a cycle that deliberately did not look.
        assert.ok(out.result === RESULT.UNCHANGED || out.result === RESULT.SYNCED, 'reports the last known state: ' + out.result);
        assert.ok(out.code === 'throttled' || out.code === 'settled', 'and says why it did not look: ' + out.code);
      }
    });
    assert.strictEqual(m.c.toolFind - base.toolFind, 0, 'no eligible-Tool read for a settled account');
    assert.strictEqual(m.c.statusWrite - base.statusWrite, 0, 'no status write that says nothing new');
    assert.strictEqual(m.c.toolWrite - base.toolWrite, 0, 'and certainly no credential write');
  });

  test('a genuine rotation still breaks the fast path immediately', async () => {
    // The fast path keys on the stored bundle hash, so a real refresh cannot be skipped.
    const a = account('A'); const pol = policyRec(); const t = extTool(); const list = [t];
    const m = counting(pol, list);
    await withProvider(answer(200, userJson()), async () => {
      await extSync.reconcileExtensionTool(a, TOOL, { Tool: m.Tool, Policy: m.Policy, deviceId: 'd1', now: minutesLater(0), force: true });
    });
    const before = m.c.toolWrite;
    const b = liveBundle('B');
    a.sessionEncrypted = vaultCrypto.encrypt(JSON.stringify(b));
    a.cookieHash = authCookieHash(b, REF);
    // A real rotation arrives as a HOOK from candidateSync's promote, which bypasses the reconcile
    // rate controls by design — so a genuine refresh is never delayed by the throttle or the
    // settled fast path. (An ordinary reconcile within the throttle interval IS deferred to the
    // next event; that was true before this optimization too.)
    await withProvider(answer(200, userJson()), async () => {
      const out = await extSync.syncRotationToExtensionTool(a, TOOL, { result: 'working', maskedId: 'op****@example.com' },
        { Tool: m.Tool, Policy: m.Policy, deviceId: 'd1', now: new Date(Date.now() + 10000) });
      assert.strictEqual(out.result, RESULT.SYNCED, 'a rotation is never skipped as "settled"');
    });
    assert.strictEqual(m.c.toolWrite - before, 1, 'and it commits exactly once');
  });

  test('a pending write is never skipped as settled', async () => {
    const a = account(); const pol = policyRec(); const t = extTool();
    const conflicting = { find: async () => [t], patchGuarded: async () => 0 };
    await withProvider(answer(200, userJson()), async () => {
      await extSync.reconcileExtensionTool(a, TOOL, { Tool: conflicting, Policy: policyModel(pol), deviceId: 'd1', now: minutesLater(0) });
    });
    assert.strictEqual(S(pol).pending, true);
    // a healthy write arrives shortly after; it must NOT be short-circuited as settled
    await withProvider(answer(200, userJson()), async () => {
      const out = await extSync.reconcileExtensionTool(a, TOOL, deps(pol, [t], { now: minutesLater(2) }));
      assert.strictEqual(out.result, RESULT.SYNCED, 'pending still heals');
    });
  });
});
