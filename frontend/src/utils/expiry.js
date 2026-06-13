/**
 * expiry.js — client-side expiry helpers that MIRROR the backend exactly.
 *
 * The backend (backend/models/ToolAssignment.js → effectiveEndBoundary) treats a
 * DATE-ONLY endDate (stored as midnight UTC, e.g. "2026-06-13") as INCLUSIVE
 * end-of-day (23:59:59.999), so same-day access stays valid all day. The dashboard
 * MUST use the same boundary or it can show "valid / N days left" while the backend
 * already considers the assignment expired (or vice-versa). Always prefer the
 * backend-computed `tool.daysUntilExpiry` when present; only fall back to this
 * local calc when it is absent.
 */

// Same rule as backend effectiveEndBoundary(endDate).
export function effectiveEndBoundary(endDate) {
  if (!endDate) return null; // no end date = no expiry
  const d = new Date(endDate);
  if (isNaN(d.getTime())) return null;
  if (d.getUTCHours() === 0 && d.getUTCMinutes() === 0 &&
      d.getUTCSeconds() === 0 && d.getUTCMilliseconds() === 0) {
    d.setUTCHours(23, 59, 59, 999);
  }
  return d;
}

// Whole days remaining until the inclusive end-of-day boundary. null = no expiry.
export function daysUntilExpiry(endDate, backendDays) {
  if (backendDays !== undefined && backendDays !== null) return backendDays;
  const boundary = effectiveEndBoundary(endDate);
  if (!boundary) return null;
  return Math.ceil((boundary.getTime() - Date.now()) / (1000 * 60 * 60 * 24));
}

// True only when the inclusive end-of-day boundary has fully passed.
export function isAccessExpired(endDate) {
  const boundary = effectiveEndBoundary(endDate);
  return !!(boundary && boundary.getTime() < Date.now());
}
