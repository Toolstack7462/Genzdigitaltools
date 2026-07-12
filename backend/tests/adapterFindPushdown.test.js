'use strict';
/**
 * Regression test for the _findRaw SQL-pushdown in db/mysqlAdapter.js.
 *   node --test backend/tests/adapterFindPushdown.test.js
 *
 * Proves that find() pushes a safe WHERE (PK for _id / $in, JSON_EXTRACT for a top-level string
 * equality) so only matching rows are read, while STILL producing the exact same results as the
 * old full-scan-then-JS-filter path — including operator/$or fallback and error fallback.
 */
const { test } = require('node:test');
const assert = require('node:assert');
const adapter = require('../db/mysqlAdapter');

const DATA = [
  { _id: 'r1', tool: 'writehuman', status: 'active', userId: 'u1' },
  { _id: 'r2', tool: 'writehuman', status: 'disabled', userId: 'u2' },
  { _id: 'r3', tool: 'hix', status: 'active', userId: 'u1' },
  { _id: 'r4', tool: 'stealth', status: 'active', isPrimary: true },
];

function fakePool({ throwOnJson = false } = {}) {
  const queries = [];
  const wrap = (arr) => [arr.map(r => ({ data: JSON.stringify(r) }))];
  const pool = {
    query: async (sql, params = []) => {
      queries.push({ sql, params });
      if (throwOnJson && sql.includes('JSON_EXTRACT')) throw new Error('JSON functions unsupported');
      if (sql.includes('WHERE id IN')) {
        const want = new Set(params.map(String));
        return wrap(DATA.filter(d => want.has(String(d._id))));
      }
      if (sql.includes('WHERE id = ?')) return wrap(DATA.filter(d => String(d._id) === String(params[0])));
      if (sql.includes('JSON_EXTRACT')) {
        const field = String(params[0]).replace(/^\$\./, '');
        return wrap(DATA.filter(d => d[field] === params[1]));
      }
      return wrap(DATA); // bare SELECT data FROM table (full scan)
    },
  };
  return { pool, queries };
}
const ids = (docs) => docs.map(d => String(d._id)).sort();
function setup(opts) { const fp = fakePool(opts); adapter.__test.setPool(fp.pool); const M = adapter.createModel('PushTest'); return { M, ...fp }; }

test('string equality → JSON_EXTRACT WHERE (not a full scan), correct rows', async () => {
  const { M, queries } = setup();
  const docs = await M.find({ tool: 'writehuman' });
  assert.deepEqual(ids(docs), ['r1', 'r2']);
  assert.equal(queries.length, 1);
  assert.ok(queries[0].sql.includes('JSON_EXTRACT'), 'used JSON_EXTRACT pushdown');
  assert.deepEqual(queries[0].params, ['$.tool', 'writehuman']);
});

test('_id equality → PK WHERE id = ?', async () => {
  const { M, queries } = setup();
  const docs = await M.find({ _id: 'r3' });
  assert.deepEqual(ids(docs), ['r3']);
  assert.ok(queries[0].sql.includes('WHERE id = ?'));
});

test('_id $in → WHERE id IN (...)', async () => {
  const { M, queries } = setup();
  const docs = await M.find({ _id: { $in: ['r1', 'r4'] } });
  assert.deepEqual(ids(docs), ['r1', 'r4']);
  assert.ok(queries[0].sql.includes('WHERE id IN'));
});

test('extra conditions still filtered in JS after the pushdown', async () => {
  const { M, queries } = setup();
  const docs = await M.find({ tool: 'writehuman', status: 'active' }); // JSON_EXTRACT on tool, JS filters status
  assert.deepEqual(ids(docs), ['r1']);
  assert.ok(queries[0].sql.includes('JSON_EXTRACT'));
});

test('operator value ($ne) → full scan fallback, still correct', async () => {
  const { M, queries } = setup();
  const docs = await M.find({ status: { $ne: 'active' } });
  assert.deepEqual(ids(docs), ['r2']);
  assert.ok(!queries[0].sql.includes('WHERE'), 'no WHERE pushed for operator query (full scan)');
});

test('$or → full scan fallback, still correct', async () => {
  const { M, queries } = setup();
  const docs = await M.find({ $or: [{ tool: 'hix' }, { tool: 'stealth' }] });
  assert.deepEqual(ids(docs), ['r3', 'r4']);
  assert.ok(!queries[0].sql.includes('WHERE'));
});

test('boolean value is NOT pushed (would be unsafe) → full scan', async () => {
  const { M, queries } = setup();
  const docs = await M.find({ isPrimary: true });
  assert.deepEqual(ids(docs), ['r4']);
  assert.ok(!queries.some(q => q.sql.includes('JSON_EXTRACT')), 'boolean not pushed via JSON_EXTRACT');
});

test('SQL error on the pushdown → falls back to full scan, still correct', async () => {
  const { M, queries } = setup({ throwOnJson: true });
  const docs = await M.find({ tool: 'writehuman' });
  assert.deepEqual(ids(docs), ['r1', 'r2']);
  assert.ok(queries.some(q => q.sql.includes('JSON_EXTRACT')), 'attempted the pushdown');
  assert.ok(queries.some(q => !q.sql.includes('WHERE')), 'then fell back to full scan');
});

test('INVARIANT: a SQL over-match (e.g. case-insensitive collation) is corrected by the JS re-filter', async () => {
  // The pushdown WHERE can over-match (utf8mb4_unicode_ci is case-insensitive; JSON_EXTRACT
  // type-juggles). This proves the safety net: whatever the WHERE returns, matchesQuery re-filters
  // it exactly, so find() results are always correct regardless of collation/type quirks.
  const CASE = [
    { _id: 'a', tool: 'writehuman' },
    { _id: 'b', tool: 'WriteHuman' }, // a ci collation would ALSO return this row
    { _id: 'c', tool: 'writehuman' },
  ];
  const pool = {
    query: async (sql, params = []) => {
      if (sql.includes('JSON_EXTRACT') || sql.includes('gc_')) {
        const want = String(params[params.length - 1]).toLowerCase(); // simulate case-INSENSITIVE SQL
        return [CASE.filter(d => d.tool.toLowerCase() === want).map(r => ({ data: JSON.stringify(r) }))];
      }
      return [CASE.map(r => ({ data: JSON.stringify(r) }))];
    },
  };
  adapter.__test.setPool(pool);
  const docs = await adapter.createModel('CaseTest').find({ tool: 'writehuman' });
  assert.deepEqual(ids(docs), ['a', 'c'], 'case-variant SQL over-match is dropped by the case-sensitive JS filter');
});

test('_id $in [] → matches nothing, issues no id query', async () => {
  const { M, queries } = setup();
  const docs = await M.find({ _id: { $in: [] } });
  assert.equal(docs.length, 0);
  assert.ok(!queries.some(q => q.sql.includes('WHERE id IN')), 'empty $in short-circuits — no query');
});
