'use strict';
/**
 * Pakistan-time daily reset helpers for the StealthWriter module.
 *
 * Usage counters reset every day at 05:00 Pakistan Standard Time. PKT is a fixed
 * UTC+5 offset (Pakistan does not currently observe DST), so we compute the
 * reset boundary deterministically without a timezone database.
 *
 * The "current window start" is the most recent instant at which the local PKT
 * clock read 05:00:00. A counter whose lastResetAt is before that instant is
 * stale and must be lazily reset before any limit check.
 */

const PKT_OFFSET_MINUTES = 5 * 60; // UTC+5
const RESET_HOUR_PKT = 5;          // 05:00 Pakistan time

/** Start (UTC Date) of the reset window that `now` currently falls in. */
function currentResetWindowStart(now = new Date()) {
  const nowMs = now.getTime();
  // Shift into PKT wall-clock space.
  const pktMs = nowMs + PKT_OFFSET_MINUTES * 60 * 1000;
  const pkt = new Date(pktMs);
  // Build today's 05:00 PKT in PKT wall-clock space (using UTC getters on the shifted date).
  let resetPktMs = Date.UTC(
    pkt.getUTCFullYear(), pkt.getUTCMonth(), pkt.getUTCDate(),
    RESET_HOUR_PKT, 0, 0, 0
  );
  // If we are before 05:00 PKT, the active window opened at 05:00 PKT yesterday.
  if (pktMs < resetPktMs) resetPktMs -= 24 * 60 * 60 * 1000;
  // Shift back to real UTC.
  return new Date(resetPktMs - PKT_OFFSET_MINUTES * 60 * 1000);
}

/** Next reset boundary (UTC Date) strictly after `now`. */
function nextResetAt(now = new Date()) {
  return new Date(currentResetWindowStart(now).getTime() + 24 * 60 * 60 * 1000);
}

/** True when a counter last reset before the current window opened. */
function needsReset(lastResetAt, now = new Date()) {
  if (!lastResetAt) return true;
  const last = new Date(lastResetAt).getTime();
  if (Number.isNaN(last)) return true;
  return last < currentResetWindowStart(now).getTime();
}

/**
 * Lazily reset a StealthClient's usage if its window has rolled over.
 * Returns true when a reset was applied (caller persists the client).
 * Does NOT save — the caller controls persistence to batch with other writes.
 */
function applyLazyReset(client, now = new Date()) {
  if (!client) return false;
  if (!client.usage || typeof client.usage !== 'object') {
    client.usage = { humanizerUsed: 0, detectorUsed: 0, lastResetAt: now };
    return true;
  }
  if (needsReset(client.usage.lastResetAt, now)) {
    client.usage.humanizerUsed = 0;
    client.usage.detectorUsed = 0;
    client.usage.lastResetAt = now;
    return true;
  }
  return false;
}

/** Human-readable reset label for dashboards. */
const RESET_LABEL = '5:00 AM Pakistan Time (PKT)';

module.exports = {
  PKT_OFFSET_MINUTES,
  RESET_HOUR_PKT,
  RESET_LABEL,
  currentResetWindowStart,
  nextResetAt,
  needsReset,
  applyLazyReset,
};
