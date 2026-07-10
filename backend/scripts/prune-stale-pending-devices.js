'use strict';
/**
 * prune-stale-pending-devices.js
 *
 * One-off maintenance: remove STALE pending DeviceProfile rows created by the old
 * fingerprint-drift bug. Before the fix, every fingerprint change spawned a NEW pending
 * profile that carried the SAME stable browserInstanceId as the client's already-approved
 * profile. The resolve() fix now makes approved win over those duplicates, so they are
 * inert — this just cleans them out of the admin device list.
 *
 * SAFETY — a pending row is deleted ONLY when ALL of these hold:
 *   • status === 'pending'
 *   • it has at least one browserInstanceId
 *   • EVERY one of its browserInstanceIds is already present on an APPROVED profile of the
 *     SAME client (i.e. the browser is already trusted — nothing new is awaiting approval)
 * approved and blocked rows are never touched; a pending row that contains any browser not
 * covered by an approved profile (a genuinely new device awaiting approval) is never touched.
 *
 * DRY-RUN by default — prints what it WOULD delete and changes nothing. Pass --apply to
 * delete; --apply first writes a full JSON backup of every removed row next to this script.
 * Optional --client=email@x.com scopes the whole run to a single client.
 *
 * Run on the server (where DATABASE_URL is reachable), from the app root:
 *   cd /home/u171982351/domains/api.genzdigitalstore.com/nodejs
 *   node scripts/prune-stale-pending-devices.js            # dry run (safe)
 *   node scripts/prune-stale-pending-devices.js --apply    # actually delete (backs up first)
 */
const dotenv = require('dotenv');
const path = require('path');
const fs = require('fs');
const mysqlAdapter = require('../db/mysqlAdapter');

dotenv.config({ path: path.join(__dirname, '..', '.env') });

const APPLY = process.argv.includes('--apply');
const clientArg = (process.argv.find(a => a.startsWith('--client=')) || '').split('=')[1] || null;

function idsOf(p) {
  return Array.isArray(p.browserInstanceIds) ? p.browserInstanceIds.filter(Boolean) : [];
}

async function main() {
  await mysqlAdapter.connect();
  const DeviceProfile = require('../models/DeviceProfile');

  const all = await DeviceProfile.find({});
  const clientFilter = clientArg ? String(clientArg).trim().toLowerCase() : null;

  // Group every profile by client.
  const byClient = new Map();
  for (const p of all) {
    const cid = String(p.clientId || '');
    if (!cid) continue;
    if (clientFilter && String(p.clientEmail || '').toLowerCase() !== clientFilter) continue;
    if (!byClient.has(cid)) byClient.set(cid, []);
    byClient.get(cid).push(p);
  }

  const candidates = [];
  for (const [cid, profiles] of byClient) {
    // Every browser instance that is already trusted (present on an approved profile).
    const approvedBrowsers = new Set();
    for (const p of profiles) {
      if (p.status === 'approved') for (const id of idsOf(p)) approvedBrowsers.add(id);
    }
    if (approvedBrowsers.size === 0) continue; // no approved anchor → never prune this client

    for (const p of profiles) {
      if (p.status !== 'pending') continue;
      const ids = idsOf(p);
      if (ids.length === 0) continue;                          // fingerprint-only pending → leave
      const fullyCovered = ids.every(id => approvedBrowsers.has(id));
      if (fullyCovered) candidates.push({ clientId: cid, profile: p });
    }
  }

  const total = all.length;
  console.log(`\n[prune] scanned ${total} device profiles across ${byClient.size} client(s)` +
    (clientFilter ? ` (filtered to ${clientFilter})` : ''));
  console.log(`[prune] stale pending duplicates found: ${candidates.length}\n`);

  for (const { profile: p } of candidates) {
    console.log(`  - id=${p._id} client=${p.clientEmail || p.clientId} ` +
      `deviceGroup=${String(p.deviceGroupId || '').slice(0, 12)}… ` +
      `browsers=${idsOf(p).length} createdAt=${p.createdAt ? new Date(p.createdAt).toISOString() : '?'}`);
  }

  if (candidates.length === 0) {
    console.log('[prune] nothing to do.');
    await mysqlAdapter.close();
    return;
  }

  if (!APPLY) {
    console.log(`\n[prune] DRY RUN — no changes made. Re-run with --apply to delete the ${candidates.length} row(s) above.`);
    await mysqlAdapter.close();
    return;
  }

  // Back up every row we are about to delete BEFORE deleting (full data, recoverable).
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const backupPath = path.join(__dirname, `prune-backup-${stamp}.json`);
  const backup = candidates.map(c => (c.profile.toObject ? c.profile.toObject() : c.profile));
  fs.writeFileSync(backupPath, JSON.stringify(backup, null, 2));
  console.log(`\n[prune] backup written: ${backupPath}`);

  let deleted = 0;
  for (const { profile: p } of candidates) {
    const res = await DeviceProfile.deleteOne({ _id: p._id });
    if (res && res.deletedCount) deleted += res.deletedCount;
  }
  console.log(`[prune] deleted ${deleted} stale pending duplicate(s).`);
  await mysqlAdapter.close();
}

main().catch(async (err) => {
  console.error('[prune] FAILED:', err && err.stack ? err.stack : err);
  try { await mysqlAdapter.close(); } catch (_) {}
  process.exit(1);
});
