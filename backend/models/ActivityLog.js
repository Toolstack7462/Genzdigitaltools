'use strict';
const { createModel } = require('../db/mysqlAdapter');

const ActivityLog = createModel('ActivityLog', {
  statics: {
    async log(actorRole, actorId, action, meta = {}) {
      try { return await this.create({ actorRole, actorId, action, meta }); }
      catch (err) { console.error('ActivityLog.log failed:', err.message); }
    }
  }
});
module.exports = ActivityLog;
