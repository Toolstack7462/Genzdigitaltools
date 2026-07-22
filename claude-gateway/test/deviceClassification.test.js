'use strict';
/**
 * Device classification — the claim under test is "a real phone is classified as mobile".
 *
 * WHY THIS FILE EXISTS: the live gateway logged `device=desktop` for traffic reported as mobile,
 * which made every mobile-gated protection dead code. The classification is now decided ONCE at
 * ingress from the untouched inbound headers (`classifyDevice` → `req.__genzDevice`), and each
 * log line carries a `device_signal` naming WHICH input decided it. These tests boot the REAL
 * gateway, capture its stdout, and assert both the class and the deciding signal per client — so
 * a future header rewrite cannot silently flip the classification again.
 *
 * They also pin the desktop side: desktop Chrome and Edge must keep classifying as desktop.
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
  const p = b64({ jti: 'dev' + crypto.randomBytes(4).toString('hex'), sub: 'u1', tool: 'claude', type: 'proxy_lease', exp: Math.floor(Date.now() / 1000) + 1800 });
  const sig = crypto.createHmac('sha256', SECRET).update(h + '.' + p).digest('base64').replace(/=/g, '').replace(/\+/g, '-').replace(/\//g, '_');
  return h + '.' + p + '.' + sig;
}

const UA = {
  androidChrome: 'Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Mobile Safari/537.36',
  iphoneSafari:  'Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1',
  ipadSafari:    'Mozilla/5.0 (iPad; CPU OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1',
  androidFirefox:'Mozilla/5.0 (Android 14; Mobile; rv:128.0) Gecko/128.0 Firefox/128.0',
  desktopChrome: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36',
  desktopEdge:   'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36 Edg/130.0.0.0',
  macSafari:     'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Safari/605.1.15',
};

let proc, upstream, backend, PORT, out = '';

function req(p, headers) {
  return new Promise((resolve) => {
    const r = http.request({ port: PORT, path: p, method: 'GET', headers: headers || {} }, (res) => {
      const b = []; res.on('data', c => b.push(c));
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(b).toString('utf8') }));
    });
    r.on('error', () => resolve({ status: 0, headers: {}, body: '' }));
    r.end();
  });
}

test.before(async () => {
  upstream = http.createServer((q, r) => { r.writeHead(200, { 'content-type': 'text/html' }); r.end('<html><head></head><body>ok</body></html>'); });
  backend = http.createServer((q, r) => {
    let body = ''; q.on('data', c => body += c);
    q.on('end', () => {
      r.setHeader('content-type', 'application/json');
      if (q.url.endsWith('/session')) return r.end(JSON.stringify({ ok: true, account: { id: 'a1' }, bundle: { cookies: [{ name: 'sessionKey', value: 'V' }] } }));
      if (q.url.endsWith('/validate')) return r.end(JSON.stringify({ valid: true, secondsRemaining: 1800 }));
      r.end('{}');
    });
  });
  await new Promise(r => upstream.listen(0, r));
  await new Promise(r => backend.listen(0, r));
  PORT = 18930;   // keep clear of durableSession (18870) and modelBlock (18890-18915)
  proc = spawn(process.execPath, ['server.js'], {
    cwd: GW,
    env: Object.assign({}, process.env, {
      PORT: String(PORT), TOOL_KEY: 'claude', TOOL_NAME: 'Claude AI',
      TARGET_ORIGIN: 'http://127.0.0.1:' + upstream.address().port,
      GATEWAY_PUBLIC_ORIGIN: 'http://127.0.0.1:' + PORT, DEFAULT_PATH: '/new', SIGNIN_PATH: '/login',
      API_BASE: 'http://127.0.0.1:' + backend.address().port + '/api',
      LEASE_SECRET: SECRET, GATEWAY_KEY: 'k'.repeat(32), PROXY_LOG_ALL: '0',
      CF_CHALLENGE_PASSTHROUGH: '1', CF_CHALLENGE_MODE: 'passthrough',
    }),
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  proc.stdout.on('data', (c) => { out += c.toString(); });
  const t0 = Date.now();
  while (Date.now() - t0 < 15000) { if ((await req('/__genz/health')).status === 200) break; await new Promise(r => setTimeout(r, 150)); }
});
test.after(() => { try { proc.kill(); } catch (_) {} try { upstream.close(); } catch (_) {} try { backend.close(); } catch (_) {} });

// Drive one real navigation as a given client and read back what the gateway LOGGED about it.
async function classifyVia(headers) {
  const open = await req('/gateway?lease=' + encodeURIComponent(mintLease()));
  const sc = [].concat(open.headers['set-cookie'] || []).find(c => /claude_session=/.test(c));
  const cookie = sc.split(';')[0];
  out = '';
  await req('/new', Object.assign({ cookie, accept: 'text/html' }, headers));
  const line = out.split('\n').filter(l => l.includes('nav_timing')).pop();
  assert.ok(line, 'the navigation produced a nav_timing log line');
  const rec = JSON.parse(line.slice(line.indexOf('{')));
  return { device: rec.device, signal: rec.device_signal };
}

// ── MOBILE MUST CLASSIFY AS MOBILE ───────────────────────────────────────────
test('Android Chrome (sends Sec-CH-UA-Mobile: ?1) → mobile', async () => {
  const r = await classifyVia({ 'user-agent': UA.androidChrome, 'sec-ch-ua-mobile': '?1', 'sec-ch-ua-platform': '"Android"' });
  assert.deepStrictEqual(r, { device: 'mobile', signal: 'ch:?1' });
});

test('Android Chrome with the hint STRIPPED by a proxy hop → still mobile, via the UA', async () => {
  // This is the fallback that must survive a hosting layer that drops client hints.
  const r = await classifyVia({ 'user-agent': UA.androidChrome });
  assert.deepStrictEqual(r, { device: 'mobile', signal: 'ua' });
});

test('iPhone Safari (never sends client hints at all) → mobile', async () => {
  const r = await classifyVia({ 'user-agent': UA.iphoneSafari });
  assert.deepStrictEqual(r, { device: 'mobile', signal: 'ua' });
});

test('iPad Safari → mobile', async () => {
  const r = await classifyVia({ 'user-agent': UA.ipadSafari });
  assert.strictEqual((await classifyVia({ 'user-agent': UA.ipadSafari })).device, 'mobile');
  assert.strictEqual(r.device, 'mobile');
});

test('Android Firefox (no client hints, "Mobile" token only) → mobile', async () => {
  const r = await classifyVia({ 'user-agent': UA.androidFirefox });
  assert.strictEqual(r.device, 'mobile', 'the bare "Mobile" token must count — Firefox sends no Sec-CH-UA');
});

test('a padded or duplicated Sec-CH-UA-Mobile value still reads as mobile', async () => {
  // A strict `=== "?1"` silently fell through whenever a hop reformatted the header; the loose
  // match is what keeps a real phone from being classified as a desktop.
  const r = await classifyVia({ 'user-agent': UA.androidChrome, 'sec-ch-ua-mobile': ' ?1' });
  assert.strictEqual(r.device, 'mobile');
  const dup = await classifyVia({ 'user-agent': UA.androidChrome, 'sec-ch-ua-mobile': '?1, ?1' });
  assert.strictEqual(dup.device, 'mobile');
});

// ── DESKTOP MUST REMAIN DESKTOP ──────────────────────────────────────────────
test('desktop Chrome → desktop (unchanged)', async () => {
  const r = await classifyVia({ 'user-agent': UA.desktopChrome, 'sec-ch-ua-mobile': '?0', 'sec-ch-ua-platform': '"Windows"' });
  assert.deepStrictEqual(r, { device: 'desktop', signal: 'ch:?0' });
});

test('desktop Edge → desktop (unchanged)', async () => {
  const r = await classifyVia({ 'user-agent': UA.desktopEdge, 'sec-ch-ua-mobile': '?0', 'sec-ch-ua-platform': '"Windows"' });
  assert.strictEqual(r.device, 'desktop');
});

test('macOS Safari (no hints, no mobile token) → desktop', async () => {
  const r = await classifyVia({ 'user-agent': UA.macSafari });
  assert.deepStrictEqual(r, { device: 'desktop', signal: 'ua:desktop' });
});

// ── The case that actually produced "a real phone logged as desktop" ─────────
test('a phone in "Request desktop site" mode classifies as desktop, and SAYS SO in the signal', async () => {
  // Chrome's desktop-site mode sends ?0 AND spoofs navigator, so treating it as desktop is
  // correct — its in-browser challenge fingerprint reports desktop too. What matters is that the
  // log makes this distinguishable from a genuine desktop, instead of looking identical to one.
  const r = await classifyVia({ 'user-agent': UA.androidChrome, 'sec-ch-ua-mobile': '?0' });
  assert.strictEqual(r.device, 'desktop', 'the client asked to be treated as a desktop');
  assert.strictEqual(r.signal, 'ch:?0+mobile-ua', 'and the signal reveals it is really a phone');
});

test('the classification is decided at ingress and never recomputed downstream', async () => {
  // Same request, two independent log records (nav_timing at ingress, proxy after the upstream
  // headers were rewritten). If the upstream identity ever fed back into the classification these
  // would disagree — which is precisely the failure mode this indirection prevents.
  const open = await req('/gateway?lease=' + encodeURIComponent(mintLease()));
  const cookie = [].concat(open.headers['set-cookie'] || []).find(c => /claude_session=/.test(c)).split(';')[0];
  out = '';
  await req('/new', { cookie, accept: 'text/html', 'user-agent': UA.androidChrome, 'sec-ch-ua-mobile': '?1' });
  const recs = out.split('\n').filter(l => l.includes('"device"')).map(l => JSON.parse(l.slice(l.indexOf('{'))));
  assert.ok(recs.length >= 2, 'both the ingress and the proxy record carry the device class');
  for (const r of recs) assert.strictEqual(r.device, 'mobile', 'every stage agrees: ' + JSON.stringify(recs.map(x => x.device)));
});

test('no User-Agent string is ever written to the log', async () => {
  await classifyVia({ 'user-agent': UA.iphoneSafari, 'sec-ch-ua-mobile': '?1' });
  assert.ok(!out.includes('iPhone'), 'the UA itself is never logged — only the derived class and signal');
  assert.ok(!out.includes('AppleWebKit'), 'no UA fragments either');
});
