'use strict';
/**
 * One-time POST launch bootstrap — code format, hashing and rollout policy.
 *
 * WHY THIS EXISTS
 * The original launch flow handed the browser a gateway URL with the signed lease JWT in
 * the query string (`/gateway?lease=<JWT>`). That put a bearer credential into the address
 * bar, browser history, the Referer header of the first upstream request, and any proxy or
 * access log in between — and the JWT itself carries the client id, tool and account id as
 * readable claims. This module replaces that carrier with a value that is worthless the
 * moment it is used:
 *
 *   • 256 bits of CSPRNG entropy, base64url — never derived from anything guessable.
 *   • Travels ONLY in a POST body (dashboard → gateway), never in a URL.
 *   • Lives 30–60 seconds, single use, redeemed atomically (see utils/launchStore.js).
 *   • Stored server-side as a SHA-256 hash, never in plaintext — a database read cannot
 *     replay a launch, exactly like the existing lease `tokenHash` rule.
 *
 * The launch code authorizes ONE exchange for a lease that has already passed every
 * existing authorization check. It grants nothing on its own and is never an alternative
 * to the lease: the gateway still calls the backend, and the backend still re-validates
 * the client, plan, expiry and revocation state at redemption time.
 *
 * NEVER log a raw code. `ref()` exists for the rare case a log line needs to correlate.
 */
const crypto = require('crypto');

const CODE_BYTES = 32;   // 256 bits
// The MySQL adapter's primary key column is VARCHAR(32), and we use the code's hash AS the
// row id so that redemption can be a single atomic DELETE-by-primary-key (see launchStore).
// 128 bits of a SHA-256 digest is the addressable part; the FULL digest is also stored in
// the row and compared in constant time, so a truncation collision still cannot redeem
// someone else's code.
const ID_CHARS = 32;

// The spec range. A code only has to survive the round trip from the dashboard's fetch
// response to the browser submitting the form, so this is deliberately tight.
const TTL_MIN_SECONDS = 30;
const TTL_MAX_SECONDS = 60;
const TTL_DEFAULT_SECONDS = 45;

function ttlSeconds() {
  const raw = parseInt(process.env.LAUNCH_CODE_TTL_SECONDS, 10);
  if (!Number.isFinite(raw)) return TTL_DEFAULT_SECONDS;
  return Math.min(TTL_MAX_SECONDS, Math.max(TTL_MIN_SECONDS, raw));
}

function generate() {
  return crypto.randomBytes(CODE_BYTES).toString('base64url');
}

/** Full SHA-256 hex digest — stored in the row and compared in constant time. */
function fullHash(code) {
  return crypto.createHash('sha256').update(String(code)).digest('hex');
}

/** The row id: the first 128 bits of the digest (the adapter's id column is VARCHAR(32)). */
function idOf(code) {
  return fullHash(code).slice(0, ID_CHARS);
}

/** Constant-time hex-digest comparison (never `===`, which leaks position on mismatch). */
function hashesEqual(a, b) {
  const x = Buffer.from(String(a || ''), 'utf8');
  const y = Buffer.from(String(b || ''), 'utf8');
  if (x.length !== y.length || x.length === 0) return false;
  return crypto.timingSafeEqual(x, y);
}

// Reject anything that is not shaped like one of our codes BEFORE it reaches the database,
// so a junk/oversized value costs a regex instead of a query.
const CODE_RE = /^[A-Za-z0-9_-]{40,64}$/;
function looksValid(code) {
  return typeof code === 'string' && CODE_RE.test(code);
}

/** A short, non-reversible reference for correlating logs. NEVER the code itself. */
function ref(code) {
  if (!code) return null;
  return fullHash(code).slice(0, 8);
}

// ── Rollout / rollback flags ────────────────────────────────────────────────────────────
// SHIPS DARK. The default is the ORIGINAL `?lease=` URL flow, and the POST bootstrap is
// switched on with `LAUNCH_FLOW=post` once the frontend and both gateways are live.
//
// WHY (learned the hard way, 2026-07-27): this change spans THREE deploy surfaces that do not
// deploy atomically — the backend (auto-deploys on a push to main), the static frontend, and
// the two gateway apps. Defaulting to `post` meant the backend went live minutes after the
// push while the old frontend was still being served: the old frontend sends no CSRF header
// and does not understand the `launch` response, so every Claude/StealthWriter launch broke
// until the other two surfaces caught up. A feature whose surfaces cannot deploy together must
// default OFF and be turned on by env afterwards. Never re-default this to 'post'.
//
//   LAUNCH_FLOW          'url' (default) | 'post'   — global master switch
//   LAUNCH_FLOW_TOOLS    comma list of proxy tools on the POST flow (default: claude)
//   STEALTH_LAUNCH_FLOW  'post' (default) | 'url'   — StealthWriter, UNDER the master switch
//
// Every proxy tool NOT named in LAUNCH_FLOW_TOOLS keeps the exact URL flow it has today —
// that is what keeps HIX / BypassGPT / Grok / ChatGPT / Ryne / WriteHuman untouched.
const DEFAULT_POST_TOOLS = 'claude';

function globalFlow() {
  return String(process.env.LAUNCH_FLOW || 'url').trim().toLowerCase() === 'post' ? 'post' : 'url';
}

function postToolSet() {
  const raw = process.env.LAUNCH_FLOW_TOOLS === undefined ? DEFAULT_POST_TOOLS : process.env.LAUNCH_FLOW_TOOLS;
  return new Set(String(raw).split(',').map(s => s.trim().toLowerCase()).filter(Boolean));
}

/**
 * Is the one-time POST bootstrap active for this module/tool?
 * @param {'proxy'|'stealth'} moduleKey
 * @param {string} [tool] proxy tool key (ignored for the stealth module)
 */
function postFlowEnabled(moduleKey, tool) {
  if (globalFlow() === 'url') return false;
  if (moduleKey === 'stealth') {
    return String(process.env.STEALTH_LAUNCH_FLOW || 'post').trim().toLowerCase() !== 'url';
  }
  if (moduleKey === 'proxy') return postToolSet().has(String(tool || '').toLowerCase());
  return false;
}

module.exports = {
  CODE_BYTES, ID_CHARS, TTL_MIN_SECONDS, TTL_MAX_SECONDS, TTL_DEFAULT_SECONDS,
  ttlSeconds, generate, fullHash, idOf, hashesEqual, looksValid, ref,
  globalFlow, postToolSet, postFlowEnabled,
};
