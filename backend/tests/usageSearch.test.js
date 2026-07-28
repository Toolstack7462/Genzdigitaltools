'use strict';
/**
 * Claude usage-dashboard client search + pagination (utils/proxy/usageSearch.js).
 *
 * Covers the behaviour the admin actually relies on: matching by name, partial email and assigned
 * account, case-insensitively; a correct empty result; a stable order; and pagination that stays
 * consistent while a search is active.
 *
 * These are pure-function tests on purpose. The route's I/O (which client, which account, which
 * ledger rows) is unchanged by this feature; what IS new is the selection logic, and that is
 * exactly what is exercised here — no DB, no admin session, no live account required.
 */
const test = require('node:test');
const assert = require('node:assert');
const us = require('../utils/proxy/usageSearch');

// A small, deliberately messy fixture: mixed case, a shared account, an unassigned client, and a
// client whose User record is missing (which the real data does contain).
const entry = (id, fullName, email, label) => ({
  pc: { _id: id },
  user: fullName === null ? null : { fullName, email, status: 'active' },
  account: label === null ? null : { _id: 'acct-' + label, label },
});

const FIXTURE = [
  entry('c1', 'Alice Johnson', 'alice@example.com', 'Account 1'),
  entry('c2', 'Bob Smith', 'bob.smith@work.co.uk', 'Account 2'),
  entry('c3', 'Carol White', 'carol@EXAMPLE.com', 'Account 1'),
  entry('c4', 'dave brown', 'dave@other.net', null),          // unassigned
  entry('c5', null, null, 'Account 3'),                        // no User record
];
const ids = (r) => r.entries.map((e) => e.pc._id);

// ── Matching ────────────────────────────────────────────────────────────────
test('search by client NAME', () => {
  assert.deepStrictEqual(ids(us.selectPage(FIXTURE, { q: 'Alice' })), ['c1']);
  assert.deepStrictEqual(ids(us.selectPage(FIXTURE, { q: 'Smith' })), ['c2']);
});

test('search by PARTIAL email', () => {
  // A fragment from the middle of the address, and a domain shared by two clients.
  assert.deepStrictEqual(ids(us.selectPage(FIXTURE, { q: 'ob.smi' })), ['c2']);
  assert.deepStrictEqual(ids(us.selectPage(FIXTURE, { q: 'example.com' })), ['c1', 'c3']);
  assert.deepStrictEqual(ids(us.selectPage(FIXTURE, { q: '@' })).length, 4, 'every client that has an email');
});

test('search by assigned ACCOUNT', () => {
  assert.deepStrictEqual(ids(us.selectPage(FIXTURE, { q: 'Account 1' })), ['c1', 'c3']);
  assert.deepStrictEqual(ids(us.selectPage(FIXTURE, { q: 'account 3' })), ['c5'],
    'a client with no User record is still findable by its account');
});

test('matching is CASE-INSENSITIVE in both directions', () => {
  for (const q of ['alice', 'ALICE', 'AlIcE']) {
    assert.deepStrictEqual(ids(us.selectPage(FIXTURE, { q })), ['c1'], q);
  }
  // Upper-case stored value, lower-case term.
  assert.deepStrictEqual(ids(us.selectPage(FIXTURE, { q: 'carol@example' })), ['c3']);
  // Lower-case stored value, upper-case term.
  assert.deepStrictEqual(ids(us.selectPage(FIXTURE, { q: 'DAVE' })), ['c4']);
});

test('a term is trimmed, and an empty term matches everything', () => {
  assert.deepStrictEqual(ids(us.selectPage(FIXTURE, { q: '   alice   ' })), ['c1']);
  for (const q of ['', '   ', null, undefined]) {
    assert.strictEqual(us.selectPage(FIXTURE, { q }).total, 5, String(q));
  }
});

test('NO-RESULT state: a non-matching term yields zero rows, not everything', () => {
  const r = us.selectPage(FIXTURE, { q: 'zzz-nobody' });
  assert.deepStrictEqual(r.entries, []);
  assert.strictEqual(r.total, 0);
  assert.strictEqual(r.totalPages, 1, 'still one (empty) page, so the pager cannot break');
  assert.strictEqual(r.page, 1);
});

test('a null user / null account never throws', () => {
  assert.doesNotThrow(() => us.selectPage([entry('x', null, null, null)], { q: 'anything' }));
  assert.strictEqual(us.selectPage([entry('x', null, null, null)], { q: 'anything' }).total, 0);
  assert.doesNotThrow(() => us.selectPage([{}, null], { q: 'a' }));
});

// ── Ordering ────────────────────────────────────────────────────────────────
test('order is deterministic and case-insensitive by name', () => {
  // 'dave brown' is lower-case in the fixture and must still sort under D, not after Z.
  assert.deepStrictEqual(ids(us.selectPage(FIXTURE, {})), ['c5', 'c1', 'c2', 'c3', 'c4'],
    'nameless first (empty string), then Alice, Bob, Carol, dave');
  // Re-ordering the input must not change the output — this is what makes pagination safe.
  const shuffled = [FIXTURE[3], FIXTURE[0], FIXTURE[4], FIXTURE[2], FIXTURE[1]];
  assert.deepStrictEqual(ids(us.selectPage(shuffled, {})), ids(us.selectPage(FIXTURE, {})));
});

test('clients sharing a name and email are still totally ordered (id tie-break)', () => {
  const dupes = [entry('z9', 'Same Name', 'same@x.com', 'A'), entry('a1', 'Same Name', 'same@x.com', 'A')];
  assert.deepStrictEqual(ids(us.selectPage(dupes, {})), ['a1', 'z9']);
  assert.deepStrictEqual(ids(us.selectPage(dupes.slice().reverse(), {})), ['a1', 'z9'], 'independent of input order');
});

test('sortEntries does not mutate its input', () => {
  const input = FIXTURE.slice();
  const before = input.map((e) => e.pc._id);
  us.sortEntries(input);
  assert.deepStrictEqual(input.map((e) => e.pc._id), before);
});

// ── Pagination ──────────────────────────────────────────────────────────────
test('pagination slices in the sorted order, with no gaps or repeats', () => {
  const p1 = us.selectPage(FIXTURE, { page: 1, pageSize: 2 });
  const p2 = us.selectPage(FIXTURE, { page: 2, pageSize: 2 });
  const p3 = us.selectPage(FIXTURE, { page: 3, pageSize: 2 });
  assert.deepStrictEqual(ids(p1), ['c5', 'c1']);
  assert.deepStrictEqual(ids(p2), ['c2', 'c3']);
  assert.deepStrictEqual(ids(p3), ['c4']);
  assert.strictEqual(p1.totalPages, 3);
  assert.strictEqual(p1.total, 5, 'total counts every MATCH, not just this page');
  // Union of all pages == the whole set, each exactly once.
  const all = [...ids(p1), ...ids(p2), ...ids(p3)];
  assert.strictEqual(new Set(all).size, 5);
});

test('PAGINATION WHILE SEARCHING is scoped to the matches', () => {
  const q = 'example.com';                   // matches c1 and c3
  const p1 = us.selectPage(FIXTURE, { q, page: 1, pageSize: 1 });
  const p2 = us.selectPage(FIXTURE, { q, page: 2, pageSize: 1 });
  assert.strictEqual(p1.total, 2, 'total reflects the SEARCH, not the whole client list');
  assert.strictEqual(p1.totalPages, 2);
  assert.deepStrictEqual(ids(p1), ['c1']);
  assert.deepStrictEqual(ids(p2), ['c3']);
});

test('a page beyond the end is CLAMPED, never returned blank', () => {
  // The exact case of narrowing a search while on a later page.
  const r = us.selectPage(FIXTURE, { q: 'example.com', page: 99, pageSize: 2 });
  assert.strictEqual(r.page, 1, 'clamped to the last existing page');
  assert.strictEqual(r.entries.length, 2, 'and it actually has rows');
  const empty = us.selectPage(FIXTURE, { q: 'nobody', page: 5 });
  assert.strictEqual(empty.page, 1);
});

test('page size is clamped to a server-enforced range', () => {
  assert.strictEqual(us.normalizePageSize(undefined), us.DEFAULT_PAGE_SIZE);
  assert.strictEqual(us.normalizePageSize('nonsense'), us.DEFAULT_PAGE_SIZE);
  assert.strictEqual(us.normalizePageSize(0), us.DEFAULT_PAGE_SIZE);
  assert.strictEqual(us.normalizePageSize(-5), us.DEFAULT_PAGE_SIZE);
  assert.strictEqual(us.normalizePageSize(10), 10);
  assert.strictEqual(us.normalizePageSize(99999), us.MAX_PAGE_SIZE, 'a caller cannot request the whole table');
  assert.strictEqual(us.selectPage(FIXTURE, { pageSize: 99999 }).pageSize, us.MAX_PAGE_SIZE);
});

test('an invalid page falls back to 1', () => {
  for (const page of [undefined, null, 0, -3, 'abc']) {
    assert.strictEqual(us.selectPage(FIXTURE, { page, pageSize: 2 }).page, 1, String(page));
  }
});

// ── Regression guard ────────────────────────────────────────────────────────
test('REGRESSION: default (no search, no page) returns the first page of everything', () => {
  const r = us.selectPage(FIXTURE, {});
  assert.strictEqual(r.total, 5);
  assert.strictEqual(r.page, 1);
  assert.strictEqual(r.pageSize, us.DEFAULT_PAGE_SIZE);
  assert.strictEqual(r.entries.length, 5, 'a small client list is unaffected by paging');
});

test('REGRESSION: entries are passed through untouched — no usage field is altered', () => {
  // The selection layer must never rewrite a client, account or user object; the route computes
  // usage from exactly what it put in.
  const r = us.selectPage(FIXTURE, { q: 'alice' });
  assert.strictEqual(r.entries[0], FIXTURE[0], 'the SAME object instance is returned');
});
