'use strict';
/**
 * Regression protection for the RECURRING Claude-mobile Cloudflare-verification bug.
 *
 * The mobile fix (device-consistent identity, per-device cf_clearance, durable opaque session,
 * CF challenge passthrough) is enforced in code and covered by mobileIdentity / durableSession /
 * mobileRelaunch tests. But three of its requirements are CONFIGURED SERVER-SIDE in this gateway's
 * .htaccess (outside the repo): CF_CHALLENGE_PASSTHROUGH, CF_CHALLENGE_MODE=passthrough and
 * CLAUDE_PER_DEVICE_CLEARANCE. A redeploy or a hand-edit can silently flip one and the mobile fix
 * quietly regresses — repo tests stay green, /__genz/health stays 200, and a user rediscovers the
 * loop. Plus the durable session store must stay WRITABLE or the opaque session can't survive a
 * Passenger worker recycle (→ reload into the verification page).
 *
 * These tests assert the gateway now SURFACES those invariants (in /__genz/health .claudeMobile and
 * a loud boot warning) so the drift is caught by a deploy/monitoring check instead of by a phone.
 * They are meaningful: the misconfigured boot below is exactly the state that reintroduced the bug.
 */
const test = require('node:test');
const assert = require('node:assert');
const http = require('http');
const path = require('path');
const { spawn } = require('node:child_process');

const GW = path.resolve(__dirname, '..');
const SECRET = 'x'.repeat(48);

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

let upstream, backend;

// Boot a gateway with a given env overlay, capturing its stderr so the boot warning is observable.
function bootGateway(port, envOverride) {
  const env = Object.assign({}, process.env, {
    PORT: String(port), TOOL_KEY: 'claude', TOOL_NAME: 'Claude AI',
    TARGET_ORIGIN: 'http://127.0.0.1:' + upstream.address().port,
    GATEWAY_PUBLIC_ORIGIN: 'http://127.0.0.1:' + port, DEFAULT_PATH: '/new', SIGNIN_PATH: '/login',
    API_BASE: 'http://127.0.0.1:' + backend.address().port + '/api',
    LEASE_SECRET: SECRET, GATEWAY_KEY: 'k'.repeat(32), PROXY_LOG_ALL: '0',
  }, envOverride || {});
  const p = spawn(process.execPath, ['server.js'], { cwd: GW, env, stdio: ['ignore', 'pipe', 'pipe'] });
  p.stderrBuf = ''; p.stdoutBuf = '';
  p.stderr.on('data', c => { p.stderrBuf += c.toString(); });
  p.stdout.on('data', c => { p.stdoutBuf += c.toString(); });
  return p;
}
async function waitHealth(port) {
  const t0 = Date.now();
  while (Date.now() - t0 < 15000) {
    const r = await reqTo(port, 'GET', '/__genz/health');
    if (r.status === 200 || r.status === 503) return r;
    await new Promise(r => setTimeout(r, 150));
  }
  throw new Error('gateway ' + port + ' did not boot');
}

test.before(async () => {
  upstream = http.createServer((req, res) => { res.writeHead(200, { 'content-type': 'text/html' }); res.end('<html>CLAUDE_APP_OK</html>'); });
  backend = http.createServer((req, res) => { res.writeHead(200, { 'content-type': 'application/json' }); res.end('{"valid":true}'); });
  await new Promise(r => upstream.listen(0, r));
  await new Promise(r => backend.listen(0, r));
});
test.after(() => { try { upstream.close(); } catch (_) {} try { backend.close(); } catch (_) {} });

test('MOBILE-SAFE config → health reports claudeMobile.mobileReady:true and every invariant On', async () => {
  const PORT = 3611;
  const gw = bootGateway(PORT, { CF_CHALLENGE_PASSTHROUGH: '1', CF_CHALLENGE_MODE: 'passthrough' });
  try {
    const h = await waitHealth(PORT);
    assert.strictEqual(h.status, 200, 'a correctly configured gateway is healthy');
    const body = JSON.parse(h.body);
    assert.ok(body.claudeMobile, 'health must expose the claudeMobile block for the claude tool');
    assert.strictEqual(body.claudeMobile.mobileReady, true, 'mobileReady must be true when all invariants hold');
    assert.strictEqual(body.claudeMobile.cfChallengePassthrough, true);
    assert.strictEqual(body.claudeMobile.cfChallengeMode, 'passthrough');
    assert.strictEqual(body.claudeMobile.perDeviceClearance, true);
    assert.strictEqual(body.claudeMobile.durableSessionStore, true, 'tmp/sessions must be writable');
    assert.doesNotMatch(gw.stderrBuf + gw.stdoutBuf, /MOBILE CONFIG DRIFT/, 'no drift warning when correctly configured');
  } finally { gw.kill(); }
});

test('DRIFTED config (no passthrough + per-device clearance off) → health flags it AND the boot warns loud', async () => {
  const PORT = 3612;
  // Exactly the regression: CF passthrough removed (→ mode defaults to 'block') and the
  // per-device clearance kill-switch set. This is the state that made phones loop on verification.
  const gw = bootGateway(PORT, { CF_CHALLENGE_PASSTHROUGH: '', CLAUDE_PER_DEVICE_CLEARANCE: '0' });
  try {
    const h = await waitHealth(PORT);
    // Still a 200 (not fatal — documented kill-switches exist), but clearly marked not-mobile-ready.
    assert.strictEqual(h.status, 200, 'drift must NOT force 503 (no restart loop)');
    const body = JSON.parse(h.body);
    assert.ok(body.claudeMobile, 'claudeMobile block present');
    assert.strictEqual(body.claudeMobile.mobileReady, false, 'mobileReady must be false under drift');
    assert.strictEqual(body.claudeMobile.cfChallengePassthrough, false);
    assert.notStrictEqual(body.claudeMobile.cfChallengeMode, 'passthrough');
    assert.strictEqual(body.claudeMobile.perDeviceClearance, false);
    // The loud boot warning is the signal that stops a silent regression.
    await new Promise(r => setTimeout(r, 200)); // let the listen callback flush
    assert.match(gw.stderrBuf, /MOBILE CONFIG DRIFT/, 'boot must warn loudly about mobile config drift');
    assert.match(gw.stderrBuf, /cfChallengePassthrough/, 'the warning names the offending flags');
    assert.match(gw.stderrBuf, /perDeviceClearance/);
  } finally { gw.kill(); }
});

test('the mobile invariants are CLAUDE-ONLY (a non-claude gateway health has no claudeMobile block)', async () => {
  const PORT = 3613;
  const gw = bootGateway(PORT, { TOOL_KEY: 'hix', TOOL_NAME: 'Hix', CF_CHALLENGE_PASSTHROUGH: '1', CF_CHALLENGE_MODE: 'passthrough' });
  try {
    const h = await waitHealth(PORT);
    const body = JSON.parse(h.body);
    assert.strictEqual(body.claudeMobile, undefined, 'only the claude tool reports mobile invariants');
    assert.doesNotMatch(gw.stderrBuf, /MOBILE CONFIG DRIFT/, 'non-claude tools never emit the claude mobile warning');
  } finally { gw.kill(); }
});
