'use strict';
/**
 * Claude gateway startup-reload fix — the opaque session must survive Passenger process
 * recycling and multi-worker routing (it used to live only in one process's memory, so a
 * recycle/other-worker turned it into a `lease_missing` block page → reload into the
 * verification error). Also covers: parallel validate+session, validate dedup/cache,
 * fail-open on a transient backend blip, prompt revocation, and per-client isolation.
 *
 * Two gateway processes are booted sharing the SAME tmp/sessions dir + LEASE_SECRET — that
 * is exactly a second Passenger worker / a recycled process. Node built-in runner.
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
function mintLease(extra) {
  const h = b64({ alg: 'HS256', typ: 'JWT' });
  const p = b64(Object.assign({ jti: 'j' + crypto.randomBytes(4).toString('hex'), sub: 'u1', tool: 'claude', type: 'proxy_lease', exp: Math.floor(Date.now() / 1000) + 1800 }, extra || {}));
  const sig = crypto.createHmac('sha256', SECRET).update(h + '.' + p).digest('base64').replace(/=/g, '').replace(/\+/g, '-').replace(/\//g, '_');
  return h + '.' + p + '.' + sig;
}

let upstream, backend, gwA, gwB, PORT_A, PORT_B;
let validateCalls = 0, sessionCalls = 0, backendDelay = 0, validateResp = null;

function reqTo(port, method, p, headers) {
  return new Promise((resolve) => {
    const r = http.request({ port, path: p, method, headers: headers || {} }, (res) => {
      const b = []; res.on('data', c => b.push(c));
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(b).toString('utf8') }));
    });
    r.on('error', () => resolve({ status: 0, headers: {}, body: '' }));
    r.end();
  });
}

function bootGateway(port) {
  const env = Object.assign({}, process.env, {
    PORT: String(port), TOOL_KEY: 'claude', TOOL_NAME: 'Claude AI',
    TARGET_ORIGIN: 'http://127.0.0.1:' + upstream.address().port,
    GATEWAY_PUBLIC_ORIGIN: 'http://127.0.0.1:' + port, DEFAULT_PATH: '/new', SIGNIN_PATH: '/login',
    API_BASE: 'http://127.0.0.1:' + backend.address().port + '/api',
    LEASE_SECRET: SECRET, GATEWAY_KEY: 'k'.repeat(32),
    CF_CHALLENGE_PASSTHROUGH: '1', CF_CHALLENGE_MODE: 'passthrough', PROXY_LOG_ALL: '0',
  });
  return spawn(process.execPath, ['server.js'], { cwd: GW, env, stdio: ['ignore', 'pipe', 'pipe'] });
}
async function waitHealth(port) {
  const t0 = Date.now();
  while (Date.now() - t0 < 15000) { if ((await reqTo(port, 'GET', '/__genz/health')).status === 200) return; await new Promise(r => setTimeout(r, 150)); }
  throw new Error('gateway ' + port + ' did not boot');
}
// Exchange a lease for the opaque __Host-claude_session cookie on a given gateway process.
async function openSessionOn(port) {
  const r = await reqTo(port, 'GET', '/gateway?lease=' + encodeURIComponent(mintLease()), { 'user-agent': 'Mozilla/5.0 Chrome/130 Mobile' });
  const sc = [].concat(r.headers['set-cookie'] || []).find(c => /claude_session=/.test(c));
  assert.ok(sc, 'lease exchange must set the opaque session cookie');
  return sc.split(';')[0];
}
const navOn = (port, cookie, ua) => reqTo(port, 'GET', '/new', { cookie, accept: 'text/html', 'user-agent': ua || 'Mozilla/5.0 Chrome/130 Mobile' });
// The working app carries the upstream marker; a block page never proxies upstream so it
// cannot. (The injected overlay embeds the message catalog, so text-matching a block page by
// its words would false-positive on a WORKING page — key on the upstream marker instead.)
const isWorking = (r) => /CLAUDE_APP_OK/.test(r.body);
const isBlock = (r) => !isWorking(r);

test.before(async () => {
  upstream = http.createServer((q, r) => { r.writeHead(200, { 'content-type': 'text/html' }); r.end('<html><head></head><body>CLAUDE_APP_OK</body></html>'); });
  await new Promise(r => upstream.listen(0, r));
  backend = http.createServer((q, r) => {
    let body = ''; q.on('data', c => body += c);
    q.on('end', () => setTimeout(() => {
      r.setHeader('content-type', 'application/json');
      if (q.url.endsWith('/validate')) { validateCalls++; return r.end(JSON.stringify(validateResp || { valid: true, terminal: false, retryable: false, secondsRemaining: 1800 })); }
      if (q.url.endsWith('/session')) { sessionCalls++; return r.end(JSON.stringify({ ok: true, account: { id: 'acc1', label: 'a***1' }, bundle: { cookies: [{ name: 'sessionKey', value: 'VAULT' }] } })); }
      r.end('{}');
    }, backendDelay));
  });
  await new Promise(r => backend.listen(0, r));
  PORT_A = 18870; PORT_B = 18871;
  gwA = bootGateway(PORT_A); gwB = bootGateway(PORT_B);
  await waitHealth(PORT_A); await waitHealth(PORT_B);
});
test.after(() => { for (const p of [gwA, gwB]) { try { p.kill(); } catch (_) {} } try { upstream.close(); } catch (_) {} try { backend.close(); } catch (_) {} });

test('THE FIX: a session created on one worker resolves on ANOTHER worker (recycle/multi-worker)', async () => {
  const cookie = await openSessionOn(PORT_A);
  const onA = await navOn(PORT_A, cookie);
  assert.ok(/CLAUDE_APP_OK/.test(onA.body), 'works on the creating worker');
  // Worker B never held this sid in memory — pre-fix this was a lease_missing block page.
  const onB = await navOn(PORT_B, cookie);
  assert.ok(/CLAUDE_APP_OK/.test(onB.body), 'session rehydrated on the OTHER worker (durable store)');
  assert.ok(!isBlock(onB), 'other worker must NOT show the verification/block page');
});

test('ISOLATION: two clients keep separate sessions across workers', async () => {
  const cA = await openSessionOn(PORT_A);
  const cB = await openSessionOn(PORT_B);
  assert.notStrictEqual(cA, cB, 'distinct opaque session cookies');
  assert.ok(/CLAUDE_APP_OK/.test((await navOn(PORT_B, cA)).body), 'A resolves on B');
  assert.ok(/CLAUDE_APP_OK/.test((await navOn(PORT_A, cB)).body), 'B resolves on A');
});

test('a tampered / foreign opaque session cookie is rejected (not resolved)', async () => {
  const bogus = '__Host-claude_session=' + crypto.randomBytes(32).toString('base64url');
  const r = await navOn(PORT_A, bogus);
  assert.ok(isBlock(r), 'unknown sid must not resolve to any session');
  assert.ok(!/CLAUDE_APP_OK/.test(r.body));
});

test('DEDUP/CACHE: rapid repeat navs reuse one validate round-trip', async () => {
  const cookie = await openSessionOn(PORT_A);
  await navOn(PORT_A, cookie);            // warms the validate cache
  const before = validateCalls;
  await Promise.all([navOn(PORT_A, cookie), navOn(PORT_A, cookie), navOn(PORT_A, cookie)]);
  assert.ok(validateCalls - before <= 1, 'concurrent/rapid navs coalesced to <=1 validate call, got ' + (validateCalls - before));
});

test('PARALLEL: validate + account-session run concurrently, not sequentially', async () => {
  backendDelay = 300;                      // each backend call takes 300ms
  const cookie = await openSessionOn(PORT_B);
  await navOn(PORT_B, cookie);            // may warm caches
  const t0 = Date.now();
  await reqTo(PORT_B, 'GET', '/newconv-' + crypto.randomBytes(3).toString('hex'), { cookie, accept: 'text/html', 'user-agent': 'Mozilla/5.0 Chrome/130 Mobile' });
  const dt = Date.now() - t0;
  backendDelay = 0;
  // Sequential would be ~600ms (validate 300 + session 300). Parallel ≈ ~300ms. Allow slack.
  assert.ok(dt < 550, 'nav should be ~one backend round-trip, not two (got ' + dt + 'ms)');
});

test('FAIL-OPEN: a transient backend 500 does NOT block a valid lease (no reload-into-error)', async () => {
  const cookie = await openSessionOn(PORT_A);
  validateResp = { valid: false, terminal: false, retryable: true, code: 'server_error' };
  const r = await navOn(PORT_A, cookie);
  validateResp = null;
  assert.ok(/CLAUDE_APP_OK/.test(r.body), 'transient backend failure falls back to local lease check, page still served');
});

test('REVOCATION stays prompt: a terminal validate result blocks immediately', async () => {
  const cookie = await openSessionOn(PORT_B);
  await navOn(PORT_B, cookie);
  validateResp = { valid: false, terminal: true, retryable: false, code: 'lease_revoked' };
  // wait out the short validate cache so the terminal result is seen
  await new Promise(r => setTimeout(r, 8200));
  const r = await navOn(PORT_B, cookie);
  validateResp = null;
  assert.ok(isBlock(r), 'a revoked lease must block');
  assert.ok(!/CLAUDE_APP_OK/.test(r.body));
});
