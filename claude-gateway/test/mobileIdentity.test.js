'use strict';
/**
 * Claude mobile Cloudflare-challenge fix — the gateway must present a DEVICE-CONSISTENT
 * identity upstream so Cloudflare's in-browser challenge fingerprint matches the HTTP
 * headers (desktop pinned unchanged; mobile forwards its own honest UA + client-hints).
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
    seen.push({ ua: q.headers['user-agent'], chm: q.headers['sec-ch-ua-mobile'], chua: q.headers['sec-ch-ua'], chplat: q.headers['sec-ch-ua-platform'], cookie: q.headers.cookie || '' });
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

test('desktop client → upstream sees the PINNED desktop identity (unchanged)', async () => {
  const up = await navAs({ 'user-agent': UA_DESKTOP, 'sec-ch-ua': '"Chromium";v="130"', 'sec-ch-ua-mobile': '?0', 'sec-ch-ua-platform': '"Windows"' });
  assert.strictEqual(up.ua, PINNED_UA, 'desktop UA is pinned to UPSTREAM_UA');
  assert.strictEqual(up.chm, '?0', 'desktop sec-ch-ua-mobile stays ?0');
  assert.match(up.chua, /Google Chrome/, 'desktop sec-ch-ua is the pinned value');
  assert.strictEqual(up.chplat, '"Windows"', 'desktop platform pinned');
});

test('Android Chrome → upstream sees the REAL mobile identity, not desktop', async () => {
  const up = await navAs({ 'user-agent': UA_ANDROID, 'sec-ch-ua': '"Chromium";v="130", "Google Chrome";v="130"', 'sec-ch-ua-mobile': '?1', 'sec-ch-ua-platform': '"Android"' });
  assert.strictEqual(up.ua, UA_ANDROID, 'mobile UA is forwarded verbatim');
  assert.strictEqual(up.chm, '?1', 'sec-ch-ua-mobile forwarded as ?1');
  assert.strictEqual(up.chplat, '"Android"', 'real Android platform forwarded');
  assert.notStrictEqual(up.ua, PINNED_UA, 'mobile is NOT rewritten to the desktop UA');
});

test('Android UA with NO client-hints → detected mobile, real UA, mobile flag synthesised', async () => {
  const up = await navAs({ 'user-agent': UA_ANDROID });
  assert.strictEqual(up.ua, UA_ANDROID);
  // No hints were sent, so we do not invent a full sec-ch-ua; UA regex still classes it mobile.
  assert.notStrictEqual(up.ua, PINNED_UA);
});

test('iOS Safari → real Safari UA forwarded, and NO fake sec-ch-ua invented', async () => {
  const up = await navAs({ 'user-agent': UA_IPHONE });
  assert.strictEqual(up.ua, UA_IPHONE, 'Safari UA forwarded verbatim');
  assert.ok(up.chua == null || up.chua === undefined, 'no sec-ch-ua invented for Safari (bot tell)');
  assert.ok(up.chm == null || up.chm === undefined, 'no sec-ch-ua-mobile invented for Safari');
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

// ── Per-device Cloudflare clearance ──────────────────────────────────────────
// cf_clearance is bound to the UA (and egress IP) that minted it. The vault's clearance
// is minted with the pinned DESKTOP UA, so sending it alongside a real mobile UA is a
// guaranteed Cloudflare rejection → endless challenge. Clearance must be per-device.
test('desktop KEEPS the vault cf_clearance (UA matches the minting UA)', async () => {
  const up = await navAs({ 'user-agent': UA_DESKTOP, 'sec-ch-ua-mobile': '?0' });
  assert.match(up.cookie, /cf_clearance=VAULTCF/, 'desktop still uses the vault clearance');
  assert.match(up.cookie, /sessionKey=VAULT_SECRET/, 'auth cookie present');
});

test('mobile does NOT receive the desktop-minted vault cf_clearance (UA mismatch)', async () => {
  const up = await navAs({ 'user-agent': UA_ANDROID, 'sec-ch-ua-mobile': '?1' });
  assert.ok(!/cf_clearance=VAULTCF/.test(up.cookie), 'vault (desktop-UA) clearance must NOT be sent with a mobile UA');
  assert.match(up.cookie, /sessionKey=VAULT_SECRET/, 'auth cookie STILL sent → account stays logged in');
});

test('mobile USES ITS OWN solved clearance when it has one', async () => {
  const sess = await openSession();
  seen = [];
  await get('/new', { cookie: sess + '; cf_clearance=MOBILE_OWN', 'user-agent': UA_ANDROID, accept: 'text/html' });
  const up = seen[seen.length - 1];
  assert.match(up.cookie, /cf_clearance=MOBILE_OWN/, 'the device’s own clearance is forwarded');
  assert.ok(!/VAULTCF/.test(up.cookie), 'and it is not shadowed by the vault clearance');
});
