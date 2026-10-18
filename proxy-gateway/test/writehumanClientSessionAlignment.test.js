'use strict';
/**
 * THE 2026-10-18 BOUNDARY: source account authenticated, upload accepted, client still logged out.
 *
 * The operator reported exactly that combination — the dedicated WriteHuman browser signed in, the
 * dashboard healthy, pushes accepted, and the member seeing WRITEHUMAN'S OWN logged-out page.
 * Manual cookie updates did not help. Everything server-side is fine in that state, which is why
 * nothing upstream of here showed a fault:
 *
 *   · the vault holds the live session (the source's capture was promoted);
 *   · the gateway sends the VAULT's cookies upstream and never the member's
 *     (buildUpstreamHeaders does `delete headers.cookie` before attaching the vault header);
 *   · but WriteHuman is a client-hydrated SPA whose visible state comes from the session in the
 *     MEMBER'S browser, which the gateway seeds with injectSupabaseBrowserSession.
 *
 * So the divergence is at the last boundary: vault session -> member's browser session. Whether
 * the seed happened was decided IN THE BROWSER, by reading a `__genz_sb` marker out of
 * localStorage inside a try/catch. Two consequences, both of which produce this exact symptom:
 *
 *   1. where localStorage on the gateway origin is unavailable or throws — strict tracking
 *      protection, a partitioned context, storage disabled — the catch swallowed it and the vault
 *      session was NEVER materialised. Permanently logged out, with every server-side signal green.
 *   2. the marker records what we last injected, not what the browser now holds, so a browser that
 *      had drifted to a dead generation could still be skipped.
 *
 * The decision is now made server-side from the generation the browser sent on the request, using
 * the access token's `iat`: behind the vault -> re-align; level or ahead -> leave it alone, because
 * the in-browser SDK rotates the session it was given and overwriting a newer generation with an
 * older one would log a working member out.
 *
 * HOW THIS RUNS. The real gateway process, a mock backend (/session) and a mock upstream. No
 * production host, no real provider, no real cookies: every token here is a fixture.
 *
 * WHAT IT DOES NOT ESTABLISH. It is not a long-running observation. It says nothing about whether
 * the member's SDK and the source browser compete to rotate one shared refresh token — they do,
 * and that contention is documented in the report, not fixed here.
 */
const test = require('node:test');
const { describe, before, after } = require('node:test');
const assert = require('node:assert/strict');
const http = require('http');
const crypto = require('crypto');
const path = require('path');
const { spawn } = require('node:child_process');

const GW_DIR = path.resolve(__dirname, '..');
const LEASE_SECRET = 'L'.repeat(48);
const GATEWAY_KEY = 'K'.repeat(40);
const REF = 'hicfsbrfkzsxbwayibfm';
const b64url = (b) => Buffer.from(b).toString('base64').replace(/=+$/, '').replace(/\+/g, '-').replace(/\//g, '_');

/** A lease JWT the gateway can verify locally (same HMAC shape as utils/proxy/lease.js). */
function lease({ jti = 'lease-1', tool = 'writehuman', ttlSec = 1800 } = {}) {
  const h = b64url(JSON.stringify({ alg: 'HS256', typ: 'JWT' }));
  const p = b64url(JSON.stringify({
    jti, sub: 'user-1', tool, type: 'proxy_lease',
    iat: Math.floor(Date.now() / 1000), exp: Math.floor(Date.now() / 1000) + ttlSec,
  }));
  const sig = crypto.createHmac('sha256', LEASE_SECRET).update(`${h}.${p}`).digest('base64')
    .replace(/=/g, '').replace(/\+/g, '-').replace(/\//g, '_');
  return `${h}.${p}.${sig}`;
}

/**
 * A Supabase @supabase/ssr auth cookie carrying an access token issued at `iat`.
 * SIMULATED TIME: `iat` is a fixture offset, not a real wait.
 */
function sbCookie(iatSec) {
  const h = b64url(JSON.stringify({ alg: 'HS256' }));
  const p = b64url(JSON.stringify({ iat: iatSec, exp: iatSec + 3600, email: 'operator@example.com', session_id: 'sess-A' }));
  const at = `${h}.${p}.sig`;
  const session = JSON.stringify({ access_token: at, refresh_token: `rt-${iatSec}`, user: { email: 'operator@example.com' } });
  return { name: `sb-${REF}-auth-token`, value: 'base64-' + Buffer.from(session).toString('base64') };
}

let upstream, backend, gw, GW_URL;
let vaultIat = 0;           // the generation the vault (and therefore the source) holds
let upstreamHits = [];      // what the gateway asked the upstream for, and with which cookies
let gwOut = '';             // everything the gateway has printed, for the log-hygiene assertion
let leaseSeq = 0;           // the gateway caches /session per lease id, so each load gets its own

function listen(server) {
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(server.address().port)));
}
function get(pathname, headers) {
  return new Promise((resolve, reject) => {
    const r = http.request(`${GW_URL}${pathname}`, { method: 'GET', headers: headers || {} }, (res) => {
      let body = '';
      res.on('data', (c) => { body += c; });
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body }));
    });
    r.on('error', reject);
    r.end();
  });
}

before(async () => {
  // Mock upstream: WriteHuman's page. The SERVER-rendered shell is the same either way — the
  // member's visible state comes from the browser session, which is the whole point.
  upstream = http.createServer((req, res) => {
    upstreamHits.push({ url: req.url, cookie: req.headers.cookie || '' });
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    res.end('<!doctype html><html><head><title>WriteHuman</title></head><body><div id="app"></div></body></html>');
  });
  const upPort = await listen(upstream);

  // Mock backend: answers the gateway's /session with the vault bundle for the current generation.
  backend = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => { body += c; });
    req.on('end', () => {
      if (!req.url.endsWith('/session')) { res.writeHead(404); return res.end('{}'); }
      if (req.headers['x-gateway-key'] !== GATEWAY_KEY) { res.writeHead(403); return res.end('{}'); }
      const c = sbCookie(vaultIat);
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({
        ok: true,
        account: { id: 'acct1', label: 'WriteHuman' },
        bundle: { cookies: [{ name: c.name, value: c.value, domain: '127.0.0.1', path: '/' }] },
      }));
    });
  });
  const bePort = await listen(backend);

  const gwPort = await new Promise((resolve) => {
    const s = http.createServer(); s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => resolve(p)); });
  });
  GW_URL = `http://127.0.0.1:${gwPort}`;
  gw = spawn(process.execPath, ['server.js'], {
    cwd: GW_DIR,
    env: {
      ...process.env,
      PORT: String(gwPort),
      TOOL_KEY: 'writehuman',
      TOOL_NAME: 'WriteHuman',
      TARGET_ORIGIN: `http://127.0.0.1:${upPort}`,
      API_BASE: `http://127.0.0.1:${bePort}`,
      GATEWAY_PUBLIC_ORIGIN: GW_URL,
      LEASE_SECRET, GATEWAY_KEY,
      SUPABASE_BROWSER_SESSION: '1',
      SESSION_TTL_MS: '1',             // no cross-test session caching
      DETECT_LOGGED_OUT: '',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  gw.stdout.setEncoding('utf8');
  gw.stdout.on('data', (d) => { gwOut += d; });
  await new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error('gateway did not start')), 15000);
    gw.stdout.on('data', (d) => { if (/listening on/.test(d)) { clearTimeout(t); resolve(); } });
    gw.on('exit', (c) => { clearTimeout(t); reject(new Error('gateway exited ' + c)); });
  });
});

after(async () => {
  if (gw) gw.kill('SIGKILL');
  await new Promise((r) => upstream.close(r));
  await new Promise((r) => backend.close(r));
});

/**
 * One document load by a member whose browser carries `browserIat` (or nothing).
 *
 * Each load gets a FRESH lease id unless one is named: getSession() caches the vault bundle per
 * lease id, so reusing one would hand a later test the earlier test's generation — which is
 * exactly how the first draft of this file passed an assertion about the wrong cookie.
 */
async function load(browserIat, { jti } = {}) {
  jti = jti || `lease-${++leaseSeq}`;
  const cookies = [`pg_lease=${encodeURIComponent(lease({ jti }))}`];
  if (browserIat != null) { const c = sbCookie(browserIat); cookies.push(`${c.name}=${c.value}`); }
  return get('/', { cookie: cookies.join('; '), accept: 'text/html' });
}
const injected = (html) => /document\.cookie\s*=\s*C\[i\]\[0\]/.test(html) && /sb-/.test(html);

describe('the member’s browser is aligned to the vault when, and only when, it is behind', () => {
  test('THE REPORTED CASE: the source signed in again, the member holds a dead generation', async () => {
    vaultIat = 2_000_000;                       // the vault was refreshed by the source
    const r = await load(1_000_000);            // the member is a generation behind
    assert.equal(r.status, 200);
    assert.ok(injected(r.body), 'the vault session must be seeded into the member’s browser');
  });

  test('a member with NO session at all is seeded', async () => {
    vaultIat = 2_000_000;
    const r = await load(null);
    assert.ok(injected(r.body));
  });

  test('a member whose SDK has rotated AHEAD is left alone', async () => {
    // Overwriting a newer generation with the vault's older one would log a working member out.
    vaultIat = 2_000_000;
    const r = await load(2_000_500);
    assert.equal(r.status, 200);
    assert.ok(!injected(r.body), 'a newer in-browser session must not be clobbered');
  });

  test('the same generation is a no-op, so repeated loads do not churn cookies', async () => {
    vaultIat = 2_000_000;
    const r = await load(2_000_000);
    assert.ok(!injected(r.body));
  });

  test('alignment does not depend on localStorage being readable', async () => {
    // The seed used to be gated on `localStorage.getItem(...)` inside a try/catch, so a browser
    // that cannot read storage was silently never seeded. The decision is server-side now, and the
    // emitted script must not read storage back to decide anything.
    vaultIat = 3_000_000;
    const r = await load(1_000_000);
    assert.ok(injected(r.body));
    assert.ok(!/localStorage\.getItem\(\s*(K|"__genz_sb")/.test(r.body),
      'no read-back of a storage marker may gate the seed');
  });

  test('a stale generation is re-aligned on EVERY document load, not once per lease', async () => {
    // Same lease id twice: the old marker logic skipped the second load.
    vaultIat = 4_000_000;
    const a = await load(1_000_000, { jti: 'lease-same' });
    const b = await load(1_000_000, { jti: 'lease-same' });
    assert.ok(injected(a.body) && injected(b.body));
  });
});

describe('what reaches WriteHuman, and what never does', () => {
  test('the member’s own sb- cookies are NEVER forwarded upstream', async () => {
    vaultIat = 5_000_000;
    upstreamHits = [];
    await load(1_000_000);
    assert.ok(upstreamHits.length >= 1, 'the upstream was asked for the page');
    const sent = upstreamHits[upstreamHits.length - 1].cookie;
    assert.ok(sent.includes('sb-'), 'the vault session is attached server-side');
    // The member's generation is 1_000_000; the vault's is 5_000_000. Only the vault's may appear.
    const vaultValue = sbCookie(5_000_000).value;
    const staleValue = sbCookie(1_000_000).value;
    assert.ok(sent.includes(vaultValue), 'the vault’s cookie goes upstream');
    assert.ok(!sent.includes(staleValue), 'the member’s stale cookie must not');
    assert.ok(!sent.includes('pg_lease'), 'the lease cookie never leaves the gateway');
  });

  test('no token, cookie value or account identity appears in the alignment log line', async () => {
    // safeLog emits generations (iat seconds) and counts. Those are correlation identifiers, not
    // credentials — and nothing else may be there.
    vaultIat = 6_000_000;
    const from = gwOut.length;
    await load(1_000_000);
    await new Promise((r) => setTimeout(r, 200));
    const line = gwOut.slice(from).split('\n').reverse().find((l) => l.includes('supabase_session_align')) || '';
    assert.ok(line, 'the alignment decision is logged');
    assert.match(line, /"vault_gen":6000000/);
    assert.match(line, /"browser_gen":1000000/);
    assert.match(line, /"align":true/);
    assert.ok(!line.includes('base64-'), 'no cookie value');
    assert.ok(!line.includes('operator@example.com'), 'no account identity');
    assert.ok(!line.includes('rt-'), 'no refresh token');
  });
});
