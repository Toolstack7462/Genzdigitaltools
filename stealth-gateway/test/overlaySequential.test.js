'use strict';
/**
 * StealthWriter overlay — FIVE consecutive Humanize actions in ONE page session.
 *   node --test test/overlaySequential.test.js
 *
 * WHAT THIS PINS
 * The reported defect: the first Humanize decremented the Gen Z count, every later one in the
 * same session did not, even though StealthWriter produced a result and decremented its own
 * usage each time. Everything about that symptom points at per-session state that is set up
 * once and never cleared — so this runs the REAL overlay.js in a stubbed DOM and drives five
 * click → fetch cycles through it, asserting on each one:
 *
 *   • a NEW cryptographically unique operation id is reserved (never a reused one),
 *   • the outgoing request actually carries that id,
 *   • the click interceptor and the fetch patch are still installed afterwards,
 *   • the in-flight guard is released so the next click is not swallowed.
 *
 * It also covers the interleavings the bug report asks for: success → failure → success,
 * failure → success → success, rapid double-click, and AI Detector independence.
 *
 * No text, output, cookie or token is used anywhere in this harness.
 */
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const crypto = require('crypto');

const OVERLAY_SRC = fs.readFileSync(path.join(__dirname, '..', 'public', 'overlay.js'), 'utf8');

// ── Minimal DOM / browser stub ──────────────────────────────────────────────────────────
function makeElement(tag) {
  const el = {
    tagName: String(tag || 'div').toUpperCase(),
    textContent: '', value: '', id: '', className: '', innerHTML: '',
    style: {}, children: [], attributes: {},
    classList: { add() {}, remove() {}, toggle() {}, contains() { return false; } },
    setAttribute(k, v) { this.attributes[k] = v; },
    getAttribute(k) { return this.attributes[k] !== undefined ? this.attributes[k] : null; },
    appendChild(c) { this.children.push(c); return c; },
    removeChild() {}, remove() {},
    addEventListener(type, fn) { (this.__l || (this.__l = {}))[type] = (this.__l[type] || []).concat(fn); },
    removeEventListener() {},
    querySelector() { return makeElement('div'); },
    querySelectorAll() { return []; },
    // A clicked control resolves to itself, and is never inside our own widget.
    closest(sel) { return String(sel).indexOf('#genz-sw-widget') >= 0 ? null : this; },
    contains() { return false; },
  };
  return el;
}

function makeSandbox() {
  const listeners = {};
  const documentElement = makeElement('html');
  const document = {
    readyState: 'loading',            // startWidget stays deferred: we never fire DOMContentLoaded
    cookie: '',
    documentElement,
    body: makeElement('body'),
    createElement: makeElement,
    getElementById() { return null; },
    querySelector() { return null; },
    querySelectorAll() { return []; },
    head: makeElement('head'),
    addEventListener(type, fn) { (listeners[type] || (listeners[type] = [])).push(fn); },
    removeEventListener() {},
    createTreeWalker() { return { nextNode() { return null; } }; },
  };

  const calls = { fetch: [], xhr: [] };
  let reserveResponder = null;
  let upstreamResponder = null;

  function jsonResponse(status, obj) {
    return {
      status, ok: status >= 200 && status < 300,
      headers: { get() { return 'application/json'; } },
      json() { return Promise.resolve(obj); },
      text() { return Promise.resolve(JSON.stringify(obj)); },
    };
  }

  const sandbox = {
    console: { debug() {}, log() {}, warn() {}, error() {} },
    setTimeout: (fn, ms) => setTimeout(fn, Math.min(Number(ms) || 0, 5)),  // keep the suite fast
    clearTimeout,
    setInterval: () => 0,                                                   // no background polling
    clearInterval,
    Promise, JSON, Math, Date, String, Number, Boolean, Object, Array, RegExp, Error,
    URL, Headers: class Headers {
      constructor(init) {
        this._m = new Map();
        if (init && typeof init === 'object' && typeof init.forEach === 'function' && init._m) init._m.forEach((v, k) => this._m.set(k, v));
        else if (init) for (const k of Object.keys(init)) this._m.set(String(k).toLowerCase(), init[k]);
      }
      set(k, v) { this._m.set(String(k).toLowerCase(), v); }
      get(k) { const v = this._m.get(String(k).toLowerCase()); return v === undefined ? null : v; }
      forEach(fn) { this._m.forEach(fn); }
    },
    Request: function Request() { throw new Error('not used in this harness'); },
    MutationObserver: class { observe() {} disconnect() {} },
    requestAnimationFrame: (fn) => setTimeout(fn, 0),
    history: { pushState() {}, replaceState() {} },
    location: { href: 'https://stealth1.example/dashboard/humanizer', origin: 'https://stealth1.example' },
    document,
    XMLHttpRequest: function XMLHttpRequest() {
      this.open = function () {}; this.send = function () {}; this.abort = function () {};
      this.addEventListener = function () {}; this.setRequestHeader = function () {};
    },
    navigator: { userAgent: 'test' },
    __GENZ_GATEWAY__: { api: 'https://api.example/api/crm/stealth/gateway', capture: false, accountLabel: null, sameOrigin: true },
  };
  sandbox.window = sandbox;
  sandbox.self = sandbox;
  sandbox.globalThis = sandbox;
  sandbox.addEventListener = (t, fn) => document.addEventListener(t, fn);

  sandbox.fetch = function (input, init) {
    const url = typeof input === 'string' ? input : (input && input.url) || '';
    const headers = (init && init.headers) || {};
    const get = (k) => (headers && typeof headers.get === 'function') ? headers.get(k) : (headers[k] || headers[k.toLowerCase()] || null);
    const rec = {
      url,
      method: (init && init.method) || 'GET',
      op: get('X-Genz-Op'),
      action: get('X-Genz-Action'),
      body: init && init.body,
    };
    calls.fetch.push(rec);
    if (url.indexOf('/__genz/usage/reserve') >= 0) return Promise.resolve(jsonResponse(200, reserveResponder()));
    if (url.indexOf('/__genz/usage/status') >= 0) return Promise.resolve(jsonResponse(200, { state: 'committed', remaining: { humanizer: 40, detector: 5 } }));
    if (url.indexOf('/__genz/usage/cancel') >= 0) return Promise.resolve(jsonResponse(200, { ok: true, cancelled: true }));
    if (url.indexOf('/__genz/validate') >= 0) {
      return Promise.resolve(jsonResponse(200, {
        valid: true, terminal: false, secondsRemaining: 1800,
        plan: { planName: 'Pro', limits: { humanizer: 50, detector: 20 }, used: {}, remaining: { humanizer: 40, detector: 5 } },
      }));
    }
    return upstreamResponder(rec);
  };

  vm.createContext(sandbox);
  vm.runInContext(OVERLAY_SRC, sandbox, { filename: 'overlay.js' });

  return {
    sandbox, calls, listeners,
    setReserveResponder(fn) { reserveResponder = fn; },
    setUpstreamResponder(fn) { upstreamResponder = fn; },
    click(label) {
      const target = makeElement('button');
      target.textContent = label;
      for (const fn of (listeners.click || [])) fn({ target });
    },
    jsonResponse,
  };
}

const settle = () => new Promise(r => setTimeout(r, 60));

/** One full user action: click the button, then let the app fire its request. */
async function humanize(h, label, url) {
  h.click(label || 'Humanize');
  try { await h.sandbox.fetch(url || '/api/humanize', { method: 'POST', body: '{}' }); }
  catch (_) { /* blocked or upstream failure — the assertions below say which */ }
  await settle();
}

function freshOps() {
  const issued = [];
  return {
    issued,
    responder: () => {
      const operationId = crypto.randomBytes(16).toString('hex');
      issued.push(operationId);
      return { ok: true, allowed: true, code: 'ok', operationId, remaining: { humanizer: 40, detector: 5 } };
    },
  };
}
const meteredCalls = (h) => h.calls.fetch.filter(c => c.url === '/api/humanize' || c.url === '/api/scan');
const reserveCalls = (h) => h.calls.fetch.filter(c => c.url.indexOf('/usage/reserve') >= 0);

// ── The reported defect ─────────────────────────────────────────────────────────────────

test('FIVE consecutive Humanize actions each reserve a NEW unique operation id', async () => {
  const h = makeSandbox();
  const ops = freshOps();
  h.setReserveResponder(ops.responder);
  h.setUpstreamResponder(() => Promise.resolve(h.jsonResponse(200, { d: 'UkVT', s: 'k' })));

  for (let i = 0; i < 5; i++) await humanize(h);

  assert.equal(reserveCalls(h).length, 5, 'every click reserves — not just the first');
  const tagged = meteredCalls(h).map(c => c.op);
  assert.equal(tagged.length, 5, 'five upstream requests went out');
  assert.deepEqual(tagged, ops.issued, 'each request carries the id reserved for IT');
  assert.equal(new Set(tagged).size, 5, 'five DISTINCT operation ids — none reused');
  for (const op of tagged) assert.match(String(op), /^[0-9a-f]{32}$/, 'unguessable 128-bit id');
});

test('the click interceptor and fetch patch survive the first operation', async () => {
  const h = makeSandbox();
  const ops = freshOps();
  h.setReserveResponder(ops.responder);
  h.setUpstreamResponder(() => Promise.resolve(h.jsonResponse(200, { d: 'UkVT', s: 'k' })));

  const patched = h.sandbox.fetch;
  const clickHandlers = (h.listeners.click || []).length;
  await humanize(h);
  assert.equal((h.listeners.click || []).length, clickHandlers, 'the click listener is not one-time');
  assert.equal(h.sandbox.fetch, patched, 'and the fetch patch is not uninstalled');

  await humanize(h);
  assert.equal(reserveCalls(h).length, 2, 'so the second action still meters');
});

test('the in-flight guard is released after every terminal outcome', async () => {
  const h = makeSandbox();
  const ops = freshOps();
  h.setReserveResponder(ops.responder);

  // success, then a hard failure, then success again
  h.setUpstreamResponder(() => Promise.resolve(h.jsonResponse(200, { d: 'UkVT', s: 'k' })));
  await humanize(h);
  h.setUpstreamResponder(() => Promise.reject(new Error('network down')));
  await humanize(h);
  h.setUpstreamResponder(() => Promise.resolve(h.jsonResponse(200, { d: 'UkVT', s: 'k' })));
  await humanize(h);

  assert.equal(reserveCalls(h).length, 3, 'a failed action never wedges the next one');
  assert.equal(new Set(meteredCalls(h).map(c => c.op)).size, 3);
});

test('failure → success → success all meter independently', async () => {
  const h = makeSandbox();
  const ops = freshOps();
  h.setReserveResponder(ops.responder);
  h.setUpstreamResponder(() => Promise.reject(new Error('offline')));
  await humanize(h);
  h.setUpstreamResponder(() => Promise.resolve(h.jsonResponse(200, { d: 'UkVT', s: 'k' })));
  await humanize(h);
  await humanize(h);
  assert.equal(reserveCalls(h).length, 3);
  assert.equal(new Set(meteredCalls(h).map(c => c.op)).size, 3, 'three distinct operations');
});

test('a committed operation id is never reused by the next action', async () => {
  const h = makeSandbox();
  const ops = freshOps();
  h.setReserveResponder(ops.responder);
  h.setUpstreamResponder(() => Promise.resolve(h.jsonResponse(200, { d: 'UkVT', s: 'k' })));
  await humanize(h);
  await humanize(h);
  const [first, second] = meteredCalls(h).map(c => c.op);
  assert.notEqual(first, second);
});

// ── Concurrency and independence ────────────────────────────────────────────────────────

test('a rapid double-click does not create a second upstream request', async () => {
  const h = makeSandbox();
  const ops = freshOps();
  h.setReserveResponder(ops.responder);
  let release;
  const held = new Promise(r => { release = r; });
  h.setUpstreamResponder(() => held.then(() => h.jsonResponse(200, { d: 'UkVT', s: 'k' })));

  h.click('Humanize');
  const a = h.sandbox.fetch('/api/humanize', { method: 'POST', body: '{}' }).catch(() => {});
  h.click('Humanize');
  const b = h.sandbox.fetch('/api/humanize', { method: 'POST', body: '{}' }).catch(() => {});
  await settle();

  assert.equal(reserveCalls(h).length, 1, 'the second click is refused while one is in flight');
  release(); await a; await b; await settle();
  assert.equal(meteredCalls(h).length, 1, 'and only one upstream request was made');

  // …and the NEXT deliberate click still works.
  h.setUpstreamResponder(() => Promise.resolve(h.jsonResponse(200, { d: 'UkVT', s: 'k' })));
  await humanize(h);
  assert.equal(reserveCalls(h).length, 2, 'a fresh operation after the burst');
});

test('AI Detector reserves its own action and stays independent of Humanizer', async () => {
  const h = makeSandbox();
  const ops = freshOps();
  h.setReserveResponder(ops.responder);
  h.setUpstreamResponder(() => Promise.resolve(h.jsonResponse(200, { d: 'UkVT', s: 'k' })));

  await humanize(h, 'Humanize', '/api/humanize');
  await humanize(h, 'Check for AI', '/api/scan');
  await humanize(h, 'Humanize', '/api/humanize');

  const actions = reserveCalls(h).map(c => JSON.parse(c.body).action);
  assert.deepEqual(actions, ['humanizer', 'detector', 'humanizer']);
  const tagged = meteredCalls(h).map(c => c.action);
  assert.deepEqual(tagged, ['humanizer', 'detector', 'humanizer'], 'each request is tagged with its own action');
});

test('result-area buttons never reserve, however many times they are clicked', async () => {
  const h = makeSandbox();
  const ops = freshOps();
  h.setReserveResponder(ops.responder);
  h.setUpstreamResponder(() => Promise.resolve(h.jsonResponse(200, { d: 'UkVT', s: 'k' })));

  for (const label of ['Humanize More', 'Rehumanize', 'Re-humanize Output', 'Copy', 'Compare', 'Deep Scan']) {
    await humanize(h, label);
  }
  assert.equal(reserveCalls(h).length, 0, "matches StealthWriter's own billing: only the initial Humanize counts");

  await humanize(h, 'Humanize');
  assert.equal(reserveCalls(h).length, 1, 'and a real Humanize right after still meters');
});

// ── Refresh behaviour ───────────────────────────────────────────────────────────────────

test('a widget refresh that keeps failing never repeats the commit', async () => {
  const h = makeSandbox();
  const ops = freshOps();
  h.setReserveResponder(ops.responder);
  h.setUpstreamResponder(() => Promise.resolve(h.jsonResponse(200, { d: 'UkVT', s: 'k' })));

  // /usage/status is the only refresh channel, and it is READ-ONLY.
  await humanize(h);
  await new Promise(r => setTimeout(r, 200));

  const commitAttempts = h.calls.fetch.filter(c => c.url.indexOf('/usage/commit') >= 0);
  assert.equal(commitAttempts.length, 0, 'the browser never calls commit at all — the gateway owns it');
  assert.equal(reserveCalls(h).length, 1, 'and refreshing does not re-reserve');
});

test('reserve being refused does not send the upstream request, and does not wedge the next action', async () => {
  const h = makeSandbox();
  let refuse = true;
  const ops = freshOps();
  h.setReserveResponder(() => refuse
    ? { ok: false, allowed: false, code: 'limit_reached', remaining: { humanizer: 0, detector: 5 } }
    : ops.responder());
  h.setUpstreamResponder(() => Promise.resolve(h.jsonResponse(200, { d: 'UkVT', s: 'k' })));

  await humanize(h);
  assert.equal(meteredCalls(h).length, 0, 'fail closed: nothing is sent upstream');

  refuse = false;
  await humanize(h);
  assert.equal(meteredCalls(h).length, 1, 'and the next action works normally');
});
