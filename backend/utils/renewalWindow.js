'use strict';
/**
 * Pure, testable date-window + sort logic for the Renewals module.
 *
 * Extracted from routes/admin/renewals.js so the filtering / archiving / sorting rules can be
 * unit-tested without a DB or HTTP layer. No I/O, no models, no side effects — renewals.js imports
 * these (single source of truth, no duplicated business logic).
 */

const DAY_MS = 86400000;

// A service overdue by MORE than this is "old / archived": it drops out of the upcoming windows and
// the default queue, and is only shown under the Archived/Lost view. Env-overridable.
const ARCHIVE_AFTER_DAYS = Math.max(1, parseInt(process.env.RENEWAL_ARCHIVE_AFTER_DAYS, 10) || 30);
// Default (no explicit range) actionable horizon into the future.
const DEFAULT_HORIZON_DAYS = Math.max(1, parseInt(process.env.RENEWAL_DEFAULT_HORIZON_DAYS, 10) || 60);

// UTC day boundaries (expiry boundaries are computed in UTC via ToolAssignment.effectiveEndBoundary).
function startOfDay(d) { const x = new Date(d); x.setUTCHours(0, 0, 0, 0); return x; }
function endOfDay(d) { const x = new Date(d); x.setUTCHours(23, 59, 59, 999); return x; }
function addDays(d, n) { return new Date(d.getTime() + n * DAY_MS); }
function parseYMD(s) {
  const m = String(s || '').match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (!m) return null;
  const d = new Date(Date.UTC(+m[1], +m[2] - 1, +m[3]));
  return isNaN(d.getTime()) ? null : d;
}

// Resolve the query into an inclusive expiry window { start, end, mode } (either bound may be null =
// unbounded). Presets are computed here so the date math is timezone-consistent and testable.
//   range=today|tomorrow|next7|next14|next30|overdue|archived|all  | (from[&to] for custom)
// Back-compat: ?days=N (no range) → default actionable window (recently overdue → +N days).
function resolveWindow(query, now) {
  const q = query || {};
  const today = startOfDay(now);
  const range = String(q.range || '').toLowerCase();
  const from = parseYMD(q.from);
  const to = parseYMD(q.to);
  if (from || to) {
    return { start: from ? startOfDay(from) : null, end: to ? endOfDay(to) : (from ? endOfDay(from) : null), mode: 'custom' };
  }
  switch (range) {
    case 'today': return { start: today, end: endOfDay(today), mode: 'today' };
    case 'tomorrow': { const t = addDays(today, 1); return { start: t, end: endOfDay(t), mode: 'tomorrow' }; }
    case 'next7': return { start: today, end: endOfDay(addDays(today, 7)), mode: 'next7' };
    case 'next14': return { start: today, end: endOfDay(addDays(today, 14)), mode: 'next14' };
    case 'next30': return { start: today, end: endOfDay(addDays(today, 30)), mode: 'next30' };
    case 'overdue': return { start: startOfDay(addDays(today, -ARCHIVE_AFTER_DAYS)), end: endOfDay(addDays(today, -1)), mode: 'overdue' };
    case 'archived': return { start: null, end: endOfDay(addDays(today, -ARCHIVE_AFTER_DAYS - 1)), mode: 'archived' };
    case 'all': return { start: null, end: null, mode: 'all' };
    default: {
      const days = Math.min(90, Math.max(1, parseInt(q.days, 10) || DEFAULT_HORIZON_DAYS));
      return { start: startOfDay(addDays(today, -ARCHIVE_AFTER_DAYS)), end: endOfDay(addDays(today, days)), mode: 'default', days };
    }
  }
}

// Classify one service by its expiry `boundary` (a Date) against the window + now.
// Returns null when there's no expiry or it falls OUTSIDE the window (bounding BOTH sides — this is
// what keeps long-expired records out of the upcoming filters). Otherwise the derived facts.
function classifyExpiry(boundary, now, win) {
  if (!boundary) return null; // lifetime access → nothing to renew
  const t = boundary.getTime();
  const nowT = now.getTime();
  const startT = win && win.start ? win.start.getTime() : null;
  const endT = win && win.end ? win.end.getTime() : null;
  if (startT != null && t < startT) return null;
  if (endT != null && t > endT) return null;
  const daysLeft = Math.ceil((t - nowT) / DAY_MS);
  const expired = t < nowT;
  const overdueDays = expired ? Math.max(0, Math.floor((nowT - t) / DAY_MS)) : 0;
  const archived = expired && overdueDays > ARCHIVE_AFTER_DAYS;
  return { daysLeft, expired, overdueDays, archived };
}

// Client sort comparator. Order (top → bottom):
//   1) UPCOMING (not yet expired, incl. today) — soonest expiry first: Today → Next 7 → 14 → 30,
//   2) EXPIRED — most-recently expired first (freshest → oldest),
//   3) OLD / archived (long-expired) — always pinned to the very bottom (also excluded from active
//      windows by resolveWindow, so it never clutters the top regardless of the flag).
// This keeps the actionable upcoming renewals at the top; expired never disrupts their order.
function compareClients(a, b) {
  if (!!a.archived !== !!b.archived) return a.archived ? 1 : -1;
  const aDl = a.soonestDaysLeft, bDl = b.soonestDaysLeft;
  const aExp = aDl != null && aDl < 0;
  const bExp = bDl != null && bDl < 0;
  if (aExp !== bExp) return aExp ? 1 : -1;          // upcoming (incl. today) above all expired
  if (!aExp) return (aDl ?? 9999) - (bDl ?? 9999);  // upcoming: soonest first
  return (bDl ?? -99999) - (aDl ?? -99999);         // expired: most-recent first → oldest last
}

module.exports = {
  DAY_MS, ARCHIVE_AFTER_DAYS, DEFAULT_HORIZON_DAYS,
  startOfDay, endOfDay, addDays, parseYMD,
  resolveWindow, classifyExpiry, compareClients,
};
