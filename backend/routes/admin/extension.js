'use strict';
const express = require('express');
const crypto = require('crypto');
const router = express.Router();
const { requireAuth } = require('../../middleware/authEnhanced');
const ActivityLog = require('../../models/ActivityLog');
const ExtensionRelease = require('../../models/ExtensionRelease');
const { readManifestFromZip } = require('../../utils/zipManifest');
const { writeExtensionZip, ZIP_FILENAME } = require('../../utils/extensionDownloads');
const { isValidVersion, compareVersions } = require('../../utils/semver');

// Admin auth — same pattern as the other admin routers.
router.use(requireAuth);
router.use((req, res, next) => {
  const adminRoles = ['SUPER_ADMIN', 'ADMIN', 'SUPPORT'];
  if (!req.user || !adminRoles.includes(req.user.role)) {
    return res.status(403).json({ error: 'Insufficient permissions' });
  }
  next();
});

// GET /api/crm/admin/extension/release — current published release + min version.
router.get('/release', async (req, res) => {
  try {
    const rel = await ExtensionRelease.getLatest();
    res.json({
      success: true,
      release: rel ? {
        version: rel.version,
        minVersion: rel.minVersion || null,
        filename: rel.filename || ZIP_FILENAME,
        size: rel.size || 0,
        manifestName: rel.manifestName || null,
        publishedAt: rel.publishedAt || null,
      } : null,
      downloadPath: `/downloads/${ZIP_FILENAME}`,
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

// PUT /api/crm/admin/extension/min-version — set/clear forced-update floor.
router.put('/min-version', express.json({ limit: '10kb' }), async (req, res) => {
  try {
    const { minVersion } = req.body || {};
    if (minVersion != null && minVersion !== '' && !isValidVersion(minVersion)) {
      return res.status(400).json({ error: 'minVersion is not a valid version' });
    }
    const latest = await ExtensionRelease.getLatest();
    if (!latest) return res.status(409).json({ error: 'No extension uploaded yet' });
    if (minVersion && compareVersions(minVersion, latest.version) > 0) {
      return res.status(400).json({ error: 'minVersion cannot be greater than the published version' });
    }
    const doc = await ExtensionRelease.setMinVersion(minVersion, req.userId || (req.user && req.user._id));
    await ActivityLog.log('ADMIN', req.userId || (req.user && req.user._id), 'EXTENSION_MIN_VERSION_SET', {
      minVersion: doc.minVersion || null,
      version: doc.version,
    });
    res.json({ success: true, version: doc.version, minVersion: doc.minVersion || null });
  } catch (err) {
    console.error('Set min version error:', err.message);
    res.status(500).json({ error: 'Failed to set minimum version' });
  }
});

module.exports = router;
