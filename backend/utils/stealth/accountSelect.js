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

module.exports = { MODES, selectAccount, isEligible, unavailableReason };
