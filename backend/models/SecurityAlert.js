'use strict';
const { createModel } = require('../db/mysqlAdapter');

// Order used to keep the HIGHER severity when a repeat detection updates an open alert.
const LEVEL_RANK = { low: 0, medium: 1, high: 2, critical: 3 };
// Types that must NEVER be auto-deleted even once closed (audit-critical). Auth-abuse and
// device-mismatch are the token/authentication-abuse family called out in the cleanup policy.
const PROTECTED_TYPES = ['REPEATED_AUTH_FAILURE', 'DEVICE_MISMATCH'];

const SecurityAlert = createModel('SecurityAlert', {
  statics: {
    // Raise (or fold into) an alert. DEDUP: if an OPEN alert of the same client + type
    // already exists, we increment its occurrence count and refresh last-seen (keeping the
    // higher severity and latest context) INSTEAD of inserting a duplicate row. A new row is
    // only created when there is no open alert of that type (e.g. after an admin resolved the
    // previous one). The dedupWindowMs argument is accepted for backward compatibility but no
    // longer time-limits the fold — an open alert is unresolved, so repeats always fold into it.
    async raise(clientId, riskType, riskLevel, context = {}, _dedupWindowMs) {
      try {
        const existing = await this.findOne({ clientId, riskType, status: 'open' });
        if (existing) {
          existing.occurrences = (existing.occurrences || 1) + 1;
          existing.lastSeenAt = new Date();
          // Keep the highest severity seen for this ongoing alert.
          if ((LEVEL_RANK[riskLevel] ?? 0) > (LEVEL_RANK[existing.riskLevel] ?? 0)) {
            existing.riskLevel = riskLevel;
          }
          if (context && typeof context === 'object') {
            existing.context = { ...(existing.context || {}), ...context };
          }
          await existing.save();
          return existing;
        }
        const now = new Date();
        return await this.create({
          clientId, riskType, riskLevel, status: 'open', context,
          occurrences: 1, firstSeenAt: now, lastSeenAt: now,
        });
      } catch (err) {
        console.error('[SecurityAlert.raise] failed:', err.message);
      }
    },

    // Auto-resolve every OPEN alert of a given type for a client — used when the client
    // becomes compliant (e.g. a later extension scan reports no high-risk extensions), so
    // stale warnings clear themselves without an admin having to act. Never touches alerts
    // that are already closed, and never creates rows.
    async autoResolveOpen(clientId, riskType, meta = {}) {
      try {
        const open = await this.find({ clientId, riskType, status: 'open' });
        let resolved = 0;
        for (const a of (open || [])) {
          a.status = 'resolved';
          a.reviewedAt = new Date();
          a.actionTaken = 'auto_resolved_compliant';
          a.reviewNotes = meta.note || 'Auto-resolved: client became compliant (no high-risk extensions in latest scan).';
          await a.save();
          resolved++;
        }
        return resolved;
      } catch (err) {
        console.error('[SecurityAlert.autoResolveOpen] failed:', err.message);
        return 0;
      }
    },

    // Batched cleanup of stale, already-handled noise. DELETES only alerts that are ALL of:
    //   • closed (status !== 'open') — OPEN/active alerts are never auto-deleted, any severity;
    //   • older than maxAgeDays by BOTH creation and last activity (default 7 days);
    //   • low-risk OR an extension-scan alert (RISKY_EXTENSION_DETECTED);
    //   • NOT a protected type (authentication-abuse / device-mismatch are retained for audit).
    // Runs in a bounded batch (batchLimit) so a large backlog can never issue one huge delete /
    // overload the DB — it trims up to batchLimit rows per call and returns the count removed.
    async purgeOld({ maxAgeDays = 7, batchLimit = 500 } = {}) {
      try {
        const cutoffMs = Date.now() - maxAgeDays * 86400000;
        const cutoff = new Date(cutoffMs);
        const candidates = await this.find({
          status: { $ne: 'open' },
          createdAt: { $lt: cutoff },
        }).sort({ createdAt: 1 }).limit(batchLimit * 2).lean();

        const delIds = [];
        for (const a of (candidates || [])) {
          if (delIds.length >= batchLimit) break;
          if (!a || a.status === 'open') continue;                       // safety: never open/active
          if (a.riskLevel === 'critical') continue;                      // never critical (retain most-serious)
          if (PROTECTED_TYPES.includes(a.riskType)) continue;            // never auth-abuse / device-mismatch
          const isExtension = a.riskType === 'RISKY_EXTENSION_DETECTED';
          const isLow = a.riskLevel === 'low';
          if (!isLow && !isExtension) continue;                          // only low-risk OR extension alerts
          const last = new Date(a.reviewedAt || a.lastSeenAt || a.createdAt).getTime();
          if (!(last < cutoffMs)) continue;                              // don't delete something handled recently
          delIds.push(a._id);
        }
        if (delIds.length) await this.deleteMany({ _id: { $in: delIds } });
        return delIds.length;
      } catch (err) {
        console.error('[SecurityAlert.purgeOld] failed:', err.message);
        return 0;
      }
    },
  },
});
module.exports = SecurityAlert;
