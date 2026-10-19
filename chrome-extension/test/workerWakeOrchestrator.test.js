/**
 * THE ACCESS CRASH: "Could not open tool: Cannot read properties of null (reading 'executeLogin')"
 *
 * WHAT THE CLIENT DID. Clicked Access on a tool card. The dashboard posted GENZ_OPEN_TOOL to the
 * extension, the MV3 service worker woke up to deliver it, and the open flow dereferenced a null
 * orchestrator.
 *
 * WHY. background.js holds `let orchestrator = null` and assigns it in `initialize()`, which is
 * wired to `chrome.runtime.onInstalled` and `chrome.runtime.onStartup` — and to nothing else; the
 * module tail says so explicitly ("Initialization handled by onInstalled and onStartup listeners
 * only"). A service worker that Chrome terminated after idle and then woke to deliver a MESSAGE
 * receives NEITHER lifecycle event, so every `orchestrator.executeLogin(...)` call site runs
 * against null. There are four of them.
 *
 * HOW THIS TEST REPRODUCES IT — and why it is not just "call initialize() first".
 * A fresh ES-module instance of background.js IS a fresh worker spin-up: the module body runs, the
 * listeners register, and no lifecycle event has fired. The test then drives the REAL
 * chrome.runtime.onMessage listener that the module registered, with the real GENZ_OPEN_TOOL
 * message, through the real handleOpenTool flow, over a mocked chrome API and a mocked fetch. A
 * second import with a different cache-buster is the next wake.
 *
 * `initialize()` is deliberately NEVER called in the wake cases. Calling it is what the production
 * bug cannot rely on.
 *
 * WHAT IS MOCKED, AND WHAT IS NOT. chrome.* and global fetch are mocked — they are the browser and
 * the server. Everything between the message arriving and the orchestrator being used is the
 * shipped code, including handleOpenTool, the duplicate-open lock, the credential fetch, the
 * version-signature check and the cookie/tab work.
 */
const test = require('node:test');
const { describe, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

// WHICH EXTENSION TREE IS UNDER TEST.
//
// By default, this repository's chrome-extension/. Set EXT_DIR to point the SAME handler
// regressions at a different tree — specifically at the EXACT released package, extracted from the
// ZIP a client downloads. That matters here: the shipped v3.9.36 was patched from a v3.9.35 tree
// that is not in this repository (29 files differ, 10 are live-only), so a pass against the repo
// source says nothing about the artifact clients run.
//
// Running against an extracted package exercises its real background.js and its real imports.
// It is still a MOCKED-handler test: it does not open Chrome, does not terminate a real worker and
// does not log in to a provider. Real-browser acceptance is a separate, manual step.
const EXT = process.env.EXT_DIR ? path.resolve(process.env.EXT_DIR) : path.join(__dirname, '..');
const BG_URL = pathToFileURL(path.join(EXT, 'js', 'background.js')).href;
const RAW_BG = path.join(EXT, 'js', 'background.js');
const ORCH_URL = pathToFileURL(path.join(EXT, 'js', 'core', 'LoginOrchestrator.js')).href;

const TOOL_ID = '501';
const TOOL = {
  id: TOOL_ID,
  name: 'Write Human',
  domain: 'writehuman.ai',
  targetUrl: 'https://writehuman.ai/',
  credentialVersion: 3,
};

// ── the browser ───────────────────────────────────────────────────────────────────────────────
// Explicit for everything the open path touches; a Proxy catches anything else so an unmocked
// corner returns a harmless promise instead of masking the result with a TypeError.
function installChrome() {
  const listeners = new Map();          // 'runtime.onMessage' -> [fn]
  const store = {
    apiUrl: 'https://api.example.com',
    extensionToken: 'ext-token-fixture',
    deviceId: 'device-fixture',
    tools: [TOOL],
  };
  const created = [];
  const add = (key) => ({
    addListener: (fn) => { if (!listeners.has(key)) listeners.set(key, []); listeners.get(key).push(fn); },
    removeListener: (fn) => {
      const a = listeners.get(key) || [];
      const i = a.indexOf(fn); if (i > -1) a.splice(i, 1);
    },
    hasListener: (fn) => (listeners.get(key) || []).includes(fn),
  });
  // BOTH call forms. background.js wraps the CALLBACK form —
  //   getStorage = (keys) => new Promise(r => chrome.storage.local.get(keys, r))
  // — so a promise-only mock makes every storage read hang forever and the message handler never
  // answers, which is a property of the mock and not of the code under test.
  const dual = (compute) => (arg, cb) => {
    const value = compute(arg);
    if (typeof cb === 'function') { cb(value); return undefined; }
    return Promise.resolve(value);
  };
  const area = () => ({
    get: dual((keys) => {
      if (keys == null) return { ...store };
      const list = Array.isArray(keys) ? keys : typeof keys === 'string' ? [keys] : Object.keys(keys);
      const out = {};
      for (const k of list) if (k in store) out[k] = store[k];
      return out;
    }),
    set: dual((obj) => { Object.assign(store, obj || {}); return undefined; }),
    remove: dual((keys) => { for (const k of (Array.isArray(keys) ? keys : [keys])) delete store[k]; return undefined; }),
    clear: dual(() => { for (const k of Object.keys(store)) delete store[k]; return undefined; }),
  });
  const chrome = {
    runtime: {
      id: 'fixture-extension-id',
      lastError: null,
      getManifest: () => ({ version: '3.9.25' }),
      getURL: (p) => `chrome-extension://fixture/${p}`,
      sendMessage: async () => ({}),
      onInstalled: add('runtime.onInstalled'),
      onStartup: add('runtime.onStartup'),
      onMessage: add('runtime.onMessage'),
      onMessageExternal: add('runtime.onMessageExternal'),
      onConnect: add('runtime.onConnect'),
      onSuspend: add('runtime.onSuspend'),
    },
    storage: { local: area(), session: area(), sync: area(), onChanged: add('storage.onChanged') },
    alarms: {
      create: async () => {}, clear: async () => true, clearAll: async () => true,
      get: async () => null, getAll: async () => [], onAlarm: add('alarms.onAlarm'),
    },
    tabs: {
      create: async (opts) => { const t = { id: 900 + created.length, status: 'complete', url: opts?.url }; created.push(t); return t; },
      // Both forms: the open flow awaits it AND waitForTabLoad passes a callback.
      get: (id, cb) => { const t = { id, status: 'complete', url: TOOL.targetUrl }; if (cb) { cb(t); return undefined; } return Promise.resolve(t); },
      query: async () => [{ id: 901, url: TOOL.targetUrl, active: true }],
      update: async () => ({ id: 901 }), reload: async () => {}, remove: async () => {},
      sendMessage: async () => ({}),
      onUpdated: add('tabs.onUpdated'), onRemoved: add('tabs.onRemoved'), onActivated: add('tabs.onActivated'),
    },
    cookies: {
      getAll: async () => [], set: async () => ({}), remove: async () => ({}),
      onChanged: add('cookies.onChanged'),
    },
    scripting: {
      executeScript: async () => [{ result: null }],
      registerContentScripts: async () => {}, unregisterContentScripts: async () => {},
      getRegisteredContentScripts: async () => [],
    },
    permissions: { contains: async () => true, request: async () => true, getAll: async () => ({ origins: [] }) },
    webNavigation: { onCommitted: add('webNavigation.onCommitted'), onCompleted: add('webNavigation.onCompleted') },
    action: { setBadgeText: async () => {}, setBadgeBackgroundColor: async () => {}, setTitle: async () => {}, setIcon: async () => {}, onClicked: add('action.onClicked') },
    notifications: { create: async () => 'n1', clear: async () => true, onClicked: add('notifications.onClicked') },
    windows: { create: async () => ({ id: 1 }), update: async () => ({}), getCurrent: async () => ({ id: 1 }) },
    idle: { queryState: async () => 'active', setDetectionInterval: () => {}, onStateChanged: add('idle.onStateChanged') },
  };
  const fallback = (p) => new Proxy(function fn() {}, {
    get: (_t, k) => (k === 'then' ? undefined : fallback(`${p}.${String(k)}`)),
    apply: () => (p.endsWith('addListener') || p.endsWith('removeListener') ? undefined : Promise.resolve(undefined)),
  });
  globalThis.chrome = new Proxy(chrome, {
    get: (t, k) => (k in t ? t[k] : fallback(String(k))),
  });
  return { listeners, store, created };
}

// ── the server ────────────────────────────────────────────────────────────────────────────────
// Answers only what this path asks for. `credentials.type: 'form'` is what makes the flow
// INTERACTIVE, which is the branch that reaches the orchestrator — a cookies-only answer would
// return early at session_bundle and prove nothing about this crash.
function installFetch() {
  const calls = [];
  globalThis.fetch = async (url, opts) => {
    const u = String(url);
    calls.push({ url: u, method: opts?.method || 'GET' });
    const json = (body, status = 200) => ({
      ok: status < 400, status, statusText: 'OK',
      headers: { get: () => 'application/json' },
      json: async () => body,
      text: async () => JSON.stringify(body),
    });
    if (u.includes('/extension/tools/versions')) {
      return json({ success: true, versions: { [TOOL_ID]: { assignmentId: 'a1', version: 3, bundleVersion: 7, bundleUpdatedAt: '2026-10-18T00:00:00Z' } } });
    }
    if (u.includes(`/extension/tools/${TOOL_ID}/credentials`)) {
      return json({
        success: true,
        tool: TOOL,
        credentials: { type: 'form', username: 'u', password: 'p' },
      });
    }
    if (u.includes('/extension/tools')) return json({ success: true, tools: [TOOL] });
    return json({ success: true });
  };
  return calls;
}

/**
 * Boot a FRESH worker: a new module instance, listeners registered, and NO lifecycle event.
 * `wave` is the cache-buster — a different value is a different spin-up.
 */
async function wakeWorker(wave) {
  const env = installChrome();
  const fetchCalls = installFetch();
  const mod = await import(`${BG_URL}?worker=${wave}`);
  const handlers = env.listeners.get('runtime.onMessage') || [];
  assert.ok(handlers.length >= 1, 'the module must register its message listener synchronously on load');
  return { ...env, fetchCalls, mod, handlers };
}

/** Deliver a message exactly as Chrome does, and resolve what the handler sends back. */
function deliver(handlers, message, sender = { tab: { id: 901, url: TOOL.targetUrl } }) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('no response from the message handler within 10s')), 10000);
    let answered = false;
    const sendResponse = (r) => { if (!answered) { answered = true; clearTimeout(timer); resolve(r); } };
    let kept = false;
    for (const h of handlers) {
      const keep = h(message, sender, sendResponse);
      if (keep === true) kept = true;
    }
    if (!kept && !answered) { clearTimeout(timer); resolve(undefined); }
  });
}

// The orchestrator is a lazily constructed singleton, so patching the prototype before the first
// use intercepts whatever instance the worker ends up building.
let orchCalls = [];
let restoreExecuteLogin = null;
async function stubExecuteLogin(impl) {
  const orch = await import(ORCH_URL);
  const proto = orch.LoginOrchestrator.prototype;
  const original = proto.executeLogin;
  proto.executeLogin = async function patched(tool, creds, ctx) {
    orchCalls.push({ tool: tool?.id, type: creds?.type, hasCtx: !!ctx });
    return impl ? impl(tool, creds, ctx) : { success: true, method: 'form', tabId: ctx?.tabId ?? null };
  };
  restoreExecuteLogin = () => { proto.executeLogin = original; };
}

const NULL_ORCH = /Cannot read properties of null \(reading 'executeLogin'\)|null is not an object.*executeLogin/i;

let wave = 0;
let savedConsole;
beforeEach(() => {
  orchCalls = [];
  // background.js logs generously at module scope; keep the test output readable without
  // suppressing anything the assertions depend on.
  savedConsole = { log: console.log, info: console.info, debug: console.debug, warn: console.warn };
  console.log = console.info = console.debug = console.warn = () => {};
});
afterEach(() => {
  Object.assign(console, savedConsole);
  if (restoreExecuteLogin) { restoreExecuteLogin(); restoreExecuteLogin = null; }
});

describe('a worker woken by a message has its runtime dependencies', () => {
  test('THE SCREENSHOT: Access on a fresh wake — no install, no startup — must not hit a null orchestrator', async () => {
    const w = await wakeWorker(++wave);
    await stubExecuteLogin();
    // Deliberately NOT firing runtime.onInstalled or runtime.onStartup. That is the whole point.
    assert.equal((w.listeners.get('runtime.onInstalled') || []).length >= 1, true, 'the lifecycle listeners are still registered…');
    const res = await deliver(w.handlers, { type: 'GENZ_OPEN_TOOL', payload: { toolId: TOOL_ID } });

    assert.ok(res, 'the handler must answer');
    const err = String(res.error || '');
    assert.doesNotMatch(err, NULL_ORCH, `the null-orchestrator crash is back: ${err}`);
    assert.equal(orchCalls.length, 1, 'the orchestrator must actually have been used');
    assert.equal(orchCalls[0].type, 'form');
    assert.equal(res.success, true);
  });

  test('IDLE TERMINATION THEN ACCESS: each wake is independent and each one works', async () => {
    for (const i of [1, 2, 3]) {
      const w = await wakeWorker(++wave);
      await stubExecuteLogin();
      const res = await deliver(w.handlers, { type: 'GENZ_OPEN_TOOL', payload: { toolId: TOOL_ID } });
      assert.doesNotMatch(String(res.error || ''), NULL_ORCH, `wake ${i} crashed on a null orchestrator`);
      assert.equal(res.success, true, `wake ${i} did not open the tool`);
      restoreExecuteLogin(); restoreExecuteLogin = null;
    }
  });

  test('the aliases route the same way, and none of them crashes on a wake', async () => {
    for (const type of ['GENZ_PROCESS_TOOL', 'GENZ_OPEN_TOOL_DIRECT', 'GENZ_AUTO_LOGIN_NO_SAVE']) {
      orchCalls = [];                     // per alias, not per test: each wake is its own count
      const w = await wakeWorker(++wave);
      await stubExecuteLogin();
      const res = await deliver(w.handlers, { type, payload: { toolId: TOOL_ID } });
      assert.doesNotMatch(String(res.error || ''), NULL_ORCH, `${type} crashed on a null orchestrator`);
      assert.equal(orchCalls.length, 1, `${type} did not reach the orchestrator`);
      restoreExecuteLogin(); restoreExecuteLogin = null;
    }
  });

  test('a lifecycle wake still works — the fix must not break install or startup', async () => {
    const w = await wakeWorker(++wave);
    await stubExecuteLogin();
    for (const fn of w.listeners.get('runtime.onInstalled') || []) fn({ reason: 'install' });
    for (const fn of w.listeners.get('runtime.onStartup') || []) fn();
    await new Promise((r) => setTimeout(r, 50));
    const res = await deliver(w.handlers, { type: 'GENZ_OPEN_TOOL', payload: { toolId: TOOL_ID } });
    assert.equal(res.success, true);
    assert.equal(orchCalls.length, 1);
  });

  test('CONCURRENT Access clicks on one wake: no crash, and the duplicate lock still holds', async () => {
    const w = await wakeWorker(++wave);
    let inFlight = 0; let maxInFlight = 0;
    await stubExecuteLogin(async (tool, creds, ctx) => {
      inFlight += 1; maxInFlight = Math.max(maxInFlight, inFlight);
      await new Promise((r) => setTimeout(r, 30));
      inFlight -= 1;
      return { success: true, method: 'form', tabId: ctx?.tabId ?? null };
    });
    const results = await Promise.all([
      deliver(w.handlers, { type: 'GENZ_OPEN_TOOL', payload: { toolId: TOOL_ID } }),
      deliver(w.handlers, { type: 'GENZ_OPEN_TOOL', payload: { toolId: TOOL_ID } }),
      deliver(w.handlers, { type: 'GENZ_OPEN_TOOL', payload: { toolId: TOOL_ID } }),
    ]);
    for (const r of results) assert.doesNotMatch(String(r.error || ''), NULL_ORCH);
    assert.equal(results.filter((r) => r.success).length >= 1, true, 'at least one open must succeed');
    // The pre-existing isToolOpening / 3s lock behaviour is NOT loosened by the fix.
    assert.equal(maxInFlight, 1, 'opens must not overlap');
    assert.equal(results.filter((r) => r.error === 'already_opening').length, 2);
  });

  test('a FAILED dependent operation is reported as itself, not hidden and not a false success', async () => {
    const w = await wakeWorker(++wave);
    await stubExecuteLogin(async () => { throw new Error('login_strategy_exploded'); });
    const res = await deliver(w.handlers, { type: 'GENZ_OPEN_TOOL', payload: { toolId: TOOL_ID } });
    assert.notEqual(res.success, true, 'a thrown login must never be reported as success');
    assert.doesNotMatch(String(res.error || ''), NULL_ORCH);
    assert.match(String(res.error || ''), /login_strategy_exploded/);
  });
});

describe('the fix does not buy readiness with side effects', () => {
  const RAW = require('node:fs').readFileSync(RAW_BG, 'utf8');
  // Comment lines are stripped: the accessor's own doc comment legitimately names the expression it
  // replaced, and a source contract that cannot tell code from prose is a source contract that
  // fails on documentation.
  const SRC = RAW.split('\n').filter((l) => !/^\s*(\*|\/\/|\/\*)/.test(l)).join('\n');

  test('no executeLogin call site dereferences the bare variable any more', () => {
    assert.equal(/\borchestrator\.executeLogin\(/.test(SRC), false,
      'every call site must go through the accessor, so a wake cannot find null');
    assert.ok(/requireOrchestrator\(\)\.executeLogin\(/.test(SRC));
    // Four call sites existed when this was written; all four must be converted.
    assert.equal((SRC.match(/requireOrchestrator\(\)\.executeLogin\(/g) || []).length, 4);
  });

  test('the crash is not hidden with optional chaining or a fake success', () => {
    assert.equal(/orchestrator\?\.executeLogin/.test(SRC), false, 'optional chaining would turn the crash into a silent no-op');
    assert.equal(/requireOrchestrator\(\)\?\./.test(SRC), false);
  });

  test('listeners are still registered synchronously at module scope', () => {
    for (const ev of ['onInstalled', 'onStartup', 'onMessage']) {
      assert.ok(new RegExp(`^chrome\\.runtime\\.${ev}\\.addListener`, 'm').test(RAW),
        `chrome.runtime.${ev} must be registered at top level, not inside an async bootstrap`);
    }
  });

  test('readiness does NOT re-run install-only work on an ordinary wake', () => {
    // Getting an orchestrator must not re-pair the user, re-arm alarms, re-inject the bridge or
    // re-run the cleanup sync. getOrchestrator() is a synchronous, side-effect-free singleton
    // factory (core/LoginOrchestrator.js: it constructs a Logger, a SuccessDetector and three
    // Maps), so the accessor needs none of that.
    const fn = RAW.slice(RAW.indexOf('function requireOrchestrator('));
    const body = fn.slice(0, fn.indexOf('\n}\n') + 3);
    for (const forbidden of ['runCleanupSync', 'setupSyncAlarm', 'injectBridgeIntoDashboardTabs', 'loadCachedData', 'setStorage', 'chrome.alarms']) {
      assert.equal(body.includes(forbidden), false, `requireOrchestrator must not call ${forbidden}`);
    }
    assert.ok(body.includes('getOrchestrator()'), 'it must reuse the existing singleton factory');
  });

  test('no keep-alive: the fix adds no polling, no offscreen document and no persistent port', () => {
    const fn = RAW.slice(RAW.indexOf('function requireOrchestrator('));
    const body = fn.slice(0, fn.indexOf('\n}\n') + 3);
    for (const forbidden of ['setInterval', 'offscreen', 'connect(']) {
      assert.equal(body.includes(forbidden), false, `requireOrchestrator must not use ${forbidden}`);
    }
  });

  test('initialize() still owns the one-time work, and still assigns the orchestrator', () => {
    const init = RAW.slice(RAW.indexOf('async function initialize()'));
    const body = init.slice(0, init.indexOf('\n}\n') + 3);
    assert.ok(body.includes('isInitialized'), 'duplicate initialization is still prevented');
    assert.ok(/requireOrchestrator\(\)|orchestrator = getOrchestrator\(\)/.test(body));
    assert.ok(body.includes('setupSyncAlarm'), 'the lifecycle path keeps its own work');
  });
});
