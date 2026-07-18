/**
 * makeLatestGuard — drop stale, out-of-order async responses.
 *
 * Typing into a search box fires overlapping requests whose responses can resolve
 * OUT OF ORDER, so an older response can clobber a newer one and show the wrong
 * results. Take a ticket with `begin()` when a request STARTS, then gate its
 * response with `isCurrent(ticket)` — only the most recently started request is
 * allowed to commit. Framework-free and pure so it's unit-testable.
 *
 *   const guard = makeLatestGuard();
 *   const t = guard.begin();
 *   const data = await fetchThings(term);
 *   if (!guard.isCurrent(t)) return;   // a newer request already started — drop this
 *   commit(data);
 */
export function makeLatestGuard() {
  let seq = 0;
  return {
    /** Start a request; returns a monotonically increasing ticket. */
    begin() { seq += 1; return seq; },
    /** True only if `ticket` is the most recently started request. */
    isCurrent(ticket) { return ticket === seq; },
    /** The current (latest) ticket. */
    current() { return seq; },
  };
}

export default makeLatestGuard;
