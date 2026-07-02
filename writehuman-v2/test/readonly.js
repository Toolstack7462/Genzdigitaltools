'use strict';
/**
 * WriteHuman V2 — read-only verify + logout-signal test (own process; default config = agent
 * mode, exchange OFF). Asserts the Fix #1/#2/#3 behaviour:
 *   - valid access token → working (fast-path, no Supabase call)
 *   - aged-out access token → 'unknown' (NO exchange, NO Supabase call, status NOT expired)
 *   - cookie ingest records lastSyncedAt + agentStale=false (Fix #3 visibility)
 *   - debounced logout signal → session_expired / needs_login (Fix #2)
 *   - logout signal requires the agent/admin key
 *
 * Run: node test/readonly.js   (exit 0 = pass)
 */
const http = require('http');
const fs = require('fs');
const os = require('os');
const path = require('path');

const realLog = console.log.bind(console);
const now = () => Math.floor(Date.now() / 1000);
const b64url = (s) => Buffer.from(s).toString('base64url');
const makeJwt = (exp) => `${b64url(JSON.stringify({ alg: 'HS256', typ: 'JWT' }))}.${b64url(JSON.stringify({ exp, sub: 'u' }))}.sig`;
const REF = 'hicfsbrfkzsxbwayibfm';
const AUTH = 'sb-' + REF + '-auth-token';
const authVal = (s) => 'base64-' + b64url(JSON.stringify(s));
function authCookies(tag, accessExp, refresh) {
  const s = { access_token: makeJwt(accessExp), refresh_token: refresh, token_type: 'bearer', expires_in: 3600, expires_at: accessExp, user: { email: tag + '@example.com' } };
  return [{ name: AUTH, value: authVal(s) }, { name: 'sb-session-token', value: 'SESS-' + tag }];
}
function listen(s) { return new Promise((r) => s.listen(0, '127.0.0.1', () => r(s.address().port))); }
function req(port, method, p, opts = {}) {
  return new Promise((resolve, reject) => {
    const data = opts.body == null ? null : Buffer.from(typeof opts.body === 'string' ? opts.body : JSON.stringify(opts.body));
    const h = Object.assign({}, opts.headers || {});
    if (data) { h['content-type'] = h['content-type'] || 'application/json'; h['content-length'] = data.length; }
    const r = http.request({ host: '127.0.0.1', port, method, path: p, headers: h, agent: false }, (resp) => {
      const ch = []; resp.on('data', (c) => ch.push(c));
      resp.on('end', () => { let j = null; try { j = JSON.parse(Buffer.concat(ch).toString('utf8')); } catch (_) {} resolve({ status: resp.statusCode, json: j }); });
    });
    r.on('error', reject); if (data) r.write(data); r.end();
  });
}
let pass = 0, fail = 0;
function check(n, c, d) { if (c) { pass++; realLog('  ✓', n); } else { fail++; realLog('  ✗', n, d != null ? '→ ' + JSON.stringify(d) : ''); } }

async function main() {
  let supabaseHits = 0;
  const fakeSupabase = http.createServer((rq, rs) => { if (rq.url.startsWith('/auth/v1/token')) { supabaseHits++; rs.writeHead(200, { 'content-type': 'application/json' }); rs.end('{"refresh_token":"X","access_token":"' + makeJwt(now() + 3600) + '"}'); return; } rs.writeHead(404); rs.end(); });
  const sbPort = await listen(fakeSupabase);

  const ADMIN = 'ro-admin', AGENT = 'ro-agent';
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'whv2ro-'));
  Object.assign(process.env, {
    WRITEHUMAN_V2_PORT: '0',
    WRITEHUMAN_V2_TARGET_ORIGIN: 'http://127.0.0.1:1',
    WRITEHUMAN_V2_SUPABASE_URL: 'http://127.0.0.1:' + sbPort,
    WRITEHUMAN_V2_SUPABASE_REF: REF,
    WRITEHUMAN_V2_STORE: 'json',
    WRITEHUMAN_V2_DATA_DIR: tmp,
    WRITEHUMAN_V2_ADMIN_KEY: ADMIN,
    WRITEHUMAN_V2_AGENT_KEY: AGENT,
    WRITEHUMAN_V2_SECRET: 'base-secret-readonly-1234567890',
    WRITEHUMAN_V2_SCHEDULER: '0',
    WRITEHUMAN_V2_VERIFY_MAX_RETRIES: '0',
    // NOTE: WRITEHUMAN_V2_VERIFY_EXCHANGE intentionally UNSET → default read-only/agent mode.
  });
  const { server } = require('../server');
  await new Promise((r) => (server.listening ? r() : server.once('listening', r)));
  const port = server.address().port;
  const adminH = { 'x-admin-key': ADMIN }, agentH = { 'x-agent-key': AGENT };

  realLog('\n── read-only verify (no server-side exchange) ────');
  const h0 = await req(port, 'GET', '/v2/health');
  check('mode is standalone', h0.json && h0.json.mode === 'standalone', h0.json && h0.json.mode);

  // valid access token → working via fast-path, NO Supabase call
  await req(port, 'POST', '/v2/admin/seed', { headers: adminH, body: { cookies: authCookies('live', now() + 3600, 'REFRESH_GOOD') } });
  let before = supabaseHits;
  const vLive = await req(port, 'POST', '/v2/admin/verify', { headers: adminH });
  check('valid access → working (fast-path)', vLive.json && vLive.json.result === 'working', vLive.json);
  check('fast-path made NO Supabase call', supabaseHits === before, { before, after: supabaseHits });

  // aged-out access token + good refresh → read-only returns unknown, NO exchange, NOT expired
  await req(port, 'POST', '/v2/admin/seed', { headers: adminH, body: { cookies: authCookies('stale', now() - 30, 'REFRESH_GOOD') } });
  before = supabaseHits;
  const vStale = await req(port, 'POST', '/v2/admin/verify', { headers: adminH });
  check('aged-out access → unknown (read-only, no rotation)', vStale.json && vStale.json.result === 'unknown', vStale.json);
  check('read-only made NO Supabase exchange', supabaseHits === before, { before, after: supabaseHits });
  const hStale = await req(port, 'GET', '/v2/health');
  check('stale token did NOT flip to session_expired', hStale.json.account.status !== 'session_expired', hStale.json.account.status);

  realLog('\n── sync visibility (Fix #3) ──────────────────────');
  const ig = await req(port, 'POST', '/v2/cookies/ingest', { headers: agentH, body: { cookies: authCookies('fresh', now() + 3600, 'REFRESH_GOOD') } });
  check('ingest changed → working', ig.json && ig.json.changed === true && ig.json.result === 'working', ig.json);
  const hSync = await req(port, 'GET', '/v2/health');
  check('health shows lastSyncedAt + agentStale=false + syncCount>=1', !!hSync.json.account.lastSyncedAt && hSync.json.account.agentStale === false && hSync.json.account.syncCount >= 1, hSync.json.account);

  realLog('\n── logout signal (Fix #2) ────────────────────────');
  const lo403 = await req(port, 'POST', '/v2/cookies/ingest', { body: { loggedOut: true } });
  check('logout signal without key → 403', lo403.status === 403, lo403.status);
  const lo = await req(port, 'POST', '/v2/cookies/ingest', { headers: agentH, body: { loggedOut: true, reason: 'auth_cookie_absent' } });
  check('logout signal accepted', lo.status === 200 && lo.json && lo.json.loggedOut === true, lo.json);
  const hLo = await req(port, 'GET', '/v2/health');
  check('logout → session_expired / needs_login', hLo.json.account.status === 'session_expired' && hLo.json.account.sessionStatus === 'needs_login', hLo.json.account);

  realLog(`\n  RESULT: ${pass} passed, ${fail} failed\n`);
  process.exitCode = fail === 0 ? 0 : 1;
  try { fakeSupabase.close(); server.close(); } catch (_) {}
  try { http.globalAgent.destroy(); } catch (_) {}
  const t = setTimeout(() => process.exit(process.exitCode), 1500); t.unref();
}
main().catch((e) => { realLog('READONLY ERROR:', e && e.stack || e); process.exit(2); });
