'use strict';
const { createModel } = require('../db/mysqlAdapter');

function hasChanged(data, original, path) {
  const get = (obj, p) => p.split('.').reduce((cur, key) => cur && cur[key], obj);
  return !original || JSON.stringify(get(data, path)) !== JSON.stringify(get(original, path));
}

const Tool = createModel('Tool', {
  preSave: async (data, original) => {
    if (data.targetUrl && (!data.domain || hasChanged(data, original, 'targetUrl'))) {
      try { data.domain = new URL(data.targetUrl).hostname; } catch (_) {}
    }
    if (data.loginUrl && !data.domain) {
      try { data.domain = new URL(data.loginUrl).hostname; } catch (_) {}
    }
    const credentialChanged = ['cookiesEncrypted', 'tokenEncrypted', 'localStorageEncrypted', 'credentials'].some(p => hasChanged(data, original, p));
    const bundleChanged = ['sessionBundle.cookiesEncrypted', 'sessionBundle.localStorageEncrypted', 'sessionBundle.sessionStorageEncrypted'].some(p => hasChanged(data, original, p));
    if (credentialChanged || bundleChanged) {
      data.credentialVersion = Number(data.credentialVersion || 0) + 1;
      data.credentialUpdatedAt = new Date();
      if (bundleChanged) {
        data.sessionBundle = data.sessionBundle || {};
        data.sessionBundle.version = Number(data.sessionBundle.version || 0) + 1;
        data.sessionBundle.bundleUpdatedAt = new Date();
      }
    }
    if (!data.status) data.status = 'active';
    if (!data.category) data.category = 'Other';
    if (!data.extensionSettings) data.extensionSettings = { requirePermission: true, autoInject: true, directOpenEnabled: true };
    return data;
  },
  methods: {
    hasCredentials() {
      if (this.credentials && this.credentials.type && this.credentials.type !== 'none') return !!this.credentials.payloadEncrypted;
      return !!(this.cookiesEncrypted || this.tokenEncrypted || this.localStorageEncrypted);
    },
    getUnifiedCredentialType() {
      if (this.credentials && this.credentials.type) return this.credentials.type;
      return this.credentialType || 'none';
    }
  },
  statics: {
    async getUniqueDomains() {
      const tools = await this.find({ status: 'active', domain: { $exists: true, $ne: null } }).select('domain').lean();
      return [...new Set(tools.map(t => t.domain).filter(Boolean))];
    }
  }
});
module.exports = Tool;
