'use strict';
/**
 * StealthUsageLog — append-only audit of every humanizer / AI-detector action
 * decision (allowed or blocked). Used by the admin usage-logs view. Contains no
 * secrets — only ids, action type, the decision, remaining counts and an IP.
 */
const { createModel } = require('../../db/mysqlAdapter');

const StealthUsageLog = createModel('StealthUsageLog', {
  statics: {
    async record(entry = {}) {
      try {
        return await this.create({
          userId: entry.userId,
          stealthClientId: entry.stealthClientId,
          leaseId: entry.leaseId || null,
          action: entry.action,
          allowed: !!entry.allowed,
          reason: entry.reason || null,
          remainingHumanizer: entry.remainingHumanizer,
          remainingDetector: entry.remainingDetector,
          ip: entry.ip || null
        });
      } catch (err) {
        console.error('StealthUsageLog.record failed:', err.message);
      }
    }
  }
});

module.exports = StealthUsageLog;
