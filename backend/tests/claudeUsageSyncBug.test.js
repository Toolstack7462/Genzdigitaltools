'use strict';
/**
 * Regression tests for the Claude usage-summary SYNCHRONIZATION bug.
 *
 * ROOT CAUSE: aggregation summed ledger rows by the STORED `cycleKey`/`weekKey` bucket string,
 * which embeds the account's reset ANCHOR. When the account's official five-hour / weekly reset
 * timestamp is set or corrected AFTER a request was recorded (a normal operator flow), the anchor
 * changes, so the recomputed bucket key no longer matches the key stored on the row — the row is
 * orphaned and the summary shows 0, even though the history (which is not cycle-filtered) still
 * lists it. The fix aggregates by the row's real EVENT TIME (`at`) falling inside the active
 * window, so the ledger is the source of truth and stale bucket strings can never hide usage.
 *
 * Run: node --test tests/claudeUsageSyncBug.test.js
 */
const test = require('node:test');
const assert = require('node:assert/strict');

// In-memory ledger stub (mirrors the append-only model; find() by accountId only, like production).
const ClaudeUsage = require('../models/proxy/ClaudeUsage');
const ROWS = [];
ClaudeUsage.create = async (data) => {
  const row = Object.assign(
    { totalTokens: (Number(data.inputTokens) || 0) + (Number(data.contextTokens) || 0) + (Number(data.outputTokens) || 0), kind: 'usage' },
    data,
  );
  ROWS.push(row);
  return row;
};
ClaudeUsage.find = async (q) => ROWS.filter(r => q.accountId === undefined || String(r.accountId) === String(q.accountId));
ClaudeUsage.deleteMany = async () => ({});

const usage = require('../utils/proxy/claudeUsage');

const NOW = '2026-07-18T09:00:00.000Z';

test('BUG: usage recorded BEFORE the official reset anchor is set is still counted after it is set', async () => {
  ROWS.length = 0;
  // 1) Account has NO official reset timestamps yet → anchor falls back to createdAt.
  const before = { _id: 'ACC', plan: 'pro', createdAt: '2026-07-18T00:00:00.000Z' };
  const client = { _id: 'CLI', tokenLimit: 9997 };
  await usage.recordUsage({ account: before, client, userId: 'u', inputTokens: 17, contextTokens: 0, outputTokens: 115, requestId: 'req-1', now: NOW });

  // 2) Operator now sets the official five-hour + weekly reset timestamps (anchor CHANGES).
  const after = { _id: 'ACC', plan: 'pro', createdAt: '2026-07-18T00:00:00.000Z', cycleResetAt: '2026-07-18T11:00:00.000Z', weeklyResetAt: '2026-07-14T11:00:00.000Z' };

  const u = await usage.readUsage(after, client, NOW);
  // The event (09:00) is inside BOTH the current five-hour window [06:00,11:00) and the current
  // weekly window → it MUST still be counted (previously returned 0 because the bucket key drifted).
  assert.equal(u.clientUsed, 132, 'five-hour usage must survive a reset-anchor change');
  assert.equal(u.weeklyClientUsed, 132, 'weekly usage must survive a reset-anchor change');
  assert.equal(u.accountUsed, 132);
  assert.equal(u.weeklyAccountUsed, 132);
});

test('first usage event immediately updates five-hour AND weekly totals (custom limit preserved)', async () => {
  ROWS.length = 0;
  const account = { _id: 'ACC', plan: 'pro', cycleResetAt: '2026-07-18T06:00:00.000Z', weeklyResetAt: '2026-07-14T06:00:00.000Z' };
  const client = { _id: 'CLI', tokenLimit: 9997, weeklyTokenLimit: null };
  await usage.recordUsage({ account, client, userId: 'u', inputTokens: 17, contextTokens: 0, outputTokens: 115, requestId: 'r1', now: NOW });

  const u = await usage.readUsage(account, client, NOW);
  const st = usage.usageStatus({ account, client, usage: u, now: NOW });
  assert.equal(st.fiveHour.used, 132);
  assert.equal(st.fiveHour.limit, 9997);          // real custom limit, not the default 20000
  assert.equal(st.fiveHour.source, 'custom');
  assert.equal(st.weekly.used, 132);              // same tokens count toward weekly
  assert.equal(st.weekly.limit, 150000);          // weekly falls to global default (no override)
});

test('multiple events aggregate; only the correct client/account/cycle is summed', async () => {
  ROWS.length = 0;
  const account = { _id: 'ACC', plan: 'pro', cycleResetAt: '2026-07-18T06:00:00.000Z', weeklyResetAt: '2026-07-14T06:00:00.000Z' };
  const other = { _id: 'OTHER', plan: 'pro', cycleResetAt: '2026-07-18T06:00:00.000Z' };
  const cliA = { _id: 'A', tokenLimit: 9997 };
  const cliB = { _id: 'B', tokenLimit: 9997 };
  await usage.recordUsage({ account, client: cliA, userId: 'a', inputTokens: 17, outputTokens: 115, requestId: 'r1', now: NOW });
  await usage.recordUsage({ account, client: cliA, userId: 'a', inputTokens: 0, outputTokens: 68, requestId: 'r2', now: '2026-07-18T09:30:00.000Z' });
  await usage.recordUsage({ account, client: cliB, userId: 'b', inputTokens: 0, outputTokens: 500, requestId: 'r3', now: NOW });
  // A row on a DIFFERENT account must never leak into ACC's totals.
  await usage.recordUsage({ account: other, client: cliA, userId: 'a', inputTokens: 0, outputTokens: 9999, requestId: 'r4', now: NOW });

  const uA = await usage.readUsage(account, cliA, NOW);
  assert.equal(uA.clientUsed, 200);   // 132 + 68 (only client A, only account ACC, only this cycle)
  assert.equal(uA.accountUsed, 700);  // 200 (A) + 500 (B) shared on ACC — NOT the OTHER-account row
});

test('duplicate requestId is not double-counted', async () => {
  ROWS.length = 0;
  const account = { _id: 'ACC', plan: 'pro', cycleResetAt: '2026-07-18T06:00:00.000Z' };
  const client = { _id: 'CLI', tokenLimit: 9997 };
  await usage.recordUsage({ account, client, userId: 'u', inputTokens: 17, outputTokens: 115, requestId: 'dup', now: NOW });
  const again = await usage.recordUsage({ account, client, userId: 'u', inputTokens: 17, outputTokens: 115, requestId: 'dup', now: NOW });
  assert.equal(again.duplicate, true);
  const u = await usage.readUsage(account, client, NOW);
  assert.equal(u.clientUsed, 132); // counted once, not twice
});

test('reset starts a NEW cycle without deleting history; totals reflect only the active cycle', async () => {
  ROWS.length = 0;
  const account = { _id: 'ACC', plan: 'pro', cycleResetAt: '2026-07-18T06:00:00.000Z', weeklyResetAt: '2026-07-14T06:00:00.000Z' };
  const client = { _id: 'CLI', tokenLimit: 9997 };
  await usage.recordUsage({ account, client, userId: 'u', inputTokens: 17, outputTokens: 115, requestId: 'r1', now: NOW });
  // Six hours later → a new five-hour cycle; the old row still EXISTS (history) but is not in the
  // active five-hour total. It IS still within the same week, so weekly keeps counting it.
  const later = '2026-07-18T15:30:00.000Z';
  const u = await usage.readUsage(account, client, later);
  assert.equal(u.clientUsed, 0);       // new five-hour cycle
  assert.equal(u.weeklyClientUsed, 132); // same week → preserved
  assert.equal(ROWS.length, 1);        // history row NOT deleted
});

test('concurrent requests neither lose nor double-count tokens', async () => {
  ROWS.length = 0;
  const account = { _id: 'ACC', plan: 'pro', cycleResetAt: '2026-07-18T06:00:00.000Z' };
  const client = { _id: 'CLI', tokenLimit: 9997 };
  await Promise.all([
    usage.recordUsage({ account, client, userId: 'u', inputTokens: 0, outputTokens: 100, requestId: 'c1', now: NOW }),
    usage.recordUsage({ account, client, userId: 'u', inputTokens: 0, outputTokens: 100, requestId: 'c2', now: NOW }),
  ]);
  const u = await usage.readUsage(account, client, NOW);
  assert.equal(u.clientUsed, 200); // both survived (append-only), no duplicate
});
