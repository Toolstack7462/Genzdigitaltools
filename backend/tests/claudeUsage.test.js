'use strict';
/**
 * Unit tests for the pure helpers of utils/proxy/claudeUsage.js (cycle bucketing, summing,
 * and the combined quota decision). No DB is touched. Run: node --test tests/claudeUsage.test.js
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const usage = require('../utils/proxy/claudeUsage');

test('cycleKeysFor uses the account reset anchor; shared across clients on that account', () => {
  const account = { _id: 'A1', cycleResetAt: '2026-01-01T00:00:00.000Z', weeklyResetAt: '2026-01-01T00:00:00.000Z' };
  const k1 = usage.cycleKeysFor(account, '2026-01-01T03:00:00.000Z');
  const k2 = usage.cycleKeysFor(account, '2026-01-01T04:59:00.000Z');
  // same five-hour window → same cycleKey (shared bucket)
  assert.equal(k1.cycleKey, k2.cycleKey);
  // after the boundary → different bucket
  const k3 = usage.cycleKeysFor(account, '2026-01-01T05:01:00.000Z');
  assert.notEqual(k1.cycleKey, k3.cycleKey);
});

test('cycleKeysFor falls back to createdAt when no reset anchor is set', () => {
  const account = { _id: 'A2', createdAt: '2026-02-01T00:00:00.000Z' };
  const k = usage.cycleKeysFor(account, '2026-02-01T02:00:00.000Z');
  assert.ok(typeof k.cycleKey === 'string' && k.cycleKey.length > 0);
});

test('sumRowsInWindow sums only rows whose event time is in the active window (source of truth)', () => {
  const win = { startMs: 1000, endMs: 2000 }; // half-open [1000, 2000)
  const rows = [
    { at: new Date(1000), totalTokens: 100, kind: 'usage' }, // inclusive start
    { at: new Date(1500), totalTokens: 50, kind: 'usage' },
    { at: new Date(2000), totalTokens: 999, kind: 'usage' }, // exclusive end → ignored
    { at: new Date(500), totalTokens: 999, kind: 'usage' },  // before window → ignored
    { at: new Date(1500), totalTokens: 7, kind: 'precheck' },// non-usage kind → ignored
    null,                                                     // malformed → ignored
    { at: new Date(1500), totalTokens: -20, kind: 'usage' }, // negative → clamped to 0
  ];
  assert.equal(usage.sumRowsInWindow(rows, win), 150);
  assert.equal(usage.usageForCycle(rows, win), 150);   // usageForCycle now windows by event time
  assert.equal(usage.sumRowsInWindow([], win), 0);
  assert.equal(usage.sumRowsInWindow(rows, null), 0);  // no window → 0 (never throws)
});

test('sumRowsByKey still buckets by a stored key (retained helper, not the authoritative path)', () => {
  const rows = [
    { cycleKey: 'C1', totalTokens: 100, kind: 'usage' },
    { cycleKey: 'C2', totalTokens: 999, kind: 'usage' },
    { cycleKey: 'C1', totalTokens: 7, kind: 'precheck' }, // non-usage → ignored
  ];
  assert.equal(usage.sumRowsByKey(rows, 'C1', 'cycleKey'), 100);
  assert.equal(usage.sumRowsByKey(rows, 'C2', 'cycleKey'), 999);
});

test('resolveDecision: Pro account, default client limit, within both → allowed', () => {
  const account = { plan: 'pro' };       // capacity = 44000*1*0.8 = 35200 (default env)
  const client = { tokenLimit: null };   // 20000 default
  const d = usage.resolveDecision({ account, client, clientUsed: 1000, accountUsed: 5000, estIncoming: 500 });
  assert.equal(d.plan, 'pro');
  assert.equal(d.allowed, true);
  assert.equal(d.clientLimit, 20000);
  assert.equal(d.accountCapacity, 35200);
  assert.equal(d.label, 'Estimated local token usage');
});

test('resolveDecision: Max20 scales shared capacity 20x', () => {
  const account = { plan: 'max20' };
  const client = { tokenLimit: 500000 };
  // account capacity = 44000*20*0.8 = 704000; client used 400000 + 200000 <= 500000? no → client_limit
  const d = usage.resolveDecision({ account, client, clientUsed: 400000, accountUsed: 0, estIncoming: 200000 });
  assert.equal(d.accountCapacity, 704000);
  assert.equal(d.allowed, false);
  assert.equal(d.reason, 'client_limit');
});

test('resolveDecision: shared account saturates before a generous client limit', () => {
  const account = { plan: 'pro' };             // capacity 35200
  const client = { tokenLimit: 100000000 };    // effectively unlimited client
  const d = usage.resolveDecision({ account, client, clientUsed: 0, accountUsed: 35000, estIncoming: 500 });
  assert.equal(d.allowed, false);
  assert.equal(d.reason, 'account_capacity');
});

test('resolveDecision: unknown plan is treated as 1x (Pro-equivalent), never crashes', () => {
  const d = usage.resolveDecision({ account: {}, client: {}, clientUsed: 0, accountUsed: 0, estIncoming: 10 });
  assert.equal(d.plan, 'unknown');
  assert.equal(d.allowed, true);
});
