'use strict';
/**
 * Claude default-effort preference — PURE, DOM-free decision logic (claude-only, isolated).
 *
 * This is the tested reference for the auto-select-effort behaviour the gateway OVERLAY performs
 * on a fresh Claude session / new conversation. The overlay (public/overlay.js) inlines an
 * equivalent copy to drive the live claude.ai DOM; keeping the policy here means it is fully
 * unit-testable without a browser. No secrets, no I/O, no network.
 *
 * Behaviour encoded:
 *   - Target effort defaults to "medium" (admin-configurable to low/medium/high/extra/max).
 *   - Apply ONCE per fresh session / new conversation, only after the UI is ready.
 *   - Detect the current effort first; never click when it already matches the target.
 *   - Never override a manual change during the active conversation (once handled, stay handled).
 *   - The /new → /chat/<id> transition (first message sent) is the SAME conversation (no re-apply).
 *   - If the control is unavailable / the UI changed, give up for this conversation and warn once
 *     (never loop / never break Claude).
 *   - "Thinking default" is a SEPARATE setting, OFF by default (lower usage); only auto-enabled
 *     when an admin turns it on, and never forced off (users may enable it manually).
 */

const EFFORT_LEVELS = ['low', 'medium', 'high', 'extra', 'max'];
const DEFAULT_EFFORT = 'medium';

// Canonicalise common label variants to the five levels.
const ALIASES = {
  low: 'low', lo: 'low', light: 'low',
  medium: 'medium', med: 'medium', mid: 'medium', standard: 'medium', normal: 'medium', balanced: 'medium', default: 'medium',
  high: 'high', hi: 'high',
  extra: 'extra', 'extra high': 'extra', extrahigh: 'extra', 'very high': 'extra', higher: 'extra',
  max: 'max', maximum: 'max', highest: 'max', ultra: 'max',
};

// Exact string → canonical level (or null if not an effort word).
function toLevel(v) {
  if (v == null) return null;
  const s = String(v).trim().toLowerCase();
  if (EFFORT_LEVELS.includes(s)) return s;
  return ALIASES[s] || null;
}

// Normalise a configured value to a canonical level, falling back to `fallback` (default medium).
function normalizeEffort(v, fallback) {
  return toLevel(v) || (EFFORT_LEVELS.includes(fallback) ? fallback : DEFAULT_EFFORT);
}

// Extract an effort level mentioned inside a label / aria-text (e.g. "Effort: Medium",
// "High effort", "Extra high"). Longer phrases are matched first so "extra high" beats "high".
// Returns a canonical level or null.
function parseEffortFromText(text) {
  if (text == null) return null;
  const s = String(text).toLowerCase();
  const ordered = ['extra high', 'very high', 'extrahigh', 'maximum', 'highest', 'ultra', 'extra', 'max', 'higher', 'high', 'medium', 'standard', 'normal', 'balanced', 'low'];
  for (const w of ordered) {
    const re = new RegExp('(^|[^a-z])' + w.replace(/ /g, '\\s+') + '([^a-z]|$)', 'i');
    if (re.test(s)) { const lvl = toLevel(w); if (lvl) return lvl; }
  }
  return null;
}

function sameEffort(a, b) { const x = toLevel(a), y = toLevel(b); return !!x && !!y && x === y; }

function parseThinkingDefault(v) {
  if (v === true) return true;
  if (v == null) return false;
  return /^(1|true|on|yes)$/i.test(String(v).trim());
}

// Stable key identifying the current conversation from a URL pathname.
function conversationKey(pathname) {
  const p = String(pathname || '').replace(/[#?].*$/, '').replace(/\/+$/, '') || '/';
  let m;
  if ((m = p.match(/\/chat\/([\w-]+)/i))) return 'chat:' + m[1];
  if ((m = p.match(/\/project\/([\w-]+)/i))) return 'project:' + m[1];
  if (/\/new$/i.test(p) || p === '/' || p === '') return 'new';
  return 'path:' + p;
}

// Given the previous conversation key and a new pathname, return { key, fresh, inherit }:
//   fresh   — a fresh session / new conversation that should be (re)handled.
//   inherit — the /new → /chat/<id> continuation: same conversation, carry the handled state.
function nextConversationState(prevKey, pathname) {
  const key = conversationKey(pathname);
  if (prevKey == null) return { key, fresh: true, inherit: false };        // first load
  if (key === prevKey) return { key, fresh: false, inherit: false };        // unchanged
  if (prevKey === 'new' && key.indexOf('chat:') === 0) return { key, fresh: false, inherit: true }; // first message sent
  if (key === 'new') return { key, fresh: true, inherit: false };          // user started a new chat
  return { key, fresh: false, inherit: false };                            // opened another existing chat → don't override
}

// The core decision. `state`:
//   { ready, controlFound, current, target, handledFor, conversationKey, attemptsExhausted }
// Returns { action: 'wait' | 'skip' | 'apply' | 'warn-skip', reason, target }.
function decideEffort(state) {
  const s = state || {};
  const target = normalizeEffort(s.target, DEFAULT_EFFORT);
  if (s.handledFor != null && s.handledFor === s.conversationKey) return { action: 'skip', reason: 'already-handled', target };
  if (!s.ready) return { action: 'wait', reason: 'not-ready', target };
  if (!s.controlFound || s.current == null) {
    return s.attemptsExhausted
      ? { action: 'warn-skip', reason: 'control-unavailable', target }
      : { action: 'wait', reason: 'control-not-found-yet', target };
  }
  if (sameEffort(s.current, target)) return { action: 'skip', reason: 'already-target', target };
  return { action: 'apply', reason: 'set-target', target };
}

// Thinking-default decision (separate setting; OFF by default). `state`:
//   { enabled, ready, controlFound, currentOn, handledFor, conversationKey, attemptsExhausted }
function decideThinking(state) {
  const s = state || {};
  if (s.enabled !== true) return { action: 'skip', reason: 'thinking-default-off' }; // never touch when off
  if (s.handledFor != null && s.handledFor === s.conversationKey) return { action: 'skip', reason: 'already-handled' };
  if (!s.ready) return { action: 'wait', reason: 'not-ready' };
  if (!s.controlFound || s.currentOn == null) {
    return s.attemptsExhausted ? { action: 'warn-skip', reason: 'control-unavailable' } : { action: 'wait', reason: 'not-found-yet' };
  }
  if (s.currentOn === true) return { action: 'skip', reason: 'already-on' };
  return { action: 'apply', reason: 'enable-thinking' };
}

module.exports = {
  EFFORT_LEVELS, DEFAULT_EFFORT,
  toLevel, normalizeEffort, parseEffortFromText, sameEffort, parseThinkingDefault,
  conversationKey, nextConversationState, decideEffort, decideThinking,
};
