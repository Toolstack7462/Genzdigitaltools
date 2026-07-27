'use strict';
/**
 * The StealthWriter gateway router must key /validate and /consume PER LEASE, not per IP.
 *
 * ROOT CAUSE this pins. These two endpoints used to be called DIRECTLY FROM THE BROWSER by the
 * injected overlay, which read the lease out of the non-HttpOnly `sw_lease` cookie. A per-IP
 * budget was therefore per-client, and correct — which is why middleware/rateLimiter.js says
 * validateLimiter "is left exactly as it is, so the StealthWriter router keeps its current
 * per-IP behaviour".
 *
 * The one-time POST launch bootstrap invalidated that premise: the lease now lives in an
 * HttpOnly `__Host-stealth_session` cookie the page cannot read, so the overlay calls the
 * gateway's same-origin /__genz/validate and /__genz/consume and the GATEWAY relays them —
 * from its single stable egress IP. Under per-IP keying every StealthWriter client would share
 * one bucket: 400/15min for all liveness polling, and only 100/15min (apiLimiter) for ALL
 * humanize/detect actions across every user combined. That is the same shared-bucket failure
 * that surfaced on Claude as a terminal "session ended" screen.
 *
 * These tests drive the REAL router. Every request stops at an auth gate before any database
 * work (no/invalid lease → 401), which is enough to exercise the limiter in front of it.
 * Limits are shrunk via env so the test is fast; the KEYING is what matters.
 *
 * Run: node --test tests/stealthRateLimitKeying.test.js
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('http');

// Must be set BEFORE the limiters are constructed at require time.
process.env.VALIDATE_RATE_LIMIT_MAX = '4';
process.env.GATEWAY_SERVICE_RATE_LIMIT_MAX = '4';
process.env.RATE_LIMIT_MAX_REQUESTS = '4';
process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-jwt-secret-0123456789abcdef0123456789';
process.env.JWT_REFRESH_SECRET = process.env.JWT_REFRESH_SECRET || 'test-refresh-secret-0123456789abcdef0123456789';
process.env.COOKIES_ENCRYPTION_KEY = process.env.COOKIES_ENCRYPTION_KEY || '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef';
process.env.STEALTH_LEASE_SECRET = process.env.STEALTH_LEASE_SECRET || 's'.repeat(48);

const express = require('express');
const stealthRouter = require('../routes/stealth/gateway');

let server, PORT;

test.before(async () => {
  const app = express();
  app.set('trust proxy', 1);
  app.use(express.json());
  app.use('/api/crm/stealth/gateway', stealthRouter);
  await new Promise((r) => { server = app.listen(0, r); });
  PORT = server.address().port;
});
test.after(() => { try { server.close(); } catch (_) {} });

// All requests come from ONE ip, as they do when the gateway relays them server-side.
const GATEWAY_IP = '203.0.113.77';
function post(path, lease) {
  return new Promise((resolve) => {
    const body = Buffer.from('{}');
    const headers = {
      'content-type': 'application/json',
      'content-length': body.length,
      'x-forwarded-for': GATEWAY_IP,
    };
    if (lease) headers.authorization = 'Bearer ' + lease;
    const req = http.request({ port: PORT, path: '/api/crm/stealth/gateway' + path, method: 'POST', headers },
      (res) => { res.resume(); res.on('end', () => resolve(res.statusCode)); });
    req.on('error', () => resolve(0));
    req.end(body);
  });
}
const is429 = (s) => s === 429;

test('/validate: one lease exhausting its budget does NOT lock out another lease on the same IP', async () => {
  // Client A burns well past the limit from the gateway's IP.
  const a = [];
  for (let i = 0; i < 12; i++) a.push(await post('/validate', 'lease-AAA'));
  assert.ok(a.some(is429), 'client A must eventually be limited — the ceiling is still enforced');

  // Client B, same IP, different lease: must be unaffected.
  const b = await post('/validate', 'lease-BBB');
  assert.ok(!is429(b), `client B was rate-limited by client A's traffic (got ${b}) — the bucket is shared, i.e. keyed by IP`);
});

test('/consume: metering is per lease, so one client cannot spend everyone else\'s budget', async () => {
  const a = [];
  for (let i = 0; i < 12; i++) a.push(await post('/consume', 'lease-CCC'));
  assert.ok(a.some(is429), 'ceiling still enforced');

  const b = await post('/consume', 'lease-DDD');
  assert.ok(!is429(b), `a second client was blocked by the first (got ${b}) — /consume is still on a shared per-IP bucket`);
});

test('the ceiling is still real: hammering ONE lease is throttled', async () => {
  const codes = [];
  for (let i = 0; i < 15; i++) codes.push(await post('/validate', 'lease-FLOOD'));
  assert.ok(codes.filter(is429).length > 0, 'a runaway loop on a single lease must still be stopped');
});

test('a 429 from these routes is retryable, never a terminal "session ended" verdict', async () => {
  // Exhaust one lease, then read the body the overlay would actually receive.
  for (let i = 0; i < 12; i++) await post('/validate', 'lease-BODY');
  const body = await new Promise((resolve) => {
    const b = Buffer.from('{}');
    const req = http.request({
      port: PORT, path: '/api/crm/stealth/gateway/validate', method: 'POST',
      headers: { 'content-type': 'application/json', 'content-length': b.length, 'x-forwarded-for': GATEWAY_IP, authorization: 'Bearer lease-BODY' },
    }, (res) => { let d = ''; res.on('data', c => { d += c; }); res.on('end', () => resolve({ status: res.statusCode, d })); });
    req.on('error', () => resolve({ status: 0, d: '' }));
    req.end(b);
  });
  if (body.status === 429) {
    const j = JSON.parse(body.d || '{}');
    assert.equal(j.terminal, false, 'a rate-limit must never be terminal');
    assert.equal(j.retryable, true, 'a rate-limit must be explicitly retryable');
    assert.equal(j.code, 'rate_limited');
  }
});
