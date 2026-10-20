'use strict';
/**
 * The guarded-write primitives the extension auto-sync commit depends on, exercised as the REAL
 * adapter code against a fake driver (the established `__test.setPool` seam used by the other
 * adapter tests).
 *
 * WHAT THIS PROVES: the exact SQL and bound parameters — that a partial write touches only the
 * JSON paths it was given, that every guard reaches the WHERE clause, that a null guard becomes
 * `IS NULL` rather than an equality against the string "null", that objects are stored as JSON
 * objects rather than quoted strings, that an empty patch issues NO statement at all, and that the
 * statements avoid `CAST(... AS JSON)` so they run on MariaDB as well as MySQL.
 *
 * WHAT IT DOES NOT PROVE: that the configured server accepts them. A fake driver cannot stand in
 * for an engine's JSON implementation, collation or privilege model. That is
 * `scripts/extcredsync-db-selftest.js`, which must be run against a RESTRICTED SCRATCH database on
 * the same engine/version as production (it requires EXTCREDSYNC_SELFTEST_DB=1 and
 * EXTCREDSYNC_EXPECTED_DB, re-reads `database()` from the live connection and refuses to proceed if
 * the account holds any global privilege beyond USAGE). It is NOT run here: this environment has no
 * MySQL/MariaDB and no container runtime, so that check remains outstanding and is reported as
 * outstanding rather than being approximated by this file.
 */
const { test, describe } = require('node:test');
const assert = require('node:assert');
const adapter = require('../db/mysqlAdapter');

function fakePool(affected = 1) {
  const queries = [];
  const pool = {
    query: async (sql, params = []) => {
      queries.push({ sql, params });
      return [{ affectedRows: affected }];
    },
  };
  return { pool, queries };
}

// A model on a table name the adapter knows, so the statements are the real ones.
const Policy = adapter.createModel('ExtAutoSyncPolicy', {});
const Tool = adapter.createModel('Tool', {});

describe('updateJsonPath — single-path partial write', () => {
  test('writes ONLY the given path, parses the value as JSON, and never CASTs', async () => {
    const { pool, queries } = fakePool(1);
    adapter.__test.setPool(pool);
    const rows = await Policy.updateJsonPath('pol1', 'sync.lastResult', 'synced');
    assert.strictEqual(rows, 1);
    assert.strictEqual(queries.length, 1);
    const { sql, params } = queries[0];
    assert.match(sql, /UPDATE `ext_autosync_policies` SET data = JSON_SET\(data, \?, JSON_EXTRACT\(\?, '\$'\)\), updatedAt = \? WHERE id = \?/);
    assert.doesNotMatch(sql, /CAST\s*\(/i, 'CAST(... AS JSON) is not portable to MariaDB');
    assert.strictEqual(params[0], '$.sync.lastResult');
    assert.strictEqual(JSON.parse(params[1]), 'synced');
    assert.strictEqual(String(params[3]), 'pol1');
  });

  test('an OBJECT value stays a JSON object, not a quoted string', async () => {
    const { pool, queries } = fakePool(1);
    adapter.__test.setPool(pool);
    const value = { lastResult: 'synced', boundIdentity: 'uid-1', nested: { n: 1 }, list: [1, 2] };
    await Policy.updateJsonPath('pol1', 'sync', value);
    const parsed = JSON.parse(queries[0].params[1]);
    assert.deepStrictEqual(parsed, value, 'the parameter round-trips as a real object');
    assert.match(queries[0].sql, /JSON_EXTRACT\(\?, '\$'\)/, 'the value is PARSED server-side');
  });

  test('undefined is persisted as JSON null, not the string "undefined"', async () => {
    const { pool, queries } = fakePool(1);
    adapter.__test.setPool(pool);
    await Policy.updateJsonPath('pol1', 'sync.lastError', undefined);
    assert.strictEqual(queries[0].params[1], 'null');
    assert.strictEqual(JSON.parse(queries[0].params[1]), null);
  });
});

describe('patchGuarded — multi-path write under an optimistic multi-field guard', () => {
  test('sets every path in one JSON_SET and puts every guard in the WHERE', async () => {
    const { pool, queries } = fakePool(1);
    adapter.__test.setPool(pool);
    const rows = await Tool.patchGuarded(
      'tool-1',
      { 'sessionBundle.cookiesEncrypted': 'ct', 'sessionBundle.version': 3, credentialVersion: 4 },
      { credentialVersion: 3, status: 'active' },
    );
    assert.strictEqual(rows, 1);
    const { sql, params } = queries[0];
    // three set pairs
    assert.strictEqual((sql.match(/JSON_EXTRACT\(\?, '\$'\)/g) || []).length, 3);
    // both guards, compared with the adapter's portable unquoted comparison
    assert.strictEqual((sql.match(/JSON_UNQUOTE\(JSON_EXTRACT\(data, \?\)\) = \?/g) || []).length, 2);
    assert.match(sql, /WHERE id = \?/);
    assert.doesNotMatch(sql, /CAST\s*\(/i);
    assert.ok(params.includes('$.credentialVersion'), 'the revision guard is bound');
    assert.ok(params.includes('$.status'), 'the active-tool guard is bound');
  });

  test('a null/undefined guard becomes IS NULL, never equality against "null"', async () => {
    const { pool, queries } = fakePool(1);
    adapter.__test.setPool(pool);
    await Tool.patchGuarded('tool-1', { credentialVersion: 1 }, { 'sessionBundle.version': null });
    const { sql } = queries[0];
    assert.match(sql, /JSON_EXTRACT\(data, \?\) IS NULL/);
    assert.doesNotMatch(sql, /JSON_UNQUOTE\(JSON_EXTRACT\(data, \?\)\) = \?/,
      'a null guard must not be compared as a string');
  });

  test('a guard that no longer holds yields 0 rows — the caller must treat that as a conflict', async () => {
    const { pool } = fakePool(0);
    adapter.__test.setPool(pool);
    const rows = await Tool.patchGuarded('tool-1', { credentialVersion: 4 }, { credentialVersion: 3 });
    assert.strictEqual(rows, 0, '0 affected rows is the cross-worker conflict signal');
  });

  test('an EMPTY patch issues no statement at all', async () => {
    const { pool, queries } = fakePool(1);
    adapter.__test.setPool(pool);
    const rows = await Tool.patchGuarded('tool-1', {}, { credentialVersion: 3 });
    assert.strictEqual(rows, 0);
    assert.strictEqual(queries.length, 0, 'no accidental unguarded UPDATE');
  });
});

describe('replaceGuarded — whole-document compare-and-set', () => {
  test('guards the whole-doc write on the expected field value', async () => {
    const { pool, queries } = fakePool(1);
    adapter.__test.setPool(pool);
    const rows = await Policy.replaceGuarded('pol1', 'policyEpoch', 7, { _id: 'pol1', policyEpoch: 8 });
    assert.strictEqual(rows, 1);
    const { sql, params } = queries[0];
    assert.match(sql, /UPDATE `ext_autosync_policies` SET data = \?, updatedAt = \? WHERE id = \? AND JSON_UNQUOTE\(JSON_EXTRACT\(data, \?\)\) = \?/);
    assert.doesNotMatch(sql, /CAST\s*\(/i);
    assert.strictEqual(params[3], '$.policyEpoch');
    assert.strictEqual(params[4], '7', 'the expected value is bound as a string comparison');
  });

  test('an expected value of null requires the field to be absent', async () => {
    const { pool, queries } = fakePool(1);
    adapter.__test.setPool(pool);
    await Policy.replaceGuarded('pol1', 'approvedAccountKey', null, { _id: 'pol1' });
    assert.match(queries[0].sql, /AND JSON_EXTRACT\(data, \?\) IS NULL/);
  });

  test('a lost race returns 0 and must not be read as success', async () => {
    const { pool } = fakePool(0);
    adapter.__test.setPool(pool);
    const rows = await Policy.replaceGuarded('pol1', 'policyEpoch', 7, { _id: 'pol1' });
    assert.strictEqual(rows, 0);
  });
});

describe('the new table is provisioned like every other', () => {
  test('ensureTables creates ext_autosync_policies, so no manual migration is needed', async () => {
    const { pool, queries } = fakePool(1);
    adapter.__test.setPool(pool);
    await adapter.ensureTables();
    const created = queries.filter(q => /CREATE TABLE IF NOT EXISTS/.test(q.sql)).map(q => q.sql);
    assert.ok(created.some(s => s.includes('`ext_autosync_policies`')),
      'the auto-sync policy table is created at connect time');
  });
});

describe('datetime binding — the defect a real engine found and a fake driver had missed', () => {
  // THE FAILURE: `_preSave` clones with deepClone(), a JSON round-trip, so a model WITH a preSave
  // hook turned its `createdAt`/`updatedAt` Dates into ISO-8601 strings ending in `Z`. Bound to a
  // DATETIME(3) column, a strict-mode server refuses them:
  //   Incorrect datetime value: '2026-10-19T17:49:05.416Z' for column 'createdAt'
  // That is the default sql_mode on MySQL 8 and current MariaDB. It only worked in production
  // because that server is lenient. Caught by scripts/extcredsync-db-selftest.js on a real engine
  // (mysql:8.0 and mariadb:10.11, identically) — these SQL-shape tests passed throughout, which is
  // exactly why the real-engine run exists. This pins the write path so it cannot regress.
  const WithHook = adapter.createModel('ExtAutoSyncPolicy', {
    // the same shape the real policy model uses
    preSave: async (data) => { if (!data.mode) data.mode = 'observe'; return data; },
  });
  const NoHook = adapter.createModel('Tool', {});

  for (const [label, Model] of [['a model WITH a preSave hook', WithHook], ['a model without one', NoHook]]) {
    test(`${label} binds real Date objects, never ISO strings`, async () => {
      const { pool, queries } = fakePool(1);
      adapter.__test.setPool(pool);
      await Model.create({ _id: 'dt-1', name: 'x' });
      const insert = queries.find(q => /INSERT INTO/.test(q.sql));
      assert.ok(insert, 'an INSERT was issued');
      const [, , createdAt, updatedAt] = insert.params;
      assert.ok(createdAt instanceof Date, `${label}: createdAt must bind as a Date, got ${typeof createdAt} ${String(createdAt)}`);
      assert.ok(updatedAt instanceof Date, `${label}: updatedAt must bind as a Date, got ${typeof updatedAt} ${String(updatedAt)}`);
      assert.doesNotMatch(String(createdAt), /\dZ$/, 'and never the ISO form a strict server rejects');
    });
  }

  test('an ISO string arriving from anywhere else is still coerced, not passed through', async () => {
    const { pool, queries } = fakePool(1);
    adapter.__test.setPool(pool);
    await NoHook._upsertRaw({ _id: 'dt-2', createdAt: '2026-10-19T17:49:05.416Z', updatedAt: '2026-10-19T17:49:05.416Z' });
    const insert = queries.find(q => /INSERT INTO/.test(q.sql));
    const [, , createdAt, updatedAt] = insert.params;
    assert.ok(createdAt instanceof Date && updatedAt instanceof Date, 'coerced at the binding boundary');
    assert.strictEqual(createdAt.toISOString(), '2026-10-19T17:49:05.416Z', 'and the instant is preserved exactly');
  });

  test('an unparseable value falls back to now rather than binding garbage', async () => {
    const { pool, queries } = fakePool(1);
    adapter.__test.setPool(pool);
    await NoHook._upsertRaw({ _id: 'dt-3', createdAt: 'not-a-date', updatedAt: 'not-a-date' });
    const insert = queries.find(q => /INSERT INTO/.test(q.sql));
    const [, , createdAt] = insert.params;
    assert.ok(createdAt instanceof Date && !Number.isNaN(createdAt.getTime()), 'a valid Date is bound');
  });
});

describe('the Tool model bumps its own versions on create — the fixture assumption that was wrong', () => {
  // WHY THIS IS HERE: the real-engine self-test seeded credentialVersion:1 / sessionBundle.version:1
  // and then guarded patchGuarded on credentialVersion:1. But Tool's own preSave bumps both whenever
  // a credential/bundle field changes, and a create counts — so 2/2 was stored and the guard could
  // never match. patchGuarded was right to return 0 rows; the TEST was wrong, and three of its
  // content checks passed vacuously off the bumped values. Pinning the model behaviour here means
  // the next person writing a guard against a freshly created Tool sees it locally.
  test('create() with a bundle stores versions ABOVE the seeded values', async () => {
    const { pool, queries } = fakePool(1);
    adapter.__test.setPool(pool);
    const RealTool = require('../models/Tool');
    await RealTool.create({
      _id: 'presave-1', name: 'SEED', status: 'active', credentialVersion: 1,
      sessionBundle: { version: 1, cookiesEncrypted: JSON.stringify([{ name: 'old' }]) },
    });
    const insert = queries.find(q => /INSERT INTO/.test(q.sql));
    const stored = JSON.parse(insert.params[1]);
    assert.strictEqual(stored.credentialVersion, 2, 'preSave bumped credentialVersion past the seed');
    assert.strictEqual(stored.sessionBundle.version, 2, 'and bumped sessionBundle.version too');
    assert.strictEqual(typeof stored.credentialVersion, 'number', 'and it stays a number');
  });
});

describe('the real-engine check stays wired to the code it protects', () => {
  // WHY: the guarded-write primitives and the Tool version behaviour are only truly verified by
  // scripts/extcredsync-db-selftest.js against a real engine. If that job stops running on the
  // files that can break it, the fake-driver tests above would be the only gate — and they passed
  // through BOTH real defects (the DATETIME binding and the stale-guard fixture). This keeps the
  // wiring honest. It is a string check on purpose: no YAML parser is a dependency of this suite.
  const fs = require('fs');
  const path = require('path');
  const WF = path.join(__dirname, '..', '..', '.github', 'workflows', 'extsync-db-selftest.yml');

  test('the workflow exists and runs on pull requests into main', () => {
    assert.ok(fs.existsSync(WF), 'the real-DB workflow is present');
    const src = fs.readFileSync(WF, 'utf8');
    assert.match(src, /^\s*pull_request:/m, 'it runs on pull requests...');
    assert.match(src, /pull_request:[\s\S]{0,200}?branches:\s*\[main\]/, '...targeting main, so it lands before the merge that triggers Hostinger');
  });

  test('it covers every file that can break the guarded writes', () => {
    const src = fs.readFileSync(WF, 'utf8');
    for (const f of [
      'backend/db/mysqlAdapter.js',                        // the primitives + the timestamp binding
      'backend/models/Tool.js',                            // preSave bumps the versions guards lock on
      'backend/models/proxy/ExtAutoSyncPolicy.js',
      'backend/utils/proxy/extensionCredentialSync.js',
      'backend/scripts/extcredsync-db-selftest.js',
    ]) {
      assert.ok(src.includes(f), `the real-DB job must run when ${f} changes`);
    }
  });

  test('it stays test-only: no repository secrets, read-only token', () => {
    const src = fs.readFileSync(WF, 'utf8');
    assert.doesNotMatch(src, /secrets\./, 'a test job must never carry production credentials');
    assert.match(src, /permissions:\s*\n\s*contents:\s*read/, 'and must hold a read-only token');
  });
});
