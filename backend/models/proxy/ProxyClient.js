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
