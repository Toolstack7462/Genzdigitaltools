'use strict';
const { createModel } = require('../db/mysqlAdapter');

const SecurityAlert = createModel('SecurityAlert', {
  statics: {
    async raise(clientId, riskType, riskLevel, context = {}, dedupWindowMs = 5 * 60 * 1000) {
      try {
        const cutoff = new Date(Date.now() - dedupWindowMs);
        const existing = await this.findOne({ clientId, riskType, status: 'open', createdAt: { $gte: cutoff } });
        if (existing) return existing;
        return await this.create({ clientId, riskType, riskLevel, status: 'open', context });
      } catch (err) {
        console.error('[SecurityAlert.raise] failed:', err.message);
      }
    }
  }
});
module.exports = SecurityAlert;
