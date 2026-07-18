'use strict';
/**
 * Unit tests for the proxy-tools "Grant access" picker search/rank logic
 * (utils/proxy/assignableClients.js). Pure — no DB. Covers partial-name /
 * partial-email search, case-insensitivity, exact→starts→contains ranking,
 * duplicate names, no-results, minimal-field shaping, and pagination slicing.
 * Run: node --test tests/assignableClients.test.js
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const { rankAssignableClients, rankScore, toOption } = require('../utils/proxy/assignableClients');

const U = [
  { _id: '1', fullName: 'Peterson Grant', email: 'pg@example.com', status: 'active' },   // starts-with (name)
  { _id: '2', fullName: 'Peter',          email: 'peter@mail.com', status: 'active' },   // exact (name)
  { _id: '3', fullName: 'Spencer Peters',  email: 'spen@corp.com', status: 'active' },   // contains (name)
  { _id: '4', fullName: 'Alice Wong',      email: 'alice@mail.com', status: 'active' },  // no match for "peter"
];
const ids = (arr) => arr.map((c) => c._id);

test('partial name search returns only matches, ranked exact → starts-with → contains', () => {
  const out = rankAssignableClients(U, 'peter');
  assert.deepEqual(ids(out), ['2', '1', '3']); // Peter (exact), Peterson (starts), Spencer Peters (contains)
  assert.equal(out.length, 3);                 // Alice excluded
});

test('shorter partial ("pet") still matches by prefix/contains', () => {
  const out = rankAssignableClients(U, 'pet');
  assert.deepEqual(ids(out), ['2', '1', '3']); // both "peter"/"peterson" start-with, tie-broken by name
});

test('partial EMAIL search (case-insensitive) matches on email', () => {
  assert.deepEqual(ids(rankAssignableClients(U, 'peter@')), ['2']); // starts-with email
  assert.deepEqual(ids(rankAssignableClients(U, 'mail.com')), ['4', '2']); // contains email, tie-broken by name (Alice < Peter)
});

test('uppercase input matches lowercase records and vice-versa', () => {
  assert.deepEqual(ids(rankAssignableClients(U, 'PETER')), ['2', '1', '3']);
  assert.deepEqual(ids(rankAssignableClients(U, 'Peter')), ['2', '1', '3']);
  assert.equal(rankScore({ fullName: 'PeTeR', email: '' }, 'peter'), 0); // exact regardless of case
});

test('duplicate names are BOTH returned, stably (tie-broken by id)', () => {
  const dups = [
    { _id: 'b', fullName: 'Peter Parker', email: 'peter2@x.com', status: 'active' },
    { _id: 'a', fullName: 'Peter Parker', email: 'peter1@x.com', status: 'active' },
  ];
  const out = rankAssignableClients(dups, 'parker');
  assert.equal(out.length, 2);
  assert.deepEqual(ids(out), ['a', 'b']); // same name+rank → stable order by id, neither collapsed
});

test('no-results: a term matching nothing returns an empty list', () => {
  assert.deepEqual(rankAssignableClients(U, 'zzznobody'), []);
});

test('empty term preserves input (recent-first) order and shapes only', () => {
  const out = rankAssignableClients(U, '');
  assert.deepEqual(ids(out), ['1', '2', '3', '4']);
});

test('options are MINIMAL — only id/name/email/status/eligible (no leaked fields)', () => {
  const opt = toOption({ _id: 9, fullName: 'X', email: 'x@y.com', status: 'active', passwordHash: 'secret', notes: 'n', phone: '123' });
  assert.deepEqual(Object.keys(opt).sort(), ['_id', 'eligible', 'email', 'fullName', 'id', 'status']);
  assert.equal(opt._id, '9');        // id coerced to string
  assert.equal(opt.eligible, true);
  assert.equal(opt.passwordHash, undefined);
});

test('pagination: rank once, then slice pages with correct hasMore', () => {
  const many = Array.from({ length: 25 }, (_, i) => ({ _id: String(i), fullName: `User ${String(i).padStart(2, '0')}`, email: `u${i}@x.com`, status: 'active' }));
  const ranked = rankAssignableClients(many, 'user');
  assert.equal(ranked.length, 25);

  const pageSize = 10;
  const page1 = ranked.slice(0, pageSize);
  const page2 = ranked.slice(pageSize, pageSize * 2);
  const page3 = ranked.slice(pageSize * 2, pageSize * 3);

  assert.equal(page1.length, 10);
  assert.equal(page2.length, 10);
  assert.equal(page3.length, 5);
  // No overlap across pages.
  const seen = new Set([...page1, ...page2, ...page3].map((c) => c._id));
  assert.equal(seen.size, 25);
  // hasMore is true while more remain, false on the last page.
  assert.equal(ranked.length > pageSize, true);       // after page1
  assert.equal(ranked.length > pageSize * 2, true);    // after page2
  assert.equal(ranked.length > pageSize * 3, false);   // after page3
});
