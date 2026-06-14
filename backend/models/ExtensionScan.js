'use strict';
const { createModel } = require('../db/mysqlAdapter');

/**
 * ExtensionScan — latest browser-extension security scan reported by a client's
 * Gen Z extension. ONE record per client (upserted on each scan).
 *
 * Privacy: stores ONLY safe metadata — client email/name (from the user record),
 * device-id hash, extension version, last sync time, scanner status, and the list
 * of installed extensions with risk levels. NEVER cookie values, tokens,
 * passwords, browsing history, or tab content.
 *
 * Schema-less JSON document (mysqlAdapter). Expected shape:
 *   {
 *     clientId, clientEmail, clientName,
 *     deviceIdHash, extensionVersion, lastSync, scannedAt,
 *     scannerStatus,                       // enabled | disabled | permission_missing
 *     counts: { total, risky, high, medium, low },
 *     extensions: [ { extId, extName, version, enabled, type, permissionsSummary, riskLevel } ]
 *   }
 */
const ExtensionScan = createModel('ExtensionScan', {
  statics: {
    async recordScan(clientId, data = {}) {
      const update = { clientId, ...data, scannedAt: data.scannedAt || new Date() };
      // One row per client — upsert so admin always sees the latest scan.
      return this.findOneAndUpdate({ clientId }, { $set: update }, { upsert: true, new: true });
    },
  },
});

module.exports = ExtensionScan;
