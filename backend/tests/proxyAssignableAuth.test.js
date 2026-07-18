'use strict';
/**
 * The "Grant access" picker endpoint (GET /admin/proxy-tools/:tool/assignable-clients)
 * sits behind the same router-level requireAuth + requireAdmin as every other admin
 * proxy-tools route, so the client list can never leak to an unauthorized caller.
 * This verifies the gate itself: unauthenticated → 401, non-admin → 403, admin → next().
 * Run: node --test tests/proxyAssignableAuth.test.js
 */
const test = require('node:test');
const assert = require('node:assert/strict');

// authEnhanced validates required secrets at load; provide test-only values so the
// pure middleware can be imported. These never leave the test process.
process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-jwt-secret-0123456789abcdef0123456789';
process.env.JWT_REFRESH_SECRET = process.env.JWT_REFRESH_SECRET || 'test-refresh-secret-0123456789abcdef0123456789';
process.env.COOKIES_ENCRYPTION_KEY = process.env.COOKIES_ENCRYPTION_KEY || '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef';
const { requireAdmin } = require('../middleware/authEnhanced');

function mockRes() {
  return {
    statusCode: null,
    body: null,
    status(c) { this.statusCode = c; return this; },
    json(b) { this.body = b; return this; },
  };
}

test('unauthenticated request is rejected (401) and never reaches the handler', () => {
  const res = mockRes();
  let nexted = false;
  requireAdmin({}, res, () => { nexted = true; });
  assert.equal(res.statusCode, 401);
  assert.equal(nexted, false);
});

test('authenticated non-admin (CLIENT) is rejected (403) and never reaches the handler', () => {
  const res = mockRes();
  let nexted = false;
  requireAdmin({ user: { role: 'CLIENT', isAdmin: () => false } }, res, () => { nexted = true; });
  assert.equal(res.statusCode, 403);
  assert.equal(nexted, false);
});

test('admin passes the gate (next called, no error status)', () => {
  const res = mockRes();
  let nexted = false;
  requireAdmin({ user: { role: 'ADMIN', isAdmin: () => true } }, res, () => { nexted = true; });
  assert.equal(nexted, true);
  assert.equal(res.statusCode, null);
});
