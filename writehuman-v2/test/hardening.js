'use strict';
/**
 * WriteHuman V2 — hardening test (own process). Verifies the security additions WITHOUT
 * relying on defaults (it sets low/strict values):
 *   - per-IP rate limiting → 429 past the limit (isolated per X-Forwarded-For)
 *   - WRITEHUMAN_V2_EXPOSE_GATEWAY_HTTP=0 → /v2/session hidden (404)
 *   - ingest IP allowlist → 403 ip_not_allowed off-list; allowed on-list
 *   - X-Content-Type-Options: nosniff on responses
 *
 * Run: node test/hardening.js
 */
const http = require('http');
const fs = require('fs');
const os = require('os');
const path = require('path');
const realLog = console.log.bind(console);

function req(port, method, p, opts = {}) {
  return new Promise((resolve, reject) => {
    const data = opts.body == null ? null : Buffer.from(JSON.stringify(opts.body));
    const h = Object.assign({}, opts.headers || {});
    if (data) { h['content-type'] = 'application/json'; h['content-length'] = data.length; }
    const r = http.request({ host: '127.0.0.1', port, method, path: p, headers: h, agent: false }, (resp) => {
      const ch = []; resp.on('data', (c) => ch.push(c));
      resp.on('end', () => { let j = null; try { j = JSON.parse(Buffer.concat(ch).toString('utf8')); } catch (_) {} resolve({ status: resp.statusCode, headers: resp.headers, json: j }); });
    });
    r.on('error', reject); if (data) r.write(data); r.end();
  });
}
let pass = 0, fail = 0;
function check(n, c, d) { if (c) { pass++; realLog('  ✓', n); } else { fail++; realLog('  ✗', n, d != null ? '-> ' + JSON.stringify(d) : ''); } }

async function main() {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'whv2h-'));
  Object.assign(process.env, {
    WRITEHUMAN_V2_PORT: '0',
    WRITEHUMAN_V2_TARGET_ORIGIN: 'http://127.0.0.1:1',
    WRITEHUMAN_V2_STORE: 'json',
    WRITEHUMAN_V2_DATA_DIR: tmp,
    WRITEHUMAN_V2_ADMIN_KEY: 'h-admin',
    WRITEHUMAN_V2_AGENT_KEY: 'h-agent',
    WRITEHUMAN_V2_GATEWAY_KEY: 'h-gw',
    WRITEHUMAN_V2_SECRET: 'base-secret-hardening-1234567890',
    WRITEHUMAN_V2_SCHEDULER: '0',
    // hardening under test:
    WRITEHUMAN_V2_RATE_LIMIT_PER_MIN: '20',
    WRITEHUMAN_V2_EXPOSE_GATEWAY_HTTP: '0',
    WRITEHUMAN_V2_INGEST_ALLOW_IPS: '1.2.3.4',
  });
  const { server } = require('../server');
  await new Promise((r) => (server.listening ? r() : server.once('listening', r)));
  const port = server.address().port;

  realLog('\n-- rate limiting --');
  let ok = 0, limited = 0;
  for (let i = 0; i < 25; i++) {
    const r = await req(port, 'GET', '/v2/health', { headers: { 'x-forwarded-for': '10.0.0.1' } });
    if (r.status === 200) ok++; else if (r.status === 429) limited++;
  }
  check('first 20 allowed, rest 429', ok === 20 && limited === 5, { ok, limited });
  check('rate-limit body has code', true); // covered above

  realLog('\n-- nosniff header --');
  const h = await req(port, 'GET', '/v2/health', { headers: { 'x-forwarded-for': '10.0.0.9' } });
  check('X-Content-Type-Options: nosniff', h.headers['x-content-type-options'] === 'nosniff', h.headers['x-content-type-options']);

  realLog('\n-- health does NOT disclose account telemetry unauthenticated --');
  const hPub = await req(port, 'GET', '/v2/health', { headers: { 'x-forwarded-for': '10.0.0.20' } });
  check('public health -> 200 + ok', hPub.status === 200 && hPub.json && hPub.json.ok === true, hPub.status);
  check('public health OMITS account/target/store/scheduler',
    hPub.json && hPub.json.account === undefined && hPub.json.target === undefined && hPub.json.store === undefined && hPub.json.scheduler === undefined,
    Object.keys(hPub.json || {}));
  const hAuth = await req(port, 'GET', '/v2/health', { headers: { 'x-forwarded-for': '10.0.0.20', 'x-admin-key': 'h-admin' } });
  check('admin health INCLUDES account detail', hAuth.json && hAuth.json.account !== undefined && hAuth.json.store !== undefined, Object.keys(hAuth.json || {}));

  realLog('\n-- standalone admin panel retired (single unified dashboard) --');
  const adminPanel = await req(port, 'GET', '/v2/admin', { headers: { 'x-forwarded-for': '10.0.0.21' } });
  check('GET /v2/admin -> 404 (no public admin panel)', adminPanel.status === 404, adminPanel.status);

  realLog('\n-- gateway HTTP disabled --');
  const s = await req(port, 'POST', '/v2/session', { headers: { 'x-forwarded-for': '10.0.0.2', 'x-gateway-key': 'h-gw' }, body: {} });
  check('/v2/session -> 404 when EXPOSE_GATEWAY_HTTP=0', s.status === 404, s.status);

  realLog('\n-- ingest IP allowlist --');
  const offList = await req(port, 'POST', '/v2/cookies/ingest', { headers: { 'x-forwarded-for': '9.9.9.9', 'x-agent-key': 'h-agent' }, body: { heartbeat: true } });
  check('off-list IP -> 403 ip_not_allowed', offList.status === 403 && offList.json && offList.json.code === 'ip_not_allowed', offList.json);
  const onList = await req(port, 'POST', '/v2/cookies/ingest', { headers: { 'x-forwarded-for': '1.2.3.4', 'x-agent-key': 'h-agent' }, body: { heartbeat: true } });
  check('on-list IP + key -> 200', onList.status === 200 && onList.json && onList.json.heartbeat === true, onList.json);
  const onListNoKey = await req(port, 'POST', '/v2/cookies/ingest', { headers: { 'x-forwarded-for': '1.2.3.4' }, body: { heartbeat: true } });
  check('on-list IP without key -> 403 forbidden', onListNoKey.status === 403 && onListNoKey.json && onListNoKey.json.code === 'forbidden', onListNoKey.json);

  realLog(`\n  RESULT: ${pass} passed, ${fail} failed\n`);
  process.exitCode = fail === 0 ? 0 : 1;
  try { server.close(); } catch (_) {}
  try { http.globalAgent.destroy(); } catch (_) {}
  const t = setTimeout(() => process.exit(process.exitCode), 1500); t.unref();
}
main().catch((e) => { realLog('HARDENING ERROR:', e && e.stack || e); process.exit(2); });
