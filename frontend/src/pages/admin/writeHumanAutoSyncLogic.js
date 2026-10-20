// Pure decision logic for the WriteHuman Extension Auto-Sync admin section. Extracted so it can be
// unit-tested without a DOM. NO network, NO React. The security-relevant rule lives here: a status
// is "Verified" ONLY on a server canary-confirmed result — never on connectivity or a stale verify —
// and enforcement/approval controls are gated accordingly.

// Verification verdict derived ONLY from the backend's canary-confirmed result.
export function verification(status) {
  const s = status || {};
  if (s.lastResult === 'failed') return { label: 'Failed', tone: 'red', detail: s.lastError || 'authentication failed' };
  if (s.lastCanary === 'passed' && (s.stage === 'verified' || s.stage === 'wouldSync' || s.stage === 'synced')) {
    return { label: 'Verified', tone: 'emerald', detail: 'provider-authenticated (/auth/v1/user)' };
  }
  if (s.lastResult === 'verification_inconclusive') return { label: 'Inconclusive', tone: 'amber', detail: s.inconclusiveReason || 'cannot confirm right now' };
  return { label: 'Pending', tone: 'slate', detail: 'awaiting first verification' };
}

// Derive the UI/control state from the backend policy. Guards:
//  - ambiguity (>1 eligible tool, with none explicitly bound) blocks ALL activation.
//  - approve is offered ONLY when a provider-authenticated account is awaiting approval and none is
//    approved yet (never auto-approve).
//  - enforce is allowed ONLY when enabled + an account is approved + current verification is Verified.
export function deriveControls(policy) {
  const p = policy || {};
  const s = p.status || {};
  const eligibleToolIds = Array.isArray(p.eligibleToolIds) ? p.eligibleToolIds : [];
  const eligibleCount = eligibleToolIds.length;
  // Two Tools can legitimately be active on the official domain (production, 2026-10-20:
  // "Write Human" with 31 client assignments and "WH" with 7). The backend resolves that with an
  // explicit admin-set `approvedToolId` and reports the REMAINING ambiguity in `p.ambiguous`, so
  // trust that field when the server sent it. Deriving it from the count alone would keep every
  // control disabled forever even once a Tool had been bound — the count stays >1 either way.
  const boundToolId = p.approvedToolId || null;
  const bindingHonoured = !!boundToolId && eligibleToolIds.some((id) => String(id) === String(boundToolId));
  const ambiguous = typeof p.ambiguous === 'boolean'
    ? p.ambiguous
    : (eligibleCount > 1 && !bindingHonoured);
  const idle = eligibleCount === 0;
  const enabled = !!p.enabled;
  const mode = p.mode === 'enforce' ? 'enforce' : 'observe';
  const approved = !!p.approvedAccountKey;
  const awaiting = !!(s.awaitingApproval || s.lastResult === 'awaiting_approval');
  const observedKey = p.observedAccountKey || s.observedAccountKey || null;
  const verified = verification(s).label === 'Verified';

  return {
    eligibleCount, ambiguous, idle, enabled, mode, approved, awaiting, observedKey, verified,
    boundToolId, bindingHonoured,
    eligibleTools: Array.isArray(p.eligibleTools) ? p.eligibleTools : [],
    approvalState: approved ? 'approved' : (awaiting ? 'awaiting' : 'pending'),
    canEnable: !enabled && !ambiguous,
    canDisable: enabled,
    canApprove: enabled && awaiting && !!observedKey && !approved,
    canEnforce: enabled && approved && mode !== 'enforce' && verified && !ambiguous,
    canRevertObserve: enabled && mode === 'enforce',
  };
}
