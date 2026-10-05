/**
 * Apply only the newest response of a repeatedly-issued request.
 *
 * A status page that polls (and also reloads after every action, and on Refresh) can have several
 * requests in flight; whichever finishes LAST used to win, so a slow older snapshot could overwrite
 * a newer one and make cards disagree with what the server already said. Each call is numbered when
 * it is SENT, and a result is applied only if no newer call has been applied since.
 *
 *   const gate = createLatestOnly();
 *   const ticket = gate.issue();
 *   const data = await fetchSomething();
 *   if (gate.accept(ticket)) setState(data);
 */
export function createLatestOnly() {
  let issued = 0;
  let applied = 0;
  return {
    issue() { issued += 1; return issued; },
    accept(ticket) {
      if (ticket < applied) return false;
      applied = ticket;
      return true;
    },
  };
}
