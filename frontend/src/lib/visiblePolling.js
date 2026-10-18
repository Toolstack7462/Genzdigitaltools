// Poll only while the tab is actually being looked at.
//
// A plain setInterval keeps firing in a background tab for as long as the page is open, so a client
// who leaves the dashboard in another tab generates backend requests indefinitely. Browsers throttle
// hidden-tab timers (Chrome clamps to ~1/minute, harder after a few minutes) but never stop them, so
// the floor is "forever at a slower rate" rather than zero. On shared Node hosting that background
// floor is paid per open tab, by every client at once.
//
// This runs the interval ONLY while document.visibilityState === 'visible', and polls immediately on
// return so nothing is stale by the time anyone can see it. A visible tab behaves exactly as before.
//
// Deliberately dependency-free and defensive: in a non-DOM environment it degrades to a plain
// interval, and every listener/timer is released by the returned stop().

/**
 * @param {() => void} fn            the poll to run
 * @param {number} intervalMs        cadence while visible
 * @param {{ pollOnShow?: boolean, maxBackoffSteps?: number }} [opts]
 *        pollOnShow        poll immediately when the tab becomes visible/focused (default true)
 *        maxBackoffSteps   OPT-IN bounded backoff. 0 (default) keeps the previous fixed cadence
 *                          exactly, so existing callers are unchanged. With n > 0, each
 *                          consecutive FAILED poll group skips 2^k - 1 ticks (k capped at n), and
 *                          the first success resets it. A server that is refusing requests is not
 *                          helped by being asked again on the same cadence; this backs off without
 *                          a second timer or any rescheduling.
 * @returns {() => void}             stop — clears the timer and removes every listener
 */
export function startVisiblePolling(fn, intervalMs, opts = {}) {
  const pollOnShow = opts.pollOnShow !== false;
  // Window in which paired visibilitychange+focus events count as ONE return.
  const showDedupeMs = Number.isFinite(opts.showDedupeMs) ? opts.showDedupeMs : 1000;
  if (typeof fn !== 'function' || !(intervalMs > 0)) return () => {};

  // No DOM (SSR / tests without jsdom): fall back to a plain interval rather than never polling.
  if (typeof document === 'undefined' || typeof document.addEventListener !== 'function') {
    let busy = false;
    const tick = () => {
      if (busy) return;
      busy = true;
      let p; try { p = fn(); } catch { busy = false; return; }
      if (!p || typeof p.then !== 'function') { busy = false; return; }
      Promise.resolve(p).then(() => { busy = false; }, () => { busy = false; });
    };
    const fid = setInterval(tick, intervalMs);
    return () => clearInterval(fid);
  }

  const maxBackoffSteps = Number.isFinite(opts.maxBackoffSteps) && opts.maxBackoffSteps > 0
    ? Math.floor(opts.maxBackoffSteps) : 0;

  let id = null;
  let inFlight = false;          // a poll GROUP is running — never start a second one
  let lastShowRunAt = -Infinity; // when an event-driven poll last started (for pairing dedupe)
  let stopped = false;
  let failures = 0;              // consecutive failed groups (backoff only)
  let skipTicks = 0;             // ticks to sit out before the next attempt (backoff only)

  const settle = () => { inFlight = false; };
  const onOk = () => {
    inFlight = false;
    failures = 0; skipTicks = 0;   // recovered: back to the normal cadence immediately
  };
  const onFail = () => {
    inFlight = false;
    if (!maxBackoffSteps) return;
    failures += 1;
    const k = Math.min(failures, maxBackoffSteps);
    skipTicks = Math.pow(2, k) - 1;   // 1 failure -> skip 1, 2 -> skip 3, 3 -> skip 7 …
  };

  // Run one poll group. `fn`'s promise defines the group, so fn MUST resolve only once every
  // request it issued has settled — a promise that settles on the first of several releases the
  // guard while the rest are still outstanding.
  const run = ({ force = false } = {}) => {
    if (stopped || inFlight) return false;
    // Backoff: sit out this tick. A user-driven return to the tab forces a poll regardless, so
    // backing off never makes the page feel dead to someone actually looking at it.
    if (!force && skipTicks > 0) { skipTicks -= 1; return false; }
    inFlight = true;
    let p;
    try { p = fn(); } catch { onFail(); return false; }   // synchronous throw
    if (!p || typeof p.then !== 'function') { onOk(); return true; }   // synchronous fn
    // Both handlers, so a rejected poll releases the guard AND is never an unhandled rejection.
    Promise.resolve(p).then(onOk, onFail);
    return true;
  };

  const visible = () => document.visibilityState !== 'hidden';
  const start = () => { if (id === null && !stopped) id = setInterval(run, intervalMs); };
  const stopTimer = () => { if (id !== null) { clearInterval(id); id = null; } };

  // One user action returning to a tab fires BOTH visibilitychange AND focus, and window managers
  // can fire focus repeatedly. Collapse that burst into a single catch-up poll; a genuinely later
  // return (outside the window) still polls.
  const onShow = () => {
    if (stopped) return;
    if (!visible()) { stopTimer(); return; }
    if (pollOnShow) {
      const now = Date.now();
      if (now - lastShowRunAt >= showDedupeMs) { lastShowRunAt = now; run({ force: true }); }
    }
    start();
  };

  if (visible()) start();   // mount: schedule only — the caller owns the initial load

  document.addEventListener('visibilitychange', onShow);
  window.addEventListener('focus', onShow);

  return () => {
    stopped = true;
    stopTimer();
    document.removeEventListener('visibilitychange', onShow);
    window.removeEventListener('focus', onShow);
  };
}

export default startVisiblePolling;
