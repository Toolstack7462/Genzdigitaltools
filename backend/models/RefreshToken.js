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
