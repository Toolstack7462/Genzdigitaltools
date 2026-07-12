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

      // Fingerprint-drift resilience. The machine fingerprint (OS + screen + timezone +
      // CPU cores) can legitimately change on the SAME browser — display-scaling change,
      // an external monitor connect/disconnect, an HDR/color-depth toggle, a resolution
      // change, or a browser/ICU update that recanonicalizes the timezone string. Any of
      // those rotates deviceGroupId and, with a fingerprint-only match, would flag an
      // already-known browser as a brand-new device. The per-browser instance id (hash of
      // the browser's stable localStorage device id) survives refresh, logout/login,
      // restart and normal browser updates, and is ALREADY recorded on this browser's
      // existing profile. So if THIS browser instance is already known under one of the
      // client's profiles, honour that profile's decision instead of treating it as new.
      // A genuinely new browser has a new instance id (fresh localStorage) that is on no
      // profile, so it still falls through to pending — and a blocked profile still blocks.
      if (browserInstanceId) {
        const known = profiles.filter(p =>
          Array.isArray(p.browserInstanceIds) && p.browserInstanceIds.includes(browserInstanceId));
        if (known.length) {
          // A browser can appear on MORE THAN ONE of a client's profiles — e.g. an
          // approved profile PLUS stale pending duplicates that the fingerprint-drift
          // bug created before this fix, all carrying the same browserInstanceId. find()
          // relies on unspecified DB scan order (ids are random hex, no ORDER BY), so it
          // could return a pending duplicate and leave an already-approved browser locked
          // out. Resolve by explicit security precedence instead: an admin block wins,
          // else restore trust from the approved profile, else stay pending.
          const blocked = known.find(p => p.status === 'blocked');
          if (blocked) return { status: 'blocked', profile: blocked };
          const approved = known.find(p => p.status === 'approved');
          if (approved) {
            // Same trusted browser whose fingerprint merely drifted. Refresh metadata
            // only (do NOT rewrite deviceGroupId — keep the record structure intact).
            if (info.browser) approved.browser = info.browser;
            if (info.os && !approved.os) approved.os = info.os;
            if (info.extensionVersion) approved.extensionVersion = info.extensionVersion;
            approved.clientEmail = approved.clientEmail || client.email || null;
            approved.lastSeenAt = now;
            await approved.save();
            return { status: 'approved', profile: approved, reason: 'browser_instance_match' };
          }
          return { status: 'pending', profile: known[0] };
        }
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
