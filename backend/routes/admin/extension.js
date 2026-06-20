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
        .select('email fullName extensionVersion extensionLastSyncAt');
      clients = (users || [])
        .filter(u => u.extensionVersion || u.extensionLastSyncAt)
        .map(u => {
          const installed = u.extensionVersion || null;
          return {
            clientId: String(u._id),
            email: u.email || null,
            name: u.fullName || null,
            installedVersion: installed,
            lastSyncAt: u.extensionLastSyncAt || null,
            isOutdated: !!(latest && installed && isOlder(installed, latest)),
            updateRequired: !!(effectiveMin && installed && isOlder(installed, effectiveMin)),
            status: (latest && installed && isOlder(installed, latest)) ? 'outdated' : (installed ? 'up_to_date' : 'unknown'),
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

module.exports = router;
