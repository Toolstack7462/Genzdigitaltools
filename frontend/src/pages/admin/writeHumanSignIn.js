/**
 * "Sign-in" is a POSITIVE claim about the source account, so it needs positive evidence.
 *
 * The row used to read:
 *
 *   browserAuthCookies == null ? unknown : loggedOut ? 'signed out' : 'signed in'
 *
 * with `loggedOut = sessionState === 'LOGIN_REQUIRED'`. The only negative it recognised was that
 * one exact string, so everything else was painted green. Two consequences, both of them seen in
 * the admin page:
 *
 *   - `sessionState === 'ERROR'`, whose own row renders "no session", showed a green "signed in"
 *     next to it. STALLED ("renewal stalled") did too, and so did a missing state.
 *   - `browserAuthCookies === false` — the agent reporting that the source browser holds NO auth
 *     cookies — is not `== null`, so it fell through to "signed in" as well.
 *
 * That is the "admin says healthy, the client cannot open the tool" gap in miniature: a green badge
 * standing in for a fact nobody established.
 *
 * The server emits exactly five session states: HEALTHY, REFRESHING, STALLED, LOGIN_REQUIRED and
 * ERROR. Only the first two mean the account is signed in — REFRESHING is a renewal in flight over
 * a live session. STALLED and ERROR are not signed out as such, but they are certainly not proof of
 * being signed in, so they read as unestablished rather than as either extreme.
 */

// The states that genuinely mean "this account is signed in".
export const SIGNED_IN_STATES = Object.freeze(['HEALTHY', 'REFRESHING']);

/**
 * @param {object} a                      the account row from the admin API
 * @param {number|boolean|null} a.browserAuthCookies  what the source browser reported holding
 * @param {boolean} [a.telemetryFrozen]   no device is currently reporting
 * @param {string|null} sessionState      healthSignals.session.state, or null when absent
 * @returns {{label: string, tone: 'ok'|'bad'|'mut', established: boolean}}
 */
export function signInDisplay(a = {}, sessionState = null) {
  const reported = a.browserAuthCookies !== null && a.browserAuthCookies !== undefined;

  // Nothing reported at all: say so, and say why when we know.
  if (!reported) {
    return {
      label: a.telemetryFrozen ? 'unknown · no device reporting' : 'unknown',
      tone: 'mut',
      established: false,
    };
  }

  // Reported, and the answer was none. This is evidence of being signed OUT, not of anything green.
  if (a.browserAuthCookies === false || a.browserAuthCookies === 0) {
    return { label: 'signed out · no auth cookies', tone: 'bad', established: true };
  }

  if (sessionState === 'LOGIN_REQUIRED') {
    return { label: 'signed out', tone: 'bad', established: true };
  }

  if (SIGNED_IN_STATES.includes(sessionState)) {
    return { label: 'signed in', tone: 'ok', established: true };
  }

  // Cookies are present but the session state is STALLED, ERROR, unrecognised or absent. The
  // account may well be fine; we have not established it, and a badge must not pretend otherwise.
  return {
    label: sessionState ? `not established · session ${String(sessionState).toLowerCase()}` : 'not established',
    tone: 'mut',
    established: false,
  };
}
