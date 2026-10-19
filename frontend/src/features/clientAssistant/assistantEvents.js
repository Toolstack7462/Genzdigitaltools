// Gen Z Guide — safe, non-sensitive event utilities + the decoupled reportIssue() bus + the
// "auto-open at most once per issue per browser session" gate. No secrets are ever logged or stored.
// Pure/DOM-light and unit-tested (the sessionStorage helpers are defensive and never throw).

// A tiny window-level event bus so ANY client component can raise an issue to the assistant without
// importing its UI (loose coupling, per the spec). The provider subscribes; sources just dispatch.
const EVENT_NAME = 'genz-guide:issue';

// Only these fields are allowed to cross the bus — no tokens, cookies, payloads, or stack traces.
const ALLOWED_ISSUE_FIELDS = ['code', 'source', 'toolId', 'toolName', 'message', 'recoverable', 'retry'];

/** Strip an issue object down to the allowed, non-sensitive fields. */
export function sanitizeIssue(issue = {}) {
  const out = {};
  for (const k of ALLOWED_ISSUE_FIELDS) if (issue[k] !== undefined) out[k] = issue[k];
  // `retry` may be a function (kept in-memory only, never logged/serialised).
  if (typeof out.message === 'string') out.message = out.message.slice(0, 300);
  return out;
}

/** Fire-and-forget: raise an issue to the assistant from anywhere. Safe if no listener/window. */
export function reportIssue(issue) {
  try {
    const detail = sanitizeIssue(issue);
    if (typeof window !== 'undefined' && typeof window.dispatchEvent === 'function') {
      window.dispatchEvent(new CustomEvent(EVENT_NAME, { detail }));
    }
    return detail;
  } catch { return null; }
}

/** Subscribe to issues. Returns an unsubscribe fn. */
export function subscribeIssues(handler) {
  if (typeof window === 'undefined' || typeof handler !== 'function') return () => {};
  const fn = (e) => { try { handler(e.detail || {}); } catch { /* never break the host */ } };
  window.addEventListener(EVENT_NAME, fn);
  return () => window.removeEventListener(EVENT_NAME, fn);
}

// ── Auto-open-once gate (per-browser-session, non-sensitive UI state only) ──────────────────────
const SS_KEY = 'genzGuide.autoOpened.v1';

function readSet() {
  try {
    const raw = sessionStorage.getItem(SS_KEY);
    const arr = raw ? JSON.parse(raw) : [];
    return new Set(Array.isArray(arr) ? arr : []);
  } catch { return new Set(); }
}
function writeSet(set) {
  try { sessionStorage.setItem(SS_KEY, JSON.stringify([...set])); } catch { /* ignore (private mode) */ }
}

/** Stable, non-sensitive key for an issue occurrence (code + tool only — never message/secret). */
export function issueKey(issue = {}) {
  return `${issue.code || 'UNKNOWN'}:${issue.toolId || issue.toolName || 'global'}`;
}

/** True if the assistant may auto-open for this issue (i.e. it hasn't already this session). */
export function shouldAutoOpen(issue = {}) {
  return !readSet().has(issueKey(issue));
}

/** Record that we auto-opened for this issue so we won't nag again this session. */
export function markAutoOpened(issue = {}) {
  const set = readSet();
  set.add(issueKey(issue));
  writeSet(set);
}

/** Test/utility: clear the gate. */
export function resetAutoOpen() { try { sessionStorage.removeItem(SS_KEY); } catch { /* ignore */ } }

// ── Safe diagnostic logging (non-sensitive only) ────────────────────────────────────────────────
const SAFE_EVENTS = new Set([
  'assistant_opened', 'assistant_closed', 'flow_selected', 'issue_reported', 'guidance_completed',
  'retry_attempted', 'support_handoff_clicked', 'avatar_fallback_used',
]);

/** Log a non-sensitive assistant event. Only whitelisted event names + a tiny safe meta subset. */
export function logEvent(name, meta = {}) {
  if (!SAFE_EVENTS.has(name)) return;
  const safe = {};
  for (const k of ['code', 'flow', 'source', 'toolId']) if (meta[k] !== undefined) safe[k] = meta[k];
  try {
    if (typeof console !== 'undefined' && console.debug) console.debug(`[genz-guide] ${name}`, safe);
  } catch { /* never break the host */ }
}

export const ISSUE_EVENT_NAME = EVENT_NAME;
