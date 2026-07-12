'use strict';
/**
 * Regression test for the populate() N+1 fix in db/mysqlAdapter.js.
 * Runs with Node's built-in runner (no jest, no real DB):
 *   node --test backend/tests/adapterPopulate.test.js
 *
 * Injects a fake pool that records every SQL query, then asserts that populating a ref over N docs
 * issues exactly ONE batched `WHERE id IN (...)` query (not N findById round-trips), with the same
 * projection + only-assign-when-found semantics as before.
 */
const { test } = require('node:test');
const assert = require('node:assert');
const adapter = require('../db/mysqlAdapter');

const USERS = [
  { _id: 'u1', fullName: 'Alice', email: 'a@x.com', secret: 'should-be-projected-out' },
  { _id: 'u2', fullName: 'Bob', email: 'b@x.com', secret: 'nope' },
];
const ASSIGNS = [
  { _id: 'a1', userId: 'u1', tool: 'x' },
  { _id: 'a2', userId: 'u2', tool: 'y' },
  { _id: 'a3', userId: 'u1', tool: 'z' },       // duplicate ref id → must dedup
  { _id: 'a4', userId: 'u404', tool: 'w' },     // missing ref → stays a raw id
];

function makeFakePool() {
  const queries = [];
  const pool = {
    query: async (sql, params) => {
      queries.push({ sql, params: params || [] });
      if (sql.includes('`assigntest`')) return [ASSIGNS.map(a => ({ data: JSON.stringify(a) }))];
      if (sql.includes('`users`')) {
        const want = new Set((params || []).map(String));
        return [USERS.filter(u => want.has(u._id)).map(u => ({ data: JSON.stringify(u) }))];
      }
      return [[]];
    },
  };
  return { pool, queries };
}

test('populate() batches ref lookups into ONE IN(...) query (no N+1) and preserves semantics', async () => {
  const { pool, queries } = makeFakePool();
  adapter.__test.setPool(pool);

  const User = adapter.createModel('User');            // table `users` (registry ref for userId)
  const Assign = adapter.createModel('AssignTest');    // table `assigntest`
  void User;

  const docs = await Assign.find({}).populate('userId', 'fullName email').exec();

  // --- batching: exactly one query to the ref (`users`) table, and it uses IN(...) ---
  const userQueries = queries.filter(q => q.sql.includes('`users`'));
  assert.equal(userQueries.length, 1, 'ref table queried exactly once (batched), not once-per-row');
  assert.ok(/IN \(/.test(userQueries[0].sql), 'uses WHERE id IN (...)');
  // deduped ids: u1, u2, u404 (a3 reuses u1)
  assert.deepEqual([...userQueries[0].params].sort(), ['u1', 'u2', 'u404'], 'deduped ref ids');

  // --- correctness: refs populated, projection applied, missing ref left raw ---
  assert.equal(docs.length, 4);
  assert.equal(docs[0].userId.fullName, 'Alice');
  assert.equal(docs[0].userId.email, 'a@x.com');
  assert.equal(docs[0].userId.secret, undefined, 'select projection dropped non-selected field');
  assert.equal(String(docs[0].userId._id), 'u1');
  assert.equal(docs[1].userId.fullName, 'Bob');
  assert.equal(docs[2].userId.fullName, 'Alice', 'duplicate ref id resolves correctly');
  assert.equal(docs[3].userId, 'u404', 'unresolved ref id is left untouched (raw id)');
});

test('populate() with no matching ref ids issues no ref query', async () => {
  const { pool, queries } = makeFakePool();
  adapter.__test.setPool(pool);
  adapter.createModel('User');
  const Empty = adapter.createModel('AssignEmpty'); // table `assignempty` → fake returns []
  const docs = await Empty.find({}).populate('userId', 'fullName').exec();
  assert.equal(docs.length, 0);
  assert.equal(queries.filter(q => q.sql.includes('`users`')).length, 0, 'no ref query when nothing to populate');
});
