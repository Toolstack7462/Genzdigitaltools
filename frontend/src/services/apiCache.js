import api from './api';

/**
 * Lightweight GET cache + in-flight de-duplication for STABLE data.
 *
 * Two safe wins, opt-in per call:
 *  1) Request coalescing — concurrent identical GETs share ONE network request
 *     instead of each firing their own (kills duplicate requests on a page that
 *     mounts several components needing the same data).
 *  2) Short-TTL cache — a repeated GET within `ttl` ms returns the cached value
 *     instead of re-hitting the backend (kills re-fetch on every navigation for
 *     data that changes rarely, e.g. the CRM client list, tool catalog).
 *
 * Deliberately conservative: default TTL is short, every cache entry is keyed by
 * the full URL, and `invalidate()` lets a mutation drop stale entries immediately.
 * Never use this for per-action / usage / auth-sensitive data — only stable lists.
 */
const cache = new Map();    // key -> { at, data }
const inflight = new Map(); // key -> Promise

const DEFAULT_TTL = 60 * 1000; // 60s

export async function cachedGet(url, { ttl = DEFAULT_TTL, config } = {}) {
  const key = url;
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < ttl) return hit.data;

  // Coalesce concurrent identical requests into one.
  if (inflight.has(key)) return inflight.get(key);

  const p = api.get(url, config)
    .then((res) => {
      cache.set(key, { at: Date.now(), data: res.data });
      return res.data;
    })
    .finally(() => { inflight.delete(key); });

  inflight.set(key, p);
  return p;
}

/** Drop cached entries whose URL contains `fragment` (call after a mutation). */
export function invalidate(fragment) {
  if (!fragment) { cache.clear(); return; }
  for (const key of cache.keys()) {
    if (key.includes(fragment)) cache.delete(key);
  }
}
