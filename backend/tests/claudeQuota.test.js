'use strict';
/**
 * Deterministic unit tests for the Claude token-quota engine (utils/proxy/claudeQuota.js).
 * Pure math — no DB, no network, no secrets. Run: node --test tests/claudeQuota.test.js
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const q = require('../utils/proxy/claudeQuota');

test('token estimation: chars/4 heuristic, non-negative, ceil', () => {
  assert.equal(q.tokensFromChars(0), 0);
  assert.equal(q.tokensFromChars(4), 1);
  assert.equal(q.tokensFromChars(5), 2);   // ceil(5/4)
  assert.equal(q.tokensFromChars(-10), 0); // clamped
  assert.equal(q.tokensFromText('abcd'), 1);
  assert.equal(q.tokensFromText(''), 0);
  assert.equal(q.tokensFromText(null), 0);
  assert.equal(q.tokensFromText(undefined), 0);
});

test('estimateRequestTokens counts input + system + context + attachments', () => {
  // 4 + 4 + 4 + 4 = 16 chars → 4 tokens
  const t = q.estimateRequestTokens({ inputChars: 4, systemChars: 4, contextChars: 4, attachmentChars: 4 });
  assert.equal(t, 4);
  // missing components default to 0
  assert.equal(q.estimateRequestTokens({ inputChars: 8 }), 2);
  assert.equal(q.estimateRequestTokens({}), 0);
  assert.equal(q.estimateRequestTokens(null), 0);
  // negatives are clamped per-component, not summed as negatives
  assert.equal(q.estimateRequestTokens({ inputChars: 8, systemChars: -1000 }), 2);
});

test('plan scaling: Pro 1x / Max5 5x / Max20 20x; unknown = 1x', () => {
  assert.equal(q.planMultiplier('pro'), 1);
  assert.equal(q.planMultiplier('max5'), 5);
  assert.equal(q.planMultiplier('max20'), 20);
  assert.equal(q.planMultiplier('unknown'), 1);
  assert.equal(q.planMultiplier('garbage'), 1); // normalizes to unknown
  assert.equal(q.normalizePlan('garbage'), 'unknown');
  assert.equal(q.isValidPlan('max20'), true);
  assert.equal(q.isValidPlan('max50'), false);
});

test('accountCapacity: base * multiplier * (1 - reserve)', () => {
  const opts = { baseTokens: 44000, reservePct: 20 };
  assert.equal(q.accountCapacity('pro', opts), 35200);    // 44000 * 1 * 0.8
  assert.equal(q.accountCapacity('max5', opts), 176000);  // 44000 * 5 * 0.8
  assert.equal(q.accountCapacity('max20', opts), 704000); // 44000 * 20 * 0.8
  // 0% reserve → full scaled capacity
  assert.equal(q.accountCapacity('pro', { baseTokens: 1000, reservePct: 0 }), 1000);
  // 20% reserve keeps exactly 80%
  assert.equal(q.accountCapacity('pro', { baseTokens: 1000, reservePct: 20 }), 800);
});

test('clientAllowance: custom wins, else default 20000; 0 is a valid hard-stop', () => {
  assert.equal(q.clientAllowance(null), 20000);
  assert.equal(q.clientAllowance(''), 20000);
  assert.equal(q.clientAllowance(undefined), 20000);
  assert.equal(q.clientAllowance(5000), 5000);
  assert.equal(q.clientAllowance('7500'), 7500);
  assert.equal(q.clientAllowance(0), 0);      // explicit hard-stop, NOT treated as "unset"
  assert.equal(q.clientAllowance(-5), 20000); // invalid → default
});

test('checkAllowance: allows within both limits', () => {
  const r = q.checkAllowance({ clientLimit: 20000, clientUsed: 1000, accountCapacity: 35200, accountUsed: 2000, estIncoming: 500 });
  assert.equal(r.allowed, true);
  assert.equal(r.reason, null);
  assert.equal(r.clientRemaining, 19000);
  assert.equal(r.accountRemaining, 33200);
  assert.equal(r.label, 'Estimated local token usage');
});

test('checkAllowance: denies on client limit first', () => {
  const r = q.checkAllowance({ clientLimit: 20000, clientUsed: 19800, accountCapacity: 1e9, accountUsed: 0, estIncoming: 500 });
  assert.equal(r.allowed, false);
  assert.equal(r.reason, 'client_limit');
});

test('checkAllowance: denies on shared account capacity when client still has room', () => {
  const r = q.checkAllowance({ clientLimit: 1e9, clientUsed: 0, accountCapacity: 35200, accountUsed: 35000, estIncoming: 500 });
  assert.equal(r.allowed, false);
  assert.equal(r.reason, 'account_capacity');
});

test('checkAllowance: exact-fit is allowed, one-over is denied (boundary)', () => {
  const fit = q.checkAllowance({ clientLimit: 100, clientUsed: 90, accountCapacity: 1000, accountUsed: 0, estIncoming: 10 });
  assert.equal(fit.allowed, true); // 90 + 10 == 100, not over
  const over = q.checkAllowance({ clientLimit: 100, clientUsed: 90, accountCapacity: 1000, accountUsed: 0, estIncoming: 11 });
  assert.equal(over.allowed, false);
  assert.equal(over.reason, 'client_limit');
});

test('checkAllowance: limit 0 hard-stops even a zero-token request that is over', () => {
  const r = q.checkAllowance({ clientLimit: 0, clientUsed: 0, accountCapacity: 1000, accountUsed: 0, estIncoming: 1 });
  assert.equal(r.allowed, false);
  assert.equal(r.reason, 'client_limit');
});

test('five-hour cycle windows are contiguous, non-overlapping, and contain now', () => {
  const anchor = '2026-01-01T00:00:00.000Z';
  const now = '2026-01-01T07:30:00.000Z'; // 7.5h after anchor → 2nd window [5h,10h)
  const w = q.fiveHourWindow(anchor, now);
  assert.equal(w.index, 1);
  assert.equal(new Date(w.startMs).toISOString(), '2026-01-01T05:00:00.000Z');
  assert.equal(new Date(w.endMs).toISOString(), '2026-01-01T10:00:00.000Z');
  const nowMs = new Date(now).getTime();
  assert.ok(w.startMs <= nowMs && nowMs < w.endMs); // now is inside the window
});

test('cycle key changes exactly at the boundary (rollover)', () => {
  const anchor = '2026-01-01T00:00:00.000Z';
  const justBefore = q.fiveHourWindow(anchor, '2026-01-01T04:59:59.999Z');
  const atBoundary = q.fiveHourWindow(anchor, '2026-01-01T05:00:00.000Z');
  assert.equal(justBefore.index, 0);
  assert.equal(atBoundary.index, 1);
  assert.notEqual(justBefore.key, atBoundary.key); // usage buckets differ → usage resets
});

test('cycles are timezone-safe: same instant in different TZ offsets → same window', () => {
  const anchor = '2026-03-10T00:00:00.000Z';
  // 2026-03-10T09:00:00+02:00 == 2026-03-10T07:00:00Z  (same instant, different notation)
  const a = q.fiveHourWindow(anchor, '2026-03-10T07:00:00.000Z');
  const b = q.fiveHourWindow(anchor, '2026-03-10T09:00:00.000+02:00');
  assert.equal(a.key, b.key);
  assert.equal(a.index, b.index);
});

test('weekly window spans 7 days and rolls over on the boundary', () => {
  const anchor = '2026-01-05T00:00:00.000Z'; // a Monday
  const w0 = q.weeklyWindow(anchor, '2026-01-11T23:59:59.999Z');
  const w1 = q.weeklyWindow(anchor, '2026-01-12T00:00:00.000Z');
  assert.equal(w0.index, 0);
  assert.equal(w1.index, 1);
  assert.equal(w1.endMs - w1.startMs, q.WEEK_MS);
});

test('secondsUntilReset counts down to the window end', () => {
  const anchor = '2026-01-01T00:00:00.000Z';
  const now = '2026-01-01T04:00:00.000Z'; // 1h before the 5h boundary
  const w = q.fiveHourWindow(anchor, now);
  assert.equal(q.secondsUntilReset(w, now), 3600);
});

test('missing anchor falls back deterministically (no crash, stable key)', () => {
  const w1 = q.fiveHourWindow(null, '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z');
  const w2 = q.fiveHourWindow(null, '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z');
  assert.equal(w1.key, w2.key);
  assert.ok(Number.isFinite(w1.startMs));
});
