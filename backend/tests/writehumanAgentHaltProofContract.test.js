'use strict';
/**
 * WHAT A 'PROMOTED' REPLY ACTUALLY PROVES - and what may therefore clear a security halt.
 *
 * Incident 03cbb77d left the installed agent with haltedReason='submission_outcome_unknown': a
 * password was submitted and the outcome could not be observed. The first attempt at a fix resolved
 * that halt whenever the server answered
 *
 *     verified = PROMOTED && promoted===true && isActiveSource===true && !standDown
 *
 * describing it as "the backend's PROMOTED verdict on a provider-verified candidate ... proof the
 * submission DID succeed for the right account". Traced against the running backend, that is FALSE:
 *
 *   candidateSync.js  routine pushes call verifyAccountCookies(..., {readOnly:true}); the canary is
 *                     requested on the ACTIVATION path only.
 *   verify.js         without a canary it returns {result:'working', finalPath:'/auth (jwt)'} - a
 *                     LOCAL JWT DECODE, with no `canary` field. A Supabase access token stays
 *                     exp-valid for about an hour AFTER its session is gone, so this answers
 *                     "working" for a browser that has been signed out.
 *   candidateSync.js  WriteHuman is verifyMode 'supabase_refresh', so canaryExpected is true and a
 *                     routine push records canaryProven:false / canaryState:'absent'.
 *   agentSync.js      the reply did not forward those fields at all.
 *
 * So the premise was satisfiable with evidence fully consistent with the submission having FAILED -
 * in precisely the scenario the halt exists for. These tests pin the corrected contract instead:
 *
 *   Part C  producer -> route -> reply, driven through the REAL Express router and the REAL
 *           candidateSync, with only the provider boundary stubbed. The PROMOTED reply is produced
 *           by the server, never hand-built, so the proof under test is never assumed.
 *   Part B  the agent's real resolution path (resolveHaltOnStatedProof), against a real
 *           state file - not a source-pattern assertion.
 *
 * Nothing here requires Chrome, a network, a credential or a database.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('crypto');
const http = require('http');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

// ─────────────────────────── backend harness (route + producer) ───────────────────────────
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

// The ONLY stub, and it mirrors verify.js exactly: with `canary` it is a real /auth/v1/user answer
// carrying canary:'passed'; without one it is the local decode, which has no `canary` field at all.
// Everything downstream - candidateSync, the route, the reply shape - is the real code.
const VERIFY_CALLS = [];
// WHY THE INDIRECTION. utils/proxy/verifyAndApply.js does
//     const { verifyAccountCookies } = require('./verify');
// i.e. it DESTRUCTURES at module load. Reassigning the module property later therefore does not
// change what verifyAndApply calls - it keeps the function it captured. Installing one permanent
// stub here that delegates to a swappable `verifyImpl` is what lets a test change the provider's
// behaviour (slow, inconclusive, logged-out) after everything is wired up.
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
const router = require('../routes/proxy/agentSync');

const REF = 'hicfsbrfkzsxbwayibfm';
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

// ──────────────────────────────── Part C - the real contract ────────────────────────────────

test('C1 a ROUTINE promotion is produced from a DECODE: the server states no canary proof', async () => {
  const acct = makeAccount(); ACCOUNTS = [acct];
  VERIFY_CALLS.length = 0;
  const { server, post } = await serve();
  try {
    const r = await post('/api/crm/proxy/agent/writehuman/cookies', { cookies: cookies(9000) });
    assert.equal(r.status, 200);
    assert.equal(r.body.code, deviceSync.CODES.PROMOTED);
    assert.equal(r.body.promoted, true);

    // The producer was asked for NO canary on this routine push.
    assert.equal(VERIFY_CALLS.length, 1);
    assert.ok(!VERIFY_CALLS[0].canary, 'a routine push must not pay for a provider round-trip');

    // THE POINT: the reply is a verified-looking promotion whose proof is absent, and the server
    // now says so instead of leaving the agent to infer authentication from `promoted`.
    assert.ok(r.body.sessionProof, 'the reply must carry the proof record (it previously did not)');
    assert.equal(r.body.sessionProof.canary, null, 'a decode is not a canary');
    assert.notEqual(r.body.sessionProof.canary, 'passed');
  } finally { server.close(); }
});

test('C2 the AUTHORITATIVE canary path records real proof, and the reply forwards it', async () => {
  const acct = makeAccount(); ACCOUNTS = [acct];
  // The existing out-of-request-path verifier - the same call cron/proxyVerifyScheduler.js makes
  // every ~7 min. No second verifier, and nothing new on the push path.
  const applied = await verifyAndApply(acct, 'writehuman', { readOnly: true, canary: true });
  assert.equal(applied.result, 'working');
  assert.equal(acct.verification.canary, 'passed', 'the proof METHOD is now recorded, not just the verdict');

  const { server, post } = await serve();
  try {
    // A heartbeat does not disturb the stored proof; the push reply carries it.
    const r = await post('/api/crm/proxy/agent/writehuman/cookies', { heartbeat: true, report: { authCookies: 2 } });
    assert.equal(r.status, 200);
    assert.equal(acct.verification.canary, 'passed');
  } finally { server.close(); }
});

test('C3 a promotion REPLACES the bundle, so it honestly reports the new bundle as unproven', async () => {
  const acct = makeAccount(); ACCOUNTS = [acct];
  await verifyAndApply(acct, 'writehuman', { readOnly: true, canary: true });
  assert.equal(acct.verification.canary, 'passed');

  const { server, post } = await serve();
  try {
    const r = await post('/api/crm/proxy/agent/writehuman/cookies', { cookies: cookies(9000) });
    assert.equal(r.body.code, deviceSync.CODES.PROMOTED);
    // The canary proved the PREVIOUS bundle. Promotion installs different cookies, so carrying the
    // old 'passed' forward would be a lie about the session now being served.
    assert.equal(acct.verification.canary, null);
    assert.equal(r.body.sessionProof.canary, null);
    assert.equal(r.body.sessionProof.bundleVersion, acct.bundleVersion,
      'the proof record is tied to a candidate revision');
  } finally { server.close(); }
});

// ──────────────────────────── Part B - the agent's real path ────────────────────────────
const AGENT_SRC = path.join(__dirname, '..', '..', 'writehuman-v2', 'agent', 'cookie-sync-agent.js');
const BOX = fs.mkdtempSync(path.join(os.tmpdir(), 'wh-halt-proof-'));
const STATE = path.join(BOX, 'agent-relogin.json');
process.env.WHV2_CONFIG = path.join(BOX, 'config.json');
fs.writeFileSync(process.env.WHV2_CONFIG, JSON.stringify({ reloginEnabled: true }));
process.env.WHV2_RELOGIN = '1';
process.env.WHV2_RELOGIN_STATE = STATE;
process.env.WHV2_LOCK_FILE = path.join(BOX, 'agent.lock');
process.env.WHV2_DEVICE_STATE = path.join(BOX, 'agent-device.json');
process.env.WHV2_STAND_DOWN = path.join(BOX, 'stood-down.json');
const agent = require(AGENT_SRC);
test.after(() => fs.rmSync(BOX, { recursive: true, force: true }));

const INCIDENT = '03cbb77d-2105-49a2-bb09-6366f1141495';
const DEVICE = 'dev-rdp-01';
const HALTED_AT = new Date(Date.now() - 3 * 60000).toISOString();
const ATTEMPTS = [Date.now() - 9 * 60000, Date.now() - 6 * 60000, Date.now() - 3 * 60000];

/** Exactly what finish('submission_outcome_unknown') leaves behind, with nothing pending. */
function halted(extra = {}) {
  fs.writeFileSync(STATE, JSON.stringify({
    attempts: ATTEMPTS.slice(), sessionLimitResets: [],
    lastAttemptAt: new Date(ATTEMPTS[2]).toISOString(),
    lastOutcome: 'submission_outcome_unknown',
    haltedReason: 'submission_outcome_unknown', haltedAt: HALTED_AT,
    captchaHaltPreSubmit: false,
    pendingVerification: false, verificationStartedAt: null,
    incident: { id: INCIDENT, stage: 'MANUAL_ACTION', credentialSubmitted: true, closed: false },
    ...extra,
  }, null, 2));
}
/** The in-memory state of a process that did NOT run the submission: no pending recovery. */
const liveState = () => ({ isActiveSource: true, deviceId: DEVICE, reloginPending: false });

/** A server reply, with the proof record the server would have stated. */
function reply(proof, over = {}) {
  return Object.assign({
    ok: true, code: 'PROMOTED', promoted: true, isActiveSource: true, standDown: false,
    bundleVersion: 7, activeSource: { deviceId: DEVICE, name: 'RDP-01', bundleVersion: 7 },
    sessionProof: proof === undefined ? undefined : proof,
  }, over);
}
// The shape sessionProofView actually serializes. C7 pins this against the real route so the
// fixture cannot drift away from the server's contract.
const provenNow = (over = {}) => Object.assign({
  canary: 'passed', result: 'working', checkedAt: new Date().toISOString(),
  maskedId: 'op***@example.com',
  subjectBundleVersion: 7, subjectSourceDeviceId: DEVICE,
  bundleVersion: 7, sourceDeviceId: DEVICE, stale: false,
}, over);

/** The halt is intact: not just haltedReason, but the whole protective shape. */
function assertStillHalted(why) {
  const s = agent.readReloginState();
  assert.equal(s.haltedReason, 'submission_outcome_unknown', why + ' (haltedReason)');
  assert.ok(s.haltedAt, why + ' (haltedAt kept)');
  assert.equal(s.incident.closed, false, why + ' (incident still open)');
  assert.equal(s.incident.stage, 'MANUAL_ACTION', why + ' (stage unchanged)');
  assert.equal(s.incident.credentialSubmitted, true, why + ' (submission still on record)');
  assert.ok(!s.lastSubmissionResolvedAt, why + ' (no resolution recorded)');
  assert.ok(!s.incident.resolvedBy, why + ' (no resolution provenance)');
  // And the gate still refuses, which is the operational property that actually matters.
  assert.match(agent.reloginReport().activeBlock || '', /submission_outcome_unknown/, why + ' (gate)');
}

test('B1 an UNPROVEN routine PROMOTED does not clear the halt', () => {
  halted();
  const resolved = agent.resolveHaltOnStatedProof(
    liveState(), reply(provenNow({ canary: null })), INCIDENT, HALTED_AT);
  assert.equal(resolved, false);
  assertStillHalted('a decode-backed promotion is not authentication proof');
});

test('B2 no proof record at all (an older backend) does not clear the halt', () => {
  halted();
  assert.equal(agent.resolveHaltOnStatedProof(liveState(), reply(undefined), INCIDENT, HALTED_AT), false);
  assertStillHalted('an unstated proof is not a proof');
  assert.equal(agent.evaluateAuthProof(reply(undefined), liveState(), agent.readReloginState()).why, 'proof_not_exposed');
});

test('B3 FRESH, CORRELATED proof resolves the halt - and records it honestly', () => {
  halted();
  const resolved = agent.resolveHaltOnStatedProof(liveState(), reply(provenNow()), INCIDENT, HALTED_AT);
  assert.equal(resolved, true);
  const s = agent.readReloginState();
  assert.equal(s.haltedReason, null, 'the halt it answers is cleared');
  assert.equal(s.haltedAt, null);
  assert.equal(s.incident.closed, true);
  // HONESTY: current authentication is proven; the original submission's outcome stays unknown.
  assert.equal(s.lastSubmissionOutcome, 'unknown_resolved_by_current_auth_proof');
  assert.equal(s.incident.submissionOutcome, 'unknown');
  assert.equal(s.incident.resolvedBy, 'current_auth_proof');
  assert.ok(s.incident.authProofAt, 'the proof is dated');
  assert.equal(s.incident.credentialSubmitted, true, 'the attempt history is never rewritten');
  // Budgets survive: the first thing after resolution is an ordinary time-bounded block, not a
  // free extra password attempt.
  assert.equal(s.attempts.length, ATTEMPTS.length, 'the attempt budget is preserved');
  assert.match(agent.reloginReport().activeBlock || '', /cooldown|budget_exhausted/);
});

test('B4 a carrier is never proof - but a heartbeat MAY carry proof that already exists', () => {
  // THE DISTINCTION. A HEARTBEAT/UNCHANGED reply proves nothing by itself: there is no canary in
  // it. But the authoritative canary is produced by the scheduler BETWEEN pushes, and a promotion
  // is precisely the reply that cannot carry it (a new bundle starts unproven). So the carrier is
  // allowed to be any authorised reply, and the proof is always the server's bound canary.

  // (a) the carrier ALONE - no proof record, or an unproven one - never resolves anything.
  for (const over of [
    { code: 'HEARTBEAT', heartbeat: true, promoted: false },
    { code: 'OK', promoted: false },
    { code: 'COOKIE_BUNDLE_UNCHANGED', promoted: false },
    { code: 'STANDBY_ROUTINE_REFRESH', promoted: false, standby: true },
    { code: 'VERIFICATION_INCONCLUSIVE', promoted: false },
    { code: 'PROMOTED', promoted: true },
  ]) {
    halted();
    assert.equal(agent.resolveHaltOnStatedProof(liveState(), reply(undefined, over), INCIDENT, HALTED_AT),
      false, 'no proof record on ' + over.code);
    assertStillHalted('no proof on ' + over.code);
    halted();
    assert.equal(agent.resolveHaltOnStatedProof(liveState(), reply(provenNow({ canary: null }), over), INCIDENT, HALTED_AT),
      false, 'unproven record on ' + over.code);
    assertStillHalted('unproven proof on ' + over.code);
  }

  // (b) a HEARTBEAT carrying a bound, fresh, correlated canary DOES resolve it - which is the only
  // way scheduler-produced proof can arrive without a new activation or another password login.
  halted();
  assert.equal(agent.resolveHaltOnStatedProof(
    liveState(), reply(provenNow(), { code: 'HEARTBEAT', heartbeat: true, promoted: false }),
    INCIDENT, HALTED_AT), true, 'a heartbeat may DELIVER proof');
  assert.equal(agent.readReloginState().haltedReason, null);
  assert.equal(agent.readReloginState().incident.resolvedBy, 'current_auth_proof');

  // (c) authority still governs, however good the attached proof looks.
  for (const over of [
    { code: 'HEARTBEAT', standDown: true },
    { code: 'HEARTBEAT', isActiveSource: false },
    { code: 'PROMOTED', promoted: true, standDown: true },
    { code: 'PROMOTED', promoted: true, isActiveSource: false },
  ]) {
    halted();
    assert.equal(agent.resolveHaltOnStatedProof(liveState(), reply(provenNow(), over), INCIDENT, HALTED_AT),
      false, 'authority must govern: ' + JSON.stringify(over));
    assertStillHalted('authority ' + JSON.stringify(over));
  }

  // (d) a transport failure or a rejected reply is not a quiet success.
  for (const bad of [{ _err: 'timeout' }, { _status: 503 }, null, undefined]) {
    halted();
    assert.equal(agent.resolveHaltOnStatedProof(liveState(), bad, INCIDENT, HALTED_AT), false);
    assertStillHalted('bad reply ' + JSON.stringify(bad));
  }
});

test('B5 stale-subject, stale, undated, pre-halt, wrong-source and wrong-revision are refused', () => {
  const cases = [
    // THE RELABELLING CASE: the server itself says the verdict no longer describes what is served.
    ['proof_stale_subject', provenNow({ stale: true })],
    // A record with no subject at all is pre-correction data; the server marks it stale.
    ['proof_stale_subject', provenNow({ stale: true, subjectBundleVersion: null, subjectSourceDeviceId: null })],
    ['proof_stale', provenNow({ checkedAt: new Date(Date.now() - 60 * 60000).toISOString() })],
    ['proof_undated', provenNow({ checkedAt: 'not-a-date' })],
    ['proof_undated', provenNow({ checkedAt: null })],
    ['proof_predates_halt', provenNow({ checkedAt: new Date(Date.parse(HALTED_AT) - 60000).toISOString() })],
    ['proof_other_source', provenNow({ sourceDeviceId: 'dev-other', subjectSourceDeviceId: 'dev-other' })],
    ['proof_other_source', provenNow({ subjectSourceDeviceId: 'dev-other' })],
    // The subject's revision and the served revision disagree.
    ['proof_other_revision', provenNow({ subjectBundleVersion: 6 })],
    ['proof_failed', provenNow({ canary: 'failed' })],
    ['proof_inconclusive', provenNow({ canary: 'inconclusive' })],
    ['proof_absent', provenNow({ canary: null })],
  ];
  for (const [why, proof] of cases) {
    halted();
    const verdict = agent.evaluateAuthProof(reply(proof), liveState(), agent.readReloginState());
    assert.equal(verdict.ok, false, why + ' must not pass');
    assert.equal(verdict.why, why, 'reason for ' + JSON.stringify(proof).slice(0, 70));
    assert.equal(agent.resolveHaltOnStatedProof(liveState(), reply(proof), INCIDENT, HALTED_AT), false);
    assertStillHalted(why);
  }
  // The reply's own revision disagreeing with the proof is refused too.
  halted();
  assert.equal(agent.resolveHaltOnStatedProof(
    liveState(), reply(provenNow(), { bundleVersion: 9 }), INCIDENT, HALTED_AT), false);
  assertStillHalted('reply revision disagrees with the proof');
});

test('B6 a DELAYED reply cannot close a newer incident, nor act after the halt changed', () => {
  // The reply was in flight while recovery moved on and opened a new incident.
  halted({ incident: { id: '11111111-2222-4333-8444-555555555555', stage: 'MANUAL_ACTION', credentialSubmitted: true, closed: false } });
  assert.equal(agent.resolveHaltOnStatedProof(liveState(), reply(provenNow()), INCIDENT, HALTED_AT), false);
  let s = agent.readReloginState();
  assert.equal(s.incident.id, '11111111-2222-4333-8444-555555555555');
  assert.equal(s.incident.closed, false, 'a stale reply must not close a newer incident');
  assert.equal(s.haltedReason, 'submission_outcome_unknown');

  // Same incident, but it was re-halted after the request left.
  halted({ haltedAt: new Date().toISOString() });
  assert.equal(agent.resolveHaltOnStatedProof(liveState(), reply(provenNow()), INCIDENT, HALTED_AT), false);
  assertStillHalted('the halt was rewritten while the reply was in flight');
});

test('B7 every OTHER halt survives proven authentication, with its review intact', () => {
  for (const reason of ['wrong_credentials', 'wrong_account', 'captcha_required', 'mfa_required',
    'rate_limited', 'account_restricted', 'session_limit_reset_failed',
    'session_limit_after_reset', 'session_limit_live_authorization_required']) {
    halted({
      haltedReason: reason, lastOutcome: reason,
      incident: { id: INCIDENT, stage: 'MANUAL_ACTION', credentialSubmitted: true, closed: false },
    });
    assert.equal(agent.resolveHaltOnStatedProof(liveState(), reply(provenNow()), INCIDENT, HALTED_AT),
      false, reason + ' must not be resolved by a session proof');
    const s = agent.readReloginState();
    assert.equal(s.haltedReason, reason, reason + ' survives');
    assert.equal(s.incident.closed, false, reason + ': incident stays open');
    assert.equal(s.incident.stage, 'MANUAL_ACTION', reason + ': stage unchanged');
    assert.ok(!s.incident.resolvedBy, reason + ': no resolution claimed');
    assert.ok(!s.lastSubmissionResolvedAt, reason + ': nothing recorded as resolved');
    // manual review is still demanded
    assert.match(agent.reloginReport().activeBlock || '', new RegExp(reason), reason + ': gate still refuses');
  }
  // An unreadable state file stays a sentinel rather than something a proof repairs.
  fs.writeFileSync(STATE, '{ not json');
  assert.equal(agent.resolveHaltOnStatedProof(liveState(), reply(provenNow()), INCIDENT, HALTED_AT), false);
  assert.equal(agent.readReloginState().haltedReason, 'state_unreadable');
});

test('B8 a durable-write failure cannot leave a falsely recovered in-memory state', () => {
  halted();
  // The state file stays perfectly READABLE - the halt is seen, the proof is accepted - but the
  // durable write cannot land. writeReloginState writes atomically via `<state>.<pid>.tmp` and
  // renames, so occupying that exact path with a directory fails the write and nothing else.
  const temp = STATE + '.' + process.pid + '.tmp';
  fs.mkdirSync(temp, { recursive: true });
  const state = liveState();
  try {
    const resolved = agent.resolveHaltOnStatedProof(state, reply(provenNow()), INCIDENT, HALTED_AT);
    assert.equal(resolved, false, 'an unpersisted resolution is not a resolution');
    // On disk the halt MUST still be there: an in-memory-only recovery is the dangerous state.
    const onDisk = JSON.parse(fs.readFileSync(STATE, 'utf8'));
    assert.equal(onDisk.haltedReason, 'submission_outcome_unknown', 'the halt survives a failed write');
    assert.equal(onDisk.incident.closed, false);
    // And the process carries the pending-write sentinel, so the eligibility gate keeps refusing
    // with relogin_state_unwritable rather than proceeding as if recovered.
    assert.ok(state.recoveryVerdictToPersist, 'the unwritten verdict is retained, not dropped');
    assert.equal(state.recoveryVerdictToPersist.verdict, 'confirmed');
    assert.match(agent.reloginReport().activeBlock || '', /submission_outcome_unknown/);
  } finally {
    fs.rmSync(temp, { recursive: true, force: true });
  }
});

test('B9 after a RESTART the resolved state keeps its history, budget and eligibility', () => {
  halted();
  assert.equal(agent.resolveHaltOnStatedProof(liveState(), reply(provenNow()), INCIDENT, HALTED_AT), true);

  // A restart reads only the file. Nothing in memory carries over.
  const onDisk = JSON.parse(fs.readFileSync(STATE, 'utf8'));
  assert.equal(onDisk.haltedReason, null, 'the resolution is durable, not in-memory');
  assert.equal(onDisk.incident.credentialSubmitted, true, 'the submission stays on the record');
  assert.equal(onDisk.incident.resolvedBy, 'current_auth_proof');
  assert.equal(onDisk.incident.submissionOutcome, 'unknown', 'never upgraded to a success');
  assert.equal(onDisk.attempts.length, ATTEMPTS.length, 'the budget is not reset');
  assert.ok(onDisk.lastAuthProofAt, 'the proof timestamp survives the restart');
  // Re-running the same reply after the halt is gone changes nothing further.
  assert.equal(agent.resolveHaltOnStatedProof(liveState(), reply(provenNow()), INCIDENT, HALTED_AT), false);
  assert.equal(JSON.parse(fs.readFileSync(STATE, 'utf8')).attempts.length, ATTEMPTS.length);
});

// ═══════════════════ Part D — producer → persistence → route → consumer, for real ═══════════════
//
// Part C proves the contract shape and Part B the agent's decisions. Part D runs the sequences that
// only appear when both halves move at once: a verification that lands late, ordinary sync starving
// the authoritative check, the complete recovery path, and the mixed-version matrix.
const scheduler = require('../cron/proxyVerifyScheduler');
const verifyMod = require('../utils/proxy/verify');
const CANARY_OK = {
  result: 'working', httpStatus: 200, finalPath: '/auth/v1/user',
  maskedId: 'op***@example.com', canary: 'passed', accountKey: 'acct-key-1',
};
/** A state object whose device identity is the one the server actually recorded. */
const asSource = (acct) => ({
  isActiveSource: true, reloginPending: false,
  deviceId: (acct.activeSource && acct.activeSource.deviceId) || null,
});

test('D1 a verification of bundle A landing LATE cannot authenticate bundle B', async () => {
  const acct = makeAccount(); ACCOUNTS = [acct];
  await verifyAndApply(acct, 'writehuman', { readOnly: true, canary: true });
  assert.equal(acct.verification.canary, 'passed');
  const bundleA = acct.bundleVersion || 0;
  const hashA = acct.cookieHash || null;
  assert.equal(acct.verification.subject.bundleVersion, bundleA);

  // Start a verification that will not return until we let it.
  let release;
  const gate = new Promise((r) => { release = r; });
  verifyImpl = async () => { await gate; return CANARY_OK; };
  const late = verifyAndApply(acct, 'writehuman', { readOnly: true, canary: true });
  verifyImpl = DEFAULT_VERIFY;                   // only affects calls made from here on

  const { server, post } = await serve();
  try {
    // While A is in flight, a push promotes a DIFFERENT bundle.
    const r = await post('/api/crm/proxy/agent/writehuman/cookies', { cookies: cookies(9000) });
    assert.equal(r.body.code, deviceSync.CODES.PROMOTED);
    assert.notEqual(acct.bundleVersion, bundleA, 'bundle B is now what is served');
    assert.notEqual(acct.cookieHash, hashA);
    assert.equal(acct.verification.canary, null, 'B starts unproven - it inherits nothing from A');

    // Now A lands. This is the relabelling attempt.
    release();
    const res = await late;
    assert.equal(res.result, 'stale_subject', 'the verdict about A is dropped, not applied to B');
    assert.equal(res.stale, true);
    assert.equal(acct.verification.canary, null, 'A did not mark B as provably authenticated');
    assert.equal(acct.verification.subject.bundleVersion, acct.bundleVersion,
      'and did not rewrite the subject recorded for B');

    // The serialized proof must not claim B is proven either.
    const hb = await post('/api/crm/proxy/agent/writehuman/cookies', { heartbeat: true });
    assert.notEqual(hb.body.sessionProof.canary, 'passed');
    // And the agent refuses it.
    halted();
    assert.equal(agent.resolveHaltOnStatedProof(asSource(acct), hb.body, INCIDENT, HALTED_AT), false);
    assertStillHalted('a late verdict about a previous bundle');
  } finally { server.close(); }
});

test('D1b a late verdict cannot DOWNGRADE the bundle that replaced its subject', async () => {
  const acct = makeAccount(); ACCOUNTS = [acct];
  let release;
  const gate = new Promise((r) => { release = r; });
  // The late answer is a hard negative about the OLD bundle.
  verifyImpl = async () => {
    await gate;
    return { result: 'session_expired', httpStatus: 200, finalPath: '/auth/v1/user', loggedOut: true, maskedId: null, canary: 'failed' };
  };
  const late = verifyAndApply(acct, 'writehuman', { readOnly: true, canary: true });
  verifyImpl = DEFAULT_VERIFY;

  const { server, post } = await serve();
  try {
    await post('/api/crm/proxy/agent/writehuman/cookies', { cookies: cookies(9000) });
    assert.equal(acct.session_status, 'working');
    release();
    assert.equal((await late).result, 'stale_subject');
    // A dead session is a fact about the bundle that is gone. It must not expire its replacement,
    // nor invent an expiry for a working one.
    assert.equal(acct.session_status, 'working', 'the newer working bundle is untouched');
    assert.notEqual(acct.status, 'session_expired');
  } finally { server.close(); }
});

test('D2 repeated routine promotions cannot starve the authoritative check', async () => {
  const acct = makeAccount(); ACCOUNTS = [acct];
  await scheduler.verifyOne('writehuman');
  assert.equal(acct.verification.canary, 'passed', 'the scheduler produces real proof');
  const proofClock = acct.lastCanaryAt;
  assert.ok(proofClock, 'and stamps the authoritative clock');

  const { server, post } = await serve();
  try {
    // Ordinary sync, repeatedly, inside what would be successive scheduler windows. Each promotion
    // records a verification (a decode) and so refreshes lastVerifiedAt - the old stale gate's only
    // input, which is exactly how the schedule was starved.
    for (let i = 0; i < 3; i++) {
      const r = await post('/api/crm/proxy/agent/writehuman/cookies', { cookies: cookies(9000 + i * 500) });
      assert.equal(r.body.code, deviceSync.CODES.PROMOTED, 'ordinary sync still works, push ' + i);
      assert.equal(acct.verification.canary, null, 'each new bundle starts unproven');
    }
    assert.equal(String(acct.lastCanaryAt), String(proofClock),
      'a decode-backed promotion must NEVER advance the authoritative proof clock');
    assert.ok(new Date(acct.lastVerifiedAt).getTime() >= new Date(proofClock).getTime(),
      'while lastVerifiedAt IS refreshed - the starvation condition, now harmless');

    // THE STARVATION CONDITION ITSELF, deterministically: the authoritative proof is older than the
    // stale window while lastVerifiedAt is seconds old. The old gate read only lastVerifiedAt and
    // skipped here - for as long as ordinary sync kept landing. Time is advanced by ageing the
    // stored clock rather than by sleeping, so this is exact and fast.
    const aged = new Date(Date.now() - 11 * 60_000);
    acct.lastCanaryAt = aged;
    acct.lastVerifiedAt = new Date();            // ordinary sync, just now
    const callsBefore = VERIFY_CALLS.length;
    await scheduler.verifyOne('writehuman');
    assert.ok(VERIFY_CALLS.length > callsBefore, 'the authoritative check must not be skipped');
    assert.equal(VERIFY_CALLS[VERIFY_CALLS.length - 1].canary, true, 'and it must be the real canary');
    assert.equal(acct.verification.canary, 'passed', 'the authoritative check still ran');
    assert.equal(acct.verification.subject.bundleVersion, acct.bundleVersion,
      'and it proved the bundle actually being served');
    assert.ok(new Date(acct.lastCanaryAt).getTime() > aged.getTime(), 'the proof clock advanced');

    // A GENUINELY FRESH proof is still not re-checked: the cadence stays bounded, with no busy
    // polling and no extra provider call per request.
    const fresh = VERIFY_CALLS.length;
    await scheduler.verifyOne('writehuman');
    assert.equal(VERIFY_CALLS.length, fresh, 'a fresh authoritative proof is not re-verified');

    // ...but a NEW bundle is never allowed to inherit it: the subject moved, so the next tick
    // checks rather than waiting out the window.
    await post('/api/crm/proxy/agent/writehuman/cookies', { cookies: cookies(12345) });
    assert.equal(acct.verification.canary, null, 'the new bundle starts unproven');
    const afterPush = VERIFY_CALLS.length;
    await scheduler.verifyOne('writehuman');
    assert.ok(VERIFY_CALLS.length > afterPush, 'a moved subject forces a fresh authoritative check');
    assert.equal(acct.verification.canary, 'passed');
    assert.equal(acct.verification.subject.bundleVersion, acct.bundleVersion);
  } finally { server.close(); }
});

test('D2b an inconclusive canary neither proves, expires, nor fakes freshness', async () => {
  const acct = makeAccount(); ACCOUNTS = [acct];
  const { server, post } = await serve();
  try {
    // Establish this device as the approved active source first, so the heartbeat below is
    // authoritative for it and the refusal under test is about the PROOF, not about authority.
    await post('/api/crm/proxy/agent/writehuman/cookies', { cookies: cookies(9000) });
    assert.ok(acct.activeSource && acct.activeSource.deviceId);

    verifyImpl = async () => ({
      result: 'working', httpStatus: 200, finalPath: '/auth (jwt)', maskedId: 'op***@example.com', canary: 'inconclusive',
    });
    await scheduler.verifyOne('writehuman');
    assert.equal(acct.verification.canary, 'inconclusive');
    assert.ok(!acct.lastCanaryAt, 'an inconclusive check does not stamp the proof clock');
    assert.equal(acct.session_status, 'working', 'nor does our own network trouble expire the bundle');
    {
      const hb = await post('/api/crm/proxy/agent/writehuman/cookies', { heartbeat: true });
      assert.equal(hb.body.sessionProof.canary, 'inconclusive');
      halted();
      const v = agent.evaluateAuthProof(hb.body, asSource(acct), agent.readReloginState());
      assert.equal(v.ok, false);
      assert.equal(v.why, 'proof_inconclusive', 'unresolved, and honestly so');
      assertStillHalted('inconclusive proof');
    }
  } finally { verifyImpl = DEFAULT_VERIFY; server.close(); }
});

test('D3 THE ORDINARY SEQUENCE: push without proof -> scheduler proves -> heartbeat delivers -> resolved', async () => {
  const acct = makeAccount(); ACCOUNTS = [acct];
  halted();                                    // the real 3.5.15 dead end
  const { server, post } = await serve();
  try {
    // 1. routine push: accepted and promoted, with NO authentication proof.
    const push = await post('/api/crm/proxy/agent/writehuman/cookies', { cookies: cookies(9000) });
    assert.equal(push.body.code, deviceSync.CODES.PROMOTED);
    assert.equal(push.body.sessionProof.canary, null);
    assert.equal(agent.resolveHaltOnStatedProof(asSource(acct), push.body, INCIDENT, HALTED_AT), false);
    assertStillHalted('a routine push is not proof');

    // 2. the EXISTING scheduler verifies that very bundle, out of the request path.
    await scheduler.verifyOne('writehuman');
    assert.equal(acct.verification.canary, 'passed');
    assert.equal(acct.verification.subject.bundleVersion, acct.bundleVersion);

    // 3. the EXISTING heartbeat conveys it. No activation, no cookie mutation, no password login,
    //    and no provider request on this path.
    const hb = await post('/api/crm/proxy/agent/writehuman/cookies', { heartbeat: true, report: { authCookies: 2 } });
    assert.equal(hb.body.code, 'HEARTBEAT');
    assert.equal(hb.body.sessionProof.canary, 'passed');
    assert.equal(hb.body.sessionProof.stale, false);
    assert.equal(hb.body.sessionProof.subjectBundleVersion, hb.body.sessionProof.bundleVersion);

    // 4. the agent resolves the matching uncertain incident.
    assert.equal(agent.resolveHaltOnStatedProof(asSource(acct), hb.body, INCIDENT, HALTED_AT), true);
    const s = agent.readReloginState();
    assert.equal(s.haltedReason, null);
    assert.equal(s.incident.closed, true);
    assert.equal(s.incident.resolvedBy, 'current_auth_proof');
    assert.equal(s.incident.submissionOutcome, 'unknown', 'the submission outcome stays unknown');
    assert.equal(s.incident.credentialSubmitted, true, 'no password was submitted to achieve this');
    assert.equal(s.attempts.length, ATTEMPTS.length, 'the retry budget is untouched');
    const rep = agent.reloginReport();
    assert.equal(rep.manualRequired, false);
    assert.equal(rep.haltedReason, null);
  } finally { server.close(); }
});

test('D4 MIXED VERSIONS: old agent + new backend, new agent + old backend', async () => {
  const acct = makeAccount(); ACCOUNTS = [acct];
  const { server, post } = await serve();
  try {
    // (a) OLD AGENT + NEW BACKEND. The reply must remain a strict SUPERSET: every field an older
    // agent reads is still present with the same meaning, so its ordinary sync is unaffected and it
    // simply ignores sessionProof.
    const push = await post('/api/crm/proxy/agent/writehuman/cookies', { cookies: cookies(9000) });
    for (const k of ['ok', 'code', 'changed', 'promoted', 'standby', 'bundleVersion', 'activeSource',
      'command', 'rotateTokenIn', 'isActiveSource', 'deviceState', 'standDown']) {
      assert.ok(k in push.body, 'the reply must still carry ' + k + ' for an older agent');
    }
    assert.equal(push.body.code, deviceSync.CODES.PROMOTED);
    assert.equal(push.body.promoted, true);
    const hb = await post('/api/crm/proxy/agent/writehuman/cookies', { heartbeat: true });
    for (const k of ['ok', 'code', 'heartbeat', 'changed', 'activeSource', 'isActiveSource']) {
      assert.ok(k in hb.body, 'the heartbeat must still carry ' + k);
    }
    assert.equal(hb.body.code, 'HEARTBEAT');

    // (b) NEW AGENT + OLD BACKEND. An old backend sends no sessionProof at all. The new agent must
    // fail SAFE: the halt stands, and it must not loop on login or demand an update.
    const oldBackendPush = {
      ok: true, code: 'PROMOTED', promoted: true, changed: true, standby: false,
      bundleVersion: 7, activeSource: { deviceId: asSource(acct).deviceId },
      isActiveSource: true, standDown: false,
    };
    halted();
    const st = asSource(acct);
    assert.equal(agent.resolveHaltOnStatedProof(st, oldBackendPush, INCIDENT, HALTED_AT), false);
    assert.equal(agent.evaluateAuthProof(oldBackendPush, st, agent.readReloginState()).why, 'proof_not_exposed');
    assertStillHalted('an old backend exposes no proof');
    // No pending verification was invented, and nothing asked for a credential.
    const s = agent.readReloginState();
    assert.equal(s.pendingVerification, false, 'no verification is left pending');
    assert.equal(s.attempts.length, ATTEMPTS.length, 'no attempt was consumed');
    assert.equal(s.incident.credentialSubmitted, true);
    assert.ok(!s.incident.resolvedBy);
    // Repeating it is idempotent - no loop, no drift.
    for (let i = 0; i < 3; i++) {
      assert.equal(agent.resolveHaltOnStatedProof(st, oldBackendPush, INCIDENT, HALTED_AT), false);
    }
    assert.equal(agent.readReloginState().attempts.length, ATTEMPTS.length);
  } finally { server.close(); }
});

test('D5 the EXACT saved 3.5.15 state shape resolves, and zero attempts never bypasses the halt', () => {
  // The affected installation, as its own diagnostic reported it at 2026-10-22T04:23:28Z: halted
  // since 2026-10-20T16:37:22.017Z, nothing pending, and ZERO attempts in the window. The file
  // predates this correction, so it carries NONE of the new provenance fields.
  const HALT_REAL = '2026-10-20T16:37:22.017Z';
  fs.writeFileSync(STATE, JSON.stringify({
    attempts: [], sessionLimitResets: [],
    lastAttemptAt: HALT_REAL,
    lastOutcome: 'submission_outcome_unknown',
    haltedReason: 'submission_outcome_unknown', haltedAt: HALT_REAL,
    captchaHaltPreSubmit: false,
    pendingVerification: false, verificationStartedAt: null,
    incident: {
      id: INCIDENT, stage: 'MANUAL_ACTION', reason: 'auth_cookie_absent',
      startedAt: HALT_REAL, credentialSubmitted: true, closed: false,
    },
  }, null, 2));

  // An empty attempt window is NOT permission to bypass a halt.
  let rep = agent.reloginReport();
  assert.equal(rep.attemptsInWindow, 0);
  assert.equal(rep.activeBlock, 'submission_outcome_unknown');
  assert.equal(rep.manualRequired, true);
  assert.equal(rep.retryEligible, false);
  assert.equal(rep.nextRetryAt, null);

  // Missing provenance fields must not fabricate approval...
  const held = agent.readReloginState();
  assert.ok(!held.incident.resolvedBy);
  assert.equal(agent.resolveHaltOnStatedProof(liveState(), reply(provenNow({ canary: null })), INCIDENT, HALT_REAL), false);
  assert.equal(agent.readReloginState().haltedReason, 'submission_outcome_unknown');

  // ...nor make an existing installation permanently unresolvable.
  assert.equal(agent.resolveHaltOnStatedProof(liveState(), reply(provenNow()), INCIDENT, HALT_REAL), true);
  const s = agent.readReloginState();
  assert.equal(s.haltedReason, null);
  assert.equal(s.incident.resolvedBy, 'current_auth_proof');
  assert.equal(s.incident.submissionOutcome, 'unknown');
  assert.equal(s.incident.credentialSubmitted, true);

  // With the window genuinely empty the policy now governs again - 3 per rolling hour, 20 min
  // cooldown - rather than a permanent manual halt.
  rep = agent.reloginReport();
  assert.equal(rep.manualRequired, false);
  assert.equal(rep.retryEligible, true);
  assert.equal(rep.attemptsInWindow, 0);
  assert.equal(rep.maxAttempts, 3);
  assert.equal(rep.windowMs, 3600000);
  assert.equal(rep.cooldownMs, 1200000);
});
