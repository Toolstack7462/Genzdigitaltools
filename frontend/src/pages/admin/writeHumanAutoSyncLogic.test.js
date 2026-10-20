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

  // Two Tools CAN legitimately be active on the official domain (production 2026-10-20:
  // "Write Human" 31 client assignments, "WH" 7). The backend resolves it with an explicit
  // approvedToolId and reports the remaining ambiguity itself; deriving ambiguity from the count
  // alone kept every control disabled forever, because the count stays >1 after binding too.
  test('an honoured Tool binding clears ambiguity even though >1 Tool is eligible', () => {
    const d = deriveControls({
      enabled: true, approvedAccountKey: 'uid-1', mode: 'observe',
      eligibleToolIds: ['t1', 't2'], approvedToolId: 't2', ambiguous: false,
      eligibleTools: [{ id: 't1', name: 'WH' }, { id: 't2', name: 'Write Human' }],
      status: { stage: 'verified', lastCanary: 'passed' },
    });
    expect(d.ambiguous).toBe(false);
    expect(d.bindingHonoured).toBe(true);
    expect(d.boundToolId).toBe('t2');
    expect(d.canEnforce).toBe(true);
  });

  test('a stale binding (not eligible) stays ambiguous and keeps controls locked', () => {
    const d = deriveControls({
      enabled: true, approvedAccountKey: 'uid-1', mode: 'observe',
      eligibleToolIds: ['t1', 't2'], approvedToolId: 'gone', ambiguous: true,
      status: { stage: 'verified', lastCanary: 'passed' },
    });
    expect(d.ambiguous).toBe(true);
    expect(d.bindingHonoured).toBe(false);
    expect(d.canEnforce).toBe(false);
  });

  test('an older backend response without `ambiguous` still falls back to the count', () => {
    const d = deriveControls({ enabled: true, eligibleToolIds: ['t1', 't2'] });
    expect(d.ambiguous).toBe(true);
    expect(d.canEnable).toBe(false);
  });

  // A selected Tool that is no longer eligible is a DIFFERENT state from "several candidates":
  // the engine reports target_unavailable and refuses to write anything, including to a lone
  // survivor. The panel must say so and offer reselection, never suggest deleting a Tool.
  test('a stale binding is reported as stale, and the Tool selector stays available', () => {
    const d = deriveControls({
      enabled: true, mode: 'enforce', approvedAccountKey: 'uid-1',
      eligibleToolIds: ['t-survivor'], approvedToolId: 't-deleted',
      eligibleTools: [{ id: 't-survivor', name: 'Other' }],
      status: { stage: 'synced', lastResult: 'target_unavailable', lastError: 'bound_tool_unavailable' },
    });
    expect(d.bindingStale).toBe(true);
    expect(d.bindingHonoured).toBe(false);
    expect(d.canSelectTool).toBe(true);
  });

  test('the Tool selector is available whenever a choice is meaningful', () => {
    // two candidates, nothing bound yet
    expect(deriveControls({ enabled: true, eligibleToolIds: ['a', 'b'] }).canSelectTool).toBe(true);
    // one candidate, already bound to it -> still offered, so it can be changed or cleared
    expect(deriveControls({ enabled: true, eligibleToolIds: ['a'], approvedToolId: 'a' }).canSelectTool).toBe(true);
    // single candidate, nothing bound -> no choice to make
    expect(deriveControls({ enabled: true, eligibleToolIds: ['a'] }).canSelectTool).toBe(false);
    // nothing eligible at all and nothing bound
    expect(deriveControls({ enabled: true, eligibleToolIds: [] }).canSelectTool).toBe(false);
  });

  test('a stale binding does not read as honoured just because one Tool is left', () => {
    const d = deriveControls({
      enabled: true, eligibleToolIds: ['only-one'], approvedToolId: 'gone', ambiguous: false,
    });
    expect(d.bindingHonoured).toBe(false);
    expect(d.bindingStale).toBe(true);
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
