'use strict';
const { createModel } = require('../db/mysqlAdapter');

const ToolAssignment = createModel('ToolAssignment', {
  methods: {
    // Inclusive validity using the SAME end-of-day rule the routes use.
    isValid(now = new Date()) {
      if (this.status !== 'active') return false;
      if (this.startDate && new Date(this.startDate) > now) return false;
      return !ToolAssignment.isAssignmentExpired(this, now);
    }
  },
  statics: {
    // The effective expiry boundary for an endDate. A DATE-ONLY endDate (stored
    // as midnight UTC, e.g. "2026-06-10") is treated as INCLUSIVE end-of-day
    // (23:59:59.999) so same-day access is not wrongly rejected. A timestamped
    // endDate keeps its exact time.
    effectiveEndBoundary(endDate) {
      if (!endDate) return null; // no end date = no expiry
      const d = new Date(endDate);
      if (isNaN(d.getTime())) return null;
      if (d.getUTCHours() === 0 && d.getUTCMinutes() === 0 &&
          d.getUTCSeconds() === 0 && d.getUTCMilliseconds() === 0) {
        d.setUTCHours(23, 59, 59, 999);
      }
      return d;
    },

    isAssignmentExpired(assignment, now = new Date()) {
      const boundary = this.effectiveEndBoundary(assignment && assignment.endDate);
      return !!(boundary && boundary.getTime() < now.getTime());
    },

    // Pick the LATEST still-valid active assignment for a client+tool. Handles
    // duplicate assignment rows: filters to active + started + not-expired, then
    // chooses the one with the furthest end-of-day boundary (null endDate = no
    // expiry, treated as furthest). Returns { assignment, candidates }.
    async findActiveForClientTool(clientId, toolId) {
      const candidates = await this.find({ clientId, toolId, status: 'active' }).populate('toolId');
      const now = new Date();
      const valid = (candidates || []).filter(a =>
        a && a.toolId && a.toolId.status === 'active' &&
        !(a.startDate && new Date(a.startDate) > now) &&
        !this.isAssignmentExpired(a, now)
      );
      valid.sort((x, y) => {
        const bx = this.effectiveEndBoundary(x.endDate)?.getTime() ?? Number.POSITIVE_INFINITY;
        const by = this.effectiveEndBoundary(y.endDate)?.getTime() ?? Number.POSITIVE_INFINITY;
        return by - bx; // latest boundary first
      });
      return { assignment: valid[0] || null, candidates: candidates || [] };
    },

    async updateExpiredAssignments() {
      // Only sweep rows whose INCLUSIVE end-of-day has fully passed — i.e. endDate
      // strictly before the start of today (UTC). This keeps a date-only endDate
      // valid through its entire day instead of flipping it to 'expired' at 00:00.
      const startOfToday = new Date();
      startOfToday.setUTCHours(0, 0, 0, 0);
      return this.updateMany(
        { status: 'active', endDate: { $lt: startOfToday } },
        { $set: { status: 'expired' } }
      );
    }
  }
});

module.exports = ToolAssignment;
