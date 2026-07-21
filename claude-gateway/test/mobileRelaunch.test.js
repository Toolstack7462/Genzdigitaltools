'use strict';
/**
 * Mobile session-renewal fix (CLAUDE ONLY).
 *
 * THE BUG: on a phone, once the 30-minute session expired, reopening Claude from the
 * dashboard kept showing the "session complete/expired" screen — through refreshes, new
 * tabs and browser restarts. Desktop was fine. Three things kept the dead state alive on
 * mobile, and this file covers the server half of the fix:
 *
 *  1. A service worker registered by the proxied app is scoped to the GATEWAY origin and
 *     replays its cached "session ended" document for later navigations — including the
 *     /gateway?lease=<NEW> launch itself, so the fresh session cookie was never set and no
 *     server-side change could dislodge it. Cache Storage also survives clearing cookies.
 *  2. POST /__genz/validate fell through to the HTML block page when the opaque session was
 *     gone. `fetch(...).json()` cannot read that, so the overlay classified a finished
 *     session as a transient network fault and sat on "Connection interrupted — retrying…".
 *  3. The valid response dropped `expiresAt`/`serverTime`, so a resumed tab had no absolute
 *     server deadline to re-anchor its countdown to.
 *
 * Everything here must hold for desktop exactly as before — asserted explicitly.
 */
const test = require('node:test');
const assert = require('node:assert');
const http = require('http');
const crypto = require('crypto');
const path = require('path');
const { spawn } = require('node:child_process');

const GW = path.resolve(__dirname, '..');
const SECRET = 'x'.repeat(48);
const PORT = 18890;

const ANDROID = 'Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Mobile Safari/537.36';
const IPHONE = 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1';
const DESKTOP = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36';

const b64 = (o) => Buffer.from(JSON.stringify(o)).toString('base64url');
function mintLease(ttlSec) {
  const h = b64({ alg: 'HS256', typ: 'JWT' });
  const p = b64({
    jti: 'j' + crypto.randomBytes(6).toString('hex'), sub: 'u1', tool: 'claude',
    type: 'proxy_lease', exp: Math.floor(Date.now() / 1000) + ttlSec,
  });
  const sig = crypto.createHmac('sha256', SECRET).update(h + '.' + p).digest('base64')
    .replace(/=/g, '').replace(/\+/g, '-').replace(/\//g, '_');
  return h + '.' + p + '.' + sig;
}

function reqTo(method, p, headers) {
  return new Promise((resolve) => {
    const r = http.request({ port: PORT, path: p, method, headers: headers || {} }, (res) => {
      const b = []; res.on('data', c => b.push(c));
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(b).toString('utf8') }));
    });
    r.on('error', () => resolve({ status: 0, headers: {}, body: '' }));
    r.end();
  });
}

/** A browser cookie jar: last Set-Cookie for a name wins, Max-Age=0 deletes. */
function jar() {
  const m = new Map();
  return {
    apply(setCookie) {
      for (const c of [].concat(setCookie || [])) {
        const first = c.split(';')[0];
        const i = first.indexOf('=');
        const name = first.slice(0, i).trim(), val = first.slice(i + 1);
        if (/max-age=0/i.test(c) || val === '') m.delete(name); else m.set(name, val);
      }
    },
    header() { return [...m].map(([k, v]) => k + '=' + v).join('; '); },
    get(n) { return m.get(n); },
  };
}

let upstream, backend, gw;

/** Backend stand-in that answers from the lease JWT's own `exp`, like the real one. */
function startBackend() {
  return http.createServer((q, r) => {
    let body = ''; q.on('data', c => body += c);
    q.on('end', () => {
      r.setHeader('content-type', 'application/json');
      const auth = String(q.headers.authorization || '').replace(/^Bearer /, '');
      let payload = null;
      try { payload = JSON.parse(Buffer.from(auth.split('.')[1], 'base64url').toString()); } catch (_) {}
      if (q.url.endsWith('/validate')) {
        if (!payload) return r.end(JSON.stringify({ valid: false, terminal: true, retryable: false, code: 'lease_invalid' }));
        const expMs = payload.exp * 1000;
        if (Date.now() > expMs) return r.end(JSON.stringify({ valid: false, terminal: true, retryable: false, code: 'lease_expired' }));
        return r.end(JSON.stringify({
          valid: true, terminal: false, retryable: false, code: null,
          secondsRemaining: Math.floor((expMs - Date.now()) / 1000),
          expiresAt: new Date(expMs).toISOString(), serverTime: new Date().toISOString(),
        }));
      }
      if (q.url.endsWith('/session')) {
        return r.end(JSON.stringify({ ok: true, account: { id: 'acc1', label: 'a***1' }, bundle: { cookies: [{ name: 'sessionKey', value: 'VAULT' }] } }));
      }
      r.end('{}');
    });
  });
}

test.before(async () => {
  upstream = http.createServer((q, r) => {
    r.writeHead(200, { 'content-type': 'text/html' });
    r.end('<html><head></head><body>CLAUDE_APP_OK</body></html>');
  });
  await new Promise(r => upstream.listen(0, r));
  backend = startBackend();
  await new Promise(r => backend.listen(0, r));

  gw = spawn(process.execPath, ['server.js'], {
    cwd: GW, stdio: ['ignore', 'pipe', 'pipe'],
    env: Object.assign({}, process.env, {
      PORT: String(PORT), TOOL_KEY: 'claude', TOOL_NAME: 'Claude AI',
      TARGET_ORIGIN: 'http://127.0.0.1:' + upstream.address().port,
      GATEWAY_PUBLIC_ORIGIN: 'http://127.0.0.1:' + PORT, DEFAULT_PATH: '/new', SIGNIN_PATH: '/login',
      API_BASE: 'http://127.0.0.1:' + backend.address().port + '/api',
      LEASE_SECRET: SECRET, GATEWAY_KEY: 'k'.repeat(32),
      CF_CHALLENGE_PASSTHROUGH: '1', CF_CHALLENGE_MODE: 'passthrough', PROXY_LOG_ALL: '0',
      CLAUDE_VALIDATE_CACHE_MS: '0',   // assert on real verdicts, never a cached one
    }),
  });
  const t0 = Date.now();
  while (Date.now() - t0 < 15000) {
    if ((await reqTo('GET', '/__genz/health')).status === 200) return;
    await new Promise(r => setTimeout(r, 150));
  }
  throw new Error('gateway did not boot');
});
test.after(() => {
  try { gw.kill(); } catch (_) {}
  try { upstream.close(); } catch (_) {}
  try { backend.close(); } catch (_) {}
});

/** Launch from the dashboard on a given device; returns the cookie jar. */
async function launch(ua, ttlSec, existingJar) {
  const J = existingJar || jar();
  const r = await reqTo('GET', '/gateway?lease=' + encodeURIComponent(mintLease(ttlSec)), { 'user-agent': ua, cookie: J.header() });
  J.apply(r.headers['set-cookie']);
  return { J, r };
}
const nav = (J, ua) => reqTo('GET', '/new', { cookie: J.header(), accept: 'text/html', 'user-agent': ua });
const validate = (J, ua) => reqTo('POST', '/__genz/validate', { cookie: J.header(), 'user-agent': ua, 'content-type': 'application/json' });
const isApp = (r) => /CLAUDE_APP_OK/.test(r.body);

// ── 1. Service workers can never take over the gateway origin ────────────────
test('a service-worker script is refused, so it can never replay a cached page', async () => {
  for (const p of ['/sw.js', '/service-worker.js', '/serviceworker.js', '/workbox-a1b2c3d4.js', '/firebase-messaging-sw.js']) {
    const r = await reqTo('GET', p, { 'user-agent': ANDROID });
    assert.strictEqual(r.status, 404, p + ' must not be served');
    assert.strictEqual(r.headers['cache-control'], 'no-store', p + ' must not be cacheable');
  }
});

test('a worker request is refused by intent too, whatever the script is named', async () => {
  const byDest = await reqTo('GET', '/assets/some-bundle.js', { 'user-agent': ANDROID, 'sec-fetch-dest': 'serviceworker' });
  assert.strictEqual(byDest.status, 404, 'Sec-Fetch-Dest: serviceworker must be refused');
  // An installed worker's update check gets a 404, which makes the browser drop it.
  const update = await reqTo('GET', '/custom-worker.js', { 'user-agent': ANDROID, 'service-worker': 'script' });
  assert.strictEqual(update.status, 404, 'a worker update check must 404 so the registration is dropped');
});

test('ordinary scripts are still proxied normally (the block is narrow)', async () => {
  const { J } = await launch(ANDROID, 1800);
  const r = await reqTo('GET', '/static/app.js', { cookie: J.header(), 'user-agent': ANDROID });
  assert.notStrictEqual(r.status, 404, 'a normal .js asset must not be caught by the worker block');
});

// ── 2. The overlay's endpoints always answer in JSON ─────────────────────────
test('validate with no session answers a terminal JSON verdict, never an HTML page', async () => {
  const r = await reqTo('POST', '/__genz/validate', { 'user-agent': ANDROID, 'content-type': 'application/json' });
  assert.strictEqual(r.status, 200);
  assert.match(String(r.headers['content-type']), /application\/json/);
  const body = JSON.parse(r.body);
  assert.strictEqual(body.valid, false);
  assert.strictEqual(body.terminal, true, 'a finished session must be terminal, not "retrying…"');
  assert.strictEqual(body.retryable, false);
  assert.strictEqual(body.code, 'lease_missing');
  assert.ok([].concat(r.headers['set-cookie'] || []).some(c => /claude_session=;/.test(c)), 'the dead opaque cookie is expired');
});

test('the usage endpoint also stays JSON with no session', async () => {
  const r = await reqTo('POST', '/__genz/usage', { 'user-agent': ANDROID, 'content-type': 'application/json' });
  assert.strictEqual(r.status, 200);
  assert.strictEqual(JSON.parse(r.body).synced, false);
});

// ── 3. The countdown gets an absolute server deadline to anchor to ───────────
test('a valid validate carries expiresAt + serverTime, not just a relative count', async () => {
  const { J } = await launch(ANDROID, 1800);
  const body = JSON.parse((await validate(J, ANDROID)).body);
  assert.strictEqual(body.valid, true);
  assert.ok(body.expiresAt, 'expiresAt must be relayed so a resumed tab can re-anchor');
  assert.ok(body.serverTime, 'serverTime must be relayed so a wrong device clock self-corrects');
  const remaining = Date.parse(body.expiresAt) - Date.parse(body.serverTime);
  assert.ok(remaining > 1700000 && remaining <= 1800000, 'expiry is ~30 minutes out, got ms=' + remaining);
  assert.ok(body.secondsRemaining > 1700);
});

// ── 4. The block page dismantles the replay machinery ────────────────────────
test('an ended-session page clears workers, caches and storage on its way out', async () => {
  const expired = await nav(jar(), ANDROID);          // no cookie at all → lease_missing
  assert.strictEqual(expired.status, 403);
  assert.match(expired.body, /unregister\(\)/, 'must unregister service workers');
  assert.match(expired.body, /caches\.delete/, 'must empty Cache Storage');
  assert.match(expired.body, /localStorage\.clear\(\)/, 'must clear localStorage');
  assert.match(expired.body, /sessionStorage\.clear\(\)/, 'must clear sessionStorage');
  assert.strictEqual(expired.headers['clear-site-data'], '"cache", "storage"');
  assert.strictEqual(expired.headers['cache-control'], 'no-store');
  assert.ok(!/"cookies"/.test(String(expired.headers['clear-site-data'])),
    'cookies must NOT be cleared — that would drop this device\'s Cloudflare clearance');
});

// ── 5. The actual reported journey, per device ───────────────────────────────
for (const [name, ua] of [['Android Chrome', ANDROID], ['iPhone Safari', IPHONE], ['Desktop (must be unchanged)', DESKTOP]]) {
  test(name + ': expire → relaunch from the dashboard → a fresh 30-minute session', async () => {
    // A short session, used and then allowed to run out.
    const { J } = await launch(ua, 2);
    const firstSid = J.get('__Host-claude_session');
    assert.ok(firstSid, 'launch installs the opaque session');
    assert.ok(isApp(await nav(J, ua)), 'the tool works while the lease is live');

    await new Promise(r => setTimeout(r, 2600));

    // Expired: the page is blocked and the widget is told, in JSON, that it is over.
    assert.strictEqual((await nav(J, ua)).status, 403, 'an expired lease is blocked');
    const dead = JSON.parse((await validate(J, ua)).body);
    assert.strictEqual(dead.valid, false);
    assert.strictEqual(dead.terminal, true);

    // REFRESH ALONE MUST NOT RENEW — no matter how many times.
    for (let i = 0; i < 3; i++) {
      assert.strictEqual((await nav(J, ua)).status, 403, 'refresh #' + i + ' must not renew access');
    }

    // The authorized dashboard launch — the only thing that may renew.
    const relaunch = await launch(ua, 1800, J);
    assert.strictEqual(relaunch.r.status, 302);
    const newSid = J.get('__Host-claude_session');
    assert.ok(newSid, 'a fresh opaque session is installed');
    assert.notStrictEqual(newSid, firstSid, 'the expired session id must be replaced, never reused');

    assert.ok(isApp(await nav(J, ua)), 'the tool loads again');
    const fresh = JSON.parse((await validate(J, ua)).body);
    assert.strictEqual(fresh.valid, true, 'the widget is told the session is live again');
    assert.ok(fresh.secondsRemaining > 1700, 'a full new 30 minutes, got ' + fresh.secondsRemaining);
    assert.ok(fresh.expiresAt, 'anchored to the new server-issued expiry');

    // A new tab and a browser restart both reuse the same cookie jar / a fresh one.
    assert.ok(isApp(await nav(J, ua)), 'new tab on the fresh session works');
    const restarted = jar();                       // session cookie gone after a real restart
    assert.strictEqual((await nav(restarted, ua)).status, 403, 'a restart without a launch grants nothing');
  });
}

test('the old session is not resurrected once a new one is issued', async () => {
  const { J } = await launch(ANDROID, 1800);
  const oldSid = J.get('__Host-claude_session');
  await launch(ANDROID, 1800, J);                  // relaunch from the dashboard
  const newSid = J.get('__Host-claude_session');
  assert.notStrictEqual(newSid, oldSid);

  // The browser now presents only the new id; presenting the OLD one must still resolve to
  // that old lease and nothing else — it can never become the new session.
  const stale = jar(); stale.apply(['__Host-claude_session=' + oldSid]);
  const r = JSON.parse((await validate(stale, ANDROID)).body);
  assert.ok(r.valid === true || r.terminal === true, 'the old id resolves to its own lease or to a denial');
  const fresh = JSON.parse((await validate(J, ANDROID)).body);
  assert.strictEqual(fresh.valid, true, 'the new session is unaffected by the old one');
});
