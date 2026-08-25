'use strict';
/**
 * The session-lifecycle decision table. The property that matters and is easy to get wrong:
 * LOGIN_REQUIRED must fire ONLY for a proven auth failure — never for a late heartbeat, an offline
 * PC, a closed Chrome, an ordinary token rotation, or a single timed-out verify.
 */
const test = require('node:test');
const assert = require('node:assert');
const { deriveLifecycle } = require('../utils/proxy/sessionHealth');

const base = {
  hasBundle: true, sessionStatus: 'working', browserAuthCookies: 2, tokenExpired: false,
  agentStale: false, onlineDeviceCount: 1, cdpConnected: true, ingestConfigured: true,
};
const S = (o) => deriveLifecycle({ ...base, ...o }).state;
const L = (o) => deriveLifecycle({ ...base, ...o }).loginRequired;

test('the happy path is HEALTHY', () => {
  assert.strictEqual(S({}), 'HEALTHY');
  assert.strictEqual(L({}), false);
});

test('LOGIN_REQUIRED fires for every GENUINE auth failure', () => {
  for (const ss of ['needs_login', 'session_expired', 'cookies_invalid', 'missing_required_session_cookie']) {
    assert.strictEqual(S({ sessionStatus: ss }), 'LOGIN_REQUIRED', ss);
    assert.strictEqual(L({ sessionStatus: ss }), true, ss);
  }
  // A fresh report with zero auth cookies = the dedicated Chrome is genuinely signed out.
  assert.strictEqual(S({ browserAuthCookies: 0 }), 'LOGIN_REQUIRED');
  assert.strictEqual(L({ browserAuthCookies: 0 }), true);
});

test('LOGIN_REQUIRED does NOT fire for transient conditions', () => {
  // Offline source machine — keep serving the last verified bundle, do not demand a login.
  assert.strictEqual(S({ agentStale: true, onlineDeviceCount: 0 }), 'OFFLINE');
  assert.strictEqual(L({ agentStale: true, onlineDeviceCount: 0 }), false);

  // Chrome temporarily unreachable — reconnects on its own.
  assert.strictEqual(S({ cdpConnected: false }), 'RECONNECTING');
  assert.strictEqual(L({ cdpConnected: false }), false);

  // Ordinary token rotation (aged token, browser still logged in) — the browser rotates it.
  assert.strictEqual(S({ tokenExpired: true }), 'RECONNECTING');
  assert.strictEqual(L({ tokenExpired: true }), false);

  // Stale/unknown telemetry (null auth cookies) is NOT proof of logout — must not demand a login.
  assert.strictEqual(L({ browserAuthCookies: null, agentStale: true, onlineDeviceCount: 0 }), false);
});

test('a genuine auth failure OUTRANKS a transient one', () => {
  // Signed out AND the PC offline: the auth failure is what the operator must act on.
  assert.strictEqual(S({ sessionStatus: 'needs_login', agentStale: true, onlineDeviceCount: 0 }), 'LOGIN_REQUIRED');
});

test('no source connected is OFFLINE, not an error', () => {
  assert.strictEqual(S({ ingestConfigured: false }), 'OFFLINE');
  assert.strictEqual(L({ ingestConfigured: false }), false);
});

test('no saved bundle is ERROR', () => {
  assert.strictEqual(S({ hasBundle: false }), 'ERROR');
  assert.strictEqual(L({ hasBundle: false }), false);
});

test('every state carries a human reason', () => {
  for (const o of [{}, { sessionStatus: 'needs_login' }, { cdpConnected: false }, { agentStale: true, onlineDeviceCount: 0 }, { hasBundle: false }]) {
    const r = deriveLifecycle({ ...base, ...o });
    assert.ok(r.reason && r.reason.length > 8, JSON.stringify(o));
  }
});
