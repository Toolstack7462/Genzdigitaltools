'use strict';
/**
 * REAL-DATABASE self-test for the extension-auto-sync concurrency primitives
 * (updateJsonPath / patchGuarded). This is the test that the mocked unit suite CANNOT replace: it
 * exercises the actual JSON_SET + guarded-UPDATE SQL against the SAME MySQL/MariaDB engine/version
 * production runs on. It uses a THROWAWAY row (id prefixed `selftest-`) and deletes it at the end;
 * it never reads, writes, or depends on any real Tool.
 *
 * ISOLATION (required): point DATABASE_URL at a SCRATCH database on the SAME engine/version as
 * production — never the production schema — and set EXTCREDSYNC_SELFTEST_DB=1 to confirm. The test
 * refuses to run without that flag. It only ever creates/updates/deletes ONE throwaway row
 * (id `selftest-<timestamp>`, which is NOT a valid hex Tool id, so it can never collide with a real
 * Tool); it reads/writes no other row and never a customer record. It is a dev utility and is NOT
 * part of the production deploy set.
 *
 *   DATABASE_URL="mysql://user:pass@host:3306/scratch_db" EXTCREDSYNC_SELFTEST_DB=1 \
 *     node scripts/extcredsync-db-selftest.js
 * Exit code 0 = all cases passed; non-zero = a failure (do NOT enable enforcement until it passes).
 */
const adapter = require('../db/mysqlAdapter');
const Tool = require('../models/Tool');

if (!/^(1|true|yes)$/i.test(String(process.env.EXTCREDSYNC_SELFTEST_DB || ''))) {
  console.error('REFUSING TO RUN: set EXTCREDSYNC_SELFTEST_DB=1 and point DATABASE_URL at an ISOLATED scratch database (same engine/version as prod, never the production schema).');
  process.exit(2);
}

const ID = 'selftest-' + Date.now();
let passed = 0, failed = 0;
function check(name, cond, extra) { if (cond) { passed++; console.log('  ✓', name); } else { failed++; console.error('  ✗', name, extra != null ? JSON.stringify(extra) : ''); } }
const raw = async (id) => { const r = await Tool._findRaw({ _id: id }); return r[0] || null; };

(async () => {
  // (1) EXPLICIT DATABASE-IDENTITY VERIFICATION — the primary isolation proof. The operator must
  // name the scratch DB in EXTCREDSYNC_EXPECTED_DB; we open a raw connection, ask the SERVER which
  // database + user we are actually on (SELECT DATABASE()/CURRENT_USER()), and refuse unless the
  // live db name equals the expected scratch name. This also captures the real engine/VERSION().
  const expectedDb = String(process.env.EXTCREDSYNC_EXPECTED_DB || '');
  if (!expectedDb) { console.error('REFUSING TO RUN: set EXTCREDSYNC_EXPECTED_DB to the scratch database name you provisioned.'); process.exit(2); }
  let mysql; try { mysql = require('mysql2/promise'); } catch (e) { console.error('mysql2 not installed in this app env — run from the staging app environment with the updated code + deps.'); process.exit(2); }
  {
    const conn = await mysql.createConnection(process.env.DATABASE_URL);
    const [[idrow]] = await conn.query('SELECT DATABASE() AS db, CURRENT_USER() AS usr, VERSION() AS ver');
    // PRIVILEGE ISOLATION (primary proof): the connecting account must have NO production reach.
    // A properly restricted scratch user is granted only on the scratch schema; the sole allowed
    // global grant is the baseline `USAGE ON *.*`. Any other `ON *.*` grant (SELECT/ALL/…) means the
    // account can touch other schemas (incl. production) → refuse.
    let grantLines = [];
    try { const [g] = await conn.query('SHOW GRANTS FOR CURRENT_USER()'); grantLines = g.map(r => String(Object.values(r)[0] || '')); } catch (_) {}
    await conn.end();
    console.log(`[selftest] connected db=${idrow.db} user=${idrow.usr} engine/version=${idrow.ver}`);
    console.log('[selftest] grants:\n    ' + grantLines.join('\n    '));
    if (idrow.db !== expectedDb) { console.error(`REFUSING TO RUN: connected to '${idrow.db}', not the expected scratch db '${expectedDb}'.`); process.exit(2); }
    const overReach = grantLines.find(l => /\bON\s+\*\.\*/i.test(l) && !/\bGRANT\s+USAGE\s+ON\s+\*\.\*/i.test(l));
    if (overReach) { console.error(`REFUSING TO RUN: the scratch account has a global privilege beyond USAGE — it is NOT restricted to the scratch schema:\n    ${overReach}`); process.exit(2); }
    if (!grantLines.some(l => new RegExp('ON\\s+[`\'"]?' + expectedDb.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '[`\'"]?\\.\\*', 'i').test(l))) {
      console.error(`REFUSING TO RUN: no grant scoped to \`${expectedDb}\`.* found — cannot confirm the account is provisioned for the scratch schema.`);
      process.exit(2);
    }
  }

  await adapter.connect();

  // (2) VERIFY THIS IS THE UPDATED CODE — the new adapter primitives must exist, else we'd be
  // testing a stale app directory rather than the integration under review.
  if (typeof Tool.patchGuarded !== 'function' || typeof Tool.updateJsonPath !== 'function') {
    console.error('REFUSING TO RUN: this app environment lacks the updated mysqlAdapter (patchGuarded/updateJsonPath). Deploy the updated code to staging first.');
    process.exit(2);
  }

  try {
    // Secondary safeguard: a real scratch DB's `tools` table is EMPTY; production's is not.
    const existing = await Tool.countDocuments({});
    if (existing > 0) {
      console.error(`REFUSING TO RUN: the target \`tools\` table has ${existing} row(s) — not an empty scratch database.`);
      process.exit(2);
    }

    // Seed a throwaway row that looks like a bound extension Tool.
    await Tool.create({
      _id: ID, name: 'SELFTEST', status: 'active', domain: 'example.invalid', targetUrl: 'https://example.invalid/',
      credentialType: 'cookies', credentialVersion: 1,
      sessionBundle: { version: 1, cookiesEncrypted: JSON.stringify([{ name: 'old' }]) },
      autoSync: { enabled: true, sourceProxyTool: 'writehuman', mode: 'enforce', expectedAccountId: 'acctX', sync: { lastResult: 'observe' } },
      keepField: 'untouched',
    });

    // 1. updateJsonPath sets ONLY autoSync.sync and preserves JSON OBJECT type (not a string).
    await Tool.updateJsonPath(ID, 'autoSync.sync', { lastResult: 'synced', pending: false, n: 2 });
    let row = await raw(ID);
    check('updateJsonPath wrote the sub-object', row.autoSync.sync && row.autoSync.sync.lastResult === 'synced', row.autoSync.sync);
    check('autoSync.sync is a JSON OBJECT, not a serialized string', typeof row.autoSync.sync === 'object' && row.autoSync.sync.n === 2, typeof row.autoSync.sync);
    check('updateJsonPath left control + unrelated fields intact', row.autoSync.enabled === true && row.autoSync.mode === 'enforce' && row.keepField === 'untouched');

    // READ BACK WHAT WAS ACTUALLY STORED before guarding on it. The Tool model's own preSave bumps
    // `credentialVersion` and `sessionBundle.version` whenever a credential/bundle field changes, and
    // a create counts as a change — so the seeded 1/1 above is already 2/2 on disk. Guarding on the
    // seeded value made patchGuarded correctly refuse the write (0 rows), while THREE content checks
    // passed anyway off the preSave-bumped values. Derive the guards from the row instead: the
    // optimistic lock is only meaningfully exercised when the expected value is the real one.
    const seeded = await raw(ID);
    const v0 = Number(seeded.credentialVersion);
    const b0 = Number(seeded.sessionBundle && seeded.sessionBundle.version);
    check('seed read back with the model-applied versions', Number.isFinite(v0) && Number.isFinite(b0), { v0, b0 });

    // 2. patchGuarded SUCCESS when all guards hold (version + authorization) — targeted write.
    let rows = await Tool.patchGuarded(ID, { credentialVersion: v0 + 1, 'sessionBundle': { version: b0 + 1, cookiesEncrypted: JSON.stringify([{ name: 'new' }]) } },
      { credentialVersion: v0, 'autoSync.enabled': true, 'autoSync.mode': 'enforce', 'autoSync.expectedAccountId': 'acctX' });
    row = await raw(ID);
    check('patchGuarded success returns 1 row', rows === 1, rows);
    check('patchGuarded bumped credentialVersion', row.credentialVersion === v0 + 1, row.credentialVersion);
    check('patchGuarded credentialVersion is a NUMBER, not a JSON string', typeof row.credentialVersion === 'number', typeof row.credentialVersion);
    check('patchGuarded set sessionBundle as OBJECT', typeof row.sessionBundle === 'object' && row.sessionBundle.version === b0 + 1, row.sessionBundle && row.sessionBundle.version);
    check('patchGuarded preserved unrelated field', row.keepField === 'untouched');

    // 3. patchGuarded CONFLICT on a stale credentialVersion guard → 0 rows, no change.
    rows = await Tool.patchGuarded(ID, { credentialVersion: 99 }, { credentialVersion: v0 /* stale now */ });
    row = await raw(ID);
    check('patchGuarded version conflict returns 0 rows', rows === 0, rows);
    check('patchGuarded version conflict wrote nothing', row.credentialVersion === v0 + 1, row.credentialVersion);

    // 4. patchGuarded AUTHORIZATION conflict: binding withdrawn (enabled=false) → 0 rows.
    await Tool.updateJsonPath(ID, 'autoSync.enabled', false);
    rows = await Tool.patchGuarded(ID, { credentialVersion: v0 + 2 }, { credentialVersion: v0 + 1, 'autoSync.enabled': true });
    row = await raw(ID);
    check('patchGuarded authorization conflict returns 0 rows', rows === 0, rows);
    check('patchGuarded authorization conflict wrote nothing', row.credentialVersion === v0 + 1, row.credentialVersion);

    // 5. NULL handling: guard requiring an ABSENT path matches only when truly absent.
    rows = await Tool.patchGuarded(ID, { marker: 'x' }, { 'nope.missing': null });
    check('patchGuarded null-guard matches an absent path', rows === 1, rows);
    rows = await Tool.patchGuarded(ID, { marker: 'y' }, { credentialVersion: null /* present → should NOT match */ });
    check('patchGuarded null-guard rejects a present field', rows === 0, rows);
  } catch (e) {
    failed++; console.error('  ✗ EXCEPTION', e && e.message);
  } finally {
    try { await Tool.deleteOne({ _id: ID }); } catch (_) {}
    const left = await raw(ID).catch(() => null);
    check('throwaway row cleaned up', !left);
  }

  console.log(`\n[selftest] passed=${passed} failed=${failed}`);
  process.exit(failed ? 1 : 0);
})().catch((e) => { console.error('[selftest] fatal', e && e.message); process.exit(1); });
