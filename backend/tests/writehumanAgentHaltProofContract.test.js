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
 *   Part B  the agent's real resolution path (resolveHaltOnVerifiedPromotion), against a real
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
require('../utils/proxy/verify').verifyAccountCookies = async (tool, header, expected, opts) => {
  VERIFY_CALLS.push(Object.assign({}, opts || {}));
  return (opts && opts.canary)
    ? { result: 'working', httpStatus: 200, finalPath: '/auth/v1/user', maskedId: 'op***@example.com', canary: 'passed', accountKey: 'acct-key-1' }
    : { result: 'working', httpStatus: 200, finalPath: '/auth (jwt)', maskedId: 'op***@example.com' };
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
const provenNow = (over = {}) => Object.assign({
  canary: 'passed', result: 'working', checkedAt: new Date().toISOString(),
  maskedId: 'op***@example.com', bundleVersion: 7, sourceDeviceId: DEVICE,
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
  const resolved = agent.resolveHaltOnVerifiedPromotion(
    liveState(), reply(provenNow({ canary: null })), INCIDENT, HALTED_AT);
  assert.equal(resolved, false);
  assertStillHalted('a decode-backed promotion is not authentication proof');
});

test('B2 no proof record at all (an older backend) does not clear the halt', () => {
  halted();
  assert.equal(agent.resolveHaltOnVerifiedPromotion(liveState(), reply(undefined), INCIDENT, HALTED_AT), false);
  assertStillHalted('an unstated proof is not a proof');
  assert.equal(agent.evaluateAuthProof(reply(undefined), liveState(), agent.readReloginState()).why, 'proof_not_exposed');
});

test('B3 FRESH, CORRELATED proof resolves the halt - and records it honestly', () => {
  halted();
  const resolved = agent.resolveHaltOnVerifiedPromotion(liveState(), reply(provenNow()), INCIDENT, HALTED_AT);
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

test('B4 HEARTBEAT, UNCHANGED, STANDBY, inconclusive and transport failure are never proof', () => {
  // Each carries a perfectly good proof record; the reply itself is not a verified promotion.
  for (const over of [
    { code: 'OK', promoted: false },
    { code: 'COOKIE_BUNDLE_UNCHANGED', promoted: false },
    { code: 'STANDBY_ROUTINE_REFRESH', promoted: false, standby: true },
    { code: 'VERIFICATION_INCONCLUSIVE', promoted: false },
    { code: 'PROMOTED', promoted: true, standDown: true },
    { code: 'PROMOTED', promoted: true, isActiveSource: false },
    { code: 'PROMOTED', promoted: false },
  ]) {
    halted();
    assert.equal(
      agent.resolveHaltOnVerifiedPromotion(liveState(), reply(provenNow(), over), INCIDENT, HALTED_AT),
      false, 'must not resolve on ' + JSON.stringify(over));
    assertStillHalted('reply ' + JSON.stringify(over));
  }
  // A transport failure is an absent reply, not a quiet success.
  halted();
  assert.equal(agent.resolveHaltOnVerifiedPromotion(liveState(), { _err: 'timeout' }, INCIDENT, HALTED_AT), false);
  assertStillHalted('transport failure');
  assert.equal(agent.resolveHaltOnVerifiedPromotion(liveState(), null, INCIDENT, HALTED_AT), false);
  assertStillHalted('no reply at all');
});

test('B5 stale, undated, pre-halt, wrong-source and wrong-revision proof are all refused', () => {
  const cases = [
    ['proof_stale', provenNow({ checkedAt: new Date(Date.now() - 60 * 60000).toISOString() })],
    ['proof_undated', provenNow({ checkedAt: 'not-a-date' })],
    ['proof_undated', provenNow({ checkedAt: null })],
    // Proof from BEFORE the outcome became unknown says nothing about the submission.
    ['proof_predates_halt', provenNow({ checkedAt: new Date(Date.parse(HALTED_AT) - 60000).toISOString() })],
    ['proof_other_source', provenNow({ sourceDeviceId: 'dev-other' })],
    ['proof_other_revision', provenNow({ bundleVersion: 6 })],
    ['proof_failed', provenNow({ canary: 'failed' })],
    ['proof_inconclusive', provenNow({ canary: 'inconclusive' })],
    ['proof_absent', provenNow({ canary: null })],
  ];
  for (const [why, proof] of cases) {
    halted();
    const verdict = agent.evaluateAuthProof(reply(proof), liveState(), agent.readReloginState());
    assert.equal(verdict.ok, false, why + ' must not pass');
    assert.equal(verdict.why, why);
    assert.equal(agent.resolveHaltOnVerifiedPromotion(liveState(), reply(proof), INCIDENT, HALTED_AT), false);
    assertStillHalted(why);
  }
  // A reply naming a DIFFERENT active source is refused even when the proof record looks right.
  halted();
  assert.equal(agent.resolveHaltOnVerifiedPromotion(
    liveState(), reply(provenNow(), { activeSource: { deviceId: 'dev-other' } }), INCIDENT, HALTED_AT), false);
  assertStillHalted('another machine holds the session');
});

test('B6 a DELAYED reply cannot close a newer incident, nor act after the halt changed', () => {
  // The reply was in flight while recovery moved on and opened a new incident.
  halted({ incident: { id: '11111111-2222-4333-8444-555555555555', stage: 'MANUAL_ACTION', credentialSubmitted: true, closed: false } });
  assert.equal(agent.resolveHaltOnVerifiedPromotion(liveState(), reply(provenNow()), INCIDENT, HALTED_AT), false);
  let s = agent.readReloginState();
  assert.equal(s.incident.id, '11111111-2222-4333-8444-555555555555');
  assert.equal(s.incident.closed, false, 'a stale reply must not close a newer incident');
  assert.equal(s.haltedReason, 'submission_outcome_unknown');

  // Same incident, but it was re-halted after the request left.
  halted({ haltedAt: new Date().toISOString() });
  assert.equal(agent.resolveHaltOnVerifiedPromotion(liveState(), reply(provenNow()), INCIDENT, HALTED_AT), false);
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
    assert.equal(agent.resolveHaltOnVerifiedPromotion(liveState(), reply(provenNow()), INCIDENT, HALTED_AT),
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
  assert.equal(agent.resolveHaltOnVerifiedPromotion(liveState(), reply(provenNow()), INCIDENT, HALTED_AT), false);
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
    const resolved = agent.resolveHaltOnVerifiedPromotion(state, reply(provenNow()), INCIDENT, HALTED_AT);
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
  assert.equal(agent.resolveHaltOnVerifiedPromotion(liveState(), reply(provenNow()), INCIDENT, HALTED_AT), true);

  // A restart reads only the file. Nothing in memory carries over.
  const onDisk = JSON.parse(fs.readFileSync(STATE, 'utf8'));
  assert.equal(onDisk.haltedReason, null, 'the resolution is durable, not in-memory');
  assert.equal(onDisk.incident.credentialSubmitted, true, 'the submission stays on the record');
  assert.equal(onDisk.incident.resolvedBy, 'current_auth_proof');
  assert.equal(onDisk.incident.submissionOutcome, 'unknown', 'never upgraded to a success');
  assert.equal(onDisk.attempts.length, ATTEMPTS.length, 'the budget is not reset');
  assert.ok(onDisk.lastAuthProofAt, 'the proof timestamp survives the restart');
  // Re-running the same reply after the halt is gone changes nothing further.
  assert.equal(agent.resolveHaltOnVerifiedPromotion(liveState(), reply(provenNow()), INCIDENT, HALTED_AT), false);
  assert.equal(JSON.parse(fs.readFileSync(STATE, 'utf8')).attempts.length, ATTEMPTS.length);
});
