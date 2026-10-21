/**
 * THE RE-LOGIN DEAD END - incident 03cbb77d-2105-49a2-bb09-6366f1141495 (20 Oct 2026).
 *
 * The installed 3.5.15 agent stopped recovering its own WriteHuman login. Its state file held
 *
 *     agent-relogin.json   haltedReason = "submission_outcome_unknown"
 *
 * and from then on every attempt logged `recovery_transition RECOVERY_BLOCKED /
 * halted_submission_outcome_unknown`, for the life of the installation.
 *
 * Writing that halt is CORRECT: a password was submitted and the outcome could not be observed, so
 * the machine must not send another one blindly. What was wrong is that nothing could resolve it.
 *
 *   1. noteReloginVerdict('confirmed') - the backend's PROMOTED verdict on a provider-verified
 *      candidate from this approved active source, i.e. positive proof the submission DID succeed
 *      for the right account - closed the incident but KEPT haltedReason, and the eligibility gate
 *      refuses on haltedReason alone.
 *   2. Even that was unreachable. The push handler records a verdict only inside
 *      `if (state.reloginPending)`, an in-memory flag the terminal finish() had already cleared,
 *      and the durable pendingVerification was written false, so no restart could re-arm it.
 *   3. No supported operator command covered it: --acknowledge-resolved-challenge refuses anything
 *      but captcha_required / mfa_required (security_review_required), the passive revalidation
 *      path is CAPTCHA-only, and --authorize-session-limit-recovery writes config, not state.
 *
 * Group A reproduces that boundary (A2/A4 fail against the shipped 3.5.15 source); group B pins
 * the safety properties the fix must not trade away. No browser, no network, no credential - the
 * recovery state machine only, against a throwaway state file in a temp dir.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const AGENT_SRC = path.join(__dirname, '..', '..', 'writehuman-v2', 'agent', 'cookie-sync-agent.js');
const BOX = fs.mkdtempSync(path.join(os.tmpdir(), 'wh-relogin-halt-'));
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

/** The exact durable shape left behind by finish('submission_outcome_unknown'). */
function haltedAfterUnknownSubmission(extra = {}) {
  fs.writeFileSync(STATE, JSON.stringify({
    attempts: [Date.now() - 9 * 60000, Date.now() - 6 * 60000, Date.now() - 3 * 60000],
    sessionLimitResets: [],
    lastAttemptAt: new Date(Date.now() - 3 * 60000).toISOString(),
    lastOutcome: 'submission_outcome_unknown',
    haltedReason: 'submission_outcome_unknown',
    haltedAt: new Date(Date.now() - 3 * 60000).toISOString(),
    captchaHaltPreSubmit: false,
    pendingVerification: false,
    verificationStartedAt: null,
    incident: { id: INCIDENT, stage: 'MANUAL_ACTION', credentialSubmitted: true, closed: false },
    ...extra,
  }, null, 2));
}

/** A live source that is authorised to recover: every pre-halt gate passes. */
const authorisedSource = () => ({ isActiveSource: true });

// ─────────────────────────────── Group A — the reproducer ────────────────────────────────

test('A1 the halt is reproduced exactly as logged', async () => {
  haltedAfterUnknownSubmission();
  const outcome = await agent.attemptSourceRelogin(authorisedSource(), 'cookies_missing');
  assert.equal(outcome, 'halted_submission_outcome_unknown');
});

test('A2 a server-CONFIRMED recovery resolves the halt it is the answer to', async () => {
  haltedAfterUnknownSubmission();

  // the same evidence class the push handler calls 'confirmed': the backend PROMOTED a verified
  // candidate from this approved active source, i.e. the submission's outcome is no longer unknown
  assert.equal(agent.noteReloginVerdict('confirmed'), true);

  const after = agent.readReloginState();
  assert.equal(after.lastOutcome, 'confirmed');
  assert.equal(after.incident.closed, true, 'the incident IS closed by confirmation');
  assert.equal(after.incident.stage, 'SYNC_RESUMED');

  // ...and yet the halt survives, so recovery stays blocked for the life of the install
  assert.equal(after.haltedReason, null,
    'a confirmed recovery must clear the submission_outcome_unknown halt it resolved');

  // with the halt resolved, the next block must be an ordinary TIME-BOUNDED one (this fixture has
  // already spent its three hourly attempts) - never a permanent halt_* requiring manual action
  const next = await agent.attemptSourceRelogin(authorisedSource(), 'cookies_missing');
  assert.equal(next, 'budget_exhausted');
  assert.ok(agent.reloginReport().nextRetryAt, 'a recoverable block must publish a retry time');
});

test('A3 no supported operator command can clear this halt', async () => {
  haltedAfterUnknownSubmission();

  // the challenge acknowledgement is the only halt-clearing operator command in this build
  const ack = await agent.acknowledgeResolvedChallenge(true);
  assert.equal(ack.ok, false);
  assert.equal(ack.code, 'security_review_required');

  // the passive revalidation path is CAPTCHA-only
  assert.equal(await agent.recheckStaleCaptchaHalt(authorisedSource()), false);

  // and the session-limit consent command writes config, never state
  assert.equal(agent.readReloginState().haltedReason, 'submission_outcome_unknown');
});

// ───────────────────────── Group B — controls that must not regress ──────────────────────

test('B1 an UNRESOLVED submission still blocks - no confirmation recorded', async () => {
  haltedAfterUnknownSubmission();
  const outcome = await agent.attemptSourceRelogin(authorisedSource(), 'cookies_missing');
  assert.match(outcome, /^halted_submission_outcome_unknown$|^submission_outcome_unknown$/);
});

test('B2 confirmation must NOT erase a halt it does not answer', async () => {
  for (const reason of ['wrong_credentials', 'wrong_account', 'captcha_required', 'mfa_required',
    'rate_limited', 'account_restricted', 'session_limit_requires_manual_reset',
    'session_limit_reset_budget_exhausted', 'session_limit_live_authorization_required',
    'session_limit_control_unverified', 'session_limit_reset_failed', 'session_limit_after_reset']) {
    haltedAfterUnknownSubmission({ haltedReason: reason, lastOutcome: reason });
    agent.noteReloginVerdict('confirmed');
    assert.equal(agent.readReloginState().haltedReason, reason, `${reason} must survive a confirmed verdict`);
    assert.equal(await agent.attemptSourceRelogin(authorisedSource(), 'cookies_missing'), 'halted_' + reason);
  }
});

test('B3 the attempt budget, incident identity and submission record are preserved', async () => {
  haltedAfterUnknownSubmission();
  const before = agent.readReloginState();
  agent.noteReloginVerdict('confirmed');
  const after = agent.readReloginState();
  assert.deepEqual(after.attempts, before.attempts, 'retry budget must not be reset');
  assert.equal(after.incident.id, INCIDENT, 'incident identity must be kept for audit');
  assert.equal(after.incident.credentialSubmitted, true, 'the submission record must never be falsified');
});

test('B4 an unreadable state file is still a sentinel, not something confirmation repairs', async () => {
  fs.writeFileSync(STATE, '{ not json');
  assert.equal(agent.readReloginState().lastOutcome, 'state_unreadable');
  agent.noteReloginVerdict('confirmed');
  assert.equal(agent.readReloginState().lastOutcome, 'state_unreadable');
  assert.equal(await agent.attemptSourceRelogin(authorisedSource(), 'cookies_missing'),
    'halted_state_unreadable');
});

test('A4 the dead end was durable: no saved field could re-arm confirmation after a restart', async () => {
  // one attempt, over an hour ago: the retry budget is clear, so the ONLY thing standing between
  // this install and recovery is the saved halt
  haltedAfterUnknownSubmission({ attempts: [Date.now() - 70 * 60000] });
  const saved = agent.readReloginState();

  // the confirmation branch in the push handler is gated on an IN-MEMORY state.reloginPending,
  // and the terminal finish() cleared it. The only durable flag that could re-arm it on a
  // restart is pendingVerification - which the same finish() wrote as false.
  assert.equal(saved.pendingVerification, false);

  const report = agent.reloginReport();
  assert.equal(report.manualRequired, true);
  assert.equal(report.activeBlock, 'submission_outcome_unknown');
  assert.equal(report.nextRetryAt, null, 'no retry is ever scheduled - this is permanent, not a cooldown');

  // after the fix a verified promotion makes the install eligible again
  agent.noteReloginVerdict('confirmed');
  assert.equal(agent.reloginReport().retryEligible, true);
  assert.equal(agent.reloginReport().manualRequired, false);
});

test('B5 the resolution is applied to the VERIFIED promotion, outside the in-memory pending branch', () => {
  // Fix 1 alone is unreachable: the handler's confirmation branch is gated on state.reloginPending,
  // which the terminal halt already cleared. This pins the reachability contract itself, because
  // the live path needs real Chrome + a real backend promotion and cannot run in a unit test.
  const src = fs.readFileSync(AGENT_SRC, 'utf8');

  const marker = "const verified=r.code==='PROMOTED'&&r.promoted===true&&r.isActiveSource===true&&!r.standDown;";
  assert.ok(src.includes(marker), 'the verified-promotion test must keep all four conditions');

  const pendingBranch = src.search(/if \(state\.reloginPending\) \{\s*state\.reloginPending = true;/);
  const resolver = src.indexOf("if(held.haltedReason==='submission_outcome_unknown')");
  assert.ok(pendingBranch > 0 && resolver > 0);
  assert.ok(resolver > src.indexOf(marker),
    'the resolver must sit on the verified-promotion path, not inside the reloginPending branch');

  const block = src.slice(src.indexOf(marker), resolver + 400);
  assert.match(block, /verified&&!state\.reloginPending/, 'it must apply exactly when the branch above did not');
  assert.match(block, /persistRecoveryVerdict\(state,'confirmed'/, 'it must reuse the existing durable verdict writer');
  assert.ok(!/haltedReason\s*[:=]\s*null/.test(block), 'it must not clear the halt itself - that is noteReloginVerdict’s single writer');
});
