'use strict';
/**
 * END-TO-END test of the Claude per-client token-limit override, driving the REAL ProxyClient /
 * ProxyAccount models through the REAL mysqlAdapter against an in-memory pool
 * (serialize → persist → deserialize → read → effective-limit → enforce). Reproduces the exact
 * production flow: admin update route sets fields, model.save() serializes the JSON blob, a fresh
 * findById deserializes it, and claudeQuota resolves the effective limit.
 *
 * Run: node --test tests/claudeLimitOverride.test.js
 */
const { test } = require('node:test');
const assert = require('node:assert/strict');
const adapter = require('../db/mysqlAdapter');
const ProxyClient = require('../models/proxy/ProxyClient');   // REAL model (with preSave)
const ProxyAccount = require('../models/proxy/ProxyAccount');  // REAL model (with preSave)
const quota = require('../utils/proxy/claudeQuota');

// In-memory pool: emulates the SQL shapes the adapter emits (upsert, SELECT by id, SELECT all).
// Any other WHERE throws so the adapter falls back to a full scan + in-JS matchesQuery.
function setMemPool() {
  const tables = new Map();
  const tableOf = (sql) => (sql.match(/`([a-z_]+)`/i) || [])[1];
  const store = (t) => tables.get(t) || (tables.set(t, new Map()), tables.get(t));
  adapter.__test.setPool({
    query: async (sql, params) => {
      const t = tableOf(sql);
      if (/^INSERT INTO/i.test(sql)) { store(t).set(String(params[0]), params[1]); return [[]]; }
      if (/^SELECT/i.test(sql)) {
        if (/WHERE id = \?/i.test(sql)) { const r = store(t).get(String(params[0])); return [r ? [{ data: r }] : []]; }
        if (/WHERE/i.test(sql)) throw new Error('unsupported WHERE → full scan fallback');
        return [[...store(t).values()].map(data => ({ data }))];
      }
      return [[]];
    },
  });
  return tables;
}

// Mirror the admin update route exactly: assign only PROVIDED fields, then save().
async function adminUpdate(id, body) {
  const pc = await ProxyClient.findById(id);
  if (body.tokenLimit !== undefined) pc.tokenLimit = body.tokenLimit ?? null;
  if (body.weeklyTokenLimit !== undefined) pc.weeklyTokenLimit = body.weeklyTokenLimit ?? null;
  await pc.save();
  return pc;
}

test('custom 5-hour + weekly overrides persist and drive the effective limit', async () => {
  setMemPool();
  const created = await ProxyClient.create({ tool: 'claude', userId: 'u1', tokenLimit: 5000, weeklyTokenLimit: 60000 });
  const c = await ProxyClient.findById(created._id);
  assert.equal(c.tokenLimit, 5000);
  assert.equal(c.weeklyTokenLimit, 60000);
  assert.equal(quota.clientAllowance(c.tokenLimit), 5000);                 // override, not default 20000
  assert.equal(quota.weeklyClientAllowance(c.weeklyTokenLimit, null), 60000); // override, not default 150000
});

test('increasing the 5-hour limit does NOT overwrite the weekly limit (separate storage)', async () => {
  setMemPool();
  const created = await ProxyClient.create({ tool: 'claude', userId: 'u1', tokenLimit: 5000, weeklyTokenLimit: 60000 });
  await adminUpdate(created._id, { tokenLimit: 8000 });        // only the 5-hour changes
  const c = await ProxyClient.findById(created._id);
  assert.equal(c.tokenLimit, 8000);       // increased
  assert.equal(c.weeklyTokenLimit, 60000); // untouched
});

test('decreasing a limit persists and a fresh read reflects it', async () => {
  setMemPool();
  const created = await ProxyClient.create({ tool: 'claude', userId: 'u1', tokenLimit: 5000, weeklyTokenLimit: 60000 });
  await adminUpdate(created._id, { weeklyTokenLimit: 30000 }); // decrease weekly only
  const c = await ProxyClient.findById(created._id);
  assert.equal(c.weeklyTokenLimit, 30000);
  assert.equal(c.tokenLimit, 5000);
});

test('0 is a valid hard-stop, NOT treated as unset (no truthy/falsy bug)', async () => {
  setMemPool();
  const created = await ProxyClient.create({ tool: 'claude', userId: 'u1', tokenLimit: 5000 });
  await adminUpdate(created._id, { tokenLimit: 0 });
  const c = await ProxyClient.findById(created._id);
  assert.equal(c.tokenLimit, 0);                        // persisted as 0, not null
  assert.equal(quota.clientAllowance(c.tokenLimit), 0); // enforced as 0, not default
});

test('removing an override (null) returns the client to the inherited default', async () => {
  setMemPool();
  const created = await ProxyClient.create({ tool: 'claude', userId: 'u1', tokenLimit: 5000, weeklyTokenLimit: 60000 });
  await adminUpdate(created._id, { tokenLimit: null, weeklyTokenLimit: null });
  const c = await ProxyClient.findById(created._id);
  assert.equal(c.tokenLimit, null);
  assert.equal(c.weeklyTokenLimit, null);
  assert.equal(quota.clientAllowance(c.tokenLimit), quota.defaultClientLimit());
  assert.equal(quota.weeklyClientAllowance(c.weeklyTokenLimit, null), quota.defaultWeeklyClientLimit());
});

test('numeric-string overrides are coerced to numbers and validated', async () => {
  setMemPool();
  const created = await ProxyClient.create({ tool: 'claude', userId: 'u1', tokenLimit: '7500', weeklyTokenLimit: '  90000  ' });
  const c = await ProxyClient.findById(created._id);
  assert.equal(c.tokenLimit, 7500);
  assert.equal(typeof c.tokenLimit, 'number');
  assert.equal(c.weeklyTokenLimit, 90000);
});

test('override survives a fresh read from persisted storage (restart-equivalent)', async () => {
  setMemPool();
  const created = await ProxyClient.create({ tool: 'claude', userId: 'u1', tokenLimit: 12345, weeklyTokenLimit: 67890 });
  // A brand-new findById deserializes purely from the stored blob — no in-memory instance carried over.
  const c = await ProxyClient.findById(created._id);
  assert.equal(c.tokenLimit, 12345);
  assert.equal(c.weeklyTokenLimit, 67890);
});

test('REGRESSION: an update payload that OMITS a limit key leaves it unchanged', async () => {
  // This is why the admin page bug mattered: when saveClient dropped tokenLimit from the payload,
  // the backend correctly left the OLD value in place → the admin's new value never took effect.
  setMemPool();
  const created = await ProxyClient.create({ tool: 'claude', userId: 'u1', tokenLimit: 5000, weeklyTokenLimit: 60000 });
  await adminUpdate(created._id, { /* no tokenLimit / weeklyTokenLimit keys */ status: 'active' });
  const c = await ProxyClient.findById(created._id);
  assert.equal(c.tokenLimit, 5000);       // unchanged (old value preserved, NOT applied)
  assert.equal(c.weeklyTokenLimit, 60000);
});

// ── Four-tier priority: client override → account default → global default ───
test('effective 5-hour priority: client override → account default → global default', async () => {
  setMemPool();
  const acct = await ProxyAccount.create({ tool: 'claude', label: 'A1', clientTokenLimit: 30000, weeklyClientTokenLimit: 250000 });
  const a = await ProxyAccount.findById(acct._id);
  assert.equal(a.clientTokenLimit, 30000);
  assert.equal(a.weeklyClientTokenLimit, 250000);
  // client override present → wins
  assert.equal(quota.clientAllowance(5000, a.clientTokenLimit), 5000);
  // no client override → account default
  assert.equal(quota.clientAllowance(null, a.clientTokenLimit), 30000);
  // neither → global default
  assert.equal(quota.clientAllowance(null, null), quota.defaultClientLimit());
});

test('effective weekly priority mirrors five-hour (client → account → global)', async () => {
  assert.equal(quota.weeklyClientAllowance(40000, 250000), 40000);
  assert.equal(quota.weeklyClientAllowance(null, 250000), 250000);
  assert.equal(quota.weeklyClientAllowance(null, null), quota.defaultWeeklyClientLimit());
});

test('reducing a limit below current usage blocks new requests until reset', () => {
  const d = quota.checkAllowance({ clientLimit: 3000, clientUsed: 4000, accountCapacity: 1e9, accountUsed: 0, estIncoming: 1 });
  assert.equal(d.allowed, false);
  assert.equal(d.reason, 'client_limit');
  assert.equal(d.clientRemaining, 0); // never negative
});
