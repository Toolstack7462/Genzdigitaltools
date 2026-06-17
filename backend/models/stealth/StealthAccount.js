'use strict';
/**
 * StealthAccount — an entry in the admin-only StealthWriter Account Vault.
 *
 * Each row represents ONE of the operator's own authorized StealthWriter accounts.
 * Its session/cookie bundle is stored encrypted at rest (`sessionEncrypted`,
 * AES-256-GCM via utils/stealth/vaultCrypto) and is ONLY decrypted server-side in
 * the gateway session endpoint. The encrypted blob is never returned to any UI and
 * never logged. `sessionMeta` holds non-secret display info only.
 *
 * This does NOT touch StealthWriter's official limits/credits/login/payment — it
 * only manages which of the operator's own accounts a lease proxies through.
 */
const { createModel } = require('../../db/mysqlAdapter');

const STATUSES = ['active', 'standby', 'limit_reached', 'session_expired', 'blocked'];

const StealthAccount = createModel('StealthAccount', {
  preSave: async (data) => {
    if (!data.label) data.label = 'Account';
    if (!STATUSES.includes(data.status)) data.status = 'active';
    // session_status tracks the cookie/session health independently of admin status.
    const SESSION_STATUSES = ['pending_verification', 'working', 'session_expired', 'cookies_invalid'];
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
    // Defensive: a StealthAccount must never serialize its encrypted secret.
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

module.exports = StealthAccount;
