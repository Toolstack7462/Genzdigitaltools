'use strict';
/**
 * WriteHuman V2 — dashboard/telemetry/command test (own process).
 *   - /v2/admin/state (admin-gated) reflects account + agent telemetry
 *   - agent diagnostics in an ingest are recorded and exposed
 *   - remote command channel: queue -> handed back to agent once -> consumed
 *   - /v2/admin/logs returns recent events
 *   - SSE stream: token-gated, emits an initial state event
 *   - auth gating (403 without admin key)
 *
 * Run: node test/dashboard.js
 */
const http = require('http');
const fs = require('fs');
const os = require('os');
const path = require('path');
const realLog = console.log.bind(console);
const now = () => Math.floor(Date.now() / 1000);
const b64url = (s) => Buffer.from(s).toString('base64url');
const makeJwt = (exp) => `${b64url(JSON.stringify({ alg: 'HS256', typ: 'JWT' }))}.${b64url(JSON.stringify({ exp }))}.s`;
const REF = 'hicfsbrfkzsxbwayibfm';
const AUTH = 'sb-' + REF + '-auth-token';
const liveCookies = [{ name: AUTH, value: 'base64-' + b64url(JSON.stringify({ access_token: makeJwt(now() + 3600), refresh_token: 'R', user: { email: 'x@y.com' } })) }, { name: 'sb-session-token', value: 'S' }];

function req(port, method, p, opts = {}) {
  return new Promise((resolve, reject) => {
    const data = opts.body == null ? null : Buffer.from(JSON.stringify(opts.body));
    const h = Object.assign({}, opts.headers || {});
    if (data) { h['content-type'] = 'application/json'; h['content-length'] = data.length; }
    const r = http.request({ host: '127.0.0.1', port, method, path: p, headers: h, agent: false }, (resp) => {
      const ch = []; resp.on('data', (c) => ch.push(c));
      resp.on('end', () => { let j = null; const txt = Buffer.concat(ch).toString('utf8'); try { j = JSON.parse(txt); } catch (_) {} resolve({ status: resp.statusCode, headers: resp.headers, json: j, text: txt }); });
    });
    r.on('error', reject); if (data) r.write(data); r.end();
  });
}
// read the first ~chunk of an SSE stream then abort
function sseFirst(port, p) {
  return new Promise((resolve) => {
    let buf = '', doneP = false;
    const finish = (status) => { if (doneP) return; doneP = true; try { r.destroy(); } catch (_) {} resolve({ status, buf }); };
    const r = http.request({ host: '127.0.0.1', port, method: 'GET', path: p, agent: false }, (resp) => {
      resp.on('data', (c) => { buf += c.toString('utf8'); if (buf.includes('event: state')) finish(resp.statusCode); });
      resp.on('end', () => finish(resp.statusCode));
      resp.on('close', () => finish(resp.statusCode || 200));
    });
    r.on('error', () => finish(0));
    setTimeout(() => finish(200), 3000);
    r.end();
  });
}
let pass = 0, fail = 0;
function check(n, c, d) { if (c) { pass++; realLog('  ✓', n); } else { fail++; realLog('  ✗', n, d != null ? '-> ' + JSON.stringify(d) : ''); } }

async function main() {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'whv2d-'));
  Object.assign(process.env, {
    WRITEHUMAN_V2_PORT: '0', WRITEHUMAN_V2_TARGET_ORIGIN: 'http://127.0.0.1:1', WRITEHUMAN_V2_STORE: 'json',
    WRITEHUMAN_V2_DATA_DIR: tmp, WRITEHUMAN_V2_ADMIN_KEY: 'd-admin', WRITEHUMAN_V2_AGENT_KEY: 'd-agent',
    WRITEHUMAN_V2_SECRET: 'base-secret-dashboard-1234567890', WRITEHUMAN_V2_SCHEDULER: '0',
  });
  const { server } = require('../server');
  await new Promise((r) => (server.listening ? r() : server.once('listening', r)));
  const port = server.address().port;
  const A = { 'x-admin-key': 'd-admin' }, G = { 'x-agent-key': 'd-agent' };

  realLog('\n-- state + auth --');
  const noKey = await req(port, 'GET', '/v2/admin/state');
  check('state without admin key -> 403', noKey.status === 403, noKey.status);
  await req(port, 'POST', '/v2/admin/seed', { headers: A, body: { cookies: liveCookies } });
  const st = await req(port, 'GET', '/v2/admin/state', { headers: A });
  check('state -> 200 with account', st.status === 200 && st.json && st.json.account && st.json.account.status === 'active', st.json && st.json.account);
  check('state.agent null before any report', st.json.agent === null, st.json.agent);

  realLog('-- agent telemetry --');
  await req(port, 'POST', '/v2/cookies/ingest', { headers: G, body: { heartbeat: true, hash: 'abc', agent: { cdp: '200', chrome: true, pollCount: 5, authCookies: 2, host: 'RDP-TEST', version: '2.1.0', uptimeSec: 120, lastError: null } } });
  const st2 = await req(port, 'GET', '/v2/admin/state', { headers: A });
  const ag = st2.json.agent || {};
  check('agent report recorded (cdp/host/version)', ag.cdp === '200' && ag.host === 'RDP-TEST' && ag.version === '2.1.0' && ag.chrome === true, ag);
  check('agent report has receivedAt', !!ag.receivedAt);

  realLog('-- command channel --');
  const bad = await req(port, 'POST', '/v2/admin/command', { headers: A, body: { command: 'rm-rf' } });
  check('bad command -> 400', bad.status === 400 && bad.json && bad.json.code === 'bad_command', bad.json);
  const q = await req(port, 'POST', '/v2/admin/command', { headers: A, body: { command: 'reverify' } });
  check('queue reverify -> 200', q.status === 200 && q.json && q.json.queued === 'reverify', q.json);
  const ing1 = await req(port, 'POST', '/v2/cookies/ingest', { headers: G, body: { heartbeat: true, hash: 'abc' } });
  check('agent receives command in response', ing1.json && ing1.json.command === 'reverify', ing1.json);
  const ing2 = await req(port, 'POST', '/v2/cookies/ingest', { headers: G, body: { heartbeat: true, hash: 'abc' } });
  check('command consumed (not re-sent)', ing2.json && ing2.json.command === undefined, ing2.json);

  realLog('-- logs --');
  const logs = await req(port, 'GET', '/v2/admin/logs?limit=50', { headers: A });
  check('logs -> events array', logs.status === 200 && logs.json && Array.isArray(logs.json.events) && logs.json.events.length > 0, logs.json && (logs.json.events || []).length);
  const logsNoKey = await req(port, 'GET', '/v2/admin/logs');
  check('logs without key -> 403', logsNoKey.status === 403);

  realLog('-- SSE stream --');
  const tokNoKey = await req(port, 'POST', '/v2/admin/stream-token');
  check('stream-token without key -> 403', tokNoKey.status === 403);
  const tok = await req(port, 'POST', '/v2/admin/stream-token', { headers: A });
  check('stream-token -> token', tok.status === 200 && tok.json && !!tok.json.token, tok.json);
  const badStream = await req(port, 'GET', '/v2/admin/stream?token=nope');
  check('stream bad token -> 403', badStream.status === 403, badStream.status);
  const stream = await sseFirst(port, '/v2/admin/stream?token=' + tok.json.token);
  check('stream emits initial state event', stream.status === 200 && stream.buf.includes('event: state'), stream.buf.slice(0, 40));

  realLog(`\n  RESULT: ${pass} passed, ${fail} failed\n`);
  process.exitCode = fail === 0 ? 0 : 1;
  try { server.close(); } catch (_) {}
  try { http.globalAgent.destroy(); } catch (_) {}
  const t = setTimeout(() => process.exit(process.exitCode), 1500); t.unref();
}
main().catch((e) => { realLog('DASHBOARD TEST ERROR:', e && e.stack || e); process.exit(2); });
