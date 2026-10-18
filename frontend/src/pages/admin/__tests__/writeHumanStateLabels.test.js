// "UNKNOWN" WAS FOUR DIFFERENT FACTS WEARING ONE WORD.
//
// The deployed dashboard printed the bare word "unknown" for:
//   · a device whose `state` field was absent from the API response;
//   · healthSignals.agent.state === 'UNKNOWN', which the SERVER explains as either "No agent has
//     ever reported." or "No current report from the active source.";
//   · healthSignals.chrome.state === 'UNKNOWN';
//   · an account whose browserAuthCookies had not been reported.
//
// An operator could not tell which, and the word reads like a broken dashboard rather than a fact
// about a machine. These tests pin the replacement: each fact is named, the server's own reason is
// kept, a missing field is reported as not reported, and no absence is ever coloured as healthy.
//
// The device fixtures are the five situations named in the task: active/online, offline, standby,
// revoked, and missing telemetry.
import {
  DEVICE_STATES, DEVICE_STATE_TONE,
  deviceStateBadge, agentSignalBadge, chromeSignalBadge, signInBadge,
} from '../writeHumanStateLabels';

// Device views exactly as routes/admin/proxyTools.js decorates them: publicDevice() fields plus
// state / stateReason / terminal / canActivate from utils/proxy/deviceState.js.
const ACTIVE_ONLINE = {
  deviceId: 'dev-a', name: 'STUDIO-PC', online: true, revoked: false, isActiveSource: true,
  agentVersion: '3.5.3', state: 'ACTIVE', canActivate: false, terminal: false,
  stateReason: 'Supplying the live WriteHuman session. Only this device may update the active bundle.',
};
const OFFLINE = {
  deviceId: 'dev-b', name: 'LAPTOP', online: false, revoked: false, isActiveSource: false,
  state: 'OFFLINE', canActivate: false, terminal: false,
  stateReason: 'No heartbeat inside the last 10 minutes.',
};
const STANDBY = {
  deviceId: 'dev-c', name: 'BACKUP-PC', online: true, revoked: false, isActiveSource: false,
  state: 'STANDBY', canActivate: true, terminal: false,
  stateReason: 'Authorized and online. It has held the title before and can take it again.',
};
const REVOKED = {
  deviceId: 'dev-d', name: 'OLD-PC', online: false, revoked: true, isActiveSource: false,
  state: 'REVOKED', canActivate: false, terminal: true,
  stateReason: 'Revoked by an admin. It cannot sync, receive commands or open Chrome.',
};
// MISSING TELEMETRY: a row from a backend that does not decorate state at all. This is the only
// case that produced the literal word "unknown" on the device row.
const NO_TELEMETRY = { deviceId: 'dev-e', name: 'UNREPORTED-PC', online: false, revoked: false };

describe('every real device state keeps its own name and its own tone', () => {
  test('active / online', () => {
    const b = deviceStateBadge(ACTIVE_ONLINE);
    expect(b.label).toBe('active');
    expect(b.tone).toBe('ok');
    expect(b.title).toBe(ACTIVE_ONLINE.stateReason);
    expect(b.reported).toBe(true);
  });

  test('offline reads as offline, not as unknown and not as a fault', () => {
    const b = deviceStateBadge(OFFLINE);
    expect(b.label).toBe('offline');
    expect(b.tone).toBe('warn');
    expect(b.title).toMatch(/No heartbeat/);
  });

  test('standby', () => {
    expect(deviceStateBadge(STANDBY).label).toBe('standby');
    expect(deviceStateBadge(STANDBY).tone).toBe('mut');
  });

  test('revoked is an administrator decision, not a red alarm', () => {
    const b = deviceStateBadge(REVOKED);
    expect(b.label).toBe('revoked');
    expect(b.tone).toBe('mut');     // the page's old local map said 'bad'
    expect(b.title).toMatch(/Revoked by an admin/);
  });

  test('all eight server states are mapped, and none of them maps to "unknown"', () => {
    for (const state of DEVICE_STATES) {
      const b = deviceStateBadge({ state });
      expect(b.label).toBe(state.toLowerCase());
      expect(b.label).not.toBe('unknown');
      expect(DEVICE_STATE_TONE[state]).toBeTruthy();
      expect(b.reported).toBe(true);
    }
  });

  test('ERROR is the only device state that reads red', () => {
    const red = DEVICE_STATES.filter((s) => DEVICE_STATE_TONE[s] === 'bad');
    expect(red).toEqual(['ERROR']);
  });
});

describe('a missing state is reported as missing — never as unknown, never as healthy', () => {
  test('no state field at all', () => {
    const b = deviceStateBadge(NO_TELEMETRY);
    expect(b.reported).toBe(false);
    expect(b.label).toBe('state not reported');
    expect(b.label).not.toContain('unknown');
    expect(b.tone).toBe('mut');                 // not 'ok', ever
    expect(b.title).toMatch(/did not report/);
  });

  test('it says the gap is in the response, not a verdict on the machine', () => {
    expect(deviceStateBadge(NO_TELEMETRY).title).toMatch(/not a judgement about the machine/i);
  });

  test('a null, undefined or non-string state is treated the same way', () => {
    for (const state of [null, undefined, 0, false, {}, ['ACTIVE']]) {
      expect(deviceStateBadge({ state }).reported).toBe(false);
      expect(deviceStateBadge({ state }).tone).toBe('mut');
    }
    expect(deviceStateBadge(null).reported).toBe(false);
    expect(deviceStateBadge(undefined).reported).toBe(false);
  });

  test('an unrecognised state from a NEWER server is shown verbatim, not flattened', () => {
    const b = deviceStateBadge({ state: 'QUARANTINED', stateReason: 'Held pending review.' });
    expect(b.label).toBe('quarantined');
    expect(b.reported).toBe(true);
    expect(b.tone).toBe('mut');
    expect(b.title).toBe('Held pending review.');
  });

  test('an online, healthy-looking device with no state is still "not reported"', () => {
    // The temptation this guards against: inferring ACTIVE from a live session or a heartbeat.
    const b = deviceStateBadge({ ...NO_TELEMETRY, online: true, isActiveSource: true });
    expect(b.label).toBe('state not reported');
    expect(b.tone).not.toBe('ok');
  });
});

describe("the agent heartbeat keeps the server's own explanation", () => {
  test('ONLINE', () => {
    const b = agentSignalBadge({ state: 'ONLINE', reason: 'Reporting normally.' });
    expect(b.label).toBe('online'); expect(b.tone).toBe('ok');
  });

  test('UNKNOWN: "never reported" and "no current report" stay DIFFERENT messages', () => {
    const never = agentSignalBadge({ state: 'UNKNOWN', reason: 'No agent has ever reported.' });
    const stale = agentSignalBadge({ state: 'UNKNOWN', reason: 'No current report from the active source.' });
    expect(never.label).toBe('not reported');
    expect(stale.label).toBe('not reported');
    expect(never.title).not.toBe(stale.title);      // the whole point: both used to be "unknown"
    expect(never.title).toMatch(/ever reported/);
    expect(stale.title).toMatch(/no current report/i);
  });

  test('OFFLINE and RECONNECTING are distinct, and neither is green', () => {
    expect(agentSignalBadge({ state: 'OFFLINE' }).label).toBe('offline');
    expect(agentSignalBadge({ state: 'RECONNECTING' }).label).toBe('reconnecting');
    for (const s of ['OFFLINE', 'RECONNECTING', 'UNKNOWN']) {
      expect(agentSignalBadge({ state: s }).tone).not.toBe('ok');
    }
  });

  test('no agent signal at all is reported:false and says the SERVER did not report it', () => {
    for (const sig of [null, undefined, {}, { state: null }]) {
      const b = agentSignalBadge(sig);
      expect(b.label).toBe('not reported');
      expect(b.reported).toBe(false);
      expect(b.tone).toBe('mut');
    }
    expect(agentSignalBadge(null).title).toMatch(/did not report/);
  });

  test('a reported UNKNOWN and an absent signal are distinguishable', () => {
    expect(agentSignalBadge({ state: 'UNKNOWN', reason: 'No agent has ever reported.' }).reported).toBe(true);
    expect(agentSignalBadge(null).reported).toBe(false);
  });
});

describe('Chrome / CDP', () => {
  test('connected and disconnected', () => {
    expect(chromeSignalBadge({ state: 'CONNECTED' }).tone).toBe('ok');
    expect(chromeSignalBadge({ state: 'DISCONNECTED' }).tone).toBe('warn');
  });

  test('UNKNOWN and absent both read "not reported", never "disconnected"', () => {
    for (const sig of [{ state: 'UNKNOWN' }, null, {}]) {
      const b = chromeSignalBadge(sig);
      expect(b.label).toBe('not reported');
      expect(b.label).not.toBe('disconnected');
      expect(b.tone).toBe('mut');
    }
  });
});

describe('sign-in: a missing observation is not a signed-out browser', () => {
  test('cookies reported and session healthy', () => {
    expect(signInBadge({ browserAuthCookies: 4 }, false).label).toBe('signed in');
  });

  test('cookies reported and the lifecycle says login required', () => {
    const b = signInBadge({ browserAuthCookies: 0 }, true);
    expect(b.label).toBe('signed out');
    expect(b.tone).toBe('bad');
  });

  test('nothing reported is "not reported", and frozen telemetry says why', () => {
    const plain = signInBadge({ browserAuthCookies: null }, false);
    const frozen = signInBadge({ browserAuthCookies: null, telemetryFrozen: true }, false);
    expect(plain.label).toBe('not reported');
    expect(frozen.label).toBe('not reported');
    expect(frozen.title).toMatch(/No device is reporting/);
    expect(plain.title).toMatch(/missing observation/);
    expect(plain.title).not.toBe(frozen.title);
  });

  test('a missing observation is never rendered as signed out', () => {
    // Even when the lifecycle verdict is LOGIN_REQUIRED, an unreported cookie count is unreported.
    expect(signInBadge({ browserAuthCookies: null }, true).label).toBe('not reported');
  });
});
