'use strict';
const crypto = require('crypto');
const { createModel } = require('../db/mysqlAdapter');

function sha256(v) { return crypto.createHash('sha256').update(String(v || '')).digest('hex'); }

/**
 * DeviceProfile — groups a client's browsers by PHYSICAL SYSTEM.
 *
 *   deviceGroupId / deviceFingerprintHash : hash of OS + screen + timezone + CPU
 *       cores → identifies the machine across browsers (best-effort; no hardware
 *       ID access in a browser).
 *   browserInstanceIds : hashed per-browser ids seen under this system.
 *   status : approved | pending | blocked.
 *
 * Hybrid policy (admin-chosen):
 *   • a client's FIRST device auto-approves (no lockout for existing users),
 *   • same system + a new browser → allowed under the same approved profile,
 *   • a genuinely NEW system → pending (blocked until an admin approves).
 *
 * Privacy: stores ONLY safe metadata — never cookies, passwords, history, or tabs.
 */
const DeviceProfile = createModel('DeviceProfile', {
  statics: {
    sha256,

    /**
     * Resolve a device for a client and apply the hybrid policy.
     * @param {object} client  User doc (needs _id, email)
     * @param {object} info    { fingerprint, browserInstanceId, os, browser, extensionVersion, ip, userAgent }
     * @returns {{status:'approved'|'pending'|'blocked', profile, isNew?, firstDevice?, reason?}}
     */
    async resolve(client, info = {}) {
      const clientId = client._id || client;
      const fp = info.fingerprint ? sha256(info.fingerprint) : null;
      const browserInstanceId = info.browserInstanceId ? sha256(info.browserInstanceId) : null;
      const now = new Date();

      // No usable fingerprint → cannot group; do NOT break login (allow).
      if (!fp) return { status: 'approved', profile: null, reason: 'no_fingerprint' };

      const profiles = await this.find({ clientId });

      // First device for this client → auto-approve.
      if (!profiles || profiles.length === 0) {
        const profile = await this.create({
          clientId,
          clientEmail: client.email || null,
          deviceGroupId: fp,
          deviceFingerprintHash: fp,
          browserInstanceIds: browserInstanceId ? [browserInstanceId] : [],
          os: info.os || null,
          browser: info.browser || null,
          extensionVersion: info.extensionVersion || null,
          status: 'approved',
          firstDevice: true,
          lastSeenAt: now,
        });
        return { status: 'approved', profile, isNew: true, firstDevice: true };
      }

      const match = profiles.find(p => p.deviceGroupId === fp);
      if (match) {
        if (match.status === 'blocked') return { status: 'blocked', profile: match };
        if (match.status === 'pending') return { status: 'pending', profile: match };
        // Approved → same physical system. Record a new browser instance, refresh meta.
        match.browserInstanceIds = Array.isArray(match.browserInstanceIds) ? match.browserInstanceIds : [];
        if (browserInstanceId && !match.browserInstanceIds.includes(browserInstanceId)) {
          match.browserInstanceIds.push(browserInstanceId);
        }
        if (info.browser) match.browser = info.browser;
        if (info.os && !match.os) match.os = info.os;
        if (info.extensionVersion) match.extensionVersion = info.extensionVersion;
        match.clientEmail = match.clientEmail || client.email || null;
        match.lastSeenAt = now;
        await match.save();
        return { status: 'approved', profile: match };
      }

      // New/different physical system → pending admin approval.
      const profile = await this.create({
        clientId,
        clientEmail: client.email || null,
        deviceGroupId: fp,
        deviceFingerprintHash: fp,
        browserInstanceIds: browserInstanceId ? [browserInstanceId] : [],
        os: info.os || null,
        browser: info.browser || null,
        extensionVersion: info.extensionVersion || null,
        status: 'pending',
        lastSeenAt: now,
      });
      return { status: 'pending', profile, isNew: true };
    },
  },
});

module.exports = DeviceProfile;
