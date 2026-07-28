'use strict';
/**
 * Unit tests for the streamed-response lifetime policy (lib/streamGuard.js).
 *
 * THE DEFECT THIS GUARDS: the gateway protected a proxied request with a single
 * `upstream.setTimeout(30s)`. That maps onto `socket.setTimeout`, an IDLE timer armed for the
 * whole life of the socket — including while Claude's answer was still streaming. Claude
 * legitimately goes quiet for longer than 30s during extended thinking, a tool call or file
 * generation, so the socket was destroyed mid-answer, and the teardown path called a bare
 * `res.end()`. That is a CLEAN EOF in the middle of an SSE stream: no terminating event, no error.
 * The client cannot distinguish it from a finished answer, which is exactly "Claude's response was
 * interrupted", a spinner that never resolves, and a file stuck on "Creating file".
 *
 * So the two properties asserted hardest here are:
 *   1. The two budgets are SEPARATE, and the idle budget can never be configured short enough to
 *      cut an ordinary thinking pause.
 *   2. A broken stream is ALWAYS terminated with an explicit, retryable error frame.
 */
const test = require('node:test');
const assert = require('node:assert');
const sg = require('./streamGuard');

// ── Budgets ─────────────────────────────────────────────────────────────────
test('the two budgets are independent, and the idle budget has a hard floor', () => {
  const d = sg.resolveBudgets({}, 30000);
  assert.equal(d.headersMs, 30000, 'the pre-response budget keeps its existing default');
  assert.equal(d.idleMs, sg.DEFAULT_IDLE_MS);
  assert.ok(d.idleMs > d.headersMs, 'a stream may pause far longer than a page may take to start');

  // THE REGRESSION GUARD: the old single-timer behaviour was a 30s budget applied to a streaming
  // body. Configuring anything that short must be clamped up, so the bug cannot be reintroduced
  // through configuration alone.
  assert.equal(sg.resolveBudgets({ CLAUDE_STREAM_IDLE_TIMEOUT_MS: '30000' }, 30000).idleMs, sg.MIN_IDLE_MS);
  assert.equal(sg.resolveBudgets({ CLAUDE_STREAM_IDLE_TIMEOUT_MS: '1' }, 30000).idleMs, sg.MIN_IDLE_MS);
  assert.equal(sg.resolveBudgets({ CLAUDE_STREAM_IDLE_TIMEOUT_MS: '0' }, 30000).idleMs, sg.DEFAULT_IDLE_MS);
  assert.equal(sg.resolveBudgets({ CLAUDE_STREAM_IDLE_TIMEOUT_MS: 'nonsense' }, 30000).idleMs, sg.DEFAULT_IDLE_MS);
  assert.ok(sg.MIN_IDLE_MS >= 60000, 'the floor must comfortably exceed a normal extended-thinking pause');

  // A longer budget IS honoured — the floor is a minimum, not a fixed value.
  assert.equal(sg.resolveBudgets({ CLAUDE_STREAM_IDLE_TIMEOUT_MS: '600000' }, 30000).idleMs, 600000);
  // The pre-response budget stays separately configurable.
  assert.equal(sg.resolveBudgets({ UPSTREAM_TIMEOUT_MS: '5000' }, 30000).headersMs, 5000);
});

// ── Classification ──────────────────────────────────────────────────────────
test('stream errors classify into distinct, retryable codes', () => {
  assert.equal(sg.classifyStreamError({ code: 'ECONNRESET' }), sg.CODES.GATEWAY_RESTARTED);
  assert.equal(sg.classifyStreamError({ code: 'EPIPE' }), sg.CODES.GATEWAY_RESTARTED);
  assert.equal(sg.classifyStreamError({ code: 'ERR_STREAM_PREMATURE_CLOSE' }), sg.CODES.GATEWAY_RESTARTED);
  assert.equal(sg.classifyStreamError({ code: 'ETIMEDOUT' }), sg.CODES.STREAM_IDLE_TIMEOUT);
  assert.equal(sg.classifyStreamError(new Error('stream_idle_timeout')), sg.CODES.STREAM_IDLE_TIMEOUT);
  assert.equal(sg.classifyStreamError(new Error('something else')), sg.CODES.UPSTREAM_UNAVAILABLE);
  assert.equal(sg.classifyStreamError(null), sg.CODES.UPSTREAM_UNAVAILABLE);
  // Every one of them is retryable: none may be presented as a dead session.
  for (const e of [{ code: 'ECONNRESET' }, { code: 'ETIMEDOUT' }, null]) {
    assert.equal(sg.isRetryable(sg.classifyStreamError(e)), true);
  }
});

test('upstream statuses classify into distinct codes', () => {
  assert.equal(sg.classifyStatus(429), sg.CODES.UPSTREAM_RATE_LIMITED);
  assert.equal(sg.classifyStatus(503), sg.CODES.UPSTREAM_OVERLOADED);
  assert.equal(sg.classifyStatus(529), sg.CODES.UPSTREAM_OVERLOADED);
  assert.equal(sg.classifyStatus(500), sg.CODES.UPSTREAM_UNAVAILABLE);
  assert.equal(sg.classifyStatus(403, { cfChallenge: true }), sg.CODES.CLOUDFLARE_CHALLENGE);
  assert.equal(sg.classifyStatus(200, { cfChallenge: true }), sg.CODES.CLOUDFLARE_CHALLENGE);
});

test('only a confirmed account denial is terminal; every infrastructure code is retryable', () => {
  assert.equal(sg.isRetryable(sg.CODES.ACCOUNT_SESSION_TERMINAL), false);
  assert.equal(sg.isRetryable(sg.CODES.CONVERSATION_TOO_LONG), false, 'a real length limit is not worth retrying');
  for (const c of [
    sg.CODES.UPSTREAM_RATE_LIMITED, sg.CODES.UPSTREAM_OVERLOADED, sg.CODES.UPSTREAM_UNAVAILABLE,
    sg.CODES.CLOUDFLARE_CHALLENGE, sg.CODES.STREAM_IDLE_TIMEOUT, sg.CODES.STREAM_PARSE_ERROR,
    sg.CODES.GATEWAY_RESTARTED, sg.CODES.ACCOUNT_SESSION_TRANSIENT,
  ]) assert.equal(sg.isRetryable(c), true, c);
});

// ── Conversation length must never be confused with a network fault ─────────
test('a REAL conversation-length error is detected', () => {
  for (const b of [
    '{"error":{"message":"maximum conversation length reached"}}',
    '{"error":{"message":"prompt is too long"}}',
    '{"detail":"context_length_exceeded"}',
    '{"error":"This conversation is too long to continue"}',
  ]) assert.equal(sg.isConversationTooLong(400, b), true, b);
  assert.equal(sg.isConversationTooLong(413, '{"error":"too many tokens"}'), true);
});

test('a network fault is NEVER labelled "maximum conversation length"', () => {
  // The explicit requirement: unrelated failures must not be reported as a length problem.
  assert.equal(sg.isConversationTooLong(502, 'Bad Gateway'), false);
  assert.equal(sg.isConversationTooLong(503, '{"error":"overloaded"}'), false);
  assert.equal(sg.isConversationTooLong(429, '{"error":"rate limited"}'), false);
  assert.equal(sg.isConversationTooLong(400, '{"error":"invalid request"}'), false, 'an ordinary 400 is not a length limit');
  assert.equal(sg.isConversationTooLong(400, ''), false);
  assert.equal(sg.isConversationTooLong(200, 'maximum conversation length'), false, 'only real error statuses count');
});

// ── The terminating frame: what stops the spinner ───────────────────────────
test('sseErrorFrame is a complete, parseable, self-delimiting SSE error event', () => {
  const f = sg.sseErrorFrame(sg.CODES.STREAM_IDLE_TIMEOUT);
  assert.ok(f.startsWith('\n\n'), 'opens a fresh frame, so a half-written upstream chunk cannot merge with it');
  assert.ok(f.endsWith('\n\n'), 'terminated, so the client dispatches it immediately');
  assert.match(f, /^\n\nevent: error\ndata: /);
  const payload = JSON.parse(f.slice(f.indexOf('data: ') + 6).trim());
  assert.equal(payload.type, 'error');
  assert.equal(payload.error.type, sg.CODES.STREAM_IDLE_TIMEOUT);
  assert.equal(payload.error.retryable, true);
  assert.ok(payload.error.message.length > 0, 'carries exactly one human-readable sentence');
  assert.ok(!/\n/.test(JSON.stringify(payload)), 'single-line data field — never breaks SSE framing');
});

test('every code yields exactly one accurate, content-free message', () => {
  const seen = new Set();
  for (const code of Object.values(sg.CODES)) {
    const f = sg.sseErrorFrame(code);
    const payload = JSON.parse(f.slice(f.indexOf('data: ') + 6).trim());
    assert.equal(payload.error.type, code);
    assert.equal(payload.error.retryable, sg.isRetryable(code), code);
    const msg = payload.error.message;
    assert.ok(msg && msg.length > 10, code + ': has a real message');
    // Content-free: a failure notice must never leak identifiers or internals.
    // Word-bounded on purpose — an unanchored /lease/ matches "Please", which is ordinary English
    // in a user-facing sentence and not a leak.
    assert.ok(!/cookie|\btoken\b|\blease\b|session[_-]?key|@|Bearer/i.test(msg), code + ': leaks nothing — got: ' + msg);
    seen.add(msg);
  }
  assert.ok(seen.size > 5, 'the codes are genuinely distinguishable to a user, not one catch-all');
});

test('the conversation-length message tells the user what to actually do', () => {
  const msg = sg.messageFor(sg.CODES.CONVERSATION_TOO_LONG);
  assert.match(msg, /new chat/i);
  assert.ok(!/try again/i.test(msg), 'retrying will not help, so it must not be suggested');
});

test('jsonErrorBody is machine-readable and marks retryability both ways', () => {
  const b = JSON.parse(sg.jsonErrorBody(sg.CODES.CLOUDFLARE_CHALLENGE));
  assert.equal(b.code, sg.CODES.CLOUDFLARE_CHALLENGE);
  assert.equal(b.retryable, true);
  assert.equal(b.terminal, false, 'a background fetch must never read a transient blip as terminal');
  // The overlay classifies on `terminal`/`retryable`; a terminal code must set them consistently.
  const t = JSON.parse(sg.jsonErrorBody(sg.CODES.ACCOUNT_SESSION_TERMINAL));
  assert.equal(t.retryable, false);
  assert.equal(t.terminal, true);
});

test('isEventStream recognises the streaming content type', () => {
  assert.equal(sg.isEventStream('text/event-stream'), true);
  assert.equal(sg.isEventStream('text/event-stream; charset=utf-8'), true);
  assert.equal(sg.isEventStream('application/json'), false);
  assert.equal(sg.isEventStream(''), false);
  assert.equal(sg.isEventStream(null), false);
});
