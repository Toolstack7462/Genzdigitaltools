'use strict';
/**
 * WriteHuman health classification — FIVE INDEPENDENT SIGNALS, never one generic "stale".
 *
 * WHY THIS FILE WAS REWRITTEN (the one-hour false-stale bug, 2026-08-26)
 * ---------------------------------------------------------------------
 * WriteHuman's Supabase access token lives ~1 hour. The dedicated Chrome is the sole rotator and
 * it rotates LATE — measured from a real agent log, rotations landed 63/67/68/86 minutes apart on
 * a 60-minute token, because Chrome throttles timers in a backgrounded window. So for 3-26 minutes
 * of EVERY hour the stored access token is expired while the refresh session is perfectly alive
 * and the product keeps working.
 *
 * The old table treated `tokenExpired` as a health problem: the HEALTHY branch required
 * `!tokenExpired`, so an aged token fell through to RECONNECTING, the aggregator reported
 * `degraded`, the read-only verify returned `unknown`, and five cards on the admin page went amber
 * at once — on a healthy session. The operator's only cure was to go and refresh the RDP browser,
 * which forced an immediate rotation. That is the bug: a real but harmless fact, misclassified.
 *
 * An aged access token is now VERIFICATION FRESHNESS ("due"), not session health. The session is
 * HEALTHY until something PROVES otherwise.
 *
 * THE FIVE SIGNALS
 * ----------------
 *  1. SESSION HEALTH          HEALTHY | REFRESHING | LOGIN_REQUIRED | ERROR
 *                             From the stored bundle + server-side verification ONLY.
 *  2. VERIFICATION FRESHNESS  recent | due | failed
 *  3. AGENT HEALTH            ONLINE | RECONNECTING | OFFLINE | UNKNOWN   (heartbeat only)
 *  4. CHROME / CDP HEALTH     CONNECTED | DISCONNECTED | UNKNOWN
 *  5. COOKIE-SYNC FRESHNESS   FRESH | BEHIND | NEVER_SYNCED | FAILED
 *
 * THE RULES THAT MATTER
 *  - A stale or offline AGENT must never turn a working SESSION into LOGIN_REQUIRED.
 *    "Session HEALTHY / Agent OFFLINE / Cookie sync BEHIND / using the last verified bundle" is a
 *    valid, correct, non-alarming state.
 *  - LOGIN_REQUIRED fires ONLY on proof: the stored status is a confirmed auth failure, or a FRESH
 *    agent report shows the dedicated Chrome holding zero auth cookies, or a real server-side
 *    verification came back as a login page / revoked / missing session cookie.
 *  - An aged access token, a late heartbeat, a closed Chrome, an offline PC and a single timed-out
 *    verify are NEVER login problems.
 */

// Stored session_status values that are PROOF of an auth failure.
const DOWN_STATES = ['needs_login', 'session_expired', 'cookies_invalid', 'missing_required_session_cookie'];
// Real verification verdicts that are PROOF of an auth failure. 'unknown' / 'unsupported' are
// inconclusive by construction and must never appear here.
const FAILED_VERIFY = ['session_expired', 'needs_login', 'missing_required_session_cookie', 'cookies_invalid'];

// null/undefined/'' mean "we do not know", and must stay null. `Number(null)` is 0, so a naive
// Number.isFinite check silently turns "never synced" into "synced 0 seconds ago" — i.e. FRESH.
const num = (v) => {
  if (v === null || v === undefined || v === '') return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
};

/**
 * 3. AGENT HEALTH — from heartbeat liveness alone. Says nothing about the session.
 */
function deriveAgent(s) {
  const { ingestConfigured, agentStale, onlineDeviceCount, devicesPaired, agentSeenSec, agentStaleSec } = s;
  const online = onlineDeviceCount || 0;
  const seen = num(agentSeenSec);
  const stale = num(agentStaleSec);
  if (ingestConfigured === false) {
    return { state: 'OFFLINE', reason: 'No source is connected. Install the agent on the machine you sign in on.' };
  }
  if (agentStale == null && seen == null && !(devicesPaired > 0)) {
    return { state: 'UNKNOWN', reason: 'No agent has ever reported.' };
  }
  if (online > 0 && !agentStale) {
    return { state: 'ONLINE', reason: 'Reporting normally.' };
  }
  // Silent, but not yet past twice the stale window: a late heartbeat is a hiccup, not a
  // disappearance. A machine that briefly slept or lost the network recovers here on its own.
  if (seen != null && stale != null && seen <= stale * 2) {
    return { state: 'RECONNECTING', reason: 'A heartbeat is late; the source is expected back shortly.' };
  }
  if (online > 0) {
    return { state: 'RECONNECTING', reason: 'A paired device is reporting but the active source is behind.' };
  }
  return { state: 'OFFLINE', reason: 'The source machine is not reporting. The last verified session keeps working.' };
}

/**
 * 4. CHROME / CDP HEALTH — the active source's dedicated Chrome, as last reported. `null` means we
 * genuinely do not know (no fresh telemetry), which is NOT the same as "down".
 */
function deriveChrome(s) {
  const { cdpConnected } = s;
  if (cdpConnected === true) return { state: 'CONNECTED', reason: 'The dedicated WriteHuman Chrome is reachable.' };
  if (cdpConnected === false) return { state: 'DISCONNECTED', reason: 'The dedicated WriteHuman Chrome is not reachable right now.' };
  return { state: 'UNKNOWN', reason: 'No current report from the active source.' };
}

/**
 * 5. COOKIE-SYNC FRESHNESS — how old the stored bundle is, and whether the last push failed.
 * Deliberately separate from agent liveness: an agent can be alive while cookies are behind, and
 * cookies can be current while every agent is offline.
 */
function deriveCookieSync(s) {
  const { cookieSyncAgeSec, cookieSyncStaleSec, lastSyncFailed } = s;
  const age = num(cookieSyncAgeSec);
  if (age == null) return { state: 'NEVER_SYNCED', reason: 'No agent has ever supplied cookies.', ageSec: null };
  if (lastSyncFailed) return { state: 'FAILED', reason: 'The last cookie push was refused. The stored bundle is unchanged.', ageSec: age };
  const limit = num(cookieSyncStaleSec) || 90 * 60;
  if (age > limit) return { state: 'BEHIND', reason: 'Cookies have not been refreshed recently.', ageSec: age };
  return { state: 'FRESH', reason: 'Cookies are current.', ageSec: age };
}

/**
 * 2. VERIFICATION FRESHNESS — when the session was last PROVEN, and whether that proof failed.
 * An aged access token lands here ("due"), never in session health.
 */
function deriveVerification(s) {
  const { lastVerifyResult, verificationAgeSec, verificationDueSec, tokenExpired } = s;
  const age = num(verificationAgeSec);
  const due = num(verificationDueSec) || 15 * 60;
  if (FAILED_VERIFY.includes(lastVerifyResult)) {
    return { state: 'failed', reason: 'The last verification could not confirm this session.', ageSec: age };
  }
  if (age == null) return { state: 'due', reason: 'This session has never been verified.', ageSec: null };
  // An expired access token means the next check cannot prove anything until the browser rotates,
  // so verification is DUE by definition — regardless of the clock.
  if (tokenExpired) {
    return { state: 'due', reason: 'The access token has aged out; it rotates and sync then re-proves the session.', ageSec: age };
  }
  if (age > due) return { state: 'due', reason: 'A routine re-check is due.', ageSec: age };
  return { state: 'recent', reason: 'Recently proven working.', ageSec: age };
}

/**
 * 1. SESSION HEALTH — the stored bundle and server-side verification ONLY. No agent signal, no
 * Chrome signal, no cookie-freshness signal may reach this function's verdict. That separation is
 * the entire point: it is what makes "Session HEALTHY / Agent OFFLINE" expressible.
 */
function deriveSession(s) {
  const { hasBundle, sessionStatus, browserAuthCookies, lastVerifyResult, tokenExpired, refreshTokenPresent } = s;

  if (!hasBundle) {
    return { state: 'ERROR', reason: 'No WriteHuman session is saved yet.', loginRequired: false };
  }
  if (DOWN_STATES.includes(sessionStatus)) {
    const reason = sessionStatus === 'needs_login'
      ? 'WriteHuman signed this account out. Open WriteHuman Chrome on the active source and log in once.'
      : sessionStatus === 'missing_required_session_cookie'
        ? 'The session cookie is missing. Open WriteHuman Chrome on the active source and log in once.'
        : 'The WriteHuman session expired. Open WriteHuman Chrome on the active source and log in once.';
    return { state: 'LOGIN_REQUIRED', reason, loginRequired: true };
  }
  if (FAILED_VERIFY.includes(lastVerifyResult)) {
    return {
      state: 'LOGIN_REQUIRED',
      reason: 'A server-side check could not authenticate with the stored session. Log in once on the active source.',
      loginRequired: true,
    };
  }
  if (browserAuthCookies === 0) {
    // A FRESH report holding zero auth cookies = the dedicated Chrome is genuinely signed out.
    // `null` (stale/unknown telemetry) deliberately does NOT reach here — absence of evidence is
    // not evidence, and treating it as proof is how an offline PC became a "logged out account".
    return {
      state: 'LOGIN_REQUIRED',
      reason: 'You are signed out in WriteHuman Chrome. Open it and log in once — sync then resumes on its own.',
      loginRequired: true,
    };
  }
  if (refreshTokenPresent === false) {
    return {
      state: 'LOGIN_REQUIRED',
      reason: 'The stored bundle has no refresh token, so it can never renew itself. Log in once on the active source.',
      loginRequired: true,
    };
  }
  if (tokenExpired) {
    // THE ONE-HOUR CASE. The access token aged out and the refresh session is still there. The
    // session is NOT unhealthy and the operator has NOTHING to do — the browser rotates, or the
    // server-side refresh fallback does. Reported as REFRESHING; the UI must not call it stale,
    // expired, or unverified.
    return {
      state: 'REFRESHING',
      reason: 'The access token is rotating. The stored session is still valid — no action needed.',
      loginRequired: false,
    };
  }
  if (sessionStatus && sessionStatus !== 'working') {
    return { state: 'REFRESHING', reason: 'Verification is pending — not yet confirmed working.', loginRequired: false };
  }
  return { state: 'HEALTHY', reason: 'Signed in and syncing automatically. No action needed.', loginRequired: false };
}

/**
 * deriveHealth — the whole picture, as five signals that are allowed to disagree with each other
 * because in reality they DO disagree, and pretending otherwise is what made the old page lie.
 */
function deriveHealth(signals) {
  const s = signals || {};
  const session = deriveSession(s);
  const verification = deriveVerification(s);
  const agent = deriveAgent(s);
  const chrome = deriveChrome(s);
  const cookieSync = deriveCookieSync(s);

  // A one-line operator summary that never contradicts the parts it summarises.
  const bits = ['Session ' + session.state];
  if (agent.state !== 'ONLINE') bits.push('Agent ' + agent.state);
  if (cookieSync.state !== 'FRESH') bits.push('Cookie sync ' + cookieSync.state.replace('_', ' '));
  if (session.state !== 'LOGIN_REQUIRED' && session.state !== 'ERROR'
      && (agent.state === 'OFFLINE' || cookieSync.state === 'BEHIND')) {
    bits.push('using the last verified bundle');
  }

  return { session, verification, agent, chrome, cookieSync, summary: bits.join(' · '), loginRequired: session.loginRequired };
}

/**
 * deriveLifecycle — the legacy single-label view, kept because the admin API still publishes
 * `lifecycleState` and an older cached frontend build may read it. It is now DERIVED from the five
 * signals so the two can never drift apart.
 *
 * The one behaviour change: an aged access token used to come out as RECONNECTING and now comes
 * out as HEALTHY when nothing else is wrong. That was the one-hour false stale, in this function.
 */
function deriveLifecycle(signals) {
  const h = deriveHealth(signals);
  if (h.session.state === 'ERROR') return { state: 'ERROR', reason: h.session.reason, loginRequired: false };
  if (h.session.state === 'LOGIN_REQUIRED') return { state: 'LOGIN_REQUIRED', reason: h.session.reason, loginRequired: true };
  if (h.agent.state === 'OFFLINE') {
    const reason = (signals && signals.ingestConfigured === false)
      ? h.agent.reason
      : 'The source machine is offline. WriteHuman keeps working from the last verified session; it refreshes when the machine returns.';
    return { state: 'OFFLINE', reason, loginRequired: false };
  }
  if (h.chrome.state === 'DISCONNECTED') return { state: 'RECONNECTING', reason: 'Reconnecting to WriteHuman Chrome…', loginRequired: false };
  if (h.session.state === 'REFRESHING') {
    // Token rotation is not a fault. Only a genuinely pending verification reads as RECONNECTING.
    if (signals && signals.tokenExpired) return { state: 'HEALTHY', reason: h.session.reason, loginRequired: false };
    return { state: 'RECONNECTING', reason: h.session.reason, loginRequired: false };
  }
  if (h.agent.state === 'RECONNECTING') return { state: 'RECONNECTING', reason: h.agent.reason, loginRequired: false };
  return { state: 'HEALTHY', reason: h.session.reason, loginRequired: false };
}

module.exports = {
  deriveHealth, deriveLifecycle,
  deriveSession, deriveVerification, deriveAgent, deriveChrome, deriveCookieSync,
  DOWN_STATES, FAILED_VERIFY,
};
