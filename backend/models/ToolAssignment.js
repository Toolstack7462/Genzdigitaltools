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
    // The effective expiry boundary for an endDate. A DATE-ONLY endDate
    // ("2026-06-10", or any midnight value) means the WHOLE calendar day is
    // included, so it is treated as INCLUSIVE end-of-day (23:59:59.999) and
    // same-day access is never wrongly rejected. A real timestamped endDate
    // keeps its exact time.
    effectiveEndBoundary(endDate) {
      if (!endDate) return null; // no end date = no expiry

      // Robust date-only handling: build the boundary from the calendar Y/M/D
      // directly so it does NOT depend on the server timezone or on how MySQL
      // returned the value (a date string can be "2026-06-10", "2026-06-10
      // 00:00:00", or "2026-06-10T00:00:00.000Z"; `new Date(...)` would parse
      // the space form as LOCAL time and could shift it off midnight UTC).
      if (typeof endDate === 'string') {
        const m = endDate.match(/^(\d{4})-(\d{2})-(\d{2})(?:[T ](\d{2}):(\d{2}):(\d{2}))?/);
        if (m) {
          const [, y, mo, d, hh, mm, ss] = m;
          const isMidnight = hh === undefined || (hh === '00' && mm === '00' && ss === '00');
          if (isMidnight) {
            return new Date(Date.UTC(+y, +mo - 1, +d, 23, 59, 59, 999));
          }
        }
      }

      const dt = new Date(endDate);
      if (isNaN(dt.getTime())) return null;
      if (dt.getUTCHours() === 0 && dt.getUTCMinutes() === 0 &&
          dt.getUTCSeconds() === 0 && dt.getUTCMilliseconds() === 0) {
        dt.setUTCHours(23, 59, 59, 999);
      }
      return dt;
    },

    isAssignmentExpired(assignment, now = new Date()) {
      const boundary = this.effectiveEndBoundary(assignment && assignment.endDate);
      return !!(boundary && boundary.getTime() < now.getTime());
    },

    // Pick the LATEST still-valid active assignment for a client+tool — using the
    // EXACT SAME query + filters as the client dashboard list (routes/client/
    // tools.js GET /), so anything visible on the dashboard is allowed to open.
    //
    // CRITICAL: query by clientId + status ONLY, then match toolId with a
    // String() compare in JS. A compound SQL find that includes `toolId` can
    // silently miss rows because the dashboard and the extension hold
    // clientId/toolId in DIFFERENT representations (string vs number vs hex) —
    // that mismatch is the documented cause of "tool is visible on the dashboard
    // but Access says tool_access_expired". Mirroring the dashboard's query
    // removes the divergence entirely.
    //
    // Handles duplicate rows: filters to active + started + not-expired (inclusive
    // end-of-day), then chooses the one with the furthest boundary (null endDate =
    // no expiry, treated as furthest). Returns { assignment, candidates } where
    // `candidates` are the active rows for THIS tool (used to tell
    // assignment_not_found from assignment_expired).
    async findActiveForClientTool(clientId, toolId) {
      const wantTool = String(toolId);
      const rows = await this.find({ clientId, status: 'active' }).populate('toolId');
      const candidates = (rows || []).filter(a => {
        const tid = a && a.toolId ? String(a.toolId._id ?? a.toolId) : null;
        return tid === wantTool;
      });
      const now = new Date();
      const valid = candidates.filter(a =>
        a && a.toolId && a.toolId.status === 'active' &&
        !(a.startDate && new Date(a.startDate) > now) &&
        !this.isAssignmentExpired(a, now)
      );
      valid.sort((x, y) => {
        const bx = this.effectiveEndBoundary(x.endDate)?.getTime() ?? Number.POSITIVE_INFINITY;
        const by = this.effectiveEndBoundary(y.endDate)?.getTime() ?? Number.POSITIVE_INFINITY;
        return by - bx; // latest boundary first
      });
      return { assignment: valid[0] || null, candidates };
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
