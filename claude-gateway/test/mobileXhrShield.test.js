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
 * ★ 2026-08-10 — THE DEVICE GATE WAS REMOVED FROM BOTH FIXES, and the desktop assertions in this
 * file were INVERTED to match. That reversal is deliberate and is the point of the change:
 * classifyDevice() returns 'desktop' for Mac Safari, Mac Chrome and iPadOS Safari (iPadOS sends a
 * Macintosh UA), and there is no Mac/Safari branch in server.js — so `isMobileClient(req)` excluded
 * EVERY MacBook and iPad, i.e. exactly the devices reporting the cascade. The old
 * "DESKTOP UNCHANGED — an XHR challenge is NOT shielded" tests froze that defect in place.
 *
 * What this file now asserts:
 *   - a SUCCESSFUL (2xx) request is byte-for-byte unchanged on every device — the gate removal
 *     touches challenge handling ONLY;
 *   - a CHALLENGED XHR gets the structured retryable 503 on desktop, Mac, iPad and mobile alike,
 *     and never the raw Cloudflare challenge document;
 *   - a CHALLENGED nav to /api/challenge_redirect is cancelled (204) on every device, with exactly
 *     one upstream hit and no retry wait, so no reload loop can form;
 *   - the genuine no-session/expiry path is untouched by the shield.
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
const UA_MAC_SAFARI = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.5 Safari/605.1.15';
// iPadOS Safari deliberately presents a Macintosh UA — verified live against /__genz/health, which
// classified this exact string as device:"desktop", signal:"ua:desktop".
const UA_IPADOS_SAFARI = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.5 Safari/605.1.15';

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
// Mac Safari sends NO client hints at all, so classifyDevice falls back to the UA test and returns
// 'desktop'. iPadOS Safari reports a *Macintosh* UA, so an iPad is indistinguishable from a MacBook
// here — which is exactly why the removed `isMobileClient` gate excluded both. These two entries
// are the regression guard for the reported device classes.
const MAC = { 'user-agent': UA_MAC_SAFARI };
const IPAD = { 'user-agent': UA_IPADOS_SAFARI };
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

// ── A + B: a SUCCESSFUL request must be unchanged on every device ─────────────────────────────
// This is the guard on the whole change: the gate removal is allowed to alter challenge handling
// and NOTHING else. If a 2xx ever diverges between device classes, the change has overreached.
for (const [label, dev] of [['desktop', DESKTOP], ['mobile', MOBILE], ['mac', MAC], ['ipad', IPAD]]) {
  test(`2xx UNCHANGED — a successful ${label} API request is untouched by the shield`, async () => {
    const sess = await openSession();
    const r = await get('/api/ok', Object.assign({ cookie: sess }, dev, XHR));
    assert.strictEqual(r.status, 200, 'a successful call still succeeds');
    assert.strictEqual(r.body, '{"ok":true}', 'the upstream body is passed through verbatim');
    assert.ok(!/cf_verification|retryable/.test(r.body), 'the shield never touches a 2xx');
  });
}

// ── C + D: a challenged XHR gets the structured response on EVERY device ──────────────────────
// Previously this test asserted the OPPOSITE for desktop ("must NOT get the 503"). See the file
// header: that assertion encoded the defect, because Macs and iPads are in the 'desktop' class.
for (const [label, dev] of [['desktop', DESKTOP], ['mac', MAC], ['ipad', IPAD], ['mobile', MOBILE]]) {
  test(`challenged ${label} XHR gets the structured retryable 503, never raw Cloudflare HTML`, async () => {
    const sess = await openSession();
    const r = await get('/api/cf', Object.assign({ cookie: sess }, dev, XHR));
    assert.strictEqual(r.status, 503, `${label} must get the benign transient error`);
    assert.match(r.headers['content-type'] || '', /application\/json/, 'JSON, not a page');
    assert.match(r.body, /cf_verification|retryable/, 'machine-readable retryable signal');
    assert.ok(!/Verifying you are human/i.test(r.body), 'challenge document never reaches the fetch');
    assert.ok(!/location\.reload|window\.location\s*=/i.test(r.body), 'nothing that can navigate the tab');
    assert.strictEqual(r.headers['cache-control'], 'no-store', 'never cached');
  });
}

// ── E + F: challenge_redirect cannot reload-loop on ANY device ────────────────────────────────
for (const [label, dev] of [['desktop', DESKTOP], ['mac', MAC], ['ipad', IPAD], ['mobile', MOBILE]]) {
  test(`${label} nav to /api/challenge_redirect is cancelled (204) — no reload loop`, async () => {
    const sess = await openSession();
    const before = crHits;
    const t0 = Date.now();
    const r = await get('/api/challenge_redirect', Object.assign({ cookie: sess }, dev, NAV));
    const dt = Date.now() - t0;
    assert.strictEqual(r.status, 204, `${label} navigation is cancelled, not retried into a notice`);
    assert.ok(!r.headers['location'], 'NO redirect: a working page must not be navigated anywhere');
    assert.ok(!/verify the connection|Verifying you are human/i.test(r.body || ''), 'never the verification page');
    assert.strictEqual(crHits - before, 1, 'exactly ONE upstream hit — the retry loop never ran');
    assert.ok(dt < 400, 'returns immediately, no retry wait: ' + dt + 'ms');
  });
}

// ── G: the genuine no-session / expiry path is NOT swallowed by the shield ────────────────────
// The shield must only ever intercept a Cloudflare challenge. A request with no opaque session is
// an authentication condition and must still reach the existing block page, unchanged.
test('EXPIRY UNCHANGED — a request with no session still gets the existing block page, not the shield', async () => {
  const r = await get('/new', Object.assign({}, DESKTOP, NAV));
  assert.notStrictEqual(r.status, 204, 'the loop breaker must not fire on an auth condition');
  assert.ok(!/cf_verification|retryable/.test(r.body || ''), 'the XHR shield must not fire either');
  assert.ok(r.status === 403 || r.status === 302, 'the existing lease/session gate still answers: ' + r.status);
});
