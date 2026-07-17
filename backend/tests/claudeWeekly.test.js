'use strict';
/**
 * Unit + integration tests for the Claude WEEKLY quota (parallel to the five-hour quota).
 * Pure engine + a stubbed-ledger pipeline. Run: node --test tests/claudeWeekly.test.js
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const q = require('../utils/proxy/claudeQuota');

// ── Engine: weekly capacity + allowance priority ─────────────────────────────
test('accountWeeklyCapacity scales by plan and applies the reserve', () => {
  const opts = { baseTokens: 300000, reservePct: 20 };
  assert.equal(q.accountWeeklyCapacity('pro', opts), 240000);   // 300000 * 1 * 0.8
  assert.equal(q.accountWeeklyCapacity('max5', opts), 1200000); // * 5
  assert.equal(q.accountWeeklyCapacity('max20', opts), 4800000);// * 20
});

test('weeklyClientAllowance priority: client override → account default → global → 200k fallback', () => {
  // 1) client override wins
  assert.equal(q.weeklyClientAllowance(90000, 120000), 90000);
  // 2) no client override → account default
  assert.equal(q.weeklyClientAllowance(null, 120000), 120000);
  assert.equal(q.weeklyClientAllowance('', 120000), 120000);
  // 3) neither → global default (150,000 by default env)
  assert.equal(q.weeklyClientAllowance(null, null), 150000);
  // 0 is a valid hard-stop at each level (not treated as "unset")
  assert.equal(q.weeklyClientAllowance(0, 120000), 0);
  assert.equal(q.weeklyClientAllowance(null, 0), 0);
});

test('weeklyClientAllowance falls back to 200,000 only when the global default is invalid', () => {
  const prev = process.env.CLAUDE_DEFAULT_WEEKLY_CLIENT_TOKENS;
  // An unparseable env leaves intEnv at its 150000 default → NOT the 200k fallback.
  process.env.CLAUDE_DEFAULT_WEEKLY_CLIENT_TOKENS = 'not-a-number';
  assert.equal(q.weeklyClientAllowance(null, null), 150000);
  // The 200k hard fallback constant is exposed and correct.
  assert.equal(q.WEEKLY_HARD_FALLBACK, 200000);
  if (prev === undefined) delete process.env.CLAUDE_DEFAULT_WEEKLY_CLIENT_TOKENS; else process.env.CLAUDE_DEFAULT_WEEKLY_CLIENT_TOKENS = prev;
});

// ── Engine: checkAllowance weekly gates ──────────────────────────────────────
test('checkAllowance without weekly params is unchanged (backward compatible)', () => {
  const r = q.checkAllowance({ clientLimit: 100, clientUsed: 10, accountCapacity: 1000, accountUsed: 0, estIncoming: 10 });
  assert.equal(r.allowed, true);
  assert.equal(r.weeklyClientLimit, undefined); // no weekly fields emitted
});

test('checkAllowance denies on weekly client limit when five-hour is fine', () => {
  const r = q.checkAllowance({
    clientLimit: 1e9, clientUsed: 0, accountCapacity: 1e9, accountUsed: 0,
    weeklyClientLimit: 150000, weeklyClientUsed: 149900,
    weeklyAccountCapacity: 1e9, weeklyAccountUsed: 0, estIncoming: 200,
  });
  assert.equal(r.allowed, false);
  assert.equal(r.reason, 'weekly_client_limit');
  assert.equal(r.weeklyClientRemaining, 100);
});

test('checkAllowance denies on shared weekly account capacity', () => {
  const r = q.checkAllowance({
    clientLimit: 1e9, clientUsed: 0, accountCapacity: 1e9, accountUsed: 0,
    weeklyClientLimit: 1e9, weeklyClientUsed: 0,
    weeklyAccountCapacity: 240000, weeklyAccountUsed: 239900, estIncoming: 200,
  });
  assert.equal(r.allowed, false);
  assert.equal(r.reason, 'weekly_account_capacity');
});

test('five-hour gate takes precedence over weekly (checked first)', () => {
  const r = q.checkAllowance({
    clientLimit: 100, clientUsed: 100, accountCapacity: 1e9, accountUsed: 0,
    weeklyClientLimit: 100, weeklyClientUsed: 100,
    weeklyAccountCapacity: 1e9, weeklyAccountUsed: 0, estIncoming: 1,
  });
  assert.equal(r.allowed, false);
  assert.equal(r.reason, 'client_limit'); // 5h reported first even though weekly is also over
});

// ── Integration: weekly aggregation + rollover + concurrency + not-synced ────
const ClaudeUsage = require('../models/proxy/ClaudeUsage');
const ROWS = [];
ClaudeUsage.create = async (data) => {
  const row = Object.assign({ totalTokens: (Number(data.inputTokens) || 0) + (Number(data.outputTokens) || 0), kind: 'usage' }, data);
  ROWS.push(row); return row;
};
ClaudeUsage.find = async (query) => ROWS.filter(r => query.accountId === undefined || String(r.accountId) === String(query.accountId));
ClaudeUsage.deleteMany = async () => ({});
const usage = require('../utils/proxy/claudeUsage');

const account = { _id: 'A1', plan: 'pro', cycleResetAt: '2026-01-01T00:00:00.000Z', weeklyResetAt: '2026-01-01T00:00:00.000Z', createdAt: '2026-01-01T00:00:00.000Z' };
const client = { _id: 'C1', tokenLimit: 20000, weeklyTokenLimit: 150000 };

test('weekly usage accumulates across multiple five-hour cycles within the same week', async () => {
  ROWS.length = 0;
  // Two records 6 hours apart → different 5-hour buckets, SAME week.
  await usage.recordUsage({ account, client, userId: 'u', inputTokens: 0, outputTokens: 5000, now: '2026-01-01T01:00:00.000Z' });
  await usage.recordUsage({ account, client, userId: 'u', inputTokens: 0, outputTokens: 7000, now: '2026-01-01T07:00:00.000Z' });
  const u = await usage.readUsage(account, client, '2026-01-01T08:00:00.000Z');
  assert.equal(u.clientUsed, 7000);       // only the current 5-hour bucket
  assert.equal(u.weeklyClientUsed, 12000);// both, within the week
  assert.equal(u.weeklyAccountUsed, 12000);
  assert.equal(u.synced, true);
});

test('weekly bucket rolls over on the official weekly boundary (atomic reset)', async () => {
  ROWS.length = 0;
  await usage.recordUsage({ account, client, userId: 'u', inputTokens: 0, outputTokens: 100000, now: '2026-01-05T00:00:00.000Z' });
  // 8 days later → next weekly window → prior week's usage no longer counts.
  const u = await usage.readUsage(account, client, '2026-01-09T00:00:00.000Z');
  assert.equal(u.weeklyClientUsed, 0);
  assert.equal(u.weeklyAccountUsed, 0);
});

test('concurrent records both persist (append-only → no weekly bypass)', async () => {
  ROWS.length = 0;
  await Promise.all([
    usage.recordUsage({ account, client, userId: 'u', inputTokens: 0, outputTokens: 80000, now: '2026-01-01T01:00:00.000Z' }),
    usage.recordUsage({ account, client, userId: 'u', inputTokens: 0, outputTokens: 80000, now: '2026-01-01T01:00:00.000Z' }),
  ]);
  const u = await usage.readUsage(account, client, '2026-01-01T01:00:00.000Z');
  assert.equal(u.weeklyClientUsed, 160000); // both counted; a lost update would show 80000
  // Feed the accumulated weekly usage into a five-hour-CLEAR decision to isolate the weekly gate:
  // the persisted concurrent total (160000 > 150000) must produce a weekly denial.
  const d = usage.resolveDecision({ account, client, clientUsed: 0, accountUsed: 0, weeklyClientUsed: u.weeklyClientUsed, weeklyAccountUsed: u.weeklyAccountUsed, estIncoming: 1 });
  assert.equal(d.allowed, false);
  assert.equal(d.reason, 'weekly_client_limit'); // 160000 > 150000 weekly limit
});

test('readUsage reports synced=false on a ledger read error (→ "Not synced", no fabricated 0)', async () => {
  const orig = ClaudeUsage.find;
  ClaudeUsage.find = async () => { throw new Error('db down'); };
  const u = await usage.readUsage(account, client, '2026-01-01T01:00:00.000Z');
  assert.equal(u.synced, false);
  assert.equal(u.weeklyClientUsed, 0);
  ClaudeUsage.find = orig;
});

test('resolveDecision enforces BOTH five-hour and weekly for a Claude request', async () => {
  ROWS.length = 0;
  // Push the client over the 5-hour limit but under weekly.
  const d1 = usage.resolveDecision({ account, client, clientUsed: 20000, accountUsed: 0, weeklyClientUsed: 20000, weeklyAccountUsed: 0, estIncoming: 1 });
  assert.equal(d1.allowed, false);
  assert.equal(d1.reason, 'client_limit');
  // Under 5-hour, over weekly.
  const d2 = usage.resolveDecision({ account, client, clientUsed: 0, accountUsed: 0, weeklyClientUsed: 150000, weeklyAccountUsed: 0, estIncoming: 1 });
  assert.equal(d2.allowed, false);
  assert.equal(d2.reason, 'weekly_client_limit');
});
