'use strict';
/**
 * Tests for the Renewals date-window + sort logic (backend/utils/renewalWindow.js).
 * Runs with Node's built-in runner (no jest needed):  node --test backend/tests/renewalWindow.test.js
 * Pure logic only — no DB / HTTP.
 */
const { test } = require('node:test');
const assert = require('node:assert');
const {
  ARCHIVE_AFTER_DAYS, resolveWindow, classifyExpiry, compareClients,
  startOfDay, endOfDay, addDays, parseYMD,
} = require('../utils/renewalWindow');

const NOW = new Date('2026-07-04T12:00:00.000Z'); // fixed clock for determinism
// Inclusive end-of-day boundary N days from "today" — mirrors ToolAssignment.effectiveEndBoundary.
const boundaryIn = (n) => endOfDay(addDays(startOfDay(NOW), n));
const inWin = (n, win) => classifyExpiry(boundaryIn(n), NOW, win) !== null;

test('next7/14/30 use real ranges (exclude far-future AND all past)', () => {
  const w7 = resolveWindow({ range: 'next7' }, NOW);
  assert.ok(inWin(3, w7) && inWin(7, w7), 'next7 includes +3 and +7');
  assert.ok(!inWin(8, w7), 'next7 excludes +8');
  assert.ok(!inWin(-1, w7), 'next7 excludes yesterday');
  assert.ok(!inWin(-(ARCHIVE_AFTER_DAYS + 50), w7), 'next7 excludes long-expired');
  assert.ok(!inWin(20, resolveWindow({ range: 'next14' }, NOW)), 'next14 excludes +20');
  assert.ok(!inWin(45, resolveWindow({ range: 'next30' }, NOW)), 'next30 excludes +45');
});

test('today / tomorrow windows', () => {
  const wt = resolveWindow({ range: 'today' }, NOW);
  assert.ok(inWin(0, wt) && !inWin(1, wt) && !inWin(-1, wt));
  const wm = resolveWindow({ range: 'tomorrow' }, NOW);
  assert.ok(inWin(1, wm) && !inWin(0, wm) && !inWin(2, wm));
});

test('default window keeps recently-overdue + upcoming, drops long-expired', () => {
  const wd = resolveWindow({}, NOW);
  assert.ok(inWin(10, wd), 'default keeps upcoming');
  assert.ok(inWin(-5, wd), 'default keeps recently overdue');
  assert.ok(!inWin(-(ARCHIVE_AFTER_DAYS + 50), wd), 'default drops long-expired');
});

test('overdue and archived windows partition expired records at the grace boundary', () => {
  const wo = resolveWindow({ range: 'overdue' }, NOW);
  assert.ok(inWin(-2, wo) && !inWin(2, wo) && !inWin(-(ARCHIVE_AFTER_DAYS + 20), wo));
  const wa = resolveWindow({ range: 'archived' }, NOW);
  assert.ok(inWin(-(ARCHIVE_AFTER_DAYS + 20), wa) && !inWin(-2, wa) && !inWin(5, wa));
});

test('custom single date and custom range', () => {
  const d = resolveWindow({ from: '2026-07-10' }, NOW);       // NOW is Jul 4 → Jul 10 = +6
  assert.ok(inWin(6, d) && !inWin(5, d) && !inWin(7, d), 'single custom date is that day only');
  const r = resolveWindow({ from: '2026-07-01', to: '2026-07-31' }, NOW);
  assert.ok(classifyExpiry(endOfDay(parseYMD('2026-07-15')), NOW, r) !== null, 'range includes mid-month');
  assert.ok(classifyExpiry(endOfDay(parseYMD('2026-08-05')), NOW, r) === null, 'range excludes out-of-range');
});

test('all window is unbounded', () => {
  const w = resolveWindow({ range: 'all' }, NOW);
  assert.equal(w.start, null); assert.equal(w.end, null);
  assert.ok(inWin(500, w) && inWin(-500, w));
});

test('back-compat: ?days=N maps to the default actionable window up to +N', () => {
  const w = resolveWindow({ days: '7' }, NOW);
  assert.equal(w.mode, 'default');
  assert.ok(inWin(7, w) && !inWin(8, w) && inWin(-5, w));
});

test('classifyExpiry derives expired / overdueDays / archived; null for lifetime', () => {
  const win = resolveWindow({ range: 'all' }, NOW);
  const up = classifyExpiry(boundaryIn(5), NOW, win);
  assert.equal(up.expired, false); assert.equal(up.archived, false); assert.ok(up.daysLeft >= 4);
  const recent = classifyExpiry(boundaryIn(-3), NOW, win);
  assert.equal(recent.expired, true); assert.equal(recent.archived, false); assert.ok(recent.overdueDays >= 2);
  const old = classifyExpiry(boundaryIn(-(ARCHIVE_AFTER_DAYS + 10)), NOW, win);
  assert.equal(old.expired, true); assert.equal(old.archived, true);
  assert.equal(classifyExpiry(null, NOW, win), null, 'no expiry → not a renewal candidate');
});

test('compareClients: upcoming first (Today → Next N), then expired most-recent first, archived last', () => {
  const mk = (soonestDaysLeft, archived = false) => ({ soonestDaysLeft, archived });
  const clients = [ mk(10), mk(-3), mk(0), mk(-60, true), mk(2), mk(-1) ];
  clients.sort(compareClients);
  assert.deepEqual(
    clients.map(c => c.soonestDaysLeft),
    [0, 2, 10, -1, -3, -60],
    'today/upcoming soonest-first, then expired freshest-first, then archived (old) at the very bottom',
  );
});
