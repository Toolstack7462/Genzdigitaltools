'use strict';
/**
 * StealthLease — a short-lived signed lease that authorizes a client to use the
 * StealthWriter proxy gateway. Default lifetime is 30 minutes (configurable via
 * admin settings). The signed JWT lives only in the gateway URL / overlay memory;
 * we store ONLY a sha256 hash of the token here so a DB leak cannot reconstruct a
 * usable lease. The DB row is the authority for revocation and expiry.
 *
 * Never store cookies, sessions, passwords, or auth headers on this record —
 * only ids, timestamps, a truncated user-agent and an IP for audit.
 */
const { createModel } = require('../../db/mysqlAdapter');

const StealthLease = createModel('StealthLease', {
  preSave: async (data) => {
    if (!data.issuedAt) data.issuedAt = new Date();
    if (data.revoked === undefined) data.revoked = false;
    if (data.fixedLease === undefined) data.fixedLease = true;
    if (data.userAgent) data.userAgent = String(data.userAgent).slice(0, 256);
    return data;
  },
  methods: {
    isActive(now = new Date()) {
      if (this.revoked) return false;
      if (!this.expiresAt) return false;
      return new Date(this.expiresAt).getTime() > now.getTime();
    }
  }
});

module.exports = StealthLease;
