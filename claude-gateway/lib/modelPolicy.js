'use strict';
/**
 * Claude model allowlist — PURE, DOM-free, I/O-free decision logic (claude-only, isolated).
 *
 * WHY THIS EXISTS
 * Fable 5 must not be usable by proxy clients. Hiding it in the UI is not enough: the picker is
 * claude.ai's own React state, so a modified request, a replayed/cached body, a direct call to
 * the completion endpoint, or devtools can all still ask for it. The only place a block cannot
 * be bypassed is the gateway, on the way upstream — so this module decides, and server.js
 * applies the decision to the request body before it is forwarded.
 *
 * DESIGN
 *   - DENYLIST BY SHAPE, NOT BY EXACT ID. claude.ai model ids carry build/date suffixes that
 *     change without notice (claude-fable-5, claude-fable-5-20260101, fable-5-latest, ...), so an
 *     exact-match list would silently stop matching after an upstream rename. We match /fable/
 *     with separator tolerance, which fails CLOSED: an unrecognised fable variant is still blocked.
 *   - EVERY OTHER MODEL IS UNTOUCHED. This is deliberately a denylist of one family, not an
 *     allowlist of known-good ids, because an allowlist would break every future Claude model on
 *     the day Anthropic ships it.
 *   - REVERSIBLE. `allowed` (from CLAUDE_ALLOW_FABLE5) short-circuits everything, so flipping the
 *     admin setting restores the original behaviour exactly, with no other code path involved.
 *   - NEVER SILENTLY BACK TO FABLE. Rewrites only ever go blocked -> fallback, never the reverse;
 *     there is no code path in this module that can produce a fable id as an output.
 *
 * No secrets, no network, no filesystem. Fully unit-testable without a browser or a live proxy.
 */

/** The client-visible reason, shown verbatim in the UI. */
const BLOCKED_MESSAGE = 'Fable 5 is disabled by your administrator.';

/** Fallback applied when a blocked model is requested. Effort/thinking live in effortPrefs. */
const DEFAULT_FALLBACK_MODEL = 'claude-opus-4-8';

/**
 * Matches the Fable 5 family across the id spellings claude.ai has used or may use:
 *   claude-fable-5 / claude_fable_5 / fable5 / fable-5-latest / claude-fable-5-20260101
 * Separator-tolerant and version-tolerant on purpose (see DESIGN above).
 * Bare "fable" with no digit still matches, so a future "fable-6" is also refused rather than
 * silently allowed — failing closed is the safe direction for a disable switch.
 */
const BLOCKED_MODEL_RE = /fable/i;

/** JSON keys that carry a model id in claude.ai request/response bodies. */
const MODEL_KEY_RE = /^(model|model_?name|model_?id|default_?model|preferred_?model|paprika_?model|target_?model|fallback_?model)$/i;

/**
 * Keys that let the ACCOUNT auto-switch models (e.g. dropping to a cheaper/faster model under
 * load). If the connected account has that enabled, Claude could move a conversation onto Fable 5
 * without the client ever choosing it — which would defeat the block. Where such a flag appears in
 * a body we force it off. Named conservatively so unrelated booleans are never touched.
 */
const AUTO_SWITCH_KEY_RE = /^(auto_?(model|switch)\w*|model_?auto\w*|(enable_?)?auto_?model_?selection|smart_?model_?routing)$/i;

/** Is this model id blocked under the current setting? */
function isBlockedModel(value, allowed) {
  if (allowed) return false;
  if (value == null || typeof value !== 'string') return false;
  return BLOCKED_MODEL_RE.test(value);
}

/** Normalise a configured fallback, refusing to ever fall back to a blocked model. */
function normalizeFallback(value) {
  const v = (value == null ? '' : String(value)).trim();
  if (!v) return DEFAULT_FALLBACK_MODEL;
  // A misconfigured fallback pointing at fable would re-enable it through the back door.
  if (BLOCKED_MODEL_RE.test(v)) return DEFAULT_FALLBACK_MODEL;
  return v;
}

/**
 * Cheap pre-filter. Body rewriting means JSON.parse on a request body, which we refuse to pay on
 * every proxied request. If the raw bytes cannot possibly contain a fable id, there is nothing to
 * do. Byte-level and case-insensitive; no full-buffer toString().
 */
function mayContainBlocked(buf) {
  if (!buf || !buf.length) return false;
  const needle = 'fable';
  const n0 = needle.charCodeAt(0), N0 = n0 - 32; // 'f' / 'F'
  const last = buf.length - needle.length;
  outer:
  for (let i = 0; i <= last; i++) {
    const c = buf[i];
    if (c !== n0 && c !== N0) continue;
    for (let j = 1; j < needle.length; j++) {
      const b = buf[i + j], want = needle.charCodeAt(j);
      if (b !== want && b !== want - 32) continue outer;
    }
    return true;
  }
  return false;
}

/**
 * Recursively rewrite a parsed JSON value.
 * Returns { value, changed, from } — `from` is the first blocked id seen, for logging.
 * Pure: never mutates the input.
 */
function rewriteValue(node, fallback, allowed, acc) {
  if (allowed) return node;
  if (Array.isArray(node)) {
    let changed = false;
    const out = node.map((v) => {
      const r = rewriteValue(v, fallback, allowed, acc);
      if (r !== v) changed = true;
      return r;
    });
    return changed ? out : node;
  }
  if (node && typeof node === 'object') {
    let changed = false;
    const out = {};
    for (const k of Object.keys(node)) {
      const v = node[k];
      if (MODEL_KEY_RE.test(k) && typeof v === 'string' && BLOCKED_MODEL_RE.test(v)) {
        if (!acc.from) acc.from = v;
        acc.changed = true;
        out[k] = fallback;
        changed = true;
        continue;
      }
      // Force account-level automatic model switching off, so the account cannot move a
      // conversation onto Fable 5 behind the client's back.
      if (AUTO_SWITCH_KEY_RE.test(k) && v === true) {
        acc.autoSwitchDisabled = true;
        acc.changed = true;
        out[k] = false;
        changed = true;
        continue;
      }
      const r = rewriteValue(v, fallback, allowed, acc);
      if (r !== v) changed = true;
      out[k] = r;
    }
    return changed ? out : node;
  }
  return node;
}

/**
 * Apply the policy to a JSON REQUEST body.
 * Returns { body, changed, from, autoSwitchDisabled } where `body` is a Buffer (the original
 * instance when nothing changed, so the caller can skip re-setting content-length).
 * FAIL-OPEN on malformed/non-JSON input: a body we cannot parse is forwarded untouched rather
 * than breaking the request. That is safe because the completion endpoint is JSON — an
 * unparseable body was never going to select a model.
 */
function applyToRequestBody(buf, opts) {
  const o = opts || {};
  const allowed = !!o.allowed;
  const fallback = normalizeFallback(o.fallback);
  const unchanged = { body: buf, changed: false, from: null, autoSwitchDisabled: false };
  if (allowed || !mayContainBlocked(buf)) return unchanged;
  let parsed;
  try { parsed = JSON.parse(buf.toString('utf8')); } catch (_) { return unchanged; }
  const acc = { changed: false, from: null, autoSwitchDisabled: false };
  const next = rewriteValue(parsed, fallback, allowed, acc);
  if (!acc.changed) return unchanged;
  let out;
  try { out = Buffer.from(JSON.stringify(next), 'utf8'); } catch (_) { return unchanged; }
  return { body: out, changed: true, from: acc.from, autoSwitchDisabled: acc.autoSwitchDisabled };
}

/**
 * Apply the policy to a JSON RESPONSE body — this is what removes Fable 5 from the picker.
 * Any array of model descriptors has its blocked entries dropped; any scalar model field still
 * naming a blocked model is rewritten to the fallback (so a conversation already on Fable 5
 * renders as the fallback instead of an unknown/blank model).
 * Returns { text, changed }. FAIL-OPEN on non-JSON.
 */
function applyToResponseBody(text, opts) {
  const o = opts || {};
  const allowed = !!o.allowed;
  const fallback = normalizeFallback(o.fallback);
  const unchanged = { text, changed: false };
  if (allowed || text == null || text.indexOf('able') < 0) return unchanged; // cheap pre-filter
  if (!BLOCKED_MODEL_RE.test(text)) return unchanged;
  let parsed;
  try { parsed = JSON.parse(text); } catch (_) { return unchanged; }

  let changed = false;
  const strip = (node) => {
    if (Array.isArray(node)) {
      const kept = [];
      for (const v of node) {
        // Drop model descriptors for the blocked family — this is the picker removal.
        if (v && typeof v === 'object' && !Array.isArray(v)) {
          const id = Object.keys(v).find((k) => MODEL_KEY_RE.test(k) || /^(id|key|slug|value)$/i.test(k));
          if (id && typeof v[id] === 'string' && BLOCKED_MODEL_RE.test(v[id])) { changed = true; continue; }
        }
        if (typeof v === 'string' && BLOCKED_MODEL_RE.test(v)) { changed = true; continue; }
        kept.push(strip(v));
      }
      return kept;
    }
    if (node && typeof node === 'object') {
      const out = {};
      for (const k of Object.keys(node)) {
        const v = node[k];
        if (MODEL_KEY_RE.test(k) && typeof v === 'string' && BLOCKED_MODEL_RE.test(v)) { out[k] = fallback; changed = true; continue; }
        if (AUTO_SWITCH_KEY_RE.test(k) && v === true) { out[k] = false; changed = true; continue; }
        out[k] = strip(v);
      }
      return out;
    }
    return node;
  };
  const next = strip(parsed);
  if (!changed) return unchanged;
  try { return { text: JSON.stringify(next), changed: true }; } catch (_) { return unchanged; }
}

/** Parse the admin on/off setting. OFF (blocked) by default — an unset/garbage value blocks. */
function parseAllowSetting(v) {
  if (v === true) return true;
  if (v == null) return false;
  return /^(1|true|on|yes)$/i.test(String(v).trim());
}

module.exports = {
  BLOCKED_MESSAGE, DEFAULT_FALLBACK_MODEL, BLOCKED_MODEL_RE, MODEL_KEY_RE, AUTO_SWITCH_KEY_RE,
  isBlockedModel, normalizeFallback, mayContainBlocked,
  applyToRequestBody, applyToResponseBody, parseAllowSetting,
};
