'use strict';
const crypto = require('crypto');
const { createModel } = require('../db/mysqlAdapter');

const OpenIntent = createModel('OpenIntent', {
  statics: {
    hashToken(token) {
      return crypto.createHash('sha256').update(String(token || '')).digest('hex');
    },
    async issue({ clientId, toolId, deviceIdHash = null, ip, userAgent, ttlMs = 2 * 60 * 1000 }) {
      const token = crypto.randomBytes(32).toString('hex');
      const tokenHash = this.hashToken(token);
      const expiresAt = new Date(Date.now() + ttlMs);
      const doc = await this.create({
        clientId,
        toolId,
        tokenHash,
        deviceIdHash,
        ip,
        userAgent,
        expiresAt,
        consumedAt: null,
        status: 'active'
      });
      return { id: doc._id, token, expiresAt };
    },
    async consume({ clientId, toolId, token, deviceIdHash = null }) {
      const tokenHash = this.hashToken(token);
      const intent = await this.findOne({ clientId, toolId, tokenHash, status: 'active', expiresAt: { $gt: new Date() } }).sort({ createdAt: -1 });
      if (!intent || intent.consumedAt) return null;
      if (intent.deviceIdHash && deviceIdHash && intent.deviceIdHash !== deviceIdHash) return null;
      intent.consumedAt = new Date();
      intent.status = 'consumed';
      await intent.save();
      return intent;
    }
  }
});

module.exports = OpenIntent;
