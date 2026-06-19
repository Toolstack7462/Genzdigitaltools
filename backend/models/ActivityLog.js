'use strict';
const { createModel } = require('../db/mysqlAdapter');

// Important audit actions kept beyond the normal 7-day window (security / payment /
// account / credential events). Everything else is routine activity and is purged so
// the log table stays small and fast (the JSON store scans all rows per query).
const KEEP_ACTION_RE = /LOGIN_FAILED|LOGIN_BLOCKED|SECURITY|ALERT|PAYMENT|INVOICE|BILLING|ACCOUNT|PASSWORD|FRAUD|SUSPEND|BLOCK|DELETE|REVOKE|DEVICE_RESET|CREDENTIAL/i;

const ActivityLog = createModel('ActivityLog', {
  statics: {
    async log(actorRole, actorId, action, meta = {}) {
      try { return await this.create({ actorRole, actorId, action, meta }); }
      catch (err) { console.error('ActivityLog.log failed:', err.message); }
    },
    // Delete routine activity older than `days` (default 7). Keeps important
    // security/payment/account/credential audit logs regardless of age. Fail-safe.
    async purgeOld(days = 7) {
      try {
        const cutoff = new Date(Date.now() - Number(days) * 86400000);
        const old = await this.find({ createdAt: { $lt: cutoff } });
        const ids = (old || []).filter(r => !KEEP_ACTION_RE.test(String(r.action || ''))).map(r => r._id);
        if (!ids.length) return { deleted: 0 };
        const r = await this.deleteMany({ _id: { $in: ids } });
        return { deleted: r.deletedCount || 0 };
      } catch (err) {
        console.error('ActivityLog.purgeOld failed:', err.message);
        return { deleted: 0 };
      }
    }
  }
});
module.exports = ActivityLog;
