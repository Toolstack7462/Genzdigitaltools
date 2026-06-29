'use strict';
/**
 * WriteHuman V2 — production-backed validate mode test (runs in its own process so the V2
 * module graph boots with WRITEHUMAN_V2_PROD_LEASE_SECRET set).
 *
 * Boots V2 against a FAKE production backend exposing POST /validate, and asserts:
 *   - mode reports production-backed
 *   - a prod-signed lease is accepted when prod /validate says valid (uses prod secondsRemaining)
 *   - an authoritative prod rejection (revoked) → V2 returns invalid
 *   - a prod 5xx/outage → V2 FALLS BACK to local signature+expiry (valid, never locks out)
 *   - a bad-signature lease is rejected locally without ever calling prod
 *
 * Run: node test/prodmode.js   (exit 0 = pass)
 */
const http = require('http');
const fs = require('fs');
const os = require('os');
const path = require('path');

const realLog = console.log.bind(console);
function listen(srv) { return new Promise((r) => srv.listen(0, '127.0.0.1', () => r(srv.address().port))); }
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
function check(name, cond, detail) { if (cond) { pass++; realLog('  ✓', name); } else { fail++; realLog('  ✗', name, detail != null ? '→ ' + JSON.stringify(detail) : ''); } }

async function main() {
  // Fake production backend: POST /validate returns whatever `verdict` is set to.
  let verdict = { status: 200, body: { valid: true, tool: 'writehuman', secondsRemaining: 1234 } };
  let prodHits = 0;
  const fakeProd = http.createServer((rq, rs) => {
    if (rq.method === 'POST' && rq.url === '/validate') {
      prodHits++; rs.writeHead(verdict.status, { 'content-type': 'application/json' }); rs.end(JSON.stringify(verdict.body)); return;
    }
    rs.writeHead(404); rs.end();
  });
  const prodPort = await listen(fakeProd);

  const PROD_SECRET = 'prod-lease-secret-ABCDEFGHIJKLMNOPQRST'; // ≥16
  const ADMIN = 'pm-admin-key';
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'whv2pm-'));
  Object.assign(process.env, {
    WRITEHUMAN_V2_PORT: '0',
    WRITEHUMAN_V2_TARGET_ORIGIN: 'http://127.0.0.1:1',          // unused here
    WRITEHUMAN_V2_STORE: 'json',
    WRITEHUMAN_V2_DATA_DIR: tmp,
    WRITEHUMAN_V2_ADMIN_KEY: ADMIN,
    WRITEHUMAN_V2_SECRET: 'base-secret-prodmode-1234567890',
    WRITEHUMAN_V2_SCHEDULER: '0',
    // Enable production-backed mode:
    WRITEHUMAN_V2_PROD_LEASE_SECRET: PROD_SECRET,
    WRITEHUMAN_V2_PROD_API_BASE: 'http://127.0.0.1:' + prodPort,
  });

  const { server } = require('../server');
  await new Promise((r) => (server.listening ? r() : server.once('listening', r)));
  const port = server.address().port;
  const adminH = { 'x-admin-key': ADMIN };

  realLog('\n── production-backed validate ────────────────────');
  const h = await req(port, 'GET', '/v2/health');
  check('health reports production-backed', h.json && h.json.mode === 'production-backed' && h.json.prodValidate === true, h.json && h.json.mode);

  // A lease minted now is signed with the prod secret (effectiveLeaseSecret) → simulates a
  // production-minted lease.
  const lz = await req(port, 'POST', '/v2/admin/lease', { headers: adminH, body: {} });
  const token = lz.json && lz.json.token;
  check('minted a (prod-signed) lease', !!token);

  verdict = { status: 200, body: { valid: true, tool: 'writehuman', secondsRemaining: 1234 } };
  let before = prodHits;
  const v1 = await req(port, 'POST', '/v2/validate', { headers: { authorization: 'Bearer ' + token } });
  check('prod says valid → valid:true (uses prod secondsRemaining)', v1.status === 200 && v1.json && v1.json.valid === true && v1.json.secondsRemaining === 1234, v1.json);
  check('prod /validate was actually consulted', prodHits === before + 1, { before, after: prodHits });

  verdict = { status: 403, body: { valid: false, code: 'lease_revoked' } };
  const v2 = await req(port, 'POST', '/v2/validate', { headers: { authorization: 'Bearer ' + token } });
  check('prod revokes → V2 returns invalid (lease_revoked)', v2.status === 403 && v2.json && v2.json.valid === false && v2.json.code === 'lease_revoked', v2.json);

  verdict = { status: 500, body: {} };
  const v3 = await req(port, 'POST', '/v2/validate', { headers: { authorization: 'Bearer ' + token } });
  check('prod 5xx outage → fall back to local (valid, no lockout)', v3.status === 200 && v3.json && v3.json.valid === true, v3.json);

  before = prodHits;
  const vbad = await req(port, 'POST', '/v2/validate', { headers: { authorization: 'Bearer bad.sig.token' } });
  check('bad-signature lease → 401 locally, prod NOT called', vbad.status === 401 && prodHits === before, { status: vbad.status, hits: prodHits, before });

  realLog(`\n  RESULT: ${pass} passed, ${fail} failed\n`);
  process.exitCode = fail === 0 ? 0 : 1;
  try { fakeProd.close(); server.close(); } catch (_) {}
  try { http.globalAgent.destroy(); } catch (_) {}
  const t = setTimeout(() => process.exit(process.exitCode), 1500); t.unref();
}
main().catch((e) => { realLog('PRODMODE ERROR:', e && e.stack || e); process.exit(2); });
