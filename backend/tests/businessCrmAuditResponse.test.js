'use strict';

/**
 * AUDIT LIST RESPONSE - the profit gate must not be reachable through audit history.
 *
 * `GET /exports/sales.csv` deletes `subtotal_cost` unless the caller holds `profit.view`. The audit
 * handler meanwhile ran `SELECT * FROM biz_crm_audit_logs` and serialised the row as-is, and that
 * table stores `before_json` / `after_json` - the snapshots of the very records whose costs are
 * gated. A user holding only `audit.view` could therefore read purchase costs and margins out of
 * the audit screen.
 *
 * WHAT THIS EXERCISES. The REAL express router (modules/business-crm/routes/admin.js) over real
 * HTTP, with the REAL permission middleware and real permission resolution. Only two boundaries are
 * synthetic: the database rows and the user directory. No production data is read, and the snapshot
 * values below are invented.
 *
 * WHAT THIS IS NOT. It is not evidence about the live deployment, and it does not demonstrate that
 * anyone actually extracted costs in production.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const path = require('node:path');

const BACKEND = path.join(__dirname, '..');
const MODULE_DIR = path.join(BACKEND, 'modules', 'business-crm');

// -- stub the two boundaries BEFORE the router is loaded ---------------------------------------
function stubModule(id, exports) {
  const resolved = require.resolve(id);
  require.cache[resolved] = { id: resolved, filename: resolved, loaded: true, exports, children: [], paths: [] };
}

// A sale snapshot of exactly the shape audit.write stores: the gated cost fields are present.
const SECRET_COST = '1234.56';
const SNAPSHOT = JSON.stringify({ id: 'sale-1', subtotal_sale: '5000.00', subtotal_cost: SECRET_COST, margin: '3765.44', client_name: 'Synthetic Client' });

const AUDIT_ROWS = [
  { id: 'a-2', created_at: '2026-10-20T10:00:00Z', action_key: 'sale.update', entity_type: 'sale', entity_id: 'sale-1',
    actor_user_id: 'user-1', actor_role: 'ADMIN', ip_address: '10.0.0.1', user_agent: 'synthetic-agent', request_id: 'req-2',
    before_json: SNAPSHOT, after_json: SNAPSHOT },
  { id: 'a-1', created_at: '2026-10-20T09:00:00Z', action_key: 'payment.reverse', entity_type: 'payment', entity_id: 'pay-1',
    actor_user_id: 'user-gone', actor_role: 'SUPPORT', ip_address: '10.0.0.2', user_agent: 'synthetic-agent', request_id: 'req-1',
    before_json: SNAPSHOT, after_json: null },
];

let dbCalls = [];
let auditTable = AUDIT_ROWS;
let userQueries = 0;

stubModule(path.join(MODULE_DIR, 'db.js'), {
  query: async (sql, params) => {
    dbCalls.push({ sql, params });
    if (/COUNT\(\*\)/i.test(sql)) {
      let rows = auditTable;
      if (params.action) rows = rows.filter((r) => r.action_key === params.action);
      if (params.actorFilter) rows = rows.filter((r) => r.actor_user_id === params.actorFilter);
      return [{ total: rows.length }];
    }
    if (/biz_crm_audit_logs/i.test(sql)) {
      const offset = Number(params.offset || 0);
      const limit = Number(params.limit || 25);
      let rows = auditTable;
      if (params.action) rows = rows.filter((r) => r.action_key === params.action);
      if (params.actorFilter) rows = rows.filter((r) => r.actor_user_id === params.actorFilter);
      // Mirror a real SELECT: return only the columns the statement actually named.
      const projection = String(sql.match(/SELECT\s+([\s\S]*?)\s+FROM/i)[1]).split(',').map((part) => part.trim());
      return rows.slice(offset, offset + limit).map((row) => {
        if (projection.includes('*')) return Object.assign({}, row);
        const out = {};
        for (const column of projection) if (column in row) out[column] = row[column];
        return out;
      });
    }
    return [];
  },
  getPool: () => ({ getConnection: async () => { throw new Error('not used by these tests'); } }),
  withTransaction: async () => { throw new Error('not used by these tests'); },
});

stubModule(path.join(BACKEND, 'models', 'User.js'), {
  find: () => ({ select: async () => { userQueries += 1; return [{ _id: 'user-1', fullName: 'Synthetic Admin' }]; } }),
});

// eslint-disable-next-line import/order
const express = require('express');
const { PERMISSIONS } = require(path.join(MODULE_DIR, 'permissions.js'));
const adminRoutes = require(path.join(MODULE_DIR, 'routes', 'admin.js'));

/** Boot the REAL router with a caller carrying exactly `permissions`. */
function serve(permissions) {
  const app = express();
  app.use(express.json());
  app.use((req, res, next) => { req.userId = 'caller-1'; req.businessAccess = { role: 'TEST', permissions }; next(); });
  app.use('/admin', adminRoutes);
  app.use((err, req, res, _next) => res.status(err.status || 500).json({ error: err.message, code: err.code }));
  return new Promise((resolve) => { const server = app.listen(0, '127.0.0.1', () => resolve(server)); });
}

function get(server, url) {
  return new Promise((resolve, reject) => {
    http.get({ host: '127.0.0.1', port: server.address().port, path: url }, (res) => {
      let body = '';
      res.on('data', (chunk) => { body += chunk; });
      res.on('end', () => {
        let json = null;
        try { json = JSON.parse(body); } catch (_) { json = null; }
        resolve({ status: res.statusCode, body, json });
      });
    }).on('error', reject);
  });
}

// Every permission the module defines: the most-authorised caller that can exist.
const ADMIN_PERMS = PERMISSIONS.slice();

test.beforeEach(() => { dbCalls = []; auditTable = AUDIT_ROWS; userQueries = 0; });

// -- 1. no audit.view -> denied ----------------------------------------------------------------
test('without audit.view the audit list is refused', async () => {
  const server = await serve(['clients.view', 'sales.view', 'profit.view']);
  const res = await get(server, '/admin/audit');
  server.close();
  assert.equal(res.status, 403);
  assert.equal(res.json.code, 'BUSINESS_PERMISSION_DENIED');
  assert.ok(!res.body.includes(SECRET_COST), 'a refusal must not leak a snapshot');
});

// -- 2. audit.view WITHOUT profit.view -> metadata only. THE REGRESSION TEST. -------------------
test('audit.view without profit.view never receives purchase costs through snapshots', async () => {
  const server = await serve(['audit.view']);
  const res = await get(server, '/admin/audit');
  server.close();
  assert.equal(res.status, 200);
  assert.equal(res.json.rows.length, 2);

  assert.ok(!res.body.includes(SECRET_COST),
    'the gated purchase cost reached a caller holding only audit.view - the profit gate is bypassable through audit history');
  assert.ok(!res.body.includes('subtotal_cost') && !res.body.includes('margin'),
    'no cost/profit field name may appear in the audit list response');
  for (const row of res.json.rows) {
    assert.equal(row.before_json, undefined, 'before_json must not be serialised to the client');
    assert.equal(row.after_json, undefined, 'after_json must not be serialised to the client');
  }
});

// -- 3. a FULLY authorised caller gets no more snapshot access than anyone else -----------------
test('even a fully authorised caller gets the same explicit contract, not raw rows', async () => {
  const server = await serve(ADMIN_PERMS);
  const res = await get(server, '/admin/audit');
  server.close();
  assert.equal(res.status, 200);
  assert.ok(!res.body.includes(SECRET_COST), 'the list endpoint is not a snapshot-detail endpoint for anyone');
  for (const key of ['created_at', 'action_key', 'actor_user_id', 'actor_role', 'entity_type', 'entity_id', 'ip_address', 'request_id']) {
    assert.ok(key in res.json.rows[0], `existing consumer field ${key} must survive`);
  }
});

// -- 4. readability: labels + names, one directory lookup per PAGE ------------------------------
test('readable labels and staff names are added without a query per row', async () => {
  const server = await serve(['audit.view']);
  const res = await get(server, '/admin/audit');
  server.close();
  assert.equal(res.json.rows[0].action_label, 'Sale updated');
  assert.equal(res.json.rows[0].action_key, 'sale.update', 'the stable key is kept alongside the label');
  assert.equal(res.json.rows[0].actor_name, 'Synthetic Admin');
  // honest fallback: a deleted/unreadable user keeps its stable id and gets no invented name
  assert.equal(res.json.rows[1].actor_name, null);
  assert.equal(res.json.rows[1].actor_user_id, 'user-gone');
  assert.equal(userQueries, 1, 'one directory lookup for the whole page, never one per displayed row');
});

test('an unknown action key falls back to the raw key rather than inventing wording', async () => {
  auditTable = [Object.assign({}, AUDIT_ROWS[0], { action_key: 'something.new' })];
  const server = await serve(['audit.view']);
  const res = await get(server, '/admin/audit');
  server.close();
  assert.equal(res.json.rows[0].action_label, 'something.new');
});

// -- 5. empty history, pagination and filters still work ----------------------------------------
test('empty history returns an empty page, not an error', async () => {
  auditTable = [];
  const server = await serve(['audit.view']);
  const res = await get(server, '/admin/audit');
  server.close();
  assert.equal(res.status, 200);
  assert.deepEqual(res.json.rows, []);
  assert.equal(res.json.total, 0);
  assert.equal(userQueries, 0, 'no directory lookup when there are no rows');
});

test('pagination and filters are honoured, and ordering has a unique tie-breaker', async () => {
  const server = await serve(['audit.view']);

  const page1 = await get(server, '/admin/audit?page=1&pageSize=1');
  assert.equal(page1.json.rows.length, 1);
  assert.equal(page1.json.page, 1);
  assert.equal(page1.json.pageSize, 1);
  assert.equal(page1.json.total, 2, 'total counts the whole filtered set, not the page');

  const page2 = await get(server, '/admin/audit?page=2&pageSize=1');
  assert.notEqual(page2.json.rows[0].id, page1.json.rows[0].id, 'page 2 must not repeat page 1');

  const beyond = await get(server, '/admin/audit?page=99&pageSize=1');
  assert.deepEqual(beyond.json.rows, [], 'an out-of-range page is empty, not an error');
  assert.equal(beyond.status, 200);

  const filtered = await get(server, '/admin/audit?action=payment.reverse');
  assert.equal(filtered.json.rows.length, 1);
  assert.equal(filtered.json.rows[0].action_key, 'payment.reverse');
  assert.equal(filtered.json.total, 1, 'the filtered total must reflect the filter');

  const byActor = await get(server, '/admin/audit?actor=user-gone');
  assert.equal(byActor.json.rows.length, 1);
  server.close();

  const listSql = dbCalls.map((call) => call.sql).filter((sql) => /ORDER BY/i.test(sql))[0];
  assert.match(listSql, /ORDER BY created_at DESC, id DESC/,
    'created_at alone is not a total order: rows written in one transaction share a timestamp');
  assert.ok(!/SELECT \* FROM biz_crm_audit_logs/i.test(listSql), 'the list must never SELECT *');
});
