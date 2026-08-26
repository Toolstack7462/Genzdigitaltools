'use strict';
/**
 * The FIVE health signals, and the two production bugs they exist to prevent.
 *
 * BUG 1 — the one-hour false stale. WriteHuman's Supabase access token lives ~1 hour and the
 * dedicated Chrome rotates it LATE (measured on the real source machine: rotations 63, 67, 68 and
 * 86 minutes apart on a 60-minute token, because Chrome throttles timers in a backgrounded
 * window). For several minutes of every hour the stored token is therefore expired while the
 * refresh session is perfectly alive and the product keeps working. The old classifier required
 * `!tokenExpired` to say HEALTHY, so it reported RECONNECTING, the aggregator said `degraded`, and
 * the page rendered "working · unverified" — on a healthy account, every hour, until someone went
 * and refreshed the RDP browser by hand.
 *
 * BUG 2 — contradictory signals. A stale or offline AGENT must never turn a working SESSION into
 * LOGIN_REQUIRED, and "Session HEALTHY / Agent OFFLINE / Cookie sync BEHIND" must be expressible.
 */
const test = require('node:test');
const assert = require('node:assert');
const { deriveHealth, deriveLifecycle } = require('../utils/proxy/sessionHealth');

const base = {
  hasBundle: true,
  sessionStatus: 'working',
  browserAuthCookies: 2,
  tokenExpired: false,
  refreshTokenPresent: true,
  lastVerifyResult: 'working',
  verificationAgeSec: 120,
  verificationDueSec: 20 * 60,
  agentStale: false,
  agentSeenSec: 60,
  agentStaleSec: 10 * 60,
  devicesPaired: 1,
  onlineDeviceCount: 1,
  cdpConnected: true,
  ingestConfigured: true,
  cookieSyncAgeSec: 300,
  cookieSyncStaleSec: 90 * 60,
  lastSyncFailed: false,
};
const H = (o) => deriveHealth({ ...base, ...o });

test('the happy path is green on all five signals', () => {
  const h = H({});
  assert.strictEqual(h.session.state, 'HEALTHY');
  assert.strictEqual(h.verification.state, 'recent');
  assert.strictEqual(h.agent.state, 'ONLINE');
  assert.strictEqual(h.chrome.state, 'CONNECTED');
  assert.strictEqual(h.cookieSync.state, 'FRESH');
  assert.strictEqual(h.loginRequired, false);
});

test('THE ONE-HOUR BUG: an aged access token is verification freshness, not session health', () => {
  const h = H({ tokenExpired: true });
  // The session is NOT degraded, NOT stale, NOT unverified, and NOT a login problem.
  assert.strictEqual(h.session.state, 'REFRESHING');
  assert.strictEqual(h.session.loginRequired, false);
  // It shows up here, and only here.
  assert.strictEqual(h.verification.state, 'due');
  // ...and nothing else moves.
  assert.strictEqual(h.agent.state, 'ONLINE');
  assert.strictEqual(h.chrome.state, 'CONNECTED');
  assert.strictEqual(h.cookieSync.state, 'FRESH');
  // The legacy single label must not go amber either — that field drove the dashboard banner.
  assert.strictEqual(deriveLifecycle({ ...base, tokenExpired: true }).state, 'HEALTHY');
});

test('an aged token PLUS a long-idle browser is still not a login problem', () => {
  // 80 minutes since the last cookie change and the token expired: exactly the state the operator
  // used to find every hour before reaching for the RDP.
  const h = H({ tokenExpired: true, cookieSyncAgeSec: 80 * 60, verificationAgeSec: 40 * 60 });
  assert.strictEqual(h.session.loginRequired, false);
  assert.notStrictEqual(h.session.state, 'LOGIN_REQUIRED');
  assert.strictEqual(h.verification.state, 'due');
});

test('the required valid combination: Session HEALTHY / Agent OFFLINE / Cookie sync BEHIND', () => {
  const h = H({
    agentStale: true, onlineDeviceCount: 0, agentSeenSec: 3 * 60 * 60, cdpConnected: null,
    cookieSyncAgeSec: 3 * 60 * 60,
  });
  assert.strictEqual(h.session.state, 'HEALTHY');
  assert.strictEqual(h.session.loginRequired, false);
  assert.strictEqual(h.agent.state, 'OFFLINE');
  assert.strictEqual(h.chrome.state, 'UNKNOWN');
  assert.strictEqual(h.cookieSync.state, 'BEHIND');
  assert.match(h.summary, /using the last verified bundle/);
});

test('LOGIN_REQUIRED fires only on PROOF', () => {
  // Proof 1: the stored status is a confirmed auth failure.
  for (const ss of ['needs_login', 'session_expired', 'cookies_invalid', 'missing_required_session_cookie']) {
    assert.strictEqual(H({ sessionStatus: ss }).session.state, 'LOGIN_REQUIRED', ss);
  }
  // Proof 2: a FRESH report shows the dedicated Chrome holding zero auth cookies.
  assert.strictEqual(H({ browserAuthCookies: 0 }).session.state, 'LOGIN_REQUIRED');
  // Proof 3: a real server-side verification came back as a confirmed auth failure.
  assert.strictEqual(H({ lastVerifyResult: 'session_expired' }).session.state, 'LOGIN_REQUIRED');
  // Proof 4: the bundle has no refresh token, so it can never renew itself.
  assert.strictEqual(H({ refreshTokenPresent: false }).session.state, 'LOGIN_REQUIRED');
});

test('LOGIN_REQUIRED never fires on absence of evidence or on someone else being down', () => {
  const notLogin = [
    { tokenExpired: true },                                                  // routine rotation
    { agentStale: true, onlineDeviceCount: 0, agentSeenSec: 9999 },          // PC off
    { cdpConnected: false },                                                 // Chrome closed
    { browserAuthCookies: null },                                            // stale telemetry
    { lastVerifyResult: 'unknown' },                                         // timed-out verify
    { lastVerifyResult: 'unsupported' },                                     // anti-bot challenge
    { cookieSyncAgeSec: 5 * 60 * 60 },                                       // sync far behind
    { lastSyncFailed: true },                                                // a refused push
  ];
  for (const o of notLogin) {
    const h = H(o);
    assert.strictEqual(h.session.loginRequired, false, JSON.stringify(o));
    assert.notStrictEqual(h.session.state, 'LOGIN_REQUIRED', JSON.stringify(o));
  }
});

test('an inconclusive verify does not read as a failed one', () => {
  for (const r of ['unknown', 'unsupported', null]) {
    assert.notStrictEqual(H({ lastVerifyResult: r }).verification.state, 'failed', String(r));
  }
  assert.strictEqual(H({ lastVerifyResult: 'session_expired' }).verification.state, 'failed');
});

test('agent health comes from the heartbeat alone and knows "late" from "gone"', () => {
  assert.strictEqual(H({ agentStale: false, onlineDeviceCount: 1 }).agent.state, 'ONLINE');
  // Silent, but inside twice the stale window: a hiccup.
  assert.strictEqual(H({ agentStale: true, onlineDeviceCount: 0, agentSeenSec: 12 * 60 }).agent.state, 'RECONNECTING');
  // Silent well past it: gone.
  assert.strictEqual(H({ agentStale: true, onlineDeviceCount: 0, agentSeenSec: 90 * 60 }).agent.state, 'OFFLINE');
  // Never seen and nothing paired: unknown, not "offline" (which implies it was ever there).
  assert.strictEqual(H({ agentStale: null, agentSeenSec: null, devicesPaired: 0, onlineDeviceCount: 0 }).agent.state, 'UNKNOWN');
  // No ingest at all is its own thing.
  assert.strictEqual(H({ ingestConfigured: false }).agent.state, 'OFFLINE');
});

test('Chrome UNKNOWN is not Chrome DOWN', () => {
  assert.strictEqual(H({ cdpConnected: null }).chrome.state, 'UNKNOWN');
  assert.strictEqual(H({ cdpConnected: false }).chrome.state, 'DISCONNECTED');
  assert.strictEqual(H({ cdpConnected: true }).chrome.state, 'CONNECTED');
});

test('cookie-sync freshness is independent of agent liveness in BOTH directions', () => {
  // Agent alive, cookies behind.
  const a = H({ cookieSyncAgeSec: 5 * 60 * 60 });
  assert.strictEqual(a.agent.state, 'ONLINE');
  assert.strictEqual(a.cookieSync.state, 'BEHIND');
  // Every agent offline, cookies current.
  const b = H({ agentStale: true, onlineDeviceCount: 0, agentSeenSec: 9999, cookieSyncAgeSec: 60 });
  assert.strictEqual(b.agent.state, 'OFFLINE');
  assert.strictEqual(b.cookieSync.state, 'FRESH');
  // Never synced is distinct from behind.
  assert.strictEqual(H({ cookieSyncAgeSec: null }).cookieSync.state, 'NEVER_SYNCED');
  assert.strictEqual(H({ lastSyncFailed: true }).cookieSync.state, 'FAILED');
});

test('no bundle is ERROR, and ERROR is not a login prompt', () => {
  const h = H({ hasBundle: false });
  assert.strictEqual(h.session.state, 'ERROR');
  assert.strictEqual(h.session.loginRequired, false);
});

test('every signal carries a human reason, so the UI never has to invent one', () => {
  for (const o of [{}, { tokenExpired: true }, { sessionStatus: 'needs_login' }, { cdpConnected: false },
    { agentStale: true, onlineDeviceCount: 0, agentSeenSec: 9999 }, { hasBundle: false }]) {
    const h = H(o);
    for (const k of ['session', 'verification', 'agent', 'chrome', 'cookieSync']) {
      assert.ok(h[k].reason && h[k].reason.length > 8, k + ' ' + JSON.stringify(o));
    }
  }
});

test('the summary never contradicts the signals it summarises', () => {
  // Never claims a bundle is in use when the session needs a login.
  const bad = H({ sessionStatus: 'needs_login', agentStale: true, onlineDeviceCount: 0, agentSeenSec: 9999 });
  assert.strictEqual(bad.session.state, 'LOGIN_REQUIRED');
  assert.doesNotMatch(bad.summary, /using the last verified bundle/);
  // ...and does say so when the session really is fine.
  const good = H({ agentStale: true, onlineDeviceCount: 0, agentSeenSec: 9999 });
  assert.match(good.summary, /using the last verified bundle/);
});
