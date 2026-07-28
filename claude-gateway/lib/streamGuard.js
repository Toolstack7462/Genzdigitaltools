'use strict';
/**
 * streamGuard — PURE, I/O-free decision logic for the lifetime of a PROXIED STREAMING RESPONSE
 * (claude-only in practice; the module itself is generic and dependency-free).
 *
 * WHY THIS EXISTS
 * The gateway forwarded Claude's SSE answer with `uRes.pipe(res)` and guarded the upstream request
 * with `upstream.setTimeout(30s)`. That call maps onto `socket.setTimeout`, which is an IDLE timer
 * armed for the WHOLE life of the socket — including while the answer is still streaming. Claude
 * legitimately goes quiet for longer than 30s during extended thinking, a long tool-use step or
 * artifact/file generation, so the socket was destroyed mid-answer. The teardown path then saw
 * `res.headersSent === true` and simply called `res.end()`, which hands the browser a CLEAN EOF in
 * the middle of an SSE stream: no terminating event, no error frame. Claude's app cannot tell that
 * from a truncated answer, which is exactly "Claude's response was interrupted", a spinner that
 * never resolves, and a file stuck on "Creating file".
 *
 * DESIGN
 *   - TWO SEPARATE BUDGETS. Waiting for the upstream to START responding is a different question
 *     from how long it may pause BETWEEN chunks. Collapsing them into one socket timer is the bug.
 *   - THE IDLE BUDGET RESETS ON EVERY CHUNK, so a long answer is bounded by silence, never by total
 *     duration. A 20-minute answer that keeps streaming is healthy and must never be cut.
 *   - A BROKEN STREAM MUST SAY SO. Once bytes are on the wire the only honest way to end an SSE
 *     response is a terminating error frame, so the client stops its spinner and shows ONE accurate
 *     message instead of silently rendering a truncated answer as if it were complete.
 *   - CODES ARE STABLE AND CONTENT-FREE. They identify a condition for the log and the client; they
 *     never carry a cookie, lease, token, account or any message text.
 *
 * No secrets, no network, no filesystem, no DOM. Fully unit-testable.
 */

/**
 * Structured internal codes. These are the vocabulary the gateway uses to describe a failure to
 * itself, to the log and to the client — deliberately distinct so a temporary network fault can
 * never be reported as (or mistaken for) a session or conversation-length problem.
 */
const CODES = {
  UPSTREAM_RATE_LIMITED: 'upstream_rate_limited',
  UPSTREAM_OVERLOADED: 'upstream_overloaded',
  UPSTREAM_UNAVAILABLE: 'upstream_unavailable',
  CLOUDFLARE_CHALLENGE: 'cloudflare_challenge',
  STREAM_IDLE_TIMEOUT: 'stream_idle_timeout',
  STREAM_PARSE_ERROR: 'stream_parse_error',
  GATEWAY_RESTARTED: 'gateway_restarted',
  CONVERSATION_TOO_LONG: 'conversation_too_long',
  ACCOUNT_SESSION_TRANSIENT: 'account_session_transient',
  ACCOUNT_SESSION_TERMINAL: 'account_session_terminal',
};

/** Every code above that means "this is worth trying again". */
const RETRYABLE = new Set([
  CODES.UPSTREAM_RATE_LIMITED,
  CODES.UPSTREAM_OVERLOADED,
  CODES.UPSTREAM_UNAVAILABLE,
  CODES.CLOUDFLARE_CHALLENGE,
  CODES.STREAM_IDLE_TIMEOUT,
  CODES.STREAM_PARSE_ERROR,
  CODES.GATEWAY_RESTARTED,
  CODES.ACCOUNT_SESSION_TRANSIENT,
]);

function isRetryable(code) { return RETRYABLE.has(code); }

/** Short, honest, user-facing sentence per code. No jargon, no blame, no internal detail. */
const MESSAGES = {
  [CODES.UPSTREAM_RATE_LIMITED]: 'Claude is rate limiting requests right now. Please try again in a moment.',
  [CODES.UPSTREAM_OVERLOADED]: 'Claude is overloaded right now. Please try again in a moment.',
  [CODES.UPSTREAM_UNAVAILABLE]: 'We could not reach Claude to finish this response. Please try again.',
  [CODES.CLOUDFLARE_CHALLENGE]: 'A routine security check interrupted this response. Your session is still active — please try again.',
  [CODES.STREAM_IDLE_TIMEOUT]: 'Claude stopped sending this response. Nothing was lost — please try again.',
  [CODES.STREAM_PARSE_ERROR]: 'This response could not be read to the end. Please try again.',
  [CODES.GATEWAY_RESTARTED]: 'The connection to Claude was reset before this response finished. Please try again.',
  [CODES.CONVERSATION_TOO_LONG]: 'This conversation has reached its maximum length. Start a new chat to continue.',
  [CODES.ACCOUNT_SESSION_TRANSIENT]: 'We could not verify the connection for a moment. Please try again.',
  [CODES.ACCOUNT_SESSION_TERMINAL]: 'This Claude session has ended. Please reopen the tool from your dashboard.',
};

function messageFor(code) { return MESSAGES[code] || MESSAGES[CODES.UPSTREAM_UNAVAILABLE]; }

/** Is this response body a stream we must terminate with an event rather than a bare socket close? */
function isEventStream(contentType) {
  return /text\/event-stream/i.test(String(contentType || ''));
}

/**
 * Map a Node socket/stream error to a code. `ECONNRESET`/`EPIPE` mid-answer is the upstream (or an
 * intermediary) dropping the connection; anything else is treated as a generic unavailability
 * rather than guessed at.
 */
function classifyStreamError(err) {
  const code = err && (err.code || err.message);
  if (code === 'stream_idle_timeout') return CODES.STREAM_IDLE_TIMEOUT;
  if (code === 'ECONNRESET' || code === 'EPIPE' || code === 'ERR_STREAM_PREMATURE_CLOSE') return CODES.GATEWAY_RESTARTED;
  if (code === 'ETIMEDOUT' || code === 'ESOCKETTIMEDOUT') return CODES.STREAM_IDLE_TIMEOUT;
  return CODES.UPSTREAM_UNAVAILABLE;
}

/**
 * Map an upstream HTTP status (plus optional detected Cloudflare challenge) to a code, for
 * failures that happen BEFORE any byte reaches the browser.
 */
function classifyStatus(status, opts) {
  const o = opts || {};
  if (o.cfChallenge) return CODES.CLOUDFLARE_CHALLENGE;
  if (status === 429) return CODES.UPSTREAM_RATE_LIMITED;
  if (status === 529 || status === 503) return CODES.UPSTREAM_OVERLOADED;
  if (status >= 500) return CODES.UPSTREAM_UNAVAILABLE;
  return CODES.UPSTREAM_UNAVAILABLE;
}

/**
 * Does an upstream error body describe a REAL conversation-length limit?
 *
 * This exists so a network fault is never mislabelled "maximum conversation length" and, equally,
 * so a genuine length limit is never buried under a generic network message. Deliberately narrow:
 * it requires an explicit length/limit phrase, so an unrelated 400 is not swept up.
 */
const CONVERSATION_TOO_LONG_RE = /(maximum\s+(conversation|context|prompt)\s+length|conversation\s+is\s+too\s+long|exceeds?\s+the\s+maximum\s+(context|conversation|prompt)|context[_\s-]?length[_\s-]?exceeded|prompt\s+is\s+too\s+long|too\s+many\s+tokens)/i;
function isConversationTooLong(status, bodyText) {
  if (status !== 400 && status !== 413 && status !== 422) return false;
  return CONVERSATION_TOO_LONG_RE.test(String(bodyText || ''));
}

/**
 * The terminating SSE frame written when a stream dies after headers were already sent.
 *
 * Shape matches the Anthropic streaming error event (`event: error` + a JSON `error` payload),
 * which is what a client consuming this stream already expects an upstream failure to look like.
 * Emitting it is what lets the app stop its spinner and show ONE accurate message; without it the
 * app sees a clean EOF and renders a truncated answer as if it were finished.
 *
 * Terminated with a blank line so the frame is complete and immediately dispatchable, and preceded
 * by one so it can never be concatenated onto a half-written chunk from upstream.
 */
function sseErrorFrame(code, opts) {
  const o = opts || {};
  const payload = {
    type: 'error',
    error: {
      type: code,
      message: o.message || messageFor(code),
      retryable: isRetryable(code),
    },
  };
  // `\n\n` first: if upstream was cut mid-frame, this closes it off so ours parses cleanly.
  return '\n\nevent: error\ndata: ' + JSON.stringify(payload) + '\n\n';
}

/** The JSON body returned for a NON-streaming background request that failed. Never HTML. */
function jsonErrorBody(code, opts) {
  const o = opts || {};
  return JSON.stringify({
    error: code,
    code,
    message: o.message || messageFor(code),
    retryable: isRetryable(code),
    terminal: !isRetryable(code),
  });
}

/**
 * Resolve the two budgets from env, with safe floors so a typo cannot reintroduce the bug by
 * setting a stream-idle budget shorter than a normal thinking pause.
 *   headersMs — how long the upstream may take to START responding.
 *   idleMs    — how long it may pause BETWEEN chunks once it has started. Reset on every chunk.
 */
const MIN_IDLE_MS = 60000;      // a floor: below this, ordinary extended thinking would be cut
const DEFAULT_IDLE_MS = 300000; // 5 minutes of complete silence before we call a stream dead
function resolveBudgets(env, headersDefaultMs) {
  const e = env || {};
  const headersMs = Math.max(1000, parseInt(e.UPSTREAM_TIMEOUT_MS, 10) || headersDefaultMs || 30000);
  const raw = parseInt(e.CLAUDE_STREAM_IDLE_TIMEOUT_MS, 10);
  const idleMs = Math.max(MIN_IDLE_MS, Number.isFinite(raw) && raw > 0 ? raw : DEFAULT_IDLE_MS);
  return { headersMs, idleMs };
}

module.exports = {
  CODES, MESSAGES, MIN_IDLE_MS, DEFAULT_IDLE_MS, CONVERSATION_TOO_LONG_RE,
  isRetryable, messageFor, isEventStream,
  classifyStreamError, classifyStatus, isConversationTooLong,
  sseErrorFrame, jsonErrorBody, resolveBudgets,
};
