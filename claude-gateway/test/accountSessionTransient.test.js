'use strict';
/**
 * Claude: a TRANSIENT failure of the account-vault fetch must never end the session.
 *
 * ROOT CAUSE this pins. The lease/validate path was taught to separate a CONFIRMED
 * authorization denial from a transient infrastructure failure, but the OTHER backend call every
 * navigation makes — POST {API_BASE}/session, which fetches the vault account bundle — was not.
 * getSession() collapsed every response that was not a recognised success into
 * `{ blocked: true, code }`, and the request handler renders `session.blocked` as the 403
 * "<tool> session ended" page. So:
 *
 *   • 429  (the backend's apiLimiter — `{ error: '…', code: 'rate_limited' }`, and the gateway's
 *           server-to-server calls all key to ONE stable IP, so the shared 100/15min budget is
 *           exhausted by ordinary polling)                       → 403 "session ended"
 *   • 500  (`{ ok: false, code: 'server_error' }`)               → 403 "session ended"
 *   • 503  (`{ ok: false, code: 'vault_unconfigured' }`)         → 403 "session ended"
 *   • 200 with a malformed/empty body                            → 403 "session ended"
 *
 * and because none of those codes exists in sendBlockPage's message map, every one of them
 * renders the generic "Access could not be verified." — the exact screen clients report, on
 * desktop, laptop and incognito alike, while the lease and the vault account are both fine.
 * The blocked verdict is also cached for 60s, so a refresh repeats it.
 *
 * These tests are device-independent on purpose: the condition has nothing to do with mobile.
 * The final two tests pin the other half of the contract — a CONFIRMED dead/blocked vault
 * account must still stop the session — so the fix cannot become a blanket fail-open.
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
  const p = b64({ jti: 'asjti' + crypto.randomBytes(4).toString('hex'), sub: 'u1', tool: 'claude', type: 'proxy_lease', exp: Math.floor(Date.now() / 1000) + 1800 });
  const sig = crypto.createHmac('sha256', SECRET).update(h + '.' + p).digest('base64').replace(/=/g, '').replace(/\+/g, '-').replace(/\//g, '_');
  return h + '.' + p + '.' + sig;
}
const UA_DESKTOP = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36';
const UA_ANDROID = 'Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Mobile Safari/537.36';

// The mock backend's /session answer, swapped per test. Each entry mirrors a real production
// response: the first four are transient, the last two are confirmed denials.
const SESSION_REPLIES = {
  ok:        { status: 200, body: { ok: true, account: { id: 'acc1', label: 'a***1' }, bundle: { cookies: [{ name: 'sessionKey', value: 'VAULT_SECRET' }] } } },
  // express-rate-limit v7 serialises apiLimiter's `message` object as the 429 body.
  rate:      { status: 429, body: { error: 'Too many requests from this IP. Please try again later.', code: 'rate_limited' } },
  server:    { status: 500, body: { ok: false, code: 'server_error' } },
  unconf:    { status: 503, body: { ok: false, code: 'vault_unconfigured' } },
  malformed: { status: 200, raw: 'not json at all' },
  noSession: { status: 200, body: { ok: false, blocked: true, code: 'account_no_session' } },
  blocked:   { status: 200, body: { ok: false, blocked: true, code: 'account_blocked' } },
};
let sessionMode = 'ok';
let sessionCalls = 0;

let proc, upstream, backend, GW_PORT;

test.before(async () => {
  backend = http.createServer((q, r) => {
    let body = ''; q.on('data', c => body += c);
    q.on('end', () => {
      r.setHeader('content-type', 'application/json');
      if (q.url.endsWith('/session')) {
        sessionCalls += 1;
        const m = SESSION_REPLIES[sessionMode];
        r.writeHead(m.status, { 'content-type': 'application/json' });
        return r.end(m.raw != null ? m.raw : JSON.stringify(m.body));
      }
      // The LEASE is valid throughout — this is the whole point. Only the vault fetch fails.
      if (q.url.endsWith('/validate')) {
        return r.end(JSON.stringify({
          valid: true, terminal: false, retryable: false, code: null,
          secondsRemaining: 1800,
          expiresAt: new Date(Date.now() + 1800000).toISOString(),
          serverTime: new Date().toISOString(),
        }));
      }
      if (q.url.endsWith('/quota-status')) return r.end(JSON.stringify({ ok: true, enabled: false }));
      r.end('{}');
    });
  });
  await new Promise((res) => backend.listen(0, res));
  const bePort = backend.address().port;

  upstream = http.createServer((q, r) => {
    r.writeHead(200, { 'content-type': 'text/html' });
    r.end('<html><head></head><body>CLAUDE_APP_OK</body></html>');
  });
  await new Promise((res) => upstream.listen(0, res));
  const upPort = upstream.address().port;

  // Fixed ports are shared across this suite's files — 18870/18871 belong to durableSession.test.js.
  GW_PORT = 18877;
  const env = Object.assign({}, process.env, {
    PORT: String(GW_PORT), TOOL_KEY: 'claude', TOOL_NAME: 'Claude AI',
    TARGET_ORIGIN: 'http://127.0.0.1:' + upPort,
    GATEWAY_PUBLIC_ORIGIN: 'http://127.0.0.1:' + GW_PORT, DEFAULT_PATH: '/new', SIGNIN_PATH: '/login',
    API_BASE: 'http://127.0.0.1:' + bePort + '/api', LEASE_SECRET: SECRET, GATEWAY_KEY: 'k'.repeat(32),
    CF_CHALLENGE_PASSTHROUGH: '1', CF_CHALLENGE_MODE: 'passthrough',
    IDENTITY_SHIELD: '0', PROXY_LOG_ALL: '0',
    // Short serving TTL so a test can reach the stale-if-error path without waiting a minute.
    // The grace window (how long a known-good bundle stays reusable) is left generous.
    CLAUDE_SESSION_TTL_MS: '250', CLAUDE_SESSION_GRACE_MS: '600000',
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

// A fresh lease per test → a fresh jti → never a cached account-session verdict from another test.
async function openSession(ua) {
  const lease = mintLease();
  const r = await get('/gateway?lease=' + encodeURIComponent(lease), { 'user-agent': ua || UA_DESKTOP });
  const sc = [].concat(r.headers['set-cookie'] || []).find(c => /claude_session=/.test(c));
  assert.ok(sc, 'lease exchange must set an opaque session cookie');
  return sc.split(';')[0];
}
const nav = (sess, ua) => get('/new', { cookie: sess, 'user-agent': ua || UA_DESKTOP, accept: 'text/html,application/xhtml+xml' });

// A transient vault-fetch failure must not produce the terminal page, must not kill the opaque
// session cookie, and must leave the client somewhere it can recover from.
// Matched STRUCTURALLY (title + heading), because the overlay injected into a healthy app page
// legitimately carries both of these strings inside its own message table.
function assertNotTerminal(r, what) {
  const seen = `[${r.status}] ${String(r.body).replace(/\s+/g, ' ').slice(0, 200)}`;
  assert.ok(!/<title>Session ended<\/title>/i.test(r.body), `${what}: must NOT be the "session ended" page — got ${seen}`);
  assert.ok(!/<h1>[^<]*session ended<\/h1>/i.test(r.body), `${what}: must NOT show the session-ended heading — got ${seen}`);
  assert.ok(!/<p>Access could not be verified[^<]*<\/p>/i.test(r.body), `${what}: must NOT show the generic "Access could not be verified" message`);
  assert.notStrictEqual(r.status, 403, `${what}: 403 is the terminal block status`);
  const sc = [].concat(r.headers['set-cookie'] || []).join('|');
  assert.ok(!/claude_session=;/.test(sc), `${what}: the opaque session cookie must survive`);
  assert.ok(!/clear-site-data/i.test(Object.keys(r.headers).join(',')), `${what}: nothing may be cleared`);
}

test('vault fetch 429 (backend apiLimiter) on a desktop nav: session survives, no terminal page', async () => {
  const sess = await openSession();
  sessionMode = 'rate';
  const r = await nav(sess);
  assertNotTerminal(r, '429 rate_limited');
});

test('vault fetch 500 server_error on a desktop nav: session survives, no terminal page', async () => {
  const sess = await openSession();
  sessionMode = 'server';
  const r = await nav(sess);
  assertNotTerminal(r, '500 server_error');
});

test('vault fetch 503 vault_unconfigured on a desktop nav: session survives, no terminal page', async () => {
  const sess = await openSession();
  sessionMode = 'unconf';
  const r = await nav(sess);
  assertNotTerminal(r, '503 vault_unconfigured');
});

test('vault fetch 200 with a malformed body: session survives, no terminal page', async () => {
  const sess = await openSession();
  sessionMode = 'malformed';
  const r = await nav(sess);
  assertNotTerminal(r, '200 malformed');
});

test('incognito: a FRESH authorized launch during the same 429 must not open onto the terminal page', async () => {
  sessionMode = 'rate';
  const sess = await openSession();          // a brand-new lease + brand-new opaque session
  const r = await nav(sess);
  assertNotTerminal(r, 'fresh lease during 429');
});

test('mobile is not regressed by the same transient failure', async () => {
  const sess = await openSession(UA_ANDROID);
  sessionMode = 'rate';
  const r = await nav(sess, UA_ANDROID);
  assertNotTerminal(r, '429 on mobile');
});

test('a transient failure recovers on its own once the backend answers again', async () => {
  const sess = await openSession();
  sessionMode = 'rate';
  await nav(sess);
  sessionMode = 'ok';
  const r = await nav(sess);
  assert.strictEqual(r.status, 200, 'the app loads again with no client action');
  assert.match(r.body, /CLAUDE_APP_OK/, 'the real app document is served');
});

// THE PRODUCTION CASE: a client who has been working for a while already has a known-good bundle
// for this lease, so a backend blip must be completely invisible to them — the page keeps working.
test('an ALREADY-WORKING session rides through the 429 on its last known-good bundle', async () => {
  const sess = await openSession();
  sessionMode = 'ok';
  const first = await nav(sess);
  assert.strictEqual(first.status, 200, 'the session is established and working');
  await new Promise(r => setTimeout(r, 400));      // let the short serving TTL lapse
  sessionMode = 'rate';
  const during = await nav(sess);
  assertNotTerminal(during, 'stale-if-error');
  assert.strictEqual(during.status, 200, 'the app keeps loading — the client sees nothing at all');
  assert.match(during.body, /CLAUDE_APP_OK/, 'served with the bundle this lease already had');
  // And it self-clears: no failure was cached, so the next call re-checks for real.
  sessionMode = 'ok';
  await new Promise(r => setTimeout(r, 400));
  const after = await nav(sess);
  assert.strictEqual(after.status, 200, 'back to normal with no client action');
});

// A late failure must not be able to overwrite a good verdict a newer response already stored.
// Concurrent requests for ONE lease share a single round-trip, exactly as /validate already does.
test('concurrent requests for one lease share ONE vault fetch (no last-writer-wins race)', async () => {
  const sess = await openSession();
  sessionMode = 'ok';
  const before = sessionCalls;
  const rs = await Promise.all([nav(sess), nav(sess), nav(sess), nav(sess), nav(sess)]);
  assert.ok(rs.every(r => r.status === 200), 'all five load the app');
  assert.equal(sessionCalls - before, 1, 'five simultaneous requests, one backend /session call');
});

// A background fetch must never receive an HTML error document: reacting to one is what makes an
// SPA navigate the whole tab, which is how a transient failure became a full-page terminal screen.
test('a background fetch gets a non-navigating retryable 503 JSON, never an HTML page', async () => {
  const sess = await openSession();
  sessionMode = 'rate';
  const r = await req('GET', '/api/organizations', { cookie: sess, 'user-agent': UA_DESKTOP, accept: 'application/json' });
  assert.strictEqual(r.status, 503, 'transient, retryable');
  assert.match(String(r.headers['content-type'] || ''), /application\/json/, 'JSON, not a document');
  assert.ok(!/<html/i.test(r.body), 'no HTML error document reaches the app');
  assert.match(r.body, /"retryable":true/, 'and it says so machine-readably');
});

// ── The other half of the contract: a CONFIRMED dead vault account still stops the session ──
test('CONFIRMED account_no_session still blocks (this must not become a fail-open)', async () => {
  const sess = await openSession();
  sessionMode = 'noSession';
  const r = await nav(sess);
  assert.strictEqual(r.status, 403, 'a confirmed dead vault session is terminal');
  assert.match(r.body, /session ended/i, 'the block page is still shown');
  assert.ok(!/could not be verified/i.test(r.body),
    'and it names the real condition rather than the generic message');
});

test('CONFIRMED account_blocked still blocks', async () => {
  const sess = await openSession();
  sessionMode = 'blocked';
  const r = await nav(sess);
  assert.strictEqual(r.status, 403, 'a blocked account is terminal');
  assert.match(r.body, /session ended/i, 'the block page is still shown');
});

test('a terminal LEASE denial is unaffected by any of this', async () => {
  const sess = await openSession();
  sessionMode = 'ok';
  void sess;
  const r = await get('/new', { cookie: 'bogus=1', 'user-agent': UA_DESKTOP, accept: 'text/html' });
  assert.strictEqual(r.status, 403, 'no session cookie → still blocked');
  assert.match(r.body, /No active session|session ended/i, 'the lease_missing page');
  assert.ok(sessionCalls >= 1, 'sanity: the mock vault endpoint was exercised');
});
