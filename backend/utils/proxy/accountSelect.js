'use strict';
/**
 * Account selection for NEW proxy-tool leases (HIX / BypassGPT). Mirrors the
 * StealthWriter selection logic but is an isolated copy so the proxy module never
 * depends on the StealthWriter module. Operates on the tool's OWN account set
 * (callers pass only accounts for that tool).
 *
 * Only `active`/`standby` accounts with a usable session cookie are eligible.
 * `limit_reached`, `session_expired`, `blocked` and cookie-less accounts are skipped.
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

// Safe, log-able reason an account is NOT eligible (no secrets).
function unavailableReason(a) {
  if (a.status === 'blocked') return 'blocked';
  if (a.status === 'limit_reached') return 'status_limit_reached';
  if (!accountHasSessionCookie(a)) return 'no_session_cookie';
  // Live-agent tools (WriteHuman): the Cookie Sync Agent's freshest report is the ground truth for
  // "is the browser logged in RIGHT NOW". authCookies===0 => the RDP browser is logged out, so the
  // cached vault cookie is dead — never serve it to a client (read-only verify can't catch this
  // because the stored access-token JWT stays exp-valid ~1h after logout). Only trust a report from
  // the last 10 min. No-op for tools without an agent report (agentReport is undefined -> skipped).
  if (a.agentReport && a.agentReport.authCookies === 0) {
    const recv = a.agentReport.receivedAt ? new Date(a.agentReport.receivedAt).getTime() : 0;
    if (recv && (Date.now() - recv) < 10 * 60000) return 'browser_logged_out';
  }
  const ss = a.session_status || 'pending_verification';
  if (ss === 'session_expired') return 'session_expired';
  if (ss === 'needs_login') return 'needs_login';
  if (ss === 'missing_required_session_cookie') return 'missing_required_session_cookie';
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

// Resolve the account for a client that MAY be pinned to a specific account (Claude's
// pinned-vs-automatic assignment). Additive + tool-agnostic; existing selection is untouched.
//   - pinnedAccountId set + that account exists + eligible → serve it (pinned=true).
//   - pinnedAccountId set + that account exists but NOT eligible → { account: null, pinned: true,
//     unavailableReason } — we DO NOT silently switch a pinned client onto a different account,
//     because that would break the shared five-hour/weekly reset grouping and could place the
//     client on a different identity. The caller surfaces a clear "being refreshed" status.
//   - pinnedAccountId set but the account was deleted → gracefully fall back to automatic.
//   - no pinnedAccountId → automatic selection exactly as before.
function resolveAccount(accounts, mode, pinnedAccountId) {
  const list = accounts || [];
  if (pinnedAccountId) {
    const pinned = list.find(a => String(a._id) === String(pinnedAccountId));
    if (pinned) {
      const reason = unavailableReason(pinned);
      return reason === null
        ? { account: pinned, pinned: true, unavailableReason: null }
        : { account: null, pinned: true, unavailableReason: reason };
    }
    // Pinned account no longer exists → fall through to automatic (graceful).
  }
  return { account: selectAccount(list, mode), pinned: false, unavailableReason: null };
}

module.exports = { MODES, selectAccount, isEligible, unavailableReason, resolveAccount };
