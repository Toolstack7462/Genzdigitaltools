import { makeLatestGuard } from '../utils/latestOnly';

/**
 * createLaunchAttempts — per-card launch-attempt identity plus its auto-clear timer.
 *
 * WHY. The Access card's state was written by whichever async path finished last, with no idea
 * whether a newer attempt had already started. Two client-visible consequences:
 *
 *   * click → fail → click again: the FIRST attempt's 8s "clear the error" timer fired during the
 *     SECOND attempt and wiped its loading state (or wiped a freshly-set error);
 *   * two attempts in flight both wrote the same card, so a slower OLDER rejection could land
 *     after a newer SUCCESS and leave a red banner on a tool that had actually opened.
 *
 * The same shape existed twice by hand — in the dashboard card and in the tool-detail page — so
 * this is one owner for both, not a third copy. It is built on the EXISTING tested
 * `makeLatestGuard` (utils/latestOnly), one guard per key, because `isCurrent` there is a
 * non-mutating predicate, which is exactly what a "may I still write?" check needs. The sibling
 * `createLatestOnly` (lib/latestOnly) is deliberately NOT used here: its `accept()` mutates, so it
 * cannot be asked the same question twice during one attempt.
 *
 * No timers are created until an attempt asks for one, and `dispose()` makes every outstanding
 * attempt stale — which is what unmount, logout and account switching need.
 *
 *   const attempts = createLaunchAttempts();
 *   const a = attempts.begin(toolId);          // claims the card, cancels an older clear-timer
 *   ...
 *   if (!attempts.isCurrent(toolId, a)) return;      // a newer attempt owns it now
 *   attempts.scheduleClear(toolId, a, clear, 8000);  // auto-clear belonging to THIS attempt
 */
export function createLaunchAttempts({ setTimeoutFn = setTimeout, clearTimeoutFn = clearTimeout } = {}) {
  const guards = new Map();   // key → makeLatestGuard()
  const timers = new Map();   // key → handle
  let disposed = false;

  const guardFor = (key) => {
    let g = guards.get(key);
    if (!g) { g = makeLatestGuard(); guards.set(key, g); }
    return g;
  };

  const cancelTimer = (key) => {
    const t = timers.get(key);
    if (t !== undefined) { clearTimeoutFn(t); timers.delete(key); }
  };

  return {
    /** Claim `key` for a new attempt. Cancels any pending clear-timer for it. Returns the id. */
    begin(key) {
      if (disposed) return -1;
      cancelTimer(key);
      return guardFor(key).begin();
    },

    /** May this attempt still write `key`? False once a newer attempt began, or after dispose. */
    isCurrent(key, id) {
      if (disposed) return false;
      const g = guards.get(key);
      return !!g && g.isCurrent(id);
    },

    /**
     * Schedule `fn` for THIS attempt only. A newer `begin(key)` cancels it, and it re-checks
     * ownership when it fires, so it can never clear a state it does not own.
     */
    scheduleClear(key, id, fn, ms) {
      if (disposed || !this.isCurrent(key, id)) return;
      cancelTimer(key);
      const handle = setTimeoutFn(() => {
        timers.delete(key);
        if (this.isCurrent(key, id)) fn();
      }, ms);
      timers.set(key, handle);
    },

    /** Settle `key` now: drop its timer so nothing later fires for it. */
    settle(key) { cancelTimer(key); },

    /** Unmount / logout / account switch: every outstanding attempt becomes stale. */
    dispose() {
      disposed = true;
      for (const t of timers.values()) clearTimeoutFn(t);
      timers.clear();
      guards.clear();
    },

    /** Test/diagnostic only. */
    pendingTimers() { return timers.size; },
  };
}

export default createLaunchAttempts;
