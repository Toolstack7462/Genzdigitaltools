'use strict';
const crypto = require('crypto');
const { createModel } = require('../db/mysqlAdapter');

const ExtensionToken = createModel('ExtensionToken', {
  statics: {
    generateToken() {
      return crypto.randomBytes(32).toString('hex');
    },
    hashToken(token) {
      return crypto.createHash('sha256').update(String(token || '')).digest('hex');
    },
    async createForClient(clientId, expiresInDays = 30, deviceInfo = {}) {
      const token = this.generateToken();
      const tokenHash = this.hashToken(token);
      const extensionToken = await this.create({
        clientId,
        token: token.substring(0, 8) + '...' + token.substring(token.length - 4),
        tokenHash,
        name: 'Chrome Extension',
        expiresAt: new Date(Date.now() + expiresInDays * 24 * 60 * 60 * 1000),
        isRevoked: false,
        deviceInfo: { userAgent: deviceInfo.userAgent, ip: deviceInfo.ip },
        deviceIdHash: deviceInfo.deviceIdHash || undefined,
      });
      return { id: extensionToken._id, token, expiresAt: extensionToken.expiresAt };
    },
    async verifyToken(token, requestDeviceIdHash = null) {
      const tokenHash = this.hashToken(token);
      const extensionToken = await this.findOne({ tokenHash, isRevoked: false, expiresAt: { $gt: new Date() } })
        .populate('clientId', 'email fullName status devicePolicy');
      if (!extensionToken) return null;

      if (extensionToken.deviceIdHash) {
        if (!requestDeviceIdHash || requestDeviceIdHash !== extensionToken.deviceIdHash) {
          extensionToken.isRevoked = true;
          await extensionToken.save();
          return null;
        }
        const DeviceBinding = require('./DeviceBinding');
        let binding = await DeviceBinding.findOne({ clientId: extensionToken.clientId._id, deviceIdHash: extensionToken.deviceIdHash });
        if (!binding) {
          binding = await DeviceBinding.findOne({ clientId: extensionToken.clientId._id, extensionDeviceIdHash: extensionToken.deviceIdHash });
        }
        if (!binding) {
          extensionToken.isRevoked = true;
          await extensionToken.save();
          return null;
        }
        binding.lastSeenAt = new Date();
        await binding.save();
      }

      extensionToken.lastUsedAt = new Date();
      await extensionToken.save();
      return {
        tokenId: extensionToken._id,
        clientId: extensionToken.clientId._id,
        client: extensionToken.clientId,
        expiresAt: extensionToken.expiresAt,
        deviceIdHash: extensionToken.deviceIdHash,
      };
    }
  },
  methods: {
    async revoke() {
      this.isRevoked = true;
      await this.save();
    }
  }
});

module.exports = ExtensionToken;
