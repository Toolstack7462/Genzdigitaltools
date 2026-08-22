/**
 * ChatGPT Plus / Pro assignment-expiry ISOLATION.
 *
 * THE DEFECT. Two separately assigned ChatGPT products are distinct tools with distinct
 * toolIds, but both resolve to chatgpt.com. backend/utils/toolCleanupConfig.js derives
 * tabUrlPatterns from the HOST, so both produce the identical `*://chatgpt.com/*`.
 * background.js clearStorageAndRedirectTabs() matched tabs by that pattern alone and
 * redirected EVERY match — so expiring "Chat Gpt Pro" redirected the still-active
 * "ChatGPT Plus" tab to expired.html?tool=Chat%20Gpt%20Pro.
 *
 * The backend was never wrong: /cleanup-manifest already classifies per toolId. The
 * extension discarded that identity. These tests pin the corrected model.
 *
 * Layer 1 (BEHAVIOURAL) executes the real clearStorageAndRedirectTabs / clearCookiesForConfig
 * / cleanupToolSession from background.js in a node:vm realm against a chrome API harness
 * built here — no new dependency, no second framework. Layer 2 guards the wiring by source.
 */
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const EXT = path.join(__dirname, '..');
const BG_SRC = fs.readFileSync(path.join(EXT, 'js', 'background.js'), 'utf8');
const EXPIRED_SRC = fs.readFileSync(path.join(EXT, 'js', 'expired.js'), 'utf8');

// ─────────────────────────────────────────────────────────────────────────────
// Harness: extract the cleanup helpers and run them against a fake chrome API.
// ─────────────────────────────────────────────────────────────────────────────
// background.js is a 3600-line ES module full of listeners; importing it wholesale would
// execute all of them. Instead we lift the exact functions under test — verbatim, by brace
// matching — so the code executed here IS the shipped code, not a paraphrase of it.
function lift(names) {
  let out = '';
  for (const name of names) {
    const decl = `async function ${name}(`;
    const i = BG_SRC.indexOf(decl);
    assert.ok(i !== -1, `${name}() not found in background.js`);
    let d = 0, started = false, end = i;
    for (let k = BG_SRC.indexOf('{', i); k < BG_SRC.length; k++) {
      if (BG_SRC[k] === '{') { d++; started = true; }
      else if (BG_SRC[k] === '}') { d--; if (started && d === 0) { end = k + 1; break; } }
    }
    out += BG_SRC.slice(i, end) + '\n';
  }
  return out;
}

const LIFTED = [
  'clearCookiesForConfig',
  'clearStorageAndRedirectTabs',
  'cleanupToolSession',
  'getTabBindings',
  'getTabBinding',
  'nextLaunchGeneration',
  'bindTabToTool',
  'unbindTab',
  'pruneTabBindings',
];

const EXT_URL = 'chrome-extension://abcdef/';

// Convert a chrome match pattern (`*://chatgpt.com/*`) into a predicate.
function patternMatches(pattern, url) {
  const re = new RegExp('^' + String(pattern)
    .replace(/[.+?^${}()|[\]\\]/g, '\\$&')
    .replace(/^\\\*:\/\//, 'https?://')
    .replace(/\*/g, '.*') + '$');
  return re.test(url);
}

function makeEnv(opts) {
  const o = opts || {};
  const store = Object.assign({}, o.storage || {});
  const tabs = (o.tabs || []).map((t) => Object.assign({}, t));
  const cookies = (o.cookies || []).map((c) => Object.assign({}, c));
  const log = { redirects: [], removedCookies: [], info: [] };

  const chrome = {
    runtime: { getURL: (p) => EXT_URL + (p || '') },
    storage: {
      local: {
        get: async (keys) => {
          const out = {};
          for (const k of [].concat(keys)) if (k in store) out[k] = store[k];
          return out;
        },
        set: async (obj) => { Object.assign(store, obj); },
        remove: async (keys) => { for (const k of [].concat(keys)) delete store[k]; },
      },
    },
    tabs: {
      query: async (q) => {
        if (!q || !q.url) return tabs.slice();
        const pats = [].concat(q.url);
        return tabs.filter((t) => pats.some((p) => patternMatches(p, t.url)));
      },
      update: async (tabId, props) => {
        const t = tabs.find((x) => x.id === tabId);
        if (!t) throw new Error('no such tab');
        if (props && props.url) { t.url = props.url; log.redirects.push({ tabId, url: props.url }); }
        return t;
      },
    },
    cookies: {
      getAll: async ({ domain }) => cookies.filter((c) => c.domain.replace(/^\./, '').endsWith(domain)),
      remove: async ({ name, url }) => { log.removedCookies.push({ name, url }); return { name }; },
    },
    scripting: { executeScript: async () => [{ result: 0 }] },
    notifications: { create: () => {} },
  };

  const logger = {
    debug: () => {}, warn: () => {}, error: () => {},
    info: (m, d) => log.info.push({ m, d }),
  };

  const ctx = vm.createContext({ chrome, logger, console, Date, Set, Map, URL, JSON });
  ctx.globalThis = ctx;

  // The few module-level helpers the lifted functions close over.
  const PRELUDE = `
    const TAB_BINDINGS_KEY = 'genzTabBindings';
    const LAUNCH_GEN_KEY = 'genzLaunchGeneration';
    const PROTECTED_HOST_RE = /(^|\\.)genzdigitalstore\\.com$/i;
    function isProtectedHost(host) { return !!host && PROTECTED_HOST_RE.test(String(host)); }
    async function getStorage(keys) { return chrome.storage.local.get(keys); }
    async function setStorage(obj) { return chrome.storage.local.set(obj); }
    async function getAppOrigin() { return 'https://app.genzdigitalstore.com'; }
    async function getKnownTools() { return {}; }
    async function setKnownTools() {}
    async function logCleanup() {}
    async function removeStorage(keys) { return chrome.storage.local.remove(keys); }
    function sessionCacheKey(toolId) { return 'genzSession:' + toolId; }
    const domainToolMap = new Map();
  `;
  vm.runInContext(PRELUDE + lift(LIFTED), ctx);

  const call = (fn, ...args) => vm.runInContext(
    `(${fn})(...globalThis.__ARGS__)`,
    Object.assign(ctx, { __ARGS__: args }));

  return { ctx, chrome, store, tabs, log, call };
}

// Two DISTINCT tools that share one hostname — the whole point of the defect.
const PLUS = {
  toolId: '651plus',
  cleanup: {
    name: 'ChatGPT Plus', tool_code: '651plus',
    domains: ['chatgpt.com'], cookieDomains: ['chatgpt.com', '.chatgpt.com'],
    tabUrlPatterns: ['*://chatgpt.com/*', '*://*.chatgpt.com/*'],
  },
};
const PRO = {
  toolId: '772pro',
  cleanup: {
    name: 'Chat Gpt Pro', tool_code: '772pro',
    domains: ['chatgpt.com'], cookieDomains: ['chatgpt.com', '.chatgpt.com'],
    tabUrlPatterns: ['*://chatgpt.com/*', '*://*.chatgpt.com/*'],
  },
};
const CLAUDE = {
  toolId: '900claude',
  cleanup: {
    name: 'Claude', tool_code: '900claude',
    domains: ['claude.ai'], cookieDomains: ['claude.ai'],
    tabUrlPatterns: ['*://claude.ai/*'],
  },
};

// The activeScope runCleanup() builds from the manifest's active[] entries.
function scopeOf(...entries) {
  const domains = new Set(), patterns = new Set();
  for (const e of entries) {
    for (const d of [...(e.cleanup.cookieDomains || []), ...(e.cleanup.domains || [])]) {
      domains.add(String(d).replace(/^\./, '').toLowerCase());
    }
    for (const p of (e.cleanup.tabUrlPatterns || [])) patterns.add(p);
  }
  return { domains, patterns };
}

const bindings = (map) => ({ genzTabBindings: map, genzLaunchGeneration: 100 });
const bind = (toolId, toolName, gen) => ({ toolId, toolName, gen: gen || 1, boundAt: 1 });

// ─────────────────────────────────────────────────────────────────────────────
// 1. Harness self-check
// ─────────────────────────────────────────────────────────────────────────────
test('harness: the real shipped functions are lifted and runnable', () => {
  const env = makeEnv({ tabs: [{ id: 1, url: 'https://chatgpt.com/c/x' }] });
  assert.ok(patternMatches('*://chatgpt.com/*', 'https://chatgpt.com/c/x'));
  assert.ok(!patternMatches('*://claude.ai/*', 'https://chatgpt.com/c/x'));
  assert.strictEqual(typeof env.call('clearStorageAndRedirectTabs'), 'object'); // returns a promise
});

// ─────────────────────────────────────────────────────────────────────────────
// 2. THE REPORTED DEFECT — Plus active, Pro expired
// ─────────────────────────────────────────────────────────────────────────────
test('REPRODUCTION: the PRE-FIX call shape (no toolId) redirects the sibling — the reported bug', async () => {
  // This is exactly what cleanupToolSession used to do: pass only (cleanup, toolName, reason).
  // Reproducing it here proves the harness genuinely detects the defect, so the passing
  // regression tests below are evidence of the fix rather than of a blind spot.
  const env = makeEnv({
    tabs: [{ id: 11, url: 'https://chatgpt.com/c/plus-chat' }],
    storage: bindings({ 11: bind(PLUS.toolId, 'ChatGPT Plus') }),
  });
  const r = await env.call('clearStorageAndRedirectTabs', PRO.cleanup, 'Chat Gpt Pro', 'expired');
  assert.strictEqual(r.redirected, 1, 'host-only matching hits the Plus tab');
  assert.strictEqual(new URL(env.log.redirects[0].url).searchParams.get('tool'), 'Chat Gpt Pro',
    'and mislabels it as Pro — precisely the reported screenshot');
});

test('REGRESSION: expiring Pro does NOT redirect the active Plus tab', async () => {
  const env = makeEnv({
    tabs: [{ id: 11, url: 'https://chatgpt.com/c/plus-chat' }],
    storage: bindings({ 11: bind(PLUS.toolId, 'ChatGPT Plus') }),
  });
  await env.call('cleanupToolSession', { ...PRO, reason: 'expired' }, scopeOf(PLUS));

  assert.strictEqual(env.log.redirects.length, 0,
    'the Plus tab must not be redirected because a sibling ChatGPT product expired');
  assert.strictEqual(env.tabs[0].url, 'https://chatgpt.com/c/plus-chat', 'Plus stays where it was');
});

test('REGRESSION: expiring Pro does NOT wipe the shared chatgpt.com cookies Plus needs', async () => {
  const env = makeEnv({
    tabs: [{ id: 11, url: 'https://chatgpt.com/' }],
    cookies: [{ name: '__Secure-next-auth.session-token', domain: 'chatgpt.com', path: '/', secure: true }],
    storage: bindings({ 11: bind(PLUS.toolId, 'ChatGPT Plus') }),
  });
  await env.call('cleanupToolSession', { ...PRO, reason: 'expired' }, scopeOf(PLUS));
  assert.strictEqual(env.log.removedCookies.length, 0,
    'clearing chatgpt.com cookies would log the active Plus session out');
});

test('the expired Pro tab IS redirected, and labelled Pro', async () => {
  const env = makeEnv({
    tabs: [
      { id: 11, url: 'https://chatgpt.com/c/plus-chat' },
      { id: 22, url: 'https://chatgpt.com/c/pro-chat' },
    ],
    storage: bindings({
      11: bind(PLUS.toolId, 'ChatGPT Plus'),
      22: bind(PRO.toolId, 'Chat Gpt Pro'),
    }),
  });
  await env.call('cleanupToolSession', { ...PRO, reason: 'expired' }, scopeOf(PLUS));

  assert.strictEqual(env.log.redirects.length, 1, 'exactly one tab — the Pro tab');
  assert.strictEqual(env.log.redirects[0].tabId, 22);
  const u = new URL(env.log.redirects[0].url);
  assert.strictEqual(u.searchParams.get('tool'), 'Chat Gpt Pro');
  assert.strictEqual(u.searchParams.get('toolId'), PRO.toolId, 'exact assignment id must travel');
  assert.strictEqual(env.tabs[0].url, 'https://chatgpt.com/c/plus-chat', 'Plus untouched');
});

// ─────────────────────────────────────────────────────────────────────────────
// 3. Mirror case — Pro active, Plus expired
// ─────────────────────────────────────────────────────────────────────────────
test('MIRROR: expiring Plus does NOT redirect the active Pro tab', async () => {
  const env = makeEnv({
    tabs: [
      { id: 11, url: 'https://chatgpt.com/c/pro-chat' },
      { id: 22, url: 'https://chatgpt.com/c/plus-chat' },
    ],
    storage: bindings({
      11: bind(PRO.toolId, 'Chat Gpt Pro'),
      22: bind(PLUS.toolId, 'ChatGPT Plus'),
    }),
  });
  await env.call('cleanupToolSession', { ...PLUS, reason: 'expired' }, scopeOf(PRO));

  assert.deepStrictEqual(env.log.redirects.map(r => r.tabId), [22], 'only the Plus tab');
  const u = new URL(env.log.redirects[0].url);
  assert.strictEqual(u.searchParams.get('tool'), 'ChatGPT Plus');
  assert.strictEqual(u.searchParams.get('toolId'), PLUS.toolId);
});

// ─────────────────────────────────────────────────────────────────────────────
// 4. Both expired — each reports its own exact identity
// ─────────────────────────────────────────────────────────────────────────────
test('BOTH EXPIRED: Plus shows Plus and Pro shows Pro', async () => {
  const env = makeEnv({
    tabs: [
      { id: 11, url: 'https://chatgpt.com/a' },
      { id: 22, url: 'https://chatgpt.com/b' },
    ],
    storage: bindings({
      11: bind(PLUS.toolId, 'ChatGPT Plus'),
      22: bind(PRO.toolId, 'Chat Gpt Pro'),
    }),
  });
  await env.call('cleanupToolSession', { ...PLUS, reason: 'expired' }, scopeOf());
  await env.call('cleanupToolSession', { ...PRO, reason: 'revoked' }, scopeOf());

  const byTab = Object.fromEntries(env.log.redirects.map(r => [r.tabId, new URL(r.url)]));
  assert.strictEqual(byTab[11].searchParams.get('tool'), 'ChatGPT Plus');
  assert.strictEqual(byTab[11].searchParams.get('toolId'), PLUS.toolId);
  assert.strictEqual(byTab[11].searchParams.get('reason'), 'expired');
  assert.strictEqual(byTab[22].searchParams.get('tool'), 'Chat Gpt Pro');
  assert.strictEqual(byTab[22].searchParams.get('toolId'), PRO.toolId);
  assert.strictEqual(byTab[22].searchParams.get('reason'), 'revoked');
});

// ─────────────────────────────────────────────────────────────────────────────
// 5. Multiple tabs per assignment
// ─────────────────────────────────────────────────────────────────────────────
test('MULTI-TAB: every Pro tab redirects, no Plus tab does', async () => {
  const env = makeEnv({
    tabs: [
      { id: 1, url: 'https://chatgpt.com/p1' }, { id: 2, url: 'https://chatgpt.com/p2' },
      { id: 3, url: 'https://chatgpt.com/x1' }, { id: 4, url: 'https://chatgpt.com/x2' },
    ],
    storage: bindings({
      1: bind(PLUS.toolId, 'ChatGPT Plus'), 2: bind(PLUS.toolId, 'ChatGPT Plus'),
      3: bind(PRO.toolId, 'Chat Gpt Pro'), 4: bind(PRO.toolId, 'Chat Gpt Pro'),
    }),
  });
  await env.call('cleanupToolSession', { ...PRO, reason: 'expired' }, scopeOf(PLUS));
  assert.deepStrictEqual(env.log.redirects.map(r => r.tabId).sort(), [3, 4]);
});

// ─────────────────────────────────────────────────────────────────────────────
// 6. Tab reuse / stale events (Scenario G, Invariants 4 & 5)
// ─────────────────────────────────────────────────────────────────────────────
test('TAB REUSE: a tab re-bound from Pro to Plus is not redirected by the Pro cleanup', async () => {
  // The tab was Pro's; it has since been re-launched as Plus, so it carries Plus's binding.
  const env = makeEnv({
    tabs: [{ id: 7, url: 'https://chatgpt.com/now-plus' }],
    storage: bindings({ 7: bind(PLUS.toolId, 'ChatGPT Plus', 42) }),
  });
  await env.call('cleanupToolSession', { ...PRO, reason: 'expired' }, scopeOf(PLUS));
  assert.strictEqual(env.log.redirects.length, 0, 'the old Pro cleanup must not touch it');
});

test('STALE EVENT: a tab re-bound MID-cleanup is rejected before the redirect', async () => {
  const env = makeEnv({
    tabs: [{ id: 7, url: 'https://chatgpt.com/c' }],
    storage: bindings({ 7: bind(PRO.toolId, 'Chat Gpt Pro', 5) }),
  });
  // The storage clear is an await; simulate the user re-launching Plus into this tab during it.
  env.chrome.scripting.executeScript = async () => {
    env.store.genzTabBindings = { 7: bind(PLUS.toolId, 'ChatGPT Plus', 6) };
    return [{ result: 0 }];
  };
  await env.call('cleanupToolSession', { ...PRO, reason: 'expired' }, scopeOf());
  assert.strictEqual(env.log.redirects.length, 0,
    're-verification immediately before tabs.update must reject the stale redirect');
});

test('GENERATION: same tool but a newer generation is still rejected', async () => {
  const env = makeEnv({
    tabs: [{ id: 7, url: 'https://chatgpt.com/c' }],
    storage: bindings({ 7: bind(PRO.toolId, 'Chat Gpt Pro', 5) }),
  });
  env.chrome.scripting.executeScript = async () => {
    env.store.genzTabBindings = { 7: bind(PRO.toolId, 'Chat Gpt Pro', 9) };  // relaunched
    return [{ result: 0 }];
  };
  await env.call('cleanupToolSession', { ...PRO, reason: 'expired' }, scopeOf());
  assert.strictEqual(env.log.redirects.length, 0, 'a newer launch generation supersedes the event');
});

// ─────────────────────────────────────────────────────────────────────────────
// 7. Unbound tabs — Invariant 7, no unsafe fallback
// ─────────────────────────────────────────────────────────────────────────────
test('UNBOUND + active sibling on the host → left alone (never borrow a sibling state)', async () => {
  const env = makeEnv({
    tabs: [{ id: 9, url: 'https://chatgpt.com/manual' }],
    storage: bindings({}),
  });
  await env.call('cleanupToolSession', { ...PRO, reason: 'expired' }, scopeOf(PLUS));
  assert.strictEqual(env.log.redirects.length, 0,
    'ownership is ambiguous; expiring somebody else’s working session is the worse error');
});

test('UNBOUND + NO active sibling → redirected (single-assignment behaviour preserved)', async () => {
  const env = makeEnv({
    tabs: [{ id: 9, url: 'https://chatgpt.com/manual' }],
    storage: bindings({}),
  });
  await env.call('cleanupToolSession', { ...PRO, reason: 'expired' }, scopeOf());
  assert.strictEqual(env.log.redirects.length, 1,
    'with no sibling the tab can only belong to the expiring tool — old behaviour must remain');
});

// ─────────────────────────────────────────────────────────────────────────────
// 8. Other tools must be unaffected
// ─────────────────────────────────────────────────────────────────────────────
test('OTHER TOOLS: a Claude tab is never touched by a ChatGPT expiry', async () => {
  const env = makeEnv({
    tabs: [
      { id: 1, url: 'https://claude.ai/chat/abc' },
      { id: 2, url: 'https://chatgpt.com/c' },
    ],
    storage: bindings({ 1: bind(CLAUDE.toolId, 'Claude'), 2: bind(PRO.toolId, 'Chat Gpt Pro') }),
  });
  await env.call('cleanupToolSession', { ...PRO, reason: 'expired' }, scopeOf());
  assert.deepStrictEqual(env.log.redirects.map(r => r.tabId), [2]);
});

test('OTHER TOOLS: expiring Claude still works exactly as before (single-host tool)', async () => {
  const env = makeEnv({
    tabs: [{ id: 1, url: 'https://claude.ai/chat/abc' }],
    cookies: [{ name: 'sessionKey', domain: 'claude.ai', path: '/', secure: true }],
    storage: bindings({ 1: bind(CLAUDE.toolId, 'Claude') }),
  });
  await env.call('cleanupToolSession', { ...CLAUDE, reason: 'expired' }, scopeOf());
  assert.strictEqual(env.log.redirects.length, 1, 'Claude expiry must still redirect its tab');
  assert.ok(env.log.removedCookies.length > 0, 'and still clear its cookies');
});

test('the dashboard is never redirected or cleaned', async () => {
  const env = makeEnv({
    tabs: [{ id: 1, url: 'https://app.genzdigitalstore.com/client/dashboard' }],
    storage: bindings({}),
  });
  const wide = {
    toolId: 'x', reason: 'expired',
    cleanup: { name: 'X', domains: ['genzdigitalstore.com'],
      cookieDomains: ['genzdigitalstore.com'], tabUrlPatterns: ['*://*.genzdigitalstore.com/*'] },
  };
  await env.call('cleanupToolSession', wide, scopeOf());
  assert.strictEqual(env.log.redirects.length, 0);
  assert.strictEqual(env.log.removedCookies.length, 0);
});

// ─────────────────────────────────────────────────────────────────────────────
// 9. Idle-timeout path must be unchanged (no toolId → previous behaviour)
// ─────────────────────────────────────────────────────────────────────────────
test('IDLE PATH: without a toolId the helper behaves exactly as before', async () => {
  const env = makeEnv({
    tabs: [{ id: 1, url: 'https://hix.ai/app' }],
    storage: bindings({ 1: bind('some-other-tool', 'Something Else') }),
  });
  const cleanup = { name: 'hix.ai', cookieDomains: ['hix.ai'], domains: ['hix.ai'],
    tabUrlPatterns: ['*://hix.ai/*', '*://*.hix.ai/*'] };
  const r = await env.call('clearStorageAndRedirectTabs', cleanup, 'hix.ai', 'idle_timeout');
  assert.strictEqual(r.redirected, 1,
    'idle expiry is a HOST concept and must not be gated on assignment binding');
  assert.strictEqual(new URL(env.log.redirects[0].url).searchParams.get('reason'), 'idle_timeout');
});

// ─────────────────────────────────────────────────────────────────────────────
// 10. Binding registry mechanics (service-worker restart, cleanup)
// ─────────────────────────────────────────────────────────────────────────────
test('bindings persist to storage and generations increase monotonically', async () => {
  const env = makeEnv({ tabs: [{ id: 5, url: 'https://chatgpt.com/' }] });
  const g1 = await env.call('bindTabToTool', 5, PLUS.toolId, 'ChatGPT Plus');
  const g2 = await env.call('bindTabToTool', 5, PRO.toolId, 'Chat Gpt Pro');
  assert.ok(g2 > g1, 'a re-bind must supersede the previous generation');
  const b = await env.call('getTabBinding', 5);
  assert.strictEqual(b.toolId, PRO.toolId, 'the newest launch owns the tab');
  assert.ok(env.store.genzTabBindings, 'persisted for service-worker restart');
});

test('bindings store IDENTITY ONLY — never cookies, tokens or secrets', async () => {
  const env = makeEnv({ tabs: [{ id: 5, url: 'https://chatgpt.com/' }] });
  await env.call('bindTabToTool', 5, PLUS.toolId, 'ChatGPT Plus');
  const rec = env.store.genzTabBindings['5'];
  assert.deepStrictEqual(Object.keys(rec).sort(), ['boundAt', 'gen', 'toolId', 'toolName']);
  const blob = JSON.stringify(env.store).toLowerCase();
  for (const bad of ['cookie', 'token', 'password', 'authorization', 'secret']) {
    assert.ok(!blob.includes(bad), `binding storage must never contain "${bad}"`);
  }
});

test('closing a tab forgets only that tab; pruning drops vanished tabs', async () => {
  const env = makeEnv({
    tabs: [{ id: 1, url: 'https://chatgpt.com/' }],
    storage: bindings({ 1: bind(PLUS.toolId, 'ChatGPT Plus'), 2: bind(PRO.toolId, 'Chat Gpt Pro') }),
  });
  await env.call('unbindTab', 1);
  assert.ok(!env.store.genzTabBindings['1'], 'the closed tab is forgotten');
  assert.ok(env.store.genzTabBindings['2'], 'the sibling binding is untouched');

  env.store.genzTabBindings = { 1: bind(PLUS.toolId, 'ChatGPT Plus'), 99: bind(PRO.toolId, 'Pro') };
  await env.call('pruneTabBindings');
  assert.ok(env.store.genzTabBindings['1'], 'a live tab keeps its binding');
  assert.ok(!env.store.genzTabBindings['99'], 'a vanished tab is pruned');
});

test('SERVICE-WORKER RESTART: identity is rehydrated from storage, not from the hostname', async () => {
  // Fresh realm (as after a restart) that only has persisted storage — no in-memory state.
  const env = makeEnv({
    tabs: [
      { id: 11, url: 'https://chatgpt.com/a' },
      { id: 22, url: 'https://chatgpt.com/b' },
    ],
    storage: bindings({
      11: bind(PLUS.toolId, 'ChatGPT Plus'), 22: bind(PRO.toolId, 'Chat Gpt Pro'),
    }),
  });
  await env.call('cleanupToolSession', { ...PRO, reason: 'expired' }, scopeOf(PLUS));
  assert.deepStrictEqual(env.log.redirects.map(r => r.tabId), [22],
    'after a restart the Plus tab must still be recognised as Plus');
});

// ─────────────────────────────────────────────────────────────────────────────
// 11. Source-level wiring guards
// ─────────────────────────────────────────────────────────────────────────────
test('WIRING: the exact toolId reaches the redirect helper', () => {
  assert.match(BG_SRC, /clearStorageAndRedirectTabs\(\s*\n?\s*cleanup, toolName, reason, \{ toolId, hostSharedWithActive \}\)/,
    'cleanupToolSession must pass the exact assignment id — dropping it is the original bug');
  assert.match(BG_SRC, /const wantToolId = opts && opts\.toolId != null \? String\(opts\.toolId\) : null;/);
});

test('WIRING: ownership is decided by binding, not by the URL pattern', () => {
  const i = BG_SRC.indexOf('async function clearStorageAndRedirectTabs');
  const fn = BG_SRC.slice(i, BG_SRC.indexOf('\n}', i));
  assert.match(fn, /String\(binding\.toolId\) !== wantToolId/,
    'a tab owned by another assignment must be skipped');
  assert.match(fn, /now\.gen !== binding\.gen/, 'generation must be re-verified before navigating');
});

test('WIRING: runCleanup computes the active scope and prunes bindings', () => {
  assert.match(BG_SRC, /await pruneTabBindings\(\);/);
  assert.match(BG_SRC, /const activeScope = \{ domains: new Set\(\), patterns: new Set\(\) \};/);
  assert.match(BG_SRC, /cleanupToolSession\(entry, activeScope\)/);
});

test('WIRING: launch binds the tab and never steals a sibling’s tab', () => {
  assert.match(BG_SRC, /await bindTabToTool\(targetTabId, toolId, tool && tool\.name\);/,
    'every launch must bind the tab to its exact assignment');
  const i = BG_SRC.indexOf('let reuseTab = null;');
  assert.ok(i !== -1, 'ownership-aware reuse must exist');
  const fn = BG_SRC.slice(i, i + 900);
  assert.match(fn, /String\(b\.toolId\) === toolIdStr/, 'prefer a tab already owned by this tool');
  assert.ok(!/existingTabs\[0\]\.id/.test(BG_SRC),
    'blind existingTabs[0] reuse is what let launching Pro hijack an open Plus tab');
});

test('WIRING: a blocked account still wipes everything (no activeScope passed)', () => {
  assert.match(BG_SRC, /cleanupToolSession\(toKnownEntry\(toolId, rec, 'blocked'\)\)/,
    'when the account is blocked nothing is active, so no sibling protection applies');
});

test('the fix does not weaken auth, credentials or the cookie-injection path', () => {
  const i = BG_SRC.indexOf('async function clearStorageAndRedirectTabs');
  const fn = BG_SRC.slice(i, BG_SRC.indexOf('\n}', i));
  for (const bad of ['extensionToken', 'password', 'Authorization', 'injectCookies']) {
    assert.ok(!fn.includes(bad), `the redirect helper must not touch ${bad}`);
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// 12. Expired page: query string is presentation only
// ─────────────────────────────────────────────────────────────────────────────
test('EXPIRED PAGE: authority is the background, not the tool= parameter', () => {
  assert.match(EXPIRED_SRC, /GENZ_EXPIRED_CONTEXT/, 'the page must ask the background');
  assert.match(EXPIRED_SRC, /params\.get\('toolId'\)/, 'verification keys on the exact assignment id');
  assert.match(BG_SRC, /case 'GENZ_EXPIRED_CONTEXT':/, 'the handler must exist');
  // The handler must key off the payload toolId only — never a caller-supplied label.
  const i = BG_SRC.indexOf("case 'GENZ_EXPIRED_CONTEXT':");
  const h = BG_SRC.slice(i, i + 1400);
  assert.match(h, /message\.payload && message\.payload\.toolId/);
  for (const bad of ['extensionToken', 'password', 'cookie', 'Authorization']) {
    assert.ok(!h.includes(bad), `the expired-context handler must not return ${bad}`);
  }
});

test('EXPIRED PAGE: a renewed assignment recovers instead of showing a stale expiry', () => {
  assert.match(EXPIRED_SRC, /res\.active/, 'an active assignment must be detected');
  assert.match(EXPIRED_SRC, /Access restored/, 'and surfaced to the member');
  assert.ok(!/location\.replace|location\.href\s*=/.test(EXPIRED_SRC),
    'recovery must not auto-navigate — that is how redirect loops start');
});

// ─────────────────────────────────────────────────────────────────────────────
// 13. The separate ChatGPT Work policy must be untouched
// ─────────────────────────────────────────────────────────────────────────────
test('the ChatGPT Work-removal policy is intact and independent of expiry', () => {
  const shield = fs.readFileSync(path.join(EXT, 'js', 'shield.js'), 'utf8');
  const cfg = fs.readFileSync(path.join(EXT, 'js', 'config', 'toolConfigs.js'), 'utf8');
  assert.match(shield, /function applyTabPolicy/, 'the Work policy engine must still exist');
  assert.match(cfg, /tabPolicy: \{/, 'its config must still exist');
  assert.ok(fs.existsSync(path.join(EXT, 'js', 'chatgptEarlyShield.js')),
    'the zero-flash bootstrap must still exist');
  // The two features must not have become entangled.
  assert.ok(!/tabPolicy/.test(BG_SRC), 'background.js must not learn about the Work policy');
  assert.ok(!/isWorkArea|hasWorkArea|applyTabPolicy/.test(BG_SRC),
    'work-area helpers are DOM concepts and must never appear in expiry logic');
  assert.ok(!/assignmentId|toolId|expiry|expired/i.test(
    shield.slice(shield.indexOf('// ── TAB POLICY'), shield.indexOf('function sweepMenuPolicy'))),
    'the Work policy must not learn about assignments or expiry');
});
