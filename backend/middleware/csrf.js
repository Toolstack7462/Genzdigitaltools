'use strict';
/**
 * CSRF protection for tool-launch requests.
 *
 * WHY THIS IS NEEDED HERE
 * The dashboard authenticates with cookies (`clientAccessToken` / `adminAccessToken`) and
 * those cookies are `SameSite=None` in production, because the SPA on
 * app.genzdigitalstore.com talks to api.genzdigitalstore.com cross-site. CORS stops an
 * attacker READING a response, but it does not stop a request being SENT: a plain
 * <form method="POST"> is a "simple request", so it is never preflighted and it arrives at
 * the API with the victim's cookies attached. Before this middleware, any page a logged-in
 * client visited could silently force `POST /client/proxy-tools/claude/open` — burning
 * leases, consuming the shared Claude token allowance and bumping account usage counters.
 *
 * DESIGN — double-submit, with the token delivered out of band
 *   • `GET /client/launch/csrf` mints 256 random bits, sets it as an HttpOnly cookie and
 *     ALSO returns it in the JSON body.
 *   • The SPA keeps that value in memory (never localStorage/sessionStorage) and sends it
 *     as the `X-CSRF-Token` header on launch requests.
 *   • This middleware requires header and cookie to match, in constant time.
 *
 * That is two independent barriers: an attacker cannot read the JSON body (CORS blocks it)
 * and cannot set a custom header on a simple request (adding one forces a preflight, which
 * the origin allowlist rejects). The cookie is HttpOnly, so page script on another origin
 * cannot lift it either.
 *
 * ROLLOUT NOTE: deploy the FRONTEND FIRST. A new frontend against an old backend just gets
 * a 404 from the token endpoint, sends no header, and the old backend does not care. The
 * reverse order would 403 every launch. `LAUNCH_CSRF_ENFORCE=0` is the emergency release
 * valve — it keeps validating and logging but stops rejecting.
 */
const crypto = require('crypto');

const COOKIE_NAME = process.env.NODE_ENV === 'production' ? '__Secure-genz_csrf' : 'genz_csrf';
const HEADER_NAME = 'x-csrf-token';
const TOKEN_BYTES = 32;
// Long enough that a dashboard tab left open all day still launches without a refetch; the
// token is not a credential on its own, so its lifetime is not a security boundary.
const MAX_AGE_MS = 12 * 60 * 60 * 1000;

function cookieOpts() {
  return {
    httpOnly: true,
    maxAge: MAX_AGE_MS,
    // Must match the auth cookies: the SPA and the API are different hosts in production.
    sameSite: process.env.NODE_ENV === 'production' ? 'none' : 'lax',
    secure: process.env.NODE_ENV === 'production',
    path: '/',
  };
}

function enforcing() {
  return String(process.env.LAUNCH_CSRF_ENFORCE || '1') !== '0';
}

function equal(a, b) {
  const x = Buffer.from(String(a || ''), 'utf8');
  const y = Buffer.from(String(b || ''), 'utf8');
  if (x.length !== y.length || x.length === 0) return false;
  return crypto.timingSafeEqual(x, y);
}

/**
 * Mint (or re-mint) the token, set the cookie, and return the value for the JSON body.
 * Re-minting on every call is intentional and cheap: it keeps a stale tab from pinning an
 * old value, and a token is only ever compared against the cookie set in the same response.
 */
function issue(res) {
  const token = crypto.randomBytes(TOKEN_BYTES).toString('base64url');
  res.cookie(COOKIE_NAME, token, cookieOpts());
  return token;
}

/**
 * Reject a state-changing request whose `X-CSRF-Token` header does not match the cookie.
 * The token value itself is NEVER logged — only the reason.
 */
function requireCsrf(req, res, next) {
  const header = String(req.headers[HEADER_NAME] || '');
  const cookie = (req.cookies && req.cookies[COOKIE_NAME]) || '';

  let reason = null;
  if (!header) reason = 'csrf_header_missing';
  else if (!cookie) reason = 'csrf_cookie_missing';
  else if (!equal(header, cookie)) reason = 'csrf_mismatch';

  if (!reason) return next();

  if (!enforcing()) {
    try { console.warn('[csrf] would-block (LAUNCH_CSRF_ENFORCE=0):', reason, req.method, req.path); } catch (_) {}
    return next();
  }
  // 403 with a machine code the SPA recognises: it refetches a token and retries once, so a
  // token that simply aged out is invisible to the user rather than a failed launch.
  return res.status(403).json({ error: 'Security check failed. Please refresh and try again.', code: 'csrf_invalid', reason });
}

module.exports = { COOKIE_NAME, HEADER_NAME, issue, requireCsrf, enforcing };
