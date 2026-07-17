'use strict';
/**
 * Tests for the Claude usage-management additions: token breakdown (input/context/output/total),
 * idempotent recording (no duplicate charging), admin global-default overrides, and recent
 * history. Run: node --test tests/claudeUsageMgmt.test.js
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const quota = require('../utils/proxy/claudeQuota');

// ── Global overrides (pure) ──────────────────────────────────────────────────
test('setGlobalConfig overrides the global defaults; clearing reverts to env/hardcoded', () => {
  const before = quota.defaultClientLimit();
  const beforeWk = quota.defaultWeeklyClientLimit();
  quota.setGlobalConfig({ defaultClientLimit: 33000, defaultWeeklyClientLimit: 400000, safetyReservePct: 10 });
  assert.equal(quota.defaultClientLimit(), 33000);
  assert.equal(quota.defaultWeeklyClientLimit(), 400000);
  assert.equal(quota.safetyReservePct(), 10);
  // The override flows into allowance resolution (priority: client → account → GLOBAL).
  assert.equal(quota.clientAllowance(null, null), 33000);
  assert.equal(quota.weeklyClientAllowance(null, null), 400000);
  // Clear → back to defaults.
  quota.setGlobalConfig({});
  assert.equal(quota.defaultClientLimit(), before);
  assert.equal(quota.defaultWeeklyClientLimit(), beforeWk);
});

test('setGlobalConfig ignores invalid values (negative / non-numeric), keeping env default', () => {
  quota.setGlobalConfig({ defaultClientLimit: -5, defaultWeeklyClientLimit: 'abc' });
  assert.equal(quota.getGlobalOverrides().defaultClientLimit, undefined);
  assert.equal(quota.getGlobalOverrides().defaultWeeklyClientLimit, undefined);
  quota.setGlobalConfig({});
});

// ── Ledger breakdown + idempotency (stubbed model) ───────────────────────────
const ClaudeUsage = require('../models/proxy/ClaudeUsage');
const ROWS = [];
// Use the REAL preSave via a light create stub so totalTokens = input+context+output is enforced.
ClaudeUsage.create = async (data) => {
  const d = await ClaudeUsage._preSave({ ...data }, null);
  ROWS.push(d);
  return d;
};
ClaudeUsage.find = async (q) => ROWS.filter(r => q.accountId === undefined || String(r.accountId) === String(q.accountId));
ClaudeUsage.deleteMany = async () => ({});
const usage = require('../utils/proxy/claudeUsage');

const account = { _id: 'A1', plan: 'pro', cycleResetAt: '2026-01-01T00:00:00.000Z', weeklyResetAt: '2026-01-01T00:00:00.000Z', createdAt: '2026-01-01T00:00:00.000Z' };
const client = { _id: 'C1' };
const NOW = '2026-01-01T01:00:00.000Z';

test('recordUsage stores the input/context/output breakdown; total is their sum', async () => {
  ROWS.length = 0;
  const r = await usage.recordUsage({ account, client, userId: 'u', inputTokens: 100, contextTokens: 40, outputTokens: 260, now: NOW });
  assert.equal(r.recorded, true);
  assert.equal(ROWS.length, 1);
  assert.equal(ROWS[0].inputTokens, 100);
  assert.equal(ROWS[0].contextTokens, 40);
  assert.equal(ROWS[0].outputTokens, 260);
  assert.equal(ROWS[0].totalTokens, 400); // 100 + 40 + 260
});

test('recordUsage is idempotent on requestId (no duplicate charging)', async () => {
  ROWS.length = 0;
  const first = await usage.recordUsage({ account, client, userId: 'u', inputTokens: 100, outputTokens: 200, requestId: 'req-abc', now: NOW });
  const dup = await usage.recordUsage({ account, client, userId: 'u', inputTokens: 100, outputTokens: 200, requestId: 'req-abc', now: NOW });
  assert.equal(first.recorded, true);
  assert.equal(dup.recorded, false);
  assert.equal(dup.duplicate, true);
  assert.equal(ROWS.length, 1); // charged exactly once
  // A different requestId is charged.
  const other = await usage.recordUsage({ account, client, userId: 'u', inputTokens: 50, outputTokens: 50, requestId: 'req-xyz', now: NOW });
  assert.equal(other.recorded, true);
  assert.equal(ROWS.length, 2);
});

test('enforcement total is unchanged by the breakdown split (sum still enforced)', async () => {
  ROWS.length = 0;
  await usage.recordUsage({ account, client, userId: 'u', inputTokens: 100, contextTokens: 100, outputTokens: 100, now: NOW });
  const u = await usage.readUsage(account, client, NOW);
  assert.equal(u.clientUsed, 300);       // 100 + 100 + 100 summed for the cycle
  assert.equal(u.weeklyClientUsed, 300);
});

test('recentHistory returns rows newest-first with the breakdown, safe fields only', async () => {
  ROWS.length = 0;
  await usage.recordUsage({ account, client, userId: 'u', inputTokens: 10, contextTokens: 1, outputTokens: 5, requestId: 'r1', now: '2026-01-01T01:00:00.000Z' });
  await usage.recordUsage({ account, client, userId: 'u', inputTokens: 20, contextTokens: 2, outputTokens: 8, requestId: 'r2', now: '2026-01-01T02:00:00.000Z' });
  const hist = await usage.recentHistory(account._id, client._id, 10);
  assert.equal(hist.length, 2);
  assert.equal(hist[0].inputTokens, 20); // newest first
  assert.equal(hist[0].totalTokens, 30);
  assert.ok(!('requestId' in hist[0]) && !('userId' in hist[0])); // only safe token/time fields
  assert.ok('at' in hist[0]);
});
