'use strict';
/**
 * ProxyAccount — one of the operator's OWN authorized accounts for a proxy tool
 * (HIX AI or BypassGPT). The `tool` field keeps each tool's vault separate
 * (HIX cookies are never mixed with BypassGPT or StealthWriter cookies).
 *
 * The session/cookie bundle is encrypted at rest (`sessionEncrypted`, AES-256-GCM
 * via utils/proxy/vaultCrypto) and is ONLY decrypted server-side inside the gateway
 * /session endpoint. The encrypted blob is never returned to any UI and never logged.
 *
 * This does NOT touch the tool's official limits/credits/login/payment.
 */
const { createModel } = require('../../db/mysqlAdapter');

const STATUSES = ['active', 'standby', 'limit_reached', 'session_expired', 'blocked'];
const SESSION_STATUSES = ['pending_verification', 'working', 'session_expired', 'cookies_invalid'];

const ProxyAccount = createModel('ProxyAccount', {
  preSave: async (data) => {
    if (!data.tool) data.tool = 'hix';
    if (!data.label) data.label = 'Account';
    if (!STATUSES.includes(data.status)) data.status = 'active';
    if (!SESSION_STATUSES.includes(data.session_status)) data.session_status = 'pending_verification';
    data.isPrimary = !!data.isPrimary;
    data.priority = Number.isFinite(Number(data.priority)) ? Math.trunc(Number(data.priority)) : 100;
    data.usageCount = Math.max(0, Math.trunc(Number(data.usageCount || 0)));
    if (!data.sessionMeta || typeof data.sessionMeta !== 'object') {
      data.sessionMeta = { cookieCount: 0, hasLocalStorage: false, origin: '', updatedAt: null };
    }
    return data;
  },
  methods: {
    // Defensive: never serialize the encrypted secret.
    toJSON() {
      const obj = this.toObject();
      delete obj.sessionEncrypted;
      return obj;
    }
  },
  statics: {
    STATUSES() { return STATUSES.slice(); }
  }
});

module.exports = ProxyAccount;
