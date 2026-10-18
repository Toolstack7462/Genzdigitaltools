// How the WriteHuman dashboard turns server-reported state into words — and the one word it is
// no longer allowed to use.
//
// THE BUG THIS REPLACES
// ---------------------
// Four different facts all rendered as the bare word "unknown", with no way for an operator to
// tell which of them they were looking at:
//
//     <Badge tone={STATE_TONE[d.state] || 'mut'}>{(d.state || 'unknown').toLowerCase()}</Badge>
//     const agLabel = agentState === 'ONLINE' ? 'online' : … : 'unknown';
//     const chromeLabel = chromeState === 'CONNECTED' ? 'connected' : … : 'unknown';
//     {a.browserAuthCookies == null ? <Badge tone="mut">…'unknown'</Badge> : …}
//
// The agent and Chrome cases are the ones that actually show on a working system, and they are the
// most misleading, because the server DOES say what it means — utils/proxy/sessionHealth.js returns
// `{ state: 'UNKNOWN', reason: 'No agent has ever reported.' }` and
// `{ state: 'UNKNOWN', reason: 'No current report from the active source.' }`. The page threw the
// reason away and printed "unknown", so a precise statement ("nothing has ever checked in") and a
// different precise statement ("it checked in before, but not recently") became the same
// uninformative word, which reads like a dashboard malfunction rather than a fact about a machine.
//
// What this module does NOT do: invent a state. A missing field is reported as not reported, never
// as healthy, and never with an "ok" tone. Active-source ownership, heartbeat liveness and session
// health stay three separate inputs — none of them is allowed to imply another. `deviceStateBadge`
// cannot see the session at all, which is enforced by its signature.
//
// Pure: no React, no network, no clock.

/** The eight states utils/proxy/deviceState.js can return. Nothing else is a device state. */
export const DEVICE_STATES = ['ACTIVE', 'READY', 'STANDBY', 'OFFLINE', 'REVOKED', 'SUPERSEDED', 'UNINSTALLED', 'ERROR'];

// Tone carries meaning, so it is assigned per state rather than defaulted. REVOKED, UNINSTALLED
// and SUPERSEDED are terminal and read grey, not red: they are an administrator's decision or
// bookkeeping, not a fault to chase.
export const DEVICE_STATE_TONE = {
  ACTIVE: 'ok',
  READY: 'ok',
  STANDBY: 'mut',
  OFFLINE: 'warn',
  ERROR: 'bad',
  REVOKED: 'mut',
  SUPERSEDED: 'mut',
  UNINSTALLED: 'mut',
};

/** Shown when the server did not report a field. Deliberately not the word "unknown". */
const NOT_REPORTED = 'not reported';

/**
 * The state badge for one device row.
 *
 * @param {object} d a device view from GET …/writehuman/agent-state → devices[]
 * @returns {{label:string, tone:string, title:string, reported:boolean}}
 */
export function deviceStateBadge(d) {
  const raw = d && typeof d.state === 'string' ? d.state : null;
  const reason = d && typeof d.stateReason === 'string' ? d.stateReason : '';
  if (!raw) {
    return {
      label: `state ${NOT_REPORTED}`,
      tone: 'mut',
      // This is the one case an operator must not read as a verdict on the machine. It is a
      // statement about the SERVER's answer.
      title: 'This server did not report an operational state for this device. That is a gap in the API response, not a judgement about the machine — it usually means the backend predates the canonical device state.',
      reported: false,
    };
  }
  const state = raw.toUpperCase();
  if (!DEVICE_STATES.includes(state)) {
    // A newer backend with a state this bundle has not been taught. Show it verbatim rather than
    // flattening it, and do not colour it as good or bad.
    return {
      label: state.toLowerCase(),
      tone: 'mut',
      title: reason || 'This server reported a device state this dashboard does not recognise. It is shown exactly as received.',
      reported: true,
    };
  }
  return { label: state.toLowerCase(), tone: DEVICE_STATE_TONE[state], title: reason, reported: true };
}

/**
 * The agent heartbeat badge. Heartbeat only — this says nothing about whether the stored session
 * works, and must never be derived from it.
 *
 * @param {object|null} agentSignal healthSignals.agent, i.e. { state, reason }
 * @returns {{label:string, tone:string, title:string, reported:boolean}}
 */
export function agentSignalBadge(agentSignal) {
  const s = agentSignal && typeof agentSignal.state === 'string' ? agentSignal.state.toUpperCase() : null;
  const reason = (agentSignal && typeof agentSignal.reason === 'string' && agentSignal.reason) || '';
  switch (s) {
    case 'ONLINE': return { label: 'online', tone: 'ok', title: reason, reported: true };
    case 'RECONNECTING': return { label: 'reconnecting', tone: 'warn', title: reason, reported: true };
    case 'OFFLINE': return { label: 'offline', tone: 'warn', title: reason, reported: true };
    case 'UNKNOWN':
      // The server's own words distinguish "never reported" from "no current report". Keeping the
      // reason is the whole fix: both used to render as "unknown".
      return { label: NOT_REPORTED, tone: 'mut', title: reason || 'The server reported no agent heartbeat.', reported: true };
    default:
      return {
        label: NOT_REPORTED, tone: 'mut',
        title: 'This server did not report an agent heartbeat signal.',
        reported: false,
      };
  }
}

/**
 * The Chrome / CDP badge. Also heartbeat-shaped: a disconnected Chrome does not invalidate the
 * stored session, and an unreported one is not a disconnected one.
 *
 * @param {object|null} chromeSignal healthSignals.chrome
 */
export function chromeSignalBadge(chromeSignal) {
  const s = chromeSignal && typeof chromeSignal.state === 'string' ? chromeSignal.state.toUpperCase() : null;
  const reason = (chromeSignal && typeof chromeSignal.reason === 'string' && chromeSignal.reason) || '';
  switch (s) {
    case 'CONNECTED': return { label: 'connected', tone: 'ok', title: reason, reported: true };
    case 'DISCONNECTED': return { label: 'disconnected', tone: 'warn', title: reason, reported: true };
    case 'UNKNOWN': return { label: NOT_REPORTED, tone: 'mut', title: reason || 'The server reported no Chrome status.', reported: true };
    default:
      return { label: NOT_REPORTED, tone: 'mut', title: 'This server did not report a Chrome / CDP signal.', reported: false };
  }
}

/**
 * The stored account's sign-in badge. `browserAuthCookies == null` means no device has told the
 * server what the browser holds — which is a missing observation, not a signed-out browser.
 *
 * @param {object} account state.account
 * @param {boolean} loggedOut the lifecycle verdict (healthSignals.session === 'LOGIN_REQUIRED')
 */
export function signInBadge(account, loggedOut) {
  const a = account || {};
  if (a.browserAuthCookies == null) {
    return {
      label: NOT_REPORTED, tone: 'mut',
      title: a.telemetryFrozen
        ? 'No device is reporting, so the server cannot say what the browser currently holds. The stored session is unaffected.'
        : 'No device has reported the browser’s auth cookies yet. This is a missing observation, not a signed-out browser.',
      reported: false,
    };
  }
  return loggedOut
    ? { label: 'signed out', tone: 'bad', title: 'The stored session needs a fresh sign-in on the source machine.', reported: true }
    : { label: 'signed in', tone: 'ok', title: '', reported: true };
}
