'use strict';
/**
 * StealthWriter account cookie verification.
 *
 * Makes ONE server-side request to the authenticated humanizer path using the
 * account's cookie, FOLLOWS redirects, and decides the result from the FINAL path:
 *   - final path is /sign-in (or /login)  → session_expired
 *   - reached the dashboard               → working (or wrong_account if expected
 *                                            identifier mismatches)
 *   - could not reach upstream            → unknown (never falsely "expired")
 *
 * It does NOT decide from body text (a logged-in SPA shell can still contain a
 * "sign in" string) — only an actual redirect to /sign-in means expired. Returns
 * only safe fields: { result, httpStatus, finalPath, redirectedToSignIn, maskedId }.
 * Never logs cookies, tokens or secrets.
 */
const TARGET = (process.env.STEALTH_TARGET_ORIGIN || 'https://stealthwriter.ai').replace(/\/$/, '');
const VERIFY_PATH = process.env.STEALTH_VERIFY_PATH || '/dashboard/humanizer';
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36';
const SIGNIN_RE = /\/(sign-?in|login|auth\/login|account\/login)\b/i;
const EMAIL_RE = /[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}/ig;

function maskEmail(email) {
  if (!email) return null;
  const [local, domain] = String(email).split('@');
  if (!domain) return null;
  const head = local.slice(0, 1) || '*';
  return `${head}${'*'.repeat(Math.max(2, Math.min(local.length - 1, 4)))}@${domain}`;
}
function extractMaskedIdentifier(body) {
  const matches = String(body || '').match(EMAIL_RE);
  if (!matches || matches.length === 0) return null;
  let host = '';
  try { host = new URL(TARGET).hostname.replace(/^www\./, ''); } catch (_) {}
  const external = matches.find(m => host && !m.toLowerCase().endsWith('@' + host) && !m.toLowerCase().includes('.' + host));
  return maskEmail(external || matches[0]);
}

async function verifyAccountCookies(cookieHeader, expectedIdentifier) {
  if (!cookieHeader) {
    return { result: 'session_expired', httpStatus: 0, finalPath: null, redirectedToSignIn: true, maskedId: null };
  }
  let resp;
  try {
    resp = await fetch(TARGET + VERIFY_PATH, {
      method: 'GET',
      headers: { cookie: cookieHeader, 'user-agent': UA, 'accept': 'text/html,application/xhtml+xml' },
      redirect: 'follow',                 // follow so we can read the FINAL path
      signal: AbortSignal.timeout(10000),
    });
  } catch (_) {
    // Upstream unreachable / blocked — never falsely mark expired.
    return { result: 'unknown', httpStatus: 0, finalPath: null, redirectedToSignIn: false, maskedId: null };
  }

  const httpStatus = resp.status;
  let finalPath = VERIFY_PATH;
  try { finalPath = new URL(resp.url).pathname || VERIFY_PATH; } catch (_) {}
  const redirectedToSignIn = SIGNIN_RE.test(finalPath);

  if (redirectedToSignIn) {
    return { result: 'session_expired', httpStatus, finalPath, redirectedToSignIn: true, maskedId: null };
  }

  let body = '';
  try { body = (await resp.text()).slice(0, 200000); } catch (_) {}
  const maskedId = extractMaskedIdentifier(body);

  if (expectedIdentifier) {
    const exp = String(expectedIdentifier).trim().toLowerCase();
    const found = (String(body).match(EMAIL_RE) || []).map(s => s.toLowerCase());
    if (found.length && !found.includes(exp)) {
      return { result: 'wrong_account', httpStatus, finalPath, redirectedToSignIn: false, maskedId };
    }
  }
  return { result: 'working', httpStatus, finalPath, redirectedToSignIn: false, maskedId };
}

module.exports = { verifyAccountCookies, maskEmail };
