'use strict';
/**
 * In-process daily reset scheduler for the StealthWriter module.
 *
 * Dependency-free: a 60s interval watches the 05:00-PKT reset boundary and runs
 * resetAllUsage() once per boundary crossing. This complements (does not replace)
 * the external cron script and the lazy reset. Safe to run in multiple workers —
 * resetAllUsage is idempotent within a window because lazy reset already zeroes
 * stale counters, and a duplicate zeroing is harmless.
 *
 * Enable by setting STEALTH_INTERNAL_CRON=true (off by default so deployments that
 * rely solely on system cron don't double-schedule).
 */
const { currentResetWindowStart } = require('../utils/stealth/time');
const { resetAllUsage } = require('../utils/stealth/resetAll');

let timer = null;
let lastWindow = null;

function start() {
  if (process.env.STEALTH_INTERNAL_CRON !== 'true') {
    console.log('ℹ️  StealthWriter internal reset scheduler disabled (set STEALTH_INTERNAL_CRON=true to enable).');
    return;
  }
  if (timer) return;
  // Seed with the current window so we don't fire immediately on boot.
  lastWindow = currentResetWindowStart().getTime();
  timer = setInterval(async () => {
    try {
      const win = currentResetWindowStart().getTime();
      if (win !== lastWindow) {
        lastWindow = win;
        const { reset, at } = await resetAllUsage();
        console.log(`[stealth-scheduler] daily reset: ${reset} client(s) at ${at.toISOString()}`);
      }
    } catch (err) {
      console.error('[stealth-scheduler] reset error:', err.message);
    }
  }, 60 * 1000);
  if (timer.unref) timer.unref();
  console.log('✅ StealthWriter internal reset scheduler started (05:00 PKT daily).');
}

function stop() {
  if (timer) { clearInterval(timer); timer = null; }
}

module.exports = { start, stop };
