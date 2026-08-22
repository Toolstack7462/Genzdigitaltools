/**
 * TOOL-EXPIRY SCOPE — which tools may expire, and for which reason.
 *
 * There are exactly TWO ways a tool tab can be sent to expired.html, and they must never blur:
 *
 *   1. IDLE / SESSION expiry (reason=idle_timeout) — the 20-minute inactivity rule. It is a HOST
 *      concept driven by checkIdleSessions() -> expireIdleHost(), and it applies to GPT Bypass and
 *      HIX AI ONLY. The subscription is still valid; the member simply relaunches.
 *
 *   2. ASSIGNMENT expiry / revoke (reason=expired|revoked|removed|blocked) — backend-confirmed,
 *      per exact toolId, driven by the cleanup manifest.
 *
 * ChatGPT (Plus, Pro, any other assignment) and Claude must NEVER take path 1. They may only ever
 * take path 2, for their OWN exact assignment. This file locks that, because the scope is a
 * one-line change away from silently widening.
 */
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const EXT = path.join(__dirname, '..');
const TOOLCFG = fs.readFileSync(path.join(EXT, 'js', 'config', 'toolConfigs.js'), 'utf8');
const BG = fs.readFileSync(path.join(EXT, 'js', 'background.js'), 'utf8');

// ─────────────────────────────────────────────────────────────────────────────
// 1. The 20-minute rule: exact membership
// ─────────────────────────────────────────────────────────────────────────────
const IDLE_MIN = TOOLCFG.match(/export const IDLE_TIMEOUT_MINUTES\s*=\s*(\d+)/);
const IDLE_HOSTS = (() => {
  const m = TOOLCFG.match(/export const IDLE_TIMEOUT_HOSTS\s*=\s*\[([^\]]*)\]/);
  assert.ok(m, 'IDLE_TIMEOUT_HOSTS must exist');
  return m[1].split(',').map(s => s.trim().replace(/^['"]|['"]$/g, '')).filter(Boolean);
})();
// Mirrors idleHostMatch(): exact host or a subdomain of one.
const idleApplies = (h) => IDLE_HOSTS.some(k => h === k || h.endsWith('.' + k));

test('the 20-minute window is 20 minutes and the host list is EXACTLY GPT Bypass + HIX AI', () => {
  assert.ok(IDLE_MIN, 'IDLE_TIMEOUT_MINUTES must exist');
  assert.strictEqual(IDLE_MIN[1], '20');
  assert.deepStrictEqual(IDLE_HOSTS.slice().sort(), ['bypassgpt.ai', 'hix.ai'],
    'only GPT Bypass and HIX AI may carry the 20-minute rule');
});

test('GPT Bypass and HIX AI DO take the 20-minute rule (including subdomains)', () => {
  for (const h of ['hix.ai', 'www.hix.ai', 'app.hix.ai', 'bypassgpt.ai', 'www.bypassgpt.ai']) {
    assert.strictEqual(idleApplies(h), true, `${h} must keep its 20-minute expiry`);
  }
});

test('ChatGPT (Plus, Pro, any assignment) never takes the 20-minute rule', () => {
  for (const h of ['chatgpt.com', 'www.chatgpt.com', 'chat.openai.com', 'openai.com']) {
    assert.strictEqual(idleApplies(h), false, `${h} must have NO inactivity expiry`);
  }
});

test('Claude never takes the 20-minute rule', () => {
  for (const h of ['claude.ai', 'www.claude.ai']) {
    assert.strictEqual(idleApplies(h), false, `${h} must have NO inactivity expiry`);
  }
});

test('every other supported tool is likewise exempt', () => {
  for (const h of ['grok.com', 'ryne.ai', 'writehuman.ai', 'scispace.com', 'typeset.io',
                   'stealthwriter.ai', 'anything-added-later.com']) {
    assert.strictEqual(idleApplies(h), false, `${h} must have NO inactivity expiry`);
  }
});

test('the ChatGPT/Claude hostnames appear NOWHERE in the idle policy', () => {
  const i = TOOLCFG.indexOf('export const IDLE_TIMEOUT_MINUTES');
  const block = TOOLCFG.slice(i, i + 900);
  for (const h of ['chatgpt', 'claude', 'openai', 'grok', 'ryne', 'writehuman', 'scispace']) {
    assert.ok(!new RegExp("'[^']*" + h).test(block),
      `${h} must not be listed in the idle policy block`);
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// 2. The idle machinery cannot reach a tool outside the list
// ─────────────────────────────────────────────────────────────────────────────
test('the idle watchdog iterates ONLY the idle host list', () => {
  const i = BG.indexOf('async function checkIdleSessions');
  const fn = BG.slice(i, BG.indexOf('\n}', i));
  assert.match(fn, /for \(const host of IDLE_TIMEOUT_HOSTS\)/,
    'the tick must iterate the explicit list, never all tools or all tabs');
  assert.ok(!/domainToolMap|tools\b|activeIds/.test(fn),
    'it must not consult the tool list — that is how a scope widens by accident');
});

test('the idle watchdog is only armed for a matching host', () => {
  assert.match(BG, /if \(idleHostMatch\(hostname\)\) \{[\s\S]{0,120}startIdleWatch/,
    'startIdleWatch must be gated on idleHostMatch');
});

test('idle expiry is HOST-scoped and carries no assignment identity', () => {
  const i = BG.indexOf('async function expireIdleHost');
  const fn = BG.slice(i, BG.indexOf('\n}', i));
  assert.match(fn, /'idle_timeout'/, 'it must use the session-expired reason');
  assert.ok(!/toolId/.test(fn),
    'idle is a host concept: passing a toolId would make it an ASSIGNMENT expiry');
  // And the reason must stay on the session allowlist, so the page never says "renew your plan".
  const expired = fs.readFileSync(path.join(EXT, 'js', 'expired.js'), 'utf8');
  assert.match(expired, /SESSION_REASONS = \[[^\]]*'idle_timeout'/,
    'idle_timeout must render as SESSION expired, never as a subscription expiry');
});

// ─────────────────────────────────────────────────────────────────────────────
// 3. ChatGPT / Claude expire ONLY via exact-assignment revoke or real expiry
// ─────────────────────────────────────────────────────────────────────────────
// Executed, not asserted on text: the real cleanup helpers are lifted and run.
function lift(names) {
  let out = '';
  for (const name of names) {
    const i = BG.indexOf(`async function ${name}(`);
    assert.ok(i !== -1, `${name}() not found`);
    let d = 0, started = false, end = i;
    for (let k = BG.indexOf('{', i); k < BG.length; k++) {
      if (BG[k] === '{') { d++; started = true; }
      else if (BG[k] === '}') { d--; if (started && d === 0) { end = k + 1; break; } }
    }
    out += BG.slice(i, end) + '\n';
  }
  return out;
}
function patternMatches(pattern, url) {
  return new RegExp('^' + String(pattern)
    .replace(/[.+?^${}()|[\]\\]/g, '\\$&')
    .replace(/^\\\*:\/\//, 'https?://').replace(/\*/g, '.*') + '$').test(url);
}
function env(tabs, storage) {
  const store = Object.assign({}, storage || {});
  const t = (tabs || []).map(x => Object.assign({}, x));
  const log = { redirects: [] };
  const chrome = {
    runtime: { getURL: p => 'chrome-extension://x/' + (p || '') },
    storage: { local: {
      get: async (k) => { const o = {}; for (const key of [].concat(k)) if (key in store) o[key] = store[key]; return o; },
      set: async (o) => { Object.assign(store, o); },
      remove: async (k) => { for (const key of [].concat(k)) delete store[key]; } } },
    tabs: {
      query: async (q) => !q || !q.url ? t.slice()
        : t.filter(x => [].concat(q.url).some(p => patternMatches(p, x.url))),
      update: async (id, props) => { const x = t.find(y => y.id === id);
        if (props.url) { x.url = props.url; log.redirects.push({ id, url: props.url }); } return x; },
    },
    cookies: { getAll: async () => [], remove: async () => ({}) },
    scripting: { executeScript: async () => [{ result: 0 }] },
    notifications: { create: () => {} },
  };
  const ctx = vm.createContext({ chrome, logger: { debug(){}, warn(){}, error(){}, info(){} },
    console, Date, Set, Map, URL, JSON });
  ctx.globalThis = ctx;
  vm.runInContext(`
    const TAB_BINDINGS_KEY='genzTabBindings'; const LAUNCH_GEN_KEY='genzLaunchGeneration';
    const PROTECTED_HOST_RE=/(^|\\.)genzdigitalstore\\.com$/i;
    function isProtectedHost(h){return !!h && PROTECTED_HOST_RE.test(String(h));}
    async function getStorage(k){return chrome.storage.local.get(k);}
    async function setStorage(o){return chrome.storage.local.set(o);}
    async function removeStorage(k){return chrome.storage.local.remove(k);}
    async function getAppOrigin(){return 'https://app.genzdigitalstore.com';}
    function sessionCacheKey(id){return 's:'+id;}
    const domainToolMap=new Map();
    const IDLE_TIMEOUT_MINUTES=${IDLE_MIN[1]};
  ` + lift(['clearCookiesForConfig', 'clearStorageAndRedirectTabs', 'cleanupToolSession',
            'getTabBindings', 'getTabBinding', 'expireIdleHost']), ctx);
  const call = (fn, ...args) => vm.runInContext(`(${fn})(...globalThis.__A__)`,
    Object.assign(ctx, { __A__: args }));
  return { call, log, tabs: t, store };
}

test('EXECUTED: a HIX idle expiry never touches a ChatGPT or Claude tab', async () => {
  const e = env([
    { id: 1, url: 'https://hix.ai/app' },
    { id: 2, url: 'https://chatgpt.com/c/abc' },
    { id: 3, url: 'https://claude.ai/chat/abc' },
  ], { genzTabBindings: {} });
  await e.call('expireIdleHost', 'hix.ai');
  assert.deepStrictEqual(e.log.redirects.map(r => r.id), [1],
    'only the HIX tab may be ended by the 20-minute rule');
  assert.strictEqual(e.tabs[1].url, 'https://chatgpt.com/c/abc', 'ChatGPT untouched');
  assert.strictEqual(e.tabs[2].url, 'https://claude.ai/chat/abc', 'Claude untouched');
});

test('EXECUTED: a BypassGPT idle expiry never touches ChatGPT or Claude', async () => {
  const e = env([
    { id: 1, url: 'https://bypassgpt.ai/' },
    { id: 2, url: 'https://chatgpt.com/' },
    { id: 3, url: 'https://claude.ai/' },
  ], { genzTabBindings: {} });
  await e.call('expireIdleHost', 'bypassgpt.ai');
  assert.deepStrictEqual(e.log.redirects.map(r => r.id), [1]);
});

test('EXECUTED: ChatGPT expires only for its OWN exact assignment (revoke / real expiry)', async () => {
  const PLUS = { toolId: '651plus', cleanup: { name: 'ChatGPT Plus', domains: ['chatgpt.com'],
    cookieDomains: ['chatgpt.com'], tabUrlPatterns: ['*://chatgpt.com/*'] } };
  const PRO = { toolId: '772pro', cleanup: { name: 'Chat Gpt Pro', domains: ['chatgpt.com'],
    cookieDomains: ['chatgpt.com'], tabUrlPatterns: ['*://chatgpt.com/*'] } };
  const e = env([
    { id: 1, url: 'https://chatgpt.com/plus' },
    { id: 2, url: 'https://chatgpt.com/pro' },
  ], { genzTabBindings: {
    1: { toolId: '651plus', toolName: 'ChatGPT Plus', gen: 1 },
    2: { toolId: '772pro', toolName: 'Chat Gpt Pro', gen: 1 } } });

  const activeScope = { domains: new Set(['chatgpt.com']), patterns: new Set(['*://chatgpt.com/*']) };
  await e.call('cleanupToolSession', Object.assign({ reason: 'revoked' }, PRO), activeScope);

  assert.deepStrictEqual(e.log.redirects.map(r => r.id), [2],
    'a revoke of Pro must end Pro only');
  const u = new URL(e.log.redirects[0].url);
  assert.strictEqual(u.searchParams.get('reason'), 'revoked', 'a genuine revoke, not idle_timeout');
  assert.strictEqual(u.searchParams.get('toolId'), '772pro', 'keyed on the exact assignment');
  void PLUS;
});

test('EXECUTED: Claude expires only through its own assignment, never a 20-minute timer', async () => {
  const CLAUDE = { toolId: '900c', cleanup: { name: 'Claude', domains: ['claude.ai'],
    cookieDomains: ['claude.ai'], tabUrlPatterns: ['*://claude.ai/*'] } };
  const e = env([
    { id: 1, url: 'https://claude.ai/chat/a' },
    { id: 2, url: 'https://chatgpt.com/c/b' },
  ], { genzTabBindings: { 1: { toolId: '900c', toolName: 'Claude', gen: 1 } } });
  await e.call('cleanupToolSession', Object.assign({ reason: 'expired' }, CLAUDE),
    { domains: new Set(), patterns: new Set() });
  assert.deepStrictEqual(e.log.redirects.map(r => r.id), [1], 'only the Claude tab');
  const u = new URL(e.log.redirects[0].url);
  assert.strictEqual(u.searchParams.get('reason'), 'expired');
  assert.strictEqual(u.searchParams.get('tool'), 'Claude', 'labelled Claude, never another tool');
});

// ─────────────────────────────────────────────────────────────────────────────
// 4. The two paths must stay distinguishable
// ─────────────────────────────────────────────────────────────────────────────
test('an idle expiry and an assignment expiry produce DIFFERENT reasons', async () => {
  const e = env([{ id: 1, url: 'https://hix.ai/app' }], { genzTabBindings: {} });
  await e.call('expireIdleHost', 'hix.ai');
  assert.strictEqual(new URL(e.log.redirects[0].url).searchParams.get('reason'), 'idle_timeout',
    'the 20-minute rule must never masquerade as a subscription expiry');
});

test('the ChatGPT Work policy plays no part in any expiry decision', () => {
  assert.ok(!/tabPolicy|applyTabPolicy|isWorkArea|hasWorkArea/.test(BG),
    'DOM/Work concepts must never appear in background.js expiry logic');
  const shield = fs.readFileSync(path.join(EXT, 'js', 'shield.js'), 'utf8');
  const tabEngine = shield.slice(shield.indexOf('// ── TAB POLICY'),
    shield.indexOf('function sweepMenuPolicy'));
  assert.ok(!/assignment|expiry|expired|revoke/i.test(tabEngine),
    'the Work policy must never learn about assignments or expiry');
});
