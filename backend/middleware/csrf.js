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
 * SHIPS DARK — `LAUNCH_CSRF_ENFORCE=1` turns rejection on; the default validates and logs but
 * does not reject.
 *
 * WHY (learned the hard way, 2026-07-27): the backend auto-deploys on a push to main, while
 * the static frontend deploys separately. Defaulting to enforce meant the new backend started
 * demanding a header that the still-old frontend had no way to send, and every launch 403'd
 * until the frontend caught up. Enforcement is only safe once the frontend that fetches the
 * token is actually being served, so it is an explicit env flip, not a default.
 *
 * TURN IT ON: after the new frontend is live, `SetEnv LAUNCH_CSRF_ENFORCE 1` + restart. Until
 * then the middleware still runs and logs every request it WOULD have blocked, so the flip can
 * be made with evidence rather than hope.
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
  return String(process.env.LAUNCH_CSRF_ENFORCE || '0') === '1';
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
    // Dark mode: log what enforcement WOULD have rejected, so the operator can flip
    // LAUNCH_CSRF_ENFORCE=1 once these stop appearing for legitimate traffic.
    try { console.warn('[csrf] would-block (LAUNCH_CSRF_ENFORCE not 1):', reason, req.method, req.path); } catch (_) {}
    return next();
  }
  // 403 with a machine code the SPA recognises: it refetches a token and retries once, so a
  // token that simply aged out is invisible to the user rather than a failed launch.
  return res.status(403).json({ error: 'Security check failed. Please refresh and try again.', code: 'csrf_invalid', reason });
}

module.exports = { COOKIE_NAME, HEADER_NAME, issue, requireCsrf, enforcing };
