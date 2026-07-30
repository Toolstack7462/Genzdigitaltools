'use strict';
/**
 * A renewal email that the provider never accepted must be VISIBLE and RETRYABLE.
 *
 * WHY THIS EXISTS. When a deferred renewal send failed, the route returned silently: the only
 * trace was a console line on a host whose logs are not reachable from the application. From
 * the admin's side a total delivery outage was indistinguishable from "nobody clicked the
 * button" — which is precisely how this bug survived two rounds of fixes and came back.
 *
 * Recording the failure introduces a hazard that must be pinned down, because getting it
 * wrong is worse than not recording at all:
 *   1. A failed row must never count as "Last reminded" (it would report an outage as success).
 *   2. A failed row must never open the 60-second duplicate window (it would suppress the
 *      admin's retry, stranding the client with no reminder at all).
 *
 * These tests exercise the real helpers from routes/admin/renewals.js by extracting them, so
 * they assert the shipped logic rather than a copy of it.
 *
 * Run: node --test tests/renewalFailureVisible.test.js
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const SRC = fs.readFileSync(path.join(__dirname, '..', 'routes', 'admin', 'renewals.js'), 'utf8');

// ── The status predicate the route uses everywhere ───────────────────────────
function loadIsSentRow() {
  const m = SRC.match(/function isSentRow\(r\) \{[\s\S]*?\n\}/);
  assert.ok(m, 'isSentRow must exist in routes/admin/renewals.js');
  // eslint-disable-next-line no-new-func
  return new Function(`${m[0]}; return isSentRow;`)();
}
const isSentRow = loadIsSentRow();

test('a failed row is never treated as a successful reminder', () => {
  assert.equal(isSentRow({ status: 'failed' }), false);
});

test('a sent row, and a LEGACY row with no status at all, both count as sent', () => {
  // Rows written before the status field existed were only ever created on acceptance.
  // Treating them as failures would blank out every historical "Last reminded".
  assert.equal(isSentRow({ status: 'sent' }), true);
  assert.equal(isSentRow({}), true);
  assert.equal(isSentRow({ sentAt: new Date() }), true);
});

test('the dedupe scan skips failed rows, so a failure can be retried immediately', () => {
  // Mirrors recentEmailReminder's loop against a history whose NEWEST row is a failure.
  const now = Date.now();
  const rows = [
    { status: 'failed', sentAt: new Date(now - 1000) },   // newest: just failed
    { status: 'sent',   sentAt: new Date(now - 600000) }, // an old success, well outside the window
  ];
  const windowMs = 60000;
  let deduped = null;
  for (const r of rows) {
    if (!isSentRow(r)) continue;
    const at = new Date(r.sentAt).getTime();
    if (at && at >= now - windowMs) { deduped = new Date(at); break; }
  }
  assert.equal(deduped, null, 'a fresh FAILURE must not suppress the retry as a duplicate');
});

test('a genuine recent success still dedupes — the retry guard must not be disarmed', () => {
  const now = Date.now();
  const rows = [{ status: 'sent', sentAt: new Date(now - 5000) }];
  const windowMs = 60000;
  let deduped = null;
  for (const r of rows) {
    if (!isSentRow(r)) continue;
    const at = new Date(r.sentAt).getTime();
    if (at && at >= now - windowMs) { deduped = new Date(at); break; }
  }
  assert.ok(deduped, 'two rapid clicks must still collapse to one email');
});

// ── The route's own wiring ───────────────────────────────────────────────────

test('the failure path records a row and the success path is still acceptance-gated', () => {
  // The failure branch must persist something...
  const failBranch = SRC.match(/stage=failed[\s\S]{0,1600}?\n      \}/);
  assert.ok(failBranch, 'the failure branch must exist');
  assert.match(failBranch[0], /RenewalReminderLog\.create/,
    'a failed send must leave a durable trace, not just a log line');
  assert.match(failBranch[0], /status:\s*'failed'/, 'and it must be marked as failed');
  assert.match(failBranch[0], /failureCode/, 'with the provider code, so the cause is visible');

  // ...and must NOT call record(), which is what advances "Last reminded". Bounded precisely
  // to the failure branch: it ends where the success path's `stage=accepted` log begins.
  const start = SRC.indexOf('stage=failed');
  const end = SRC.indexOf('stage=accepted');
  assert.ok(start > 0 && end > start, 'both branches must be present, failure first');
  const failureOnly = SRC.slice(start, end);
  assert.ok(!/\brecord\s*\(/.test(failureOnly),
    'a failed send must never call record() — that would report an outage as a success');
});

test('the list separates delivered reminders from failed attempts', () => {
  assert.match(SRC, /lastFailureByClient/, 'failures are collected separately');
  assert.match(SRC, /lastFailure:/, 'and exposed to the UI');
  // The success map must be gated on isSentRow, or a failure becomes "Last reminded".
  const block = SRC.match(/const lastReminderByClient[\s\S]*?catch \(_\)/);
  assert.ok(block, 'the reminder-map builder must exist');
  assert.match(block[0], /isSentRow\(l\)/, 'the "Last reminded" map must exclude failed rows');
});

test('the provider message id is still recorded on acceptance', () => {
  // Correlation evidence must survive this change: it is the only proof of a real send.
  assert.match(SRC, /providerMessageId/, 'accepted sends still persist the provider id');
  assert.match(SRC, /correlationId/, 'and a correlation id for tracing');
});
