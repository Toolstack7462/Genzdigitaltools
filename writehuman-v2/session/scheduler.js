'use strict';
/**
 * WriteHuman V2 — smart session timer.
 *
 * A SINGLE unref'd timer that runs ONE verify only when due, then reschedules. This is the
 * "Working → periodic verify → valid → reset timer → continue" loop from the spec, with the
 * timer-based EXPIRY removed: a verify never expires a session by time, it only confirms (or,
 * on a real logout/401/403, flags) it. The timer just keeps the session proven-alive.
 *
 * Stability guarantees:
 *  - exactly one pending timer (reschedule clears the previous one) → no duplicate timers;
 *  - the timer awaits verifyFn before scheduling the next tick → no overlapping verifies;
 *  - unref'd → never holds the process open;
 *  - a transient 'unknown' result reschedules SOONER (retryMs) but never tight-loops;
 *  - bounded: one timer, no growing state → no leaks.
 */
const log = require('../lib/log');

let timer = null;
let running = false;
const cfg = { verifyFn: null, getLast: null, intervalMs: 10 * 60 * 1000, retryMs: 60 * 1000, enabled: true };

function init(opts) { Object.assign(cfg, opts || {}); }

function schedule(delayMs) {
  if (!running) return;
  if (timer) clearTimeout(timer);
  const d = Math.max(0, Math.floor(delayMs));
  timer = setTimeout(tick, d);
  if (timer.unref) timer.unref();
}

async function tick() {
  if (!running) return;
  let v = null;
  try { v = cfg.verifyFn ? await cfg.verifyFn() : null; }
  catch (e) { log.error('scheduler_tick', { message: e && e.message }); }
  const next = (v && v.result === 'unknown') ? cfg.retryMs : cfg.intervalMs;
  log.sessionTimerReset({ next_ms: next, last_result: v ? v.result : null });
  schedule(next);
}

// Start the timer. The first verify is scheduled relative to the last verification time so a
// restart does not immediately re-verify a recently-checked session (spec: lightweight, no spam).
function start() {
  if (!cfg.enabled) { log.info('scheduler_disabled', { enabled: false }); return; }
  if (running) return;
  running = true;
  let initial = 0;
  try {
    const last = cfg.getLast ? cfg.getLast() : null;
    if (last) initial = Math.max(0, cfg.intervalMs - (Date.now() - new Date(last).getTime()));
  } catch (_) { initial = 0; }
  log.info('scheduler_started', { interval_ms: cfg.intervalMs, first_tick_ms: initial });
  schedule(initial);
}

// Reset the timer (e.g. after an ingest-triggered verify). Defaults to a full interval.
function reschedule(delayMs) {
  if (!running) return;
  const d = (delayMs == null) ? cfg.intervalMs : delayMs;
  log.sessionTimerReset({ next_ms: d, reason: 'reschedule' });
  schedule(d);
}

function stop() { running = false; if (timer) { clearTimeout(timer); timer = null; } }

module.exports = { init, start, reschedule, stop, isRunning: () => running };
