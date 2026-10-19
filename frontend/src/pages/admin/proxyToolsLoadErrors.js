/**
 * Describe WHICH parts of the proxy-tools section failed to load.
 *
 * The section loads three independent things — stats, the account vault, the client assignments —
 * and used to fetch them with Promise.all. One rejection discarded the other two, so a single slow
 * or failing call left the whole section blank with one generic line. That is how the vault and
 * assignment UI at the bottom of the WriteHuman admin page "disappeared" while the data behind two
 * of the three calls was perfectly fine.
 *
 * The classifications are unchanged — a 404 still means the route is not mounted, a status still
 * shows the status, no response still means the server was not reached. What is added is the name
 * of the part that failed, so a partial outage reads as a partial outage.
 */

const label = (e) => {
  const status = e?.response?.status;
  const serverMsg = e?.response?.data?.error;
  if (status === 404 || serverMsg === 'Route not found') return 'route unavailable (404)';
  if (status) return `HTTP ${status}${serverMsg ? ` — ${serverMsg}` : ''}`;
  return 'could not reach the server';
};

/**
 * @param {Array<[string, {status: string, reason?: any}]>} failures  named allSettled results
 * @returns {string|null} a message, or null when nothing failed
 */
export function describeLoadFailures(failures) {
  const bad = (failures || []).filter(([, r]) => r && r.status === 'rejected');
  if (!bad.length) return null;

  // All three gone with the same cause: the section as a whole is unavailable, so say that once
  // rather than repeating the same reason three times.
  if (bad.length === 3) {
    const reasons = new Set(bad.map(([, r]) => label(r.reason)));
    if (reasons.size === 1) return `Failed to load Proxy Tools — ${[...reasons][0]}.`;
  }

  return `Proxy Tools partly unavailable — ${bad.map(([name, r]) => `${name}: ${label(r.reason)}`).join('; ')}. The rest of the section is still shown.`;
}

export default describeLoadFailures;
