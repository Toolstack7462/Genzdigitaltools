'use strict';
/**
 * Regression tests for the generated-column index pushdown + SQL COUNT(*) in db/mysqlAdapter.js.
 *   node --test backend/tests/adapterIndexCount.test.js
 *
 * Uses a fake pool + the __test seams (setPool / markIndexed / clearIndexed). Proves the indexed
 * generated column is used when present (else JSON_EXTRACT), the value-length guard, and that
 * countDocuments returns the exact same counts via SQL COUNT with a full-scan fallback.
 */
const { test, beforeEach } = require('node:test');
const assert = require('node:assert');
const adapter = require('../db/mysqlAdapter');

const DATA = [
  { _id: 'r1', tool: 'writehuman', status: 'active' },
  { _id: 'r2', tool: 'writehuman', status: 'disabled' },
  { _id: 'r3', tool: 'hix', status: 'active' },
];

function fakePool() {
  const queries = [];
  const wrap = (arr) => [arr.map(r => ({ data: JSON.stringify(r) }))];
  const pool = {
    query: async (sql, params = []) => {
      queries.push({ sql, params });
      if (/SELECT COUNT\(\*\)/.test(sql)) {
        let rows = DATA;
        if (sql.includes('`gc_tool` = ?')) rows = DATA.filter(d => d.tool === params[0]);
        else if (sql.includes('JSON_EXTRACT')) { const f = String(params[0]).replace(/^\$\./, ''); rows = DATA.filter(d => d[f] === params[1]); }
        else if (sql.includes('WHERE id = ?')) rows = DATA.filter(d => d._id === params[0]);
        return [[{ c: rows.length }]];
      }
      if (sql.includes('`gc_tool` = ?')) return wrap(DATA.filter(d => d.tool === params[0]));
      if (sql.includes('JSON_EXTRACT')) { const f = String(params[0]).replace(/^\$\./, ''); return wrap(DATA.filter(d => d[f] === params[1])); }
      if (sql.includes('WHERE id = ?')) return wrap(DATA.filter(d => d._id === params[0]));
      return wrap(DATA);
    },
  };
  return { pool, queries };
}
const ids = (docs) => docs.map(d => String(d._id)).sort();

beforeEach(() => adapter.__test.clearIndexed());

test('indexed field → WHERE gc_<field> = ? (index seek), correct rows', async () => {
  const { pool, queries } = fakePool();
  adapter.__test.setPool(pool);
  const M = adapter.createModel('IdxTest');
  adapter.__test.markIndexed('idxtest', 'tool');
  const docs = await M.find({ tool: 'writehuman' });
  assert.deepEqual(ids(docs), ['r1', 'r2']);
  assert.ok(queries[0].sql.includes('`gc_tool` = ?'), 'used the indexed generated column');
  assert.ok(!queries[0].sql.includes('JSON_EXTRACT'));
});

test('indexed field but value longer than the index prefix → JSON_EXTRACT (correctness over index)', async () => {
  const { pool, queries } = fakePool();
  adapter.__test.setPool(pool);
  const M = adapter.createModel('IdxTest');
  adapter.__test.markIndexed('idxtest', 'tool');
  await M.find({ tool: 'x'.repeat(200) });
  assert.ok(queries[0].sql.includes('JSON_EXTRACT'), 'long value bypasses truncating gc column');
});

test('non-indexed string field still uses JSON_EXTRACT', async () => {
  const { pool, queries } = fakePool();
  adapter.__test.setPool(pool);
  const M = adapter.createModel('IdxTest'); // nothing marked indexed
  await M.find({ status: 'active' });
  assert.ok(queries[0].sql.includes('JSON_EXTRACT'));
});

test('countDocuments: empty → SELECT COUNT(*) (no rows loaded)', async () => {
  const { pool, queries } = fakePool();
  adapter.__test.setPool(pool);
  const M = adapter.createModel('IdxTest');
  const n = await M.countDocuments({});
  assert.equal(n, 3);
  assert.ok(queries[0].sql.includes('COUNT(*)') && !queries[0].sql.includes('WHERE'));
});

test('countDocuments: single string field → exact load-count (NOT SQL COUNT — collation/type safe)', async () => {
  const { pool, queries } = fakePool();
  adapter.__test.setPool(pool);
  const M = adapter.createModel('IdxTest');
  adapter.__test.markIndexed('idxtest', 'tool');
  const n = await M.countDocuments({ tool: 'writehuman' });
  assert.equal(n, 2, 'exact count via matchesQuery re-filter');
  assert.ok(!queries.some(q => q.sql.includes('COUNT(*)')), 'string-field count must NOT use bare SQL COUNT');
  assert.ok(queries.some(q => q.sql.includes('`gc_tool` = ?')), 'still narrows via the find pushdown (loads only matching rows)');
});

test('countDocuments: single _id → COUNT(*) WHERE id = ?', async () => {
  const { pool, queries } = fakePool();
  adapter.__test.setPool(pool);
  const M = adapter.createModel('IdxTest');
  const n = await M.countDocuments({ _id: 'r3' });
  assert.equal(n, 1);
  assert.ok(queries[0].sql.includes('COUNT(*)') && queries[0].sql.includes('WHERE id = ?'));
});

test('countDocuments: multi-field / operator criteria → exact load-and-count fallback', async () => {
  const { pool, queries } = fakePool();
  adapter.__test.setPool(pool);
  const M = adapter.createModel('IdxTest');
  const n = await M.countDocuments({ tool: 'writehuman', status: 'active' }); // 2 fields → not a single WHERE
  assert.equal(n, 1, 'exact count via matchesQuery');
  assert.ok(!queries.some(q => q.sql.includes('COUNT(*)')), 'did not use SQL COUNT for multi-field');
});
