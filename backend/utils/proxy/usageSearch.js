'use strict';
/**
 * Claude usage-dashboard search + pagination — PURE, I/O-free selection logic.
 *
 * Extracted from the route so the behaviour that actually matters (what matches, what order, which
 * slice) is unit-testable without a database, an admin session or a live account. The route keeps
 * the I/O; this module keeps the decisions.
 *
 * An "entry" is `{ pc, account, user }` — the ProxyClient, its resolved display account and the
 * User record. Only three fields are ever read: user.fullName, user.email, account.label.
 *
 * WHY SELECTION HAPPENS HERE AND NOT IN THE DB QUERY. The searchable account is a RESOLVED value
 * (active lease → account selection), not a stored column on ProxyClient, and the name/email live
 * on a different model. There is no single query that can express the match, so the candidate set
 * is assembled first and narrowed here — then the expensive per-client usage maths runs for the
 * returned page ONLY.
 *
 * No secrets: labels, names and emails in, a slice out. Nothing is logged.
 */

const DEFAULT_PAGE_SIZE = 25;
const MAX_PAGE_SIZE = 100;

/** Normalise a search term: trimmed and lower-cased, so matching is case-insensitive. */
function normalizeQuery(q) {
  return String(q == null ? '' : q).trim().toLowerCase();
}

/** The three fields a search may match. */
function searchableFields(entry) {
  const e = entry || {};
  return [
    e.user && e.user.fullName,
    e.user && e.user.email,
    e.account && e.account.label,
  ];
}

/**
 * Case-insensitive PARTIAL match across name, email and account label.
 * An empty term matches everything (no filter), which is what an untouched search box means.
 */
function matchesQuery(entry, q) {
  const needle = normalizeQuery(q);
  if (!needle) return true;
  return searchableFields(entry).some(
    (v) => v != null && String(v).toLowerCase().includes(needle)
  );
}

/**
 * Total, deterministic order: name → email → id, case-insensitively.
 *
 * This is not cosmetic. Paginating an unordered result set silently repeats rows on one page and
 * drops them from another, because nothing guarantees the backing store returns the same order
 * twice. The id tie-break makes the order total even when two clients share a name and an email.
 * Returns a NEW array; the input is never mutated.
 */
function sortEntries(entries) {
  const key = (e) => [
    String((e.user && e.user.fullName) || '').toLowerCase(),
    String((e.user && e.user.email) || '').toLowerCase(),
    String((e.pc && e.pc._id) || ''),
  ];
  return (entries || []).slice().sort((a, b) => {
    const ka = key(a), kb = key(b);
    for (let i = 0; i < ka.length; i++) {
      if (ka[i] !== kb[i]) return ka[i] < kb[i] ? -1 : 1;
    }
    return 0;
  });
}

/** Clamp a requested page size into a sane, server-enforced range. */
function normalizePageSize(limit) {
  const n = parseInt(limit, 10);
  if (!Number.isFinite(n) || n <= 0) return DEFAULT_PAGE_SIZE;
  return Math.min(MAX_PAGE_SIZE, Math.max(1, n));
}

/**
 * Filter → sort → slice.
 * Returns { entries, total, page, pageSize, totalPages } where `entries` is the requested page and
 * `total` counts everything MATCHING (not everything that exists) — which is what the pager and
 * the empty state need.
 *
 * A page beyond the end is CLAMPED rather than returned empty: narrowing a search while on page 3
 * must still show results, not a blank table with a dead pager.
 */
function selectPage(entries, opts) {
  const o = opts || {};
  const q = normalizeQuery(o.q);
  const pageSize = normalizePageSize(o.pageSize);
  const requested = parseInt(o.page, 10);
  const wanted = Number.isFinite(requested) && requested > 0 ? requested : 1;

  const matched = sortEntries((entries || []).filter((e) => matchesQuery(e, q)));
  const total = matched.length;
  const totalPages = Math.max(1, Math.ceil(total / pageSize));
  const page = Math.min(wanted, totalPages);
  return {
    entries: matched.slice((page - 1) * pageSize, page * pageSize),
    total, page, pageSize, totalPages,
  };
}

module.exports = {
  DEFAULT_PAGE_SIZE, MAX_PAGE_SIZE,
  normalizeQuery, matchesQuery, sortEntries, normalizePageSize, selectPage,
};
