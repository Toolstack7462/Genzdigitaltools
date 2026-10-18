// Zee — a small set of timeouts that prunes itself.
//
// The avatar controller keeps every timeout it schedules so unmount can sweep them. The blink loop
// schedules two per blink, roughly every 3-5 seconds, forever while the avatar is visible — and the
// original set only ever GREW: fired ids were never removed, because clearTimeout on a dead id is
// harmless and nothing forced the issue. A parked client page therefore accumulated dead ids for as
// long as it stayed mounted. Small per entry, unbounded over a session, and invisible until you go
// looking for it.
//
// Each id is removed as it fires, so the set holds only timers that are genuinely still pending.
// clearAll() stays correct either way: clearing an already-fired id is a no-op.

export function createTimerTracker() {
  const pending = new Set();

  return {
    /** Schedule `cb` after `ms`. The id is dropped from the set the moment it fires. */
    set(cb, ms) {
      const id = setTimeout(() => {
        pending.delete(id);
        if (typeof cb === 'function') cb();
      }, ms);
      pending.add(id);
      return id;
    },
    /** Cancel one timer and forget it. */
    clear(id) {
      if (id === undefined || id === null) return;
      clearTimeout(id);
      pending.delete(id);
    },
    /** Cancel everything still pending (unmount sweep). */
    clearAll() {
      pending.forEach((id) => clearTimeout(id));
      pending.clear();
    },
    /** Timers still pending. Exposed so the no-growth property is testable, not guessed at. */
    get size() { return pending.size; },
  };
}

export default createTimerTracker;
