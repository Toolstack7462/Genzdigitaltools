'use strict';
const { createModel } = require('../db/mysqlAdapter');

const CredentialAccessLog = createModel('CredentialAccessLog', {
  statics: {
    async log(data) {
      try { return await this.create(data); }
      catch (error) { console.error('Failed to log credential access:', error.message); }
    },
    async getToolLoginStats(toolId, days = 30) {
      const startDate = new Date();
      startDate.setDate(startDate.getDate() - days);
      const stats = await this.aggregate([
        { $match: { toolId, action: { $in: ['LOGIN_SUCCESS', 'LOGIN_FAILED', 'LOGIN_MFA_REQUIRED'] }, createdAt: { $gte: startDate } } },
        { $group: { _id: '$action', count: { $sum: 1 }, avgDuration: { $avg: '$loginAttempt.duration' } } }
      ]);
      return {
        total: stats.reduce((sum, s) => sum + s.count, 0),
        success: stats.find(s => s._id === 'LOGIN_SUCCESS')?.count || 0,
        failed: stats.find(s => s._id === 'LOGIN_FAILED')?.count || 0,
        mfaRequired: stats.find(s => s._id === 'LOGIN_MFA_REQUIRED')?.count || 0,
        avgDuration: stats.find(s => s._id === 'LOGIN_SUCCESS')?.avgDuration || null
      };
    },
    async getClientLoginHistory(clientId, limit = 50) {
      return this.find({
        clientId,
        action: { $in: ['LOGIN_SUCCESS', 'LOGIN_FAILED', 'LOGIN_MFA_REQUIRED', 'LOGIN_MANUAL_REQUIRED'] }
      }).populate('toolId', 'name domain').sort({ createdAt: -1 }).limit(limit).lean();
    }
  }
});
module.exports = CredentialAccessLog;
