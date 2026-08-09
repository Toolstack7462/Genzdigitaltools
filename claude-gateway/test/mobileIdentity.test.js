'use strict';
/**
 * Claude mobile Cloudflare-challenge fix (CORRECTED 2026-07-22 from live-log evidence).
 *
 * The gateway's egress is a datacenter IP whose ONLY valid Cloudflare cf_clearance is the vault's,
 * minted with the pinned DESKTOP UA. Live logs proved a mobile client that sends its own UA + has
 * the vault clearance stripped is challenged on ~every /api/* call and then loops forever on the
 * unsolvable /api/challenge_redirect. So by DEFAULT ('vault' mode) a mobile client now rides the
 * SAME pinned desktop upstream identity + reused vault clearance as desktop — the browser stays
 * mobile, only the upstream HTTP identity is the desktop vault's. The previous per-device behaviour
 * (real mobile UA + own clearance) is kept ONLY as the reversible CLAUDE_MOBILE_UPSTREAM=own
 * kill-switch, and is still covered at the bottom of this file against a second gateway process.
 *
 * Boots the REAL claude-gateway/server.js against a mock upstream that echoes the headers
 * (and cookies) it received, then drives a full lease → nav for desktop and several mobile
 * clients. Node built-in runner; no browser needed.
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
  const p = b64({ jti: 'testjti' + crypto.randomBytes(3).toString('hex'), sub: 'u1', tool: 'claude', type: 'proxy_lease', exp: Math.floor(Date.now() / 1000) + 1800 });
  const sig = crypto.createHmac('sha256', SECRET).update(h + '.' + p).digest('base64').replace(/=/g, '').replace(/\+/g, '-').replace(/\//g, '_');
  return h + '.' + p + '.' + sig;
}

const UA_DESKTOP = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36';
const UA_ANDROID = 'Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Mobile Safari/537.36';
const UA_IPHONE = 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1';
const PINNED_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36';

let proc, upstream, backend, GW_PORT, seen = [], flakyHits = 0;

test.before(async () => {
  // Mock Gen Z backend: the gateway fetches the vault account session from here (server-to-
  // server, gateway-key). Returning a bundle makes `session.cookieHeader` non-empty so the
  // CF-cookie passthrough branch actually runs (that is where per-client isolation lives).
  backend = http.createServer((q, r) => {
    let body = ''; q.on('data', c => body += c);
    q.on('end', () => {
      r.setHeader('content-type', 'application/json');
      if (q.url.endsWith('/session')) return r.end(JSON.stringify({ ok: true, account: { id: 'acc1', maskedId: 'a***1' }, bundle: { cookies: [{ name: "sessionKey", value: "VAULT_SECRET" }, { name: "cf_clearance", value: "VAULTCF" }] } }));
      if (q.url.endsWith('/validate')) return r.end(JSON.stringify({ valid: true, secondsRemaining: 1800 }));
      r.end('{}');
    });
  });
  await new Promise((res) => backend.listen(0, res));
  const bePort = backend.address().port;
  // Mock claude.ai: echoes the request headers + cookies it received as JSON. A cf_clearance
  // in the request cookie is echoed so we can assert which one reached upstream.
  upstream = http.createServer((q, r) => {
    // rawHeaders preserves ARRIVAL ORDER, which is itself part of Cloudflare's fingerprint.
    const order = []; for (let i = 0; i < q.rawHeaders.length; i += 2) order.push(String(q.rawHeaders[i]).toLowerCase());
    seen.push({ ua: q.headers['user-agent'], chm: q.headers['sec-ch-ua-mobile'], chua: q.headers['sec-ch-ua'], chplat: q.headers['sec-ch-ua-platform'], model: q.headers['sec-ch-ua-model'], platver: q.headers['sec-ch-ua-platform-version'], cookie: q.headers.cookie || '', order });
    const p = q.url.split('?')[0];
    const challenge = () => {
      r.writeHead(403, { 'content-type': 'text/html', server: 'cloudflare', 'cf-ray': '9abc123', 'cf-mitigated': 'challenge' });
      r.end('<html><body>Verifying you are human… <script>window.location.reload()</script></body></html>');
    };
    // Always challenges — exhausts the retries and lands on the notice.
    if (p === '/api/challenge_redirect') return challenge();
    // A GENERIC always-challenged nav path. /api/challenge_redirect is now specially handled for
    // mobile (bounced back — see test/mobileXhrShield.test.js), so the general "a challenged nav
    // gives a recoverable notice" behaviour is asserted against this generic path instead.
    if (p === '/perma-challenge') return challenge();
    // Challenges the FIRST hit only, then succeeds — the transient shape the live log shows.
    if (p === '/flaky') { flakyHits += 1; if (flakyHits === 1) return challenge(); }
    r.writeHead(200, { 'content-type': 'text/html' });
    r.end('<html><head></head><body>ok</body></html>');
  });
  await new Promise((res) => upstream.listen(0, res));
  const upPort = upstream.address().port;

  GW_PORT = 18860;
  const env = Object.assign({}, process.env, {
    PORT: String(GW_PORT), TOOL_KEY: 'claude', TOOL_NAME: 'Claude AI',
    TARGET_ORIGIN: 'http://127.0.0.1:' + upPort,
    GATEWAY_PUBLIC_ORIGIN: 'http://127.0.0.1:' + GW_PORT, DEFAULT_PATH: '/new', SIGNIN_PATH: '/login',
    API_BASE: 'http://127.0.0.1:' + bePort + '/api', LEASE_SECRET: SECRET, GATEWAY_KEY: 'k'.repeat(32),
    CF_CHALLENGE_PASSTHROUGH: '1', CF_CHALLENGE_MODE: 'passthrough',
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

// Exchange a lease for the opaque __Host-claude_session cookie, then return that cookie.
async function openSession() {
  const lease = mintLease();
  const r = await get('/gateway?lease=' + encodeURIComponent(lease), { 'user-agent': UA_DESKTOP });
  const sc = [].concat(r.headers['set-cookie'] || []).find(c => /claude_session=/.test(c));
  assert.ok(sc, 'lease exchange must set an opaque session cookie');
  return sc.split(';')[0]; // name=value
}

// Drive a top-level HTML navigation as a given device; return what the upstream saw.
async function navAs(deviceHeaders) {
  const sess = await openSession();
  seen = [];
  await get('/new', Object.assign({ cookie: sess, accept: 'text/html,application/xhtml+xml' }, deviceHeaders));
  return seen[seen.length - 1];
}
// Drive an XHR/API request (NON-HTML accept → the non-minimal branch of buildUpstreamHeaders, which
// is the path that serves /api/* and was the one 75341b4 left with a desktop UA + mobile hints).
async function xhrAs(pathName, deviceHeaders) {
  const sess = await openSession();
  seen = [];
  await get(pathName, Object.assign({ cookie: sess, accept: 'application/json', 'sec-fetch-mode': 'cors', 'x-requested-with': 'XMLHttpRequest' }, deviceHeaders));
  return seen[seen.length - 1];
}

test('desktop client → upstream sees the PINNED desktop identity (unchanged)', async () => {
  const up = await navAs({ 'user-agent': UA_DESKTOP, 'sec-ch-ua': '"Chromium";v="130"', 'sec-ch-ua-mobile': '?0', 'sec-ch-ua-platform': '"Windows"' });
  assert.strictEqual(up.ua, PINNED_UA, 'desktop UA is pinned to UPSTREAM_UA');
  assert.strictEqual(up.chm, '?0', 'desktop sec-ch-ua-mobile stays ?0');
  assert.match(up.chua, /Google Chrome/, 'desktop sec-ch-ua is the pinned value');
  assert.strictEqual(up.chplat, '"Windows"', 'desktop platform pinned');
});

test('Android Chrome (default) → upstream carries the PINNED desktop identity, like the working desktop path', async () => {
  // SETTLED: mobile presents the SAME stable upstream identity as desktop. Sending a device-derived
  // UA made every phone a different fingerprint from one shared datacenter IP, and paired with
  // stripCfCookies it left the phone depending on a clearance it cannot solve through a proxy.
  const up = await navAs({ 'user-agent': UA_ANDROID, 'sec-ch-ua-mobile': '?1' });
  assert.strictEqual(up.ua, PINNED_UA, 'the pinned desktop UA, not the phone’s');
  assert.strictEqual(up.chm, '?0', 'and the hints AGREE with it (no mobile hint beside a desktop UA)');
  assert.strictEqual(up.chplat, '"Windows"', 'pinned platform, consistent with the pinned UA');
});

test('Android UA with NO client-hints (default) → still the pinned desktop identity', async () => {
  const up = await navAs({ 'user-agent': UA_ANDROID });
  assert.strictEqual(up.ua, PINNED_UA);
  assert.strictEqual(up.chm, '?0', 'hints match the pinned UA');
});

test('iOS Safari (default) → still the pinned desktop identity', async () => {
  const up = await navAs({ 'user-agent': UA_IPHONE });
  assert.strictEqual(up.ua, PINNED_UA, 'iOS also rides the pinned identity');
  assert.strictEqual(up.chm, '?0');
});

// ── REGRESSION: the /api XHR (non-minimal) branch must be consistent too ──────
// 75341b4 changed upstreamIdentity (fixing the HTML-nav/minimal branch) but LEFT the non-minimal
// branch keeping the client's own MOBILE hints beside the now-desktop UA → every mobile /api/* call
// went upstream as desktop-UA + mobile-hints → Cloudflare challenged them → the challenge_redirect
// loop returned on API calls even though /new loaded. These tests pin BOTH the UA and the hints on
// the XHR path. With the bug re-introduced, the model/mobile-flag assertions fail.
test('REGRESSION: Android XHR/API (default) → UA and hints AGREE (both desktop), on the XHR branch too', async () => {
  // buildUpstreamHeaders has TWO branches (minimal = HTML nav, non-minimal = XHR/API). Whatever
  // identity is chosen, BOTH must agree internally or Cloudflare's cross-check fails. This test
  // exists because 75341b4 changed one branch and not the other.
  const up = await xhrAs('/api/organizations', {
    'user-agent': UA_ANDROID,
    'sec-ch-ua': '"Chromium";v="130", "Google Chrome";v="130"', 'sec-ch-ua-mobile': '?1',
    'sec-ch-ua-platform': '"Android"', 'sec-ch-ua-model': '"Pixel 8"',
  });
  assert.strictEqual(up.ua, PINNED_UA, 'XHR carries the pinned desktop UA');
  assert.strictEqual(up.chm, '?0', 'desktop hint beside a desktop UA — consistent');
  assert.strictEqual(up.chplat, '"Windows"', 'consistent platform');
  assert.ok(up.model == null, 'a leftover mobile high-entropy hint would betray the mismatch');
});

test('REGRESSION: iOS XHR/API (default) → pinned desktop UA on the XHR branch as well', async () => {
  const up = await xhrAs('/api/account_profile', { 'user-agent': UA_IPHONE });
  assert.strictEqual(up.ua, PINNED_UA);
  assert.strictEqual(up.chm, '?0', 'hints agree on the XHR branch too');
});

test('desktop XHR/API is unchanged: pinned low-entropy hints, its own high-entropy hints kept', async () => {
  const up = await xhrAs('/api/organizations', {
    'user-agent': UA_DESKTOP, 'sec-ch-ua': '"Chromium";v="130"', 'sec-ch-ua-mobile': '?0',
    'sec-ch-ua-platform': '"Windows"', 'sec-ch-ua-platform-version': '"15.0.0"',
  });
  assert.strictEqual(up.ua, PINNED_UA);
  assert.strictEqual(up.chm, '?0');
  assert.strictEqual(up.chplat, '"Windows"');
  assert.strictEqual(up.platver, '"15.0.0"', 'desktop keeps its OWN (matching) high-entropy hints — purge is mobile-only');
});

test('desktop UA + desktop hints is byte-consistent across repeats (stable fingerprint)', async () => {
  const a = await navAs({ 'user-agent': UA_DESKTOP, 'sec-ch-ua-mobile': '?0' });
  const b = await navAs({ 'user-agent': UA_DESKTOP, 'sec-ch-ua-mobile': '?0' });
  assert.deepStrictEqual({ ua: a.ua, chm: a.chm, chplat: a.chplat }, { ua: b.ua, chm: b.chm, chplat: b.chplat });
});

test('COOKIE ISOLATION: one client’s cf_clearance never reaches upstream for another client', async () => {
  // Client A navigates carrying its own solved cf_clearance in its browser cookies.
  const sessA = await openSession();
  seen = [];
  await get('/new', { cookie: sessA + '; cf_clearance=AAA_clientA', 'user-agent': UA_ANDROID, accept: 'text/html' });
  const upA = seen[seen.length - 1];
  // Client B (separate lease/session) navigates with ITS own clearance.
  const sessB = await openSession();
  seen = [];
  await get('/new', { cookie: sessB + '; cf_clearance=BBB_clientB', 'user-agent': UA_ANDROID, accept: 'text/html' });
  const upB = seen[seen.length - 1];

  // The guarantee that matters is NON-LEAKAGE: no client's device cookie may ever appear in
  // another client's upstream request. (Which clearance is USED is the separate vault-precedence
  // contract below — in vault mode both clients ride the vault's, which is per-account, not
  // per-device, and was never derived from either browser.)
  assert.ok(!/BBB_clientB/.test(upA.cookie), 'client B’s clearance never leaks into A’s request');
  assert.ok(!/AAA_clientA/.test(upB.cookie), 'client A’s clearance never leaks into B’s request');
});

test('the lease cookie itself is NEVER forwarded upstream', async () => {
  const sess = await openSession();
  seen = [];
  await get('/new', { cookie: sess + '; pg_lease=SHOULD_NOT_LEAK', 'user-agent': UA_ANDROID, accept: 'text/html' });
  const up = seen[seen.length - 1];
  assert.ok(!/SHOULD_NOT_LEAK/.test(up.cookie), 'pg_lease never reaches the upstream');
  assert.ok(!/claude_session/.test(up.cookie), 'opaque session cookie never reaches the upstream');
});

// ── Shared vault Cloudflare clearance (default 'vault' mode) ──────────────────
// The vault clearance is the ONLY one valid for this gateway's datacenter egress IP, and it is
// bound to the pinned desktop UA. Because mobile now also rides that pinned desktop UA (above),
// mobile can — and must — reuse the SAME vault clearance as desktop. That is exactly what keeps
// a mobile client OFF the unsolvable /api/challenge_redirect loop.
test('desktop KEEPS the vault cf_clearance (UA matches the minting UA)', async () => {
  const up = await navAs({ 'user-agent': UA_DESKTOP, 'sec-ch-ua-mobile': '?0' });
  assert.match(up.cookie, /cf_clearance=VAULTCF/, 'desktop still uses the vault clearance');
  assert.match(up.cookie, /sessionKey=VAULT_SECRET/, 'auth cookie present');
});

test('mobile (default): the phone RIDES the authorised vault clearance, exactly like desktop', async () => {
  // This is NOT copying a clearance between devices. There is one authorised vault bundle per
  // Claude ACCOUNT, captured through this gateway from this egress under this pinned UA. Every
  // client assigned that account uses that same bundle — which is the shared-account model itself.
  // Nothing a device solved is ever reused for a different device or client (asserted below).
  const up = await navAs({ 'user-agent': UA_ANDROID, 'sec-ch-ua-mobile': '?1' });
  assert.match(up.cookie, /cf_clearance=VAULTCF/, 'the phone uses the authorised account clearance');
  assert.match(up.cookie, /sessionKey=VAULT_SECRET/, 'and the account auth cookie — it stays logged in');
});

test('mobile (default): a device-owned clearance never OVERRIDES the vault’s', async () => {
  // The regression this pins: mergeCookieHeaders is b-wins, so merging (vault, browserCf) let any
  // clearance a phone happened to hold replace the authorised one on the upstream leg — solved by
  // a mobile browser, so bound to a mobile fingerprint, so invalid for the desktop-UA request the
  // gateway sends. Every /api/* call then got challenged. In vault mode the vault wins the clash.
  const sess = await openSession();
  seen = [];
  await get('/new', { cookie: sess + '; cf_clearance=MOBILE_OWN', 'user-agent': UA_ANDROID, 'sec-ch-ua-mobile': '?1', accept: 'text/html' });
  const up = seen[seen.length - 1];
  assert.match(up.cookie, /cf_clearance=VAULTCF/, 'the authorised clearance is the one sent');
  assert.ok(!/MOBILE_OWN/.test(up.cookie), 'the device-owned one never reaches upstream');
});

test('DESKTOP IS UNCHANGED: it still uses the vault clearance, and its own still wins when present', async () => {
  const a = await navAs({ 'user-agent': UA_DESKTOP, 'sec-ch-ua-mobile': '?0' });
  assert.match(a.cookie, /cf_clearance=VAULTCF/, 'desktop still rides the vault clearance exactly as before');
  const sess = await openSession();
  seen = [];
  await get('/new', { cookie: sess + '; cf_clearance=DESKTOP_OWN', 'user-agent': UA_DESKTOP, 'sec-ch-ua-mobile': '?0', accept: 'text/html' });
  const b = seen[seen.length - 1];
  assert.match(b.cookie, /cf_clearance=DESKTOP_OWN/, 'and desktop precedence is byte-identical to before');
});

test('CLEARANCE IS NEVER SHARED BETWEEN CLIENTS (req 10)', async () => {
  // The invariant is NON-LEAKAGE and it is mode-independent: no client's device-owned cookie may
  // ever appear in another client's upstream request. In vault mode neither device cookie is used
  // at all — both ride the account's own authorised bundle — which is strictly stronger isolation
  // of device-owned secrets than forwarding each phone's own clearance.
  const sessA = await openSession();
  seen = [];
  await get('/new', { cookie: sessA + '; cf_clearance=AAA_clientA', 'user-agent': UA_ANDROID, 'sec-ch-ua-mobile': '?1', accept: 'text/html' });
  const upA = seen[seen.length - 1];
  const sessB = await openSession();
  seen = [];
  await get('/new', { cookie: sessB + '; cf_clearance=BBB_clientB', 'user-agent': UA_ANDROID, 'sec-ch-ua-mobile': '?1', accept: 'text/html' });
  const upB = seen[seen.length - 1];
  assert.ok(!/BBB_clientB/.test(upA.cookie), 'client B’s clearance never leaks into A’s request');
  assert.ok(!/AAA_clientA/.test(upB.cookie), 'client A’s clearance never leaks into B’s request');
  assert.match(upA.cookie, /cf_clearance=VAULTCF/, 'both ride the account’s authorised clearance');
  assert.match(upB.cookie, /cf_clearance=VAULTCF/);
});

test('mobile keeps its own client-hints in their original header POSITION (nothing is purged)', async () => {
  const chromeOrder = (ua, hints) => Object.assign(
    { 'sec-ch-ua': '"Chromium";v="130", "Google Chrome";v="130"' }, hints,
    { 'user-agent': ua, accept: 'application/json', 'accept-language': 'en-US,en;q=0.9' }
  );
  const sess = await openSession();
  seen = [];
  await get('/api/organizations', Object.assign({ cookie: sess },
    chromeOrder(UA_ANDROID, { 'sec-ch-ua-mobile': '?1', 'sec-ch-ua-platform': '"Android"' })));
  const mob = seen[seen.length - 1];
  const idx = (o, n) => o.order.indexOf(n);
  for (const h of ['sec-ch-ua', 'sec-ch-ua-mobile', 'sec-ch-ua-platform']) {
    assert.ok(idx(mob, h) >= 0, h + ' is forwarded');
    assert.ok(idx(mob, h) < idx(mob, 'user-agent'), h + ' keeps its early Chrome slot, not appended last');
  }
});

// ── An unsolvable challenge must not become a reload loop ─────────────────────
test('mobile: a Cloudflare challenge on a nav returns ONE recoverable notice, never a self-reloading page', async () => {
  const sess = await openSession();
  const r = await get('/perma-challenge', { cookie: sess, 'user-agent': UA_ANDROID, 'sec-ch-ua-mobile': '?1', accept: 'text/html' });
  assert.strictEqual(r.status, 503, 'a recoverable notice, not the 403 challenge document');
  assert.match(r.body, /try again/i, 'offers a MANUAL retry');
  assert.ok(!/location\.reload|window\.location\s*=|http-equiv=["']?refresh/i.test(r.body), 'and nothing in it reloads or redirects on its own');
  assert.ok(!/Verifying you are human/i.test(r.body), 'the self-reloading challenge document is not replayed');
});

test('DESKTOP gets the same treatment — the failure is not device-specific', async () => {
  // The live log showed EVERY request classifying as 'desktop' while the client was reporting the
  // fault, so gating this by device is precisely why the earlier rounds changed nothing.
  //
  // ★ UPDATED 2026-08-10. The intent of this test is unchanged and is now MORE true: desktop is
  // treated identically to mobile. What changed is the expected value on THIS path. It probed
  // /api/challenge_redirect, which — since the Fix B device gate was removed — is handled by the
  // loop breaker (204, navigation cancelled) instead of falling through to retry→notice. Asserting
  // 503 here would now re-encode the very gate that was removed. The general challenged-navigation
  // path still ends in the recoverable notice on desktop, and that is asserted separately below so
  // the notice path is not silently lost.
  const sess = await openSession();
  const r = await get('/api/challenge_redirect', { cookie: sess, 'user-agent': UA_DESKTOP, 'sec-ch-ua-mobile': '?0', accept: 'text/html' });
  assert.strictEqual(r.status, 204, 'desktop gets the same loop breaker as mobile — navigation cancelled');
  assert.ok(!r.headers['location'], 'no redirect: the running page is left exactly where it is');
  assert.ok(!/Verifying you are human/i.test(r.body || ''), 'the self-reloading challenge is not replayed on desktop either');
});

test('DESKTOP still gets the recoverable notice on a NORMAL challenged navigation', async () => {
  // Guards the other half of the change: removing the Fix B gate must not swallow the ordinary
  // retry→notice path. A challenged nav that is NOT /api/challenge_redirect must behave exactly as
  // it did before on desktop — retried, then one manual-retry notice.
  const sess = await openSession();
  const r = await get('/perma-challenge', { cookie: sess, 'user-agent': UA_DESKTOP, 'sec-ch-ua-mobile': '?0', accept: 'text/html' });
  assert.strictEqual(r.status, 503, 'the existing desktop notice path is preserved');
  assert.match(r.body, /try again/i, 'and the retry is still the user’s to make');
  assert.ok(!/Verifying you are human/i.test(r.body), 'never the challenge document');
});

// ── A challenged navigation is TRANSIENT — retry it rather than surface it ────
// Live: /new alternates 200,200 -> 403,403 -> 200,200 -> 403,403,403 with the SAME 21 vault
// cookies, same identity, same device. Nothing in the request differs between a success and a
// challenge, so re-sending it usually just works and the client never sees anything.
test('a transiently challenged navigation is retried upstream and succeeds invisibly', async () => {
  const sess = await openSession();
  flakyHits = 0;
  const r = await get('/flaky', { cookie: sess, 'user-agent': UA_DESKTOP, accept: 'text/html' });
  assert.strictEqual(r.status, 200, 'the client sees the app, not a challenge');
  assert.ok(flakyHits >= 2, 'the gateway re-sent the navigation upstream (hits: ' + flakyHits + ')');
  assert.ok(!/Verifying you are human/i.test(r.body), 'no challenge document reached the browser');
});

test('retries are BOUNDED — a permanently challenged path gives up and never loops', async () => {
  const sess = await openSession();
  const r = await get('/perma-challenge', { cookie: sess, 'user-agent': UA_ANDROID, 'sec-ch-ua-mobile': '?1', accept: 'text/html' });
  assert.strictEqual(r.status, 503, 'it stops and reports, rather than retrying forever');
  assert.match(r.body, /try again/i, 'and the retry is the user’s to make');
});

test('an XHR/API challenge is NOT RETRIED (only page navigations are) — but it IS shielded', async () => {
  // ★ UPDATED 2026-08-10. The claim this test exists to protect — "only navigations are retried" —
  // is unchanged and still asserted: the retry block is gated on isHtmlNav, so an XHR never spends
  // a retry wait. What changed is the second half. It used to assert the challenge was passed
  // through RAW to the app's fetch handler, which is exactly the defect Fix A exists to prevent:
  // handing Cloudflare's challenge DOCUMENT to a background fetch is what makes Claude's SPA
  // full-page-navigate into the unsolvable /api/challenge_redirect loop. Since the Fix A device
  // gate was removed, desktop receives the same structured retryable 503 mobile already did.
  const sess = await openSession();
  const t0 = Date.now();
  const r = await get('/api/challenge_redirect', { cookie: sess, 'user-agent': UA_DESKTOP, accept: 'application/json' });
  const dt = Date.now() - t0;
  assert.ok(dt < 400, 'NOT retried — returns immediately with no retry wait: ' + dt + 'ms');
  assert.strictEqual(r.status, 503, 'shielded: a structured transient error, not the challenge document');
  assert.match(r.headers['content-type'] || '', /application\/json/, 'JSON, so the SPA cannot treat it as a page');
  assert.ok(!/Verifying you are human/i.test(r.body), 'the raw challenge never reaches the app');
});

// ── 'own' kill-switch (CLAUDE_MOBILE_UPSTREAM=own) — the reversible fallback ───
// Boots a SECOND gateway process in the old per-device mode and confirms it still behaves the old
// way (real mobile UA forwarded, vault clearance stripped). This documents the escape hatch and
// proves the default vs kill-switch really diverge.
test('vault kill-switch: CLAUDE_MOBILE_UPSTREAM=vault restores the pinned-desktop behaviour', async () => {
  const upEcho = []; let up2, be2, gw2;
  be2 = http.createServer((q, r) => {
    let body = ''; q.on('data', c => body += c);
    q.on('end', () => {
      r.setHeader('content-type', 'application/json');
      if (q.url.endsWith('/session')) return r.end(JSON.stringify({ ok: true, account: { id: 'acc1', maskedId: 'a***1' }, bundle: { cookies: [{ name: 'sessionKey', value: 'VAULT_SECRET' }, { name: 'cf_clearance', value: 'VAULTCF' }] } }));
      if (q.url.endsWith('/validate')) return r.end(JSON.stringify({ valid: true, secondsRemaining: 1800 }));
      r.end('{}');
    });
  });
  await new Promise((res) => be2.listen(0, res));
  up2 = http.createServer((q, r) => { upEcho.push({ ua: q.headers['user-agent'], cookie: q.headers.cookie || '' }); r.writeHead(200, { 'content-type': 'text/html' }); r.end('<html></html>'); });
  await new Promise((res) => up2.listen(0, res));
  const PORT2 = 18861;
  const env = Object.assign({}, process.env, {
    PORT: String(PORT2), TOOL_KEY: 'claude', TOOL_NAME: 'Claude AI',
    TARGET_ORIGIN: 'http://127.0.0.1:' + up2.address().port,
    GATEWAY_PUBLIC_ORIGIN: 'http://127.0.0.1:' + PORT2, DEFAULT_PATH: '/new', SIGNIN_PATH: '/login',
    API_BASE: 'http://127.0.0.1:' + be2.address().port + '/api', LEASE_SECRET: SECRET, GATEWAY_KEY: 'k'.repeat(32),
    CF_CHALLENGE_PASSTHROUGH: '1', CF_CHALLENGE_MODE: 'passthrough', IDENTITY_SHIELD: '0', PROXY_LOG_ALL: '0',
    CLAUDE_MOBILE_UPSTREAM: 'vault',
  });
  gw2 = spawn(process.execPath, ['server.js'], { cwd: GW, env, stdio: ['ignore', 'pipe', 'pipe'] });
  try {
    const started = Date.now();
    const g = (p, h) => new Promise((resolve) => { const r = http.request({ port: PORT2, path: p, method: 'GET', headers: h || {} }, (res) => { const b = []; res.on('data', c => b.push(c)); res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(b).toString('utf8') })); }); r.on('error', () => resolve({ status: 0, headers: {}, body: '' })); r.end(); });
    while (Date.now() - started < 15000) { if ((await g('/__genz/health')).status === 200) break; await new Promise(r => setTimeout(r, 200)); }
    const lease = mintLease();
    const so = await g('/gateway?lease=' + encodeURIComponent(lease), { 'user-agent': UA_DESKTOP });
    const sess = [].concat(so.headers['set-cookie'] || []).find(c => /claude_session=/.test(c)).split(';')[0];
    upEcho.length = 0;
    await g('/new', { cookie: sess, 'user-agent': UA_ANDROID, accept: 'text/html' });
    const up = upEcho[upEcho.length - 1];
    assert.strictEqual(up.ua, PINNED_UA, 'vault mode pins the desktop UA for a phone');
    assert.match(up.cookie, /cf_clearance=VAULTCF/, 'and reuses the vault clearance');
    // Both branches must agree in this mode too (the 50cfb03 lesson).
    upEcho.length = 0;
    await g('/api/organizations', { cookie: sess, 'user-agent': UA_ANDROID, accept: 'application/json', 'sec-ch-ua-mobile': '?1' });
    assert.strictEqual(upEcho[upEcho.length - 1].ua, PINNED_UA, 'vault mode XHR pins the desktop UA too');
  } finally { try { gw2.kill(); } catch (_) {} try { up2.close(); } catch (_) {} try { be2.close(); } catch (_) {} }
});
