/**
 * ONE EXTENSION CONNECTION OWNER — failure-first regressions.
 *
 * useExtension() is called from four places that can be mounted at the same time: Zee's
 * ClientGuideProvider (app-wide in the client layout), ClientDashboardEnhanced, ClientToolDetail
 * and ClientActivity. While its state lived in the hook, each mounted caller ran its own 500ms
 * bridge poll, its own auto-connect loop and its own in-flight connect guard — so the comment
 * "prevent duplicate activation-token consumption during multiple heartbeats" protected only one
 * caller at a time. Two callers minted two single-use activation tokens concurrently, and each
 * escalated independently to `forceReauth: true`, which exists to DISCARD stored
 * activation-token/device-binding state. One owner could therefore revoke the authorization
 * another had just established.
 *
 * These tests mount real components through a real React root. The ones that matter — "only one
 * activation token", "only one poll", "only one forceReauth escalation" — fail against the
 * per-instance implementation and pass against the shared owner. They are not source-string
 * guards: nothing here reads the hook's text.
 *
 * The bridge is replaced at `window.postMessage`, not left to jsdom's own delivery, so no
 * assertion depends on whether a queued jsdom task survives jest's fake timers.
 */
/* eslint-env jest */
jest.mock('../../services/api', () => ({
  __esModule: true,
  default: { post: jest.fn(), get: jest.fn(), put: jest.fn() },
}));

global.IS_REACT_ACT_ENVIRONMENT = true;

// Everything is required ONCE, at the top. jest.resetModules() cannot be used to isolate the
// owner: clearing the registry would give react-dom a different copy of React from the one this
// file holds, the effects would never run, and every assertion about refcounts would read zero.
// The module instead exposes a hard reset, called in beforeEach.
const React = require('react');
const { act } = require('react');
const { createRoot } = require('react-dom/client');
const api = require('../../services/api').default;
const mod = require('../useExtension');

// ── a controllable stand-in for bridge.js ────────────────────────────────────────────────────
function installBridge() {
  const sent = [];
  const bridge = {
    sent,
    // Default: installed, not connected — which is what drives the auto-connect loop.
    status: { connected: false, version: '3.9.36', toolCount: 0 },
    connect: { success: true, version: '3.9.36', toolCount: 2 },
    open: { success: true },
    // Withhold replies until release() — a slow or late response. `holdTypes` holds only the
    // named message types: holding everything also blocks the status call that openTool awaits
    // first, so the guard under test would never be reached.
    hold: false,
    holdTypes: null,
    pending: [],
    holdOnly(...types) { bridge.holdTypes = new Set(types); },
    handle(msg) {
      if (!msg || msg.source !== 'GENZ_DIGITAL_STORE_DASHBOARD') return;
      sent.push(msg);
      let payload;                                   // snapshotted at request time
      if (msg.type === 'GENZ_GET_EXTENSION_STATUS') payload = { ...bridge.status };
      else if (msg.type === 'GENZ_CONNECT_EXTENSION') payload = { ...bridge.connect };
      else if (msg.type === 'GENZ_OPEN_TOOL') payload = { ...bridge.open };
      else payload = { success: true };
      const reply = () => {
        window.dispatchEvent(new MessageEvent('message', {
          data: { type: `${msg.type}_RESPONSE`, requestId: msg.requestId, ...payload },
          source: window,
        }));
      };
      const held = bridge.holdTypes ? bridge.holdTypes.has(msg.type) : bridge.hold;
      if (held) bridge.pending.push(reply); else reply();
    },
    release() { const p = bridge.pending.splice(0); for (const r of p) r(); },
    countOf(type) { return sent.filter((m) => m.type === type).length; },
  };
  window.postMessage = (msg) => bridge.handle(msg);
  return bridge;
}

const deferred = () => {
  let resolve, reject;
  const promise = new Promise((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
};

let bridge, roots;

let lastExt = null;
function Consumer({ name, onRender }) {
  const ext = mod.useExtension();
  lastExt = ext;
  if (onRender) onRender(name, ext);
  return React.createElement('div', { 'data-name': name }, String(ext.status.connected));
}
// Call the hook's own openTool, exactly as a component would.
const openViaHook = (toolId) => lastExt.openTool(toolId);

async function mount(element) {
  const container = document.createElement('div');
  document.body.appendChild(container);
  const root = createRoot(container);
  await act(async () => { root.render(element); });
  const entry = { root, container, unmount: async () => { await act(async () => { root.unmount(); }); } };
  roots.push(entry);
  return entry;
}

const tick = async (ms = 0) => { await act(async () => { jest.advanceTimersByTime(ms); await Promise.resolve(); }); };

beforeEach(() => {
  jest.useFakeTimers();
  roots = [];
  document.body.innerHTML = '';
  document.documentElement.setAttribute('data-genz-extension-ready', 'true');
  bridge = installBridge();
  mod.__resetExtensionOwnerForTest();
  api.post.mockReset();
  api.post.mockResolvedValue({ data: { activationToken: 'tok' } });
});

afterEach(async () => {
  for (const r of roots) { try { await r.unmount(); } catch (_) {} }
  mod.__resetExtensionOwnerForTest();
  jest.useRealTimers();
  document.documentElement.removeAttribute('data-genz-extension-ready');
});

// ── A. one owner, whatever is mounted ────────────────────────────────────────────────────────
test('four simultaneously mounted callers share ONE owner, one poll and one auto-connect loop', async () => {
  await mount(React.createElement(React.Fragment, null,
    React.createElement(Consumer, { key: 'a', name: 'zee' }),
    React.createElement(Consumer, { key: 'b', name: 'dashboard' }),
    React.createElement(Consumer, { key: 'c', name: 'toolDetail' }),
    React.createElement(Consumer, { key: 'd', name: 'activity' }),
  ));
  const s = mod.__extensionOwnerForTest();
  expect(s.refs).toBe(4);
  expect(s.subs).toBeGreaterThanOrEqual(4);
  expect(s.wired).toBe(true);
  expect(s.hasPoll).toBe(true);
  expect(s.autoRunning).toBe(true);
});

test('the bridge poll runs once per interval in total, not once per mounted caller', async () => {
  await mount(React.createElement(React.Fragment, null,
    React.createElement(Consumer, { key: 'a', name: 'zee' }),
    React.createElement(Consumer, { key: 'b', name: 'dashboard' }),
    React.createElement(Consumer, { key: 'c', name: 'toolDetail' }),
  ));
  const before = bridge.countOf('GENZ_GET_EXTENSION_STATUS');
  await tick(500);
  const added = bridge.countOf('GENZ_GET_EXTENSION_STATUS') - before;
  // One poll tick => one status request. Three independent polls would add three (or more).
  expect(added).toBeLessThanOrEqual(1);
});

// ── B. the defect that could revoke a live authorization ─────────────────────────────────────
test('two mounted callers never mint two activation tokens concurrently', async () => {
  const d = deferred();
  api.post.mockReturnValue(d.promise);               // hold the activation token in flight
  await mount(React.createElement(React.Fragment, null,
    React.createElement(Consumer, { key: 'a', name: 'zee' }),
    React.createElement(Consumer, { key: 'b', name: 'dashboard' }),
  ));
  await tick(0);
  expect(api.post).toHaveBeenCalledTimes(1);
  expect(api.post.mock.calls[0][0]).toBe('/client/extension/activation-token');
  d.resolve({ data: { activationToken: 'tok' } });
  await tick(0);
});

test('a concurrent connect from a second caller joins the in-flight one instead of re-minting', async () => {
  const d = deferred();
  api.post.mockReturnValue(d.promise);
  await mount(React.createElement(Consumer, { name: 'dashboard' }));
  await tick(0);
  const before = api.post.mock.calls.length;
  expect(mod.__extensionOwnerForTest().inFlightConnect).toBe(true);

  // Two more callers ask to connect while one is already in flight. Both must join it; neither may
  // mint a second single-use activation token, because minting one invalidates the first.
  // Kick off two more connects. They are intentionally never awaited here: the activation token
  // is held in flight, so awaiting them would just time out. What matters is the call count.
  const extra = [lastExt.connectExtension().catch(() => {}), lastExt.connectExtension().catch(() => {})];
  await act(async () => { await Promise.resolve(); });
  expect(api.post.mock.calls.length).toBe(before);
  expect(mod.__extensionOwnerForTest().inFlightConnect).toBe(true);

  d.resolve({ data: { activationToken: 'tok' } });
  await act(async () => { await Promise.all(extra); });

});

test('only ONE forceReauth escalation happens per failure round, not one per caller', async () => {
  // Every connect attempt fails, so the loop escalates past AUTO_CONNECT_FORCE_REAUTH_AFTER (3).
  bridge.connect = { success: false, error: 'backend_rejected_extension_token' };
  await mount(React.createElement(React.Fragment, null,
    React.createElement(Consumer, { key: 'a', name: 'zee' }),
    React.createElement(Consumer, { key: 'b', name: 'dashboard' }),
  ));
  await tick(0);
  for (const ms of [1500, 3000, 6000, 12000]) { await tick(ms); }
  const forced = api.post.mock.calls.filter((c) => c[1] && c[1].forceReauth === true);
  const rounds = api.post.mock.calls.length;
  // With two independent loops each attempt is made twice; with one owner each attempt is made once.
  expect(forced.length).toBeLessThanOrEqual(Math.ceil(rounds / 2) + 1);
  expect(rounds).toBeLessThanOrEqual(6);
});

// ── C. lifecycle: routes, the assistant opening and closing, StrictMode ──────────────────────
test('a route change (unmount then immediate remount) does NOT restart the owner', async () => {
  const a = await mount(React.createElement(Consumer, { name: 'dashboard' }));
  const genBefore = mod.__extensionOwnerForTest().gen;
  await a.unmount();
  expect(mod.__extensionOwnerForTest().hasStopTimer).toBe(true);   // scheduled, not yet stopped
  await mount(React.createElement(Consumer, { name: 'activity' })); // navigate within the grace window
  const s = mod.__extensionOwnerForTest();
  expect(s.wired).toBe(true);
  expect(s.hasStopTimer).toBe(false);                               // teardown cancelled
  expect(s.gen).toBe(genBefore);                                    // same lifecycle, no reset
});

test('opening and closing the assistant alongside the dashboard keeps exactly one owner', async () => {
  const dash = await mount(React.createElement(Consumer, { name: 'dashboard' }));
  expect(mod.__extensionOwnerForTest().refs).toBe(1);
  const zee = await mount(React.createElement(Consumer, { name: 'zee' }));
  expect(mod.__extensionOwnerForTest().refs).toBe(2);
  const polls = bridge.countOf('GENZ_GET_EXTENSION_STATUS');
  await tick(500);
  expect(bridge.countOf('GENZ_GET_EXTENSION_STATUS') - polls).toBeLessThanOrEqual(1);
  await zee.unmount();
  const s = mod.__extensionOwnerForTest();
  expect(s.refs).toBe(1);
  expect(s.wired).toBe(true);      // the dashboard still owns it
  expect(dash).toBeDefined();
});

test('StrictMode double-mounting leaves one owner with correct refcounting', async () => {
  await mount(React.createElement(React.StrictMode, null, React.createElement(Consumer, { name: 'dashboard' })));
  const s = mod.__extensionOwnerForTest();
  expect(s.wired).toBe(true);
  expect(s.refs).toBeGreaterThanOrEqual(1);
  expect(s.hasPoll).toBe(true);
  const polls = bridge.countOf('GENZ_GET_EXTENSION_STATUS');
  await tick(500);
  // A second surviving interval from the discarded first mount would double this.
  expect(bridge.countOf('GENZ_GET_EXTENSION_STATUS') - polls).toBeLessThanOrEqual(1);
});

test('the loops stop once the last caller has been gone for the grace period', async () => {
  const a = await mount(React.createElement(Consumer, { name: 'dashboard' }));
  await a.unmount();
  await tick(2500);
  const s = mod.__extensionOwnerForTest();
  expect(s.refs).toBe(0);
  expect(s.wired).toBe(false);
  expect(s.hasPoll).toBe(false);
  expect(s.hasRetry).toBe(false);
  expect(s.autoRunning).toBe(false);
});

// ── D. logout and account switching must not be overwritten by a late reply ──────────────────
test('a bridge reply that lands after logout cannot write the previous client\'s state', async () => {
  await mount(React.createElement(Consumer, { name: 'dashboard' }));
  bridge.status = { connected: true, version: '3.9.36', toolCount: 7 };
  bridge.holdOnly('GENZ_GET_EXTENSION_STATUS');   // a status reply is now in flight, carrying 7
  await tick(500);
  expect(bridge.pending.length).toBeGreaterThan(0);

  mod.resetExtensionOwner();                      // logout / account switch
  const gen = mod.__extensionOwnerForTest().gen;
  expect(gen).toBeGreaterThan(0);

  // The next client's bridge reports something different, so "7 / connected" can only come from
  // the reply that belonged to the previous lifecycle.
  bridge.status = { connected: false, version: '3.9.37', toolCount: 0 };
  bridge.holdTypes = null;
  await act(async () => { bridge.release(); await Promise.resolve(); });

  // The reply belonged to the previous lifecycle. It must not reappear as the new one's state.
  const after = mod.__extensionOwnerForTest();
  expect(after.gen).toBe(gen);
  expect(after.status.connected).not.toBe(true);
  expect(after.status.toolCount).not.toBe(7);
  // The state that IS there came from the new lifecycle's own read, not from the dropped reply.
  expect(after.status.version).not.toBe('3.9.36');
});

test('resetExtensionOwner clears the in-flight connect, the attempt count and the opening map', async () => {
  const d = deferred();
  api.post.mockReturnValue(d.promise);
  await mount(React.createElement(Consumer, { name: 'dashboard' }));
  await tick(0);
  expect(mod.__extensionOwnerForTest().inFlightConnect).toBe(true);

  mod.resetExtensionOwner();
  const s = mod.__extensionOwnerForTest();
  expect(s.inFlightConnect).toBe(false);
  expect(s.opening).toEqual([]);
  expect(s.gen).toBeGreaterThan(0);
  d.resolve({ data: { activationToken: 'tok' } });
  await tick(0);
});

test('the already_opening guard is SHARED, so two callers cannot double-open one tool', async () => {
  bridge.status = { connected: true, version: '3.9.36' };
  await mount(React.createElement(Consumer, { name: 'dashboard' }));
  await tick(0);
  bridge.holdOnly('GENZ_OPEN_TOOL');                   // status still answers; the open does not
  let second;
  const p1 = (async () => { second = await openViaHook('42'); })();
  await act(async () => { await Promise.resolve(); });
  const r2 = await openViaHook('42');
  expect(r2).toEqual({ success: false, error: 'already_opening' });
  bridge.holdTypes = null;
  await act(async () => { bridge.release(); await Promise.resolve(); });
  await act(async () => { await p1; });
  expect(second).toBeDefined();
});

test('an account switch leaves no stale already_opening entry to block the next client', async () => {
  bridge.status = { connected: true, version: '3.9.36' };
  await mount(React.createElement(Consumer, { name: 'dashboard' }));
  await tick(0);
  bridge.holdOnly('GENZ_OPEN_TOOL');
  const inflight = openViaHook('42').catch(() => {});
  await act(async () => { await Promise.resolve(); });
  expect(mod.__extensionOwnerForTest().opening).toContain('42');

  mod.resetExtensionOwner();                           // the next client must not inherit this
  expect(mod.__extensionOwnerForTest().opening).toEqual([]);
  bridge.holdTypes = null;
  await act(async () => { bridge.release(); await Promise.resolve(); });
  await act(async () => { await inflight; });
});

// ── E. the shared state actually reaches every caller ────────────────────────────────────────
test('one bridge event updates every mounted caller', async () => {
  const seen = [];
  await mount(React.createElement(React.Fragment, null,
    React.createElement(Consumer, { key: 'a', name: 'zee', onRender: (n, e) => seen.push([n, e.status.connected]) }),
    React.createElement(Consumer, { key: 'b', name: 'dashboard', onRender: (n, e) => seen.push([n, e.status.connected]) }),
  ));
  await act(async () => {
    window.dispatchEvent(new MessageEvent('message', {
      data: { type: 'GENZ_EXTENSION_CONNECTED' }, source: window,
    }));
    await Promise.resolve();
  });
  const last = new Map();
  for (const [n, c] of seen) last.set(n, c);
  expect(last.get('zee')).toBe(true);
  expect(last.get('dashboard')).toBe(true);
});

test('the returned callbacks are stable, so consumer effects do not re-run every render', async () => {
  const refs = [];
  await mount(React.createElement(Consumer, { name: 'dashboard', onRender: (n, e) => refs.push(e.openTool) }));
  await tick(500);
  expect(refs.length).toBeGreaterThan(1);
  expect(new Set(refs).size).toBe(1);
});

// ── F. a disconnect must restart the dormant auto-connect loop ───────────────────────────────
// The loop stops after a successful connect so a second chain cannot start. The per-caller
// implementation covered the aftermath by accident — every mount created another auto-connect
// effect, so a disconnect plus a route change happened to retry. One shared owner has no such
// accident, so the disconnect signal has to resume it explicitly.
test('a disconnect while the tab stays open resumes auto-connecting', async () => {
  bridge.status = { connected: true, version: '3.9.37', toolCount: 2 };
  await mount(React.createElement(Consumer, { name: 'dashboard' }));
  await tick(0);
  expect(mod.__extensionOwnerForTest().status.connected).toBe(true);
  const before = api.post.mock.calls.length;

  // The extension drops its connection; the next status read reports it.
  bridge.status = { connected: false, version: '3.9.37' };
  await act(async () => {
    window.dispatchEvent(new MessageEvent('message', {
      data: { type: 'GENZ_EXTENSION_DISCONNECTED', reason: 'worker_restarted' }, source: window,
    }));
    await Promise.resolve();
  });
  await tick(0);

  expect(api.post.mock.calls.length).toBeGreaterThan(before);
  expect(api.post.mock.calls.at(-1)[0]).toBe('/client/extension/activation-token');
});

test('resuming after a disconnect does not leave two retry chains running', async () => {
  bridge.connect = { success: false, error: 'backend_rejected_extension_token' };
  await mount(React.createElement(Consumer, { name: 'dashboard' }));
  await tick(0);
  await tick(1500);
  const mid = api.post.mock.calls.length;

  // Two disconnects in a row must not multiply the loop.
  for (let i = 0; i < 2; i += 1) {
    await act(async () => {
      window.dispatchEvent(new MessageEvent('message', {
        data: { type: 'GENZ_EXTENSION_DISCONNECTED', reason: 'flap' }, source: window,
      }));
      await Promise.resolve();
    });
  }
  await tick(0);
  const afterResume = api.post.mock.calls.length;
  await tick(1500);
  const added = api.post.mock.calls.length - afterResume;
  // One chain => at most one attempt per backoff window. Two chains would double it.
  expect(added).toBeLessThanOrEqual(1);
  expect(mid).toBeGreaterThan(0);
});

// ── G. the bridge probe must not be a one-shot ────────────────────────────────────────────────
// The extension can be loaded, reloaded or UPDATED after the page is already open, and bridge.js
// can signal readiness only by setting data-genz-extension-ready — a marker that nothing but this
// polling reads. The per-caller implementation restarted the probe on every mount, so navigating
// re-detected it. One shared owner probes once, which left bridgeReady false forever and made
// openTool answer "Extension not detected" with the extension sitting right there.
test('an extension that appears AFTER the probe lapsed is still detected on the next mount', async () => {
  document.documentElement.removeAttribute('data-genz-extension-ready');
  window.postMessage = () => {};                       // no bridge at all yet
  const a = await mount(React.createElement(Consumer, { name: 'dashboard' }));
  await tick(31000);                                   // exhaust the 60-attempt probe
  expect(mod.__extensionOwnerForTest().hasPoll).toBe(false);
  expect(mod.__extensionOwnerForTest().bridgeReady).toBe(false);

  // The client now loads/updates the extension: the marker appears and the bridge answers.
  document.documentElement.setAttribute('data-genz-extension-ready', 'true');
  bridge = installBridge();

  await mount(React.createElement(Consumer, { name: 'toolDetail' }));   // a route change
  await tick(600);
  expect(mod.__extensionOwnerForTest().bridgeReady).toBe(true);
  expect(a).toBeDefined();
});

test('the probe stops itself once the bridge is ready, leaving exactly one', async () => {
  await mount(React.createElement(Consumer, { name: 'dashboard' }));
  await tick(600);
  expect(mod.__extensionOwnerForTest().bridgeReady).toBe(true);
  expect(mod.__extensionOwnerForTest().hasPoll).toBe(false);
  // Mounting again must not start a probe when there is nothing to look for.
  await mount(React.createElement(Consumer, { name: 'activity' }));
  expect(mod.__extensionOwnerForTest().hasPoll).toBe(false);
});

test('openTool rechecks before claiming the extension is missing', async () => {
  document.documentElement.removeAttribute('data-genz-extension-ready');
  window.postMessage = () => {};
  await mount(React.createElement(Consumer, { name: 'dashboard' }));
  await tick(31000);
  expect(mod.__extensionOwnerForTest().bridgeReady).toBe(false);

  // The bridge is alive by the time Access is clicked, even though the probe had lapsed.
  bridge = installBridge();
  bridge.status = { connected: true, version: '3.9.37' };
  const result = await openViaHook('42');
  expect(result.error).not.toBe('extension_not_detected');
});

test('a genuinely absent extension still reports not detected, and re-arms the probe', async () => {
  document.documentElement.removeAttribute('data-genz-extension-ready');
  window.postMessage = () => {};
  await mount(React.createElement(Consumer, { name: 'dashboard' }));
  await tick(31000);
  // openTool's last-chance refreshStatus waits on the bridge's own 5s timeout, so the clock has to
  // be advanced while that call is in flight rather than awaited first.
  let result;
  const pending = openViaHook('42').then((r) => { result = r; });
  await tick(6000);
  await act(async () => { await pending; });
  expect(result).toEqual({
    success: false,
    error: 'extension_not_detected',
    message: 'Extension not detected. Reload the extension, then refresh the dashboard.',
  });
  expect(mod.__extensionOwnerForTest().hasPoll).toBe(true);   // looking again from now on
});

// ── H. the real reason must reach the operator ────────────────────────────────────────────────
// "Could not open tool: Extension error" is a fallback, not a diagnosis. background.js's login
// catch returns `error: error.message`, and `new Error(undefined).message` is the empty string, so
// a message-less throw arrived with `error` falsy. sendToBridge then kept only `error` and threw
// away the stage, code and human message the extension had already worked out.
const openWith = async (reply) => {
  bridge.status = { connected: true, version: '3.9.37' };
  bridge.open = reply;
  await mount(React.createElement(Consumer, { name: 'dashboard' }));
  await tick(0);
  return openViaHook('42');
};

test('a reply with no error code but a stage and message reports THOSE, not "Extension error"', async () => {
  const r = await openWith({
    success: false,
    stage: 'no_active_session',
    message: 'No active session assigned for this tool. Please refresh or assign account from admin.',
  });
  expect(r.error).toBe('no_active_session');
  expect(r.message).toBe('No active session assigned for this tool. Please refresh or assign account from admin.');
  expect(r.message).not.toMatch(/Extension error/);
});

test('a reply carrying only actionableError uses that wording', async () => {
  const r = await openWith({ success: false, actionableError: 'Login failed unexpectedly. Please try again or contact support.' });
  expect(r.message).toBe('Login failed unexpectedly. Please try again or contact support.');
  expect(r.message).not.toMatch(/Extension error/);
});

test('a business stage arriving in `stage` is final — it is not retried as an auth error', async () => {
  const r = await openWith({ success: false, stage: 'tool_access_expired' });
  expect(r.error).toBe('tool_access_expired');
  // One open attempt only: a business stage must not trigger the reconnect-and-retry path.
  expect(bridge.countOf('GENZ_OPEN_TOOL')).toBe(1);
  expect(bridge.countOf('GENZ_CONNECT_EXTENSION')).toBe(0);
});

test('an explicit error code still behaves exactly as before', async () => {
  const r = await openWith({ success: false, error: 'session_bundle_missing' });
  expect(r.error).toBe('session_bundle_missing');
  expect(r.message).toMatch(/not available yet|contact admin/i);
});

test('a truly empty failure still says something, and never the bare fallback as the whole message', async () => {
  const r = await openWith({ success: false });
  expect(r.success).toBe(false);
  expect(r.message).not.toBe('Could not open tool: Extension error');
});
