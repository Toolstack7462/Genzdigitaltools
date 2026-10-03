'use strict';
/**
 * The extension release = the ZIP clients actually download from
 * /downloads/genz-digital-store-extension.zip. This module writes that file into the
 * EXISTING static download folders (no new download route) and reads it back, so every
 * "latest version" the backend advertises is derived from the artifact being served —
 * never from a value that can drift away from it.
 *
 * Target dirs are taken from env EXTENSION_DOWNLOAD_DIRS (':'-separated absolute paths)
 * when set; otherwise the known Hostinger docroots are used. EVERY configured dir must be
 * a docroot clients download from: a publish writes all of them or none of them.
 *
 * ── 2026-10 incident ─────────────────────────────────────────────────────────────────
 * The default list targeted `genzdigitalstore.com/public_html/app/downloads` — a legacy
 * folder that serves nothing — instead of the app subdomain's real docroot
 * `app.genzdigitalstore.com/public_html/downloads`, which is where the client dashboard
 * and the extension popup download from. Admin uploads therefore replaced only the main
 * domain's copy. The version was then read from that copy alone, so clients were told
 * "v3.9.29", handed `…-v3.9.29.zip`, and received the untouched 3.9.25 package.
 * Fixes here: the real docroot; all-or-nothing writes with read-back verification;
 * "latest" = the OLDEST version any download dir serves (what every client is
 * guaranteed to get); and an optional public-URL check that the site serves the bytes
 * that were just written.
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { readManifestFromZip, readAllEntries } = require('./zipManifest');
const { compareVersions, isOlder, isValidChromeVersion } = require('./semver');

const ZIP_FILENAME = 'genz-digital-store-extension.zip';

// Versioned download name, e.g. genz-digital-store-extension-v3.9.3.zip.
// The file on disk keeps its stable name (existing link); this is only the
// suggested SAVE-AS name the browser uses via the HTML download attribute.
function versionedFilename(version) {
  const v = String(version || '').trim().replace(/^v/i, '');
  return v ? `genz-digital-store-extension-v${v}.zip` : ZIP_FILENAME;
}

// Version a chosen file claims in its name, e.g. "…-v3.9.29 (3).zip" → "3.9.29". The upload
// compares it with the ZIP's own manifest so a renamed old build is rejected, not published.
function versionFromFilename(name) {
  const m = /-v(\d+(?:\.\d+){0,3})(?=[^\d.]|\.zip$|$)/i.exec(String(name || ''));
  return m ? m[1] : null;
}

// The client-serving download folders: main site + app subdomain. Both are real docroots
// (verified `ls ~/domains/`). NOT `genzdigitalstore.com/public_html/app/` (an empty legacy dir
// that serves nothing) and NOT the api docroot (Passenger answers /downloads there with a 404).
const DEFAULT_DIRS = [
  '/home/u171982351/domains/genzdigitalstore.com/public_html/downloads',
  '/home/u171982351/domains/app.genzdigitalstore.com/public_html/downloads',
];
// The public origins that serve DEFAULT_DIRS, in the same order.
const DEFAULT_PUBLIC_ORIGINS = [
  'https://genzdigitalstore.com',
  'https://app.genzdigitalstore.com',
];

function targetDirs() {
  const fromEnv = String(process.env.EXTENSION_DOWNLOAD_DIRS || '').trim();
  return fromEnv ? fromEnv.split(':').map(s => s.trim()).filter(Boolean) : DEFAULT_DIRS;
}

// Origins to fetch after a publish to prove the site serves the new bytes. Explicit env wins
// (empty string = disabled). Unset: the default origins are used only with the default dirs,
// because they describe the same two docroots — custom dirs (dev, tests) are not checked.
function publicOrigins() {
  if (process.env.EXTENSION_PUBLIC_ORIGINS !== undefined) {
    return String(process.env.EXTENSION_PUBLIC_ORIGINS).split(/[\s,]+/).map(s => s.trim().replace(/\/+$/, '')).filter(Boolean);
  }
  return String(process.env.EXTENSION_DOWNLOAD_DIRS || '').trim() ? [] : DEFAULT_PUBLIC_ORIGINS;
}

function sha256(buf) {
  return crypto.createHash('sha256').update(buf).digest('hex');
}

// ── Reading what is served ───────────────────────────────────────────────────────────
// Per-file cache keyed by mtime+size so the ZIP isn't re-read on every request.
const _artifactCache = new Map();

/** One entry per configured dir: what that docroot currently serves. */
function readServedArtifacts() {
  return targetDirs().map((dir) => {
    const p = path.join(dir, ZIP_FILENAME);
    let st;
    try { st = fs.statSync(p); } catch (_) {
      return { dir, path: p, present: false, version: null, sha256: null, size: 0, key: null };
    }
    const hit = _artifactCache.get(p);
    if (hit && hit.mtimeMs === st.mtimeMs && hit.size === st.size) return hit.result;
    let result;
    try {
      const buf = fs.readFileSync(p);
      const m = readManifestFromZip(buf);
      result = {
        dir, path: p, present: true,
        version: m.version || null,
        sha256: sha256(buf),
        size: buf.length,
        key: (m.raw && m.raw.key) || null,
        mtime: new Date(st.mtimeMs).toISOString(),
      };
    } catch (err) {
      result = { dir, path: p, present: true, version: null, sha256: null, size: st.size, key: null, error: String(err.message || err) };
    }
    _artifactCache.set(p, { mtimeMs: st.mtimeMs, size: st.size, result });
    return result;
  });
}

/**
 * The release clients are guaranteed to receive. When the download dirs disagree, the OLDEST
 * readable version wins: advertising a version that only some docroots serve is exactly how a
 * client ends up with "v3.9.29" in the filename and 3.9.25 in the manifest.
 */
function resolveServedRelease() {
  const artifacts = readServedArtifacts();
  const readable = artifacts.filter(a => a.version);
  if (!readable.length) {
    return { version: null, sha256: null, size: 0, key: null, consistent: false, artifacts };
  }
  const oldest = readable.reduce((lo, a) => (compareVersions(a.version, lo.version) < 0 ? a : lo));
  const consistent = artifacts.length > 0 && artifacts.every(a => a.sha256 && a.sha256 === artifacts[0].sha256);
  return { version: oldest.version, sha256: oldest.sha256, size: oldest.size, key: oldest.key, consistent, artifacts };
}

// Kept for existing callers: the served (guaranteed-downloadable) version.
function readDiskExtensionVersion() {
  return resolveServedRelease().version;
}

/**
 * The ONE place that turns (DB release row + served artifact) into what clients are told.
 * - latest: the served artifact's version; the DB row is only a fallback when nothing is
 *   readable on disk (local dev). A DB row can never advertise a package nobody can download.
 * - effectiveMin: the admin minimum (or `latest` when force-update is on), clamped to `latest`
 *   so a client is never required to install a version that is not available.
 */
function resolvePublishedRelease(rel) {
  const served = resolveServedRelease();
  const dbVersion = rel ? (rel.version || null) : null;
  const latest = served.version || dbVersion || null;
  const minVersion = rel ? (rel.minVersion || null) : null;
  const forceUpdate = rel ? !!rel.updateRequired : false;
  let effectiveMin = minVersion || (forceUpdate ? latest : null);
  if (effectiveMin && latest && compareVersions(effectiveMin, latest) > 0) effectiveMin = latest;
  return {
    latest,
    dbVersion,
    diskVersion: served.version,
    minVersion,
    forceUpdate,
    effectiveMin,
    sha256: served.version ? served.sha256 : (rel ? rel.sha256 || null : null),
    size: served.version ? served.size : (rel ? rel.size || 0 : 0),
    servedConsistent: served.consistent,
    // Does the DB row describe the artifact actually being served?
    metadataMatchesArtifact: !served.version || !dbVersion
      || (dbVersion === served.version && (!rel.sha256 || rel.sha256 === served.sha256)),
    artifacts: served.artifacts,
  };
}

// ── Validating an upload ─────────────────────────────────────────────────────────────
function collectManifestRefs(m) {
  const refs = new Set();
  const add = (v) => { if (typeof v === 'string' && v && !/^https?:/i.test(v)) refs.add(v.replace(/^\.?\//, '')); };
  if (m.background) add(m.background.service_worker);
  if (m.action) {
    add(m.action.default_popup);
    if (m.action.default_icon && typeof m.action.default_icon === 'object') Object.values(m.action.default_icon).forEach(add);
    else add(m.action.default_icon);
  }
  if (m.icons) Object.values(m.icons).forEach(add);
  add(m.options_page);
  if (m.options_ui) add(m.options_ui.page);
  for (const cs of m.content_scripts || []) {
    (cs.js || []).forEach(add);
    (cs.css || []).forEach(add);
  }
  return [...refs];
}

class ReleaseError extends Error {
  constructor(status, code, message, extra) {
    super(message);
    this.status = status; this.code = code; this.extra = extra || {};
  }
}

/**
 * Prove an uploaded ZIP is a loadable package of the release it claims to be. Throws
 * ReleaseError(422) — the upload is rejected, never relabelled.
 * @param {Buffer} buf
 * @param {{expectedVersion?:string|null, currentKey?:string|null}} opts
 */
function validateExtensionPackage(buf, { expectedVersion = null, currentKey = null } = {}) {
  let entries;
  try { entries = readAllEntries(buf); } catch (e) {
    throw new ReleaseError(422, 'zip_corrupt', `The ZIP is damaged or unreadable (${e.message}). Rebuild it and upload again.`);
  }
  if (!entries.has('manifest.json')) {
    throw new ReleaseError(422, 'manifest_not_at_root', 'manifest.json must be at the top level of the ZIP (not inside a folder).');
  }
  let m;
  try { m = JSON.parse(entries.get('manifest.json').toString('utf8')); } catch (_) {
    throw new ReleaseError(422, 'manifest_not_valid_json', 'manifest.json is not valid JSON.');
  }
  if (!m || typeof m !== 'object') throw new ReleaseError(422, 'manifest_not_valid_json', 'manifest.json is not a JSON object.');
  if (m.manifest_version !== 3) throw new ReleaseError(422, 'unsupported_manifest_version', 'manifest_version must be 3.');
  const version = m.version != null ? String(m.version) : '';
  if (!isValidChromeVersion(version)) {
    throw new ReleaseError(422, 'invalid_manifest_version', `manifest.json "version" (${version || 'missing'}) is not a valid Chrome extension version (1–4 numbers 0–65535, e.g. 3.9.29).`);
  }
  if (expectedVersion && expectedVersion !== version) {
    throw new ReleaseError(422, 'version_mismatch',
      `This file is labelled v${expectedVersion} but its manifest.json says ${version}. It is not the v${expectedVersion} build — nothing was published.`,
      { expectedVersion, manifestVersion: version });
  }
  const missing = collectManifestRefs(m).filter(f => !entries.has(f));
  if (missing.length) {
    throw new ReleaseError(422, 'missing_runtime_files', `The package is incomplete — manifest.json references files that are not in the ZIP: ${missing.join(', ')}`, { missing });
  }
  // The manifest `key` fixes the extension ID; a different key would install as a different
  // extension and lose every client's pairing.
  if (currentKey && m.key !== currentKey) {
    throw new ReleaseError(422, 'extension_identity_changed', 'manifest.json "key" differs from the published extension — this would install as a different extension. Nothing was published.');
  }
  return { version, name: m.name || null, manifest: m, entryCount: entries.size, sha256: sha256(buf), size: buf.length };
}

/**
 * Publication policy. A version maps to exactly ONE set of bytes once published (that is also
 * what makes `?v=<version>` a safe cache key). Blocks: an older version (rollback needs the
 * override), and the same version with different bytes. The same version with the same bytes
 * is an idempotent re-publish — the way to repair docroots that drifted apart.
 * @param {{version:string, sha256:string}} upload
 * @param {{artifacts:Array, dbVersion?:string|null, dbSha256?:string|null}} current
 */
function decidePublish(upload, current, allowOverride = false) {
  const known = (current.artifacts || []).filter(a => a.version).map(a => ({ version: a.version, sha256: a.sha256 }));
  if (current.dbVersion) known.push({ version: current.dbVersion, sha256: current.dbSha256 || null });
  if (!known.length) return { ok: true, kind: 'first' };
  const newest = known.reduce((hi, a) => (compareVersions(a.version, hi.version) > 0 ? a : hi)).version;
  if (isOlder(upload.version, newest)) {
    return allowOverride
      ? { ok: true, kind: 'rollback', replacedVersion: newest }
      : { ok: false, status: 409, code: 'version_downgrade_blocked', publishedVersion: newest,
          error: `Upload blocked: version ${upload.version} is older than currently deployed version ${newest}.` };
  }
  const sameVersion = known.filter(a => compareVersions(a.version, upload.version) === 0);
  if (sameVersion.some(a => a.sha256 && a.sha256 !== upload.sha256)) {
    return allowOverride
      ? { ok: true, kind: 'replace', replacedVersion: upload.version }
      : { ok: false, status: 409, code: 'version_already_published', publishedVersion: upload.version,
          error: `Version ${upload.version} is already published with different contents. Bump the version in manifest.json and rebuild — the same version must never mean two different packages.` };
  }
  return { ok: true, kind: sameVersion.length ? 'republish' : 'new' };
}

// ── Writing ──────────────────────────────────────────────────────────────────────────
function atomicWrite(dest, buf) {
  const tmp = `${dest}.tmp-${process.pid}-${Date.now()}`;
  fs.writeFileSync(tmp, buf);
  fs.renameSync(tmp, dest);
}

/**
 * Write the ZIP to EVERY download dir or to none. Each copy is staged, read back and
 * hash-checked before any is swapped in; the swapped-in files are hash-checked again.
 * On any failure the previous files are restored. Returns `rollback()` so the caller can
 * undo the publish if a later step (DB row, public check) fails.
 */
function publishExtensionZip(buf) {
  const want = sha256(buf);
  const dirs = targetDirs();
  if (!dirs.length) throw new ReleaseError(500, 'no_download_dirs', 'No extension download folder is configured.');
  const staged = [];
  const rollback = () => {
    const failed = [];
    for (const s of staged) {
      try {
        if (s.tmp && fs.existsSync(s.tmp)) fs.unlinkSync(s.tmp);
        if (!s.committed) continue;
        if (s.prev) atomicWrite(s.dest, s.prev);
        else if (fs.existsSync(s.dest)) fs.unlinkSync(s.dest);
      } catch (_) { failed.push(s.dest); }
    }
    _artifactCache.clear();
    return failed;
  };
  try {
    for (const dir of dirs) {
      if (!fs.existsSync(dir)) throw new ReleaseError(500, 'download_dir_missing', `Download folder is missing: ${dir}`);
      const dest = path.join(dir, ZIP_FILENAME);
      const s = { dir, dest, tmp: path.join(dir, `.${ZIP_FILENAME}.tmp-${process.pid}-${Date.now()}`), committed: false,
                  prev: fs.existsSync(dest) ? fs.readFileSync(dest) : null };
      staged.push(s);
      fs.writeFileSync(s.tmp, buf);
      if (sha256(fs.readFileSync(s.tmp)) !== want) throw new ReleaseError(500, 'staged_copy_corrupt', `Staged copy did not verify in ${dir}`);
    }
    for (const s of staged) { fs.renameSync(s.tmp, s.dest); s.tmp = null; s.committed = true; }
    for (const s of staged) {
      if (sha256(fs.readFileSync(s.dest)) !== want) throw new ReleaseError(500, 'written_copy_mismatch', `Published copy did not verify in ${s.dir}`);
    }
  } catch (err) {
    rollback();
    if (err instanceof ReleaseError) throw err;
    throw new ReleaseError(500, 'publish_write_failed', `Could not write the extension to every download folder (${err.code || err.message}). The previous release was kept.`);
  }
  _artifactCache.clear();
  return { written: staged.map(s => s.dest), sha256: want, size: buf.length, rollback };
}


/**
 * Fetch the public download URL on each origin and compare its SHA-256 with the published
 * bytes. A definite mismatch means the docroots written are not the ones the site serves.
 * Network trouble is reported as 'unreachable', never as success. A hard deadline wraps the
 * fetch because an outbound request on this host has been seen to never settle.
 */
async function verifyPublicDownloads(expectedSha, { origins = publicOrigins(), fetchImpl = globalThis.fetch, timeoutMs = 15000 } = {}) {
  const results = [];
  for (const origin of origins) {
    const url = `${origin}/downloads/${ZIP_FILENAME}?publish-verify=${expectedSha.slice(0, 12)}&t=${Date.now()}`;
    let timer;
    try {
      const ctrl = new AbortController();
      const deadline = new Promise((_, rej) => { timer = setTimeout(() => { ctrl.abort(); rej(new Error('timeout')); }, timeoutMs); });
      const res = await Promise.race([fetchImpl(url, { signal: ctrl.signal, headers: { 'Cache-Control': 'no-cache' } }), deadline]);
      if (!res.ok) { results.push({ origin, status: 'mismatch', httpStatus: res.status }); continue; }
      const body = Buffer.from(await Promise.race([res.arrayBuffer(), deadline]));
      const got = sha256(body);
      results.push({ origin, status: got === expectedSha ? 'match' : 'mismatch', httpStatus: res.status, sha256: got, size: body.length });
    } catch (err) {
      results.push({ origin, status: 'unreachable', error: String(err.message || err) });
    } finally { clearTimeout(timer); }
  }
  return results;
}

// ── Serialising publishes ────────────────────────────────────────────────────────────
// Passenger runs several workers, so an in-memory mutex is not enough: a lock file
// serialises uploads across processes. A crashed holder's lock goes stale after 2 minutes.
const LOCK_STALE_MS = 2 * 60 * 1000;
function lockPath() { return path.join(process.env.EXTENSION_PUBLISH_LOCK_DIR || os.tmpdir(), 'genz-extension-publish.lock'); }

async function withPublishLock(fn) {
  const p = lockPath();
  let fd;
  try { fd = fs.openSync(p, 'wx'); } catch (err) {
    if (err.code !== 'EEXIST') throw err;
    let stale = false;
    try { stale = Date.now() - fs.statSync(p).mtimeMs > LOCK_STALE_MS; } catch (_) { stale = true; }
    if (!stale) throw new ReleaseError(409, 'publish_in_progress', 'Another extension publish is in progress. Wait for it to finish, then reload this page.');
    try { fs.unlinkSync(p); } catch (_) {}
    fd = fs.openSync(p, 'wx');
  }
  try {
    fs.writeSync(fd, String(process.pid));
    return await fn();
  } finally {
    try { fs.closeSync(fd); } catch (_) {}
    try { fs.unlinkSync(p); } catch (_) {}
  }
}

module.exports = {
  ZIP_FILENAME, DEFAULT_DIRS, DEFAULT_PUBLIC_ORIGINS,
  targetDirs, publicOrigins, versionedFilename, versionFromFilename, sha256,
  readServedArtifacts, resolveServedRelease, readDiskExtensionVersion, resolvePublishedRelease,
  validateExtensionPackage, decidePublish, publishExtensionZip,
  verifyPublicDownloads, withPublishLock, ReleaseError,
};
