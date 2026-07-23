'use strict';
/**
 * Claude mobile: a Cloudflare challenge is a RECOVERABLE condition, never proof of a dead account.
 *
 * ROOT CAUSE this pins: classifyUpstreamFailure used to map "CF challenge + the vault bundle carries
 * no cf_clearance" to ACCOUNT_SESSION_INVALID → the operator-facing "needs to be reconnected / please
 * contact support" page. But the live diagnostic that added the nav-retry logic proved the vault
 * essentially NEVER carries a cf_clearance (25/25 sampled navigations: none), while those same
 * navigations alternate 200 ⇄ 403 with identical cookies and mostly clear on a retry. So the absence
 * of a vault clearance says nothing about session validity, and that branch fired the reconnect page
 * for a perfectly valid account on any transient datacenter-IP challenge.
 *
 * The rest of the suite (mobileIdentity.test.js) can't catch this: its mock vault bundle DOES include
 * a cf_clearance, so it only ever exercises the has-clearance path. This file boots the gateway
 * against a backend whose vault bundle has NO cf_clearance — the real production condition — and
 * asserts the post-retry notice is the recoverable "verify / try again" wording, NOT the
 * account-needs-reconnecting / contact-support wording. It is device-independent on purpose (the live
 * log showed every request classifying as 'desktop'), so both a phone and a desktop are checked.
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
  const p = b64({ jti: 'cfjti' + crypto.randomBytes(3).toString('hex'), sub: 'u1', tool: 'claude', type: 'proxy_lease', exp: Math.floor(Date.now() / 1000) + 1800 });
  const sig = crypto.createHmac('sha256', SECRET).update(h + '.' + p).digest('base64').replace(/=/g, '').replace(/\+/g, '-').replace(/\//g, '_');
  return h + '.' + p + '.' + sig;
}
const UA_DESKTOP = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36';
const UA_ANDROID = 'Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Mobile Safari/537.36';

let proc, upstream, backend, GW_PORT;

test.before(async () => {
  // Mock backend — the vault bundle carries auth cookies but DELIBERATELY NO cf_clearance, which is
  // exactly what the live gateway showed (25/25 navs had none). This is the condition the old code
  // mislabeled as an invalid account session.
  backend = http.createServer((q, r) => {
    let body = ''; q.on('data', c => body += c);
    q.on('end', () => {
      r.setHeader('content-type', 'application/json');
      if (q.url.endsWith('/session')) return r.end(JSON.stringify({ ok: true, account: { id: 'acc1', maskedId: 'a***1' }, bundle: { cookies: [{ name: 'sessionKey', value: 'VAULT_SECRET' }] } }));
      if (q.url.endsWith('/validate')) return r.end(JSON.stringify({ valid: true, secondsRemaining: 1800 }));
      r.end('{}');
    });
  });
  await new Promise((res) => backend.listen(0, res));
  const bePort = backend.address().port;
  // Mock claude.ai — always answers a Cloudflare managed-challenge on the challenge path, so the
  // nav retries are exhausted and the gateway must fall through to classifyUpstreamFailure.
  upstream = http.createServer((q, r) => {
    // A GENERIC always-challenged nav path. (Not /api/challenge_redirect, which is now specially
    // bounced for mobile — see test/mobileXhrShield.test.js. This test is about the message
    // CLASSIFICATION of a surviving challenge, so it needs a path that still reaches the notice.)
    if (q.url.split('?')[0] === '/perma-challenge') {
      r.writeHead(403, { 'content-type': 'text/html', server: 'cloudflare', 'cf-ray': '9abc123', 'cf-mitigated': 'challenge' });
      return r.end('<html><body>Verifying you are human… <script>window.location.reload()</script></body></html>');
    }
    r.writeHead(200, { 'content-type': 'text/html' });
    r.end('<html><head></head><body>ok</body></html>');
  });
  await new Promise((res) => upstream.listen(0, res));
  const upPort = upstream.address().port;

  GW_PORT = 18861;
  const env = Object.assign({}, process.env, {
    PORT: String(GW_PORT), TOOL_KEY: 'claude', TOOL_NAME: 'Claude AI',
    TARGET_ORIGIN: 'http://127.0.0.1:' + upPort,
    GATEWAY_PUBLIC_ORIGIN: 'http://127.0.0.1:' + GW_PORT, DEFAULT_PATH: '/new', SIGNIN_PATH: '/login',
    API_BASE: 'http://127.0.0.1:' + bePort + '/api', LEASE_SECRET: SECRET, GATEWAY_KEY: 'k'.repeat(32),
    CF_CHALLENGE_PASSTHROUGH: '1', CF_CHALLENGE_MODE: 'passthrough',
    // Keep the retry+notice path but small so the test stays quick.
    CLAUDE_CF_NAV_RETRIES: '1', CLAUDE_CF_NAV_RETRY_DELAY_MS: '150',
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

async function openSession() {
  const lease = mintLease();
  const r = await get('/gateway?lease=' + encodeURIComponent(lease), { 'user-agent': UA_DESKTOP });
  const sc = [].concat(r.headers['set-cookie'] || []).find(c => /claude_session=/.test(c));
  assert.ok(sc, 'lease exchange must set an opaque session cookie');
  return sc.split(';')[0];
}

// The core regression: a vault with NO cf_clearance must NOT be reported as an invalid account.
function assertRecoverableNotice(r) {
  assert.strictEqual(r.status, 503, 'a recoverable notice, not the 403 challenge document');
  assert.match(r.body, /try again/i, 'offers a MANUAL retry');
  assert.match(r.body, /verify the connection|routine security check|still active/i, 'recoverable Cloudflare wording');
  assert.ok(!/needs to be reconnected/i.test(r.body), 'NOT the account-needs-reconnecting page');
  assert.ok(!/contact support/i.test(r.body), 'NOT the "please contact support" account-invalid wording');
  assert.ok(!/Verifying you are human/i.test(r.body), 'the self-reloading challenge document is not replayed');
  assert.ok(!/location\.reload|window\.location\s*=|http-equiv=["']?refresh/i.test(r.body), 'nothing in it reloads on its own');
}

test('mobile, vault has NO cf_clearance: a surviving CF challenge is recoverable, NOT "needs to be reconnected"', async () => {
  const sess = await openSession();
  const r = await get('/perma-challenge', { cookie: sess, 'user-agent': UA_ANDROID, 'sec-ch-ua-mobile': '?1', accept: 'text/html' });
  assertRecoverableNotice(r);
});

test('desktop, vault has NO cf_clearance: same recoverable notice — the failure is device-independent', async () => {
  const sess = await openSession();
  const r = await get('/perma-challenge', { cookie: sess, 'user-agent': UA_DESKTOP, 'sec-ch-ua-mobile': '?0', accept: 'text/html' });
  assertRecoverableNotice(r);
});
