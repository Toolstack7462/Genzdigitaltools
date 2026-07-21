'use strict';
/**
 * SHARED lease-validation response contract (proxy tools + StealthWriter).
 *
 * ROOT CAUSE this exists to fix: the gateway overlays treated EVERY non-200 /validate
 * response as a permanent access failure — they set `state.terminal`, froze the countdown
 * and showed "Access could not be verified". A transient 429 (shared-CDN-IP rate limit),
 * a 500, a 502/503/504 restart or a malformed body therefore killed a session that still
 * had many minutes left on a perfectly valid lease.
 *
 * The response now says explicitly whether a failure is TERMINAL (the client must stop)
 * or RETRYABLE (infrastructure hiccup — keep retrying, keep counting down). The client
 * must never have to infer that from an HTTP status alone.
 *
 * SECURITY: this module only LABELS responses. It never decides whether access is
 * granted — the backend authorization checks in routes/proxy/gateway.js and
 * routes/stealth/gateway.js remain the sole source of truth, and every code listed in
 * TERMINAL_CODES still blocks exactly as it did before.
 */

/**
 * Confirmed, authoritative denials. Only these stop a session. This list is
 * CLOSED — anything not in it is treated as retryable infrastructure noise.
 */
const TERMINAL_CODES = Object.freeze([
  'lease_expired',
  'lease_revoked',
  'lease_invalid',
  'lease_missing',
  'client_disabled',
  'client_not_found',
  'plan_expired',
  'account_blocked',
  'account_no_session',
]);

const TERMINAL_SET = new Set(TERMINAL_CODES);

/** Is this code a confirmed authorization denial (vs. a transient failure)? */
function isTerminalCode(code) {
  return TERMINAL_SET.has(String(code || ''));
}

/**
 * Short, non-guessable id correlating a client-visible failure to the server log.
 * Not a secret and not an identifier of the client — safe to return in a response body.
 */
function correlationId() {
  return require('crypto').randomBytes(8).toString('hex');
}

/**
 * SHA-256 prefix of a lease token / jti, for logs. Never log the token itself.
 */
function hashRef(value) {
  if (!value) return null;
  return require('crypto').createHash('sha256').update(String(value)).digest('hex').slice(0, 12);
}

/**
 * Build a successful validation response.
 * `expiresAt` is the ABSOLUTE server-issued deadline — the client anchors its countdown
 * to this instead of decrementing a local integer, so a stalled or frozen widget is
 * impossible and clock drift self-corrects on every poll.
 */
function ok(lease, extra) {
  const expiresMs = new Date(lease.expiresAt).getTime();
  return Object.assign({
    valid: true,
    terminal: false,
    retryable: false,
    code: null,
    secondsRemaining: Math.max(0, Math.floor((expiresMs - Date.now()) / 1000)),
    expiresAt: new Date(expiresMs).toISOString(),
    serverTime: new Date().toISOString(),
    correlationId: correlationId(),
  }, extra || {});
}

/**
 * Build a failure response. `terminal` is derived from the code, never from the status,
 * so a new/unknown code fails SAFE for availability (retryable) while every confirmed
 * denial still blocks. Callers pass the same HTTP status they always did.
 */
function fail(code, extra) {
  const terminal = isTerminalCode(code);
  return Object.assign({
    valid: false,
    terminal,
    retryable: !terminal,
    code: String(code || 'unavailable'),
    correlationId: correlationId(),
  }, extra || {});
}

module.exports = { TERMINAL_CODES, isTerminalCode, correlationId, hashRef, ok, fail };
