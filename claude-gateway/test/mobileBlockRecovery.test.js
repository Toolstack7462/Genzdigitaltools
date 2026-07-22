'use strict';
/**
 * Claude mobile "expired screen persists after a dashboard relaunch" fix.
 *
 * ROOT CAUSE: on a phone, reopening from the dashboard resurfaces the EXISTING tab showing the
 * expired block page instead of building a fresh document (desktop uses a real new tab, so never
 * sees it). The block page carried no overlay and no recovery, so it never noticed that an
 * authorized relaunch had installed a fresh __Host-claude_session cookie → "session ended" forever.
 *
 * FIX (server.js sendBlockPage, claude only): a resume-only re-check that asks /__genz/validate and,
 * ONLY if the backend independently says valid:true (which needs the fresh relaunch cookie), replaces
 * the page with the app. A plain refresh installs no new cookie → stays expired.
 *
 * These tests boot the REAL gateway and prove BOTH the markup and the underlying contract:
 *  1) the claude block page carries the recovery re-check (and a non-claude tool does NOT);
 *  2) with NO / an expired session cookie, /__genz/validate says valid:false → the page stays
 *     expired (a refresh cannot renew);
 *  3) after a dashboard relaunch (/gateway?lease=NEW installs a fresh cookie), /__genz/validate says
 *     valid:true → the recovery would navigate to the app — i.e. only a relaunch renews.
 * Also re-asserts the Cloudflare fix is intact (mobile rides the vault clearance).
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
  const p = b64({ jti: 'jti' + crypto.randomBytes(4).toString('hex'), sub: 'u1', tool: 'claude', type: 'proxy_lease', exp: Math.floor(Date.now() / 1000) + 1800 });
  const sig = crypto.createHmac('sha256', SECRET).update(h + '.' + p).digest('base64').replace(/=/g, '').replace(/\+/g, '-').replace(/\//g, '_');
  return h + '.' + p + '.' + sig;
}

let upstream, backend;
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
function bootGateway(port, envOverride) {
  const env = Object.assign({}, process.env, {
    PORT: String(port), TOOL_KEY: 'claude', TOOL_NAME: 'Claude AI',
    TARGET_ORIGIN: 'http://127.0.0.1:' + upstream.address().port,
    GATEWAY_PUBLIC_ORIGIN: 'http://127.0.0.1:' + port, DEFAULT_PATH: '/new', SIGNIN_PATH: '/login',
    API_BASE: 'http://127.0.0.1:' + backend.address().port + '/api',
    LEASE_SECRET: SECRET, GATEWAY_KEY: 'k'.repeat(32), PROXY_LOG_ALL: '0',
    CF_CHALLENGE_PASSTHROUGH: '1', CF_CHALLENGE_MODE: 'passthrough',
  }, envOverride || {});
  return spawn(process.execPath, ['server.js'], { cwd: GW, env, stdio: ['ignore', 'pipe', 'pipe'] });
}
async function waitHealth(port) {
  const t0 = Date.now();
  while (Date.now() - t0 < 15000) { if ((await reqTo(port, 'GET', '/__genz/health')).status === 200) return; await new Promise(r => setTimeout(r, 150)); }
  throw new Error('gateway ' + port + ' did not boot');
}
function sessionCookieFrom(res) {
  const sc = [].concat(res.headers['set-cookie'] || []).find(c => /claude_session=/.test(c));
  return sc ? sc.split(';')[0] : null;
}

test.before(async () => {
  upstream = http.createServer((q, r) => { r.writeHead(200, { 'content-type': 'text/html' }); r.end('<html><head></head><body>CLAUDE_APP_OK</body></html>'); });
  backend = http.createServer((q, r) => {
    let body = ''; q.on('data', c => body += c);
    q.on('end', () => {
      r.setHeader('content-type', 'application/json');
      if (q.url.endsWith('/session')) return r.end(JSON.stringify({ ok: true, account: { id: 'a1', label: 'Account 1' }, bundle: { cookies: [{ name: 'sessionKey', value: 'V' }] } }));
      if (q.url.endsWith('/validate')) return r.end(JSON.stringify({ valid: true, secondsRemaining: 1800, expiresAt: new Date(Date.now() + 1800000).toISOString(), serverTime: new Date().toISOString() }));
      r.end('{}');
    });
  });
  await new Promise(r => upstream.listen(0, r));
  await new Promise(r => backend.listen(0, r));
});
test.after(() => { try { upstream.close(); } catch (_) {} try { backend.close(); } catch (_) {} });

test('the claude expired block page carries the mobile resume-recovery re-check', async () => {
  const PORT = 3711; const gw = bootGateway(PORT);
  try {
    await waitHealth(PORT);
    // A top-level HTML nav with NO session cookie is the expired/dead state → the block page.
    const r = await reqTo(PORT, 'GET', '/new', { accept: 'text/html' });
    assert.strictEqual(r.status, 403, 'no session → the block page');
    assert.match(r.body, /session ended/i, 'it is the ended-session page');
    // The recovery re-check: polls the SAME validate endpoint, on resume events, and navigates to the app.
    assert.match(r.body, /__genz\/validate/, 'block page re-checks the server');
    assert.match(r.body, /location\.replace/, 'and navigates to the app when a valid session appears');
    assert.match(r.body, /visibilitychange/, 'driven by resume events (tab re-shown)');
    assert.match(r.body, /pageshow/, 'and bfcache/back-forward restores');
    assert.match(r.body, /"\/new"/, 'target is DEFAULT_PATH (/new)');
    // Crucially it must NOT auto-recover on first paint (only resume events) — no bare onload redirect.
    assert.ok(!/onload\s*=\s*["']?location/.test(r.body), 'never redirects on initial load (a genuine expiry stays expired)');
  } finally { gw.kill(); }
});

test('a NON-claude tool block page does NOT get the claude recovery (isolation)', async () => {
  const PORT = 3712; const gw = bootGateway(PORT, { TOOL_KEY: 'hix', TOOL_NAME: 'Hix' });
  try {
    await waitHealth(PORT);
    const r = await reqTo(PORT, 'GET', '/new', { accept: 'text/html' });
    assert.strictEqual(r.status, 403);
    assert.ok(!/__genz\/validate/.test(r.body), 'the recovery re-check is claude-only');
  } finally { gw.kill(); }
});

test('CONTRACT: a refresh (no new cookie) stays expired; only a dashboard relaunch renews', async () => {
  const PORT = 3713; const gw = bootGateway(PORT);
  try {
    await waitHealth(PORT);
    // (a) The recovery re-check with NO session cookie — i.e. a plain refresh of the expired page —
    //     must resolve to valid:false so the page stays expired. A page cannot renew itself.
    const refresh = await reqTo(PORT, 'POST', '/__genz/validate', { 'content-type': 'application/json' });
    const rb = JSON.parse(refresh.body);
    assert.strictEqual(rb.valid, false, 'no cookie → not valid → block page stays expired');

    // (b) An authorized dashboard relaunch mints a FRESH lease → fresh __Host-claude_session cookie.
    const relaunch = await reqTo(PORT, 'GET', '/gateway?lease=' + encodeURIComponent(mintLease()), { 'user-agent': 'Mozilla/5.0 Android Chrome Mobile' });
    const cookie = sessionCookieFrom(relaunch);
    assert.ok(cookie, 'relaunch installs a fresh opaque session cookie');

    // (c) The SAME recovery re-check, now carrying that fresh cookie, resolves valid:true → the
    //     block page would location.replace to the app. So ONLY a relaunch renews.
    const afterRelaunch = await reqTo(PORT, 'POST', '/__genz/validate', { 'content-type': 'application/json', cookie });
    const ab = JSON.parse(afterRelaunch.body);
    assert.strictEqual(ab.valid, true, 'fresh relaunch cookie → valid → recovery navigates to the app');
    assert.ok(ab.expiresAt, 'and carries the NEW server-issued expiry so the widget re-anchors');
  } finally { gw.kill(); }
});

test('REGRESSION (Cloudflare fix intact): mobile still rides the vault clearance, not stripped', async () => {
  const PORT = 3714; const gw = bootGateway(PORT);
  try {
    await waitHealth(PORT);
    const h = JSON.parse((await reqTo(PORT, 'GET', '/__genz/health')).body);
    assert.strictEqual(h.claudeMobile.mobileRidesVaultClearance, true, 'the CF-loop fix must remain on');
    assert.strictEqual(h.claudeMobile.mobileReady, true);
  } finally { gw.kill(); }
});
