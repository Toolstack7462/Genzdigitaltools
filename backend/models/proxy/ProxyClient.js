'use strict';
/**
 * ProxyClient — grants a CRM client access to a proxy tool (HIX / BypassGPT).
 * One row per (userId, tool). No usage metering and no daily limits — access is
 * controlled only by `status` (active/disabled) and optional `expiryDate`.
 *
 * This is intentionally separate from the Tool/ToolAssignment system so the proxy
 * tools never interfere with the existing cookie/extension tool flow.
 */
const { createModel } = require('../../db/mysqlAdapter');

const ProxyClient = createModel('ProxyClient', {
  preSave: async (data) => {
    if (!data.tool) data.tool = 'hix';
    if (!['active', 'disabled'].includes(data.status)) data.status = 'active';
    if (!data.planName) data.planName = '';
    if (data.expiryDate === undefined) data.expiryDate = null;
    // Optional per-client session length (minutes) = the client-facing countdown.
    // null/blank → fall back to the tool/global default in the open route. Clamp 1..1440.
    if (data.leaseMinutes === undefined || data.leaseMinutes === null || data.leaseMinutes === '') {
      data.leaseMinutes = null;
    } else {
      const n = parseInt(data.leaseMinutes, 10);
      data.leaseMinutes = Number.isFinite(n) ? Math.min(1440, Math.max(1, n)) : null;
    }
    // ── Claude token-quota fields (claude-only; other tools keep their exact shape) ──
    // `pinnedAccountId` = a specific Claude account this client is bound to (pinned
    // assignment). null → automatic account selection. `tokenLimit` = this client's custom
    // per-five-hour-cycle allowance in estimated tokens; null → the global default (20,000).
    if (data.tool === 'claude') {
      if (data.pinnedAccountId === undefined || data.pinnedAccountId === '' || data.pinnedAccountId === null) {
        data.pinnedAccountId = null;
      } else {
        data.pinnedAccountId = String(data.pinnedAccountId);
      }
      if (data.tokenLimit === undefined || data.tokenLimit === null || data.tokenLimit === '') {
        data.tokenLimit = null;
      } else {
        const t = parseInt(data.tokenLimit, 10);
        data.tokenLimit = Number.isFinite(t) && t >= 0 ? Math.min(100000000, t) : null;
      }
      // `weeklyTokenLimit` = this client's custom WEEKLY allowance; null → account/global default.
      if (data.weeklyTokenLimit === undefined || data.weeklyTokenLimit === null || data.weeklyTokenLimit === '') {
        data.weeklyTokenLimit = null;
      } else {
        const w = parseInt(data.weeklyTokenLimit, 10);
        data.weeklyTokenLimit = Number.isFinite(w) && w >= 0 ? Math.min(1000000000, w) : null;
      }
    }
    return data;
  },
  methods: {
    isExpired(now = new Date()) {
      if (!this.expiryDate) return false;
      // Inclusive end-of-day: a date-only expiry is valid through its whole day.
      const d = new Date(this.expiryDate);
      if (isNaN(d.getTime())) return false;
      if (d.getUTCHours() === 0 && d.getUTCMinutes() === 0 && d.getUTCSeconds() === 0) {
        d.setUTCHours(23, 59, 59, 999);
      }
      return d.getTime() < now.getTime();
    },
    isActive(now = new Date()) {
      return this.status === 'active' && !this.isExpired(now);
    }
  }
});

module.exports = ProxyClient;
