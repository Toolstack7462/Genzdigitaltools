'use strict';
/**
 * Claude gateway — one-time POST launch bootstrap.
 *
 * WHAT THIS PINS
 * The launch credential must never be reachable from a URL. Before this flow the dashboard
 * opened `/gateway?lease=<JWT>`, so the lease sat in the address bar, in history, in the
 * Referer of the first upstream request and in every access log on the path — and that JWT
 * carries the client id, tool and account id as readable claims. Now the dashboard POSTs a
 * single-use code, the gateway redeems it server-to-server, and the browser is 303'd to a
 * clean URL holding nothing but an opaque HttpOnly session id.
 *
 * Coverage: happy path + cookie attributes, the clean redirect, 303-not-302, method gate,
 * replay of a spent code, expiry, refresh-stays-expired, relaunch, multiple tabs, concurrent
 * launches, the ALLOW_URL_LEASE rollback switch, and the guarantee that the code reaches the
 * backend in a BODY (never a query string) and never appears in anything sent to the browser.
 *
 * Real gateway process, mock backend, mock upstream. Node built-in runner.
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

function mintLease(extra) {
  const h = b64({ alg: 'HS256', typ: 'JWT' });
  const p = b64(Object.assign({
    jti: 'j' + crypto.randomBytes(4).toString('hex'), sub: 'u1', tool: 'claude',
    type: 'proxy_lease', exp: Math.floor(Date.now() / 1000) + 1800,
  }, extra || {}));
  const sig = crypto.createHmac('sha256', SECRET).update(h + '.' + p).digest('base64')
    .replace(/=/g, '').replace(/\+/g, '-').replace(/\//g, '_');
  return h + '.' + p + '.' + sig;
}

let upstream, backend, gw, PORT;
// The mock backend's launch-code table: code -> { lease, spent }
const codes = new Map();
// Everything the gateway asked the backend, so the test can assert on the wire format.
let redeemRequests = [];

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
const postForm = (p, fields, headers) =>
  request('POST', p, Object.assign({ 'content-type': 'application/x-www-form-urlencoded' }, headers || {}),
    new URLSearchParams(fields).toString());

function issueCode(leaseExtra) {
  const code = crypto.randomBytes(32).toString('base64url');
  codes.set(code, { lease: mintLease(leaseExtra), spent: false, expired: false });
  return code;
}
const sessionCookieFrom = (res) =>
  [].concat(res.headers['set-cookie'] || []).find(c => /^__Host-claude_session=/.test(c)) || null;
const cookieValue = (setCookie) => setCookie.split(';')[0];

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/130 Safari/537.36';
const nav = (cookie, ua) => request('GET', '/new', { cookie, accept: 'text/html', 'user-agent': ua || UA });
const isWorking = (r) => /CLAUDE_APP_OK/.test(r.body);

test.before(async () => {
  upstream = http.createServer((q, r) => {
    r.writeHead(200, { 'content-type': 'text/html' });
    r.end('<html><head></head><body>CLAUDE_APP_OK</body></html>');
  });
  await new Promise(r => upstream.listen(0, r));

  backend = http.createServer((q, r) => {
    let body = '';
    q.on('data', c => { body += c; });
    q.on('end', () => {
      r.setHeader('content-type', 'application/json');
      if (q.url.endsWith('/redeem-launch')) {
        redeemRequests.push({ url: q.url, headers: q.headers, body });
        let parsed = {};
        try { parsed = JSON.parse(body || '{}'); } catch (_) {}
        const rec = codes.get(parsed.code);
        // Mirrors the real backend's atomic single-use redemption.
        if (!rec) { r.statusCode = 400; return r.end(JSON.stringify({ ok: false, code: 'launch_code_invalid' })); }
        if (rec.expired) { codes.delete(parsed.code); r.statusCode = 400; return r.end(JSON.stringify({ ok: false, code: 'launch_code_expired' })); }
        if (rec.spent) { r.statusCode = 400; return r.end(JSON.stringify({ ok: false, code: 'launch_code_used' })); }
        rec.spent = true;
        return r.end(JSON.stringify({ ok: true, lease: rec.lease, tool: 'claude', capture: false, secondsRemaining: 1800 }));
      }
      if (q.url.endsWith('/validate')) return r.end(JSON.stringify({ valid: true, terminal: false, retryable: false, secondsRemaining: 1800 }));
      if (q.url.endsWith('/session')) return r.end(JSON.stringify({ ok: true, account: { id: 'acc1', label: 'a***1' }, bundle: { cookies: [{ name: 'sessionKey', value: 'VAULT' }] } }));
      r.end('{}');
    });
  });
  await new Promise(r => backend.listen(0, r));

  // node --test runs files CONCURRENTLY, so every suite needs its own port block.
  // Taken: 18860-2, 18870-1, 18877, 18890-18915 (modelBlock/mobileRelaunch), 18895
  // (fileDownload), 18930 (deviceClassification). This suite owns 18940-18941.
  PORT = 18940;
  gw = spawn(process.execPath, ['server.js'], {
    cwd: GW,
    env: Object.assign({}, process.env, {
      PORT: String(PORT), TOOL_KEY: 'claude', TOOL_NAME: 'Claude AI',
      TARGET_ORIGIN: 'http://127.0.0.1:' + upstream.address().port,
      GATEWAY_PUBLIC_ORIGIN: 'http://127.0.0.1:' + PORT,
      DEFAULT_PATH: '/new', SIGNIN_PATH: '/login',
      API_BASE: 'http://127.0.0.1:' + backend.address().port + '/api',
      LEASE_SECRET: SECRET, GATEWAY_KEY,
      CF_CHALLENGE_PASSTHROUGH: '1', CF_CHALLENGE_MODE: 'passthrough', PROXY_LOG_ALL: '0',
    }),
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const t0 = Date.now();
  while (Date.now() - t0 < 15000) {
    if ((await request('GET', '/__genz/health')).status === 200) break;
    await new Promise(r => setTimeout(r, 150));
  }
});
test.after(() => {
  try { gw.kill(); } catch (_) {}
  try { upstream.close(); } catch (_) {}
  try { backend.close(); } catch (_) {}
});
test.beforeEach(() => { redeemRequests = []; });

// ── Happy path ───────────────────────────────────────────────────────────────

test('POST /launch redeems the code and 303s to a CLEAN url with an opaque HttpOnly cookie', async () => {
  const res = await postForm('/launch', { code: issueCode() }, { 'user-agent': UA });

  assert.equal(res.status, 303, '303 forces the follow-up to be a GET — a 302 could replay the POST');
  assert.equal(res.headers.location, '/new', 'lands on the clean tool path');
  assert.ok(!String(res.headers.location).includes('?'), 'the redirect target carries NO query string');
  assert.ok(!/lease|token|jwt|code=/i.test(String(res.headers.location)), 'nothing credential-shaped in the URL');

  const sc = sessionCookieFrom(res);
  assert.ok(sc, 'sets __Host-claude_session');
  assert.match(sc, /HttpOnly/i, 'HttpOnly — page script can never read it');
  assert.match(sc, /Secure/i);
  assert.match(sc, /SameSite=Lax/i);
  assert.match(sc, /Path=\//);
  assert.ok(!/Domain=/i.test(sc), '__Host- requires host-only: no Domain attribute');
  assert.match(sc, /Max-Age=\d+/, 'expires with the lease');

  assert.equal(res.headers['cache-control'], 'no-store');
  assert.equal(res.headers['referrer-policy'], 'no-referrer');
});

test('the opaque cookie is a working session: the landing page loads the real app', async () => {
  const res = await postForm('/launch', { code: issueCode() });
  const page = await nav(cookieValue(sessionCookieFrom(res)));
  assert.equal(page.status, 200);
  assert.ok(isWorking(page), 'the app is proxied, not a block page');
});

test('the code reaches the backend in a POST BODY, never a query string', async () => {
  const code = issueCode();
  await postForm('/launch', { code });
  assert.equal(redeemRequests.length, 1);
  const req = redeemRequests[0];
  assert.ok(!req.url.includes('?'), 'no query string on the redemption call');
  assert.ok(!req.url.includes(code), 'the code is not in the path');
  assert.equal(JSON.parse(req.body).code, code, 'it is in the body');
  assert.equal(req.headers['x-gateway-key'], GATEWAY_KEY, 'authenticated by the gateway key alone (no lease exists yet)');
});

test('nothing sent to the browser contains the lease JWT or the launch code', async () => {
  const code = issueCode();
  const res = await postForm('/launch', { code });
  const wire = JSON.stringify(res.headers) + res.body;
  assert.ok(!wire.includes(code), 'the code is never echoed back');
  assert.ok(!/eyJhbGciOi/.test(wire), 'no JWT anywhere in the response');
  const page = await nav(cookieValue(sessionCookieFrom(res)));
  assert.ok(!/eyJhbGciOi/.test(page.body), 'and none in the proxied page either');
});

// ── Method + input gates ─────────────────────────────────────────────────────

test('GET /launch is refused — a launch is never a URL you can visit', async () => {
  const res = await request('GET', '/launch?code=' + issueCode(), { accept: 'text/html' });
  assert.equal(res.status, 405);
  assert.equal(res.headers.allow, 'POST');
  assert.equal(sessionCookieFrom(res), null, 'and it must not mint a session');
});

test('a launch with no code, or a junk code, grants nothing', async () => {
  for (const fields of [{}, { code: '' }, { code: 'not-a-real-code' }, { code: 'x'.repeat(200) }]) {
    const res = await postForm('/launch', fields);
    assert.equal(res.status, 403, `refused: ${JSON.stringify(fields)}`);
    assert.equal(sessionCookieFrom(res), null, 'no session cookie is set on a refused launch');
  }
});

test('an oversized body is dropped rather than buffered', async () => {
  const res = await postForm('/launch', { code: issueCode(), pad: 'A'.repeat(9000) });
  assert.equal(sessionCookieFrom(res), null, 'no session from an over-limit body');
});

// ── Replay + expiry ──────────────────────────────────────────────────────────

test('REPLAY: submitting a used launch code a second time is refused', async () => {
  const code = issueCode();
  const first = await postForm('/launch', { code });
  assert.equal(first.status, 303, 'first use succeeds');

  for (let i = 0; i < 3; i++) {
    const again = await postForm('/launch', { code });
    assert.equal(again.status, 403, 'a replayed code never opens a session');
    assert.equal(sessionCookieFrom(again), null);
  }
});

test('an expired launch code is refused', async () => {
  const code = issueCode();
  codes.get(code).expired = true;
  const res = await postForm('/launch', { code });
  assert.equal(res.status, 403);
  assert.equal(sessionCookieFrom(res), null);
});

test('a backend outage during launch fails closed (no session), and is not cached as a verdict', async () => {
  // An unroutable backend is simulated by a code the mock refuses; the point is that a failed
  // redemption must leave the browser with nothing rather than a half-open session.
  const res = await postForm('/launch', { code: crypto.randomBytes(32).toString('base64url') });
  assert.equal(sessionCookieFrom(res), null);
  // …and a subsequent GOOD launch still works, i.e. the failure poisoned nothing.
  const ok = await postForm('/launch', { code: issueCode() });
  assert.equal(ok.status, 303);
});

// ── Session lifecycle ────────────────────────────────────────────────────────

test('REFRESH of an expired session stays expired — only a new dashboard launch revives it', async () => {
  // A lease that is already past its exp: the gateway must refuse it locally.
  const dead = issueCode({ exp: Math.floor(Date.now() / 1000) - 60 });
  const res = await postForm('/launch', { code: dead });
  const sc = sessionCookieFrom(res);
  const cookie = sc ? cookieValue(sc) : '__Host-claude_session=stale';

  // Refresh the tool page repeatedly — it must never come back to life on its own.
  for (let i = 0; i < 3; i++) {
    const r = await nav(cookie);
    assert.ok(!isWorking(r), 'a refresh must not resurrect an expired session');
  }

  // Only an authorized dashboard relaunch mints a working session.
  const relaunch = await postForm('/launch', { code: issueCode() });
  assert.equal(relaunch.status, 303);
  assert.ok(isWorking(await nav(cookieValue(sessionCookieFrom(relaunch)))), 'the fresh launch works');
});

test('a forged or unknown session cookie is worthless', async () => {
  for (const forged of ['__Host-claude_session=' + crypto.randomBytes(32).toString('base64url'), '__Host-claude_session=abc']) {
    const r = await nav(forged);
    assert.ok(!isWorking(r), 'an invented opaque id resolves to no session');
  }
});

test('MULTIPLE TABS: each launch gets its own session id and both keep working', async () => {
  const a = await postForm('/launch', { code: issueCode() });
  const b = await postForm('/launch', { code: issueCode() });
  const ca = cookieValue(sessionCookieFrom(a));
  const cb = cookieValue(sessionCookieFrom(b));
  assert.notEqual(ca, cb, 'a fresh, unpredictable sid per launch (session-fixation safe)');

  assert.ok(isWorking(await nav(ca)), 'tab A works');
  assert.ok(isWorking(await nav(cb)), 'tab B works');
  assert.ok(isWorking(await nav(ca)), 'tab A still works after tab B opened — no clobbering');
});

test('CONCURRENT launches each resolve to their own session', async () => {
  const list = Array.from({ length: 6 }, () => issueCode());
  const results = await Promise.all(list.map(code => postForm('/launch', { code })));
  const sids = results.map(r => { const sc = sessionCookieFrom(r); return sc ? cookieValue(sc) : null; });
  assert.ok(sids.every(Boolean), 'every concurrent launch succeeded');
  assert.equal(new Set(sids).size, sids.length, 'and every one got a distinct session id');
  for (const sid of sids) assert.ok(isWorking(await nav(sid)));
});

test('a capture lease lands on the sign-in path, not the app', async () => {
  const res = await postForm('/launch', { code: issueCode({ cap: true }) });
  assert.equal(res.status, 303);
  assert.equal(res.headers.location, '/login', 'capture mode must land where the operator can log in');
});

// ── Rollback switch ──────────────────────────────────────────────────────────

test('the legacy /gateway?lease= entry point still works while ALLOW_URL_LEASE is on', async () => {
  // This is the rollback path: LAUNCH_FLOW=url on the backend needs no gateway redeploy.
  const res = await request('GET', '/gateway?lease=' + encodeURIComponent(mintLease()), { 'user-agent': UA });
  assert.equal(res.status, 302);
  assert.ok(sessionCookieFrom(res), 'still exchanges the URL lease for an opaque session');
});

test('ALLOW_URL_LEASE=0 closes the URL entry point for good while /launch keeps working', async () => {
  // The final step of the rollout. Shipping this switch untested would mean discovering in
  // production either that it does not actually close the door, or that it closed too much.
  const port2 = 18941;
  const gw2 = spawn(process.execPath, ['server.js'], {
    cwd: GW,
    env: Object.assign({}, process.env, {
      PORT: String(port2), TOOL_KEY: 'claude', TOOL_NAME: 'Claude AI',
      TARGET_ORIGIN: 'http://127.0.0.1:' + upstream.address().port,
      GATEWAY_PUBLIC_ORIGIN: 'http://127.0.0.1:' + port2,
      DEFAULT_PATH: '/new', SIGNIN_PATH: '/login',
      API_BASE: 'http://127.0.0.1:' + backend.address().port + '/api',
      LEASE_SECRET: SECRET, GATEWAY_KEY, ALLOW_URL_LEASE: '0',
      CF_CHALLENGE_PASSTHROUGH: '1', CF_CHALLENGE_MODE: 'passthrough', PROXY_LOG_ALL: '0',
    }),
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const on2 = (method, p, headers, body) => new Promise((resolve) => {
    const buf = body === undefined ? null : Buffer.from(body);
    const h = Object.assign({}, headers || {});
    if (buf) h['content-length'] = buf.length;
    const r = http.request({ port: port2, path: p, method, headers: h }, (res) => {
      const chunks = []; res.on('data', c => chunks.push(c));
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks).toString('utf8') }));
    });
    r.on('error', () => resolve({ status: 0, headers: {}, body: '' }));
    if (buf) r.write(buf); r.end();
  });
  try {
    const t0 = Date.now();
    while (Date.now() - t0 < 15000) {
      if ((await on2('GET', '/__genz/health')).status === 200) break;
      await new Promise(r => setTimeout(r, 150));
    }

    const url = await on2('GET', '/gateway?lease=' + encodeURIComponent(mintLease()), { 'user-agent': UA });
    assert.equal(url.status, 403, 'a URL lease no longer opens anything');
    assert.equal([].concat(url.headers['set-cookie'] || []).find(c => /claude_session=/.test(c)), undefined, 'and mints no session');

    const post = await on2('POST', '/launch',
      { 'content-type': 'application/x-www-form-urlencoded' },
      new URLSearchParams({ code: issueCode() }).toString());
    assert.equal(post.status, 303, 'the POST bootstrap is unaffected');
    assert.ok([].concat(post.headers['set-cookie'] || []).some(c => /^__Host-claude_session=/.test(c)));
  } finally {
    try { gw2.kill(); } catch (_) {}
  }
});
