'use strict';
/**
 * Unit tests for best-effort Claude plan detection (utils/proxy/claudeVerify.detectPlan).
 * Pure string/JSON matching; no network. Run: node --test tests/claudePlanDetect.test.js
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const { detectPlan } = require('../utils/proxy/claudeVerify');

test('detects Max 20x from a rate-limit tier string', () => {
  assert.equal(detectPlan([{ rate_limit_tier: 'default_claude_max_20x' }]), 'max20');
  assert.equal(detectPlan(null, 'billing tier claude_max_20x active'), 'max20');
});

test('detects Max 5x', () => {
  assert.equal(detectPlan([{ rate_limit_tier: 'default_claude_max_5x' }]), 'max5');
  assert.equal(detectPlan([{ capabilities: ['chat', 'claude_max'] }]), 'max5'); // bare max → entry Max tier
});

test('detects Pro', () => {
  assert.equal(detectPlan([{ capabilities: ['chat', 'claude_pro'] }]), 'pro');
  assert.equal(detectPlan([{ billing_type: 'pro_tier' }]), 'pro');
});

test('20x takes precedence over 5x/pro when multiple hints appear', () => {
  assert.equal(detectPlan([{ notes: 'upgraded from claude_pro to claude_max_20x' }]), 'max20');
});

test('returns null when no reliable signal is present (→ manual selection)', () => {
  assert.equal(detectPlan([{ uuid: 'abc', name: "Someone's org" }]), null);
  assert.equal(detectPlan(null, ''), null);
  assert.equal(detectPlan(undefined, undefined), null);
  assert.equal(detectPlan([], ''), null);
});

test('does not false-positive on an org name that merely contains a person', () => {
  // no plan keywords → null (we never guess from arbitrary text)
  assert.equal(detectPlan([{ uuid: 'x', name: 'Maxwell Personal' }], '{"name":"Maxwell Personal"}'), null);
});
