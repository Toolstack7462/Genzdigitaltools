'use strict';
const bcrypt = require('bcryptjs');
const { createModel } = require('../db/mysqlAdapter');

const User = createModel('User', {
  preSave: async (data, original) => {
    if (data.email) data.email = String(data.email).trim().toLowerCase();
    if (!data.status) data.status = 'active';
    if (data.tokenVersion === undefined) data.tokenVersion = 0;
    if (!data.devicePolicy) data.devicePolicy = { enabled: true, maxDevices: 1 };
    if (!data.expirySettings) data.expirySettings = { warningDays: 3 };
    const changedPassword = data.passwordHash && (!original || original.passwordHash !== data.passwordHash);
    const alreadyBcrypt = /^\$2[aby]\$/.test(String(data.passwordHash || ''));
    if (changedPassword && !data._passwordPreHashed && !alreadyBcrypt) {
      data.passwordHash = await bcrypt.hash(data.passwordHash, 12);
    }
    delete data._passwordPreHashed;
    return data;
  },
  methods: {
    async comparePassword(candidatePassword) {
      return bcrypt.compare(candidatePassword, this.passwordHash || '');
    },
    async forceLogout() {
      this.tokenVersion = Number(this.tokenVersion || 0) + 1;
      await this.save();
      return this.tokenVersion;
    },
    isAdmin() {
      return ['SUPER_ADMIN', 'ADMIN'].includes(this.role);
    },
    toJSON() {
      const obj = this.toObject();
      delete obj.passwordHash;
      delete obj.tokenVersion;
      delete obj._passwordPreHashed;
      return obj;
    }
  }
});

module.exports = User;
