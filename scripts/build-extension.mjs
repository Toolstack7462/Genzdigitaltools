#!/usr/bin/env node
'use strict';
/**
 * Build / verify the served Chrome-extension ZIP from chrome-extension/.
 *
 * WHY THIS EXISTS: the served extension ZIP
 *   frontend/{public,build}/downloads/genz-digital-store-extension.zip
 * is a committed static artifact. The frontend build (CRA) does NOT regenerate it,
 * so editing chrome-extension/ (or bumping its manifest version) leaves the served
 * ZIP — and therefore the admin "latest version" + client update banner, which read
 * the ZIP's manifest.json — STALE until someone re-zips by hand. That drift is the
 * root cause of "new extension version not appearing."
 *
 * This is NOT a new release system: it just rebuilds the SAME existing artifact in the
 * SAME existing locations, deterministically, from the single source of truth
 * (chrome-extension/manifest.json). The backend version system (readDiskExtensionVersion
 * → zipManifest) is unchanged.
 *
 * Usage:
 *   node scripts/build-extension.mjs           # rebuild the ZIP into both download dirs
 *   node scripts/build-extension.mjs --check    # verify served ZIPs match source manifest (no write)
 *
 * Dependency-free (Node core only): builds a standard DEFLATE zip compatible with
 * Chrome and with backend/utils/zipManifest.js (methods 0/8). Reproducible (fixed
 * entry timestamps) so re-running on unchanged source yields a byte-identical ZIP.
 */
import fs from 'fs';
import path from 'path';
import zlib from 'zlib';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(__dirname, '..');
const SRC = path.join(REPO, 'chrome-extension');
const ZIP_NAME = 'genz-digital-store-extension.zip';
const OUT_DIRS = [
  path.join(REPO, 'frontend', 'public', 'downloads'),
  path.join(REPO, 'frontend', 'build', 'downloads'),
];
const EXCLUDE_DIRS = new Set(['node_modules', '.git']);
const EXCLUDE_FILES = new Set(['.DS_Store', 'Thumbs.db']);
// Fixed DOS date/time (2024-01-01 00:00:00) so identical source → identical ZIP bytes.
const DOS_TIME = 0;
const DOS_DATE = ((2024 - 1980) << 9) | (1 << 5) | 1;

// ── CRC32 ────────────────────────────────────────────────────────────────────
const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = (c & 1) ? (0xedb88320 ^ (c >>> 1)) : (c >>> 1);
    t[n] = c >>> 0;
  }
  return t;
})();
function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function listFiles(dir, base = '') {
  const out = [];
  for (const name of fs.readdirSync(dir).sort()) {
    const full = path.join(dir, name);
    const rel = base ? `${base}/${name}` : name;
    const st = fs.statSync(full);
    if (st.isDirectory()) { if (!EXCLUDE_DIRS.has(name)) out.push(...listFiles(full, rel)); }
    else if (!EXCLUDE_FILES.has(name) && !name.endsWith('.tmp')) out.push({ full, arc: rel });
  }
  return out;
}

function buildZip(files) {
  const locals = [];
  const central = [];
  let offset = 0;
  for (const f of files) {
    const data = fs.readFileSync(f.full);
    const crc = crc32(data);
    const deflated = zlib.deflateRawSync(data, { level: 9 });
    const useDeflate = deflated.length < data.length;
    const method = useDeflate ? 8 : 0;
    const body = useDeflate ? deflated : data;
    const nameBuf = Buffer.from(f.arc, 'utf8');

    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);           // version needed
    local.writeUInt16LE(0, 6);            // flags
    local.writeUInt16LE(method, 8);
    local.writeUInt16LE(DOS_TIME, 10);
    local.writeUInt16LE(DOS_DATE, 12);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(body.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(nameBuf.length, 26);
    local.writeUInt16LE(0, 28);
    locals.push(local, nameBuf, body);

    const cen = Buffer.alloc(46);
    cen.writeUInt32LE(0x02014b50, 0);
    cen.writeUInt16LE(20, 4);             // version made by
    cen.writeUInt16LE(20, 6);             // version needed
    cen.writeUInt16LE(0, 8);
    cen.writeUInt16LE(method, 10);
    cen.writeUInt16LE(DOS_TIME, 12);
    cen.writeUInt16LE(DOS_DATE, 14);
    cen.writeUInt32LE(crc, 16);
    cen.writeUInt32LE(body.length, 20);
    cen.writeUInt32LE(data.length, 24);
    cen.writeUInt16LE(nameBuf.length, 28);
    cen.writeUInt32LE(offset, 42);        // local header offset
    central.push(cen, nameBuf);

    offset += local.length + nameBuf.length + body.length;
  }
  const localPart = Buffer.concat(locals);
  const centralPart = Buffer.concat(central);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(files.length, 8);
  eocd.writeUInt16LE(files.length, 10);
  eocd.writeUInt32LE(centralPart.length, 12);
  eocd.writeUInt32LE(localPart.length, 16);
  return Buffer.concat([localPart, centralPart, eocd]);
}

// Minimal manifest-version reader (same approach as backend/utils/zipManifest.js).
function zipManifestVersion(buf) {
  const minLen = 22;
  let eocd = -1;
  for (let i = buf.length - minLen; i >= Math.max(0, buf.length - minLen - 0xffff); i--) {
    if (buf.readUInt32LE(i) === 0x06054b50) { eocd = i; break; }
  }
  if (eocd < 0) return null;
  const total = buf.readUInt16LE(eocd + 10);
  let p = buf.readUInt32LE(eocd + 16);
  for (let i = 0; i < total; i++) {
    if (buf.readUInt32LE(p) !== 0x02014b50) break;
    const method = buf.readUInt16LE(p + 10);
    const compSize = buf.readUInt32LE(p + 20);
    const nameLen = buf.readUInt16LE(p + 28);
    const extraLen = buf.readUInt16LE(p + 30);
    const commentLen = buf.readUInt16LE(p + 32);
    const locOff = buf.readUInt32LE(p + 42);
    const name = buf.toString('utf8', p + 46, p + 46 + nameLen).toLowerCase();
    if (name === 'manifest.json' || name.endsWith('/manifest.json')) {
      const locNameLen = buf.readUInt16LE(locOff + 26);
      const locExtraLen = buf.readUInt16LE(locOff + 28);
      const start = locOff + 30 + locNameLen + locExtraLen;
      const raw = buf.subarray(start, start + compSize);
      const bytes = method === 8 ? zlib.inflateRawSync(raw) : raw;
      return JSON.parse(bytes.toString('utf8')).version || null;
    }
    p += 46 + nameLen + extraLen + commentLen;
  }
  return null;
}

function sourceVersion() {
  return JSON.parse(fs.readFileSync(path.join(SRC, 'manifest.json'), 'utf8')).version;
}

// ── main ──────────────────────────────────────────────────────────────────────
const check = process.argv.includes('--check');
const srcVer = sourceVersion();

if (check) {
  let ok = true;
  for (const dir of OUT_DIRS) {
    const p = path.join(dir, ZIP_NAME);
    if (!fs.existsSync(p)) { console.error(`MISSING  ${p}`); ok = false; continue; }
    const ver = zipManifestVersion(fs.readFileSync(p));
    const match = ver === srcVer;
    console.log(`${match ? 'OK      ' : 'STALE   '} ${path.relative(REPO, p)} → ${ver} (source ${srcVer})`);
    if (!match) ok = false;
  }
  if (!ok) {
    console.error('\n✗ Served extension ZIP is out of sync with chrome-extension/manifest.json.');
    console.error('  Run:  node scripts/build-extension.mjs   (then commit + deploy)');
    process.exit(1);
  }
  console.log(`\n✓ Served extension ZIP matches source (v${srcVer}).`);
  process.exit(0);
}

const files = listFiles(SRC);
if (!files.some(f => f.arc === 'manifest.json')) {
  console.error('✗ chrome-extension/manifest.json not found — refusing to build.');
  process.exit(1);
}
const zip = buildZip(files);
const built = zipManifestVersion(zip);
if (built !== srcVer) {
  console.error(`✗ Internal error: built ZIP version ${built} != source ${srcVer}.`);
  process.exit(1);
}
for (const dir of OUT_DIRS) {
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, ZIP_NAME), zip);
  console.log(`wrote ${path.relative(REPO, path.join(dir, ZIP_NAME))} (${files.length} files, v${built}, ${zip.length} bytes)`);
}
console.log(`\n✓ Extension ZIP rebuilt from source at v${built}.`);
