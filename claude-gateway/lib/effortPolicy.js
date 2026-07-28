'use strict';
/**
 * Claude EFFORT allowlist — PURE, DOM-free, I/O-free decision logic (claude-only, isolated).
 *
 * WHY THIS EXISTS
 * Only Low and Medium may be used. As with the Fable 5 block, hiding the other levels in the
 * picker stops an honest click and nothing else: the picker is claude.ai's own React state, so a
 * modified request, a replayed or cached body, a saved conversation that was pinned to a higher
 * level, or a direct call to the completion endpoint all still ask for it. The only place the
 * limit cannot be bypassed is the gateway, on the way upstream — so this module decides and
 * server.js applies the decision.
 *
 * There is a second, quieter reason to cap effort. A higher effort level means longer silent
 * pauses between streamed chunks, and long silences are exactly what used to trip the gateway's
 * stream timeout and truncate an answer. Capping effort therefore also reduces interrupted
 * responses — but it is NOT the fix for them (see lib/streamGuard.js); it is a policy in its own
 * right, and the streaming defect is fixed independently.
 *
 * DESIGN
 *   - ALLOWLIST OF TWO, denylist of everything else, canonicalised first. High / Extra / Extra
 *     High / Very High / Max / Maximum / Highest / Ultra all canonicalise to a blocked level and
 *     are rewritten to Medium.
 *   - FAIL-OPEN ON THE UNRECOGNISED. A value we cannot canonicalise to a known effort level is
 *     left EXACTLY as it is. Rewriting an unknown vocabulary to "medium" could produce a request
 *     claude.ai rejects, which would break chat to enforce a preference — never an acceptable
 *     trade. Unknown values are also, by definition, not one of the levels we were asked to remove.
 *   - REWRITES ONLY EVER GO BLOCKED -> MEDIUM. No path here can emit high/extra/max.
 *   - CASE AND SEPARATOR TOLERANT, because these ids change spelling without notice
 *     (extra_high / extraHigh / "Extra High" / very-high).
 *
 * No secrets, no network, no filesystem. Fully unit-testable without a browser or a live proxy.
 */

/** The only two levels a client may use, and the one every blocked level becomes. */
const ALLOWED_EFFORTS = ['low', 'medium'];
const DEFAULT_EFFORT = 'medium';

/** The client-visible reason, shown verbatim in the UI. */
const BLOCKED_MESSAGE = 'Only Low and Medium effort are available on this account.';

/**
 * Default model for a fresh conversation. Sonnet + Medium is the required default pairing.
 * Overridable via CLAUDE_DEFAULT_MODEL for the day claude.ai renames its ids.
 */
const DEFAULT_MODEL = 'claude-sonnet-5';

/**
 * The full effort vocabulary we can RECOGNISE. Note this is deliberately wider than the allowlist:
 * to remove "Extra High" from a menu, or to detect that a saved conversation is pinned to it, we
 * must still be able to parse it. Recognising is not permitting.
 */
const CANON = {
  low: 'low', lo: 'low', light: 'low', minimal: 'low', fast: 'low', quick: 'low',
  medium: 'medium', med: 'medium', mid: 'medium', standard: 'medium', normal: 'medium',
  balanced: 'medium', default: 'medium', base: 'medium',
  high: 'high', hi: 'high', deep: 'high',
  extra: 'extra', extrahigh: 'extra', veryhigh: 'extra', higher: 'extra',
  max: 'max', maximum: 'max', highest: 'max', ultra: 'max', maximal: 'max',
};

/** JSON keys that carry an effort level in claude.ai request/response bodies. */
const EFFORT_KEY_RE = /^(effort|effort_?level|reasoning_?effort|thinking_?effort|output_?effort|compute_?effort|default_?effort|preferred_?effort|paprika_?mode|reasoning_?mode|thinking_?level)$/i;

/** Keys whose ARRAY value is a list of selectable effort options (what the picker renders). */
const EFFORT_LIST_KEY_RE = /^(efforts|effort_?levels|effort_?options|available_?efforts|allowed_?efforts|reasoning_?efforts|thinking_?levels|supported_?efforts)$/i;

/** Strip separators/case so extra_high, extraHigh, "Extra High" and EXTRA-HIGH all agree. */
function squash(v) {
  return String(v == null ? '' : v).trim().toLowerCase().replace(/[\s_\-.]+/g, '');
}

/**
 * Canonicalise a value to one of low|medium|high|extra|max, or null if it is not an effort word.
 * null is the "leave it alone" signal used everywhere below.
 */
function canonEffort(v) {
  if (v == null || typeof v === 'object') return null;
  const s = squash(v);
  if (!s) return null;
  return CANON[s] || null;
}

function isAllowedEffort(v) {
  const c = canonEffort(v);
  return c != null && ALLOWED_EFFORTS.indexOf(c) >= 0;
}

/** Is this a level we recognise AND must remove? */
function isBlockedEffort(v) {
  const c = canonEffort(v);
  return c != null && ALLOWED_EFFORTS.indexOf(c) < 0;
}

/**
 * Normalise ANY stored/configured value to an allowed level.
 * Unrecognised or blocked -> DEFAULT_EFFORT. This is what migrates a saved "Extra" preference to
 * Medium, so an "Opus Extra" conversation reopens as "Opus Medium".
 */
function clampEffort(v, fallback) {
  const c = canonEffort(v);
  if (c != null && ALLOWED_EFFORTS.indexOf(c) >= 0) return c;
  const f = canonEffort(fallback);
  return (f != null && ALLOWED_EFFORTS.indexOf(f) >= 0) ? f : DEFAULT_EFFORT;
}

/** Normalise a configured default model, refusing to ever default to the blocked family. */
function normalizeDefaultModel(v) {
  const s = (v == null ? '' : String(v)).trim();
  if (!s) return DEFAULT_MODEL;
  if (/fable/i.test(s)) return DEFAULT_MODEL;
  return s;
}

/**
 * Cheap pre-filter, mirroring modelPolicy's. Parsing JSON on every proxied request is a cost we
 * refuse to pay; if the raw bytes cannot mention an effort FIELD there is nothing to do.
 *
 * Keyed on the field NAMES, deliberately, not on the level words. "high" and "max" are ordinary
 * English that appears in the user's own message text, so a value-keyed pre-filter would match
 * almost every chat body and parse it for nothing. Field names are distinctive and rare, so this
 * skips the parse on the overwhelming majority of traffic while never missing a real selection.
 */
const RELEVANT_KEY_RE = /(effort|paprika|thinking[_\-]?level|reasoning[_\-]?mode)/i;
function mayContainBlocked(buf) {
  if (!buf || !buf.length) return false;
  try { return RELEVANT_KEY_RE.test(buf.toString('utf8')); } catch (_) { return false; }
}

/**
 * Recursively rewrite a parsed JSON value.
 *   - a scalar under an effort KEY that canonicalises to a blocked level -> DEFAULT_EFFORT
 *   - an array under an effort-LIST key -> blocked entries dropped
 * Pure: never mutates the input; returns the original node when nothing changed.
 */
function rewriteValue(node, acc, dropLists) {
  if (Array.isArray(node)) {
    let changed = false;
    const out = node.map((v) => { const r = rewriteValue(v, acc, dropLists); if (r !== v) changed = true; return r; });
    return changed ? out : node;
  }
  if (node && typeof node === 'object') {
    let changed = false;
    const out = {};
    for (const k of Object.keys(node)) {
      const v = node[k];
      // A scalar effort selection.
      if (EFFORT_KEY_RE.test(k) && typeof v === 'string' && isBlockedEffort(v)) {
        if (!acc.from) acc.from = canonEffort(v);
        acc.changed = true;
        out[k] = DEFAULT_EFFORT;
        changed = true;
        continue;
      }
      // A list of selectable levels — this is what removes the options from the picker.
      if (dropLists && EFFORT_LIST_KEY_RE.test(k) && Array.isArray(v)) {
        const kept = v.filter((entry) => {
          if (typeof entry === 'string') return !isBlockedEffort(entry);
          if (entry && typeof entry === 'object') {
            const idKey = Object.keys(entry).find((kk) => /^(id|key|slug|value|level|name|effort)$/i.test(kk));
            if (idKey && isBlockedEffort(entry[idKey])) return false;
          }
          return true;
        });
        if (kept.length !== v.length) { acc.changed = true; acc.optionsRemoved = true; out[k] = kept.map((e) => rewriteValue(e, acc, dropLists)); changed = true; continue; }
      }
      const r = rewriteValue(v, acc, dropLists);
      if (r !== v) changed = true;
      out[k] = r;
    }
    return changed ? out : node;
  }
  return node;
}

/**
 * Apply the policy to a JSON REQUEST body — the authoritative, unbypassable block.
 * Returns { body, changed, from } where `body` is a Buffer (the original instance when nothing
 * changed, so the caller can skip re-setting content-length).
 * FAIL-OPEN on malformed/non-JSON input.
 */
function applyToRequestBody(buf, opts) {
  const o = opts || {};
  const unchanged = { body: buf, changed: false, from: null };
  if (o.allowed) return unchanged;              // reversible kill-switch, same shape as modelPolicy
  if (!mayContainBlocked(buf)) return unchanged;
  let parsed;
  try { parsed = JSON.parse(buf.toString('utf8')); } catch (_) { return unchanged; }
  const acc = { changed: false, from: null, optionsRemoved: false };
  const next = rewriteValue(parsed, acc, false);  // requests carry a selection, not a menu
  if (!acc.changed) return unchanged;
  let out;
  try { out = Buffer.from(JSON.stringify(next), 'utf8'); } catch (_) { return unchanged; }
  return { body: out, changed: true, from: acc.from };
}

/**
 * Apply the policy to a JSON RESPONSE body — this is what removes High/Extra/Max from the picker
 * and what stops an upstream metadata refresh from restoring them. A scalar still naming a blocked
 * level (a conversation saved as "Extra") is rewritten to Medium, so it REOPENS as Medium.
 * Returns { text, changed, optionsRemoved }. FAIL-OPEN on non-JSON.
 */
function applyToResponseBody(text, opts) {
  const o = opts || {};
  const unchanged = { text, changed: false, optionsRemoved: false };
  if (o.allowed || text == null) return unchanged;
  if (!RELEVANT_KEY_RE.test(text)) return unchanged;      // cheap pre-filter (see mayContainBlocked)
  let parsed;
  try { parsed = JSON.parse(text); } catch (_) { return unchanged; }
  const acc = { changed: false, from: null, optionsRemoved: false };
  const next = rewriteValue(parsed, acc, true);
  if (!acc.changed) return unchanged;
  try { return { text: JSON.stringify(next), changed: true, optionsRemoved: acc.optionsRemoved }; }
  catch (_) { return unchanged; }
}

/** Parse a reversible admin/env kill-switch. OFF (enforced) by default. */
function parseAllowSetting(v) {
  if (v === true) return true;
  if (v == null) return false;
  return /^(1|true|on|yes)$/i.test(String(v).trim());
}

module.exports = {
  ALLOWED_EFFORTS, DEFAULT_EFFORT, BLOCKED_MESSAGE, DEFAULT_MODEL,
  EFFORT_KEY_RE, EFFORT_LIST_KEY_RE, RELEVANT_KEY_RE, CANON,
  canonEffort, isAllowedEffort, isBlockedEffort, clampEffort, normalizeDefaultModel,
  mayContainBlocked, applyToRequestBody, applyToResponseBody, parseAllowSetting,
};
