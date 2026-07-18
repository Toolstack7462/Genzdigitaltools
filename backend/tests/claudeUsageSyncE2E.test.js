'use strict';
/**
 * AUDIT-GRADE END-TO-END test of the Claude usage-summary synchronization fix, driving the REAL
 * ClaudeUsage ledger model through the REAL mysqlAdapter against an in-memory pool
 * (recordUsage → serialize → persist → deserialize → readUsage → usageStatus). Unlike
 * claudeUsagePipeline.test.js (which STUBS the model), this exercises the actual persistence layer,
 * so it proves the `at` timestamp and `totalTokens` survive the JSON round-trip and that the
 * window aggregation, dedup, reconciliation and isolation all behave in production shape.
 *
 * Run: node --test tests/claudeUsageSyncE2E.test.js
 */
const { test } = require('node:test');
const assert = require('node:assert/strict');
const adapter = require('../db/mysqlAdapter');
const ClaudeUsage = require('../models/proxy/ClaudeUsage'); // REAL model (with preSave)
const usage = require('../utils/proxy/claudeUsage');

// In-memory pool (same shape as claudeLimitOverride.test.js): INSERT stores the JSON blob,
// SELECT-by-id returns it, any other WHERE throws so the adapter falls back to a full scan.
function setMemPool() {
  const tables = new Map();
  const tableOf = (sql) => (sql.match(/`([a-z_]+)`/i) || [])[1];
  const store = (t) => tables.get(t) || (tables.set(t, new Map()), tables.get(t));
  adapter.__test.setPool({
    query: async (sql, params) => {
      const t = tableOf(sql);
      if (/^INSERT INTO/i.test(sql)) { store(t).set(String(params[0]), params[1]); return [[]]; }
      if (/^SELECT/i.test(sql)) {
        if (/WHERE id = \?/i.test(sql)) { const r = store(t).get(String(params[0])); return [r ? [{ data: r }] : []]; }
        if (/WHERE/i.test(sql)) throw new Error('unsupported WHERE → full scan fallback');
        return [[...store(t).values()].map(data => ({ data }))];
      }
      if (/^DELETE/i.test(sql)) return [[]];
      return [[]];
    },
  });
  return tables;
}

const T0 = '2026-07-18T09:00:00.000Z';

test('E2E: a 132-token request is recorded then immediately summed for five-hour AND weekly', async () => {
  setMemPool();
  const account = { _id: 'ACC1', plan: 'pro', cycleResetAt: '2026-07-18T06:00:00.000Z', weeklyResetAt: '2026-07-14T06:00:00.000Z' };
  const client = { _id: 'CLI1', tokenLimit: 9997, weeklyTokenLimit: null };

  const r = await usage.recordUsage({ account, client, userId: 'u1', inputTokens: 17, contextTokens: 0, outputTokens: 115, requestId: 'req-abc', now: T0 });
  assert.equal(r.recorded, true);

  const u = await usage.readUsage(account, client, T0);           // REAL find() through the adapter
  assert.equal(u.synced, true);
  assert.equal(u.clientUsed, 132, 'five-hour used must reflect the just-recorded request');
  assert.equal(u.weeklyClientUsed, 132, 'weekly used must reflect the same request');

  const st = usage.usageStatus({ account, client, usage: u, now: T0 });
  assert.equal(st.fiveHour.used, 132);
  assert.equal(st.fiveHour.limit, 9997);          // real custom limit, not the 20000 default
  assert.equal(st.fiveHour.source, 'custom');
  assert.equal(st.weekly.used, 132);
  assert.equal(st.weekly.limit, 150000);          // weekly inherits the global default (no override)
  assert.equal(st.weekly.resetOfficial, true);    // weeklyResetAt is set → shown, not "Not synced"
});

test('E2E: totals survive a simulated page-refresh AND server-restart (re-read from the ledger)', async () => {
  const tables = setMemPool();
  const account = { _id: 'ACC1', plan: 'pro', cycleResetAt: '2026-07-18T06:00:00.000Z' };
  const client = { _id: 'CLI1', tokenLimit: 9997 };
  await usage.recordUsage({ account, client, userId: 'u1', inputTokens: 17, outputTokens: 115, requestId: 'r1', now: T0 });

  // Refresh: a second independent read returns the same total (no cached counter drift).
  const u1 = await usage.readUsage(account, client, T0);
  assert.equal(u1.clientUsed, 132);

  // Restart: rebuild the model layer over the SAME persisted rows (the pool is unchanged) — the
  // total is recomputed from the ledger, so it is preserved with no in-memory state.
  adapter.__test.setPool({
    query: async (sql, params) => {
      const t = (sql.match(/`([a-z_]+)`/i) || [])[1];
      const s = tables.get(t) || new Map();
      if (/^SELECT/i.test(sql)) {
        if (/WHERE id = \?/i.test(sql)) { const r = s.get(String(params[0])); return [r ? [{ data: r }] : []]; }
        if (/WHERE/i.test(sql)) throw new Error('full scan');
        return [[...s.values()].map(data => ({ data }))];
      }
      return [[]];
    },
  });
  const u2 = await usage.readUsage(account, client, T0);
  assert.equal(u2.clientUsed, 132, 'restart preserves totals (recomputed from the persisted ledger)');
});

test('E2E: the reported bug — usage recorded BEFORE the official reset is set still counts after', async () => {
  setMemPool();
  const before = { _id: 'ACC1', plan: 'pro', createdAt: '2026-07-18T00:00:00.000Z' }; // no reset anchors yet
  const client = { _id: 'CLI1', tokenLimit: 9997 };
  await usage.recordUsage({ account: before, client, userId: 'u1', inputTokens: 17, outputTokens: 115, requestId: 'r1', now: T0 });

  // Operator now configures the official five-hour + weekly reset timestamps (anchor CHANGES).
  const after = { _id: 'ACC1', plan: 'pro', createdAt: '2026-07-18T00:00:00.000Z', cycleResetAt: '2026-07-18T11:00:00.000Z', weeklyResetAt: '2026-07-14T11:00:00.000Z' };
  const u = await usage.readUsage(after, client, T0);
  assert.equal(u.clientUsed, 132, 'summary must not drop to 0 after a reset-anchor change');
  assert.equal(u.weeklyClientUsed, 132);
});

test('E2E: duplicate requestId is rejected by the ledger (no double count)', async () => {
  setMemPool();
  const account = { _id: 'ACC1', plan: 'pro', cycleResetAt: '2026-07-18T06:00:00.000Z' };
  const client = { _id: 'CLI1', tokenLimit: 9997 };
  await usage.recordUsage({ account, client, userId: 'u1', inputTokens: 17, outputTokens: 115, requestId: 'dup', now: T0 });
  const dup = await usage.recordUsage({ account, client, userId: 'u1', inputTokens: 17, outputTokens: 115, requestId: 'dup', now: T0 });
  assert.equal(dup.duplicate, true);
  const u = await usage.readUsage(account, client, T0);
  assert.equal(u.clientUsed, 132); // counted exactly once
});

test('E2E: account/client records cannot be mixed', async () => {
  setMemPool();
  const acc1 = { _id: 'ACC1', plan: 'pro', cycleResetAt: '2026-07-18T06:00:00.000Z' };
  const acc2 = { _id: 'ACC2', plan: 'pro', cycleResetAt: '2026-07-18T06:00:00.000Z' };
  const cliA = { _id: 'A', tokenLimit: 9997 };
  const cliB = { _id: 'B', tokenLimit: 9997 };
  await usage.recordUsage({ account: acc1, client: cliA, userId: 'a', inputTokens: 0, outputTokens: 132, requestId: 'a1', now: T0 });
  await usage.recordUsage({ account: acc1, client: cliB, userId: 'b', inputTokens: 0, outputTokens: 500, requestId: 'b1', now: T0 });
  await usage.recordUsage({ account: acc2, client: cliA, userId: 'a', inputTokens: 0, outputTokens: 9999, requestId: 'a2', now: T0 });

  const uA1 = await usage.readUsage(acc1, cliA, T0);
  assert.equal(uA1.clientUsed, 132);        // only A on ACC1
  assert.equal(uA1.accountUsed, 632);       // A + B shared on ACC1, NOT the ACC2 row
  const uA2 = await usage.readUsage(acc2, cliA, T0);
  assert.equal(uA2.clientUsed, 9999);       // A on ACC2 kept separate
});
