'use strict';
const crypto = require('crypto');
const { createModel } = require('../db/mysqlAdapter');

const DeviceBinding = createModel('DeviceBinding', {
  statics: {
    hashDeviceId(deviceId) {
      return crypto.createHash('sha256').update(String(deviceId || '')).digest('hex');
    },
    async verifyDevice(clientId, deviceId) {
      const deviceIdHash = this.hashDeviceId(deviceId);
      const binding = await this.findOne({ clientId, deviceIdHash });
      return !!binding;
    }
  }
});

module.exports = DeviceBinding;
