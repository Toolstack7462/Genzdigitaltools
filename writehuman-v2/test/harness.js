'use strict';
/**
 * WriteHuman V2 — local end-to-end test harness (no production contact).
 *
 * Spins up a fake upstream (stand-in for writehuman.ai) and a fake Supabase token endpoint,
 * boots the real V2 server.js against them on an ephemeral port, and asserts the Step-1
 * contract: boot, seed/encrypt, lease validate, gateway-key session fetch, verify-gated
 * account-expired, server-side cookie injection through the gateway, cookie-hash semantics,
 * the ingest stub, and "no cookie values in logs".
 *
 * Run: node test/harness.js   (exit code 0 = all pass)
 */
const http = require('http');
const fs = require('fs');
const os = require('os');
const path = require('path');

// ── capture logs (to verify no secret ever appears) ──────────────────────────
const logLines = [];
const realLog = console.log.bind(console);
console.log = (...a) => { try { logLines.push(a.map(String).join(' ')); } catch (_) {} realLog(...a); };

// ── helpers ───────────────────────────────────────────────────────────────────
const now = () => Math.floor(Date.now() / 1000);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const authOnly = (b) => b.cookies.filter((c) => c.name === AUTH || c.name === 'sb-session-token');
const b64url = (s) => Buffer.from(s).toString('base64url');
const makeJwt = (exp) => `${b64url(JSON.stringify({ alg: 'HS256', typ: 'JWT' }))}.${b64url(JSON.stringify({ exp, sub: 'u' }))}.sig`;

const REF = 'hicfsbrfkzsxbwayibfm';
const AUTH = 'sb-' + REF + '-auth-token';
const authCookieVal = (sess) => 'base64-' + b64url(JSON.stringify(sess));
function bundle(tag, accessExp, refresh) {
  const sess = { access_token: makeJwt(accessExp), refresh_token: refresh, token_type: 'bearer', expires_in: 3600, expires_at: accessExp, user: { email: tag + '@example.com' } };
  return { cookies: [
    { name: AUTH, value: authCookieVal(sess) },
    { name: 'sb-session-token', value: 'SESSVAL-' + tag },
    { name: '_ga', value: 'GA1.2.analytics' },
  ] };
}
const SECRETS = ['REFRESH_GOOD', 'REFRESH_BAD', 'REFRESH_GOOD2', 'REFRESH_FLAKY', 'SESSVAL-'];

function listen(srv) { return new Promise((r) => srv.listen(0, '127.0.0.1', () => r(srv.address().port))); }

function req(port, method, p, { headers = {}, body = null } = {}) {
  return new Promise((resolve, reject) => {
    const data = body == null ? null : Buffer.from(typeof body === 'string' ? body : JSON.stringify(body));
    const h = Object.assign({}, headers);
    if (data) { h['content-type'] = h['content-type'] || 'application/json'; h['content-length'] = data.length; }
    const r = http.request({ host: '127.0.0.1', port, method, path: p, headers: h, agent: false }, (resp) => {
      const ch = []; resp.on('data', (c) => ch.push(c));
      resp.on('end', () => { const text = Buffer.concat(ch).toString('utf8'); let json = null; try { json = JSON.parse(text); } catch (_) {} resolve({ status: resp.statusCode, headers: resp.headers, text, json }); });
    });
    r.on('error', reject);
    if (data) r.write(data);
    r.end();
  });
}

// ── assertions ──────────────────────────────────────────────────────────────
let pass = 0, fail = 0;
function check(name, cond, detail) {
  if (cond) { pass++; realLog('  ✓', name); }
  else { fail++; realLog('  ✗', name, detail != null ? '→ ' + JSON.stringify(detail) : ''); }
}

async function main() {
  // 1) fake upstream (writehuman.ai stand-in) — records the inbound Cookie header.
  let lastUpstreamCookie = '';
  const fakeUpstream = http.createServer((rq, rs) => {
    lastUpstreamCookie = rq.headers.cookie || '';
    rs.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    rs.end('<!doctype html><html><head><title>WriteHuman</title></head><body>editor</body></html>');
  });
  const upPort = await listen(fakeUpstream);

  // 2) fake Supabase token endpoint.
  let supabaseHits = 0;
  const fakeSupabase = http.createServer((rq, rs) => {
    if (rq.url.startsWith('/auth/v1/token')) {
      supabaseHits++;
      const ch = []; rq.on('data', (c) => ch.push(c));
      rq.on('end', () => {
        let rt = null; try { rt = JSON.parse(Buffer.concat(ch).toString('utf8')).refresh_token; } catch (_) {}
        if (rt === 'REFRESH_FLAKY') { rs.writeHead(503, { 'content-type': 'application/json' }); rs.end('{"error":"upstream"}'); return; } // → verify 'unknown'
        if (rt === 'REFRESH_GOOD') {
          const sess = { access_token: makeJwt(now() + 3600), refresh_token: 'REFRESH_GOOD2', token_type: 'bearer', expires_in: 3600, expires_at: now() + 3600, user: { email: 'live@example.com' } };
          rs.writeHead(200, { 'content-type': 'application/json' }); rs.end(JSON.stringify(sess));
        } else { rs.writeHead(400, { 'content-type': 'application/json' }); rs.end('{"error":"invalid_grant"}'); }
      });
      return;
    }
    rs.writeHead(404); rs.end();
  });
  const sbPort = await listen(fakeSupabase);

  // 3) env for an isolated V2 boot — set BEFORE requiring server.js.
  const ADMIN = 'test-admin-key-xyz', GW = 'test-gateway-key-xyz', LEASE = 'test-lease-secret-0123456789abcdefghij', AGENT = 'test-agent-key-xyz';
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'whv2-'));
  Object.assign(process.env, {
    WRITEHUMAN_V2_PORT: '0',
    WRITEHUMAN_V2_TARGET_ORIGIN: 'http://127.0.0.1:' + upPort,
    WRITEHUMAN_V2_SUPABASE_URL: 'http://127.0.0.1:' + sbPort,
    WRITEHUMAN_V2_SUPABASE_REF: REF,
    WRITEHUMAN_V2_STORE: 'json',
    WRITEHUMAN_V2_DATA_DIR: tmp,
    WRITEHUMAN_V2_ADMIN_KEY: ADMIN,
    WRITEHUMAN_V2_GATEWAY_KEY: GW,
    WRITEHUMAN_V2_AGENT_KEY: AGENT,
    WRITEHUMAN_V2_LEASE_SECRET: LEASE,
    WRITEHUMAN_V2_SECRET: 'base-secret-for-vault-derive-123456',
    // Step-2: disable the auto-scheduler for deterministic tests (we test it separately), and
    // make verify retries fast so the 'unknown → retry, no expire' path runs quickly.
    WRITEHUMAN_V2_SCHEDULER: '0',
    WRITEHUMAN_V2_VERIFY_MAX_RETRIES: '1',
    WRITEHUMAN_V2_VERIFY_RETRY_MS: '10',
  });

  const { server } = require('../server');
  await new Promise((r) => (server.listening ? r() : server.once('listening', r)));
  const port = server.address().port;
  const adminH = { 'x-admin-key': ADMIN }, gwH = { 'x-gateway-key': GW }, agentH = { 'x-agent-key': AGENT };
  const mintTok = async () => (await req(port, 'POST', '/v2/admin/lease', { headers: adminH, body: {} })).json.token;

  realLog('\n── boot ─────────────────────────────────────────');
  const h0 = await req(port, 'GET', '/v2/health');
  check('boots & /v2/health ok', h0.status === 200 && h0.json && h0.json.ok === true, h0.json);
  check('uses JSON store', h0.json && h0.json.store === 'json', h0.json && h0.json.store);
  check('supabase configured', h0.json && h0.json.supabaseConfigured === true);
  check('account starts without bundle', h0.json && h0.json.account.hasBundle === false);

  realLog('\n── seed / encrypt ───────────────────────────────');
  const live = bundle('live', now() + 3600, 'REFRESH_GOOD');
  const s1 = await req(port, 'POST', '/v2/admin/seed', { headers: adminH, body: { cookies: live.cookies, label: 'Primary' } });
  check('seed stores 3 cookies', s1.status === 200 && s1.json && s1.json.cookiesSaved === 3, s1.json);
  const s1bad = await req(port, 'POST', '/v2/admin/seed', { body: { cookies: live.cookies } });
  check('seed without admin key → 403', s1bad.status === 403, s1bad.status);
  const h1 = await req(port, 'GET', '/v2/health');
  check('health shows bundle + cookieHash + active', h1.json && h1.json.account.hasBundle && h1.json.account.hasCookieHash && h1.json.account.status === 'active', h1.json && h1.json.account);

  realLog('\n── lease validate ───────────────────────────────');
  const lz = await req(port, 'POST', '/v2/admin/lease', { headers: adminH, body: {} });
  check('mint lease returns token', lz.status === 200 && lz.json && !!lz.json.token, lz.json);
  const token = lz.json && lz.json.token;
  const v1 = await req(port, 'POST', '/v2/validate', { headers: { authorization: 'Bearer ' + token } });
  check('valid lease → valid:true', v1.status === 200 && v1.json && v1.json.valid === true && v1.json.tool === 'writehuman', v1.json);
  const v2 = await req(port, 'POST', '/v2/validate', { headers: { authorization: 'Bearer garbage.token.sig' } });
  check('garbage lease → 401', v2.status === 401 && v2.json && v2.json.valid === false, v2.json);

  realLog('\n── session (gateway-key gated) ───────────────────');
  const se0 = await req(port, 'POST', '/v2/session', { headers: { authorization: 'Bearer ' + token } });
  check('session without gateway key → 403', se0.status === 403, se0.status);
  const se1 = await req(port, 'POST', '/v2/session', { headers: Object.assign({ authorization: 'Bearer ' + token }, gwH) });
  check('session with gateway key → bundle (3 cookies)', se1.status === 200 && se1.json && se1.json.ok === true && se1.json.bundle && se1.json.bundle.cookies.length === 3, se1.json && se1.json.ok);

  realLog('\n── account-expired (verify-gated) ────────────────');
  // a) expired bundle → confirmed expiry
  await req(port, 'POST', '/v2/admin/seed', { headers: adminH, body: { cookies: bundle('exp', now() - 30, 'REFRESH_BAD').cookies } });
  const hitsBeforeExp = supabaseHits;
  const lzE = await req(port, 'POST', '/v2/admin/lease', { headers: adminH, body: {} });
  const ae1 = await req(port, 'POST', '/v2/account-expired', { headers: Object.assign({ authorization: 'Bearer ' + lzE.json.token }, gwH) });
  check('expired session → updated:true (confirmed)', ae1.status === 200 && ae1.json && ae1.json.updated === true, ae1.json);
  check('expired path called Supabase', supabaseHits > hitsBeforeExp);
  const hExp = await req(port, 'GET', '/v2/health');
  check('account flagged session_expired', hExp.json && hExp.json.account.status === 'session_expired', hExp.json && hExp.json.account.status);

  // b) live (fast-path) bundle → stays active, no Supabase call
  await req(port, 'POST', '/v2/admin/seed', { headers: adminH, body: { cookies: live.cookies } });
  const hitsBeforeLive = supabaseHits;
  const lzL = await req(port, 'POST', '/v2/admin/lease', { headers: adminH, body: {} });
  const ae2 = await req(port, 'POST', '/v2/account-expired', { headers: Object.assign({ authorization: 'Bearer ' + lzL.json.token }, gwH) });
  check('live session → updated:false (kept active)', ae2.status === 200 && ae2.json && ae2.json.updated === false, ae2.json);
  check('live fast-path makes NO Supabase call', supabaseHits === hitsBeforeLive, { before: hitsBeforeLive, after: supabaseHits });
  const hLive = await req(port, 'GET', '/v2/health');
  check('account back to active', hLive.json && hLive.json.account.status === 'active', hLive.json && hLive.json.account.status);

  realLog('\n── verifyNow (refresh exchange) ──────────────────');
  await req(port, 'POST', '/v2/admin/seed', { headers: adminH, body: { cookies: bundle('exch', now() - 30, 'REFRESH_GOOD').cookies } });
  const hitsBeforeExch = supabaseHits;
  const vn = await req(port, 'POST', '/v2/admin/verify', { headers: adminH });
  check('verifyNow exchanges & returns working', vn.status === 200 && vn.json && vn.json.result === 'working', vn.json);
  check('verifyNow called Supabase', supabaseHits > hitsBeforeExch);

  realLog('\n── cookie ingest endpoint (wired) ────────────────');
  const ig0 = await req(port, 'POST', '/v2/cookies/ingest', { body: {} });
  check('ingest without key → 403', ig0.status === 403, ig0.status);
  const ig1 = await req(port, 'POST', '/v2/cookies/ingest', { headers: adminH, body: {} });
  check('ingest with key but no cookies → 400 bad_cookies', ig1.status === 400 && ig1.json && ig1.json.code === 'bad_cookies', ig1.json);

  realLog('\n── gateway: open + server-side cookie injection ──');
  await req(port, 'POST', '/v2/admin/seed', { headers: adminH, body: { cookies: live.cookies } });
  const lzC = await req(port, 'POST', '/v2/admin/lease', { headers: adminH, body: {} });
  const ctoken = lzC.json.token;
  const open = await req(port, 'GET', '/gateway?lease=' + encodeURIComponent(ctoken), { headers: { accept: 'text/html' } });
  const setCookie = [].concat(open.headers['set-cookie'] || []);
  const leaseCookie = setCookie.find((c) => c.startsWith('pg_lease='));
  check('/gateway → 302 + pg_lease cookie + redirect /', open.status === 302 && !!leaseCookie && open.headers.location === '/', { status: open.status, loc: open.headers.location });
  const cookieVal = leaseCookie ? leaseCookie.split(';')[0].slice('pg_lease='.length) : '';
  const nav = await req(port, 'GET', '/', { headers: { accept: 'text/html', cookie: 'pg_lease=' + cookieVal } });
  check('proxied nav → 200 HTML', nav.status === 200 && /text\/html/.test(nav.headers['content-type'] || ''), nav.status);
  check('overlay injected (__GENZ_GATEWAY__)', /__GENZ_GATEWAY__/.test(nav.text));
  check('critical-hide CSS injected', /genz-critical-hide/.test(nav.text));
  check('upstream got the auth cookie server-side', lastUpstreamCookie.includes(AUTH) && lastUpstreamCookie.includes('sb-session-token'), lastUpstreamCookie.slice(0, 60));
  check('lease cookie NOT forwarded upstream', !lastUpstreamCookie.includes('pg_lease'));
  check('supabase_session_injected logged (count only)', logLines.some((l) => l.includes('supabase_session_injected')));

  realLog('\n── cookieManager (monitors only auth cookies) ────');
  const cm = require('../session/cookieManager');
  const hLiveHash = cm.cookieHash(live);
  check('cookieHash non-null for auth bundle', !!hLiveHash);
  const gaChanged = JSON.parse(JSON.stringify(live)); gaChanged.cookies.find((c) => c.name === '_ga').value = 'GA1.2.DIFFERENT';
  check('analytics change does NOT change hash', cm.cookieHash(gaChanged) === hLiveHash);
  const authChanged = JSON.parse(JSON.stringify(live)); authChanged.cookies.find((c) => c.name === 'sb-session-token').value = 'SESSVAL-changed';
  check('auth change DOES change hash', cm.cookieHash(authChanged) !== hLiveHash);
  const replaced = cm.replaceAuthCookies(live, [{ name: 'sb-session-token', value: 'NEW' }, { name: AUTH, value: 'base64-NEW' }]);
  const ga = replaced.cookies.find((c) => c.name === '_ga');
  const newSess = replaced.cookies.find((c) => c.name === 'sb-session-token');
  check('replace keeps analytics, swaps auth (no merge)', !!ga && ga.value === 'GA1.2.analytics' && newSess.value === 'NEW' && replaced.cookies.filter((c) => c.name === 'sb-session-token').length === 1);

  realLog('\n── Step-2: cookie ingest (hash-detect, replace-not-merge) ──');
  await req(port, 'POST', '/v2/admin/seed', { headers: adminH, body: { cookies: live.cookies } }); // known active live state
  const liveAuth = authOnly(live);
  const ig403 = await req(port, 'POST', '/v2/cookies/ingest', { body: { cookies: liveAuth } });
  check('ingest without key → 403', ig403.status === 403, ig403.status);
  const igu = await req(port, 'POST', '/v2/cookies/ingest', { headers: agentH, body: { cookies: liveAuth } });
  check('identical auth → changed:false (no-op)', igu.status === 200 && igu.json && igu.json.changed === false, igu.json);

  const live2 = bundle('live2', now() + 3600, 'REFRESH_GOOD');
  const hitsBeforeIngest = supabaseHits;
  const igc = await req(port, 'POST', '/v2/cookies/ingest', { headers: agentH, body: { cookies: authOnly(live2) } });
  check('changed auth → changed:true + working', igc.status === 200 && igc.json && igc.json.changed === true && igc.json.result === 'working', igc.json);
  check('changed-live ingest used fast-path (no Supabase)', supabaseHits === hitsBeforeIngest, { b: hitsBeforeIngest, a: supabaseHits });
  const se = await req(port, 'POST', '/v2/session', { headers: Object.assign({ authorization: 'Bearer ' + (await mintTok()) }, gwH) });
  const bc = (se.json && se.json.bundle && se.json.bundle.cookies) || [];
  const gaC = bc.find((c) => c.name === '_ga');
  const authCk = bc.find((c) => c.name === AUTH);
  check('ingest preserved non-auth (_ga) cookie', !!gaC && gaC.value === 'GA1.2.analytics');
  check('ingest replaced auth value (single copy, no merge)', !!authCk && authCk.value === authOnly(live2).find((c) => c.name === AUTH).value && bc.filter((c) => c.name === AUTH).length === 1);

  const ign = await req(port, 'POST', '/v2/cookies/ingest', { headers: agentH, body: { cookies: [{ name: '_ga', value: 'x' }] } });
  check('no auth cookie in payload → changed:false (safe, no wipe)', ign.status === 200 && ign.json && ign.json.changed === false && ign.json.code === 'no_auth_in_payload', ign.json);
  const se2 = await req(port, 'POST', '/v2/session', { headers: Object.assign({ authorization: 'Bearer ' + (await mintTok()) }, gwH) });
  check('no-auth ingest did NOT wipe stored auth', (se2.json.bundle.cookies || []).some((c) => c.name === AUTH));

  const igF = await req(port, 'POST', '/v2/cookies/ingest', { headers: agentH, body: { cookies: authOnly(bundle('flaky', now() - 30, 'REFRESH_FLAKY')) } });
  check('transient 503 → result unknown', igF.json && igF.json.result === 'unknown', igF.json);
  const hF = await req(port, 'GET', '/v2/health');
  check('transient unknown does NOT flip to needs_login (retry, stay active)', hF.json.account.status === 'active', hF.json.account.status);

  const igB = await req(port, 'POST', '/v2/cookies/ingest', { headers: agentH, body: { cookies: authOnly(bundle('bad', now() - 30, 'REFRESH_BAD')) } });
  check('confirmed bad refresh → session_expired', igB.json && igB.json.result === 'session_expired', igB.json);
  const igR = await req(port, 'POST', '/v2/cookies/ingest', { headers: agentH, body: { cookies: authOnly(bundle('rec', now() + 3600, 'REFRESH_GOOD')) } });
  check('recovery ingest → working again (auto-recover, no manual step)', igR.json && igR.json.result === 'working', igR.json);
  const hR = await req(port, 'GET', '/v2/health');
  check('account recovered to active', hR.json.account.status === 'active', hR.json.account.status);

  realLog('\n── Step-2: smart-timer scheduler ─────────────────');
  const sched = require('../session/scheduler');
  let ticks = 0, maxConcurrent = 0, cur = 0;
  sched.stop();
  sched.init({ enabled: true, intervalMs: 30, retryMs: 15, getLast: () => null, verifyFn: async () => { cur++; maxConcurrent = Math.max(maxConcurrent, cur); await sleep(20); cur--; ticks++; return { result: 'working' }; } });
  sched.start();
  await sleep(150);
  const ranTicks = ticks;
  check('scheduler fires repeatedly when due', ranTicks >= 2, ranTicks);
  check('scheduler never overlaps verifies (single-flight)', maxConcurrent === 1, maxConcurrent);
  sched.stop();
  await sleep(60);                 // let any in-flight verify settle
  const afterStop = ticks;
  await sleep(80);                 // window in which a running scheduler WOULD have ticked
  check('scheduler.stop() halts further ticks', ticks === afterStop, { afterStop, later: ticks });

  realLog('\n── Step-2: CDP sync agent (pure fns + hash parity) ──');
  const agent = require('../agent/cookie-sync-agent');
  const cm2 = require('../session/cookieManager');
  const sample = [
    { name: AUTH, value: 'base64-xyz', domain: '.writehuman.ai', path: '/' },
    { name: 'sb-session-token', value: 'S1', domain: 'writehuman.ai', path: '/' },
    { name: '_ga', value: 'GA', domain: '.writehuman.ai', path: '/' },
    { name: AUTH, value: 'OTHER', domain: '.example.com', path: '/' },
  ];
  const filtered = agent.filterAuthCookies(sample, 'writehuman.ai', REF);
  check('agent keeps only auth cookies for the domain', filtered.length === 2 && filtered.every((c) => c.name === AUTH || c.name === 'sb-session-token'), filtered.map((c) => c.name));
  check('agent ignores analytics + foreign-domain auth', !filtered.some((c) => c.value === 'GA' || c.value === 'OTHER'));
  check('agent hash == server cookieManager hash (cross-impl parity)', !!agent.hashAuthCookies(filtered) && agent.hashAuthCookies(filtered) === cm2.cookieHash({ cookies: filtered }));

  realLog('\n── secret hygiene (server logs) ──────────────────');
  const serverLogs = logLines.filter((l) => l.startsWith('[wh-v2]') || l.startsWith('[proxy-gw')).join('\n');
  const leaked = SECRETS.filter((s) => serverLogs.includes(s));
  check('no cookie values / refresh tokens in logs', leaked.length === 0, leaked);

  // ── summary ─────────────────────────────────────────────────────────────────
  realLog(`\n──────────────────────────────────────────────────\n  RESULT: ${pass} passed, ${fail} failed\n`);
  // Graceful shutdown: close the listeners and destroy the agents so the event loop drains
  // and Node exits naturally with process.exitCode. Forcing process.exit() here races libuv
  // on Windows (UV_HANDLE_CLOSING assert). A safety net force-exits if anything lingers.
  process.exitCode = fail === 0 ? 0 : 1;
  try { fakeUpstream.close(); fakeSupabase.close(); server.close(); } catch (_) {}
  try { http.globalAgent.destroy(); require('https').globalAgent.destroy(); } catch (_) {}
  const t = setTimeout(() => process.exit(process.exitCode), 1500); t.unref();
}

main().catch((e) => { realLog('HARNESS ERROR:', e && e.stack || e); process.exit(2); });
