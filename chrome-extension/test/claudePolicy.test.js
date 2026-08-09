/**
 * Regression tests for the EXTENSION-BASED Claude model + effort policy
 * (chrome-extension/js/claudeEnforcer.js).
 *
 * These cover the extension path ONLY. The proxy gateway has its own separate suite
 * (claude-gateway/lib/{modelPolicy,effortPolicy}.test.js) and is not exercised or
 * affected here.
 *
 * The enforcer is a browser IIFE, so each test boots it inside a `vm` sandbox with just
 * enough of a DOM to run: that lets us assert on the REAL shipped file rather than on a
 * re-implementation of it.
 */
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const ENFORCER = fs.readFileSync(
  path.join(__dirname, '..', 'js', 'claudeEnforcer.js'), 'utf8'
);

/** Minimal localStorage/sessionStorage stand-in backed by a Map. */
function makeStore(StorageProto, seed) {
  const map = new Map(Object.entries(seed || {}));
  const store = Object.create(StorageProto);
  Object.defineProperties(store, {
    length: { get: () => map.size },
    key: { value: (i) => Array.from(map.keys())[i] ?? null },
    getItem: { value: (k) => (map.has(k) ? map.get(k) : null) },
    removeItem: { value: (k) => map.delete(k) },
    __map: { value: map },
  });
  return store;
}

/** Boot the enforcer in a fresh sandbox. Returns the sandbox + a record of fetch calls. */
function loadEnforcer({ localSeed, sessionSeed } = {}) {
  const calls = [];
  const xhrSends = [];
  const xhrOpens = [];

  function StorageProto() {}
  StorageProto.prototype.setItem = function (k, v) { this.__map.set(k, String(v)); };

  function XMLHttpRequest() {}
  XMLHttpRequest.prototype.open = function (...args) { xhrOpens.push(args); };
  XMLHttpRequest.prototype.send = function (body) { xhrSends.push(body); };

  const win = {
    fetch: (input, init) => { calls.push({ input, init }); return Promise.resolve('ok'); },
    URL, URLSearchParams, FormData,
    XMLHttpRequest,
    Storage: StorageProto,
    MutationObserver: class { observe() {} },
    navigator: { sendBeacon: () => true },
    location: { href: 'https://claude.ai/new' },
    document: {
      readyState: 'complete',
      documentElement: {},
      addEventListener() {},
      querySelectorAll: () => [],
    },
  };
  win.window = win;
  win.self = win;
  win.localStorage = makeStore(StorageProto.prototype, localSeed);
  win.sessionStorage = makeStore(StorageProto.prototype, sessionSeed);

  const ctx = vm.createContext(win);
  vm.runInContext(ENFORCER, ctx);
  return { win, calls, xhrSends, xhrOpens };
}

// ── Model policy ─────────────────────────────────────────────────────────────

test('model: every fable variant becomes the approved model', () => {
  const { win } = loadEnforcer();
  const P = win.__GENZ_CLAUDE_POLICY__;
  for (const m of ['claude-fable-5', 'fable-5-latest', 'claude-fable-5-20260101', 'FABLE-5']) {
    assert.strictEqual(P.sanitizeModel(m), 'claude-sonnet-5', `${m} must be blocked`);
  }
});

test('model: permitted models pass through byte-identically', () => {
  const { win } = loadEnforcer();
  const P = win.__GENZ_CLAUDE_POLICY__;
  for (const m of ['claude-sonnet-5', 'claude-opus-5', 'claude-haiku-4-5-20251001']) {
    assert.strictEqual(P.sanitizeModel(m), m);
  }
});

test('model: prose containing the word "fable" is NOT rewritten', () => {
  const { win } = loadEnforcer();
  const P = win.__GENZ_CLAUDE_POLICY__;
  const body = { prompt: 'Please write me a fable about a fox', model: 'claude-sonnet-5' };
  const r = P.sanitizeTree(body, 0);
  assert.strictEqual(r.changed, false);
  assert.strictEqual(r.value.prompt, 'Please write me a fable about a fox');
});

// ── Effort policy ────────────────────────────────────────────────────────────

test('effort: low and medium are preserved exactly', () => {
  const { win } = loadEnforcer();
  const P = win.__GENZ_CLAUDE_POLICY__;
  assert.strictEqual(P.sanitizeEffort('low'), 'low');
  assert.strictEqual(P.sanitizeEffort('medium'), 'medium');
  assert.strictEqual(P.isEffortAllowed('low'), true);
  assert.strictEqual(P.isEffortAllowed('medium'), true);
});

test('effort: high, extra and max are all blocked down to medium', () => {
  const { win } = loadEnforcer();
  const P = win.__GENZ_CLAUDE_POLICY__;
  for (const e of ['high', 'High', 'extra', 'Extra High', 'extra_high', 'extraHigh',
                   'very-high', 'max', 'Maximum', 'highest', 'ultra']) {
    assert.strictEqual(P.sanitizeEffort(e), 'medium', `${e} must downgrade to medium`);
    assert.strictEqual(P.isEffortAllowed(e), false);
  }
});

test('effort: an unrecognised value is left alone rather than guessed at', () => {
  const { win } = loadEnforcer();
  const P = win.__GENZ_CLAUDE_POLICY__;
  assert.strictEqual(P.sanitizeEffort('banana'), 'banana');
  assert.strictEqual(P.canonicalEffort('banana'), null);
});

test('INVARIANT: no input can ever produce a blocked output', () => {
  const { win } = loadEnforcer();
  const P = win.__GENZ_CLAUDE_POLICY__;
  const blocked = /^(high|extra|max)$/i;
  for (const e of ['high', 'extra', 'max', 'ultra', 'highest', 'very high', 'low', 'medium']) {
    const out = P.sanitizeEffort(e);
    if (P.canonicalEffort(e) && !['low', 'medium'].includes(P.canonicalEffort(e))) {
      assert.ok(!blocked.test(out), `${e} produced blocked output ${out}`);
    }
  }
  assert.ok(!/fable/i.test(P.sanitizeModel('claude-fable-5')));
});

// ── Request path ─────────────────────────────────────────────────────────────

test('request: a blocked model+effort in a fetch JSON body is rewritten', async () => {
  const { win, calls } = loadEnforcer();
  await win.fetch('https://claude.ai/api/completion', {
    method: 'POST',
    body: JSON.stringify({ model: 'claude-fable-5', effort: 'max', prompt: 'hi' }),
  });
  const sent = JSON.parse(calls[0].init.body);
  assert.strictEqual(sent.model, 'claude-sonnet-5');
  assert.strictEqual(sent.effort, 'medium');
  assert.strictEqual(sent.prompt, 'hi', 'unrelated fields must survive untouched');
});

test('request: a clean body is forwarded as the ORIGINAL bytes (no re-serialisation)', async () => {
  const { win, calls } = loadEnforcer();
  const original = JSON.stringify({ model: 'claude-sonnet-5', effort: 'low' });
  await win.fetch('https://claude.ai/api/completion', { method: 'POST', body: original });
  assert.strictEqual(calls[0].init.body, original);
});

test('request: nested blocked values are caught at depth', async () => {
  const { win, calls } = loadEnforcer();
  await win.fetch('https://claude.ai/api/x', {
    method: 'POST',
    body: JSON.stringify({ settings: { conversation: { model: 'claude-fable-5', thinking_level: 'high' } } }),
  });
  const sent = JSON.parse(calls[0].init.body);
  assert.strictEqual(sent.settings.conversation.model, 'claude-sonnet-5');
  assert.strictEqual(sent.settings.conversation.thinking_level, 'medium');
});

test('request: blocked values in the URL query string are rewritten', async () => {
  const { win, calls } = loadEnforcer();
  await win.fetch('https://claude.ai/api/x?model=claude-fable-5&effort=max');
  assert.ok(!/fable/.test(calls[0].input));
  assert.ok(/model=claude-sonnet-5/.test(calls[0].input));
  assert.ok(/effort=medium/.test(calls[0].input));
});

test('TAMPER: reassigning window.fetch does not defeat the policy', async () => {
  const { win } = loadEnforcer();
  const seen = [];
  win.fetch = (input, init) => { seen.push(init && init.body); return Promise.resolve('ok'); };
  await win.fetch('https://claude.ai/api/completion', {
    method: 'POST', body: JSON.stringify({ model: 'claude-fable-5' }),
  });
  assert.ok(!/fable/i.test(seen[0]), 'page-side fetch override must still be sanitised');
});

test('request: XHR send bodies are sanitised', () => {
  const { win, xhrSends } = loadEnforcer();
  const x = new win.XMLHttpRequest();
  x.send(JSON.stringify({ model: 'claude-fable-5', effort: 'extra' }));
  const sent = JSON.parse(xhrSends[0]);
  assert.strictEqual(sent.model, 'claude-sonnet-5');
  assert.strictEqual(sent.effort, 'medium');
});

// ── Stored preferences ───────────────────────────────────────────────────────

test('storage: a pre-existing blocked preference is migrated at load', () => {
  const { win } = loadEnforcer({
    localSeed: {
      lastModel: 'claude-fable-5',
      lastEffort: 'max',
      convo: JSON.stringify({ model: 'claude-fable-5', effort: 'high' }),
      unrelated: 'keep me',
    },
  });
  assert.strictEqual(win.localStorage.getItem('lastModel'), 'claude-sonnet-5');
  assert.strictEqual(win.localStorage.getItem('lastEffort'), 'medium');
  const convo = JSON.parse(win.localStorage.getItem('convo'));
  assert.strictEqual(convo.model, 'claude-sonnet-5');
  assert.strictEqual(convo.effort, 'medium');
  assert.strictEqual(win.localStorage.getItem('unrelated'), 'keep me');
});

test('storage: a later write cannot re-pin a blocked value', () => {
  const { win } = loadEnforcer();
  win.localStorage.setItem('effort', 'max');
  win.localStorage.setItem('model', 'claude-fable-5');
  win.sessionStorage.setItem('effort', 'extra high');
  assert.strictEqual(win.localStorage.getItem('effort'), 'medium');
  assert.strictEqual(win.localStorage.getItem('model'), 'claude-sonnet-5');
  assert.strictEqual(win.sessionStorage.getItem('effort'), 'medium');
});

test('storage: allowed values still round-trip untouched', () => {
  const { win } = loadEnforcer();
  win.localStorage.setItem('effort', 'low');
  win.localStorage.setItem('model', 'claude-opus-5');
  assert.strictEqual(win.localStorage.getItem('effort'), 'low');
  assert.strictEqual(win.localStorage.getItem('model'), 'claude-opus-5');
});
