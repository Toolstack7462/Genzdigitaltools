'use strict';
const express = require('express');
const router = express.Router();
const { requireAuth } = require('../../middleware/authEnhanced');
const ActivityLog = require('../../models/ActivityLog');
const ExtensionRelease = require('../../models/ExtensionRelease');
const User = require('../../models/User');
const {
  ZIP_FILENAME, versionedFilename, resolvePublishedRelease, resolveServedRelease,
  validateExtensionPackage, decidePublish, publishExtensionZip, verifyPublicDownloads,
  withPublishLock, ReleaseError, versionFromFilename,
} = require('../../utils/extensionDownloads');
const { isValidChromeVersion, compareVersions, isOlder } = require('../../utils/semver');

// The PUBLISHED version is resolved in ONE place — resolvePublishedRelease() — from the artifact
// actually being served (the DB row is only a fallback when nothing is readable on disk). /release
// (what the admin sees), the save-policy ceiling, /notify, the client version-info and the
// heartbeat all use it, so none of them can advertise a version the download does not contain.
// (Earlier code took the NEWER of disk and DB, which let a DB row announce 3.9.29 while the
// download still served 3.9.25.)

// Admin auth — same pattern as the other admin routers.
router.use(requireAuth);
router.use((req, res, next) => {
  const adminRoles = ['SUPER_ADMIN', 'ADMIN', 'SUPPORT'];
  if (!req.user || !adminRoles.includes(req.user.role)) {
    return res.status(403).json({ error: 'Insufficient permissions' });
  }
  next();
});

// ── Server-side list controls (pagination / filter / search / sort) ──────────
// STRICT allowlists — no user-supplied value is ever passed to the DB as a field
// name, operator, or query fragment. status/sortBy/sortOrder are enum-checked;
// page/limit are integer-coerced and range-clamped; search is length-capped and
// used ONLY as a case-insensitive substring compare in JS (never a DB $regex), so
// there is no SQL / NoSQL / regex / operator-injection surface. Status is computed
// server-side from trusted version data (isOlder) — the SAME logic /notify uses —
// so a client can never alter its reported status to change filtering or who gets
// notified.
const PAGE_SIZES = [10, 25, 50, 100];            // allowlisted page sizes (hard max 100)
const SORT_FIELDS = ['name', 'installedVersion', 'status', 'lastSync'];
const STATUS_FILTERS = ['all', 'updated', 'outdated', 'unknown'];
const STATUS_RANK = { outdated: 0, up_to_date: 1, unknown: 2 };
const SEARCH_MAX = 100;                            // cap search length (DoS + noise guard)

function parseListParams(q) {
  q = q || {};
  let page = parseInt(q.page, 10);
  if (!Number.isFinite(page) || page < 1) page = 1;
  let limit = parseInt(q.limit, 10);
  if (!PAGE_SIZES.includes(limit)) limit = 25;     // default 25; rejects 0 / 999999 / missing / junk
  const status = STATUS_FILTERS.includes(String(q.status)) ? String(q.status) : 'all';
  const sortBy = SORT_FIELDS.includes(String(q.sortBy)) ? String(q.sortBy) : 'lastSync';
  const sortOrder = String(q.sortOrder) === 'asc' ? 'asc' : 'desc';
  const search = String(q.search == null ? '' : q.search).trim().slice(0, SEARCH_MAX).toLowerCase();
  return { page, limit, status, sortBy, sortOrder, search };
}

// Build the full trusted per-client DTO set (only clients that have synced at least
// once). Status is computed here from the effective published version — the single
// source of truth shared with /notify. Never emits secrets (select() is field-scoped).
async function buildClientDtos(latest, effectiveMin) {
  const users = await User.find({ role: 'CLIENT' })
    .select('email fullName extensionVersion extensionLastSyncAt extensionUpdateNotice');
  return (users || [])
    .filter(u => u.extensionVersion || u.extensionLastSyncAt)
    .map(u => {
      const installed = u.extensionVersion || null;
      const notice = u.extensionUpdateNotice || null;
      const isOutdated = !!(latest && installed && isOlder(installed, latest));
      return {
        clientId: String(u._id),
        email: u.email || null,
        name: u.fullName || null,
        installedVersion: installed,
        lastSyncAt: u.extensionLastSyncAt || null,
        isOutdated,
        updateRequired: !!(effectiveMin && installed && isOlder(installed, effectiveMin)),
        status: isOutdated ? 'outdated' : (installed ? 'up_to_date' : 'unknown'),
        notified: !!(notice && notice.notifiedAt),
        notifiedAt: notice ? (notice.notifiedAt || null) : null,
      };
    });
}

// Case-insensitive name/email substring match. Pure JS — no regex, no DB call.
function clientMatchesSearch(c, search) {
  if (!search) return true;
  return String(c.name || '').toLowerCase().includes(search)
      || String(c.email || '').toLowerCase().includes(search);
}

// GET /api/crm/admin/extension/release — latest version (from the on-disk ZIP),
// admin policy, and a PAGE of per-client installed versions for admin visibility.
// Backward compatible: the top-level release fields are unchanged and `clients` is
// still an array (now the requested page). New optional query params: page, limit,
// status, search, sortBy, sortOrder. New response fields: `pagination` + `counts`.
router.get('/release', async (req, res) => {
  try {
    const rel = await ExtensionRelease.getLatest();
    const pub = resolvePublishedRelease(rel);
    const { latest, dbVersion, diskVersion, minVersion, effectiveMin } = pub;
    const forceUpdate = pub.forceUpdate;

    const { page, limit, status, sortBy, sortOrder, search } = parseListParams(req.query);

    // Server-side filter → count → sort → paginate. The browser only ever receives one
    // page + metadata, never the full list.
    let clients = [];
    let counts = { all: 0, updated: 0, outdated: 0, unknown: 0 };
    let totalRecords = 0, totalPages = 1, currentPage = page;
    try {
      const allDtos = await buildClientDtos(latest, effectiveMin);
      const searched = allDtos.filter(c => clientMatchesSearch(c, search));

      // Counts reflect the active SEARCH (independent of the selected status tab) so the
      // filter badges stay accurate as the admin types.
      counts.all = searched.length;
      for (const c of searched) {
        if (c.status === 'up_to_date') counts.updated++;
        else if (c.status === 'outdated') counts.outdated++;
        else counts.unknown++;
      }

      let filtered = searched;
      if (status === 'updated') filtered = searched.filter(c => c.status === 'up_to_date');
      else if (status === 'outdated') filtered = searched.filter(c => c.status === 'outdated');
      else if (status === 'unknown') filtered = searched.filter(c => c.status === 'unknown');

      const dir = sortOrder === 'asc' ? 1 : -1;
      filtered.sort((a, b) => {
        let cmp;
        if (sortBy === 'name') {
          cmp = String(a.name || a.email || '').localeCompare(String(b.name || b.email || ''), undefined, { sensitivity: 'base' });
        } else if (sortBy === 'installedVersion') {
          cmp = compareVersions(a.installedVersion, b.installedVersion); // semver-aware (never throws)
        } else if (sortBy === 'status') {
          cmp = (STATUS_RANK[a.status] ?? 3) - (STATUS_RANK[b.status] ?? 3);
        } else { // lastSync (default)
          cmp = new Date(a.lastSyncAt || 0) - new Date(b.lastSyncAt || 0);
        }
        return cmp * dir;
      });

      totalRecords = filtered.length;
      totalPages = Math.max(1, Math.ceil(totalRecords / limit));
      currentPage = Math.min(page, totalPages);            // clamp huge page numbers to the last page
      const start = (currentPage - 1) * limit;
      clients = filtered.slice(start, start + limit);
    } catch (_) {}

    res.json({
      success: true,
      latestVersion: latest,
      minimumRequiredVersion: minVersion,
      effectiveMinimum: effectiveMin,
      updateRequired: forceUpdate,
      filename: versionedFilename(latest),
      stableFilename: ZIP_FILENAME,
      size: pub.size || 0,
      sha256: pub.sha256 || null,
      uploadedAt: rel ? (rel.publishedAt || null) : null,
      diskVersion,
      dbVersion,
      // Every download folder serves the same bytes, and the DB row describes them. When either
      // is false the panel warns: clients are offered `latestVersion` (the oldest served copy).
      servedConsistent: pub.servedConsistent,
      metadataMatchesArtifact: pub.metadataMatchesArtifact,
      servedArtifacts: pub.artifacts.map(a => ({ dir: a.dir, version: a.version, sha256: a.sha256, size: a.size, mtime: a.mtime || null, error: a.error || null })),
      downloadPath: `/downloads/${ZIP_FILENAME}`,
      clients,
      counts,
      pagination: { currentPage, pageSize: limit, totalRecords, totalPages },
    });
  } catch (err) {
    console.error('Get extension release error:', err.message);
    res.status(500).json({ error: 'Failed to read release' });
  }
});

// POST /api/crm/admin/extension/upload — publish a new extension release.
// Body = raw zip bytes (Content-Type application/zip). Query (all optional):
//   minVersion=x.y.z      admin-controlled forced-update floor
//   filename=<name>       the chosen file's name; a "-v<version>" in it must match the manifest
//   expectedVersion=x.y.z explicit version the admin intends to publish (same check)
//   allowDowngrade=1      deliberate rollback / replacement of an already-published version
//
// Order (each step must pass before the next; any failure restores the previous release):
//   1. validate the package itself (integrity, root manifest, Chrome version, referenced files,
//      unchanged extension key, version matches what the admin selected)
//   2. under a cross-process lock, decide against what is CURRENTLY served (no stale publish)
//   3. write ALL download folders (staged, hash-verified, swapped in, re-verified)
//   4. fetch the public download URLs and require the same SHA-256 (proves the folders written
//      are the ones clients download from — the 2026-10 incident)
//   5. only then record the release row the version endpoints read
router.post('/upload',
  express.raw({ type: ['application/zip', 'application/x-zip-compressed', 'application/x-zip', 'application/octet-stream'], limit: '40mb' }),
  async (req, res) => {
    const fail = (err) => res.status(err.status || 500).json({ error: err.message, code: err.code, ...(err.extra || {}) });
    try {
      const buf = req.body;
      if (!Buffer.isBuffer(buf) || buf.length === 0) {
        return res.status(400).json({ error: 'No ZIP uploaded. POST the .zip with Content-Type application/zip.' });
      }

      const explicit = req.query.expectedVersion != null && req.query.expectedVersion !== '' ? String(req.query.expectedVersion) : null;
      if (explicit && !isValidChromeVersion(explicit)) {
        return res.status(400).json({ error: 'expectedVersion is not a valid Chrome extension version', code: 'invalid_expected_version' });
      }
      const expectedVersion = explicit || versionFromFilename(req.query.filename);

      let pkg;
      try {
        pkg = validateExtensionPackage(buf, { expectedVersion, currentKey: resolveServedRelease().key });
      } catch (e) {
        if (e instanceof ReleaseError) return fail(e);
        throw e;
      }

      // Optional minimum-required version (admin-controlled forced-update floor).
      const minVersion = req.query.minVersion != null ? String(req.query.minVersion) : undefined;
      if (minVersion !== undefined && minVersion !== '' && !isValidChromeVersion(minVersion)) {
        return res.status(400).json({ error: 'minVersion is not a valid version', code: 'invalid_min_version' });
      }
      // A min version must never exceed the version we are publishing.
      if (minVersion && compareVersions(minVersion, pkg.version) > 0) {
        return res.status(400).json({ error: 'minVersion cannot be greater than the uploaded version', code: 'min_version_too_high' });
      }

      const allowDowngrade = /^(1|true|yes)$/i.test(String(req.query.allowDowngrade || ''));
      const adminId = req.userId || (req.user && req.user._id) || null;

      const { decision, written, publicCheck, doc } = await withPublishLock(async () => {
        // Decide against the state INSIDE the lock, so a publish that queued behind a newer one
        // cannot overwrite it.
        const relNow = await ExtensionRelease.getLatest();
        const decision = decidePublish(
          { version: pkg.version, sha256: pkg.sha256 },
          { artifacts: resolveServedRelease().artifacts, dbVersion: relNow ? relNow.version : null, dbSha256: relNow ? relNow.sha256 : null },
          allowDowngrade,
        );
        if (!decision.ok) {
          throw new ReleaseError(decision.status, decision.code, decision.error, { uploadedVersion: pkg.version, publishedVersion: decision.publishedVersion });
        }

        const written = publishExtensionZip(buf);

        const publicCheck = await verifyPublicDownloads(written.sha256);
        const wrong = publicCheck.filter(r => r.status === 'mismatch');
        if (wrong.length) {
          const rollbackFailed = written.rollback();
          throw new ReleaseError(502, 'served_artifact_mismatch',
            `The ZIP was written but ${wrong.map(r => r.origin).join(', ')} still served a different file, so the release was rolled back and nothing changed for clients. The download folders configured on the server are not the ones the site serves.`,
            { publicCheck, rollbackFailed });
        }

        let doc;
        try {
          doc = await ExtensionRelease.publish({
            version: pkg.version,
            minVersion,
            filename: ZIP_FILENAME,
            size: written.size,
            sha256: written.sha256,
            manifestName: pkg.name,
            publishedBy: adminId,
          });
        } catch (dbErr) {
          const rollbackFailed = written.rollback();
          console.error('Extension release row write failed; files rolled back:', dbErr.message, rollbackFailed);
          throw new ReleaseError(500, 'release_record_failed', 'The release could not be recorded, so the previous release was restored.');
        }
        return { decision, written, publicCheck, doc };
      });

      const rollback = decision.kind === 'rollback' || decision.kind === 'replace';
      await ActivityLog.log('ADMIN', adminId, 'EXTENSION_RELEASE_PUBLISHED', {
        version: pkg.version,
        minVersion: doc.minVersion || null,
        sizeBytes: written.size,
        sha256: written.sha256,
        foldersWritten: written.written.length,
        publicCheck: publicCheck.map(r => `${r.origin}:${r.status}`).join(' ') || 'not_configured',
        // Records a deliberate rollback so an intentional downgrade is distinguishable
        // from a normal release when reading the audit trail later.
        rollback: rollback || undefined,
        replacedVersion: rollback ? decision.replacedVersion : undefined,
      });

      res.json({
        success: true,
        version: pkg.version,
        minVersion: doc.minVersion || null,
        size: written.size,
        sha256: written.sha256,
        filename: ZIP_FILENAME,
        foldersWritten: written.written.length,
        written: written.written,
        skipped: [],
        publication: decision.kind,
        // 'unreachable' entries mean the public URL could not be checked — not that it matched.
        publicCheck,
        downloadPath: `/downloads/${ZIP_FILENAME}`,
      });
    } catch (err) {
      if (err instanceof ReleaseError) return fail(err);
      console.error('Extension upload error:', err.message);
      res.status(500).json({ error: 'Extension upload failed' });
    }
  }
);

// PUT /api/crm/admin/extension/policy — set the forced-update policy.
// Body: { minVersion?, updateRequired? }. Works even if no ZIP was uploaded via
// the endpoint (auto-creates the release row from the on-disk ZIP version).
async function handleSetPolicy(req, res) {
  try {
    const body = req.body || {};
    const minVersion = body.minVersion;
    const updateRequired = body.updateRequired;
    if (minVersion != null && minVersion !== '' && !isValidChromeVersion(String(minVersion))) {
      return res.status(400).json({ error: 'minVersion is not a valid version' });
    }

    // Ensure a release row exists — seed from the on-disk ZIP if needed.
    let latest = await ExtensionRelease.getLatest();
    if (!latest) {
      const seedVersion = resolveServedRelease().version;
      if (!seedVersion) return res.status(409).json({ error: 'No extension ZIP available yet' });
      latest = await ExtensionRelease.publish({
        version: seedVersion, filename: ZIP_FILENAME, size: 0,
        manifestName: 'auto (from existing download)',
        publishedBy: req.userId || (req.user && req.user._id) || null,
      });
    }
    // Validate against the published version clients can actually download — the same value
    // /release shows the admin — so a minimum can never require an unavailable package.
    const publishedVersion = resolvePublishedRelease(latest).latest;
    if (minVersion && publishedVersion && compareVersions(minVersion, publishedVersion) > 0) {
      return res.status(400).json({ error: 'minVersion cannot be greater than the published version', code: 'min_version_too_high' });
    }

    const doc = await ExtensionRelease.setPolicy({ minVersion, updateRequired }, req.userId || (req.user && req.user._id));
    await ActivityLog.log('ADMIN', req.userId || (req.user && req.user._id), 'EXTENSION_POLICY_SET', {
      version: doc.version,
      minVersion: doc.minVersion || null,
      updateRequired: !!doc.updateRequired,
    });
    res.json({ success: true, version: doc.version, minVersion: doc.minVersion || null, updateRequired: !!doc.updateRequired });
  } catch (err) {
    console.error('Set extension policy error:', err.message);
    res.status(500).json({ error: 'Failed to set policy' });
  }
}

router.put('/policy', express.json({ limit: '10kb' }), handleSetPolicy);
// Backward-compatible alias (minVersion only).
router.put('/min-version', express.json({ limit: '10kb' }), handleSetPolicy);

// Per-client debounce window: an admin cannot re-notify the same client within
// this window (prevents notification spam). The client still keeps seeing the
// existing update banner in the meantime — this only throttles re-flagging.
const NOTIFY_DEBOUNCE_MS = 10 * 60 * 1000; // 10 minutes
const NOTIFY_MESSAGE = 'Admin has requested you to update your Gen Z Digital Store extension to the latest version.';

// POST /api/crm/admin/extension/notify — flag outdated clients to update their
// extension. Body: { clientIds?: string[], all?: boolean }. Only clients whose
// installed version is older than the latest published version are notified;
// up-to-date clients are skipped. A per-client 10-minute debounce prevents spam.
// Writes a safe metadata flag onto the client record (no secrets) which the
// client dashboard + extension popup read to show the existing update banner.
router.post('/notify', express.json({ limit: '64kb' }), async (req, res) => {
  try {
    const body = req.body || {};
    const all = !!body.all;
    let clientIds = Array.isArray(body.clientIds)
      ? body.clientIds.filter(id => typeof id === 'string' && /^[a-f\d]{24}$/i.test(id))
      : [];
    if (!all && clientIds.length === 0) {
      return res.status(400).json({ error: 'Provide clientIds[] or all:true' });
    }
    if (clientIds.length > 1000) clientIds = clientIds.slice(0, 1000);
    // Optional name/email search — scopes "Notify all outdated" to the SAME set the admin is
    // viewing (their active search). Pure JS substring compare (no regex/DB injection). Only
    // applies to the all:true path; explicit clientIds[] are already an exact, validated set.
    const search = String(body.search == null ? '' : body.search).trim().slice(0, 100).toLowerCase();

    // Resolve latest + effective minimum from the SAME source as /release.
    const rel = await ExtensionRelease.getLatest();
    const { latest, effectiveMin } = resolvePublishedRelease(rel);
    if (!latest) return res.status(409).json({ error: 'No published extension version yet' });

    const query = { role: 'CLIENT' };
    if (!all) query._id = { $in: clientIds };
    let users = await User.find(query)
      .select('email fullName extensionVersion extensionUpdateNotice');
    if (all && search) {
      users = users.filter(u =>
        String(u.fullName || '').toLowerCase().includes(search) ||
        String(u.email || '').toLowerCase().includes(search));
    }

    const now = Date.now();
    const adminId = req.userId || (req.user && req.user._id) || null;
    let notified = 0, skippedUpToDate = 0, debounced = 0, skippedNoVersion = 0;
    const notifiedClients = [];

    for (const u of users) {
      const installed = u.extensionVersion || null;
      if (!installed) { skippedNoVersion++; continue; }          // never synced — nothing to compare
      if (!isOlder(installed, latest)) { skippedUpToDate++; continue; } // already current
      const prev = u.extensionUpdateNotice || null;
      if (prev && prev.notifiedAt && (now - new Date(prev.notifiedAt).getTime()) < NOTIFY_DEBOUNCE_MS) {
        debounced++; continue;
      }
      const mandatory = !!(effectiveMin && isOlder(installed, effectiveMin));
      const notice = {
        notifiedAt: new Date(),
        notifiedBy: adminId ? String(adminId) : null,
        latestVersion: latest,
        installedVersion: installed,
        mandatory,
        message: NOTIFY_MESSAGE,
      };
      try {
        await User.findByIdAndUpdate(u._id, { $set: { extensionUpdateNotice: notice } });
        notified++;
        notifiedClients.push(String(u._id));
      } catch (_) { /* skip this client, continue with the rest */ }
    }

    await ActivityLog.log('ADMIN', adminId, 'EXTENSION_UPDATE_NOTIFIED', {
      scope: all ? 'all_outdated' : 'selected',
      requested: all ? null : clientIds.length,
      notified, skippedUpToDate, debounced, skippedNoVersion,
      latestVersion: latest,
    });

    res.json({
      success: true,
      latestVersion: latest,
      notified,
      skippedUpToDate,
      debounced,
      skippedNoVersion,
      notifiedClients,
    });
  } catch (err) {
    console.error('Extension notify error:', err.message);
    res.status(500).json({ error: 'Failed to send update notifications' });
  }
});

module.exports = router;
