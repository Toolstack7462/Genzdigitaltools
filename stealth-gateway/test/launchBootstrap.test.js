'use strict';
/**
 * StealthWriter gateway — one-time POST launch bootstrap + opaque session.
 *
 * WHAT THIS PINS
 * StealthWriter had the weakest carrier of the two tools. The lease JWT travelled in
 * `/gateway?lease=<JWT>` (address bar, history, Referer, access logs) and was then stored in
 * `sw_lease` — a cookie that was deliberately NOT HttpOnly, because the injected overlay read
 * it back out to authenticate its own /validate and /consume calls. Any script on the page,
 * and any cookie-editor extension, could lift a working bearer credential.
 *
 * Now: the dashboard POSTs a single-use code; the gateway redeems it server-to-server, keeps
 * the JWT in a server-side store, and gives the browser only an opaque HttpOnly
 * `__Host-stealth_session` id. The overlay calls same-origin /__genz/validate and
 * /__genz/consume, where the cookie is the credential and the server attaches the lease — so
 * metering, limits and reset labels are relayed byte-for-byte and behave exactly as before.
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
    jti: 'j' + crypto.randomBytes(4).toString('hex'), sub: 'u1', scid: 'sc1',
    type: 'stealth_lease', fixed: false, exp: Math.floor(Date.now() / 1000) + 1800,
  }, extra || {}));
  const sig = crypto.createHmac('sha256', SECRET).update(h + '.' + p).digest('base64')
    .replace(/=/g, '').replace(/\+/g, '-').replace(/\//g, '_');
  return h + '.' + p + '.' + sig;
}

let upstream, backend, gw, PORT;
const codes = new Map();
let redeemRequests = [];
let consumeRequests = [];
let upstreamCookieHeaders = [];

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
const postJson = (p, obj, headers) =>
  request('POST', p, Object.assign({ 'content-type': 'application/json' }, headers || {}), JSON.stringify(obj || {}));

function issueCode(leaseExtra) {
  const code = crypto.randomBytes(32).toString('base64url');
  codes.set(code, { lease: mintLease(leaseExtra), spent: false, expired: false });
  return code;
}
const sessionCookieFrom = (res) =>
  [].concat(res.headers['set-cookie'] || []).find(c => /^__Host-stealth_session=/.test(c)) || null;
const allSetCookies = (res) => [].concat(res.headers['set-cookie'] || []);
const cookieValue = (setCookie) => setCookie.split(';')[0];

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/130 Safari/537.36';
const nav = (cookie, p) => request('GET', p || '/dashboard/humanizer', { cookie, accept: 'text/html', 'user-agent': UA });
const isWorking = (r) => /STEALTH_APP_OK/.test(r.body);

test.before(async () => {
  upstream = http.createServer((q, r) => {
    upstreamCookieHeaders.push(q.headers.cookie || '');
    r.writeHead(200, { 'content-type': 'text/html' });
    r.end('<html><head></head><body>STEALTH_APP_OK</body></html>');
  });
  await new Promise(r => upstream.listen(0, r));

  backend = http.createServer((q, r) => {
    let body = '';
    q.on('data', c => { body += c; });
    q.on('end', () => {
      r.setHeader('content-type', 'application/json');
      if (q.url.endsWith('/redeem-launch')) {
        redeemRequests.push({ url: q.url, headers: q.headers, body });
        let parsed = {}; try { parsed = JSON.parse(body || '{}'); } catch (_) {}
        const rec = codes.get(parsed.code);
        if (!rec) { r.statusCode = 400; return r.end(JSON.stringify({ ok: false, code: 'launch_code_invalid' })); }
        if (rec.expired) { codes.delete(parsed.code); r.statusCode = 400; return r.end(JSON.stringify({ ok: false, code: 'launch_code_expired' })); }
        if (rec.spent) { r.statusCode = 400; return r.end(JSON.stringify({ ok: false, code: 'launch_code_used' })); }
        rec.spent = true;
        return r.end(JSON.stringify({ ok: true, lease: rec.lease, capture: false, fixedLease: false, secondsRemaining: 1800 }));
      }
      if (q.url.endsWith('/validate')) {
        return r.end(JSON.stringify({
          valid: true, terminal: false, retryable: false, secondsRemaining: 1800,
          plan: { planName: 'Pro', limits: { humanizer: 50, detector: 20 }, used: { humanizer: 3, detector: 1 }, remaining: { humanizer: 47, detector: 19 } },
          resetLabel: '5:00 AM Pakistan Time',
        }));
      }
      if (q.url.endsWith('/consume')) {
        consumeRequests.push({ auth: q.headers.authorization || '', body });
        return r.end(JSON.stringify({ ok: true, action: 'humanizer', remaining: { humanizer: 46, detector: 19 } }));
      }
      if (q.url.endsWith('/session')) return r.end(JSON.stringify({ ok: true, account: { id: 'acc1', label: 'a***1' }, bundle: { cookies: [{ name: 'sw_session', value: 'VAULT' }] } }));
      r.end('{}');
    });
  });
  await new Promise(r => backend.listen(0, r));

  PORT = 18895;
  gw = spawn(process.execPath, ['server.js'], {
    cwd: GW,
    env: Object.assign({}, process.env, {
      PORT: String(PORT),
      STEALTH_TARGET_ORIGIN: 'http://127.0.0.1:' + upstream.address().port,
      STEALTH_API_BASE: 'http://127.0.0.1:' + backend.address().port + '/api',
      GATEWAY_PUBLIC_ORIGIN: 'http://127.0.0.1:' + PORT,
      STEALTH_LEASE_SECRET: SECRET, STEALTH_GATEWAY_KEY: GATEWAY_KEY,
      STEALTH_DEFAULT_PATH: '/dashboard/humanizer', STEALTH_SIGNIN_PATH: '/sign-in',
    }),
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const t0 = Date.now();
  while (Date.now() - t0 < 15000) {
    const r = await postForm('/launch', {});   // any response proves the port is listening
    if (r.status !== 0) break;
    await new Promise(x => setTimeout(x, 150));
  }
});
test.after(() => {
  try { gw.kill(); } catch (_) {}
  try { upstream.close(); } catch (_) {}
  try { backend.close(); } catch (_) {}
});
test.beforeEach(() => { redeemRequests = []; consumeRequests = []; upstreamCookieHeaders = []; });

// ── Happy path ───────────────────────────────────────────────────────────────

test('POST /launch 303s to a CLEAN url with an opaque HttpOnly __Host-stealth_session', async () => {
  const res = await postForm('/launch', { code: issueCode() }, { 'user-agent': UA });

  assert.equal(res.status, 303, '303 forces a GET follow-up so the POST is never replayed');
  assert.equal(res.headers.location, '/dashboard/humanizer');
  assert.ok(!String(res.headers.location).includes('?'), 'no query string on the landing URL');

  const sc = sessionCookieFrom(res);
  assert.ok(sc, 'sets __Host-stealth_session');
  assert.match(sc, /HttpOnly/i, 'HttpOnly — this is the change that makes the lease unreadable by page script');
  assert.match(sc, /Secure/i);
  assert.match(sc, /SameSite=Lax/i);
  assert.match(sc, /Path=\//);
  assert.ok(!/Domain=/i.test(sc), '__Host- requires host-only: no Domain attribute');

  assert.equal(res.headers['cache-control'], 'no-store');
  assert.equal(res.headers['referrer-policy'], 'no-referrer');
});

test('the readable sw_lease cookie is never issued again — and any stale one is cleared', async () => {
  const res = await postForm('/launch', { code: issueCode() });
  const swLease = allSetCookies(res).find(c => /^sw_lease=/.test(c));
  assert.ok(swLease, 'the legacy cookie is explicitly expired on launch');
  assert.match(swLease, /Max-Age=0/, 'cleared, not set');
  assert.ok(!/sw_lease=ey/.test(swLease), 'and it never carries a JWT value');
});

test('the launch code reaches the backend in a POST BODY, never a query string', async () => {
  const code = issueCode();
  await postForm('/launch', { code });
  assert.equal(redeemRequests.length, 1);
  assert.ok(!redeemRequests[0].url.includes('?'), 'no query string');
  assert.ok(!redeemRequests[0].url.includes(code), 'the code is not in the path');
  assert.equal(JSON.parse(redeemRequests[0].body).code, code, 'it is in the body');
  assert.equal(redeemRequests[0].headers['x-gateway-key'], GATEWAY_KEY);
});

test('the session works and no JWT or code reaches the browser', async () => {
  const code = issueCode();
  const res = await postForm('/launch', { code });
  const page = await nav(cookieValue(sessionCookieFrom(res)));
  assert.ok(isWorking(page), 'the app is proxied');
  assert.ok(!/eyJhbGciOi/.test(page.body), 'no JWT in the delivered page');
  assert.ok(!page.body.includes(code), 'no launch code in the delivered page');
});

// ── The overlay's same-origin API (what replaced the readable cookie) ─────────

test('/__genz/validate answers from the HttpOnly cookie alone and relays the plan payload intact', async () => {
  const res = await postForm('/launch', { code: issueCode() });
  const cookie = cookieValue(sessionCookieFrom(res));

  const v = await postJson('/__genz/validate', {}, { cookie });
  assert.equal(v.status, 200);
  const body = JSON.parse(v.body);
  assert.equal(body.valid, true);
  // The plan/limits/reset payload must survive the relay untouched — this is StealthWriter's
  // metering contract and the overlay renders straight from it.
  assert.equal(body.plan.limits.humanizer, 50);
  assert.equal(body.plan.remaining.detector, 19);
  assert.equal(body.resetLabel, '5:00 AM Pakistan Time');
  assert.equal(v.headers['cache-control'], 'no-store');
});

test('/__genz/consume forwards the action and relays the metering result', async () => {
  const res = await postForm('/launch', { code: issueCode() });
  const cookie = cookieValue(sessionCookieFrom(res));

  const c = await postJson('/__genz/consume', { action: 'humanizer' }, { cookie });
  assert.equal(c.status, 200);
  assert.equal(JSON.parse(c.body).remaining.humanizer, 46, 'usage counting is unchanged');
  assert.equal(consumeRequests.length, 1);
  assert.equal(JSON.parse(consumeRequests[0].body).action, 'humanizer', 'the action is forwarded');
  assert.match(consumeRequests[0].auth, /^Bearer ey/, 'the gateway attaches the lease server-side');
});

test('a caller-supplied lease in the body is IGNORED — the cookie is the only credential', async () => {
  const res = await postForm('/launch', { code: issueCode() });
  const cookie = cookieValue(sessionCookieFrom(res));
  const forged = mintLease({ jti: 'attacker' });

  await postJson('/__genz/consume', { action: 'humanizer', lease: forged }, { cookie });
  assert.equal(consumeRequests.length, 1);
  assert.ok(!consumeRequests[0].body.includes('attacker'), 'a lease field in the body must never be relayed upstream');
  assert.ok(!consumeRequests[0].auth.includes(forged), 'and it must never become the Authorization header');
});

test('the overlay API refuses a request with no session', async () => {
  for (const p of ['/__genz/validate', '/__genz/consume']) {
    const r = await postJson(p, { action: 'humanizer' }, {});
    assert.notEqual(r.status, 200, `${p} must not answer without a session`);
  }
});

test('GET on the overlay API is refused', async () => {
  const res = await postForm('/launch', { code: issueCode() });
  const cookie = cookieValue(sessionCookieFrom(res));
  const r = await request('GET', '/__genz/validate', { cookie });
  assert.equal(r.status, 405);
});

// ── Isolation: our cookies must never leave this origin ──────────────────────

test('the opaque session id is never forwarded upstream to StealthWriter', async () => {
  const res = await postForm('/launch', { code: issueCode() });
  const cookie = cookieValue(sessionCookieFrom(res));
  await nav(cookie);
  assert.ok(upstreamCookieHeaders.length > 0, 'the upstream was reached');
  for (const h of upstreamCookieHeaders) {
    assert.ok(!/__Host-stealth_session/.test(h), 'our session id must never reach stealthwriter.ai');
    assert.ok(!/sw_lease/.test(h), 'nor the legacy lease cookie');
  }
});

// ── Method + input gates ─────────────────────────────────────────────────────

test('GET /launch is refused — a launch is never a URL you can visit', async () => {
  const r = await request('GET', '/launch?code=' + issueCode(), { accept: 'text/html' });
  assert.equal(r.status, 405);
  assert.equal(r.headers.allow, 'POST');
  assert.equal(sessionCookieFrom(r), null);
});

test('a missing or junk code grants nothing', async () => {
  for (const fields of [{}, { code: '' }, { code: 'nope' }]) {
    const r = await postForm('/launch', fields);
    assert.equal(r.status, 403);
    assert.equal(sessionCookieFrom(r), null);
  }
});

// ── Replay, expiry, relaunch ─────────────────────────────────────────────────

test('REPLAY: a used launch code cannot open a second session', async () => {
  const code = issueCode();
  assert.equal((await postForm('/launch', { code })).status, 303);
  for (let i = 0; i < 3; i++) {
    const again = await postForm('/launch', { code });
    assert.equal(again.status, 403);
    assert.equal(sessionCookieFrom(again), null);
  }
});

test('an expired launch code is refused', async () => {
  const code = issueCode();
  codes.get(code).expired = true;
  const r = await postForm('/launch', { code });
  assert.equal(r.status, 403);
  assert.equal(sessionCookieFrom(r), null);
});

test('REFRESH of an expired session stays expired; only a new launch revives it', async () => {
  const dead = await postForm('/launch', { code: issueCode({ exp: Math.floor(Date.now() / 1000) - 60 }) });
  const sc = sessionCookieFrom(dead);
  const cookie = sc ? cookieValue(sc) : '__Host-stealth_session=stale';
  for (let i = 0; i < 3; i++) {
    assert.ok(!isWorking(await nav(cookie)), 'refreshing must not resurrect an expired session');
  }
  const fresh = await postForm('/launch', { code: issueCode() });
  assert.ok(isWorking(await nav(cookieValue(sessionCookieFrom(fresh)))), 'a new authorized launch works');
});

test('a forged session id resolves to nothing', async () => {
  const r = await nav('__Host-stealth_session=' + crypto.randomBytes(32).toString('base64url'));
  assert.ok(!isWorking(r));
});

test('MULTIPLE TABS + CONCURRENT launches each get their own session', async () => {
  const results = await Promise.all(Array.from({ length: 5 }, () => postForm('/launch', { code: issueCode() })));
  const sids = results.map(r => cookieValue(sessionCookieFrom(r)));
  assert.equal(new Set(sids).size, sids.length, 'distinct, unpredictable session ids');
  for (const sid of sids) assert.ok(isWorking(await nav(sid)));
  assert.ok(isWorking(await nav(sids[0])), 'the first tab still works after the others opened');
});

test('a capture lease lands on the sign-in path', async () => {
  const r = await postForm('/launch', { code: issueCode({ cap: true }) });
  assert.equal(r.status, 303);
  assert.equal(r.headers.location, '/sign-in');
});

// ── Rollback switch ──────────────────────────────────────────────────────────

test('the legacy /gateway?lease= path still opens a session while ALLOW_URL_LEASE is on — but as an OPAQUE one', async () => {
  const r = await request('GET', '/gateway?lease=' + encodeURIComponent(mintLease()), { 'user-agent': UA });
  assert.equal(r.status, 302);
  const sc = sessionCookieFrom(r);
  assert.ok(sc, 'the rollback path works without redeploying this gateway');
  assert.match(sc, /HttpOnly/i, 'even the legacy path no longer hands the browser a readable JWT');
  const legacy = allSetCookies(r).find(c => /^sw_lease=/.test(c));
  assert.match(legacy, /Max-Age=0/, 'and it clears any stale readable cookie');
});

test('ALLOW_URL_LEASE=0 closes the URL entry point for good while /launch keeps working', async () => {
  // The final step of the rollout — verified here rather than in production.
  const port2 = 18896;
  const gw2 = spawn(process.execPath, ['server.js'], {
    cwd: GW,
    env: Object.assign({}, process.env, {
      PORT: String(port2),
      STEALTH_TARGET_ORIGIN: 'http://127.0.0.1:' + upstream.address().port,
      STEALTH_API_BASE: 'http://127.0.0.1:' + backend.address().port + '/api',
      GATEWAY_PUBLIC_ORIGIN: 'http://127.0.0.1:' + port2,
      STEALTH_LEASE_SECRET: SECRET, STEALTH_GATEWAY_KEY: GATEWAY_KEY,
      STEALTH_DEFAULT_PATH: '/dashboard/humanizer', STEALTH_SIGNIN_PATH: '/sign-in',
      ALLOW_URL_LEASE: '0',
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
      const probe = await on2('POST', '/launch', { 'content-type': 'application/x-www-form-urlencoded' }, '');
      if (probe.status !== 0) break;
      await new Promise(r => setTimeout(r, 150));
    }

    const url = await on2('GET', '/gateway?lease=' + encodeURIComponent(mintLease()), { 'user-agent': UA });
    assert.equal(url.status, 403, 'a URL lease no longer opens anything');
    assert.equal([].concat(url.headers['set-cookie'] || []).find(c => /stealth_session=/.test(c)), undefined, 'and mints no session');

    const post = await on2('POST', '/launch',
      { 'content-type': 'application/x-www-form-urlencoded' },
      new URLSearchParams({ code: issueCode() }).toString());
    assert.equal(post.status, 303, 'the POST bootstrap is unaffected');
    assert.ok([].concat(post.headers['set-cookie'] || []).some(c => /^__Host-stealth_session=/.test(c)));
  } finally {
    try { gw2.kill(); } catch (_) {}
  }
});
