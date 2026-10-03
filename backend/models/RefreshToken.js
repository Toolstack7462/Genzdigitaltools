'use strict';
const { createModel } = require('../db/mysqlAdapter');

const RefreshToken = createModel('RefreshToken', {
  statics: {
    async revokeToken(token, ipAddress) {
      const refreshToken = await this.findOne({ token });
      if (!refreshToken || !refreshToken.isActive) return null;
      refreshToken.revokedAt = new Date();
      refreshToken.revokedByIp = ipAddress;
      await refreshToken.save();
      return refreshToken;
    },

    // Remove rows that can no longer authenticate anyone: expired, or revoked, more than
    // `graceDays` ago. `isActive` already rejects both, so this never ends a live session.
    // dryRun → counts only, nothing deleted.
    async purgeExpired({ graceDays = 7, dryRun = true } = {}) {
      const cutoff = new Date(Date.now() - graceDays * 86400000);
      const rows = await this.find({ $or: [{ expiresAt: { $lt: cutoff } }, { revokedAt: { $lt: cutoff } }] });
      const ids = (rows || []).filter(r =>
        (r.expiresAt && new Date(r.expiresAt) < cutoff) || (r.revokedAt && new Date(r.revokedAt) < cutoff)).map(r => r._id);
      if (dryRun || !ids.length) return { candidates: ids.length, deleted: 0 };
      const r = await this.deleteByIds(ids);
      return { candidates: ids.length, deleted: r.deletedCount };
    }
  }
});

Object.defineProperty(RefreshToken.Document.prototype, 'isActive', {
  enumerable: false,
  get() {
    return !this.revokedAt && this.expiresAt && new Date(this.expiresAt) > new Date();
  }
});

module.exports = RefreshToken;
