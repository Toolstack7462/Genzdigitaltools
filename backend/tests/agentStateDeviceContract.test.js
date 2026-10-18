'use strict';
/**
 * AGENT-STATE → DASHBOARD CONTRACT: every device row must carry its own `state`.
 *
 * THE SYMPTOM THIS IS ABOUT. An operator screenshot shows a healthy session, an online agent,
 * connected Chrome and fresh cookies, while the device row's state badge reads "unknown" and last
 * sync reads 47m ago.
 *
 * WHAT 47 MINUTES IS NOT. It is not stale. `SYNC_STALE_MIN` defaults to 90 minutes
 * (routes/admin/proxyTools.js) and sessionHealth's cookie-sync classifier uses the same 90*60s
 * limit, so a 47-minute-old successful sync is inside the window and `healthSignals.cookieSync`
 * should read healthy. Agent LIVENESS is a separate, shorter threshold (`AGENT_STALE_MIN`, 10
 * minutes) driven by heartbeats, not by sync age. The two must not be conflated.
 *
 * WHERE "unknown" COMES FROM. AdminWriteHuman renders
 *     <Badge …>{(d.state || 'unknown').toLowerCase()}</Badge>
 * so the badge reads "unknown" exactly when `d.state` is falsy. `deviceState.stateOf()` cannot
 * return a falsy state — every branch returns a concrete string, and even a missing device returns
 * 'REVOKED'. So a row showing "unknown" means the response carried no `state` for that device.
 *
 * `state` is NOT part of `deviceSync.publicDevice()`; it is added by the route's decoration pass.
 * That is the discriminating detail: every field the screenshot renders correctly (hostname, agent
 * version, promotion count, lastSyncSuccessAt) comes from publicDevice, and the single field that
 * reads "unknown" is the one the route adds. A backend older than that decoration therefore
 * produces exactly this picture — and a FRONTEND deploy cannot fix it.
 *
 * These assertions pin the contract in THIS tree so it cannot regress. They say nothing about which
 * build is currently running on the API host; that remains unverified from here.
 */
const test = require('node:test');
const { describe } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const BACKEND = path.join(__dirname, '..');
const ROUTE = fs.readFileSync(path.join(BACKEND, 'routes', 'admin', 'proxyTools.js'), 'utf8');
const deviceState = require('../utils/proxy/deviceState');
const deviceSync = require('../utils/proxy/deviceSync');

describe('stateOf always yields a renderable state', () => {
  const account = { tool: 'writehuman', isPrimary: true, syncDevices: [], activeSource: null };
  const dev = (over = {}) => ({
    deviceId: 'agent_x', name: 'RDP-01', agentVersion: '3.5.15', keyHash: 'k'.repeat(64),
    pairedAt: new Date(Date.now() - 600000), lastSeenAt: new Date(Date.now() - 5000),
    revoked: false, uninstalledAt: null, supersededBy: null, ...over,
  });

  test('no input shape produces a falsy state, so "unknown" can never come from here', () => {
    const cases = [
      null, undefined, dev(), dev({ revoked: true }), dev({ uninstalledAt: new Date() }),
      dev({ supersededBy: 'other' }), dev({ lastSeenAt: null }),
      dev({ lastSeenAt: new Date(Date.now() - 3600000) }), dev({ lastResultCode: 'ACCOUNT_MISMATCH' }),
    ];
    for (const d of cases) {
      const st = deviceState.stateOf({ ...account, syncDevices: d ? [d] : [] }, d, { staleMs: 600000 });
      assert.ok(st && typeof st.state === 'string' && st.state.length > 0,
        `stateOf returned no usable state for ${JSON.stringify(d && d.lastResultCode)}`);
      assert.ok(st.reason && st.reason.length > 0, 'every state must carry an operator-facing reason');
    }
  });

  test('publicDevice does NOT carry state — the route must add it', () => {
    // This is why a backend older than the decoration shows every other field correctly and only
    // the state badge as "unknown".
    const view = deviceSync.publicDevice(dev(), null, 600000);
    assert.ok(view, 'publicDevice returned nothing');
    assert.equal(view.state, undefined,
      'if publicDevice ever gains `state`, update this test and the diagnosis in its header');
    // …while the fields the screenshot renders fine DO come from here.
    for (const f of ['hostname', 'agentVersion', 'promotionCount', 'lastSyncSuccessAt', 'isActiveSource']) {
      assert.ok(f in view, `publicDevice must keep exposing ${f}`);
    }
  });
});

describe('the agent-state route decorates every row it returns', () => {
  test('state, stateReason, terminal and canActivate are all attached', () => {
    for (const field of ['dv.state = st.state', 'dv.stateReason = st.reason',
      'dv.terminal = st.terminal', 'dv.canActivate = deviceState.canActivate(st.state)']) {
      assert.ok(ROUTE.includes(field), `the decoration pass must set ${field}`);
    }
  });

  test('the decoration runs over the FULL list, before any filtering', () => {
    const decorate = ROUTE.indexOf('deviceViewsAll.forEach');
    const filter = ROUTE.indexOf('deviceViewsAll.filter');
    assert.ok(decorate > -1 && filter > -1, 'the decorate/filter pair moved');
    assert.ok(decorate < filter,
      'every row must be decorated before superseded rows are dropped, or a returned row can lack state');
  });

  test('isActiveSource and activeSource stay distinct from device state', () => {
    // The screenshot conflates them easily: a device can be the active source AND offline.
    // isActiveSource is set by publicDevice (deviceSync.js), not by the route's decoration — so
    // it survives even on a backend too old to attach `state`, which is exactly what the
    // screenshot shows: the active-source marker renders while the state badge does not.
    const SYNC = fs.readFileSync(path.join(BACKEND, 'utils', 'proxy', 'deviceSync.js'), 'utf8');
    assert.match(SYNC, /isActiveSource: dev\.deviceId === activeDeviceId/);
    const st = deviceState.stateOf(
      { activeSource: { deviceId: 'agent_x' }, syncDevices: [] },
      { deviceId: 'agent_x', lastSeenAt: new Date(Date.now() - 86400000) }, { staleMs: 600000 });
    assert.equal(st.isActiveSource, true, 'active-source membership is independent of liveness');
    assert.equal(st.state, 'OFFLINE', 'and an active source can still be OFFLINE');
  });
});

describe('the two freshness thresholds are separate, and 47 minutes is not stale', () => {
  test('SYNC_STALE_MIN defaults to 90 minutes, AGENT_STALE_MIN to 10', () => {
    assert.match(ROUTE, /SYNC_STALE_MIN = Number\(process\.env\.PROXY_SYNC_STALE_MIN \|\| 90\)/);
    assert.match(ROUTE, /AGENT_STALE_MIN = Number\(process\.env\.PROXY_AGENT_STALE_MIN \|\| 10\)/);
  });

  test('a 47-minute-old cookie sync is INSIDE the default window', () => {
    const sessionHealth = require('../utils/proxy/sessionHealth');
    const src = fs.readFileSync(path.join(BACKEND, 'utils', 'proxy', 'sessionHealth.js'), 'utf8');
    assert.match(src, /num\(cookieSyncStaleSec\) \|\| 90 \* 60/,
      'the cookie-sync classifier must keep its 90-minute default');
    assert.ok(47 * 60 < 90 * 60, 'arithmetic guard: 47m is inside a 90m window');
    void sessionHealth;
  });

  test('agent liveness is driven by heartbeat age, NOT by sync age', () => {
    // Conflating them is how a healthy agent gets labelled stale, or a dead one fresh.
    const fresh = { deviceId: 'a', lastSeenAt: new Date(Date.now() - 60000),
      lastSyncSuccessAt: new Date(Date.now() - 47 * 60000) };
    assert.equal(deviceSync.isOnline(fresh, 10 * 60000), true,
      'a 47-minute-old SYNC with a 1-minute-old heartbeat is still online');
    const quiet = { deviceId: 'a', lastSeenAt: new Date(Date.now() - 47 * 60000),
      lastSyncSuccessAt: new Date(Date.now() - 60000) };
    assert.equal(deviceSync.isOnline(quiet, 10 * 60000), false,
      'and a recent sync does not make a silent agent online');
  });
});
