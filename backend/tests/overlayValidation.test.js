'use strict';
/**
 * Overlay session-resilience tests — the 12 required scenarios.
 *
 * Loads the REAL shipped overlay.js from each gateway into a minimal DOM/fetch stub and
 * drives its validation loop. No browser required, so this runs in `npm test` alongside
 * everything else and can never silently drift from what is deployed.
 *
 * The behaviour under test: a temporary failure must keep the session alive, keep the
 * countdown moving and show "Connection interrupted — retrying"; only a CONFIRMED
 * authorization denial may end the session.
 */
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const REPO = path.resolve(__dirname, '../..');
// chatgpt-gateway was absent from this list for as long as it was absent from the repo — it
// was deployed from an untracked directory, so nothing loaded its overlay and nothing noticed
// it had never received the terminal-vs-retryable fix. It is listed here now precisely so that
// gap cannot reopen: this suite reads the REAL shipped overlay.js from every gateway.
const GATEWAYS = ['proxy-gateway', 'stealth-gateway', 'claude-gateway', 'hix-gateway', 'bypassgpt-gateway', 'grok-gateway', 'writehuman-v2', 'chatgpt-gateway'];

// ── Minimal DOM good enough for the widget ──────────────────────────────────
function makeEl(tag) {
  const el = {
    tagName: String(tag || 'div').toUpperCase(),
    children: [], style: {}, dataset: {}, attributes: {},
    _classes: new Set(), textContent: '', _html: '',
    classList: {
      add(c) { el._classes.add(c); }, remove(c) { el._classes.delete(c); },
      contains(c) { return el._classes.has(c); },
      toggle(c, on) { if (on === undefined) on = !el._classes.has(c); on ? el._classes.add(c) : el._classes.delete(c); return on; },
    },
    get innerHTML() { return el._html; },
    set innerHTML(v) { el._html = String(v); },
    appendChild(c) { el.children.push(c); return c; },
    removeChild(c) { el.children = el.children.filter(x => x !== c); return c; },
    remove() {}, addEventListener() {}, removeEventListener() {},
    setAttribute(k, v) { el.attributes[k] = v; }, getAttribute(k) { return el.attributes[k]; },
    removeAttribute(k) { delete el.attributes[k]; },
    querySelector() { return makeEl('div'); },
    querySelectorAll() { return []; },
    closest() { return null; }, matches() { return false; },
    getBoundingClientRect() { return { top: 0, left: 0, width: 100, height: 20, bottom: 20, right: 100 }; },
    insertAdjacentHTML() {}, contains() { return false; }, focus() {}, click() {},
  };
  return el;
}

function makeSandbox(fetchImpl) {
  const timers = [];   // [{ id, fn, dueAt, interval }]
  let nextId = 1;
  let now = Date.now();

  // Real listener registries so a test can fire the mobile resume events (pageshow /
  // visibilitychange / focus). Previously these were no-ops; nothing that existed before
  // registered a listener, so no earlier test changes behaviour.
  const listeners = { window: {}, document: {} };
  const on = (bag) => (type, fn) => { (bag[type] || (bag[type] = [])).push(fn); };

  const doc = makeEl('html');
  doc.documentElement = doc;
  doc.head = makeEl('head'); doc.body = makeEl('body');
  doc.cookie = 'pg_lease=test.lease.jwt; sw_lease=test.lease.jwt';
  doc.createElement = makeEl;
  doc.addEventListener = on(listeners.document); doc.removeEventListener = () => {};
  doc.querySelector = () => makeEl('div'); doc.querySelectorAll = () => [];
  doc.getElementById = () => null; doc.getElementsByTagName = () => [];
  doc.readyState = 'complete';
  doc.createTreeWalker = () => ({ nextNode: () => null });
  doc.visibilityState = 'visible';

  const sandbox = {
    document: doc,
    console: { log() {}, warn() {}, error() {}, debug() {} },
    location: { href: 'https://gw.test/app', pathname: '/app', origin: 'https://gw.test', reload() {} },
    navigator: { userAgent: 'node-test' },
    fetch: fetchImpl,
    Date: new Proxy(Date, { construct: (T, a) => (a.length ? new T(...a) : new T(now)), apply: () => now, get: (T, p) => (p === 'now' ? () => now : T[p]) }),
    Math: Object.assign(Object.create(Math), { random: () => 0.5 }),  // deterministic jitter
    JSON, Promise, Object, Array, String, Number, Boolean, RegExp, Error, isNaN, parseInt, parseFloat,
    MutationObserver: function () { return { observe() {}, disconnect() {}, takeRecords: () => [] }; },
    setTimeout(fn, ms) { const id = nextId++; timers.push({ id, fn, dueAt: now + (ms || 0), interval: null }); return id; },
    setInterval(fn, ms) { const id = nextId++; timers.push({ id, fn, dueAt: now + (ms || 0), interval: ms || 1 }); return id; },
    clearTimeout(id) { for (let i = timers.length - 1; i >= 0; i--) if (timers[i].id === id) timers.splice(i, 1); },
    clearInterval(id) { sandbox.clearTimeout(id); },
    requestAnimationFrame(fn) { return sandbox.setTimeout(fn, 16); },
    getComputedStyle: () => ({ getPropertyValue: () => '', display: 'block', visibility: 'visible' }),
    history: { pushState() {}, replaceState() {} },
  };
  sandbox.addEventListener = on(listeners.window);
  sandbox.removeEventListener = () => {};
  sandbox.dispatchEvent = () => true;
  // Fire a resume event the way a phone would: `__fire('window','pageshow',{persisted:true})`.
  sandbox.__fire = (target, type, evt) => {
    for (const fn of (listeners[target][type] || [])) { try { fn(evt || {}); } catch (_) {} }
  };
  sandbox.__listenerCount = (target, type) => (listeners[target][type] || []).length;
  sandbox.window = sandbox;
  sandbox.globalThis = sandbox;

  // Drain the microtask queue. The overlay's fetch chain is several .then() hops deep
  // (fetch → json() → unwrap → handler), so a couple of awaits is not enough to settle it.
  const flush = async () => { for (let i = 0; i < 30; i++) await Promise.resolve(); };

  // Advance virtual time, firing due timers. Lets us assert on backoff without real waits.
  sandbox.__advance = async function (ms) {
    await flush();                       // settle anything already pending (e.g. the boot validate)
    const target = now + ms;
    let guard = 0;
    while (guard++ < 10000) {
      const due = timers.filter(t => t.dueAt <= target).sort((a, b) => a.dueAt - b.dueAt)[0];
      if (!due) break;
      now = Math.max(now, due.dueAt);
      if (due.interval) due.dueAt = now + due.interval;
      else timers.splice(timers.indexOf(due), 1);
      try { due.fn(); } catch (_) {}
      await flush();
    }
    now = target;
    await flush();
  };
  sandbox.__flush = flush;
  sandbox.__pendingTimers = () => timers.length;
  sandbox.__now = () => now;
  return sandbox;
}

/** Boot a gateway's real overlay.js and expose its internals for assertions. */
function boot(gateway, fetchImpl, cfg) {
  const file = path.join(REPO, gateway, 'public/overlay.js');
  const code = fs.readFileSync(file, 'utf8');
  const sandbox = makeSandbox(fetchImpl);
  sandbox.__GENZ_GATEWAY__ = Object.assign({
    api: 'https://api.test/api/crm/proxy/gateway',
    tool: gateway === 'claude-gateway' ? 'claude' : 'hix',
    toolName: 'Test Tool',
  }, cfg || {});
  // Let the fetch stub stamp responses with the sandbox's virtual clock, like a real backend.
  if (typeof fetchImpl === 'function' && fetchImpl.clock) fetchImpl.clock = () => sandbox.__now();
  vm.createContext(sandbox);
  // The overlay is an IIFE, so its state is closed over. Inject the probe just BEFORE the
  // IIFE's final `})();` so it runs inside that scope. Read-only — behaviour is untouched.
  const close = code.lastIndexOf('})();');
  assert.ok(close > 0, gateway + ': could not find the overlay IIFE terminator');
  const probe = '\ntry{window.__t={state:state,validate:validate,tick:tick,el:el};}catch(e){window.__t_err=e&&e.message;}\n';
  const instrumented = code.slice(0, close) + probe + code.slice(close);
  vm.runInContext(instrumented, sandbox, { filename: file });
  if (sandbox.__t_err) throw new Error(gateway + ' overlay threw: ' + sandbox.__t_err);
  assert.ok(sandbox.__t, gateway + ': overlay did not expose state');
  return sandbox;
}

/**
 * Fetch stub returning a scripted sequence of responses.
 *
 * `step.body` may be a function, which is invoked at RESPONSE time with the sandbox's
 * current virtual time. That matters: a real backend stamps a fresh `serverTime` on every
 * response, so a frozen fixture would make the client's clock-skew correction cancel out
 * elapsed time and mask countdown bugs.
 */
function scriptedFetch(steps) {
  let i = 0;
  const calls = [];
  const fn = function () {
    const step = steps[Math.min(i, steps.length - 1)];
    i++;
    calls.push(step);
    if (step.networkError) return Promise.reject(new Error('network down'));
    const body = (typeof step.body === 'function') ? step.body(fn.clock()) : step.body;
    return Promise.resolve({
      status: step.status,
      json: () => (step.malformed ? Promise.reject(new SyntaxError('bad json')) : Promise.resolve(body)),
    });
  };
  fn.calls = calls;
  fn.count = () => i;
  fn.clock = () => Date.now();   // replaced by boot() with the sandbox's virtual clock
  return fn;
}

/** Static body — the lease was issued `secs` from the moment this is called. */
const okBody = (secs) => ({
  valid: true, terminal: false, retryable: false, code: null,
  secondsRemaining: secs, expiresAt: new Date(Date.now() + secs * 1000).toISOString(),
  serverTime: new Date().toISOString(), correlationId: 'abc123',
});

/**
 * Live body — a lease with a FIXED absolute deadline `secs` from the first call, whose
 * serverTime tracks the virtual clock exactly as a real backend's would.
 */
function liveOkBody(secs) {
  let deadline = null;
  return (nowMs) => {
    if (deadline === null) deadline = nowMs + secs * 1000;
    return {
      valid: true, terminal: false, retryable: false, code: null,
      secondsRemaining: Math.max(0, Math.round((deadline - nowMs) / 1000)),
      expiresAt: new Date(deadline).toISOString(),
      serverTime: new Date(nowMs).toISOString(),
      correlationId: 'abc123',
    };
  };
}

const RETRYING = 'Connection interrupted — retrying…';

// ══ 1. Valid lease remains active ═══════════════════════════════════════════
test('1. a valid lease stays active and shows no message', async () => {
  const f = scriptedFetch([{ status: 200, body: okBody(900) }]);
  const sb = boot('proxy-gateway', f);
  await sb.__advance(100);
  const t = sb.__t;
  assert.strictEqual(t.state.terminal, false);
  assert.ok(t.state.secondsRemaining > 890, 'countdown adopted from server');
  assert.strictEqual(t.state.degraded, false);
  assert.ok(t.state.expiresAtMs > 0, 'absolute expiry anchored');
});

// ══ 2. One temporary 500 does not terminate the session ═════════════════════
test('2. a single 500 does not terminate the session', async () => {
  const f = scriptedFetch([
    { status: 200, body: okBody(900) },
    { status: 500, body: { valid: false, terminal: false, retryable: true, code: 'server_error' } },
    { status: 200, body: okBody(880) },
  ]);
  const sb = boot('proxy-gateway', f);
  await sb.__advance(100);
  await sb.__t.validate();               // the 500
  assert.strictEqual(sb.__t.state.terminal, false, '500 must NOT be terminal');
  assert.ok(sb.__t.state.failures >= 1, 'counted as a retryable failure');
});

// ══ 3. Timeout followed by recovery clears the warning ══════════════════════
test('3. a timeout then recovery clears the warning automatically', async () => {
  const f = scriptedFetch([
    { status: 200, body: okBody(900) },
    { networkError: true },
    { networkError: true },
    { status: 200, body: okBody(870) },
  ]);
  const sb = boot('proxy-gateway', f, { validateGraceMs: 0 });  // no grace → warn immediately
  await sb.__advance(100);
  await sb.__t.validate();
  await sb.__advance(10);
  assert.strictEqual(sb.__t.state.degraded, true, 'shows the retrying warning');
  assert.strictEqual(sb.__t.state.terminal, false, 'still not terminal');
  await sb.__advance(60000);            // let backoff retries run through to the good response
  assert.strictEqual(sb.__t.state.degraded, false, 'warning auto-cleared on success');
  assert.strictEqual(sb.__t.state.failures, 0, 'failure counter reset');
});

// ══ 4. Malformed JSON does not freeze the countdown ═════════════════════════
test('4. malformed JSON does not freeze the countdown or terminate', async () => {
  const f = scriptedFetch([
    { status: 200, body: okBody(900) },
    { status: 200, malformed: true },
  ]);
  const sb = boot('proxy-gateway', f, { validateGraceMs: 0 });
  await sb.__advance(100);
  const before = sb.__t.state.secondsRemaining;
  await sb.__t.validate();
  await sb.__advance(5000);             // 5s of ticks
  const after = sb.__t.state.secondsRemaining;
  assert.strictEqual(sb.__t.state.terminal, false, 'malformed body must not be terminal');
  assert.ok(after < before, 'countdown kept moving (' + before + ' → ' + after + ')');
});

// ══ 5. Concurrent validations do not corrupt state ══════════════════════════
test('5. three simultaneous validate() calls do not corrupt state', async () => {
  const f = scriptedFetch([{ status: 200, body: okBody(900) }]);
  const sb = boot('proxy-gateway', f);
  await sb.__advance(100);
  const n = f.count();
  await Promise.all([sb.__t.validate(), sb.__t.validate(), sb.__t.validate()]);
  assert.strictEqual(f.count(), n + 1, 'in-flight guard collapsed the duplicates');
  assert.strictEqual(sb.__t.state.terminal, false);
  assert.strictEqual(sb.__t.state.failures, 0);
});

// ══ 6/7/8/9. Confirmed denials still block immediately ══════════════════════
for (const [code, label] of [
  ['lease_revoked', '6. confirmed revocation blocks immediately'],
  ['lease_expired', '7. confirmed expiry blocks immediately'],
  ['client_disabled', '8. disabled client blocks immediately'],
  ['account_no_session', '9. account-session expiry blocks with its own message'],
]) {
  test(label, async () => {
    const f = scriptedFetch([
      { status: 200, body: okBody(900) },
      { status: 403, body: { valid: false, terminal: true, retryable: false, code } },
    ]);
    const sb = boot('proxy-gateway', f);
    await sb.__advance(100);
    await sb.__t.validate();
    assert.strictEqual(sb.__t.state.terminal, true, code + ' MUST terminate');
    assert.strictEqual(sb.__t.state.degraded, false, 'not shown as a transient blip');
  });
}

test('9b. account_no_session shows the account message, not the generic one', async () => {
  const f = scriptedFetch([
    { status: 200, body: okBody(900) },
    { status: 403, body: { valid: false, terminal: true, code: 'account_no_session' } },
  ]);
  const sb = boot('proxy-gateway', f);
  await sb.__advance(100);
  await sb.__t.validate();
  const msg = sb.__t.el.msg.textContent;
  assert.ok(/temporarily unavailable/i.test(msg), 'specific account message, got: ' + msg);
  assert.ok(!/could not be verified/i.test(msg), 'must not be the generic message');
});

// ══ 10. Backend restart during a session recovers safely ════════════════════
test('10. a backend restart (502/503/504 burst) recovers without ending the session', async () => {
  const f = scriptedFetch([
    { status: 200, body: okBody(900) },
    { status: 502, body: {} },
    { status: 503, body: {} },
    { status: 504, body: {} },
    { status: 200, body: okBody(820) },
  ]);
  const sb = boot('proxy-gateway', f, { validateGraceMs: 0 });
  await sb.__advance(100);
  await sb.__t.validate();
  assert.strictEqual(sb.__t.state.terminal, false, '502 not terminal');
  await sb.__advance(120000);
  assert.strictEqual(sb.__t.state.terminal, false, 'survived the restart burst');
  assert.strictEqual(sb.__t.state.degraded, false, 'recovered and cleared the warning');
});

test('10b. HTTP 429 is retryable, not terminal (the production trigger)', async () => {
  const f = scriptedFetch([
    { status: 200, body: okBody(900) },
    { status: 429, body: { error: 'Too many requests from this IP. Please try again later.' } },
  ]);
  const sb = boot('proxy-gateway', f, { validateGraceMs: 0 });
  await sb.__advance(100);
  await sb.__t.validate();
  assert.strictEqual(sb.__t.state.terminal, false, '429 MUST NOT terminate the session');
  assert.strictEqual(sb.__t.state.degraded, true);
  assert.ok(!/could not be verified/i.test(sb.__t.el.msg.textContent),
    'must not show the terminal message, got: ' + sb.__t.el.msg.textContent);
});

// ══ 11. Countdown never displays a stale frozen value ═══════════════════════
test('11. the countdown never freezes during a sustained outage', async () => {
  const f = scriptedFetch([
    { status: 200, body: okBody(600) },
    { status: 500, body: { code: 'server_error' } },
  ]);
  const sb = boot('proxy-gateway', f, { validateGraceMs: 0 });
  await sb.__advance(100);
  const samples = [];
  for (let i = 0; i < 5; i++) { await sb.__advance(10000); samples.push(sb.__t.state.secondsRemaining); }
  for (let i = 1; i < samples.length; i++) {
    assert.ok(samples[i] < samples[i - 1], 'countdown must keep decreasing: ' + JSON.stringify(samples));
  }
  assert.strictEqual(sb.__t.state.terminal, false);
});

test('11b. the countdown is driven by absolute expiry, so it survives a stalled tab', async () => {
  const f = scriptedFetch([{ status: 200, body: liveOkBody(600) }]);
  const sb = boot('proxy-gateway', f);
  await sb.__advance(100);
  const start = sb.__t.state.secondsRemaining;
  await sb.__advance(120000);          // 2 real minutes pass
  const after = sb.__t.state.secondsRemaining;
  assert.ok(start - after >= 110, 'elapsed wall-clock is reflected, not tick count: ' + start + ' → ' + after);
});

test('11c. an expired absolute deadline reaches 0 and never goes negative', async () => {
  const f = scriptedFetch([{ status: 200, body: liveOkBody(5) }]);
  const sb = boot('proxy-gateway', f, { validateGraceMs: 0 });
  await sb.__advance(100);
  await sb.__advance(30000);
  assert.strictEqual(sb.__t.state.secondsRemaining, 0, 'clamped at zero');
});

// ══ 12. Every gateway passes the same regression ════════════════════════════
for (const gw of GATEWAYS) {
  test('12. ' + gw + ': 500 is retryable and a revocation is terminal', async () => {
    const transient = scriptedFetch([
      { status: 200, body: okBody(900) },
      { status: 500, body: { valid: false, code: 'server_error' } },
    ]);
    const a = boot(gw, transient, { validateGraceMs: 0 });
    await a.__advance(100);
    await a.__t.validate();
    assert.strictEqual(a.__t.state.terminal, false, gw + ': 500 must not terminate');
    assert.strictEqual(a.__t.state.degraded, true, gw + ': should show the retry warning');

    const denied = scriptedFetch([
      { status: 200, body: okBody(900) },
      { status: 403, body: { valid: false, terminal: true, code: 'lease_revoked' } },
    ]);
    const b = boot(gw, denied);
    await b.__advance(100);
    await b.__t.validate();
    assert.strictEqual(b.__t.state.terminal, true, gw + ': revocation MUST terminate');
  });
}

test('12b. every overlay backs off with jitter and stops piling up timers', async () => {
  const f = scriptedFetch([{ status: 200, body: okBody(900) }, { status: 500, body: {} }]);
  const sb = boot('proxy-gateway', f, { validateGraceMs: 0 });
  await sb.__advance(100);
  const baseline = sb.__pendingTimers();
  await sb.__t.validate();
  await sb.__advance(300000);          // 5 minutes of sustained failure
  assert.ok(sb.__pendingTimers() <= baseline + 2, 'no unbounded timer growth: ' + sb.__pendingTimers());
  assert.strictEqual(sb.__t.state.terminal, false, 'still alive after 5 minutes of failures');
});

test('12c. no overlay logs the lease token, cookies or credentials', () => {
  for (const gw of GATEWAYS) {
    const src = fs.readFileSync(path.join(REPO, gw, 'public/overlay.js'), 'utf8');
    const logBody = src.slice(src.indexOf('function log(evt'), src.indexOf('function apiCall'));
    for (const forbidden of ['LEASE', 'document.cookie', 'authorization', 'Bearer']) {
      assert.ok(!logBody.includes(forbidden), gw + ': log() must never touch ' + forbidden);
    }
  }
});

// ════════════════════════════════════════════════════════════════════════════
// 13. MOBILE session renewal — the bug: on a phone, "reopen the tool from your
//     dashboard" resurfaces the EXISTING tab out of bfcache / the frozen-tab store
//     instead of building a new document. That tab still holds state.terminal from the
//     session that expired, and both validate() and tick() early-return on terminal, so
//     the expired widget is replayed forever even though a fresh 30-minute lease was
//     issued and its cookie is already installed. Desktop was never affected because
//     window.open(url,'_blank') there really does create a fresh document.
//
//     CLAUDE ONLY — every other gateway's overlay must be byte-for-byte unchanged.
// ════════════════════════════════════════════════════════════════════════════
const CLAUDE_CFG = { tool: 'claude', toolName: 'Claude AI' };
const EXPIRED = { status: 403, body: { valid: false, terminal: true, retryable: false, code: 'lease_expired' } };

/**
 * The claude overlay makes several unrelated calls of its own — /__genz/usage for the
 * estimated-usage meter and /api/organizations for the workspace switcher. Only
 * /__genz/validate may consume a scripted step; everything else gets a benign stub. Without
 * this the side calls silently shifted the script and every later assertion drifted, and
 * `count()` would not mean "validate calls".
 */
function claudeFetch(steps) {
  const inner = scriptedFetch(steps);
  const fn = function (url) {
    if (String(url || '').indexOf('/__genz/validate') === -1) {
      return Promise.resolve({ status: 200, json: () => Promise.resolve({ ok: true, enabled: false, synced: false }) });
    }
    return inner.apply(this, arguments);
  };
  fn.calls = inner.calls;
  fn.count = () => inner.count();
  Object.defineProperty(fn, 'clock', { get: () => inner.clock, set: (v) => { inner.clock = v; } });
  return fn;
}

// Drive a claude overlay to the terminal state the phone would be frozen in.
async function bootExpiredClaude(steps) {
  const f = claudeFetch([{ status: 200, body: okBody(5) }].concat(steps));
  const sb = boot('claude-gateway', f, CLAUDE_CFG);
  await sb.__advance(100);
  await sb.__advance(31000);                 // the 30s poll lands on the expired verdict
  assert.strictEqual(sb.__t.state.terminal, true, 'precondition: overlay is in the expired state');
  return sb;
}

test('13a. THE BUG: a restored mobile tab recovers once a dashboard launch issues a fresh lease', async () => {
  const sb = await bootExpiredClaude([EXPIRED, { status: 200, body: liveOkBody(1800) }]);
  const deadWidget = sb.__t.state.secondsRemaining;
  assert.strictEqual(deadWidget, 0, 'expired widget is sitting at 0:00');

  // The client relaunches from the dashboard in another tab; the fresh __Host-claude_session
  // cookie is now installed on this origin. The phone then resurfaces THIS frozen tab.
  sb.__fire('window', 'pageshow', { persisted: true });
  await sb.__advance(200);

  assert.strictEqual(sb.__t.state.terminal, false, 'terminal state must be discarded, not replayed');
  assert.ok(sb.__t.state.secondsRemaining > 1700,
    'countdown re-anchored to the NEW lease, got ' + sb.__t.state.secondsRemaining);
  assert.ok(sb.__t.state.expiresAtMs > 0, 'anchored to the new server-issued absolute expiry');
});

test('13b. SECURITY: a resume with NO new lease must not renew anything', async () => {
  const sb = await bootExpiredClaude([EXPIRED]);   // server keeps saying expired
  for (const ev of [['window', 'pageshow', { persisted: true }], ['document', 'visibilitychange'], ['window', 'focus'], ['window', 'online']]) {
    sb.__fire(ev[0], ev[1], ev[2]);
    await sb.__advance(5000);
    assert.strictEqual(sb.__t.state.terminal, true, ev[1] + ' alone must never renew access');
    assert.strictEqual(sb.__t.state.secondsRemaining, 0, ev[1] + ' must not put time back on the clock');
  }
});

test('13c. the 30s poll stays dead while terminal — only a resume event re-reaches the server', async () => {
  const f = claudeFetch([{ status: 200, body: okBody(5) }, EXPIRED, { status: 200, body: liveOkBody(1800) }]);
  const sb = boot('claude-gateway', f, CLAUDE_CFG);
  await sb.__advance(100);
  await sb.__advance(31000);
  assert.strictEqual(sb.__t.state.terminal, true);

  // Four minutes — eight 30s polls — must produce ZERO requests: terminal short-circuits
  // them. So a frozen tab can never heal itself by waiting; the resume event is the only way.
  const afterTerminal = f.count();
  await sb.__advance(240000);
  assert.strictEqual(f.count(), afterTerminal, 'terminal suppresses the periodic poll entirely');
  assert.strictEqual(sb.__t.state.terminal, true, 'and it is still showing the expired state');

  // The resume path bypasses that short-circuit and picks up the freshly issued lease.
  sb.__fire('window', 'pageshow', { persisted: true });
  await sb.__advance(200);
  assert.strictEqual(f.count(), afterTerminal + 1, 'exactly one re-check was issued');
  assert.strictEqual(sb.__t.state.terminal, false, 'the new lease was adopted');
});

test('13d. resume events are throttled so a burst is one request, not a storm', async () => {
  const f = claudeFetch([{ status: 200, body: okBody(5) }, EXPIRED, EXPIRED, EXPIRED, EXPIRED, EXPIRED]);
  const sb = boot('claude-gateway', f, CLAUDE_CFG);
  await sb.__advance(100);
  await sb.__advance(31000);
  const before = f.count();
  // A phone fires pageshow + visibilitychange + focus back-to-back on every resume.
  sb.__fire('window', 'pageshow', { persisted: true });
  sb.__fire('document', 'visibilitychange');
  sb.__fire('window', 'focus');
  await sb.__advance(200);
  assert.strictEqual(f.count() - before, 1, 'the burst coalesced into a single validate call');
});

test('13e. NO OTHER TOOL CHANGES: only the claude overlay registers resume listeners', async () => {
  for (const gw of GATEWAYS) {
    const f = scriptedFetch([{ status: 200, body: okBody(5) }, EXPIRED]);
    const cfg = gw === 'claude-gateway' ? CLAUDE_CFG : undefined;
    const sb = boot(gw, f, cfg);
    await sb.__advance(100);
    const expected = gw === 'claude-gateway' ? 1 : 0;
    assert.strictEqual(sb.__listenerCount('window', 'pageshow'), expected, gw + ': pageshow listener count');
    assert.strictEqual(sb.__listenerCount('document', 'visibilitychange'), expected, gw + ': visibilitychange listener count');
  }
});

test('13f. a non-claude overlay stays terminal on resume events (behaviour unchanged)', async () => {
  const f = scriptedFetch([{ status: 200, body: okBody(5) }, EXPIRED, { status: 200, body: liveOkBody(1800) }]);
  const sb = boot('proxy-gateway', f);
  await sb.__advance(100);
  await sb.__advance(31000);
  assert.strictEqual(sb.__t.state.terminal, true);
  sb.__fire('window', 'pageshow', { persisted: true });
  sb.__fire('document', 'visibilitychange');
  await sb.__advance(5000);
  assert.strictEqual(sb.__t.state.terminal, true, 'proxy-gateway must behave exactly as before');
});
