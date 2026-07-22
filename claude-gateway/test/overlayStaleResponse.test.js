'use strict';
/**
 * Claude overlay — a stale validation response must never overwrite a newly issued session.
 *
 * THE MOBILE RACE THIS COVERS: a phone freezes the tab mid-`/__genz/validate`. That fetch may
 * never settle, so `state.inFlight` stays true forever and every later validation returns early —
 * the resumed tab replays whatever it last knew and never learns that a dashboard relaunch has
 * installed a fresh lease. And if the abandoned request eventually DOES settle, it is answering a
 * question about the session that has since been replaced, so applying it would drag a live
 * session back to the dead one's verdict and expiry.
 *
 * Loads the REAL shipped claude-gateway/public/overlay.js into a vm sandbox with a lean DOM stub
 * (start() is never invoked — readyState is 'loading' — so only the validation logic runs) and
 * drives the race directly through a probe injected before the IIFE's final line.
 */
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const OVERLAY = path.resolve(__dirname, '..', 'public', 'overlay.js');

// Boot the overlay with a fetch that hands back a controllable deferred per call.
function boot() {
  let src = fs.readFileSync(OVERLAY, 'utf8');
  // The overlay is an IIFE; a probe appended after it cannot see `state`. Inject before the close.
  const close = src.lastIndexOf('})();');
  assert.ok(close > 0, 'overlay must end with the IIFE close');
  src = src.slice(0, close)
    + '\nwindow.__probe = { state: state, validate: validate, el: el };\n'
    + src.slice(close);

  const calls = [];
  const sandbox = {
    console: { debug() {}, log() {}, warn() {}, error() {} },
    Promise, Date, Math, JSON, Error, String, Number, Object, Array, RegExp, isNaN,
    setTimeout, clearTimeout, setInterval: () => 0, clearInterval: () => {},
    fetch(url, opts) {
      let resolve, reject;
      const p = new Promise((res, rej) => { resolve = res; reject = rej; });
      calls.push({ url: url, opts: opts, resolve, reject });
      return p;
    },
  };
  sandbox.window = sandbox;
  sandbox.globalThis = sandbox;
  sandbox.self = sandbox;
  sandbox.document = {
    // 'loading' → the overlay registers DOMContentLoaded instead of calling start(), so the
    // widget/DOM machinery never runs and we exercise the validation logic in isolation.
    readyState: 'loading',
    cookie: '',
    addEventListener() {}, removeEventListener() {},
    documentElement: { appendChild() {} },
    createElement() { return { style: {}, classList: { add() {}, remove() {}, toggle() {} }, addEventListener() {}, appendChild() {}, querySelector() { return null; }, remove() {} }; },
    querySelector() { return null; }, querySelectorAll() { return []; },
  };
  sandbox.__GENZ_GATEWAY__ = { api: '/api/crm/proxy/gateway', tool: 'claude', toolName: 'Claude AI' };
  vm.createContext(sandbox);
  vm.runInContext(src, sandbox, { filename: 'overlay.js' });
  assert.ok(sandbox.__probe, 'probe injected');
  // start() never ran, so the widget was never built. showMessage() bails out when there is no
  // message node — which would silently swallow the terminal transition we are asserting on — so
  // give it the one node it needs. `el` is the overlay's own object, so this is the real path.
  sandbox.__probe.el.msg = { textContent: '', style: {} };
  return { t: sandbox.__probe, calls, sandbox };
}

const respond = (call, status, body) => call.resolve({
  status,
  json: () => Promise.resolve(body),
});
const flush = () => new Promise(r => setTimeout(r, 0));

test('a frozen-tab request is abandoned on resume so the tab can re-validate', async () => {
  const { t, calls } = boot();
  t.validate();                                   // request #1 — never settles (tab froze)
  assert.strictEqual(calls.length, 1);
  assert.strictEqual(t.state.inFlight, true);

  // A resume while the request is still young must NOT start a second one (the original guard).
  t.validate(true);
  assert.strictEqual(calls.length, 1, 'a fresh in-flight request is still protected');

  // Age it past the abandon threshold — this is the frozen tab coming back.
  t.state.inFlightSince = Date.now() - 60000;
  t.validate(true);
  assert.strictEqual(calls.length, 2, 'the resumed tab gets a clean validation instead of being stuck forever');
});

test('the abandoned response cannot overwrite the session issued after it', async () => {
  const { t, calls } = boot();
  t.validate();                                   // #1: belongs to the OLD, dying session
  t.state.inFlightSince = Date.now() - 60000;
  t.validate(true);                               // #2: after the dashboard relaunch
  assert.strictEqual(calls.length, 2);

  // The NEW session answers first: a fresh 30-minute lease.
  const newExpiry = new Date(Date.now() + 1800000).toISOString();
  respond(calls[1], 200, { valid: true, secondsRemaining: 1800, expiresAt: newExpiry, serverTime: new Date().toISOString() });
  await flush(); await flush();
  assert.strictEqual(t.state.terminal, false);
  const adopted = t.state.expiresAtMs;
  assert.ok(adopted > Date.now() + 1700000, 'the new 30-minute expiry is in force');

  // Now the ABANDONED request finally lands, carrying the dead session's verdict.
  respond(calls[0], 200, { valid: false, terminal: true, retryable: false, code: 'lease_expired' });
  await flush(); await flush();

  assert.strictEqual(t.state.terminal, false, 'the old verdict must NOT end the newly issued session');
  assert.strictEqual(t.state.expiresAtMs, adopted, 'and must not roll the countdown back to the old expiry');
});

test('a late response for the CURRENT session is still applied normally', async () => {
  const { t, calls } = boot();
  t.validate();
  respond(calls[0], 200, { valid: true, secondsRemaining: 900, expiresAt: new Date(Date.now() + 900000).toISOString(), serverTime: new Date().toISOString() });
  await flush(); await flush();
  assert.ok(t.state.expiresAtMs > Date.now() + 800000, 'the ordinary path is untouched');
  assert.strictEqual(t.state.inFlight, false);
});

test('a confirmed denial for the CURRENT session still ends it (enforcement unchanged)', async () => {
  const { t, calls } = boot();
  t.validate();
  respond(calls[0], 200, { valid: false, terminal: true, retryable: false, code: 'lease_revoked' });
  await flush(); await flush();
  assert.strictEqual(t.state.terminal, true, 'revocation of the live session is still terminal');
});
