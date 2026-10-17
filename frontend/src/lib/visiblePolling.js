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
 * @param {{ pollOnShow?: boolean }} [opts]  poll immediately when the tab becomes visible/focused
 *                                           (default true)
 * @returns {() => void}             stop — clears the timer and removes every listener
 */
export function startVisiblePolling(fn, intervalMs, opts = {}) {
  const pollOnShow = opts.pollOnShow !== false;
  if (typeof fn !== 'function' || !(intervalMs > 0)) return () => {};

  // No DOM (SSR / tests without jsdom): fall back to a plain interval rather than never polling.
  if (typeof document === 'undefined' || typeof document.addEventListener !== 'function') {
    const id = setInterval(fn, intervalMs);
    return () => clearInterval(id);
  }

  let id = null;
  // A poll that throws must never take the schedule down with it — on either path.
  const safe = () => { try { fn(); } catch { /* caller's concern; the cadence survives */ } };
  const visible = () => document.visibilityState !== 'hidden';
  const start = () => { if (id === null) id = setInterval(safe, intervalMs); };
  const stop = () => { if (id !== null) { clearInterval(id); id = null; } };

  const onShow = () => {
    if (!visible()) { stop(); return; }
    if (pollOnShow) safe();
    start();
  };

  if (visible()) start();   // mount: schedule only — the caller owns the initial load

  document.addEventListener('visibilitychange', onShow);
  window.addEventListener('focus', onShow);

  return () => {
    stop();
    document.removeEventListener('visibilitychange', onShow);
    window.removeEventListener('focus', onShow);
  };
}

export default startVisiblePolling;
