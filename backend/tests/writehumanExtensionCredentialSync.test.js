'use strict';
/**
 * WriteHuman extension auto-sync — DYNAMIC, Tool-independent policy in its OWN record.
 *
 * The approved policy lives in a dedicated ExtAutoSyncPolicy record (keyed by tool+accountId), NOT on
 * the ProxyAccount — so the hardened agent pipeline's whole-record account.save() calls can never
 * restore a stale policy or undo an admin disable/rebind. The engine resolves the eligible extension
 * Tool DYNAMICALLY by normalized official domain (writehuman.ai): 0 → idle, 1 → bind/commit,
 * >1 → ambiguity. No Tool id is ever hardcoded.
 *
 * No database here: ProxyAccount session source, the Tool, and the Policy are in-memory fakes whose
 * patchGuarded/updateJsonPath mirror the real adapter's guard+set SEMANTICS. These verify control
 * flow; the real SQL is proven by scripts/extcredsync-db-selftest.js against a real engine.
 */
const test = require('node:test');
const assert = require('node:assert');
const crypto = require('crypto');

process.env.PROXY_VAULT_KEY = process.env.PROXY_VAULT_KEY || crypto.randomBytes(32).toString('hex');

const verifyMod = require('../utils/proxy/verify');
let nextVerify = { result: 'working', httpStatus: 200, maskedId: 'op***@example.com' };
verifyMod.verifyAccountCookies = async () => nextVerify;
const healthAlerts = require('../utils/proxy/healthAlerts');
healthAlerts.onVerifyApplied = async () => {};

const deviceSync = require('../utils/proxy/deviceSync');
const { ingestCandidate } = require('../utils/proxy/candidateSync');
const { authCookieHash } = require('../utils/proxy/cookies');
const vaultCrypto = require('../utils/proxy/vaultCrypto');
const { decryptCookies } = require('../utils/encryption');
const extSync = require('../utils/proxy/extensionCredentialSync');
const { RESULT } = extSync;

const TOOL = 'writehuman';
const REF = 'hicfsbrfkzsxbwayibfm';

function getByPath(o, p) { return String(p).split('.').reduce((x, k) => (x == null ? x : x[k]), o); }
function setByPath(o, p, v) { const ks = String(p).split('.'); let x = o; for (let i = 0; i < ks.length - 1; i++) { if (x[ks[i]] == null || typeof x[ks[i]] !== 'object') x[ks[i]] = {}; x = x[ks[i]]; } x[ks[ks.length - 1]] = v; }

function jwt(iat, sid) {
  const b64 = (o) => Buffer.from(JSON.stringify(o)).toString('base64').replace(/=+$/, '').replace(/\+/g, '-').replace(/\//g, '_');
  return b64({ alg: 'HS256' }) + '.' + b64({ iat, exp: iat + 3600, email: 'operator@example.com', session_id: sid }) + '.sig';
}
function bundle(iat, sid) {
  const payload = JSON.stringify({ access_token: jwt(iat, sid || 'sess-A'), refresh_token: 'rt-' + iat, user: { email: 'operator@example.com' } });
  return { cookies: [{ name: 'sb-' + REF + '-auth-token', value: 'base64-' + Buffer.from(payload).toString('base64'), domain: '.writehuman.ai', path: '/', secure: true }], origin: 'https://writehuman.ai' };
}
function account(initial) {
  const b = initial || bundle(2000, 'sess-L');
  return {
    _id: 'acct1', tool: TOOL, label: 'WriteHuman', isPrimary: true, status: 'active', session_status: 'working',
    expectedIdentifier: 'operator@example.com',
    sessionEncrypted: vaultCrypto.encrypt(JSON.stringify(b)),
    cookieHash: authCookieHash(b, REF), bundleVersion: 1,
    save() { return Promise.resolve(this); },  // whole-record save — must NOT affect the policy record
  };
}
function policyRec(over) {
  // Default policy EXPLICITLY approves account A (matches VERIFIED_A.accountKey) — no trust-on-first.
  return Object.assign({ _id: 'pol1', tool: TOOL, accountId: 'acct1', enabled: true, mode: 'enforce', officialDomain: 'writehuman.ai', approvedAccountKey: 'uid-AAAA-1111', sync: {} }, over);
}
let seq = 0;
function extTool(over) {
  return Object.assign({
    _id: 'tool-wh-' + (++seq), name: 'Write Human', status: 'active',
    domain: 'writehuman.ai', targetUrl: 'https://writehuman.ai/', credentialType: 'cookies',
    cookiesEncrypted: JSON.stringify([{ name: 'stale' }]),
    sessionBundle: { version: 2, cookiesEncrypted: JSON.stringify([{ name: 'stale' }]) },
    credentialVersion: 3,
  }, over);
}
function toolModel(list, opts = {}) {
  const m = { patchCalls: 0, failPatchOnce: !!opts.failPatchOnce,
    find: async (q) => list.filter(t => !q || !q.status || t.status === q.status),
    patchGuarded: async (id, setMap, guardMap) => {
      m.patchCalls += 1; if (m.failPatchOnce) { m.failPatchOnce = false; return 0; }
      const t = list.find(x => String(x._id) === String(id)); if (!t) return 0;
      for (const [p, exp] of Object.entries(guardMap || {})) { const cur = getByPath(t, p); if (exp === null || exp === undefined) { if (cur !== null && cur !== undefined) return 0; } else if (String(cur) !== String(exp)) return 0; }
      for (const [p, v] of Object.entries(setMap || {})) setByPath(t, p, v); return 1;
    } };
  return m;
}
// Fake Policy model: its OWN record; findOne by {tool,accountId}, findById (commit-boundary re-read),
// atomic status write to `sync`. `fresh` overrides findById (simulates a cross-process control change).
function policyModel(pol, opts = {}) {
  const m = { jsonPathCalls: 0,
    findOne: async (q) => (pol && pol.tool === q.tool && String(pol.accountId) === String(q.accountId)) ? pol : null,
    updateJsonPath: async (id, path, val) => { m.jsonPathCalls += 1; if (pol && String(pol._id) === String(id)) setByPath(pol, path, val); return 1; },
  };
  if (opts.withFindById) m.findById = async (id) => (pol && String(pol._id) === String(id)) ? (opts.fresh || pol) : null;
  return m;
}
const S = (pol) => (pol && pol.sync) || {};
const readerCookies = (t) => JSON.parse(decryptCookies(t.sessionBundle.cookiesEncrypted));
const committedCookies = (a) => JSON.parse(vaultCrypto.decrypt(a.sessionEncrypted)).cookies;
// CONCLUSIVE verify = server canary passed + authoritative Supabase user id (accountKey). This is
// what the real verifier returns only on a /auth/v1/user-confirmed live session.
const VERIFIED_A = { result: 'working', canary: 'passed', accountKey: 'uid-AAAA-1111', maskedId: 'op****@example.com' };
function deps(pol, list, opts) { return { Tool: toolModel(list, opts), Policy: policyModel(pol, opts || {}), deviceId: 'dev1', reVerify: async () => (opts && opts.verify) || VERIFIED_A }; }
// hook injects a reVerify via deps so the engine's OWN (canary) verify path is exercised with a
// deterministic result (the engine no longer trusts a passed-in promote verdict).
function hook(a, d, verify) { if (verify) d = Object.assign({}, d, { reVerify: async () => verify }); return extSync.syncRotationToExtensionTool(a, TOOL, { result: 'ignored' }, d); }
function reconcile(a, d, extra) { return extSync.reconcileExtensionTool(a, TOOL, Object.assign({}, d, extra)); }

// =============================================================================================

test('synced: resolves the single eligible writehuman.ai Tool by DOMAIN and commits (no Tool id used)', async () => {
  const a = account(); const pol = policyRec(); const t = extTool(); const before = t.credentialVersion;
  const out = await hook(a, deps(pol, [t]));
  assert.strictEqual(out.result, RESULT.SYNCED);
  assert.strictEqual(out.toolId, String(t._id));
  assert.deepStrictEqual(readerCookies(t), committedCookies(a));
  assert.strictEqual(t.credentialVersion, before + 1);
  assert.strictEqual(S(pol).lastResult, RESULT.SYNCED);
  assert.strictEqual(S(pol).syncedToolId, String(t._id));
});

test('policy in its OWN record: a stale whole-record account.save() cannot revert it', async () => {
  // Proves concern #2 fix: the policy is not a field on the account, so account.save() never touches it.
  const a = account(); const pol = policyRec(); const t = extTool();
  await hook(a, deps(pol, [t]));
  const beforeEnabled = pol.enabled;
  await a.save();                         // hardened pipeline whole-record save (stale in-memory copy)
  assert.strictEqual(pol.enabled, beforeEnabled, 'policy record is independent of the account save');
  assert.ok(!('extAutoSync' in a) || a.extAutoSync === undefined, 'no policy field lives on the account');
});

test('deletion: no eligible Tool → idle, policy preserved, nothing written, no Tool recreated', async () => {
  const a = account(); const pol = policyRec(); const d = deps(pol, []);
  const out = await hook(a, d);
  assert.strictEqual(out.result, 'idle');
  assert.strictEqual(d.Tool.patchCalls, 0);
  assert.strictEqual(pol.enabled, true);
  assert.strictEqual(S(pol).eligibleToolId, null);
});

test('recreation: a NEW Tool with the same domain auto-binds even if the account bundle is unchanged', async () => {
  const a = account(); const pol = policyRec(); const t1 = extTool();
  await hook(a, deps(pol, [t1]));
  assert.strictEqual(S(pol).syncedToolId, String(t1._id));
  const t2 = extTool(); const v2 = t2.credentialVersion;
  const out = await reconcile(a, deps(pol, [t2]));
  assert.strictEqual(out.result, RESULT.SYNCED);
  assert.strictEqual(out.toolId, String(t2._id));
  assert.strictEqual(t2.credentialVersion, v2 + 1);
  assert.deepStrictEqual(readerCookies(t2), committedCookies(a));
});

test('duplicate: two eligible writehuman.ai Tools → ambiguity, STOP, never guess', async () => {
  const a = account(); const pol = policyRec(); const d = deps(pol, [extTool(), extTool()]);
  const out = await hook(a, d);
  assert.strictEqual(out.result, 'ambiguous');
  assert.strictEqual(d.Tool.patchCalls, 0);
  assert.strictEqual(S(pol).lastError, 'multiple_eligible_tools');
});

// ---------------------------------------------------------------------------------------------
// EXPLICIT TOOL BINDING (policy.approvedToolId) — the tie-break for the case above.
//
// MEASURED IN PRODUCTION 2026-10-20: two Tools were legitimately ACTIVE on writehuman.ai —
// "Write Human" (31 client assignments, 489 credential fetches) and "WH" (7 assignments, 61
// fetches, its own independently maintained cookies). The engine refused with
// multiple_eligible_tools, which is correct, and there was NO way to resolve it: neither the
// policy nor the admin endpoint could name a Tool, and the endpoint rewrites `officialDomain`
// from the registry on every control change so that field cannot carry the distinction either.
//
// The binding only ever FILTERS the already-eligible set, so the engine still never writes to a
// Tool that is not active and on the official domain, and still refuses when it cannot be sure.
test('two eligible Tools + an explicit approvedToolId → commits to the BOUND Tool', async () => {
  const a = account(); const t1 = extTool(); const t2 = extTool();
  const pol = policyRec({ approvedToolId: String(t2._id) });
  const out = await hook(a, deps(pol, [t1, t2]));
  assert.strictEqual(out.result, RESULT.SYNCED);
  assert.strictEqual(out.toolId, String(t2._id), 'it must resolve to the bound Tool');
  assert.strictEqual(S(pol).syncedToolId, String(t2._id));
  // the OTHER Tool must be left completely untouched — 7 real clients depend on it
  assert.strictEqual(t1.credentialVersion, 3, 'the unbound Tool must not be written to');
});

test('a stale approvedToolId (not in the eligible set) still refuses — never falls back to guessing', async () => {
  const a = account(); const pol = policyRec({ approvedToolId: 'tool-that-no-longer-exists' });
  const d = deps(pol, [extTool(), extTool()]);
  const out = await hook(a, d);
  // Reported as the precise condition: the chosen target is gone, which is NOT the same thing as
  // "there are several, pick one". Either way it refuses and writes nothing.
  assert.strictEqual(out.result, 'target_unavailable');
  assert.strictEqual(S(pol).lastError, 'bound_tool_unavailable');
  assert.strictEqual(S(pol).eligibleToolId, null);
  assert.strictEqual(d.Tool.patchCalls, 0, 'nothing may be written when the binding cannot be honoured');
});

// LIFECYCLE CONTRACT. An EXPLICIT binding is authoritative regardless of how many Tools are
// eligible. The first version consulted it only when eligible.length > 1, so the selected Tool
// being deleted or disabled silently promoted whatever single Tool happened to be left. With a
// second, independently managed Tool in production ("WH", its own clients and its own
// credentials) that is a credential overwrite of someone else's record. A stale explicit binding
// is NOT an unbound policy. These cases pin the corrected contract.
test('selected Tool DISABLED, another remains: refuses, writes nothing anywhere', async () => {
  const a = account(); const other = extTool(); const selected = extTool({ status: 'disabled' });
  const pol = policyRec({ approvedToolId: String(selected._id) });
  const d = deps(pol, [other, selected]);
  const out = await hook(a, d);
  assert.strictEqual(out.result, 'target_unavailable');
  assert.strictEqual(S(pol).lastError, 'bound_tool_unavailable');
  assert.strictEqual(d.Tool.patchCalls, 0, 'no Tool may be written when the selected target is gone');
  assert.strictEqual(other.credentialVersion, 3, 'the unselected Tool must NOT be promoted');
  assert.strictEqual(selected.credentialVersion, 3);
});

test('selected Tool moved OFF-DOMAIN, another remains: refuses, no fallback write', async () => {
  const a = account(); const other = extTool();
  const selected = extTool({ domain: 'example.com', targetUrl: 'https://example.com/' });
  const pol = policyRec({ approvedToolId: String(selected._id) });
  const d = deps(pol, [other, selected]);
  const out = await hook(a, d);
  assert.strictEqual(out.result, 'target_unavailable');
  assert.strictEqual(d.Tool.patchCalls, 0);
  assert.strictEqual(other.credentialVersion, 3, 'an off-domain binding must not promote another Tool');
});

test('selected Tool DELETED leaving exactly one other: the single survivor is NOT promoted', async () => {
  const a = account(); const survivor = extTool();
  const pol = policyRec({ approvedToolId: 'tool-wh-deleted-synthetic' });
  const d = deps(pol, [survivor]);
  const out = await hook(a, d);
  assert.strictEqual(out.result, 'target_unavailable');
  assert.strictEqual(S(pol).lastError, 'bound_tool_unavailable');
  assert.strictEqual(d.Tool.patchCalls, 0);
  assert.strictEqual(survivor.credentialVersion, 3,
    'a stale binding must not authorise writing the survivor');
});

test('selected Tool RECREATED under a new id: approval does NOT transfer by name', async () => {
  const a = account();
  const recreated = extTool({ _id: 'tool-wh-new-id-synthetic', name: 'Write Human' });
  const pol = policyRec({ approvedToolId: 'tool-wh-old-id-synthetic' });
  const d = deps(pol, [recreated]);
  const out = await hook(a, d);
  assert.strictEqual(out.result, 'target_unavailable', 'same name, different id -> still unavailable');
  assert.strictEqual(d.Tool.patchCalls, 0);
  assert.strictEqual(recreated.credentialVersion, 3);
});

test('selected Tool RENAMED, same id and eligibility: continues without any name matching', async () => {
  const a = account(); const selected = extTool({ name: 'Write Human (renamed 2027)' });
  const pol = policyRec({ approvedToolId: String(selected._id) });
  const out = await hook(a, deps(pol, [selected, extTool()]));
  assert.strictEqual(out.result, RESULT.SYNCED);
  assert.strictEqual(out.toolId, String(selected._id));
});

test('an UNSELECTED Tool is removed: the selected target just continues', async () => {
  const a = account(); const selected = extTool(); const doomed = extTool();
  const pol = policyRec({ approvedToolId: String(selected._id) });
  let out = await hook(a, deps(pol, [selected, doomed]));
  assert.strictEqual(out.result, RESULT.SYNCED);
  assert.strictEqual(out.toolId, String(selected._id));
  const vAfterFirst = selected.credentialVersion;
  // Second cycle, the other Tool now gone. The stored bundle has not changed, so the truthful
  // result is UNCHANGED rather than another write — and it must still be the SAME target.
  out = await hook(a, deps(pol, [selected]));
  assert.strictEqual(out.result, RESULT.UNCHANGED);
  assert.strictEqual(S(pol).syncedToolId, String(selected._id));
  assert.strictEqual(selected.credentialVersion, vAfterFirst, 'no redundant re-write');
});

test('a NEW unrelated eligible Tool appears: selected target continues, newcomer untouched', async () => {
  const a = account(); const selected = extTool();
  const pol = policyRec({ approvedToolId: String(selected._id) });
  const newcomer = extTool({ name: 'Brand New WH' });
  const out = await hook(a, deps(pol, [selected, newcomer]));
  assert.strictEqual(out.result, RESULT.SYNCED);
  assert.strictEqual(out.toolId, String(selected._id));
  assert.strictEqual(newcomer.credentialVersion, 3, 'a newly added Tool must never be written to');
});

test('a genuinely UNBOUND policy with one eligible Tool keeps the legacy behaviour', async () => {
  const a = account();
  const out = await hook(a, deps(policyRec(), [extTool()]));
  assert.strictEqual(out.result, RESULT.SYNCED);
});

test('no eligible Tool stays idle even with a binding set', async () => {
  const a = account(); const pol = policyRec({ approvedToolId: 'tool-x' });
  const out = await hook(a, deps(pol, [extTool({ domain: 'example.com', targetUrl: 'https://example.com/' })]));
  assert.strictEqual(out.result, 'idle');
});

test('the binding changing mid-flight is caught at the commit boundary (no write to the old target)', async () => {
  const a = account(); const selected = extTool(); const pol = policyRec({ approvedToolId: String(selected._id) });
  // another process re-pointed the binding (and bumped the epoch) after this cycle resolved
  const fresh = policyRec({ approvedToolId: 'tool-wh-somewhere-else', policyEpoch: 99 });
  const d = deps(pol, [selected], { withFindById: true, fresh });
  const out = await hook(a, d);
  assert.strictEqual(out.result, RESULT.FAILED);
  assert.strictEqual(d.Tool.patchCalls, 0, 'a delayed commit must not write a newly unauthorised target');
  assert.strictEqual(selected.credentialVersion, 3);
});

// RESOURCE BOUND. These resolution outcomes return BEFORE the normal reconcile stamp was written,
// so nothing recorded that we had looked and the existing early rate gate could never throttle
// them: every agent heartbeat ran a full Tool.find({status:'active'}) forever. Production sat in
// `ambiguous` while this was true. They now stamp lastReconcileAt and reuse that same gate.
test('a bound-but-ineligible target is throttled like any other outcome (no per-heartbeat scan)', async () => {
  const a = account(); const pol = policyRec({ approvedToolId: 'tool-wh-gone-synthetic' });
  const d = deps(pol, [extTool()]);
  let out = await reconcile(a, d);
  assert.strictEqual(out.result, 'target_unavailable');
  assert.ok(S(pol).lastReconcileAt, 'the outcome must stamp lastReconcileAt for the early gate');
  out = await reconcile(a, d);
  assert.strictEqual(out.code, 'throttled', 'the second immediate cycle must short-circuit');
});

test('ambiguity is throttled too, and still never picks a candidate', async () => {
  const a = account(); const pol = policyRec(); const d = deps(pol, [extTool(), extTool()]);
  let out = await reconcile(a, d);
  assert.strictEqual(out.result, 'ambiguous');
  assert.strictEqual(S(pol).eligibleToolId, null, 'never nominate first/oldest/most-assigned');
  assert.ok(S(pol).lastReconcileAt);
  out = await reconcile(a, d);
  assert.strictEqual(out.code, 'throttled');
});

test('no eligible Tools: idle and throttled, not a busy loop', async () => {
  const a = account(); const pol = policyRec({ approvedToolId: 'tool-wh-x-synthetic' });
  const d = deps(pol, []);
  let out = await reconcile(a, d);
  assert.strictEqual(out.result, 'idle', 'zero candidates is idle even with a binding set');
  assert.ok(S(pol).lastReconcileAt);
  out = await reconcile(a, d);
  assert.strictEqual(out.code, 'throttled');
});

test('non-matching domains are ignored when resolving eligibility', async () => {
  const a = account(); const pol = policyRec(); const wh = extTool(); const other = extTool({ domain: 'example.com', targetUrl: 'https://example.com/' });
  const out = await hook(a, deps(pol, [other, wh]));
  assert.strictEqual(out.result, RESULT.SYNCED);
  assert.strictEqual(out.toolId, String(wh._id));
});

test('disable/revoke: a disabled policy is idle and is NEVER auto re-enabled', async () => {
  const a = account(); const pol = policyRec({ enabled: false, disabledExplicitly: true }); const d = deps(pol, [extTool()]);
  const out = await hook(a, d);
  assert.strictEqual(out.result, RESULT.SKIPPED);
  assert.strictEqual(out.code, 'policy_disabled');
  assert.strictEqual(d.Tool.patchCalls, 0);
  assert.strictEqual(pol.enabled, false);
});

test('observe mode: detects + reports, writes NO credential/revision', async () => {
  const a = account(); const pol = policyRec({ mode: 'observe' }); const t = extTool(); const v = t.credentialVersion; const d = deps(pol, [t]);
  const out = await hook(a, d);
  assert.strictEqual(out.result, RESULT.OBSERVE);
  assert.strictEqual(S(pol).wouldSync, true);
  assert.strictEqual(d.Tool.patchCalls, 0);
  assert.strictEqual(t.credentialVersion, v);
});

test('duplicate rotation to the SAME tool is a no-op', async () => {
  const a = account(); const pol = policyRec(); const t = extTool(); const d = deps(pol, [t]);
  await hook(a, d); const v = t.credentialVersion;
  const out = await extSync.syncRotationToExtensionTool(a, TOOL, { result: 'working', maskedId: 'op***@example.com' }, d);
  assert.strictEqual(out.result, RESULT.UNCHANGED);
  assert.strictEqual(t.credentialVersion, v);
});

test('verify FAILURE (real auth failure) never writes credentials and is reported as failed (not inconclusive, not valid)', async () => {
  const a = account(); const pol = policyRec(); const t = extTool(); const good = t.sessionBundle.cookiesEncrypted; const d = deps(pol, [t]);
  const out = await hook(a, d, { result: 'session_expired' });
  assert.strictEqual(out.result, RESULT.FAILED);
  assert.match(S(pol).lastError, /verify_failed:session_expired/);
  assert.strictEqual(S(pol).stage, 'detected');
  assert.strictEqual(S(pol).wouldSync, false);
  assert.strictEqual(d.Tool.patchCalls, 0);
  assert.strictEqual(t.sessionBundle.cookiesEncrypted, good);
});

test('verification INCONCLUSIVE (unknown) is distinct from failed/verified and NEVER commits or shows wouldSync', async () => {
  const a = account(); const pol = policyRec(); const t = extTool(); const good = t.sessionBundle.cookiesEncrypted; const v0 = t.credentialVersion; const d = deps(pol, [t]);
  const out = await hook(a, d, { result: 'unknown' });           // aged Supabase token → inconclusive
  assert.strictEqual(out.result, RESULT.INCONCLUSIVE);
  assert.strictEqual(S(pol).stage, 'verification_inconclusive');
  assert.strictEqual(S(pol).wouldSync, false);
  assert.strictEqual(S(pol).lastError, null, 'inconclusive is NOT an error');
  assert.ok(S(pol).lastDetectedAt, 'detection is still recorded');
  assert.strictEqual(S(pol).syncedToolId, undefined, 'never a commit marker');
  assert.strictEqual(d.Tool.patchCalls, 0);
  assert.strictEqual(t.credentialVersion, v0);
  assert.strictEqual(t.sessionBundle.cookiesEncrypted, good);
});

test('explicit approval: commits ONLY the admin-approved authoritative account id; a different id is rejected', async () => {
  const a = account(); const pol = policyRec({ mode: 'enforce' }); const t = extTool(); // approvedAccountKey = uid-AAAA-1111
  const out1 = await hook(a, deps(pol, [t]), { result: 'working', canary: 'passed', accountKey: 'uid-AAAA-1111', maskedId: 'op****@example.com' });
  assert.strictEqual(out1.result, RESULT.SYNCED);
  assert.strictEqual(S(pol).boundIdentity, 'uid-AAAA-1111');
  // Same masked email, DIFFERENT authoritative id → rejected (masked email is not the boundary).
  const good = t.sessionBundle.cookiesEncrypted; const v = t.credentialVersion;
  const out2 = await hook(a, deps(pol, [t]), { result: 'working', canary: 'passed', accountKey: 'uid-BBBB-2222', maskedId: 'op****@example.com' });
  assert.strictEqual(out2.result, RESULT.REJECTED);
  assert.strictEqual(S(pol).lastError, 'account_not_approved');
  assert.strictEqual(t.credentialVersion, v);
  assert.strictEqual(t.sessionBundle.cookiesEncrypted, good);
});

test('NO trust-on-first: without an explicit approval, a verified session is AWAITING_APPROVAL (never commits)', async () => {
  const a = account(); const pol = policyRec({ mode: 'enforce', approvedAccountKey: null }); const t = extTool(); const d = deps(pol, [t]);
  const out = await hook(a, d, { result: 'working', canary: 'passed', accountKey: 'uid-AAAA-1111', maskedId: 'op****@example.com' });
  assert.strictEqual(out.result, RESULT.AWAITING_APPROVAL);
  assert.strictEqual(S(pol).awaitingApproval, true);
  assert.strictEqual(S(pol).observedAccountKey, 'uid-AAAA-1111', 'surfaces the authenticated id for the admin to approve');
  assert.strictEqual(S(pol).boundIdentity, undefined, 'nothing auto-bound');
  assert.strictEqual(d.Tool.patchCalls, 0, 'never commits without explicit approval');
});

test('masked-identity collision: same masked email, different authoritative id → rejected (not the approved account)', async () => {
  const a = account(); const pol = policyRec({ mode: 'observe' }); const t = extTool(); // approved = uid-AAAA-1111
  const out = await hook(a, deps(pol, [t]), { result: 'working', canary: 'passed', accountKey: 'uid-CCCC-3333', maskedId: 'op****@example.com' });
  assert.strictEqual(out.result, RESULT.REJECTED);
  assert.strictEqual(S(pol).lastError, 'account_not_approved');
});

test('JWT-only "working" (no canary) is INCONCLUSIVE — a local token decode never authorizes a commit', async () => {
  const a = account(); const pol = policyRec({ mode: 'enforce' }); const t = extTool(); const d = deps(pol, [t]);
  const out = await hook(a, d, { result: 'working', maskedId: 'op****@example.com' }); // canary absent → local JWT only
  assert.strictEqual(out.result, RESULT.INCONCLUSIVE);
  assert.strictEqual(S(pol).stage, 'verification_inconclusive');
  assert.strictEqual(S(pol).wouldSync, false);
  assert.strictEqual(d.Tool.patchCalls, 0);
});

test('canary INCONCLUSIVE "working" is also INCONCLUSIVE (never a commit)', async () => {
  const a = account(); const pol = policyRec({ mode: 'enforce' }); const t = extTool(); const d = deps(pol, [t]);
  const out = await hook(a, d, { result: 'working', canary: 'inconclusive', maskedId: 'op****@example.com' });
  assert.strictEqual(out.result, RESULT.INCONCLUSIVE);
  assert.strictEqual(d.Tool.patchCalls, 0);
});

test('verified → wouldSync in observe, bound to the authoritative id (distinct from inconclusive)', async () => {
  const a = account(); const pol = policyRec({ mode: 'observe' }); const t = extTool(); const d = deps(pol, [t]);
  const out = await hook(a, d, { result: 'working', canary: 'passed', accountKey: 'uid-AAAA-1111', maskedId: 'op****@example.com' });
  assert.strictEqual(out.result, RESULT.OBSERVE);
  assert.strictEqual(S(pol).stage, 'wouldSync');
  assert.strictEqual(S(pol).wouldSync, true);
  assert.strictEqual(S(pol).boundIdentity, 'uid-AAAA-1111');
  assert.strictEqual(d.Tool.patchCalls, 0, 'observe never commits');
});

test('aged stored bundle: inconclusive once, then NOT re-verified every cycle until it changes', async () => {
  const a = account(); const pol = policyRec({ mode: 'enforce' }); const t = extTool();
  let verifyCalls = 0;
  const mkDeps = () => ({ Tool: toolModel([t]), Policy: policyModel(pol), deviceId: 'dev1', reVerify: async () => { verifyCalls++; return { result: 'unknown' }; } });
  const o1 = await reconcile(a, mkDeps());               // first: verifies the aged bundle → inconclusive
  assert.strictEqual(o1.result, RESULT.INCONCLUSIVE);
  assert.strictEqual(verifyCalls, 1);
  const o2 = await reconcile(a, mkDeps());               // same bundle hash → must NOT re-verify
  assert.strictEqual(verifyCalls, 1, 'no re-verify of an unchanged aged bundle');
  assert.ok(o2.result === RESULT.INCONCLUSIVE || o2.result === RESULT.UNCHANGED);
});

test('concurrency: a guarded-write conflict flags pending; reconcile heals without a new rotation', async () => {
  const a = account(); const pol = policyRec(); const t = extTool(); const good = t.sessionBundle.cookiesEncrypted; const v = t.credentialVersion;
  const out = await hook(a, deps(pol, [t], { failPatchOnce: true }));
  assert.strictEqual(out.result, RESULT.FAILED);
  assert.strictEqual(S(pol).lastError, 'commit_conflict');
  assert.strictEqual(S(pol).pending, true);
  assert.strictEqual(t.credentialVersion, v);
  assert.strictEqual(t.sessionBundle.cookiesEncrypted, good);
  const rec = await reconcile(a, deps(pol, [t]));
  assert.strictEqual(rec.result, RESULT.SYNCED);
  assert.strictEqual(S(pol).pending, false);
  assert.strictEqual(t.credentialVersion, v + 1);
});

test('fail-closed: with no guarded-write adapter method, an enforce commit does NOT unguarded-save', async () => {
  const a = account(); const pol = policyRec(); const t = extTool(); const good = t.sessionBundle.cookiesEncrypted; const v = t.credentialVersion;
  const d = deps(pol, [t]); delete d.Tool.patchGuarded;
  const out = await hook(a, d);
  assert.strictEqual(out.result, RESULT.FAILED);
  assert.strictEqual(S(pol).lastError, 'no_guarded_write');
  assert.strictEqual(S(pol).pending, true);
  assert.strictEqual(t.credentialVersion, v);
  assert.strictEqual(t.sessionBundle.cookiesEncrypted, good);
});

test('policy idle when there is no policy record (no accidental binding)', async () => {
  const a = account(); const d = deps(null, [extTool()]);
  const out = await hook(a, d);
  assert.strictEqual(out.result, RESULT.SKIPPED);
  assert.strictEqual(out.code, 'policy_idle');
  assert.strictEqual(d.Tool.patchCalls, 0);
});

test('no policy MODEL supplied → safely skipped', async () => {
  const a = account();
  const out = await extSync.syncRotationToExtensionTool(a, TOOL, { result: 'working', maskedId: 'x' }, { Tool: toolModel([extTool()]) });
  assert.strictEqual(out.result, RESULT.SKIPPED);
  assert.strictEqual(out.code, 'no_policy_model');
});

test('cross-process revoke: policy disabled in another process before commit → aborts, pending, no write', async () => {
  const a = account(); const pol = policyRec({ policyEpoch: 100 }); const t = extTool(); const good = t.sessionBundle.cookiesEncrypted; const v = t.credentialVersion;
  const fresh = { _id: pol._id, tool: TOOL, accountId: 'acct1', enabled: false, mode: 'enforce', officialDomain: 'writehuman.ai', policyEpoch: 100 };
  const d = deps(pol, [t], { withFindById: true, fresh });
  const out = await hook(a, d);
  assert.strictEqual(out.result, RESULT.FAILED);
  assert.strictEqual(S(pol).lastError, 'policy_revoked');
  assert.strictEqual(d.Tool.patchCalls, 0);
  assert.strictEqual(t.credentialVersion, v);
  assert.strictEqual(t.sessionBundle.cookiesEncrypted, good);
});

test('cross-process policy change (epoch bump) before commit → aborts', async () => {
  const a = account(); const pol = policyRec({ policyEpoch: 100 }); const t = extTool();
  const fresh = { _id: pol._id, tool: TOOL, accountId: 'acct1', enabled: true, mode: 'enforce', officialDomain: 'writehuman.ai', policyEpoch: 200 };
  const d = deps(pol, [t], { withFindById: true, fresh });
  const out = await hook(a, d);
  assert.strictEqual(out.result, RESULT.FAILED);
  assert.strictEqual(S(pol).lastError, 'policy_changed');
  assert.strictEqual(d.Tool.patchCalls, 0);
});

test('ambiguous source account: resolver rejects multiple, accepts explicit id / single primary', () => {
  const r = extSync.resolveBindAccount;
  assert.strictEqual(r([{ _id: 'a1' }, { _id: 'a2' }], null).code, 'ambiguous_account');
  assert.strictEqual(r([{ _id: 'a1' }, { _id: 'a2' }], 'a2').account._id, 'a2');
  assert.strictEqual(r([{ _id: 'a1', isPrimary: true }, { _id: 'a2' }], null).account._id, 'a1');
  assert.strictEqual(r([{ _id: 'solo' }], null).account._id, 'solo');
  assert.strictEqual(r([], null).code, 'no_account');
});

test('domain normalization: www./scheme/port variants resolve to the same official host', () => {
  const n = extSync.normDomain;
  assert.strictEqual(n('https://www.writehuman.ai:443/app'), 'writehuman.ai');
  assert.strictEqual(n('WriteHuman.AI'), 'writehuman.ai');
  assert.strictEqual(n('writehuman.ai'), 'writehuman.ai');
});

test('global kill switch halts all sync', async () => {
  const a = account(); const pol = policyRec(); const d = deps(pol, [extTool()]);
  process.env.EXT_CRED_SYNC_DISABLED = '1';
  try {
    const out = await hook(a, d);
    assert.strictEqual(out.result, RESULT.SKIPPED);
    assert.strictEqual(out.code, 'globally_disabled');
    assert.strictEqual(d.Tool.patchCalls, 0);
  } finally { delete process.env.EXT_CRED_SYNC_DISABLED; }
});
