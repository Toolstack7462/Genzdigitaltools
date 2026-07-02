'use strict';
/**
 * WriteHuman V2 — in-memory event ring buffer + pub/sub for the admin dashboard.
 * Feeds the live log tail (recent()) and the SSE stream (subscribe()). Bounded memory.
 * Never stores secrets (log.js only ever emits counts/ids/masked values).
 */
const MAX = 300;
const ring = [];
let seq = 0;
const subs = new Set(); // Set<fn(event)>

function push(level, event, fields) {
  const e = { seq: ++seq, t: new Date().toISOString(), level: level || 'info', event: String(event || ''), fields: fields || {} };
  ring.push(e);
  if (ring.length > MAX) ring.shift();
  for (const fn of subs) { try { fn(e); } catch (_) {} }
  return e;
}

function recent(limit) {
  const n = Math.max(1, Math.min(MAX, limit || 100));
  return ring.slice(-n);
}

// Returns an unsubscribe function.
function subscribe(fn) { subs.add(fn); return () => subs.delete(fn); }

module.exports = { push, recent, subscribe, MAX };
