'use strict';
/**
 * The proxy-gateway router must not put a per-IP budget on server-to-server calls.
 *
 * ROOT CAUSE this pins. `router.use(apiLimiter)` applied a 100-request/15-minute PER-IP budget to
 * every route on this router. For Claude that is one bucket for ALL clients at once: the browser
 * cannot read Claude's lease JWT (it holds only an opaque HttpOnly session id), so the overlay calls
 * the GATEWAY and the gateway relays /validate, /session, /quota-status, /quota-precheck and
 * /usage-report itself — all from the gateway server's single, stable egress IP. One open tab spends
 * roughly that entire budget per window (≈30 /validate + ≈30 /quota-status + ≈15 /session, plus two
 * calls per message), so the budget was exhausted mid-session and every further call got a 429.
 * The gateway then rendered the 429 on /session as a terminal "session ended / Access could not be
 * verified" page (see claude-gateway/test/accountSessionTransient.test.js for that half).
 *
 * The blanket mount also silently defeated /validate's dedicated validateLimiter, which exists
 * specifically so liveness polling does not share the general API budget.
 *
 * These tests drive the REAL router. Every request here stops at an auth gate before any database
 * work (no gateway key → 403; no/!invalid lease → 401), which is enough to exercise the limiter that
 * runs in front of it. Limits are shrunk via env so the test is fast; the keying is what matters.
 *
 * Run: node --test tests/gatewayRateLimit.test.js
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('http');

// Must be set BEFORE the limiters are constructed at require time.
process.env.GATEWAY_SERVICE_RATE_LIMIT_MAX = '5';
process.env.VALIDATE_RATE_LIMIT_MAX = '5';
process.env.RATE_LIMIT_MAX_REQUESTS = '5';
process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-jwt-secret-0123456789abcdef0123456789';
process.env.JWT_REFRESH_SECRET = process.env.JWT_REFRESH_SECRET || 'test-refresh-secret-0123456789abcdef0123456789';
process.env.COOKIES_ENCRYPTION_KEY = process.env.COOKIES_ENCRYPTION_KEY || '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef';
process.env.PROXY_LEASE_SECRET = process.env.PROXY_LEASE_SECRET || 'x'.repeat(48);
process.env.PROXY_GATEWAY_KEY = process.env.PROXY_GATEWAY_KEY || 'k'.repeat(32);

const express = require('express');
const gatewayRouter = require('../routes/proxy/gateway');
const { leaseKey } = require('../middleware/rateLimiter');

let server, PORT;

test.before(async () => {
  const app = express();
  app.set('trust proxy', 1);
  app.use(express.json());
  app.use('/api/crm/proxy/gateway', gatewayRouter);
  await new Promise((r) => { server = app.listen(0, r); });
  PORT = server.address().port;
});
test.after(() => { try { server.close(); } catch (_) {} });

function post(path, headers) {
  return new Promise((resolve) => {
    const body = Buffer.from('{}');
    const req = http.request({
      port: PORT, path: '/api/crm/proxy/gateway' + path, method: 'POST',
      headers: Object.assign({ 'content-type': 'application/json', 'content-length': body.length }, headers || {}),
    }, (res) => {
      const b = []; res.on('data', c => b.push(c));
      res.on('end', () => {
        let parsed = {};
        try { parsed = JSON.parse(Buffer.concat(b).toString('utf8') || '{}'); } catch (_) {}
        resolve({ status: res.statusCode, body: parsed });
      });
    });
    req.on('error', () => resolve({ status: 0, body: {} }));
    req.end(body);
  });
}

// Distinct fake leases. They never verify (that is fine — the limiter runs first), but they are
// distinct Bearer tokens, which is exactly what the per-lease key buckets on.
const lease = (n) => 'Bearer fake.lease.token.' + n;
// One fixed forwarded IP for the whole file: this is the gateway server's stable egress IP, the
// condition that made the old per-IP key collapse into a single bucket.
const GATEWAY_IP = { 'x-forwarded-for': '203.0.113.7' };
const withLease = (n) => Object.assign({ authorization: lease(n) }, GATEWAY_IP);

test('leaseKey buckets by lease when a bearer token is present, and never exposes the token', () => {
  const a = leaseKey({ headers: { authorization: 'Bearer secret-token-aaa' } });
  const b = leaseKey({ headers: { authorization: 'Bearer secret-token-bbb' } });
  assert.notEqual(a, b, 'different leases are different buckets');
  assert.equal(a, leaseKey({ headers: { authorization: 'Bearer secret-token-aaa' } }), 'stable for one lease');
  assert.ok(a.startsWith('lease:'), 'namespaced');
  assert.ok(!a.includes('secret-token-aaa'), 'the token itself never reaches the key');
});

test('leaseKey falls back to the real client IP when there is no bearer token', () => {
  const k = leaseKey({ headers: { 'x-forwarded-for': '198.51.100.4, 203.0.113.9' }, ip: '10.0.0.1' });
  assert.equal(k, '198.51.100.4', 'first X-Forwarded-For hop, as before');
});

test('/session: many DIFFERENT leases from ONE IP are never collectively rate-limited', async () => {
  // 40 > the old 100/15min bucket is not needed to prove the point: with a per-IP key these all
  // share one bucket whose max is 5 here, so a per-IP key would 429 from the 6th request on.
  const results = [];
  for (let i = 0; i < 40; i++) results.push(await post('/session', withLease('sess-' + i)));
  const limited = results.filter(r => r.status === 429);
  assert.equal(limited.length, 0,
    `no client may consume another client's budget on a gateway-only endpoint (got ${limited.length} × 429)`);
  assert.ok(results.every(r => r.status === 403),
    'each request still stopped at the gateway-key gate — the limiter did not replace the auth check');
});

test('/session: a single lease still has a ceiling, and its 429 is explicitly retryable', async () => {
  let last = null;
  for (let i = 0; i < 9; i++) last = await post('/session', withLease('flood-one'));
  assert.equal(last.status, 429, 'a runaway loop on one lease is still throttled');
  assert.equal(last.body.code, 'rate_limited', 'machine-readable');
  assert.equal(last.body.terminal, false, 'and NOT a terminal authorization denial');
  assert.equal(last.body.retryable, true, 'the gateway must retry rather than end the session');
  // A different lease is unaffected by that flood.
  const other = await post('/session', withLease('flood-bystander'));
  assert.equal(other.status, 403, 'an unrelated session is untouched');
});

test('/validate: per-lease budget, so one session cannot lock another out from the same IP', async () => {
  let last = null;
  for (let i = 0; i < 9; i++) last = await post('/validate', withLease('val-heavy'));
  assert.equal(last.status, 429, 'its own budget is enforced');
  assert.equal(last.body.terminal, false, 'a 429 from liveness polling is never terminal');
  assert.equal(last.body.retryable, true);
  assert.equal(last.body.valid, false);
  const other = await post('/validate', withLease('val-quiet'));
  assert.equal(other.status, 401, 'a different lease still gets a real answer (lease_invalid), not a 429');
  assert.equal(other.body.terminal, true, 'and that answer is the genuine confirmed denial');
});

test('/validate is not also charged to the general API budget (the double-count that defeated it)', async () => {
  // Spend the general per-IP apiLimiter budget on a non-exempt path...
  for (let i = 0; i < 9; i++) await post('/not-a-real-route', GATEWAY_IP);
  // ...then confirm /validate for a fresh lease still answers.
  const r = await post('/validate', withLease('val-after-api-burn'));
  assert.notEqual(r.status, 429, '/validate has its own budget and must not inherit the general one');
});

test('anything NOT exempted keeps the general per-IP apiLimiter exactly as before', async () => {
  let last = null;
  for (let i = 0; i < 9; i++) last = await post('/some-other-path', { 'x-forwarded-for': '198.51.100.77' });
  assert.equal(last.status, 429, 'the general limiter is still mounted for everything else');
  assert.equal(last.body.code, 'rate_limited');
});
