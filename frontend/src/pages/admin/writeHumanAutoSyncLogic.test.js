import { verification, deriveControls } from './writeHumanAutoSyncLogic';

describe('writeHuman auto-sync — verification verdict (server-canary only)', () => {
  test('Verified ONLY on canary passed + a verified/synced stage', () => {
    expect(verification({ lastCanary: 'passed', stage: 'wouldSync' }).label).toBe('Verified');
    expect(verification({ lastCanary: 'passed', stage: 'synced' }).label).toBe('Verified');
  });
  test('local-JWT / canary-inconclusive "working" is NOT Verified', () => {
    expect(verification({ lastResult: 'verification_inconclusive', inconclusiveReason: 'canary_inconclusive' }).label).toBe('Inconclusive');
    expect(verification({ stage: 'verification_inconclusive', lastResult: 'verification_inconclusive' }).label).toBe('Inconclusive');
  });
  test('real auth failure is Failed; nothing is Verified from connectivity/empty status', () => {
    expect(verification({ lastResult: 'failed', lastError: 'verify_failed:session_expired' }).label).toBe('Failed');
    expect(verification({}).label).toBe('Pending');
    expect(verification({ stage: 'verified' /* but no canary */ }).label).toBe('Pending');
  });
});

describe('writeHuman auto-sync — control gating (authorization safeguards)', () => {
  const verifiedAwaiting = { status: { stage: 'verified', lastCanary: 'passed', awaitingApproval: true, observedAccountKey: 'uid-1' }, eligibleToolIds: ['t1'] };

  test('idle when no eligible tool; enable allowed but nothing else', () => {
    const d = deriveControls({ enabled: false, eligibleToolIds: [] });
    expect(d.idle).toBe(true);
    expect(d.canEnable).toBe(true);
    expect(d.canApprove).toBe(false);
    expect(d.canEnforce).toBe(false);
  });

  test('ambiguity (>1 eligible tool) blocks enable and enforce', () => {
    const d = deriveControls({ enabled: true, approvedAccountKey: 'uid-1', mode: 'observe', eligibleToolIds: ['t1', 't2'], status: { stage: 'verified', lastCanary: 'passed' } });
    expect(d.ambiguous).toBe(true);
    expect(d.canEnable).toBe(false);
    expect(d.canEnforce).toBe(false);
  });

  test('awaiting approval: approve offered, enforce NOT (no trust-on-first)', () => {
    const d = deriveControls(Object.assign({ enabled: true, mode: 'observe' }, verifiedAwaiting));
    expect(d.approvalState).toBe('awaiting');
    expect(d.canApprove).toBe(true);
    expect(d.canEnforce).toBe(false); // not approved yet
  });

  test('enforce allowed ONLY when enabled + approved + Verified + unambiguous', () => {
    const base = { enabled: true, mode: 'observe', approvedAccountKey: 'uid-1', eligibleToolIds: ['t1'] };
    expect(deriveControls(Object.assign({}, base, { status: { stage: 'wouldSync', lastCanary: 'passed' } })).canEnforce).toBe(true);
    // approved but verification inconclusive → enforce blocked
    expect(deriveControls(Object.assign({}, base, { status: { lastResult: 'verification_inconclusive' } })).canEnforce).toBe(false);
    // verified but NOT approved → enforce blocked
    expect(deriveControls({ enabled: true, mode: 'observe', eligibleToolIds: ['t1'], status: { stage: 'wouldSync', lastCanary: 'passed' } }).canEnforce).toBe(false);
    // disabled → enforce blocked
    expect(deriveControls(Object.assign({}, base, { enabled: false, status: { stage: 'wouldSync', lastCanary: 'passed' } })).canEnforce).toBe(false);
  });

  test('approve not offered once already approved; disable always available when enabled', () => {
    const d = deriveControls({ enabled: true, mode: 'enforce', approvedAccountKey: 'uid-1', eligibleToolIds: ['t1'], status: { stage: 'synced', lastCanary: 'passed' } });
    expect(d.canApprove).toBe(false);
    expect(d.approvalState).toBe('approved');
    expect(d.canDisable).toBe(true);
    expect(d.canRevertObserve).toBe(true);
  });
});
