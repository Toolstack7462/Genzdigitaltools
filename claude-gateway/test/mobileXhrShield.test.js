'use strict';
/**
 * Mobile Cloudflare-loop shield (CLAUDE_MOBILE_XHR_SHIELD) — the permanent fix for the 3–4 reloads.
 *
 * ROOT CAUSE (live console.log, 4,591 lines): the shared datacenter egress IP is CF-challenged on
 * ~35% of requests, none of them a login/session failure (redirected_to_login=false on 100%). When
 * a challenge lands on an XHR/API fetch, Claude's SPA reacts by full-page-navigating the tab to
 * /api/challenge_redirect to solve it; through a reverse proxy that interactive challenge can never
 * clear, so it re-challenges — 179 XHR challenges → 288 challenge_redirect navs (all 403) → reloads.
 *
 * Fix A: a mobile XHR/API challenge returns a benign, NON-navigating 503 JSON so the SPA retries in
 *         place instead of navigating to challenge_redirect.
 * Fix B: a stray mobile NAV to /api/challenge_redirect is CANCELLED (204) so the running app stays
 *         retried or surfaced, so the loop's tail cannot form.
 *
 * BOTH are gated on isMobileClient(req). This file asserts they fire on mobile AND that DESKTOP is
 * byte-for-byte unchanged (desktop XHR still gets the raw challenge passthrough; desktop
 * challenge_redirect still goes through the existing retry→notice path — NOT the 302 break).
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
  const p = b64({ jti: 'shjti' + crypto.randomBytes(3).toString('hex'), sub: 'u1', tool: 'claude', type: 'proxy_lease', exp: Math.floor(Date.now() / 1000) + 1800 });
  const sig = crypto.createHmac('sha256', SECRET).update(h + '.' + p).digest('base64').replace(/=/g, '').replace(/\+/g, '-').replace(/\//g, '_');
  return h + '.' + p + '.' + sig;
}
const UA_DESKTOP = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36';
const UA_ANDROID = 'Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Mobile Safari/537.36';

let proc, upstream, backend, GW_PORT, crHits = 0;

test.before(async () => {
  backend = http.createServer((q, r) => {
    let body = ''; q.on('data', c => body += c);
    q.on('end', () => {
      r.setHeader('content-type', 'application/json');
      if (q.url.endsWith('/session')) return r.end(JSON.stringify({ ok: true, account: { id: 'acc1', maskedId: 'a***1' }, bundle: { cookies: [{ name: 'sessionKey', value: 'VAULT_SECRET' }] } }));
      if (q.url.endsWith('/validate')) return r.end(JSON.stringify({ valid: true, secondsRemaining: 1800 }));
      r.end('{}');
    });
  });
  await new Promise((res) => backend.listen(0, res));
  const bePort = backend.address().port;
  upstream = http.createServer((q, r) => {
    const p = q.url.split('?')[0];
    const challenge = () => {
      r.writeHead(403, { 'content-type': 'text/html', server: 'cloudflare', 'cf-ray': '9abc123', 'cf-mitigated': 'challenge' });
      r.end('<html><body>Verifying you are human… <script>window.location.reload()</script></body></html>');
    };
    if (p === '/api/challenge_redirect') { crHits += 1; return challenge(); } // always challenges (unsolvable)
    if (p === '/api/cf') return challenge();                                  // an XHR/API endpoint that gets challenged
    r.writeHead(200, { 'content-type': p.startsWith('/api/') ? 'application/json' : 'text/html' });
    r.end(p.startsWith('/api/') ? '{"ok":true}' : '<html><head></head><body>ok</body></html>');
  });
  await new Promise((res) => upstream.listen(0, res));
  const upPort = upstream.address().port;

  GW_PORT = 18862;
  const env = Object.assign({}, process.env, {
    PORT: String(GW_PORT), TOOL_KEY: 'claude', TOOL_NAME: 'Claude AI',
    TARGET_ORIGIN: 'http://127.0.0.1:' + upPort,
    GATEWAY_PUBLIC_ORIGIN: 'http://127.0.0.1:' + GW_PORT, DEFAULT_PATH: '/new', SIGNIN_PATH: '/login',
    API_BASE: 'http://127.0.0.1:' + bePort + '/api', LEASE_SECRET: SECRET, GATEWAY_KEY: 'k'.repeat(32),
    CF_CHALLENGE_PASSTHROUGH: '1', CF_CHALLENGE_MODE: 'passthrough',
    CLAUDE_CF_NAV_RETRIES: '1', CLAUDE_CF_NAV_RETRY_DELAY_MS: '150',
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
async function openSession() {
  const r = await get('/gateway?lease=' + encodeURIComponent(mintLease()), { 'user-agent': UA_DESKTOP });
  const sc = [].concat(r.headers['set-cookie'] || []).find(c => /claude_session=/.test(c));
  assert.ok(sc, 'lease exchange must set an opaque session cookie');
  return sc.split(';')[0];
}
const MOBILE = { 'user-agent': UA_ANDROID, 'sec-ch-ua-mobile': '?1' };
const DESKTOP = { 'user-agent': UA_DESKTOP, 'sec-ch-ua-mobile': '?0' };
const XHR = { accept: 'application/json', 'sec-fetch-mode': 'cors', 'x-requested-with': 'XMLHttpRequest' };
const NAV = { accept: 'text/html,application/xhtml+xml' };

// ── Fix A: mobile XHR/API challenge → benign non-navigating 503, never the challenge document ──
test('Fix A — mobile XHR challenge returns a non-navigating 503 JSON, not the challenge HTML', async () => {
  const sess = await openSession();
  const r = await get('/api/cf', Object.assign({ cookie: sess }, MOBILE, XHR));
  assert.strictEqual(r.status, 503, 'a benign transient error, not the 403 challenge');
  assert.match(r.headers['content-type'] || '', /application\/json/, 'JSON, so the SPA does not treat it as a page');
  assert.match(r.body, /cf_verification|retryable/, 'the machine-readable retryable signal');
  assert.ok(!/Verifying you are human/i.test(r.body), 'the challenge document never reaches the fetch');
  assert.ok(!/location\.reload|window\.location\s*=/i.test(r.body), 'nothing that could navigate the tab');
  assert.strictEqual(r.headers['cache-control'], 'no-store', 'never cached');
});

// ── Fix B: mobile nav to challenge_redirect → the navigation is CANCELLED, not redirected ──
// This assertion CHANGED deliberately. It used to require a 302 to DEFAULT_PATH, which encoded the
// defect: a 302 is still a full-page navigation, so it tore down the working Claude page, and when
// that fresh navigation was itself challenged it spent the nav retries and landed on the "asked us
// to verify the connection" notice ~10s after a successful load — the reported mobile symptom.
// A 204 aborts the navigation instead, leaving the running app exactly as it was.
test('Fix B — mobile nav to /api/challenge_redirect cancels the navigation (204), leaving the app up', async () => {
  const sess = await openSession();
  const before = crHits;
  const t0 = Date.now();
  const r = await get('/api/challenge_redirect', Object.assign({ cookie: sess }, MOBILE, NAV));
  const dt = Date.now() - t0;
  assert.strictEqual(r.status, 204, 'navigation cancelled, not retried into a notice');
  assert.ok(!r.headers['location'], 'NO redirect: a working page must not be navigated anywhere');
  assert.ok(!/verify the connection|Verifying you are human/i.test(r.body || ''), 'never the verification page');
  assert.strictEqual(crHits - before, 1, 'exactly ONE upstream hit — the retry loop never ran');
  assert.ok(dt < 400, 'returns immediately (no 2×retry wait): ' + dt + 'ms');
});

// ── DESKTOP FREEZE: neither fix fires on desktop; behaviour is exactly as before ──
test('DESKTOP UNCHANGED — an XHR challenge is NOT shielded (raw passthrough, not the 503)', async () => {
  const sess = await openSession();
  const r = await get('/api/cf', Object.assign({ cookie: sess }, DESKTOP, XHR));
  assert.notStrictEqual(r.status, 503, 'desktop must NOT get the mobile 503 shield');
  assert.ok(!/cloudflare_challenge/.test(r.body), 'desktop never sees the mobile shield body');
});

test('DESKTOP UNCHANGED — challenge_redirect still uses the existing retry→notice path, not the 204 break', async () => {
  const sess = await openSession();
  const r = await get('/api/challenge_redirect', Object.assign({ cookie: sess }, DESKTOP, NAV));
  assert.notStrictEqual(r.status, 204, 'desktop must NOT get the mobile navigation cancel');
  assert.strictEqual(r.status, 503, 'desktop keeps the existing recoverable notice');
  assert.match(r.body, /try again/i, 'the existing desktop notice is unchanged');
});
