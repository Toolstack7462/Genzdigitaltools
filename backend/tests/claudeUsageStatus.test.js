'use strict';
/**
 * Tests for the CLIENT-FACING usage widget data — the read-only "Estimated usage" status that
 * drives the Claude account widget's five-hour + weekly progress lines. Pure math, no DB.
 * Covers: percentage calculation, capped progress display, Custom/Default limit source,
 * effective-limit priority, weekly reset day/date, usage PERSISTENCE across a limit change, and
 * ENFORCEMENT (usage past a reduced limit blocks future requests). Run:
 *   node --test tests/claudeUsageStatus.test.js
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const q = require('../utils/proxy/claudeQuota');
const usage = require('../utils/proxy/claudeUsage');

// Build the usage object shape that readUsage() would return, but purely (no DB).
function usageFor(account, clientUsed, weeklyClientUsed, now, synced = true) {
  const keys = usage.cycleKeysFor(account, now);
  return { clientUsed, accountUsed: clientUsed, weeklyClientUsed, weeklyAccountUsed: weeklyClientUsed, keys, synced };
}

// ── usagePercent: accurate, integer, capped at 100 ───────────────────────────
test('usagePercent = used / limit, rounded, capped to [0,100]', () => {
  assert.equal(q.usagePercent(0, 20000), 0);
  assert.equal(q.usagePercent(12400, 20000), 62);   // 62% used (spec example)
  assert.equal(q.usagePercent(78000, 200000), 39);  // 39% used (spec example)
  assert.equal(q.usagePercent(20000, 20000), 100);  // exactly full
  assert.equal(q.usagePercent(50000, 20000), 100);  // over a reduced limit → still capped at 100
  assert.equal(q.usagePercent(1, 0), 100);          // hard-stop (limit 0) with usage → 100
  assert.equal(q.usagePercent(0, 0), 0);            // hard-stop, nothing used → 0
  assert.equal(q.usagePercent(1, 20000), 1);        // real sub-0.5% usage never renders as 0%
  assert.equal(q.usagePercent(0, 20000), 0);        // genuinely nothing used → 0%
});

// ── limitSource: Custom vs Default badge ─────────────────────────────────────
test('limitSource: client override → custom; account default → account; else default', () => {
  assert.equal(q.limitSource(5000, null), 'custom');    // per-client override
  assert.equal(q.limitSource(0, null), 'custom');       // 0 is an explicit override (hard-stop), not "unset"
  assert.equal(q.limitSource(null, 30000), 'account');  // account default, no client override
  assert.equal(q.limitSource(null, null), 'default');   // global default
  assert.equal(q.limitSource('', ''), 'default');
  assert.equal(q.limitSource(-5, null), 'default');     // invalid override falls through
});

// ── Effective limit priority + Custom/Default surfaced in the status ─────────
test('usageStatus resolves effective limits by priority and labels the source', () => {
  const account = { plan: 'pro', clientTokenLimit: 30000, weeklyClientTokenLimit: 250000 };
  // Client overrides the five-hour limit but NOT the weekly one → 5h Custom, weekly Account/Default.
  const client = { tokenLimit: 12000, weeklyTokenLimit: null };
  const now = '2026-07-21T12:00:00.000Z';
  const st = usage.usageStatus({ account, client, usage: usageFor(account, 6000, 100000, now), now });

  assert.equal(st.fiveHour.limit, 12000);       // client override wins
  assert.equal(st.fiveHour.source, 'custom');
  assert.equal(st.fiveHour.used, 6000);
  assert.equal(st.fiveHour.percent, 50);        // 6000 / 12000
  assert.equal(st.fiveHour.remaining, 6000);

  assert.equal(st.weekly.limit, 250000);        // account default (no client override)
  assert.equal(st.weekly.source, 'account');
  assert.equal(st.weekly.percent, 40);          // 100000 / 250000
  assert.equal(st.label, 'Estimated local token usage');
});

test('usageStatus falls back to the GLOBAL default when neither client nor account set a limit', () => {
  const account = { plan: 'pro' };
  const client = {};
  const now = '2026-07-21T12:00:00.000Z';
  const st = usage.usageStatus({ account, client, usage: usageFor(account, 5000, 30000, now), now });
  assert.equal(st.fiveHour.limit, 20000);   // global default per spec
  assert.equal(st.fiveHour.source, 'default');
  assert.equal(st.weekly.limit, 150000);    // global weekly default per spec
  assert.equal(st.weekly.source, 'default');
});

// ── Weekly reset day / date / time (the exact moment the widget renders) ─────
test('weekly reset resetAt is the end of the shared weekly window (drives the widget date)', () => {
  // Account anchor is a Tuesday 17:00 UTC; the weekly window rolls every 7 days from it.
  const account = { plan: 'pro', weeklyResetAt: '2026-07-14T17:00:00.000Z' }; // Tue 14 July 17:00Z
  const now = '2026-07-18T09:00:00.000Z';  // within the window that ends Tue 21 July 17:00Z
  const st = usage.usageStatus({ account, client: {}, usage: usageFor(account, 0, 78000, now), now });

  const reset = new Date(st.weekly.resetAt);
  assert.equal(reset.toISOString(), '2026-07-21T17:00:00.000Z'); // next Tuesday, 21 July, 17:00Z
  assert.equal(reset.getUTCDay(), 2);   // Tuesday
  assert.equal(reset.getUTCDate(), 21); // 21st
  // exactly one week after the previous boundary
  assert.equal(st.weekly.resetAt - new Date('2026-07-14T17:00:00.000Z').getTime(), q.WEEK_MS);
});

test('five-hour reset resetAt is the end of the current five-hour window', () => {
  const account = { plan: 'pro', cycleResetAt: '2026-07-18T00:00:00.000Z' };
  const now = '2026-07-18T06:30:00.000Z'; // in the [05:00,10:00) window
  const st = usage.usageStatus({ account, client: {}, usage: usageFor(account, 1000, 0, now), now });
  assert.equal(new Date(st.fiveHour.resetAt).toISOString(), '2026-07-18T10:00:00.000Z');
  assert.equal(st.fiveHour.resetInSeconds, Math.round((new Date('2026-07-18T10:00:00.000Z') - new Date(now)) / 1000));
});

// ── Shared reset: two clients on the same account share the same reset moment ─
test('all clients on one account share the account reset timestamps', () => {
  const account = { plan: 'max5', weeklyResetAt: '2026-07-14T17:00:00.000Z', cycleResetAt: '2026-07-18T00:00:00.000Z' };
  const now = '2026-07-18T06:30:00.000Z';
  const a = usage.usageStatus({ account, client: { _id: 'c1', tokenLimit: 5000 }, usage: usageFor(account, 100, 0, now), now });
  const b = usage.usageStatus({ account, client: { _id: 'c2', tokenLimit: 9000 }, usage: usageFor(account, 200, 0, now), now });
  assert.equal(a.fiveHour.resetAt, b.fiveHour.resetAt); // same shared reset moment
  assert.equal(a.weekly.resetAt, b.weekly.resetAt);
  assert.notEqual(a.fiveHour.limit, b.fiveHour.limit);  // but each keeps its own custom limit
});

// ── Persistence: usage is preserved when the limit is increased or reduced ────
test('usage is preserved across a limit change (percent recomputes, used unchanged)', () => {
  const account = { plan: 'pro' };
  const now = '2026-07-21T12:00:00.000Z';
  const used = 15000;
  const before = usage.usageStatus({ account, client: { tokenLimit: 20000 }, usage: usageFor(account, used, 0, now), now });
  assert.equal(before.fiveHour.used, 15000);
  assert.equal(before.fiveHour.percent, 75);          // 15000/20000
  assert.equal(before.fiveHour.atLimit, false);

  // Admin REDUCES the limit to 10000. Same recorded usage (ledger is append-only → preserved).
  const afterCut = usage.usageStatus({ account, client: { tokenLimit: 10000 }, usage: usageFor(account, used, 0, now), now });
  assert.equal(afterCut.fiveHour.used, 15000);        // usage NOT reset
  assert.equal(afterCut.fiveHour.percent, 100);       // capped at 100 even though raw is 150
  assert.equal(afterCut.fiveHour.percentRaw, 150);    // uncapped signal available
  assert.equal(afterCut.fiveHour.over, true);         // exceeds the reduced limit
  assert.equal(afterCut.fiveHour.atLimit, true);      // no room → future requests blocked

  // Admin INCREASES the limit to 40000. Usage still preserved; now well under.
  const afterRaise = usage.usageStatus({ account, client: { tokenLimit: 40000 }, usage: usageFor(account, used, 0, now), now });
  assert.equal(afterRaise.fiveHour.used, 15000);
  assert.equal(afterRaise.fiveHour.percent, 38);      // 15000/40000 ≈ 37.5 → 38
  assert.equal(afterRaise.fiveHour.atLimit, false);
});

// ── Enforcement: usage past a reduced limit blocks future requests ───────────
test('enforcement: over-limit status corresponds to a real deny in checkAllowance', () => {
  const account = { plan: 'pro' };
  const client = { tokenLimit: 10000 };
  const now = '2026-07-21T12:00:00.000Z';
  const st = usage.usageStatus({ account, client, usage: usageFor(account, 15000, 0, now), now });
  assert.equal(st.fiveHour.atLimit, true);

  // The very same numbers, run through the enforcement gate → any further request is denied.
  const decision = usage.resolveDecision({ account, client, clientUsed: 15000, accountUsed: 15000, estIncoming: 1 });
  assert.equal(decision.allowed, false);
  assert.equal(decision.reason, 'client_limit');
});

// ── Not synced: a DB-read failure must NOT fabricate a zero ───────────────────
test('usageStatus carries synced:false through so the widget shows "Not synced"', () => {
  const account = { plan: 'pro' };
  const now = '2026-07-21T12:00:00.000Z';
  const st = usage.usageStatus({ account, client: {}, usage: usageFor(account, 0, 0, now, /*synced*/ false), now });
  assert.equal(st.synced, false);
});
