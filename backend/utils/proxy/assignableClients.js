'use strict';
/**
 * Pure helpers for the proxy-tools "Grant access" client picker.
 *
 * No DB / no I/O here, so the search+rank behaviour is unit-testable in isolation.
 * The route (routes/admin/proxyTools.js GET /:tool/assignable-clients) fetches the
 * candidate CRM users, then these functions:
 *   - shape each user into a MINIMAL, leak-safe option (id/name/email/status/eligible),
 *   - rank matches for a partial, case-insensitive name-OR-email search as
 *       0 exact  →  1 starts-with  →  2 contains,
 *     dropping non-matches, with a stable tie-break (name, then id).
 *
 * Additive + Claude/HIX/BypassGPT/Grok-shared (every proxy tool's grant modal uses
 * one picker); it never touches StealthWriter, auth, usage limits, or the general
 * /admin/clients endpoint.
 */

/** Lower-case + trim, null-safe. */
const norm = (s) => String(s == null ? '' : s).toLowerCase().trim();

/**
 * Escape a user-supplied string before it is used as a RegExp, so a partial like
 * "a.b(" can't inject regex metachars or cause ReDoS. Mirrors clientsEnhanced.js.
 */
function escapeRegex(str) {
  return String(str == null ? '' : str).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** Minimal option DTO — ONLY the fields the picker needs (never the full user). */
function toOption(u) {
  const id = String((u && (u._id != null ? u._id : u.id)) || '');
  return {
    _id: id,
    id,
    fullName: (u && u.fullName) || '',
    email: (u && u.email) || '',
    status: (u && u.status) || 'active',
    eligible: true, // the route only ever passes already-eligible candidates
  };
}

/**
 * Rank one already-eligible user against a search term.
 *   0 = exact (name OR email equals the term)
 *   1 = starts-with (name OR email)
 *   2 = contains (name OR email)
 *   3 = no textual match (excluded by rankAssignableClients when a term is present)
 */
function rankScore(user, term) {
  const t = norm(term);
  if (!t) return 0;
  const name = norm(user && user.fullName);
  const email = norm(user && user.email);
  if (name === t || email === t) return 0;
  if (name.startsWith(t) || email.startsWith(t)) return 1;
  if (name.includes(t) || email.includes(t)) return 2;
  return 3;
}

/**
 * Rank + shape a candidate list for a search term.
 *  - No term → preserve input order (caller passes recent-first) and shape only.
 *  - With a term → keep only textual matches, ordered exact → starts-with → contains,
 *    tie-broken by name (case-insensitive) then id so duplicate names stay stable and
 *    both appear (never collapsed).
 * Pure: same input → same output.
 */
function rankAssignableClients(users, term) {
  const list = (Array.isArray(users) ? users : []).filter(Boolean);
  const t = norm(term);
  if (!t) return list.map(toOption);
  return list
    .map((u) => ({ u, score: rankScore(u, t) }))
    .filter((x) => x.score < 3)
    .sort((a, b) => {
      if (a.score !== b.score) return a.score - b.score;
      const an = norm(a.u.fullName);
      const bn = norm(b.u.fullName);
      if (an !== bn) return an < bn ? -1 : 1;
      return String(a.u._id) < String(b.u._id) ? -1 : 1;
    })
    .map((x) => toOption(x.u));
}

module.exports = { norm, escapeRegex, toOption, rankScore, rankAssignableClients };
