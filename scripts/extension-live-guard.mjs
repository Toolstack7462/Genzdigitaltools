#!/usr/bin/env node
'use strict';
/**
 * Deploy guard: never let a frontend deploy overwrite a NEWER live extension release.
 *
 * WHY THIS EXISTS: the extension ZIP has two writers that share one file —
 *   1. the admin panel upload (backend writes the docroots directly), and
 *   2. every frontend deploy, which mirrors the COMMITTED
 *      frontend/build/downloads/genz-digital-store-extension.zip to both docroots.
 * After an admin publishes v3.9.29, the next frontend deploy would silently put the committed
 * v3.9.25 back (lftp `mirror -R` uploads any file whose size/time differ), and every client would
 * again be offered a package older than the release the admin approved.
 *
 * Rule: the committed ZIP is shipped only when, on EVERY public origin, the live ZIP is absent,
 * byte-identical, or strictly OLDER. A newer live version, the same version with different bytes,
 * or a live ZIP we could not read all mean "keep live" — the deploy then leaves the ZIP out.
 *
 * Usage:
 *   node scripts/extension-live-guard.mjs <local.zip> [origin ...] [--remove-if-keep]
 * Prints DECISION=ship|keep-live (and writes decision=… to $GITHUB_OUTPUT when set). Exit 0
 * either way; exit 2 only when the local ZIP itself is unreadable.
 */
import fs from 'fs';
import crypto from 'crypto';
import { createRequire } from 'module';
import { fileURLToPath } from 'url';

const require = createRequire(import.meta.url);
const { readManifestFromZip } = require('../backend/utils/zipManifest.js');
const { compareVersions } = require('../backend/utils/semver.js');

const ZIP = 'genz-digital-store-extension.zip';
export const DEFAULT_ORIGINS = ['https://genzdigitalstore.com', 'https://app.genzdigitalstore.com'];

const sha256 = (b) => crypto.createHash('sha256').update(b).digest('hex');

export function describeZip(buf) {
  return { version: readManifestFromZip(buf).version, sha256: sha256(buf), size: buf.length };
}

/**
 * Pure decision. `lives` = [{origin, status:'ok'|'absent'|'error', version?, sha256?, error?}].
 * @returns {{ship:boolean, reasons:string[]}}
 */
export function decideDeploy(local, lives) {
  const reasons = [];
  let ship = true;
  for (const l of lives) {
    if (l.status === 'absent') { reasons.push(`${l.origin}: no live ZIP — ship`); continue; }
    if (l.status !== 'ok' || !l.version) {
      ship = false; reasons.push(`${l.origin}: live ZIP could not be read (${l.error || 'unknown'}) — keep live`); continue;
    }
    if (l.sha256 === local.sha256) { reasons.push(`${l.origin}: identical (v${l.version})`); continue; }
    const cmp = compareVersions(local.version, l.version);
    if (cmp > 0) { reasons.push(`${l.origin}: live v${l.version} < repo v${local.version} — ship`); continue; }
    ship = false;
    reasons.push(cmp < 0
      ? `${l.origin}: live v${l.version} is NEWER than repo v${local.version} — keep live`
      : `${l.origin}: live v${l.version} has different bytes than the repo's v${local.version} — keep live`);
  }
  return { ship, reasons };
}

async function fetchLive(origin) {
  const url = `${origin}/downloads/${ZIP}?deploy-guard=${Date.now()}`;
  try {
    const res = await fetch(url, { headers: { 'Cache-Control': 'no-cache' }, signal: AbortSignal.timeout(30000) });
    if (res.status === 404) return { origin, status: 'absent' };
    if (!res.ok) return { origin, status: 'error', error: `HTTP ${res.status}` };
    const buf = Buffer.from(await res.arrayBuffer());
    return { origin, status: 'ok', ...describeZip(buf) };
  } catch (err) {
    return { origin, status: 'error', error: String(err.message || err) };
  }
}

async function main(argv) {
  const removeIfKeep = argv.includes('--remove-if-keep');
  const args = argv.filter(a => !a.startsWith('--'));
  const localPath = args[0];
  const origins = args.length > 1 ? args.slice(1) : DEFAULT_ORIGINS;
  let local;
  try { local = describeZip(fs.readFileSync(localPath)); } catch (err) {
    console.error(`✗ cannot read local extension ZIP ${localPath}: ${err.message}`);
    process.exit(2);
  }
  const lives = [];
  for (const o of origins) lives.push(await fetchLive(o.replace(/\/+$/, '')));
  const { ship, reasons } = decideDeploy(local, lives);
  console.log(`repo ZIP: v${local.version} sha256 ${local.sha256.slice(0, 16)} (${local.size} B)`);
  for (const r of reasons) console.log(`  ${r}`);
  const decision = ship ? 'ship' : 'keep-live';
  console.log(`DECISION=${decision}`);
  if (process.env.GITHUB_OUTPUT) fs.appendFileSync(process.env.GITHUB_OUTPUT, `decision=${decision}\n`);
  if (!ship && removeIfKeep) {
    fs.unlinkSync(localPath);
    console.log(`  removed ${localPath} from this deploy so the live release is left untouched`);
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === fs.realpathSync(process.argv[1])) {
  main(process.argv.slice(2));
}
