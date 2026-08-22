'use strict';
const express = require('express');
const crypto = require('crypto');
const router = express.Router();
const { requireAuth } = require('../../middleware/authEnhanced');
const ActivityLog = require('../../models/ActivityLog');
const ExtensionRelease = require('../../models/ExtensionRelease');
const User = require('../../models/User');
const { readManifestFromZip } = require('../../utils/zipManifest');
const { writeExtensionZip, ZIP_FILENAME, readDiskExtensionVersion, versionedFilename } = require('../../utils/extensionDownloads');
const { isValidVersion, compareVersions, isOlder, maxVersion } = require('../../utils/semver');

// The effective PUBLISHED version = the newer of the on-disk ZIP and the DB release row. A freshly
// deployed ZIP can be newer than the last DB publish row, so BOTH must be considered. This is the
// SINGLE source of truth for "published version" — /release (what the admin sees), the save-policy
// ceiling, and the notify route all use it, so they can never disagree (the root cause of the
// "minVersion cannot be greater than the published version" false error). Disk wins ties, matching
// /release's original preference.
function effectiveLatest(dbVersion, diskVersion) {
  return maxVersion(diskVersion, dbVersion);
}

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
    const diskVersion = readDiskExtensionVersion();
    const dbVersion = rel ? rel.version : null;
    const latest = effectiveLatest(dbVersion, diskVersion);
    const minVersion = rel ? (rel.minVersion || null) : null;
    const forceUpdate = rel ? !!rel.updateRequired : false;
    const effectiveMin = minVersion || (forceUpdate ? latest : null);

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
      size: rel ? (rel.size || 0) : 0,
      uploadedAt: rel ? (rel.publishedAt || null) : null,
      diskVersion,
      dbVersion,
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

// POST /api/crm/admin/extension/upload — upload/replace the latest extension ZIP.
// Body = raw zip bytes (Content-Type application/zip). Optional ?minVersion=x.y.z
// The ZIP is written into the EXISTING download folders (no new download flow);
// the version is read from the ZIP's own manifest.json. Never logs secrets.
router.post('/upload',
  express.raw({ type: ['application/zip', 'application/x-zip-compressed', 'application/x-zip', 'application/octet-stream'], limit: '40mb' }),
  async (req, res) => {
    try {
      const buf = req.body;
      if (!Buffer.isBuffer(buf) || buf.length === 0) {
        return res.status(400).json({ error: 'No ZIP uploaded. POST the .zip with Content-Type application/zip.' });
      }

      // Read the version straight from the uploaded ZIP's manifest.json.
      let manifest;
      try {
        manifest = readManifestFromZip(buf);
      } catch (e) {
        return res.status(422).json({ error: 'Could not read manifest.json from the ZIP', code: String(e.message || 'manifest_read_failed') });
      }
      if (!manifest.version || !isValidVersion(manifest.version)) {
        return res.status(422).json({ error: 'manifest.json has no valid "version"', code: 'invalid_manifest_version' });
      }

      // Optional minimum-required version (admin-controlled forced-update floor).
      let minVersion = req.query.minVersion != null ? String(req.query.minVersion) : undefined;
      if (minVersion !== undefined && minVersion !== '' && !isValidVersion(minVersion)) {
        return res.status(400).json({ error: 'minVersion is not a valid version', code: 'invalid_min_version' });
      }
      // A min version must never exceed the version we are publishing.
      if (minVersion && compareVersions(minVersion, manifest.version) > 0) {
        return res.status(400).json({ error: 'minVersion cannot be greater than the uploaded version', code: 'min_version_too_high' });
      }

      // ── Accidental-downgrade guard ────────────────────────────────────────────
      // Publishing is a straight overwrite of the served ZIP, so uploading an older build
      // silently replaces a newer production release and every client is offered the stale
      // extension. That is exactly how v3.9.20 came to be served while v3.9.25 was the real
      // latest. Compare against the EFFECTIVE published version (newer of the on-disk ZIP and
      // the DB row) — the same value /release shows the admin, so the block can never disagree
      // with what the panel displays.
      //
      // Deliberate rollback stays possible, but it has to be asked for explicitly
      // (?allowDowngrade=1); it is never the default, and it is recorded in the activity log.
      const allowDowngrade = /^(1|true|yes)$/i.test(String(req.query.allowDowngrade || ''));
      const relNow = await ExtensionRelease.getLatest();
      const publishedNow = effectiveLatest(relNow ? relNow.version : null, readDiskExtensionVersion());
      const downgrade = !!publishedNow && isOlder(manifest.version, publishedNow);
      if (downgrade && !allowDowngrade) {
        return res.status(409).json({
          error: `Upload blocked: version ${manifest.version} is older than currently deployed version ${publishedNow}.`,
          code: 'version_downgrade_blocked',
          uploadedVersion: manifest.version,
          publishedVersion: publishedNow,
        });
      }

      // Replace the ZIP in the EXISTING download folders.
      const { written, skipped } = writeExtensionZip(buf);
      if (!written.length) {
        return res.status(500).json({ error: 'Could not write the ZIP to any download folder', skipped });
      }

      const sha256 = crypto.createHash('sha256').update(buf).digest('hex');
      const doc = await ExtensionRelease.publish({
        version: manifest.version,
        minVersion,
        filename: ZIP_FILENAME,
        size: buf.length,
        sha256,
        manifestName: manifest.name,
        publishedBy: req.userId || (req.user && req.user._id) || null,
      });

      await ActivityLog.log('ADMIN', req.userId || (req.user && req.user._id), 'EXTENSION_RELEASE_PUBLISHED', {
        version: manifest.version,
        minVersion: doc.minVersion || null,
        sizeBytes: buf.length,
        foldersWritten: written.length,
        // Records a deliberate rollback so an intentional downgrade is distinguishable
        // from a normal release when reading the audit trail later.
        rollback: downgrade || undefined,
        replacedVersion: downgrade ? publishedNow : undefined,
      });

      res.json({
        success: true,
        version: manifest.version,
        minVersion: doc.minVersion || null,
        size: buf.length,
        filename: ZIP_FILENAME,
        foldersWritten: written.length,
        written,
        skipped,
        downloadPath: `/downloads/${ZIP_FILENAME}`,
      });
    } catch (err) {
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
    if (minVersion != null && minVersion !== '' && !isValidVersion(minVersion)) {
      return res.status(400).json({ error: 'minVersion is not a valid version' });
    }

    // Ensure a release row exists — seed from the on-disk ZIP if needed.
    let latest = await ExtensionRelease.getLatest();
    if (!latest) {
      const seedVersion = readDiskExtensionVersion();
      if (!seedVersion) return res.status(409).json({ error: 'No extension ZIP available yet' });
      latest = await ExtensionRelease.publish({
        version: seedVersion, filename: ZIP_FILENAME, size: 0,
        manifestName: 'auto (from existing download)',
        publishedBy: req.userId || (req.user && req.user._id) || null,
      });
    }
    // Validate against the EFFECTIVE published version (newer of on-disk ZIP + DB row) — the same
    // value /release shows the admin. Using latest.version (DB only) here was the root-cause bug:
    // a stale DB row older than the on-disk ZIP wrongly rejected a valid, lower minVersion.
    const publishedVersion = effectiveLatest(latest.version, readDiskExtensionVersion());
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
    const diskVersion = readDiskExtensionVersion();
    const dbVersion = rel ? rel.version : null;
    const latest = effectiveLatest(dbVersion, diskVersion);
    if (!latest) return res.status(409).json({ error: 'No published extension version yet' });
    const minVersion = rel ? (rel.minVersion || null) : null;
    const forceUpdate = rel ? !!rel.updateRequired : false;
    const effectiveMin = minVersion || (forceUpdate ? latest : null);

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
