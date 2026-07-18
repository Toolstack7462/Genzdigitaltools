'use strict';
/**
 * Tests for STRICT Claude quota ENFORCEMENT with atomic reservations, driving the REAL ClaudeUsage
 * ledger through the REAL mysqlAdapter (in-memory pool). Covers the reported bug (over-limit still
 * allowed), the used + reserved + est <= limit rule for five-hour / weekly / shared account,
 * reservation settle + dedup, release, admin-reduces-limit-below-usage, and — critically —
 * CONCURRENCY: simultaneous requests can never bypass the quota.
 *
 * Run: node --test tests/claudeQuotaEnforce.test.js
 */
const { test } = require('node:test');
const assert = require('node:assert/strict');
const adapter = require('../db/mysqlAdapter');
const usage = require('../utils/proxy/claudeUsage');

function setMemPool() {
  const tables = new Map();
  const tableOf = (sql) => (sql.match(/`([a-z_]+)`/i) || [])[1];
  const store = (t) => tables.get(t) || (tables.set(t, new Map()), tables.get(t));
  adapter.__test.setPool({
    query: async (sql, params) => {
      const t = tableOf(sql);
      if (/^INSERT INTO/i.test(sql)) { store(t).set(String(params[0]), params[1]); return [[]]; }
      if (/^DELETE FROM/i.test(sql)) { store(t).delete(String(params[0])); return [{ affectedRows: 1 }]; }
      if (/^SELECT/i.test(sql)) {
        if (/WHERE id = \?/i.test(sql)) { const r = store(t).get(String(params[0])); return [r ? [{ data: r }] : []]; }
        if (/WHERE/i.test(sql)) throw new Error('full scan');
        return [[...store(t).values()].map(data => ({ data }))];
      }
      return [[]];
    },
  });
  return tables;
}

const T0 = '2026-07-18T09:00:00.000Z';
const ACC = { _id: 'ACC1', plan: 'max20', cycleResetAt: '2026-07-18T06:00:00.000Z', weeklyResetAt: '2026-07-14T06:00:00.000Z' };
// Pro-scaled account capacity is huge for max20, so these client-limit tests hit the CLIENT gate.

async function recordSettled(client, tokens, requestId) {
  await usage.recordUsage({ account: ACC, client, userId: 'u', inputTokens: tokens, outputTokens: 0, requestId, now: T0 });
}

test('REPORTED BUG: an already-over-limit client is BLOCKED, not allowed', async () => {
  setMemPool();
  const client = { _id: 'CLI', tokenLimit: 149 };
  await recordSettled(client, 483, 'past'); // 483 settled tokens, limit 149 → already way over
  const rc = await usage.reserveAndCheck({ account: ACC, client, estTokens: 10, requestId: 'new', now: T0 });
  assert.equal(rc.allowed, false, 'over-limit request must be denied (429), never allowed');
  assert.equal(rc.reason, 'client_limit');
  assert.equal(rc.reserved, false); // denied → holds no reservation
});

test('strict rule: used + reserved + est <= limit (a second in-flight request is denied)', async () => {
  setMemPool();
  const client = { _id: 'CLI', tokenLimit: 149 };
  await recordSettled(client, 100, 'p'); // used = 100
  const a = await usage.reserveAndCheck({ account: ACC, client, estTokens: 40, requestId: 'a', now: T0 });
  assert.equal(a.allowed, true);   // 100 + 0 + 40 = 140 <= 149
  const b = await usage.reserveAndCheck({ account: ACC, client, estTokens: 40, requestId: 'b', now: T0 });
  assert.equal(b.allowed, false);  // 100 + 40(reserved a) + 40 = 180 > 149
  assert.equal(b.reason, 'client_limit');
});

test('exact-fit boundary is allowed, one-over is denied', async () => {
  setMemPool();
  const client = { _id: 'CLI', tokenLimit: 149 };
  await recordSettled(client, 100, 'p');
  const fit = await usage.reserveAndCheck({ account: ACC, client, estTokens: 49, requestId: 'fit', now: T0 });
  assert.equal(fit.allowed, true); // 100 + 49 = 149
  const over = await usage.reserveAndCheck({ account: ACC, client, estTokens: 1, requestId: 'over', now: T0 });
  assert.equal(over.allowed, false); // 149 + 1 > 149
});

test('CONCURRENCY: simultaneous reservations cannot bypass the limit', async () => {
  setMemPool();
  const client = { _id: 'CLI', tokenLimit: 149 };
  // 10 simultaneous requests, each estimating 40 tokens, against a 149 limit and 0 prior usage.
  const results = await Promise.all(
    Array.from({ length: 10 }, (_, i) => usage.reserveAndCheck({ account: ACC, client, estTokens: 40, requestId: 'c' + i, now: T0 })),
  );
  const admitted = results.filter(r => r.allowed);
  // floor(149 / 40) = 3 may be admitted; 4 * 40 = 160 would exceed.
  assert.equal(admitted.length, 3, 'exactly 3 of 10 concurrent 40-token requests fit under 149');
  assert.ok(admitted.length * 40 <= 149, 'admitted reservations never sum past the limit');
  assert.ok(results.filter(r => !r.allowed).every(r => r.reason === 'client_limit'));
});

test('CONCURRENCY: shared-account capacity cannot be bypassed by multiple clients at once', async () => {
  setMemPool();
  // Two clients with generous individual limits share one account; the ACCOUNT capacity must gate.
  const acct = { _id: 'ACC2', plan: 'pro', cycleResetAt: '2026-07-18T06:00:00.000Z' }; // Pro capacity = 44000*0.8 = 35200
  const cliA = { _id: 'A', tokenLimit: 100000000 };
  const cliB = { _id: 'B', tokenLimit: 100000000 };
  const est = 20000;
  const results = await Promise.all([
    usage.reserveAndCheck({ account: acct, client: cliA, estTokens: est, requestId: 'a', now: T0 }),
    usage.reserveAndCheck({ account: acct, client: cliB, estTokens: est, requestId: 'b', now: T0 }),
    usage.reserveAndCheck({ account: acct, client: cliA, estTokens: est, requestId: 'c', now: T0 }),
  ]);
  const admitted = results.filter(r => r.allowed);
  assert.equal(admitted.length, 1, 'only one 20k request fits the 35200 shared capacity (2*20k over)');
  assert.ok(results.some(r => !r.allowed && r.reason === 'account_capacity'));
});

test('weekly limit is enforced with the same reservation rule', async () => {
  setMemPool();
  const client = { _id: 'CLI', tokenLimit: 100000000, weeklyTokenLimit: 200 };
  await recordSettled(client, 150, 'p'); // weekly used 150 of 200 (five-hour limit is generous)
  const a = await usage.reserveAndCheck({ account: ACC, client, estTokens: 40, requestId: 'a', now: T0 });
  assert.equal(a.allowed, true);  // 150 + 40 = 190 <= 200
  const b = await usage.reserveAndCheck({ account: ACC, client, estTokens: 40, requestId: 'b', now: T0 });
  assert.equal(b.allowed, false); // 150 + 40 + 40 = 230 > 200 (weekly)
  assert.equal(b.reason, 'weekly_client_limit');
});

test('admin reduces the limit below current usage → new requests blocked immediately', async () => {
  setMemPool();
  const client = { _id: 'CLI', tokenLimit: 500 };
  await recordSettled(client, 300, 'p');
  assert.equal((await usage.reserveAndCheck({ account: ACC, client, estTokens: 50, requestId: 'ok', now: T0 })).allowed, true);
  await usage.releaseReservation({ accountId: ACC._id, requestId: 'ok' }); // (that request didn't proceed)
  // Admin cuts the limit to 149 (below the 300 already used).
  const reduced = { _id: 'CLI', tokenLimit: 149 };
  const rc = await usage.reserveAndCheck({ account: ACC, client: reduced, estTokens: 1, requestId: 'blk', now: T0 });
  assert.equal(rc.allowed, false, 'usage 300 > new limit 149 → blocked until reset');
  assert.equal(rc.reason, 'client_limit');
});

test('settle converts a reservation to actual usage and dedups (no double charge)', async () => {
  setMemPool();
  const client = { _id: 'CLI', tokenLimit: 9997 };
  const rc = await usage.reserveAndCheck({ account: ACC, client, estTokens: 17, requestId: 'r1', now: T0 });
  assert.equal(rc.allowed, true);
  // Settle with the ACTUAL usage (17 input + 115 output = 132).
  const s1 = await usage.settleUsage({ account: ACC, client, userId: 'u', inputTokens: 17, contextTokens: 0, outputTokens: 115, requestId: 'r1', now: T0 });
  assert.equal(s1.recorded, true);
  // Duplicate settle for the same request must NOT double-charge.
  const s2 = await usage.settleUsage({ account: ACC, client, userId: 'u', inputTokens: 17, contextTokens: 0, outputTokens: 115, requestId: 'r1', now: T0 });
  assert.equal(s2.duplicate, true);
  const u = await usage.readUsage(ACC, client, T0);
  assert.equal(u.clientUsed, 132, 'settled once (reservation replaced by real usage, no residue)');
});

test('release frees a reservation so a failed request holds no quota', async () => {
  setMemPool();
  const client = { _id: 'CLI', tokenLimit: 149 };
  const rc = await usage.reserveAndCheck({ account: ACC, client, estTokens: 100, requestId: 'r1', now: T0 });
  assert.equal(rc.allowed, true);
  // A second request would be blocked while the reservation is held...
  assert.equal((await usage.reserveAndCheck({ account: ACC, client, estTokens: 100, requestId: 'r2', now: T0 })).allowed, false);
  // ...but after releasing r1 (upstream failed), the estimate is freed and a new one fits.
  await usage.releaseReservation({ accountId: ACC._id, requestId: 'r1' });
  assert.equal((await usage.reserveAndCheck({ account: ACC, client, estTokens: 100, requestId: 'r3', now: T0 })).allowed, true);
});

test('an expired reservation stops counting against the limit', async () => {
  setMemPool();
  const client = { _id: 'CLI', tokenLimit: 149 };
  // Reserve with a 1ms TTL, then check well after it has expired.
  await usage.reserveAndCheck({ account: ACC, client, estTokens: 140, requestId: 'stale', now: T0, ttlMs: 1 });
  const later = '2026-07-18T09:05:00.000Z'; // 5 min later → the reservation has expired
  const rc = await usage.reserveAndCheck({ account: ACC, client, estTokens: 140, requestId: 'fresh', now: later });
  assert.equal(rc.allowed, true, 'the expired reservation no longer blocks a fresh request');
});
