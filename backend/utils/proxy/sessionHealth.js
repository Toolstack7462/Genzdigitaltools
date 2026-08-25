'use strict';
/**
 * deriveLifecycle — the WriteHuman session-lifecycle state, as one clear label the operator acts on.
 *
 * The states, and the rule that matters most:
 *
 *   HEALTHY        signed in, token valid, agent fresh — nothing to do.
 *   RECONNECTING   a TRANSIENT hiccup that recovers on its own: Chrome briefly unreachable, the
 *                  access token aged while the browser rotates it, sync momentarily behind.
 *   OFFLINE        the source machine isn't reporting. NOT a login problem — the last verified
 *                  bundle keeps WriteHuman working until the session genuinely fails.
 *   LOGIN_REQUIRED a PROVEN auth failure and the only state that asks the user to act: WriteHuman
 *                  signed the account out, the session/refresh token expired or was revoked, the
 *                  required cookie is missing, or the dedicated Chrome is genuinely signed out.
 *   ERROR          no session bundle saved at all.
 *
 * LOGIN_REQUIRED must never fire for a late heartbeat, an offline PC, a closed Chrome, an ordinary
 * token rotation, or a single timed-out verify — those are OFFLINE / RECONNECTING. This function is
 * a pure decision table so that rule is directly testable.
 *
 * Signals (all already computed by the aggregator; this only classifies them):
 *   hasBundle           there is a stored session bundle
 *   sessionStatus       account.session_status ('working' | needs_login | session_expired | …)
 *   browserAuthCookies  auth-cookie count from a FRESH agent report, or null if telemetry is stale
 *   tokenExpired        the stored access token's exp has passed
 *   agentStale          no paired device has reported within the stale window
 *   onlineDeviceCount   paired devices currently reporting
 *   cdpConnected        true/false/null — the active source's Chrome/CDP reachability (null = unknown)
 *   ingestConfigured    a source can push at all (a device is paired, or the shared key is set)
 */
const DOWN_STATES = ['needs_login', 'session_expired', 'cookies_invalid', 'missing_required_session_cookie'];

function deriveLifecycle(s) {
  const {
    hasBundle, sessionStatus, browserAuthCookies, tokenExpired,
    agentStale, onlineDeviceCount, cdpConnected, ingestConfigured,
  } = s || {};

  if (!hasBundle) {
    return { state: 'ERROR', reason: 'No WriteHuman session is saved yet.', loginRequired: false };
  }
  if (DOWN_STATES.includes(sessionStatus)) {
    const reason = sessionStatus === 'needs_login'
      ? 'WriteHuman signed this account out. Open WriteHuman Chrome and log in once.'
      : sessionStatus === 'missing_required_session_cookie'
        ? 'The session cookie is missing. Open WriteHuman Chrome and log in once.'
        : 'The WriteHuman session expired. Open WriteHuman Chrome and log in once.';
    return { state: 'LOGIN_REQUIRED', reason, loginRequired: true };
  }
  if (browserAuthCookies === 0) {
    // A FRESH report with zero auth cookies = the dedicated Chrome is genuinely signed out. (null,
    // meaning stale/unknown telemetry, deliberately does NOT trigger this — that is not proof.)
    return {
      state: 'LOGIN_REQUIRED',
      reason: 'You are signed out in WriteHuman Chrome. Open it and log in once — sync then resumes on its own.',
      loginRequired: true,
    };
  }
  if (!ingestConfigured) {
    return { state: 'OFFLINE', reason: 'No source is connected. Install the agent on a machine to sync automatically.', loginRequired: false };
  }
  if (agentStale && (onlineDeviceCount || 0) === 0) {
    return {
      state: 'OFFLINE',
      reason: 'The source machine is offline. WriteHuman keeps working from the last verified session; it refreshes when the machine returns.',
      loginRequired: false,
    };
  }
  if (cdpConnected === false) {
    return { state: 'RECONNECTING', reason: 'Reconnecting to WriteHuman Chrome…', loginRequired: false };
  }
  if (sessionStatus === 'working' && !tokenExpired && !agentStale) {
    return { state: 'HEALTHY', reason: 'Signed in and syncing automatically. No action needed.', loginRequired: false };
  }
  // Working but token aged / sync briefly behind: the browser rotates on its own. Transient.
  return { state: 'RECONNECTING', reason: 'Refreshing the session…', loginRequired: false };
}

module.exports = { deriveLifecycle, DOWN_STATES };
