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

function selectAccount(accounts, mode) {
  const active = (accounts || []).filter(a => a.status === 'active');
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

module.exports = { MODES, selectAccount };
