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
    // Returns { intent } on success, or { reason } with one of:
    //   intent_not_found | intent_consumed | intent_expired | intent_device_mismatch
    // Look up by the UNIQUE token hash first, then validate the rest in JS with
    // string-normalized ids. This avoids any column type/representation mismatch
    // between the dashboard-created row (clientId = client JWT user._id, toolId
    // from URL params) and the extension's consume query (clientId from the
    // populated ExtensionToken, toolId from the request body). The intent is
    // marked consumed ONLY after every check passes.
    async consume({ clientId, toolId, token, deviceIdHash = null }) {
      const tokenHash = this.hashToken(token);
      const intent = await this.findOne({ tokenHash }).sort({ createdAt: -1 });
      if (!intent) return { reason: 'intent_not_found' };
      if (intent.consumedAt || intent.status !== 'active') return { reason: 'intent_consumed' };
      if (intent.expiresAt && new Date(intent.expiresAt).getTime() <= Date.now()) return { reason: 'intent_expired' };
      if (clientId != null && String(intent.clientId) !== String(clientId)) return { reason: 'intent_not_found' };
      if (toolId  != null && String(intent.toolId)  !== String(toolId))  return { reason: 'intent_not_found' };
      // Soft device binding: only reject when BOTH sides are present and differ.
      if (intent.deviceIdHash && deviceIdHash && String(intent.deviceIdHash) !== String(deviceIdHash)) {
        return { reason: 'intent_device_mismatch' };
      }
      intent.consumedAt = new Date();
      intent.status = 'consumed';
      await intent.save();
      return { intent };
    }
  }
});

module.exports = OpenIntent;
