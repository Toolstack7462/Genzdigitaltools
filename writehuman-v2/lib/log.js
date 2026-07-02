'use strict';
/**
 * WriteHuman V2 — safe structured logger. Logs IDs / counts / status only.
 * NEVER cookie names beyond a count, NEVER cookie values, tokens, or secrets.
 *
 * Provides the full Step-2 event vocabulary as named helpers so the session
 * architecture (cookie-hash detection, auto-verify, smart timer, sync agent) emits a
 * consistent set of events. Helpers used by Step-1 code are wired now; the rest are
 * ready for Step 2.
 */
const events = require('./events');
function emit(event, fields, level) {
  try { console.log(`[wh-v2] ${event} ${JSON.stringify(fields || {})}`); } catch (_) { /* never throw from logging */ }
  try { events.push(level || 'info', event, fields); } catch (_) {}
}

const log = {
  emit,
  info: (event, f) => emit(event, f, 'info'),
  warn: (event, f) => emit('warn:' + event, f, 'warn'),
  error: (event, f) => emit('error:' + event, f, 'error'),
  // Step-2 session-management vocabulary (see plan / spec).
  cookieHashChanged: (f) => emit('cookie_hash_changed', f),
  cookieSynchronized: (f) => emit('cookie_synchronized', f),
  verifyStarted: (f) => emit('verify_started', f),
  verifySuccess: (f) => emit('verify_success', f),
  verifyFailed: (f) => emit('verify_failed', f),
  sessionRefreshed: (f) => emit('session_refreshed', f),
  sessionTimerReset: (f) => emit('session_timer_reset', f),
  authenticationFailed: (f) => emit('authentication_failed', f),
  browserNotAuthenticated: (f) => emit('browser_not_authenticated', f),
};

module.exports = log;
