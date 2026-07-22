'use strict';
/**
 * Claude mobile Cloudflare-challenge fix (CORRECTED 2026-07-22 from live-log evidence).
 *
 * The gateway's egress is a datacenter IP whose ONLY valid Cloudflare cf_clearance is the vault's,
 * minted with the pinned DESKTOP UA. Live logs proved a mobile client that sends its own UA + has
 * the vault clearance stripped is challenged on ~every /api/* call and then loops forever on the
 * unsolvable /api/challenge_redirect. So by DEFAULT ('vault' mode) a mobile client now rides the
 * SAME pinned desktop upstream identity + reused vault clearance as desktop — the browser stays
 * mobile, only the upstream HTTP identity is the desktop vault's. The previous per-device behaviour
 * (real mobile UA + own clearance) is kept ONLY as the reversible CLAUDE_MOBILE_UPSTREAM=own
 * kill-switch, and is still covered at the bottom of this file against a second gateway process.
 *
 * Boots the REAL claude-gateway/server.js against a mock upstream that echoes the headers
 * (and cookies) it received, then drives a full lease → nav for desktop and several mobile
 * clients. Node built-in runner; no browser needed.
 */
const test = require('node:test');
const assert = require('node:assert');
const http = require('http');
const crypto = require('crypto');
const path = require('path');
const { spawn } = require('node:child_process');

const GW = path.resolve(__dirname, '..');
const SECRET = 'x'.repeat(48);
const b64 = (o) => Buffer.from(JSON.stringify(o)).toString('base64url');
function mintLease() {
  const h = b64({ alg: 'HS256', typ: 'JWT' });
  const p = b64({ jti: 'testjti' + crypto.randomBytes(3).toString('hex'), sub: 'u1', tool: 'claude', type: 'proxy_lease', exp: Math.floor(Date.now() / 1000) + 1800 });
  const sig = crypto.createHmac('sha256', SECRET).update(h + '.' + p).digest('base64').replace(/=/g, '').replace(/\+/g, '-').replace(/\//g, '_');
  return h + '.' + p + '.' + sig;
}

const UA_DESKTOP = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36';
const UA_ANDROID = 'Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Mobile Safari/537.36';
const UA_IPHONE = 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1';
const PINNED_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36';

let proc, upstream, backend, GW_PORT, seen = [];

test.before(async () => {
  // Mock Gen Z backend: the gateway fetches the vault account session from here (server-to-
  // server, gateway-key). Returning a bundle makes `session.cookieHeader` non-empty so the
  // CF-cookie passthrough branch actually runs (that is where per-client isolation lives).
  backend = http.createServer((q, r) => {
    let body = ''; q.on('data', c => body += c);
    q.on('end', () => {
      r.setHeader('content-type', 'application/json');
      if (q.url.endsWith('/session')) return r.end(JSON.stringify({ ok: true, account: { id: 'acc1', maskedId: 'a***1' }, bundle: { cookies: [{ name: "sessionKey", value: "VAULT_SECRET" }, { name: "cf_clearance", value: "VAULTCF" }] } }));
      if (q.url.endsWith('/validate')) return r.end(JSON.stringify({ valid: true, secondsRemaining: 1800 }));
      r.end('{}');
    });
  });
  await new Promise((res) => backend.listen(0, res));
  const bePort = backend.address().port;
  // Mock claude.ai: echoes the request headers + cookies it received as JSON. A cf_clearance
  // in the request cookie is echoed so we can assert which one reached upstream.
  upstream = http.createServer((q, r) => {
    seen.push({ ua: q.headers['user-agent'], chm: q.headers['sec-ch-ua-mobile'], chua: q.headers['sec-ch-ua'], chplat: q.headers['sec-ch-ua-platform'], model: q.headers['sec-ch-ua-model'], platver: q.headers['sec-ch-ua-platform-version'], cookie: q.headers.cookie || '' });
    r.writeHead(200, { 'content-type': 'text/html' });
    r.end('<html><head></head><body>ok</body></html>');
  });
  await new Promise((res) => upstream.listen(0, res));
  const upPort = upstream.address().port;

  GW_PORT = 18860;
  const env = Object.assign({}, process.env, {
    PORT: String(GW_PORT), TOOL_KEY: 'claude', TOOL_NAME: 'Claude AI',
    TARGET_ORIGIN: 'http://127.0.0.1:' + upPort,
    GATEWAY_PUBLIC_ORIGIN: 'http://127.0.0.1:' + GW_PORT, DEFAULT_PATH: '/new', SIGNIN_PATH: '/login',
    API_BASE: 'http://127.0.0.1:' + bePort + '/api', LEASE_SECRET: SECRET, GATEWAY_KEY: 'k'.repeat(32),
    CF_CHALLENGE_PASSTHROUGH: '1', CF_CHALLENGE_MODE: 'passthrough',
    IDENTITY_SHIELD: '0', PROXY_LOG_ALL: '0',
  });
  proc = spawn(process.execPath, ['server.js'], { cwd: GW, env, stdio: ['ignore', 'pipe', 'pipe'] });
  const started = Date.now();
  while (Date.now() - started < 15000) {
    const ok = await get('/__genz/health').then(r => r.status === 200).catch(() => false);
    if (ok) break;
    await new Promise(r => setTimeout(r, 200));
  }
});

test.after(() => { try { proc.kill(); } catch (_) {} try { upstream.close(); } catch (_) {} try { backend.close(); } catch (_) {} });

function req(method, p, headers) {
  return new Promise((resolve) => {
    const r = http.request({ port: GW_PORT, path: p, method, headers: headers || {} }, (res) => {
      const b = []; res.on('data', c => b.push(c));
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(b).toString('utf8') }));
    });
    r.on('error', () => resolve({ status: 0, headers: {}, body: '' }));
    r.end();
  });
}
const get = (p, h) => req('GET', p, h);

// Exchange a lease for the opaque __Host-claude_session cookie, then return that cookie.
async function openSession() {
  const lease = mintLease();
  const r = await get('/gateway?lease=' + encodeURIComponent(lease), { 'user-agent': UA_DESKTOP });
  const sc = [].concat(r.headers['set-cookie'] || []).find(c => /claude_session=/.test(c));
  assert.ok(sc, 'lease exchange must set an opaque session cookie');
  return sc.split(';')[0]; // name=value
}

// Drive a top-level HTML navigation as a given device; return what the upstream saw.
async function navAs(deviceHeaders) {
  const sess = await openSession();
  seen = [];
  await get('/new', Object.assign({ cookie: sess, accept: 'text/html,application/xhtml+xml' }, deviceHeaders));
  return seen[seen.length - 1];
}
// Drive an XHR/API request (NON-HTML accept → the non-minimal branch of buildUpstreamHeaders, which
// is the path that serves /api/* and was the one 75341b4 left with a desktop UA + mobile hints).
async function xhrAs(pathName, deviceHeaders) {
  const sess = await openSession();
  seen = [];
  await get(pathName, Object.assign({ cookie: sess, accept: 'application/json', 'sec-fetch-mode': 'cors', 'x-requested-with': 'XMLHttpRequest' }, deviceHeaders));
  return seen[seen.length - 1];
}

test('desktop client → upstream sees the PINNED desktop identity (unchanged)', async () => {
  const up = await navAs({ 'user-agent': UA_DESKTOP, 'sec-ch-ua': '"Chromium";v="130"', 'sec-ch-ua-mobile': '?0', 'sec-ch-ua-platform': '"Windows"' });
  assert.strictEqual(up.ua, PINNED_UA, 'desktop UA is pinned to UPSTREAM_UA');
  assert.strictEqual(up.chm, '?0', 'desktop sec-ch-ua-mobile stays ?0');
  assert.match(up.chua, /Google Chrome/, 'desktop sec-ch-ua is the pinned value');
  assert.strictEqual(up.chplat, '"Windows"', 'desktop platform pinned');
});

test('Android Chrome (default) → upstream rides the PINNED desktop identity so the vault clearance matches', async () => {
  const up = await navAs({ 'user-agent': UA_ANDROID, 'sec-ch-ua': '"Chromium";v="130", "Google Chrome";v="130"', 'sec-ch-ua-mobile': '?1', 'sec-ch-ua-platform': '"Android"' });
  assert.strictEqual(up.ua, PINNED_UA, 'mobile rides the pinned desktop UA (matches the vault cf_clearance)');
  assert.strictEqual(up.chm, '?0', 'sec-ch-ua-mobile pinned to ?0 to match the desktop-minted clearance');
  assert.strictEqual(up.chplat, '"Windows"', 'pinned desktop platform, not the phone’s');
});

test('Android UA with NO client-hints (default) → still rides the pinned desktop identity', async () => {
  const up = await navAs({ 'user-agent': UA_ANDROID });
  assert.strictEqual(up.ua, PINNED_UA);
  assert.strictEqual(up.chm, '?0');
});

test('iOS Safari (default) → rides the pinned desktop identity too', async () => {
  const up = await navAs({ 'user-agent': UA_IPHONE });
  assert.strictEqual(up.ua, PINNED_UA, 'iOS rides the pinned desktop UA (same working clearance path)');
  assert.match(up.chua, /Google Chrome/, 'pinned desktop sec-ch-ua sent');
  assert.strictEqual(up.chm, '?0');
});

// ── REGRESSION: the /api XHR (non-minimal) branch must be consistent too ──────
// 75341b4 changed upstreamIdentity (fixing the HTML-nav/minimal branch) but LEFT the non-minimal
// branch keeping the client's own MOBILE hints beside the now-desktop UA → every mobile /api/* call
// went upstream as desktop-UA + mobile-hints → Cloudflare challenged them → the challenge_redirect
// loop returned on API calls even though /new loaded. These tests pin BOTH the UA and the hints on
// the XHR path. With the bug re-introduced, the model/mobile-flag assertions fail.
test('REGRESSION: Android XHR/API (default) → desktop UA AND desktop hints, NO mobile hints leak', async () => {
  const up = await xhrAs('/api/organizations', {
    'user-agent': UA_ANDROID,
    'sec-ch-ua': '"Chromium";v="130", "Google Chrome";v="130"', 'sec-ch-ua-mobile': '?1',
    'sec-ch-ua-platform': '"Android"', 'sec-ch-ua-model': '"Pixel 8"', 'sec-ch-ua-platform-version': '"14.0.0"',
  });
  assert.strictEqual(up.ua, PINNED_UA, 'XHR mobile UA is the pinned desktop UA');
  assert.strictEqual(up.chm, '?0', 'sec-ch-ua-mobile MUST be ?0 to match the desktop UA (was ?1 = the bug)');
  assert.strictEqual(up.chplat, '"Windows"', 'platform pinned to Windows, not Android');
  assert.match(up.chua, /Google Chrome/, 'pinned desktop sec-ch-ua');
  assert.ok(up.model == null, 'the mobile high-entropy sec-ch-ua-model must NOT leak (Pixel 8 beside a Windows UA is a mismatch)');
  assert.ok(up.platver == null, 'the mobile platform-version must NOT leak either');
});

test('REGRESSION: iOS XHR/API (default) → pinned desktop identity, no Apple hints', async () => {
  const up = await xhrAs('/api/account_profile', { 'user-agent': UA_IPHONE });
  assert.strictEqual(up.ua, PINNED_UA);
  assert.strictEqual(up.chm, '?0');
  assert.strictEqual(up.chplat, '"Windows"');
});

test('desktop XHR/API is unchanged: pinned low-entropy hints, its own high-entropy hints kept', async () => {
  const up = await xhrAs('/api/organizations', {
    'user-agent': UA_DESKTOP, 'sec-ch-ua': '"Chromium";v="130"', 'sec-ch-ua-mobile': '?0',
    'sec-ch-ua-platform': '"Windows"', 'sec-ch-ua-platform-version': '"15.0.0"',
  });
  assert.strictEqual(up.ua, PINNED_UA);
  assert.strictEqual(up.chm, '?0');
  assert.strictEqual(up.chplat, '"Windows"');
  assert.strictEqual(up.platver, '"15.0.0"', 'desktop keeps its OWN (matching) high-entropy hints — purge is mobile-only');
});

test('desktop UA + desktop hints is byte-consistent across repeats (stable fingerprint)', async () => {
  const a = await navAs({ 'user-agent': UA_DESKTOP, 'sec-ch-ua-mobile': '?0' });
  const b = await navAs({ 'user-agent': UA_DESKTOP, 'sec-ch-ua-mobile': '?0' });
  assert.deepStrictEqual({ ua: a.ua, chm: a.chm, chplat: a.chplat }, { ua: b.ua, chm: b.chm, chplat: b.chplat });
});

test('COOKIE ISOLATION: one client’s cf_clearance never reaches upstream for another client', async () => {
  // Client A navigates carrying its own solved cf_clearance in its browser cookies.
  const sessA = await openSession();
  seen = [];
  await get('/new', { cookie: sessA + '; cf_clearance=AAA_clientA', 'user-agent': UA_ANDROID, accept: 'text/html' });
  const upA = seen[seen.length - 1];
  // Client B (separate lease/session) navigates with ITS own clearance.
  const sessB = await openSession();
  seen = [];
  await get('/new', { cookie: sessB + '; cf_clearance=BBB_clientB', 'user-agent': UA_ANDROID, accept: 'text/html' });
  const upB = seen[seen.length - 1];

  assert.match(upA.cookie, /cf_clearance=AAA_clientA/, 'client A’s own clearance is forwarded for A');
  assert.ok(!/BBB_clientB/.test(upA.cookie), 'client B’s clearance never leaks into A’s request');
  assert.match(upB.cookie, /cf_clearance=BBB_clientB/, 'client B’s own clearance is forwarded for B');
  assert.ok(!/AAA_clientA/.test(upB.cookie), 'client A’s clearance never leaks into B’s request');
});

test('the lease cookie itself is NEVER forwarded upstream', async () => {
  const sess = await openSession();
  seen = [];
  await get('/new', { cookie: sess + '; pg_lease=SHOULD_NOT_LEAK', 'user-agent': UA_ANDROID, accept: 'text/html' });
  const up = seen[seen.length - 1];
  assert.ok(!/SHOULD_NOT_LEAK/.test(up.cookie), 'pg_lease never reaches the upstream');
  assert.ok(!/claude_session/.test(up.cookie), 'opaque session cookie never reaches the upstream');
});

// ── Shared vault Cloudflare clearance (default 'vault' mode) ──────────────────
// The vault clearance is the ONLY one valid for this gateway's datacenter egress IP, and it is
// bound to the pinned desktop UA. Because mobile now also rides that pinned desktop UA (above),
// mobile can — and must — reuse the SAME vault clearance as desktop. That is exactly what keeps
// a mobile client OFF the unsolvable /api/challenge_redirect loop.
test('desktop KEEPS the vault cf_clearance (UA matches the minting UA)', async () => {
  const up = await navAs({ 'user-agent': UA_DESKTOP, 'sec-ch-ua-mobile': '?0' });
  assert.match(up.cookie, /cf_clearance=VAULTCF/, 'desktop still uses the vault clearance');
  assert.match(up.cookie, /sessionKey=VAULT_SECRET/, 'auth cookie present');
});

test('mobile (default) KEEPS the vault cf_clearance → rides the same working clearance as desktop', async () => {
  const up = await navAs({ 'user-agent': UA_ANDROID, 'sec-ch-ua-mobile': '?1' });
  assert.match(up.cookie, /cf_clearance=VAULTCF/, 'mobile now reuses the vault clearance (matched by the pinned desktop UA)');
  assert.match(up.cookie, /sessionKey=VAULT_SECRET/, 'auth cookie present → account stays logged in');
});

test('a device’s OWN browser cf_clearance still wins over the vault one when present', async () => {
  const sess = await openSession();
  seen = [];
  await get('/new', { cookie: sess + '; cf_clearance=MOBILE_OWN', 'user-agent': UA_ANDROID, accept: 'text/html' });
  const up = seen[seen.length - 1];
  assert.match(up.cookie, /cf_clearance=MOBILE_OWN/, 'the browser’s own clearance overrides the vault one');
  assert.ok(!/VAULTCF/.test(up.cookie), 'and it is not shadowed by the vault clearance');
});

// ── 'own' kill-switch (CLAUDE_MOBILE_UPSTREAM=own) — the reversible fallback ───
// Boots a SECOND gateway process in the old per-device mode and confirms it still behaves the old
// way (real mobile UA forwarded, vault clearance stripped). This documents the escape hatch and
// proves the default vs kill-switch really diverge.
test('own mode: mobile forwards its REAL UA and the vault clearance is stripped (old behaviour preserved)', async () => {
  const upEcho = []; let up2, be2, gw2;
  be2 = http.createServer((q, r) => {
    let body = ''; q.on('data', c => body += c);
    q.on('end', () => {
      r.setHeader('content-type', 'application/json');
      if (q.url.endsWith('/session')) return r.end(JSON.stringify({ ok: true, account: { id: 'acc1', maskedId: 'a***1' }, bundle: { cookies: [{ name: 'sessionKey', value: 'VAULT_SECRET' }, { name: 'cf_clearance', value: 'VAULTCF' }] } }));
      if (q.url.endsWith('/validate')) return r.end(JSON.stringify({ valid: true, secondsRemaining: 1800 }));
      r.end('{}');
    });
  });
  await new Promise((res) => be2.listen(0, res));
  up2 = http.createServer((q, r) => { upEcho.push({ ua: q.headers['user-agent'], cookie: q.headers.cookie || '' }); r.writeHead(200, { 'content-type': 'text/html' }); r.end('<html></html>'); });
  await new Promise((res) => up2.listen(0, res));
  const PORT2 = 18861;
  const env = Object.assign({}, process.env, {
    PORT: String(PORT2), TOOL_KEY: 'claude', TOOL_NAME: 'Claude AI',
    TARGET_ORIGIN: 'http://127.0.0.1:' + up2.address().port,
    GATEWAY_PUBLIC_ORIGIN: 'http://127.0.0.1:' + PORT2, DEFAULT_PATH: '/new', SIGNIN_PATH: '/login',
    API_BASE: 'http://127.0.0.1:' + be2.address().port + '/api', LEASE_SECRET: SECRET, GATEWAY_KEY: 'k'.repeat(32),
    CF_CHALLENGE_PASSTHROUGH: '1', CF_CHALLENGE_MODE: 'passthrough', IDENTITY_SHIELD: '0', PROXY_LOG_ALL: '0',
    CLAUDE_MOBILE_UPSTREAM: 'own',
  });
  gw2 = spawn(process.execPath, ['server.js'], { cwd: GW, env, stdio: ['ignore', 'pipe', 'pipe'] });
  try {
    const started = Date.now();
    const g = (p, h) => new Promise((resolve) => { const r = http.request({ port: PORT2, path: p, method: 'GET', headers: h || {} }, (res) => { const b = []; res.on('data', c => b.push(c)); res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(b).toString('utf8') })); }); r.on('error', () => resolve({ status: 0, headers: {}, body: '' })); r.end(); });
    while (Date.now() - started < 15000) { if ((await g('/__genz/health')).status === 200) break; await new Promise(r => setTimeout(r, 200)); }
    const lease = mintLease();
    const so = await g('/gateway?lease=' + encodeURIComponent(lease), { 'user-agent': UA_DESKTOP });
    const sess = [].concat(so.headers['set-cookie'] || []).find(c => /claude_session=/.test(c)).split(';')[0];
    upEcho.length = 0;
    await g('/new', { cookie: sess, 'user-agent': UA_ANDROID, accept: 'text/html' });
    const up = upEcho[upEcho.length - 1];
    assert.strictEqual(up.ua, UA_ANDROID, 'own mode forwards the real mobile UA');
    assert.ok(!/cf_clearance=VAULTCF/.test(up.cookie), 'own mode strips the vault clearance');
    // own mode must be consistent on the XHR/API (non-minimal) branch too: real mobile UA there as well.
    upEcho.length = 0;
    await g('/api/organizations', { cookie: sess, 'user-agent': UA_ANDROID, accept: 'application/json', 'sec-ch-ua-mobile': '?1' });
    assert.strictEqual(upEcho[upEcho.length - 1].ua, UA_ANDROID, 'own mode XHR forwards the real mobile UA too');
  } finally { try { gw2.kill(); } catch (_) {} try { up2.close(); } catch (_) {} try { be2.close(); } catch (_) {} }
});
