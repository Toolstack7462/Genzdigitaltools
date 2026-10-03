'use strict';
/**
 * StealthWriter gateway — the post-audit metering backstop (STEALTH_METERED_PATHS).
 *   node --test test/usageBackstop.test.js
 *
 * The overlay is what tags a request with its reservation, and a member who disables page
 * script could simply not tag it. Once the exact Humanizer/Detector request paths are known
 * from a live audit, STEALTH_METERED_PATHS closes that door server-side: a mutating request
 * to a metered path WITHOUT a reservation is refused instead of being proxied for free.
 *
 * Shipped OFF (the variable is unset), so this file also pins that an unset backstop changes
 * nothing — which is what makes it safe to deploy before the audit and enable afterwards,
 * from the .htaccess, with no code change.
 */
const test = require('node:test');
const assert = require('node:assert');
const http = require('http');
const crypto = require('crypto');
const path = require('path');
const { spawn } = require('node:child_process');

const GW = path.resolve(__dirname, '..');
const SECRET = 'x'.repeat(48);
const GATEWAY_KEY = 'k'.repeat(32);
const b64 = (o) => Buffer.from(JSON.stringify(o)).toString('base64url');

function mintLease() {
  const h = b64({ alg: 'HS256', typ: 'JWT' });
  const p = b64({
    jti: 'j' + crypto.randomBytes(4).toString('hex'), sub: 'u1', scid: 'sc1',
    type: 'stealth_lease', fixed: false, exp: Math.floor(Date.now() / 1000) + 1800,
  });
  const sig = crypto.createHmac('sha256', SECRET).update(h + '.' + p).digest('base64')
    .replace(/=/g, '').replace(/\+/g, '-').replace(/\//g, '_');
  return h + '.' + p + '.' + sig;
}

let upstream, backend, gw, PORT;
const codes = new Map();
let upstreamRequests = [];

function request(method, p, headers, body) {
  return new Promise((resolve) => {
    const buf = body === undefined ? null : Buffer.from(body);
    const h = Object.assign({}, headers || {});
    if (buf) h['content-length'] = buf.length;
    const r = http.request({ port: PORT, path: p, method, headers: h }, (res) => {
      const chunks = []; res.on('data', c => chunks.push(c));
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks).toString('utf8') }));
    });
    r.on('error', () => resolve({ status: 0, headers: {}, body: '' }));
    if (buf) r.write(buf);
    r.end();
  });
}
const postForm = (p, fields) =>
  request('POST', p, { 'content-type': 'application/x-www-form-urlencoded' }, new URLSearchParams(fields).toString());
const postJson = (p, obj, headers) =>
  request('POST', p, Object.assign({ 'content-type': 'application/json' }, headers || {}), JSON.stringify(obj || {}));

async function openSession() {
  const code = crypto.randomBytes(32).toString('base64url');
  codes.set(code, mintLease());
  const res = await postForm('/launch', { code });
  const sc = [].concat(res.headers['set-cookie'] || []).find(c => /^__Host-stealth_session=/.test(c));
  return sc.split(';')[0];
}
const OP = () => crypto.randomBytes(16).toString('hex');

test.before(async () => {
  upstream = http.createServer((q, r) => {
    const chunks = [];
    q.on('data', c => chunks.push(c));
    q.on('end', () => {
      upstreamRequests.push({ url: q.url, method: q.method });
      if (String(q.headers.accept || '').includes('text/html')) {
        r.writeHead(200, { 'content-type': 'text/html' });
        return r.end('<html><head></head><body>STEALTH_APP_OK</body></html>');
      }
      r.writeHead(200, { 'content-type': 'application/json' });
      r.end(JSON.stringify({ d: 'UkVTVUxU', s: 'k3y' }));
    });
  });
  await new Promise(r => upstream.listen(0, r));

  backend = http.createServer((q, r) => {
    let body = '';
    q.on('data', c => { body += c; });
    q.on('end', () => {
      r.setHeader('content-type', 'application/json');
      let parsed = {}; try { parsed = JSON.parse(body || '{}'); } catch (_) {}
      if (q.url.endsWith('/redeem-launch')) {
        const lease = codes.get(parsed.code);
        if (!lease) { r.statusCode = 400; return r.end(JSON.stringify({ ok: false, code: 'launch_code_invalid' })); }
        codes.delete(parsed.code);
        return r.end(JSON.stringify({ ok: true, lease, capture: false, fixedLease: false, secondsRemaining: 1800 }));
      }
      if (q.url.endsWith('/validate')) return r.end(JSON.stringify({ valid: true, terminal: false, secondsRemaining: 1800 }));
      if (q.url.endsWith('/usage/reserve')) return r.end(JSON.stringify({ ok: true, allowed: true, operationId: OP() }));
      if (q.url.endsWith('/session')) return r.end(JSON.stringify({ ok: true, account: null }));
      r.end('{}');
    });
  });
  await new Promise(r => backend.listen(0, r));

  PORT = 18899;
  gw = spawn(process.execPath, ['server.js'], {
    cwd: GW,
    env: Object.assign({}, process.env, {
      PORT: String(PORT),
      STEALTH_TARGET_ORIGIN: 'http://127.0.0.1:' + upstream.address().port,
      STEALTH_API_BASE: 'http://127.0.0.1:' + backend.address().port + '/api',
      GATEWAY_PUBLIC_ORIGIN: 'http://127.0.0.1:' + PORT,
      STEALTH_LEASE_SECRET: SECRET, STEALTH_GATEWAY_KEY: GATEWAY_KEY,
      STEALTH_DEFAULT_PATH: '/dashboard/humanizer',
      // The audited Humanizer/Detector paths. This is the only thing that turns the
      // backstop on — no code change, no redeploy of the app.
      STEALTH_METERED_PATHS: '^/api/(humanize|scan)(/|$)',
    }),
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const t0 = Date.now();
  while (Date.now() - t0 < 15000) {
    const r = await postForm('/launch', {});
    if (r.status !== 0) break;
    await new Promise(x => setTimeout(x, 150));
  }
});
test.after(() => {
  try { gw.kill(); } catch (_) {}
  try { upstream.close(); } catch (_) {}
  try { backend.close(); } catch (_) {}
});
test.beforeEach(() => { upstreamRequests = []; });

test('an UNTAGGED mutating request to a metered path is refused, not served for free', async () => {
  const cookie = await openSession();
  const res = await postJson('/api/humanize', { hello: 1 }, { cookie });
  assert.equal(res.status, 409);
  assert.match(res.body, /usage_reservation_required/);
  assert.equal(upstreamRequests.length, 0, 'StealthWriter is never asked to do the work');
});

test('a TAGGED request to the same path goes through', async () => {
  const cookie = await openSession();
  const res = await postJson('/api/humanize', { hello: 1 }, { cookie, 'x-genz-op': OP(), 'x-genz-action': 'humanizer' });
  assert.equal(res.status, 200);
  assert.equal(upstreamRequests.length, 1);
});

test('the detector path is covered by the same backstop', async () => {
  const cookie = await openSession();
  const res = await postJson('/api/scan', { hello: 1 }, { cookie });
  assert.equal(res.status, 409);
  assert.equal(upstreamRequests.length, 0);
});

test('a GET to a metered path is untouched — reading is not a billable action', async () => {
  const cookie = await openSession();
  const res = await request('GET', '/api/humanize', { cookie });
  assert.equal(res.status, 200);
  assert.equal(upstreamRequests.length, 1);
});

test('paths outside the pattern are proxied exactly as before', async () => {
  const cookie = await openSession();
  const res = await postJson('/api/settings', { theme: 'dark' }, { cookie });
  assert.equal(res.status, 200);
  assert.equal(upstreamRequests.length, 1, 'other tools and other endpoints are untouched');
});

test('page navigation still works with the backstop on', async () => {
  const cookie = await openSession();
  const res = await request('GET', '/dashboard/humanizer', { cookie, accept: 'text/html' });
  assert.equal(res.status, 200);
  assert.match(res.body, /STEALTH_APP_OK/);
});
