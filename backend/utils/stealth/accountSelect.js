'use strict';
/**
 * Account selection for NEW StealthWriter leases. Only `active` accounts are
 * eligible — `standby`, `limit_reached`, `session_expired` and `blocked` are never
 * auto-selected. The chosen account id is stored on the lease; existing leases keep
 * their account until expiry or admin revocation.
 *
 * Modes:
 *   manual_primary — use the primary account only; no failover (block if it's down).
 *   auto_failover  — use the primary if active, else the next active by priority
 *                    (DEFAULT — "Manual Primary + Auto Failover").
 *   round_robin    — rotate: least-recently-used active account.
 *   least_used     — active account with the lowest lifetime usage count.
 */
const MODES = ['manual_primary', 'auto_failover', 'round_robin', 'least_used'];

function byPriorityThenIdle(a, b) {
  if (a.priority !== b.priority) return a.priority - b.priority;
  return new Date(a.lastUsedAt || 0).getTime() - new Date(b.lastUsedAt || 0).getTime();
}

function accountHasSessionCookie(a) {
  if (a.sessionMeta && typeof a.sessionMeta.hasSessionCookie === 'boolean') return a.sessionMeta.hasSessionCookie;
  return !!a.sessionEncrypted;
}

// Safe, log-able reason an account is NOT eligible for a new lease (no secrets).
function unavailableReason(a) {
  if (a.status === 'blocked') return 'blocked';
  if (a.status === 'limit_reached') return 'status_limit_reached';
  if (!accountHasSessionCookie(a)) return 'no_session_cookie';
  const ss = a.session_status || 'pending_verification';
  if (ss === 'session_expired') return 'session_expired';
  if (ss === 'cookies_invalid') return 'verify_failed';
  if (!['active', 'standby'].includes(a.status)) return 'status_' + a.status;
  return null; // eligible
}

function isEligible(a) {
  return unavailableReason(a) === null;
}

// Coarse, UI-friendly health for an account (no secrets). One of:
//   working | needs_login | expired | blocked | limit_reached | needs_verification | missing
function accountHealth(a) {
  if (!a) return 'missing';
  if (a.status === 'blocked') return 'blocked';
  if (a.status === 'limit_reached') return 'limit_reached';
  const ss = a.session_status || 'pending_verification';
  if (a.status === 'session_expired' || ss === 'session_expired') return 'expired';
  if (!accountHasSessionCookie(a) || ss === 'cookies_invalid') return 'needs_login';
  if (ss === 'working') return 'working';
  return 'needs_verification';
}

function selectAccount(accounts, mode) {
  const active = (accounts || []).filter(isEligible);
  if (active.length === 0) return null;
  const primary = active.find(a => a.isPrimary);

  switch (mode) {
    case 'manual_primary':
      return primary || null;
    case 'round_robin':
      return [...active].sort((a, b) =>
        new Date(a.lastUsedAt || 0).getTime() - new Date(b.lastUsedAt || 0).getTime())[0];
    case 'least_used':
      return [...active].sort((a, b) =>
        (a.usageCount - b.usageCount) || (new Date(a.lastUsedAt || 0) - new Date(b.lastUsedAt || 0)))[0];
    case 'auto_failover':
    default:
      if (primary) return primary;
      return [...active].sort(byPriorityThenIdle)[0];
  }
}

// ── Per-client account pinning ────────────────────────────────────────────────
// Optional, layered ON TOP of the global pool selection above. The default
// (mode 'auto' or no pinned account) is identical to the previous behavior, so
// existing clients are unaffected.
//
//   auto              — ignore any pin; use the global pool (DEFAULT).
//   specific          — use ONLY the pinned account; if it is not eligible,
//                       return no account (caller must surface a clear status —
//                       NO fallback, NO bypass of limits/blocks).
//   specific_or_auto  — prefer the pinned account; if it is not eligible, fall
//                       back to the normal global pool.
const PIN_MODES = ['auto', 'specific', 'specific_or_auto'];

/**
 * Resolve which account a given client's new lease should use.
 * @returns {{ account: object|null, source: string, pinnedReason?: string, pinnedHealth?: string }}
 *   source: 'auto' | 'pinned' | 'fallback' | 'pinned_unavailable' | 'none'
 */
function selectAccountForClient(accounts, globalMode, pin = {}) {
  const list = accounts || [];
  const mode = PIN_MODES.includes(pin.mode) ? pin.mode : 'auto';
  const pinnedId = pin.accountId ? String(pin.accountId) : null;

  // No pin → unchanged global-pool behavior.
  if (mode === 'auto' || !pinnedId) {
    return { account: selectAccount(list, globalMode), source: 'auto' };
  }

  const pinned = list.find(a => String(a._id) === pinnedId) || null;
  if (pinned && isEligible(pinned)) {
    return { account: pinned, source: 'pinned' };
  }

  // Pinned account is missing or not currently usable.
  const pinnedReason = pinned ? unavailableReason(pinned) : 'account_not_found';
  const pinnedHealth = accountHealth(pinned);

  if (mode === 'specific_or_auto') {
    // selectAccount only returns eligible accounts, so the unusable pinned one
    // is naturally excluded from the fallback.
    const fallback = selectAccount(list, globalMode);
    if (fallback) return { account: fallback, source: 'fallback', pinnedReason, pinnedHealth };
    return { account: null, source: 'none', pinnedReason, pinnedHealth };
  }

  // mode 'specific' → no fallback.
  return { account: null, source: 'pinned_unavailable', pinnedReason, pinnedHealth };
}

module.exports = { MODES, PIN_MODES, selectAccount, selectAccountForClient, isEligible, unavailableReason, accountHealth };
