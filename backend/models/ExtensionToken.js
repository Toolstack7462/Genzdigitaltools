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
    async createForClient(clientId, expiresInDays = Number(process.env.EXTENSION_TOKEN_DAYS || 365), deviceInfo = {}) {
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
      const extensionToken = await this.findOne({ tokenHash, isRevoked: false, expiresAt: { $gt: new Date() } });
      if (!extensionToken) return null;

      // Resolve the client id from the RAW foreign key on the token row. We do
      // NOT rely on a projected .populate() here: after the MySQL migration a
      // projected populate can return the client object WITHOUT its _id, which
      // made the returned clientId (and therefore req.clientId) null on EVERY
      // extension request → getClientAccessibleTool(null, ...) → false
      // "Tool not assigned" even though the dashboard showed the tool.
      const clientId = (extensionToken.clientId && extensionToken.clientId._id) || extensionToken.clientId;
      if (!clientId) return null;

      const User = require('./User');
      const client = await User.findById(clientId).select('email fullName status devicePolicy');
      if (!client) return null;

      if (extensionToken.deviceIdHash) {
        if (!requestDeviceIdHash || requestDeviceIdHash !== extensionToken.deviceIdHash) {
          extensionToken.isRevoked = true;
          await extensionToken.save();
          return null;
        }
        const DeviceBinding = require('./DeviceBinding');
        let binding = await DeviceBinding.findOne({ clientId, deviceIdHash: extensionToken.deviceIdHash });
        if (!binding) {
          binding = await DeviceBinding.findOne({ clientId, extensionDeviceIdHash: extensionToken.deviceIdHash });
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
        clientId,
        client,
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
