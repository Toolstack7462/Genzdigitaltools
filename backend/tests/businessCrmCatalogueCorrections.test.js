'use strict';
/**
 * Regression cases for four corrections to the catalogue feature, written failure-first: each one
 * was confirmed red against the code as it stood before the fix.
 *
 * WHAT THIS FILE CAN AND CANNOT PROVE. Everything here runs with a fake connection, so it proves
 * decision logic and statement ORDER - which row is read, what is refused, whether the audit write
 * shares the caller's transaction. It proves nothing about locking, isolation or uniqueness, and a
 * pass here is NOT integration evidence. The route-level and concurrency proof is
 * scripts/crm-catalogue-db-selftest.js, which drives the real express routes against a real
 * MariaDB scratch schema.
 *
 * The one guard below that only reads source text says so in its own name.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const BACKEND = path.join(__dirname, '..');
const MODULE_DIR = path.join(BACKEND, 'modules', 'business-crm');

/* ── a connection that answers from a script and records every statement ─────────────────────── */
function fakeConnection(answers) {
  const seen = [];
  return {
    seen,
    async execute(sql, params) {
      // Matched against the collapsed statement: the real SQL is indented across several lines, so
      // a pattern written on one line would never match it.
      const flat = String(sql).replace(/\s+/g, ' ').trim();
      seen.push({ sql: flat, params });
      for (const answer of answers) {
        if (!answer.match.test(flat)) continue;
        // mysql2 returns the row array for a SELECT and a ResultSetHeader for a write, both as the
        // FIRST element - so an answer declares `rows` or `info`, never both as separate slots.
        return [answer.rows !== undefined ? answer.rows : answer.info, undefined];
      }
      return [[], undefined];
    },
  };
}
const sourceRow = (over) => ({
  match: /FROM biz_crm_product_sources/i,
  rows: [{ readiness: 'READY', source_availability: 'AVAILABLE', ignored_at: null, ...(over || {}) }],
});

/* ── stub the db module BEFORE the services capture it ───────────────────────────────────────── */
const dbPath = require.resolve(path.join(MODULE_DIR, 'db'));
let TX_CONNECTION = null;
const TX_CALLS = [];
require.cache[dbPath] = {
  id: dbPath, filename: dbPath, loaded: true,
  exports: {
    getPool() { throw new Error('getPool must not be reached in this test'); },
    async query() { throw new Error('db.query must not be reached in this test'); },
    async withTransaction(fn) { TX_CALLS.push(1); return fn(TX_CONNECTION); },
    async ensureSchema() {},
    async close() {},
    splitSql: (sql) => [sql],
    databaseConfig: () => ({}),
  },
};

const sales = require(path.join(MODULE_DIR, 'services', 'salesService'));
const catalogue = require(path.join(MODULE_DIR, 'services', 'productCatalogueService'));

const REQ = { userId: 'tester', user: { _id: 'tester' }, headers: {}, ip: '127.0.0.1', get: () => 'node-test', businessAccess: { role: 'OWNER' } };
const ITEM = { productId: 'prod-1', name: 'Line', salePrice: '100.00', purchaseCost: '0.00' };

async function refusal(promise) {
  try { await promise; return null; } catch (error) { return error.code || error.message; }
}

/* ══ A. the sale gate must honour an operator's IGNORE decision ═══════════════════════════════ */
test('A: an ignored source cannot be sold even when it is READY and AVAILABLE', async () => {
  // Before the fix the gate selected only readiness and source_availability, so this row passed:
  // the catalogue list hid an ignored product while the sale path still sold it.
  const connection = fakeConnection([sourceRow({ ignored_at: '2026-10-21 10:00:00' })]);
  assert.equal(
    await refusal(sales.assertCatalogueReady(connection, [ITEM], new Map())),
    'PRODUCT_SOURCE_IGNORED',
  );
});

test('A: the gate actually reads ignored_at rather than inferring it', async () => {
  const connection = fakeConnection([sourceRow()]);
  await sales.assertCatalogueReady(connection, [ITEM], new Map());
  assert.match(connection.seen[0].sql, /ignored_at/);
});

test('A: ignore is reported before readiness, so the operator sees their own decision', async () => {
  const connection = fakeConnection([sourceRow({ readiness: 'NEEDS_SETUP', ignored_at: '2026-10-21 10:00:00' })]);
  assert.equal(await refusal(sales.assertCatalogueReady(connection, [ITEM], new Map())), 'PRODUCT_SOURCE_IGNORED');
});

test('A: the unchanged historical line of an existing sale is never re-checked', async () => {
  // An ignored or withdrawn source must not retro-block editing a sale that already exists.
  const connection = fakeConnection([sourceRow({ ignored_at: '2026-10-21 10:00:00', readiness: 'NEEDS_SETUP' })]);
  const oldById = new Map([['item-1', { product_id: 'prod-1', purchase_cost: '0.00' }]]);
  await sales.assertCatalogueReady(connection, [{ ...ITEM, id: 'item-1' }], oldById);
  assert.deepEqual(connection.seen, [], 'no lookup should happen for an unchanged line');
});

test('A: a manual product (no mapping row) is untouched by the gate', async () => {
  const connection = fakeConnection([{ match: /FROM biz_crm_product_sources/i, rows: [] }]);
  await sales.assertCatalogueReady(connection, [ITEM], new Map());
});

test('A: NEEDS_SETUP and UNAVAILABLE still have their own distinct refusals', async () => {
  assert.equal(
    await refusal(sales.assertCatalogueReady(fakeConnection([sourceRow({ readiness: 'NEEDS_SETUP' })]), [ITEM], new Map())),
    'PRODUCT_NOT_READY',
  );
  assert.equal(
    await refusal(sales.assertCatalogueReady(fakeConnection([sourceRow({ source_availability: 'UNAVAILABLE' })]), [ITEM], new Map())),
    'PRODUCT_SOURCE_UNAVAILABLE',
  );
});

/* ══ A/retry. a committed sale is replayed before the gate runs ═══════════════════════════════ */
test('A: a same-key retry of a COMMITTED sale is answered from the key, not re-validated', async () => {
  // The readiness gate reads CURRENT source state. A retry happens precisely when the first
  // response was lost, possibly long after the source was ignored or withdrawn - so with the
  // lookup placed after validation the retry was refused instead of returning the sale it had
  // already created. The order of these two statements is the behaviour under test.
  const existingSale = { id: 'sale-1', created_by: 'tester', invoice_number: 'INV-1' };
  TX_CONNECTION = fakeConnection([
    { match: /FROM biz_crm_sales WHERE idempotency_key/i, rows: [existingSale] },
    { match: /FROM biz_crm_sales s JOIN biz_crm_clients/i, rows: [existingSale] },
    { match: /FROM biz_crm_sale_items/i, rows: [] },
    { match: /FROM biz_crm_payments/i, rows: [] },
    // Deliberately hostile: if the gate were consulted, this row would refuse the retry.
    sourceRow({ ignored_at: '2026-10-21 10:00:00', source_availability: 'UNAVAILABLE', readiness: 'NEEDS_SETUP' }),
  ]);
  const result = await sales.createSale(REQ, {
    clientId: 'client-1', items: [ITEM], currencyCode: 'PKR', saleDate: '2026-10-01', orderType: 'new',
    openingClientPayment: '0.00', openingVendorPayment: '0.00', idempotencyKey: 'key-1',
  });
  assert.equal(result.id, 'sale-1');
  assert.match(TX_CONNECTION.seen[0].sql, /idempotency_key/, 'the replay lookup must be the first statement');
  assert.equal(
    TX_CONNECTION.seen.filter((s) => /biz_crm_product_sources/.test(s.sql)).length, 0,
    'a committed sale must not be re-validated against current source state',
  );
  assert.equal(
    TX_CONNECTION.seen.filter((s) => /^INSERT/i.test(s.sql)).length, 0,
    'a replay must write nothing',
  );
});

/* ══ C. the readiness confirmation is one transaction, guarded on the product version ═════════ */
function confirmAnswers(over) {
  return [{
    match: /FROM biz_crm_product_sources ps JOIN biz_crm_products p/i,
    rows: [{
      mapping_id: 'map-1', readiness: 'NEEDS_SETUP', currency_code: 'PKR', account_type: 'private',
      default_sale_price: '5000.00', version: 4, deleted_at: null, ...(over || {}),
    }],
  }, {
    match: /UPDATE biz_crm_product_sources/i, info: { affectedRows: 1 },
  }, {
    match: /INSERT INTO biz_crm_audit_logs/i, info: { affectedRows: 1 },
  }];
}

test('C: a confirmation that names no product version is refused', async () => {
  TX_CONNECTION = fakeConnection(confirmAnswers());
  assert.equal(await refusal(catalogue.confirmReady(REQ, 'prod-1', { confirmFree: false })), 'VERSION_REQUIRED');
});

test('C: a STALE confirmation cannot approve newer commercial values', async () => {
  TX_CONNECTION = fakeConnection(confirmAnswers({ version: 5 }));
  assert.equal(
    await refusal(catalogue.confirmReady(REQ, 'prod-1', { confirmFree: false, version: 4 })),
    'VERSION_CONFLICT',
  );
  assert.equal(TX_CONNECTION.seen.filter((s) => /^UPDATE/i.test(s.sql)).length, 0, 'nothing may be written');
});

test('C: the values are validated from the LOCKED row, not from the request', async () => {
  // The caller believes the price is 5000; the row says 0.00. The row wins.
  TX_CONNECTION = fakeConnection(confirmAnswers({ default_sale_price: '0.00' }));
  assert.equal(
    await refusal(catalogue.confirmReady(REQ, 'prod-1', { confirmFree: false, version: 4 })),
    'PRICE_NOT_CONFIRMED',
  );
});

test('C: the read that validates is a locking read', async () => {
  TX_CONNECTION = fakeConnection(confirmAnswers());
  await catalogue.confirmReady(REQ, 'prod-1', { confirmFree: false, version: 4 });
  assert.match(TX_CONNECTION.seen[0].sql, /FOR UPDATE/i);
});

test('C: read, validation, readiness write and audit all share ONE transaction', async () => {
  // The audit write used to open a SECOND transaction of its own, so the state transition and the
  // record of it could commit independently.
  TX_CALLS.length = 0;
  TX_CONNECTION = fakeConnection(confirmAnswers());
  const result = await catalogue.confirmReady(REQ, 'prod-1', { confirmFree: false, version: 4 });
  assert.deepEqual(result, { readiness: 'READY', alreadyReady: false, confirmedFree: false });
  assert.equal(TX_CALLS.length, 1, 'exactly one transaction');
  const kinds = TX_CONNECTION.seen.map((s) => s.sql.split(' ')[0].toUpperCase());
  assert.deepEqual(kinds, ['SELECT', 'UPDATE', 'INSERT'], 'and in that order, on the same connection');
  assert.match(TX_CONNECTION.seen[2].sql, /biz_crm_audit_logs/);
});

test('C: the readiness write is still guarded on NEEDS_SETUP, and losing that guard is refused', async () => {
  const answers = confirmAnswers();
  answers[1] = { match: /UPDATE biz_crm_product_sources/i, info: { affectedRows: 0 } };
  TX_CONNECTION = fakeConnection(answers);
  assert.equal(await refusal(catalogue.confirmReady(REQ, 'prod-1', { confirmFree: false, version: 4 })), 'ALREADY_READY');
  assert.match(TX_CONNECTION.seen[1].sql, /readiness = 'NEEDS_SETUP'/);
  assert.equal(TX_CONNECTION.seen.filter((s) => /audit_logs/.test(s.sql)).length, 0, 'no audit entry for a refused write');
});

test('C: an explicit confirmFree is recorded in the audit entry', async () => {
  TX_CONNECTION = fakeConnection(confirmAnswers({ default_sale_price: '0.00' }));
  const result = await catalogue.confirmReady(REQ, 'prod-1', { confirmFree: true, version: 4 });
  assert.equal(result.confirmedFree, true);
  const auditStatement = TX_CONNECTION.seen.find((s) => /audit_logs/.test(s.sql));
  assert.equal(JSON.parse(auditStatement.params.afterJson).confirmedFree, true);
});

test('C: a product already READY is reported, not re-written', async () => {
  TX_CONNECTION = fakeConnection(confirmAnswers({ readiness: 'READY' }));
  assert.deepEqual(
    await catalogue.confirmReady(REQ, 'prod-1', { confirmFree: false, version: 4 }),
    { readiness: 'READY', alreadyReady: true },
  );
  assert.equal(TX_CONNECTION.seen.filter((s) => /^UPDATE/i.test(s.sql)).length, 0);
});

/* ══ B + D. structural tripwires, named as such ═══════════════════════════════════════════════ */
const productsSource = fs.readFileSync(path.join(MODULE_DIR, 'routes', 'products.js'), 'utf8');

test('B (source guard): no single-product response is built from an unjoined read', () => {
  // The behavioural proof is the real-DB self-test, which compares the PUT response with the list
  // row. This guard exists because the defect was a read that LOOKED harmless.
  assert.equal(
    (productsSource.match(/SELECT \* FROM biz_crm_products WHERE id=:id'/g) || []).length, 0,
    'a single-product read must go through readProductWithSource so the serializer sees the source columns',
  );
  assert.match(productsSource, /LEFT JOIN biz_crm_product_sources ps ON ps\.product_id = p\.id\s*\n?\s*WHERE p\.id=:id/);
  for (const responder of ['res.status(201).json(forRequest(req, await readProductWithSource(id)))',
    'res.json(forRequest(req, await readProductWithSource(req.params.id)))']) {
    assert.ok(productsSource.includes(responder), `missing: ${responder}`);
  }
});

test('D (source guard): the product PUT route itself writes name_overridden', () => {
  // The flag had readers in two production files and a writer in none - only the self-test wrote
  // it, with raw SQL, which is why a rename was overwritten on the next reconcile in production.
  const put = productsSource.slice(productsSource.indexOf("router.put('/:id'"));
  assert.match(put, /UPDATE biz_crm_product_sources SET name_overridden=:overridden/);
  assert.ok(
    put.indexOf('name_overridden=:overridden') < put.indexOf('connection.commit()'),
    'the flag must be written inside the same transaction as the rename',
  );
});

/* == schema ordering: no catalogue handler can be served before the migration runs ============ */
test('ordering guard: ensureSchema is registered before the product routes are mounted', () => {
  // The catalogue endpoints read biz_crm_product_sources, which the additive 2.1.0 migration
  // creates. The migration is not a separate deployment step: modules/business-crm/index.js awaits
  // db.ensureSchema() in a router-level middleware, and express runs middleware in registration
  // order - so the ordering is a property of THIS FILE's layout and is worth pinning.
  const index = fs.readFileSync(path.join(MODULE_DIR, 'index.js'), 'utf8');
  const ensure = index.indexOf('await db.ensureSchema()');
  const mount = index.indexOf("router.use('/products', products)");
  assert.ok(ensure > 0 && mount > 0, 'both the ensureSchema middleware and the products mount must exist');
  assert.ok(ensure < mount, 'ensureSchema must be registered before the products routes');
  // ...and the table the catalogue depends on is actually created by that migration.
  const schema = fs.readFileSync(path.join(MODULE_DIR, 'schema.sql'), 'utf8');
  assert.match(schema, /CREATE TABLE IF NOT EXISTS biz_crm_product_sources/);
  assert.match(schema, /VALUES \('2\.1\.0'\)/);
});
