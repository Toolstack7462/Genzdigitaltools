'use strict';
/**
 * WriteHuman client launch must not escape the managed origin to the public provider site.
 *
 * THE DEFECT THIS PINS (2026-10-06). WriteHuman's page ships an anti-mirror "canonical host" guard
 * as the first inline <script> in <head>, plus an RSC-serialized copy of the same code:
 *
 *   (function(){var d=['write','human'].join('')+'.ai',h=location.hostname...;
 *     if(h===d||h==='www.'+d||...)return; var o='https://'+d; ...
 *     location.replace(o+location.pathname+location.search);})()
 *
 * The hostname is assembled at RUNTIME, so (a) the gateway's literal URL rewriting
 * (https://writehuman.ai → https://writehuman1…) never sees it, and (b) the old HOST_GUARD_RE —
 * which only matched `location.replace('https://writehuman.ai'+location.pathname+location.search)`
 * — does not match. Result: the client's launch lands on writehuman1.genzdigitalstore.com, the
 * script runs, and the browser is replaced onto https://writehuman.ai/… — the PUBLIC site, with no
 * session cookies (those are scoped to the gateway host), i.e. the landing page with
 * "Log in / Sign Up". That is exactly the screenshot the owner reported.
 *
 * These tests drive the REAL proxy-gateway/server.js as a child process, with a fake upstream that
 * serves the guard byte-for-byte as WriteHuman ships it and a fake backend that authorises the
 * lease. The served HTML is then EXECUTED against a fake `location` on the gateway host, which is
 * the only honest check: "the regex matched" is not the same as "the browser stayed".
 *
 * Run: node --test tests/writehumanHostGuardEscape.test.js
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('http');
const path = require('path');
const crypto = require('crypto');
const vm = require('vm');
const { spawn } = require('child_process');

const GATEWAY = path.join(__dirname, '..', '..', 'proxy-gateway', 'server.js');
const LEASE_SECRET = 's'.repeat(48);
const GW_HOST = 'writehuman1.genzdigitalstore.com';

// Verbatim from https://writehuman.ai/ (fetched 2026-10-06), both forms it appears in.
const GUARD_JS = "(function(){var d=['write','human'].join('')+'.ai',h=location.hostname.replace(/\\.$/,'');var v=[\"ppa.lecrev.namuh-etirw-r6c6bgqde-2namuhetirw\",\"ppa.lecrev.namuh-etirw-niam-tig-2namuhetirw\"].map(function(s){return s.split('').reverse().join('')});if(h===d||h==='www.'+d||h==='mcp.'+d||v.indexOf(h)>=0||h==='localhost'||h==='127.0.0.1'||h==='[::1]'||/\\.(localhost|test)$/.test(h)||h.indexOf('192.168.')===0)return;var o='https://'+d;try{var c=document.querySelector('link[rel=\"canonical\"]');if(c)c.setAttribute('href',o+new URL(c.getAttribute('href')||'/',location.href).pathname);var m=document.createElement('meta');m.name='robots';m.content='noindex, nofollow';document.head.appendChild(m);}catch(e){}location.replace(o+location.pathname+location.search);})()";
// The RSC flight copy: the same source JSON-encoded inside a self.__next_f.push string.
const GUARD_RSC = JSON.stringify(JSON.stringify(['$', 'script', null, { dangerouslySetInnerHTML: { __html: GUARD_JS } }]));

// The older literal form the gateway was originally written for — must keep being defused. Its
// host is the gateway's own TARGET_ORIGIN host (writehuman.ai in production; the fake upstream here).
const LEGACY_GUARD_JS = (origin) => "if(location.hostname!=='x')location.replace('" + origin + "'+location.pathname+location.search)";

// A legitimate same-origin navigation the app might perform — must NOT be touched.
const BENIGN_JS = "var p='/en';if(location.pathname==='/')location.replace(p+location.pathname+location.search)";

function page(headScripts) {
  return '<!DOCTYPE html><html lang="en"><head><meta charSet="utf-8"/>'
    + '<link rel="canonical" href="https://writehuman.ai/"/>'
    + headScripts.map(s => '<script>' + s + '</script>').join('')
    + '</head><body><a href="https://writehuman.ai/login">Log in</a>'
    + '<script>self.__next_f.push([1,' + GUARD_RSC + '])</script></body></html>';
}

function b64url(b) { return Buffer.from(b).toString('base64').replace(/=/g, '').replace(/\+/g, '-').replace(/\//g, '_'); }
function signLease(tool) {
  const h = b64url(JSON.stringify({ alg: 'HS256', typ: 'JWT' }));
  const p = b64url(JSON.stringify({ type: 'proxy_lease', tool, jti: 'lease-test-1', sub: 'u1', exp: Math.floor(Date.now() / 1000) + 600 }));
  const sig = crypto.createHmac('sha256', LEASE_SECRET).update(`${h}.${p}`).digest('base64').replace(/=/g, '').replace(/\+/g, '-').replace(/\//g, '_');
  return `${h}.${p}.${sig}`;
}

function listen(handler) {
  return new Promise(resolve => { const s = http.createServer(handler); s.listen(0, '127.0.0.1', () => resolve(s)); });
}
function get(port, pathName, headers) {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, path: pathName, method: 'GET', headers }, res => {
      const chunks = []; res.on('data', c => chunks.push(c));
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks).toString('utf8') }));
    });
    req.on('error', reject); req.end();
  });
}

async function bootGateway({ tool, html, upstreamStatus = 200 }) {
  let upstreamOrigin = '';
  const upstream = await listen((req, res) => {
    res.writeHead(upstreamStatus, { 'content-type': 'text/html; charset=utf-8' });
    res.end(typeof html === 'function' ? html(upstreamOrigin) : html);
  });
  upstreamOrigin = `http://127.0.0.1:${upstream.address().port}`;
  // Fake backend: authorise every lease; no account bundle (the transform is what is under test).
  const backend = await listen((req, res) => {
    res.writeHead(200, { 'content-type': 'application/json' });
    if (req.url.includes('/validate')) return res.end(JSON.stringify({ valid: true }));
    return res.end(JSON.stringify({ ok: true, account: null }));
  });
  const port = 20000 + Math.floor(Math.random() * 20000);
  const child = spawn(process.execPath, [GATEWAY], {
    env: {
      PATH: process.env.PATH,
      PORT: String(port),
      TARGET_ORIGIN: upstreamOrigin,
      API_BASE: `http://127.0.0.1:${backend.address().port}/api/crm/proxy/gateway`,
      GATEWAY_PUBLIC_ORIGIN: `https://${GW_HOST}`,
      LEASE_SECRET, GATEWAY_KEY: 'k'.repeat(32), TOOL_KEY: tool, TOOL_NAME: tool,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let out = '';
  child.stdout.on('data', d => { out += d; }); child.stderr.on('data', d => { out += d; });
  for (let i = 0; i < 100 && !/listening/.test(out); i++) await new Promise(r => setTimeout(r, 50));
  assert.match(out, /listening/, 'gateway did not start: ' + out);
  return {
    port,
    fetchPage: () => get(port, '/', { accept: 'text/html', host: GW_HOST, cookie: 'pg_lease=' + signLease(tool) }),
    close: () => { child.kill(); upstream.close(); backend.close(); },
  };
}

/** Run every inline <script> of the served page as a browser on the gateway host would. */
function runInBrowser(html, hostname) {
  const navigations = [];
  const location = {
    hostname, host: hostname, pathname: '/', search: '', origin: `https://${hostname}`,
    get href() { return `https://${hostname}/`; }, set href(u) { navigations.push(String(u)); },
    replace(u) { navigations.push(String(u)); }, assign(u) { navigations.push(String(u)); },
  };
  const el = { setAttribute() {}, getAttribute() { return '/'; } };
  const document = { querySelector: () => el, createElement: () => ({}), head: { appendChild() {} }, cookie: '' };
  const sandbox = { location, document, URL, self: { __next_f: { push() {} } }, window: {}, localStorage: { getItem() { return null; }, setItem() {}, removeItem() {}, clear() {} }, sessionStorage: { getItem() { return null; }, setItem() {}, removeItem() {} }, console: { log() {}, warn() {} }, history: {} };
  sandbox.window = sandbox;
  vm.createContext(sandbox);
  const scripts = [...html.matchAll(/<script(?:\s[^>]*)?>([\s\S]*?)<\/script>/gi)].map(m => m[1]).filter(Boolean);
  for (const s of scripts) { try { vm.runInContext(s, sandbox, { timeout: 500 }); } catch (_) { /* other injected scripts may need a real DOM */ } }
  return navigations;
}

test('WriteHuman: the obfuscated canonical-host guard no longer sends the client to writehuman.ai', async () => {
  const gw = await bootGateway({ tool: 'writehuman', html: page([GUARD_JS]) });
  try {
    const r = await gw.fetchPage();
    assert.equal(r.status, 200, 'gateway must serve the page');
    const navs = runInBrowser(r.body, GW_HOST);
    assert.deepEqual(navs.filter(u => /writehuman\.ai/.test(u)), [],
      'page served on the managed origin must not navigate to the public provider: ' + JSON.stringify(navs));
    // Both copies are defused (the RSC copy is what React would re-render on hydration).
    assert.ok(!r.body.includes('location.replace(o+location.pathname+location.search)'), 'an executable copy of the guard redirect survived');
    // Narrow edit: the rest of the guard (hostname checks, canonical/noindex code) is left intact.
    assert.ok(r.body.includes("['write','human'].join('')"), 'the guard was rewritten more broadly than the redirect call');
  } finally { gw.close(); }
});

test('WriteHuman: the legacy literal guard is still defused', async () => {
  const gw = await bootGateway({ tool: 'writehuman', html: (o) => page([LEGACY_GUARD_JS(o)]).replace(GUARD_RSC, '""') });
  try {
    const r = await gw.fetchPage();
    const navs = runInBrowser(r.body, GW_HOST);
    assert.deepEqual(navs, [], 'legacy guard redirected: ' + JSON.stringify(navs));
  } finally { gw.close(); }
});

test('WriteHuman: a legitimate same-origin location.replace is left untouched', async () => {
  const gw = await bootGateway({ tool: 'writehuman', html: page([BENIGN_JS]).replace(GUARD_RSC, '""') });
  try {
    const r = await gw.fetchPage();
    assert.ok(r.body.includes(BENIGN_JS), 'benign same-origin navigation code was modified');
    assert.deepEqual(runInBrowser(r.body, GW_HOST), ['/en/'], 'benign navigation must still run');
  } finally { gw.close(); }
});

test('Other tools keep the exact previous behaviour (the new defusal is WriteHuman-scoped)', async () => {
  // Same page through a ryne-configured gateway: byte-identical guard output to before this change.
  const gw = await bootGateway({ tool: 'ryne', html: page([GUARD_JS]) });
  try {
    const r = await gw.fetchPage();
    assert.ok(r.body.includes('location.replace(o+location.pathname+location.search)'),
      'a non-WriteHuman gateway changed behaviour — shared change needs separate approval');
  } finally { gw.close(); }
});

// ── Gateway route self-check (/__genz/health → route) ─────────────────────────
// The admin dashboard's "client route" signal is read from here. It must report the escape when
// one is being served, and must never say "contained" on a check that did not run.
function health(gw) { return get(gw.port, '/__genz/health', { host: GW_HOST }).then(r => JSON.parse(r.body)); }

test('route self-check: contained when the served page keeps the client on the gateway', async () => {
  const gw = await bootGateway({ tool: 'writehuman', html: page([GUARD_JS]) });
  try {
    const h = await health(gw);
    assert.equal(h.route.result, 'contained');
    assert.equal(h.route.scope, 'public_page_static');
    assert.ok(!Number.isNaN(Date.parse(h.route.checkedAt)));
  } finally { gw.close(); }
});

test('route self-check (failure injection): a new guard variant the defuser misses is reported as an escape', async () => {
  const variant = GUARD_JS.replace('location.replace(o+location.pathname+location.search)', 'location.href=o+location.pathname');
  const gw = await bootGateway({ tool: 'writehuman', html: page([variant]).replace(GUARD_RSC, '""') });
  try {
    const h = await health(gw);
    assert.equal(h.route.result, 'escape', JSON.stringify(h.route));
    // …and it genuinely does escape, so "escape" is the truthful verdict.
    assert.deepEqual(runInBrowser((await gw.fetchPage()).body, GW_HOST), ['https://writehuman.ai/']);
  } finally { gw.close(); }
});

test('route self-check: an unreachable/failed upstream is inconclusive, never contained', async () => {
  const gw = await bootGateway({ tool: 'writehuman', html: page([GUARD_JS]), upstreamStatus: 502 });
  try {
    const h = await health(gw);
    assert.equal(h.route.result, 'inconclusive');
    assert.equal(h.route.reason, 'upstream_http_502');
  } finally { gw.close(); }
});

test('route self-check is WriteHuman-only: other gateways keep their health JSON unchanged', async () => {
  const gw = await bootGateway({ tool: 'ryne', html: page([GUARD_JS]) });
  try { assert.equal((await health(gw)).route, undefined); } finally { gw.close(); }
});
