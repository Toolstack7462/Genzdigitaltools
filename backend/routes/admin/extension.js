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
const { isValidVersion, compareVersions, isOlder } = require('../../utils/semver');

// Admin auth — same pattern as the other admin routers.
router.use(requireAuth);
router.use((req, res, next) => {
  const adminRoles = ['SUPER_ADMIN', 'ADMIN', 'SUPPORT'];
  if (!req.user || !adminRoles.includes(req.user.role)) {
    return res.status(403).json({ error: 'Insufficient permissions' });
  }
  next();
});

// GET /api/crm/admin/extension/release — latest version (from the on-disk ZIP),
// admin policy, and per-client installed versions for admin visibility.
router.get('/release', async (req, res) => {
  try {
    const rel = await ExtensionRelease.getLatest();
    const diskVersion = readDiskExtensionVersion();
    const dbVersion = rel ? rel.version : null;
    let latest = diskVersion || dbVersion || null;
    if (diskVersion && dbVersion && compareVersions(dbVersion, diskVersion) > 0) latest = dbVersion;
    const minVersion = rel ? (rel.minVersion || null) : null;
    const forceUpdate = rel ? !!rel.updateRequired : false;
    const effectiveMin = minVersion || (forceUpdate ? latest : null);

    // Per-client installed versions (only clients that have synced at least once).
    let clients = [];
    try {
      const users = await User.find({ role: 'CLIENT' })
        .select('email fullName extensionVersion extensionLastSyncAt extensionUpdateNotice');
      clients = (users || [])
        .filter(u => u.extensionVersion || u.extensionLastSyncAt)
        .map(u => {
          const installed = u.extensionVersion || null;
          const notice = u.extensionUpdateNotice || null;
          return {
            clientId: String(u._id),
            email: u.email || null,
            name: u.fullName || null,
            installedVersion: installed,
            lastSyncAt: u.extensionLastSyncAt || null,
            isOutdated: !!(latest && installed && isOlder(installed, latest)),
            updateRequired: !!(effectiveMin && installed && isOlder(installed, effectiveMin)),
            status: (latest && installed && isOlder(installed, latest)) ? 'outdated' : (installed ? 'up_to_date' : 'unknown'),
            // Admin-triggered "please update" notice state (safe metadata only).
            notified: !!(notice && notice.notifiedAt),
            notifiedAt: notice ? (notice.notifiedAt || null) : null,
          };
        })
        .sort((a, b) => new Date(b.lastSyncAt || 0) - new Date(a.lastSyncAt || 0));
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
      const diskVersion = readDiskExtensionVersion();
      if (!diskVersion) return res.status(409).json({ error: 'No extension ZIP available yet' });
      latest = await ExtensionRelease.publish({
        version: diskVersion, filename: ZIP_FILENAME, size: 0,
        manifestName: 'auto (from existing download)',
        publishedBy: req.userId || (req.user && req.user._id) || null,
      });
    }
    if (minVersion && compareVersions(minVersion, latest.version) > 0) {
      return res.status(400).json({ error: 'minVersion cannot be greater than the published version' });
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

    // Resolve latest + effective minimum from the SAME source as /release.
    const rel = await ExtensionRelease.getLatest();
    const diskVersion = readDiskExtensionVersion();
    const dbVersion = rel ? rel.version : null;
    let latest = diskVersion || dbVersion || null;
    if (diskVersion && dbVersion && compareVersions(dbVersion, diskVersion) > 0) latest = dbVersion;
    if (!latest) return res.status(409).json({ error: 'No published extension version yet' });
    const minVersion = rel ? (rel.minVersion || null) : null;
    const forceUpdate = rel ? !!rel.updateRequired : false;
    const effectiveMin = minVersion || (forceUpdate ? latest : null);

    const query = { role: 'CLIENT' };
    if (!all) query._id = { $in: clientIds };
    const users = await User.find(query)
      .select('email fullName extensionVersion extensionUpdateNotice');

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
