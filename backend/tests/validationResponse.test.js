'use strict';
/**
 * Shared lease-validation contract — terminal vs. retryable classification.
 *
 * Guards the root cause of "Access could not be verified. Please refresh or contact
 * support." appearing mid-session with time still on the clock: a transient failure being
 * classified as a permanent authorization denial.
 */
const test = require('node:test');
const assert = require('node:assert');
const vres = require('../utils/proxy/validationResponse');

test('every confirmed denial code is terminal', () => {
  for (const code of [
    'lease_expired', 'lease_revoked', 'lease_invalid', 'lease_missing',
    'client_disabled', 'plan_expired', 'account_blocked', 'account_no_session',
  ]) {
    assert.strictEqual(vres.isTerminalCode(code), true, code + ' must be terminal');
    const body = vres.fail(code);
    assert.strictEqual(body.terminal, true, code + ' body.terminal');
    assert.strictEqual(body.retryable, false, code + ' body.retryable');
    assert.strictEqual(body.valid, false);
  }
});

test('infrastructure failures are retryable, never terminal', () => {
  for (const code of [
    'server_error', 'rate_limited', 'backend_unavailable', 'vault_unconfigured',
    'gateway_timeout', 'bad_gateway', '', null, undefined, 'something_new_and_unknown',
  ]) {
    assert.strictEqual(vres.isTerminalCode(code), false, String(code) + ' must NOT be terminal');
    const body = vres.fail(code);
    assert.strictEqual(body.terminal, false, String(code) + ' body.terminal');
    assert.strictEqual(body.retryable, true, String(code) + ' body.retryable');
  }
});

test('an unknown code fails SAFE for availability but never grants access', () => {
  const body = vres.fail('totally_unknown_code');
  assert.strictEqual(body.valid, false);      // still denied
  assert.strictEqual(body.retryable, true);   // but the session may retry
});

test('success carries an absolute expiry the client can anchor to', () => {
  const expiresAt = new Date(Date.now() + 600000);
  const body = vres.ok({ expiresAt });
  assert.strictEqual(body.valid, true);
  assert.strictEqual(body.terminal, false);
  assert.strictEqual(body.expiresAt, expiresAt.toISOString());
  assert.ok(body.secondsRemaining > 595 && body.secondsRemaining <= 600);
  assert.ok(Date.parse(body.serverTime) > 0, 'serverTime enables clock-skew correction');
});

test('an already-expired lease reports 0 remaining, never a negative countdown', () => {
  const body = vres.ok({ expiresAt: new Date(Date.now() - 60000) });
  assert.strictEqual(body.secondsRemaining, 0);
});

test('extra fields (tool, plan) survive and do not clobber the contract', () => {
  const body = vres.ok({ expiresAt: new Date(Date.now() + 60000) }, { tool: 'claude', plan: { planName: 'Pro' } });
  assert.strictEqual(body.tool, 'claude');
  assert.deepStrictEqual(body.plan, { planName: 'Pro' });
  assert.strictEqual(body.valid, true);
});

test('every response is correlatable, and correlation ids are unique', () => {
  const a = vres.ok({ expiresAt: new Date() });
  const b = vres.fail('lease_expired');
  assert.match(a.correlationId, /^[0-9a-f]{16}$/);
  assert.match(b.correlationId, /^[0-9a-f]{16}$/);
  assert.notStrictEqual(a.correlationId, b.correlationId);
});

test('hashRef never returns the raw value — safe to log', () => {
  const secret = 'eyJhbGciOiJIUzI1NiJ9.super-secret-lease-token.sig';
  const h = vres.hashRef(secret);
  assert.match(h, /^[0-9a-f]{12}$/);
  assert.ok(!h.includes('secret'));
  assert.notStrictEqual(h, secret);
  assert.strictEqual(vres.hashRef(null), null);
  assert.strictEqual(vres.hashRef(secret), vres.hashRef(secret), 'stable for correlation');
});

test('TERMINAL_CODES is frozen — the closed list cannot be widened at runtime', () => {
  assert.throws(() => { vres.TERMINAL_CODES.push('server_error'); });
});
