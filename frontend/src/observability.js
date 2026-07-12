// Lightweight, dependency-free global error capture.
//
// Records the last N uncaught errors + unhandled promise rejections into an in-memory ring buffer
// exposed at window.__APP_ERRORS__, and logs a tagged console line. No PII is transmitted and NO
// network calls are made — this is a safe foundation an operator can inspect after an incident
// ("open devtools console → window.__APP_ERRORS__") and later wire to Sentry / a backend endpoint.
const MAX = 25;
const buffer = [];

function record(kind, message, extra) {
  try {
    const entry = { kind, message: String(message == null ? 'unknown' : message).slice(0, 500), at: new Date().toISOString(), ...extra };
    buffer.push(entry);
    if (buffer.length > MAX) buffer.shift();
    window.__APP_ERRORS__ = buffer.slice();
    console.warn('[app-error]', kind + ':', entry.message);
  } catch (_) { /* never let error-capture throw */ }
}

export function initObservability() {
  if (typeof window === 'undefined' || window.__obsInit) return;
  window.__obsInit = true;

  // Uncaught runtime errors. Resource-load errors (img/script) fire with no message → ignore them.
  window.addEventListener('error', (e) => {
    if (e && e.message) record('error', e.message, { src: e.filename || null, line: e.lineno || null, col: e.colno || null });
  });

  // Unhandled promise rejections.
  window.addEventListener('unhandledrejection', (e) => {
    const r = e && e.reason;
    record('unhandledrejection', (r && (r.message || r)) || 'unknown');
  });
}
