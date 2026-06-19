'use strict';
/**
 * ProxyLease — a short-lived (30-min) signed lease authorizing a client to use a
 * proxy-tool gateway (HIX / BypassGPT). The `tool` field scopes the lease. Only a
 * sha256 hash of the token is stored, never the token itself. The DB row is the
 * authority for revocation/expiry.
 *
 * Never store cookies, sessions, passwords or auth headers here — only ids,
 * timestamps, a truncated user-agent and an IP for audit.
 */
const { createModel } = require('../../db/mysqlAdapter');

const ProxyLease = createModel('ProxyLease', {
  preSave: async (data) => {
    if (!data.tool) data.tool = 'hix';
    if (!data.issuedAt) data.issuedAt = new Date();
    if (data.revoked === undefined) data.revoked = false;
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

module.exports = ProxyLease;
