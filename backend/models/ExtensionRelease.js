'use strict';
const { createModel } = require('../db/mysqlAdapter');

/**
 * Latest published Chrome-extension release metadata. One "current" row holds the
 * version extracted from the uploaded ZIP's manifest.json plus an optional
 * admin-set minimum-required version (for forced updates). No secrets stored.
 */
const ExtensionRelease = createModel('ExtensionRelease', {
  statics: {
    // The current/latest release = most recently published row.
    async getLatest() {
      const rows = await this.find({}).sort({ publishedAt: -1 }).limit(1);
      return (rows && rows[0]) || null;
    },

    // Publish a freshly-uploaded build as the latest. Carries forward the
    // existing minVersion unless a new one is supplied.
    async publish({ version, minVersion, filename, size, sha256, manifestName, publishedBy }) {
      const prev = await this.getLatest();
      const doc = await this.create({
        version: String(version),
        minVersion: minVersion != null && minVersion !== ''
          ? String(minVersion)
          : (prev ? prev.minVersion || null : null),
        filename: filename || 'genz-digital-store-extension.zip',
        size: size || 0,
        sha256: sha256 || null,
        manifestName: manifestName || null,
        publishedBy: publishedBy || null,
        publishedAt: new Date(),
      });
      return doc;
    },

    // Set/clear the minimum required version without re-uploading the ZIP.
    async setMinVersion(minVersion, by) {
      const latest = await this.getLatest();
      if (!latest) return null;
      latest.minVersion = minVersion != null && minVersion !== '' ? String(minVersion) : null;
      latest.minVersionUpdatedBy = by || null;
      latest.minVersionUpdatedAt = new Date();
      await latest.save();
      return latest;
    },

    // Set the forced-update policy: an explicit minimum version and/or an
    // updateRequired flag (when true with no minVersion, everyone below the
    // latest version is required to update). Either field may be omitted.
    async setPolicy({ minVersion, updateRequired }, by) {
      const latest = await this.getLatest();
      if (!latest) return null;
      if (minVersion !== undefined) {
        latest.minVersion = minVersion != null && minVersion !== '' ? String(minVersion) : null;
      }
      if (updateRequired !== undefined) {
        latest.updateRequired = !!updateRequired;
      }
      latest.policyUpdatedBy = by || null;
      latest.policyUpdatedAt = new Date();
      await latest.save();
      return latest;
    },
  },
});

module.exports = ExtensionRelease;
