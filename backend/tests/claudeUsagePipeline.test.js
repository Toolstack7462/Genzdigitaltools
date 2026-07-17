'use strict';
/**
 * Integration/smoke test for the Claude usage PIPELINE (record → read → decide) against a
 * stubbed in-memory ledger model. Exercises the DB-facing wrappers in utils/proxy/claudeUsage.js
 * without a real database. Run: node --test tests/claudeUsagePipeline.test.js
 */
const test = require('node:test');
const assert = require('node:assert/strict');

// Replace the ledger model with an in-memory stub BEFORE requiring the module under test.
const ClaudeUsage = require('../models/proxy/ClaudeUsage');
const ROWS = [];
ClaudeUsage.create = async (data) => {
  // Mimic preSave normalization we rely on (cycleKey/total kept as given).
  const row = Object.assign({ totalTokens: (Number(data.inputTokens) || 0) + (Number(data.outputTokens) || 0), kind: 'usage' }, data);
  ROWS.push(row);
  return row;
};
ClaudeUsage.find = async (q) => ROWS.filter(r =>
  (q.accountId === undefined || String(r.accountId) === String(q.accountId)) &&
  (q.cycleKey === undefined || String(r.cycleKey) === String(q.cycleKey))
);
ClaudeUsage.deleteMany = async () => ({});

const usage = require('../utils/proxy/claudeUsage');

const account = { _id: 'ACC1', plan: 'pro', cycleResetAt: '2026-01-01T00:00:00.000Z', createdAt: '2026-01-01T00:00:00.000Z' };
const clientA = { _id: 'CLA', tokenLimit: 20000 };
const clientB = { _id: 'CLB', tokenLimit: 5000 };
const NOW = '2026-01-01T02:00:00.000Z'; // inside the first 5h window

test('record → read: appended rows are summed for the client and the shared account', async () => {
  ROWS.length = 0;
  await usage.recordUsage({ account, client: clientA, userId: 'uA', inputTokens: 100, outputTokens: 300, now: NOW });
  await usage.recordUsage({ account, client: clientA, userId: 'uA', inputTokens: 50, outputTokens: 50, now: NOW });
  await usage.recordUsage({ account, client: clientB, userId: 'uB', inputTokens: 200, outputTokens: 0, now: NOW });

  const a = await usage.readUsage(account, clientA, NOW);
  assert.equal(a.clientUsed, 500);   // 400 + 100
  assert.equal(a.accountUsed, 700);  // shared: 400 + 100 + 200

  const b = await usage.readUsage(account, clientB, NOW);
  assert.equal(b.clientUsed, 200);
  assert.equal(b.accountUsed, 700);  // same shared account total
});

test('append-only is race-safe: two concurrent records both persist (no lost update)', async () => {
  ROWS.length = 0;
  await Promise.all([
    usage.recordUsage({ account, client: clientA, userId: 'uA', inputTokens: 0, outputTokens: 1000, now: NOW }),
    usage.recordUsage({ account, client: clientA, userId: 'uA', inputTokens: 0, outputTokens: 1000, now: NOW }),
  ]);
  const a = await usage.readUsage(account, clientA, NOW);
  assert.equal(a.clientUsed, 2000); // both writes survived (a counter would have lost one)
});

test('usage from a different 5-hour cycle is not counted (reset rollover)', async () => {
  ROWS.length = 0;
  await usage.recordUsage({ account, client: clientA, userId: 'uA', inputTokens: 0, outputTokens: 9000, now: NOW });
  // Six hours later → next window → previous usage no longer counts.
  const later = '2026-01-01T06:00:00.000Z';
  const a = await usage.readUsage(account, clientA, later);
  assert.equal(a.clientUsed, 0);
  assert.equal(a.accountUsed, 0);
});

test('full decision reflects recorded usage and denies once the client limit is crossed', async () => {
  ROWS.length = 0;
  await usage.recordUsage({ account, client: clientB, userId: 'uB', inputTokens: 0, outputTokens: 4800, now: NOW });
  const u = await usage.readUsage(account, clientB, NOW);
  // clientB limit 5000, used 4800; a 300-token request would exceed → deny (client_limit).
  const d = usage.resolveDecision({ account, client: clientB, clientUsed: u.clientUsed, accountUsed: u.accountUsed, estIncoming: 300 });
  assert.equal(d.allowed, false);
  assert.equal(d.reason, 'client_limit');
  // A 100-token request still fits (4800 + 100 <= 5000).
  const d2 = usage.resolveDecision({ account, client: clientB, clientUsed: u.clientUsed, accountUsed: u.accountUsed, estIncoming: 100 });
  assert.equal(d2.allowed, true);
});

test('readUsage fails OPEN (returns zero usage) when the ledger read throws', async () => {
  const orig = ClaudeUsage.find;
  ClaudeUsage.find = async () => { throw new Error('db down'); };
  const u = await usage.readUsage(account, clientA, NOW);
  assert.equal(u.clientUsed, 0);
  assert.equal(u.accountUsed, 0);
  ClaudeUsage.find = orig;
});
