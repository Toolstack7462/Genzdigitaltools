#!/usr/bin/env node
'use strict';
/**
 * WriteHuman multi-device sync — data migration.
 *
 * THERE IS NO SCHEMA CHANGE TO MAKE, and that is a finding rather than an omission. ProxyAccount is
 * stored by the MySQL JSON-document adapter: one row, one `data` blob, `CREATE TABLE IF NOT EXISTS`
 * at boot, and secondary indexes added idempotently as generated columns. Every field this feature
 * introduces — syncDevices, activeSource, candidate, bundleVersion, rollbackBundles,
 * knownSessionIds, activeSourceIntent, lastAgentSeenAt — is a new key inside that blob. No ALTER,
 * no new table, nothing to roll back at the schema level.
 *
 * What this script does instead is INITIALISE those fields on the WriteHuman primary account so the
 * first request meets defined state rather than undefined, and so the admin dashboard renders real
 * values on day one. It is deliberately narrow:
 *
 *   - additive: only ever ADDS keys that are absent; never rewrites one that exists;
 *   - idempotent: a second run changes nothing (proven by --verify);
 *   - tool-scoped: touches ProxyAccount rows with tool='writehuman' and nothing else;
 *   - NEVER touches sessionEncrypted, sessionMeta, cookieHash, status, session_status or
 *     verification. The live session is not this script's business, and the whole point of the
 *     rollout is that nothing overwrites a working bundle.
 *
 * Safety: DRY RUN by default — pass --apply to write. --apply first saves a JSON backup of every
 * row it will touch (including the encrypted bundle, so a restore is possible) to the path given by
 * --backup, and refuses to proceed if that file cannot be written.
 *
 * On the server:
 *   node -r dotenv/config scripts/writehuman-device-sync-migrate.js --apply \
 *        --backup ~/writehuman-migrate-backup.json \
 *        dotenv_config_path=/home/u171982351/domains/api.genzdigitalstore.com/.builds/config/.env
 */
const fs = require('fs');
const path = require('path');

// The fields this feature reads. Absent means "no devices yet", which is the correct initial state.
const DEFAULTS = {
  syncDevices: [],
  knownSessionIds: [],
  rollbackBundles: [],
  bundleVersion: 0,
  activeSource: null,
  activeSourceIntent: null,
  candidate: null,
  pairingCodes: [],
  lastAgentSeenAt: null,
  lastSyncAttemptAt: null,
  lastSyncSuccessAt: null,
  lastSyncResultCode: null,
};

// Fields that describe the LIVE SESSION. This script must never write any of them; the assertion
// below is what makes that a guarantee rather than an intention.
const PROTECTED = [
  'sessionEncrypted', 'sessionMeta', 'cookieHash', 'status', 'session_status',
  'verification', 'lastVerifiedAt', 'expectedIdentifier', 'isPrimary', 'tool',
];

/**
 * Pure transformation: returns { changed, patch } for one account document.
 * Exported so it can be tested without a database.
 */
function planFor(doc) {
  const patch = {};
  for (const [k, v] of Object.entries(DEFAULTS)) {
    if (doc[k] === undefined) patch[k] = Array.isArray(v) ? [] : v;
  }
  return { changed: Object.keys(patch).length > 0, patch };
}

/** A plan may never mention a protected field. Belt and braces around planFor. */
function assertSafe(patch) {
  for (const k of Object.keys(patch)) {
    if (PROTECTED.includes(k)) throw new Error('refusing to write protected field: ' + k);
  }
}

async function main() {
  const argv = process.argv.slice(2);
  const apply = argv.includes('--apply');
  const verify = argv.includes('--verify');
  const bIdx = argv.indexOf('--backup');
  const backupPath = bIdx >= 0 ? argv[bIdx + 1] : null;

  const db = require('../db/mysqlAdapter');
  const ProxyAccount = require('../models/proxy/ProxyAccount');
  if (typeof db.connect === 'function') await db.connect();

  const accounts = await ProxyAccount.find({ tool: 'writehuman' });
  console.log(`[migrate] writehuman accounts: ${accounts.length}`);
  if (!accounts.length) { console.log('[migrate] nothing to do'); return finish(db, 0); }

  const plans = accounts.map(a => ({ a, ...planFor(a) }));
  for (const p of plans) assertSafe(p.patch);
  const todo = plans.filter(p => p.changed);

  for (const p of plans) {
    const keys = Object.keys(p.patch);
    console.log(`  ${String(p.a._id).slice(0, 12)} ${p.a.label || ''} -> ${keys.length ? 'add ' + keys.join(', ') : 'already initialised'}`);
  }

  if (verify) {
    // Idempotency check: after a correct run there is nothing left to add.
    const dirty = todo.length;
    console.log(dirty === 0
      ? '[verify] PASS — all accounts already initialised, a re-run is a no-op'
      : `[verify] ${dirty} account(s) still need initialisation`);
    return finish(db, dirty === 0 ? 0 : 1);
  }

  if (!apply) {
    console.log(`[migrate] DRY RUN — ${todo.length} account(s) would change. Pass --apply to write.`);
    return finish(db, 0);
  }
  if (!todo.length) { console.log('[migrate] nothing to change (already idempotent)'); return finish(db, 0); }

  if (!backupPath) { console.error('[migrate] --apply requires --backup <path>'); return finish(db, 1); }
  const backup = todo.map(p => JSON.parse(JSON.stringify(p.a)));
  fs.mkdirSync(path.dirname(path.resolve(backupPath)), { recursive: true });
  fs.writeFileSync(path.resolve(backupPath), JSON.stringify({ takenAt: new Date().toISOString(), accounts: backup }, null, 2));
  console.log(`[migrate] backup of ${backup.length} row(s) written to ${backupPath}`);

  for (const p of todo) {
    const beforeSession = p.a.sessionEncrypted;
    Object.assign(p.a, p.patch);
    if (p.a.sessionEncrypted !== beforeSession) throw new Error('BUG: the active bundle changed — aborting');
    await p.a.save();
    console.log(`  applied to ${String(p.a._id).slice(0, 12)}`);
  }
  console.log('[migrate] done. Re-run with --verify to confirm idempotency.');
  return finish(db, 0);
}

async function finish(db, code) {
  try { if (typeof db.disconnect === 'function') await db.disconnect(); } catch (_) {}
  process.exitCode = code;
}

if (require.main === module) {
  main().catch((e) => { console.error('[migrate] FAILED:', e.message); process.exitCode = 1; });
}

module.exports = { planFor, assertSafe, DEFAULTS, PROTECTED };
