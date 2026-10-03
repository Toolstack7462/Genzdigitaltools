'use strict';
/**
 * Retention purges: delete only rows that already have no effect, in batches, and never in
 * dry-run mode. Runs the REAL models against a fake pool (same harness as the adapter tests).
 *   node --test backend/tests/retention.test.js
 */
const { test } = require('node:test');
const assert = require('node:assert');
const adapter = require('../db/mysqlAdapter');

const DAY = 86400000;
const ago = (d) => new Date(Date.now() - d * DAY).toISOString();
const ahead = (d) => new Date(Date.now() + d * DAY).toISOString();

// In-memory table: SELECT returns every row (JS filtering does the rest); DELETE … IN removes.
function fakeTable(rows) {
  const data = new Map(rows.map(r => [String(r._id), r]));
  const deletes = [];
  const pool = {
    query: async (sql, params = []) => {
      if (/^DELETE/.test(sql)) {
        deletes.push({ sql, n: params.length });
        let n = 0;
        for (const id of params) if (data.delete(String(id))) n++;
        return [{ affectedRows: n }];
      }
      if (sql.includes('WHERE id IN')) return [params.filter(id => data.has(String(id))).map(id => ({ data: JSON.stringify(data.get(String(id))) }))];
      if (sql.includes('WHERE id = ?')) return [data.has(String(params[0])) ? [{ data: JSON.stringify(data.get(String(params[0]))) }] : []];
      return [[...data.values()].map(r => ({ data: JSON.stringify(r) }))];
    },
  };
  adapter.__test.setPool(pool);
  return { data, deletes };
}
const fresh = (p) => { delete require.cache[require.resolve(p)]; return require(p); };

test('refresh tokens: only expired/revoked beyond the grace window are removed', async () => {
  const t = fakeTable([
    { _id: 'live', expiresAt: ahead(5) },
    { _id: 'just-expired', expiresAt: ago(2) },             // inside 7-day grace → kept
    { _id: 'old-expired', expiresAt: ago(30) },
    { _id: 'old-revoked', expiresAt: ahead(3), revokedAt: ago(10) },
    { _id: 'fresh-revoked', expiresAt: ahead(3), revokedAt: ago(1) },
  ]);
  const RefreshToken = fresh('../models/RefreshToken');
  const dry = await RefreshToken.purgeExpired({ graceDays: 7, dryRun: true });
  assert.deepStrictEqual(dry, { candidates: 2, deleted: 0 });
  assert.strictEqual(t.deletes.length, 0, 'dry-run must not issue any DELETE');
  const real = await RefreshToken.purgeExpired({ graceDays: 7, dryRun: false });
  assert.deepStrictEqual(real, { candidates: 2, deleted: 2 });
  assert.deepStrictEqual([...t.data.keys()].sort(), ['fresh-revoked', 'just-expired', 'live']);
});

test('extension tokens: active and recently revoked tokens survive', async () => {
  const t = fakeTable([
    { _id: 'active', isRevoked: false, expiresAt: ahead(300) },
    { _id: 'expired-old', isRevoked: false, expiresAt: ago(40) },
    { _id: 'revoked-old', isRevoked: true, expiresAt: ahead(300), revokedAt: ago(20) },
    { _id: 'revoked-new', isRevoked: true, expiresAt: ahead(300), revokedAt: ago(1) },
    { _id: 'revoked-no-date', isRevoked: true, expiresAt: ahead(300) },
  ]);
  const ExtensionToken = fresh('../models/ExtensionToken');
  const r = await ExtensionToken.purgeExpired({ graceDays: 7, dryRun: false });
  assert.strictEqual(r.deleted, 2);
  assert.deepStrictEqual([...t.data.keys()].sort(), ['active', 'revoked-new', 'revoked-no-date']);
});

test('activity log: audit actions are kept regardless of age; legacy purgeOld(days) still works', async () => {
  const t = fakeTable([
    { _id: 'routine-old', action: 'TOOL_OPENED', createdAt: ago(30) },
    { _id: 'routine-new', action: 'TOOL_OPENED', createdAt: ago(1) },
    { _id: 'login-failed-old', action: 'LOGIN_FAILED', createdAt: ago(90) },
    { _id: 'payment-old', action: 'PAYMENT_RECORDED', createdAt: ago(90) },
  ]);
  const ActivityLog = fresh('../models/ActivityLog');
  assert.deepStrictEqual(await ActivityLog.purgeOld({ days: 7, dryRun: true }), { candidates: 1, deleted: 0 });
  assert.strictEqual(t.data.size, 4);
  const r = await ActivityLog.purgeOld(7);  // the admin page's legacy call
  assert.strictEqual(r.deleted, 1);
  assert.deepStrictEqual([...t.data.keys()].sort(), ['login-failed-old', 'payment-old', 'routine-new']);
});

test('deleteByIds batches: 1,234 ids → 3 DELETE statements, not 1,234', async () => {
  const rows = Array.from({ length: 1234 }, (_, i) => ({ _id: 'x' + i, action: 'TOOL_OPENED', createdAt: ago(30) }));
  const t = fakeTable(rows);
  const ActivityLog = fresh('../models/ActivityLog');
  const r = await ActivityLog.purgeOld({ days: 7 });
  assert.strictEqual(r.deleted, 1234);
  assert.strictEqual(t.deletes.length, 3);
  assert.ok(t.deletes.every(d => d.n <= 500));
});

test('scheduler: defaults to dry-run, honours off/apply, never deletes in dry-run', async () => {
  delete process.env.RETENTION_MODE;
  const t = fakeTable([{ _id: 'old-expired', expiresAt: ago(30), action: 'TOOL_OPENED', createdAt: ago(30) }]);
  const sched = fresh('../cron/retentionScheduler');
  assert.strictEqual(sched.mode(), 'dry-run');
  const r = await sched.runOnce();
  assert.strictEqual(r.mode, 'dry-run');
  assert.strictEqual(t.deletes.length, 0);
  process.env.RETENTION_MODE = 'off';
  assert.strictEqual(await sched.runOnce(), null);
  process.env.RETENTION_MODE = 'bogus';
  assert.strictEqual(sched.mode(), 'dry-run', 'an unknown value must fall back to the safe mode');
  delete process.env.RETENTION_MODE;
});
