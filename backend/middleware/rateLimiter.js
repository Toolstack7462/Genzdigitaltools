const rateLimit = require('express-rate-limit');
const crypto = require('crypto');

/**
 * Real client IP behind Hostinger's CDN/proxy chain (hcdn edge -> LiteSpeed -> Node).
 * Mirrors getClientIp() in middleware/authEnhanced.js.
 *
 * ROOT CAUSE of the recurring generic "Login Failed": the DEFAULT express-rate-limit
 * key is Express's req.ip. Behind Hostinger's CDN, req.ip is the edge-node IP and it
 * ROTATES per request (verified: one client = 175.107.227.3 produced req.ip
 * 194.164.75.140, 2a02:4780:27:1::3, 194.164.75.2). Many unrelated clients funnel
 * through the same few edge IPs, so they SHARE one rate-limit window and trip it
 * collectively — the limiter then returns 429 BEFORE the login handler runs (which is
 * why those failures never produced an [auth:client] attempt log). Keying by the first
 * X-Forwarded-For hop buckets by the REAL visitor, so one client can no longer lock out
 * others. Applied to the auth login limiter ONLY — other limiters are left untouched.
 */
function clientIp(req) {
  const xff = req.headers['x-forwarded-for'];
  return xff ? String(xff).split(',')[0].trim()
             : (req.ip || (req.socket && req.socket.remoteAddress) || 'unknown');
}

/**
 * Rate limiter for authentication routes
 * Prevents brute force attacks
 */
const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 30, // headroom: 10 was too low — legit retries + shared/NAT IPs hit it and got locked out
  message: {
    error: 'Too many login attempts. Please wait a few minutes and try again.'
  },
  standardHeaders: true,
  legacyHeaders: false,
  // Only FAILED attempts count toward the limit. A successful login never consumes the
  // budget, so a normal member (and others sharing the same IP) can never be locked out
  // by their own successful logins — only sustained failures (brute force) are throttled.
  skipSuccessfulRequests: true,
  // Key by the REAL client IP (see clientIp) instead of Express req.ip, which is the
  // rotating/shared Hostinger CDN edge IP and locked unrelated clients out together.
  keyGenerator: clientIp,
  // Disable express-rate-limit v7 dev validations: our custom keyGenerator intentionally
  // reads X-Forwarded-For, which would otherwise emit trust-proxy / IPv6 warnings. This
  // must never throw at startup.
  validate: false
});

/**
 * Strict limiter for sensitive operations
 */
const strictLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 3, // 3 attempts per window
  message: {
    error: 'Too many requests. Please try again after 15 minutes.'
  },
  standardHeaders: true,
  legacyHeaders: false
});

/**
 * General API rate limiter
 */
const apiLimiter = rateLimit({
  windowMs: parseInt(process.env.RATE_LIMIT_WINDOW_MS) || 15 * 60 * 1000,
  max: parseInt(process.env.RATE_LIMIT_MAX_REQUESTS) || 100,
  message: {
    error: 'Too many requests from this IP. Please try again later.',
    code: 'rate_limited'
  },
  standardHeaders: true,
  legacyHeaders: false,
  // Same rotating/shared-CDN-edge-IP problem documented above for authLimiter. The proxy
  // and StealthWriter gateway routers mount this limiter, and their overlays poll
  // /validate every 30s (30 requests per session per window) — so under the DEFAULT
  // req.ip key roughly three concurrent sessions sharing an edge IP exhausted the budget
  // and every further /validate returned 429. Keying by the real visitor stops unrelated
  // clients from consuming each other's budget.
  keyGenerator: clientIp,
  validate: false
});

/**
 * Liveness limiter for the gateway /validate polls.
 *
 * /validate is a cheap, read-mostly lease check that the injected overlay calls every 30s
 * for the whole life of a session, so it must not share the general API budget (that is
 * exactly what produced spurious "Access could not be verified" terminations). It still
 * has a ceiling — a real flood is throttled — but one far above honest polling:
 * 30s polling = 30 req/15min, so 400 leaves headroom for many tabs plus reconnect bursts.
 *
 * A 429 from here is explicitly RETRYABLE (see utils/proxy/validationResponse.js); the
 * overlay backs off and retries rather than ending the session.
 */
const validateLimiter = rateLimit({
  windowMs: parseInt(process.env.VALIDATE_RATE_LIMIT_WINDOW_MS) || 15 * 60 * 1000,
  max: parseInt(process.env.VALIDATE_RATE_LIMIT_MAX) || 400,
  message: {
    error: 'Too many validation requests. Please try again shortly.',
    code: 'rate_limited',
    valid: false,
    terminal: false,
    retryable: true
  },
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: clientIp,
  validate: false
});

/**
 * Per-LEASE key for the proxy gateway router.
 *
 * ROOT CAUSE this exists for. Keying by the real client IP is right for traffic that comes from a
 * BROWSER, but the Claude gateway is the one tool whose backend calls are all server-to-server:
 * the browser cannot read Claude's lease JWT (it holds only an opaque HttpOnly session id), so the
 * overlay calls the GATEWAY and the gateway relays to /validate, /session, /quota-status,
 * /quota-precheck and /usage-report itself. Every one of those presents the gateway server's
 * single, stable egress IP — so under a per-IP key they all collapse into ONE bucket shared by
 * every Claude client at once. Ordinary polling for a SINGLE open tab is ~30 /validate + ~30
 * /quota-status + ~15 /session per 15 minutes plus two calls per message, i.e. it exhausts
 * apiLimiter's 100/15min budget on its own, mid-session. The resulting 429s were then surfaced to
 * clients as a terminal "session ended / Access could not be verified" screen.
 *
 * Every route on that router carries the lease as a Bearer token, which is the correct unit: one
 * bucket per session, no client can consume another's budget, and a real flood is still capped.
 * The token is HASHED, so no credential material can reach a limiter key, a store or a log.
 * Falls back to the real client IP when there is no bearer token (unchanged behaviour).
 */
function leaseKey(req) {
  const auth = req.headers.authorization;
  const tok = (auth && auth.startsWith('Bearer ')) ? auth.slice(7).trim() : null;
  if (!tok) return clientIp(req);
  return 'lease:' + crypto.createHash('sha256').update(tok).digest('hex').slice(0, 32);
}

/**
 * Gateway-only, server-to-server endpoints (/session, /quota-*, /usage-report, /account-expired,
 * /capture-session). These are already authenticated by the shared PROXY_GATEWAY_KEY that only the
 * gateway server holds, so an IP budget adds no security here — it only created the shared-bucket
 * failure above. Keyed per lease with a ceiling far above honest use: a busy tab spends well under
 * 100 per window, so 1200 is ~10x headroom for many tabs and reconnect bursts while still stopping
 * a runaway loop. A 429 from here is explicitly retryable and never ends a session.
 */
const gatewayServiceLimiter = rateLimit({
  windowMs: parseInt(process.env.GATEWAY_SERVICE_RATE_LIMIT_WINDOW_MS) || 15 * 60 * 1000,
  max: parseInt(process.env.GATEWAY_SERVICE_RATE_LIMIT_MAX) || 1200,
  message: {
    ok: false,
    error: 'Too many gateway requests. Please try again shortly.',
    code: 'rate_limited',
    terminal: false,
    retryable: true
  },
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: leaseKey,
  validate: false
});

/**
 * Same budget as validateLimiter, keyed per LEASE instead of per IP — for the proxy gateway
 * router, whose /validate is relayed server-side for Claude (see leaseKey). validateLimiter itself
 * is left exactly as it is, so the StealthWriter router keeps its current per-IP behaviour.
 */
const leaseValidateLimiter = rateLimit({
  windowMs: parseInt(process.env.VALIDATE_RATE_LIMIT_WINDOW_MS) || 15 * 60 * 1000,
  max: parseInt(process.env.VALIDATE_RATE_LIMIT_MAX) || 400,
  message: {
    error: 'Too many validation requests. Please try again shortly.',
    code: 'rate_limited',
    valid: false,
    terminal: false,
    retryable: true
  },
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: leaseKey,
  validate: false
});

/**
 * Registration limiter
 */
const registerLimiter = rateLimit({
  windowMs: 60 * 60 * 1000, // 1 hour
  max: 3, // 3 registrations per hour per IP
  message: {
    error: 'Too many accounts created from this IP. Please try again after an hour.'
  },
  standardHeaders: true,
  legacyHeaders: false
});

module.exports = {
  authLimiter,
  strictLimiter,
  apiLimiter,
  validateLimiter,
  gatewayServiceLimiter,
  leaseValidateLimiter,
  registerLimiter,
  // exported for tests
  leaseKey
};
