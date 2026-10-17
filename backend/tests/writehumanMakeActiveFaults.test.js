'use strict';
/**
 * MAKE-ACTIVE: FAULT INJECTION THROUGH THE REAL ROUTE.
 *
 * POST /admin/proxy-tools/:tool/devices/:deviceId/make-active caught every error and answered
 * `500 { error: 'Failed to start the activation' }`. The two polling-route fixes did not touch it,
 * so a request shed by the bounded pool queue (db/poolLimits.js) was reported to the operator as a
 * broken activation. The distinction matters here more than anywhere else in the admin surface:
 *
 *   503 DB_BUSY  nothing was queued, nothing was promoted, the previous source still serves.
 *                Clicking again shortly is correct and safe.
 *   500          something went wrong that a retry will not fix.
 *
 * These tests mount the REAL router in express and drive it over HTTP, so the assertions are about
 * the shipped handler rather than a copy of its logic. The fault is injected at the first await in
 * the route — ProxyAccount.find — which is BEFORE any state change, so no activation is created,
 * no command is queued and no source is switched by any case here.
 *
 * WHAT IS STUBBED, AND WHY THAT DOES NOT HIDE ANYTHING. requireAuth / requireAdmin / requireCsrf
 * are replaced with pass-throughs so these tests exercise error classification rather than
 * re-testing the auth gate, which proxyAssignableAuth.test.js already covers directly. The final
 * test here asserts STRUCTURALLY that the router still applies all three, so stubbing them cannot
 * conceal their removal.
 *
 * NO AUTOMATIC RETRY IS INTRODUCED. capture-and-activate is state-changing and its outcome is
 * uncertain once issued; re-issuing it on the server's own initiative could mint a second
 * activation for the same device. The retry decision stays with the operator.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('http');
const path = require('path');

process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-jwt-secret-0123456789abcdef0123456789';
process.env.JWT_REFRESH_SECRET = process.env.JWT_REFRESH_SECRET || 'test-refresh-secret-0123456789abcdef0123456789';
process.env.COOKIES_ENCRYPTION_KEY = process.env.COOKIES_ENCRYPTION_KEY
  || '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef';

const BACKEND = path.join(__dirname, '..');
const resolve = (m) => require.resolve(path.join(BACKEND, m));

/** Put a module in the require cache so the router picks up the stub when it is first required. */
function stub(modulePath, exports) {
  const id = resolve(modulePath);
  require.cache[id] = { id, filename: id, loaded: true, exports, children: [], paths: [] };
}

// The fault the test wants ProxyAccount.find to raise, swapped per case.
let nextFault = null;
let accountsToReturn = [];

stub('middleware/authEnhanced', {
  requireAuth: (req, _res, next) => { req.user = { role: 'ADMIN', isAdmin: () => true }; req.userId = 'test-admin'; next(); },
  requireAdmin: (_req, _res, next) => next(),
  getClientIp: () => '127.0.0.1',
});
stub('middleware/csrf', {
  COOKIE_NAME: 'csrf', HEADER_NAME: 'x-csrf-token', enforcing: () => false,
  issue: (_req, _res, next) => next(),
  requireCsrf: (_req, _res, next) => next(),
});
stub('models/proxy/ProxyAccount', {
  find: async () => { if (nextFault) throw nextFault; return accountsToReturn; },
  findById: async () => null,
});

// Required by the router at import time; none of these are reached before the injected fault.
stub('models/proxy/ProxyClient', { find: async () => [], findById: async () => null });
stub('models/proxy/ProxyLease', { find: async () => [], findById: async () => null });

const router = require(path.join(BACKEND, 'routes', 'admin', 'proxyTools.js'));
const express = require('express');

const app = express();
app.use(express.json());
app.use('/admin/proxy-tools', router);

let server;
let base;
test.before(async () => {
  await new Promise((done) => { server = app.listen(0, '127.0.0.1', done); });
  base = `http://127.0.0.1:${server.address().port}`;
});
test.after(async () => { await new Promise((done) => server.close(done)); });

function post(urlPath) {
  return new Promise((done, fail) => {
    const u = new URL(base + urlPath);
    const req = http.request({ hostname: u.hostname, port: u.port, path: u.pathname, method: 'POST',
      headers: { 'content-type': 'application/json', 'content-length': '2' } }, (res) => {
      let body = '';
      res.on('data', (c) => { body += c; });
      res.on('end', () => {
        let json = null;
        try { json = JSON.parse(body); } catch (_) { /* non-JSON is a finding in itself */ }
        done({ status: res.statusCode, headers: res.headers, json, raw: body });
      });
    });
    req.on('error', fail);
    req.end('{}');
  });
}

const MAKE_ACTIVE = '/admin/proxy-tools/writehuman/devices/agent_test_device/make-active';

test('DB SATURATION: make-active answers 503 + Retry-After, not 500', async () => {
  nextFault = new Error('Queue limit reached.');
  const r = await post(MAKE_ACTIVE);
  assert.equal(r.status, 503, 'a shed request must not read as a failed activation');
  assert.equal(r.headers['retry-after'], '5');
  assert.equal(r.json.code, 'DB_BUSY');
  assert.equal(r.json.retryAfter, 5);
  // The operator must not be told the activation itself broke.
  assert.ok(!/Failed to start the activation/.test(r.raw));
});

test('SATURATION BY DRIVER CODE: ER_CON_COUNT_ERROR is shed the same way', async () => {
  nextFault = Object.assign(new Error('Too many connections'), { code: 'ER_CON_COUNT_ERROR' });
  const r = await post(MAKE_ACTIVE);
  assert.equal(r.status, 503);
  assert.equal(r.json.code, 'DB_BUSY');
});

test('NON-SATURATION ERROR: a real fault still answers 500 with the existing message', async () => {
  for (const fault of [
    new Error('ER_PARSE_ERROR: bad SQL'),
    Object.assign(new Error('connect ECONNREFUSED'), { code: 'ECONNREFUSED' }),
    Object.assign(new Error('duplicate'), { code: 'ER_DUP_ENTRY' }),
  ]) {
    nextFault = fault;
    const r = await post(MAKE_ACTIVE);
    assert.equal(r.status, 500, `${fault.code || fault.message} must NOT be shed as 503`);
    assert.equal(r.json.ok, false);
    assert.equal(r.json.error, 'Failed to start the activation');
    assert.equal(r.headers['retry-after'], undefined, 'a real fault must not invite a retry');
  }
});

test('BUSINESS RESPONSE PRESERVED: no account still answers its own 404, not 500 or 503', async () => {
  nextFault = null;
  accountsToReturn = [];
  const r = await post(MAKE_ACTIVE);
  assert.equal(r.status, 404, 'the existing business error must survive the shedding change');
  assert.equal(r.json.error, 'No account');
});

test('ELIGIBILITY RESPONSE PRESERVED: an unknown device is refused on its own terms', async () => {
  nextFault = null;
  // A primary account with no paired devices: the device-eligibility path must answer, not throw.
  accountsToReturn = [{ isPrimary: true, tool: 'writehuman', devices: [], activeSource: null, save: async () => {} }];
  const r = await post(MAKE_ACTIVE);
  assert.ok(r.status !== 500 && r.status !== 503,
    `an unknown device must get its own refusal, got ${r.status} ${r.raw}`);
  assert.ok(r.json && r.json.ok === false, 'the refusal must be a structured ok:false response');
  assert.ok(r.json.code || r.json.error, 'the refusal must name a code or reason');
});

test('no response on any path leaks a cookie, token or credential', async () => {
  const forbidden = /sb-|auth-token|refresh|cookie|password|dpapi|Bearer |deviceKey|keyHash/i;
  nextFault = new Error('Queue limit reached.');
  const shed = await post(MAKE_ACTIVE);
  nextFault = new Error('ER_PARSE_ERROR');
  const failed = await post(MAKE_ACTIVE);
  for (const r of [shed, failed]) {
    assert.ok(!forbidden.test(r.raw), `response body leaked sensitive material: ${r.raw}`);
  }
});

test('the router still applies requireAuth, requireAdmin and requireCsrf', () => {
  // Stubbing those middlewares above must not be able to hide their removal from the real router.
  const fs = require('fs');
  const src = fs.readFileSync(path.join(BACKEND, 'routes', 'admin', 'proxyTools.js'), 'utf8');
  assert.match(src, /^router\.use\(requireAuth\);$/m, 'the admin router must keep requireAuth');
  assert.match(src, /^router\.use\(requireAdmin\);$/m, 'the admin router must keep requireAdmin');
  assert.match(src, /make-active', requireCsrf,/,
    'make-active is state-changing and must keep its CSRF guard');
});

test('make-active does not retry a state-changing activation on its own', () => {
  const fs = require('fs');
  const src = fs.readFileSync(path.join(BACKEND, 'routes', 'admin', 'proxyTools.js'), 'utf8');
  const start = src.indexOf("make-active', requireCsrf");
  const body = src.slice(start, src.indexOf('});', src.indexOf('Failed to start the activation')));
  assert.ok(!/for\s*\(|while\s*\(|setTimeout|retry\(/.test(body),
    'the activation path must not loop or re-issue: its outcome is uncertain once the command is '
    + 'queued, so an automatic retry could mint a second activation for the same device');
});

/**
 * THE READ-ONLY DIAGNOSTIC PATH ALREADY EXISTS — these tests establish that it is safe to export.
 *
 * Diagnosing a real "Mark as Active" failure needs the actual status, a sanitized code/state, a
 * timestamp and correlation IDs. GET /:tool/activation already returns exactly that, via
 * activation.publicView(): stage + state + inFlight/terminal, failureCode + failureMessage,
 * createdAt/stageAt/expiresAt/endedAt, and activationId/targetDeviceId/previousDeviceId/maskedId.
 *
 * So no new endpoint is added. What was missing is proof that the payload carries nothing it
 * should not, which is what makes it safe to paste into a bug report. These assertions pin that.
 */
test('the activation diagnostic exposes status, code, timestamps and correlation IDs', () => {
  const activation = require(path.join(BACKEND, 'utils', 'proxy', 'activation.js'));
  const now = new Date();
  const account = {
    activation: {
      activationId: 'act_abc123', targetDeviceId: 'agent_dev1', targetDeviceName: 'RDP-1',
      previousDeviceId: 'agent_dev0', stage: 'VERIFYING', state: 'IN_FLIGHT',
      failureCode: null, failureMessage: null, maskedId: 'c***@example.com', bundleVersion: 7,
      createdAt: now.toISOString(), stageAt: now.toISOString(),
      expiresAt: new Date(now.getTime() + 60000).toISOString(), endedAt: null,
      history: [{ stage: 'QUEUED', at: now.toISOString() }],
      nonce: 'super-secret-nonce-value', cookies: [{ name: 'sb-auth-token', value: 'LEAK' }],
      deviceKey: 'device-key-should-never-appear', keyHash: 'hash-should-never-appear',
    },
  };
  const view = activation.publicView(account, { now });
  assert.ok(view, 'publicView must render an in-flight activation');
  for (const field of ['stage', 'state', 'inFlight', 'terminal', 'activationId', 'targetDeviceId',
    'createdAt', 'stageAt', 'expiresAt', 'history']) {
    assert.ok(field in view, `the diagnostic must carry ${field}`);
  }
  assert.ok('failureCode' in view && 'failureMessage' in view,
    'a failure must be reportable by code, not guessed at');
});

test('the activation diagnostic never carries nonces, cookies or credentials', () => {
  const activation = require(path.join(BACKEND, 'utils', 'proxy', 'activation.js'));
  const now = new Date();
  const account = {
    activation: {
      activationId: 'act_abc123', targetDeviceId: 'agent_dev1', stage: 'FAILED', state: 'FAILED',
      failureCode: 'ACCOUNT_MISMATCH', failureMessage: 'captured session is a different account',
      createdAt: now.toISOString(), stageAt: now.toISOString(),
      expiresAt: new Date(now.getTime() + 1000).toISOString(), endedAt: now.toISOString(),
      history: [], maskedId: 'c***@example.com',
      // Everything below must be absent from the exported view.
      nonce: 'NONCE_LEAK', cookies: [{ name: 'sb-auth-token', value: 'COOKIE_LEAK' }],
      deviceKey: 'DEVICEKEY_LEAK', keyHash: 'KEYHASH_LEAK', password: 'PASSWORD_LEAK',
      refreshToken: 'REFRESH_LEAK', vault: 'VAULT_LEAK',
    },
  };
  const serialised = JSON.stringify(activation.publicView(account, { now }));
  for (const secret of ['NONCE_LEAK', 'COOKIE_LEAK', 'DEVICEKEY_LEAK', 'KEYHASH_LEAK',
    'PASSWORD_LEAK', 'REFRESH_LEAK', 'VAULT_LEAK']) {
    assert.ok(!serialised.includes(secret), `the diagnostic leaked ${secret}`);
  }
  // The sanitized failure code IS wanted — that is the whole point of exporting it.
  assert.match(serialised, /ACCOUNT_MISMATCH/);
  // A masked identifier is acceptable; a raw address is not.
  assert.ok(!/@example\.com"/.test(serialised.replace(/c\*\*\*@example\.com/g, '')),
    'only masked identifiers may appear');
});

test('the activation diagnostic route is a GET and changes nothing', () => {
  const fs = require('fs');
  const src = fs.readFileSync(path.join(BACKEND, 'routes', 'admin', 'proxyTools.js'), 'utf8');
  const start = src.indexOf("router.get('/:tool/activation'");
  assert.ok(start > -1, 'the read-only activation diagnostic route must exist');
  const body = src.slice(start, src.indexOf('router.', start + 10));

  // It must not drive the state machine: no new activation, no failure recorded, no promotion.
  assert.ok(!/activation\.(create|fail|advance|promote)\(/.test(body),
    'the diagnostic must not drive the activation state machine — it is what an operator calls '
    + 'while triaging, and triage must not change the thing being triaged');

  // ONE write is legitimate and documented: current() expires a stale transaction in place, so a
  // read may need to persist that expiry. Pin it to exactly that guarded case rather than banning
  // save() outright, and require the comment to stay so the exception keeps its justification.
  const saves = [...body.matchAll(/await account\.save\(\)/g)];
  assert.equal(saves.length, 1, 'the diagnostic may persist at most the lazy stale-expiry');
  assert.match(body, /stage === 'EXPIRED' && !live\.persisted/,
    "the only write must be guarded by the stale-expiry condition");
  assert.match(body, /can legitimately need to persist/,
    'the documented reason for that single write must stay with it');
});
