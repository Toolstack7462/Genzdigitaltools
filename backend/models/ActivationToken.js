'use strict';
const crypto = require('crypto');
const { createModel } = require('../db/mysqlAdapter');

const ActivationToken = createModel('ActivationToken', {
  statics: {
    hashToken(token) {
      return crypto.createHash('sha256').update(String(token || '')).digest('hex');
    },
    async issue({ clientId, deviceIdHash = null, ip, userAgent, ttlMs = 60 * 1000 }) {
      const token = crypto.randomBytes(32).toString('hex');
      const tokenHash = this.hashToken(token);
      const expiresAt = new Date(Date.now() + ttlMs);
      const doc = await this.create({
        clientId,
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
    async consume(token) {
      const tokenHash = this.hashToken(token);
      const activation = await this.findOne({ tokenHash, status: 'active', expiresAt: { $gt: new Date() } }).sort({ createdAt: -1 });
      if (!activation || activation.consumedAt) return null;
      activation.consumedAt = new Date();
      activation.status = 'consumed';
      await activation.save();
      return activation;
    }
  }
});

module.exports = ActivationToken;
