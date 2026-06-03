'use strict';
const { createModel } = require('../db/mysqlAdapter');

const ToolAssignment = createModel('ToolAssignment', {
  methods: {
    isValid() {
      if (this.status !== 'active') return false;
      const now = new Date();
      if (this.startDate && new Date(this.startDate) > now) return false;
      if (this.endDate && new Date(this.endDate) < now) return false;
      return true;
    }
  },
  statics: {
    async updateExpiredAssignments() {
      return this.updateMany({ status: 'active', endDate: { $lt: new Date() } }, { $set: { status: 'expired' } });
    }
  }
});

module.exports = ToolAssignment;
