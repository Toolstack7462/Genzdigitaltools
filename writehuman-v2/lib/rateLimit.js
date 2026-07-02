'use strict';
/**
 * WriteHuman V2 — lightweight in-process rate limiter (fixed 1-minute window, per key).
 * Dependency-free, bounded memory (periodic GC + a hard cap to survive IP-spoof floods).
 * Best-effort DoS mitigation for the /v2 API — generous by default so legitimate traffic
 * (agent every 60s, admin panel every 20s, overlay /validate) is never affected.
 */
const WINDOW_MS = 60000;
const HARD_CAP = 20000; // max distinct keys tracked; safety valve against memory exhaustion
const buckets = new Map();

// Returns true if this call is allowed. limitPerMin <= 0 disables limiting.
function allow(key, limitPerMin) {
  if (!limitPerMin || limitPerMin <= 0) return true;
  const now = Date.now();
  let b = buckets.get(key);
  if (!b || now >= b.resetAt) { b = { count: 0, resetAt: now + WINDOW_MS }; buckets.set(key, b); }
  b.count += 1;
  if (buckets.size > HARD_CAP) buckets.clear();
  return b.count <= limitPerMin;
}

const _gc = setInterval(() => {
  const now = Date.now();
  for (const [k, b] of buckets) { if (now >= b.resetAt) buckets.delete(k); }
}, 2 * WINDOW_MS);
if (_gc.unref) _gc.unref();

module.exports = { allow, _buckets: buckets };
