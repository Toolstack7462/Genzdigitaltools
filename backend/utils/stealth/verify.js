'use strict';
/**
 * StealthWriter account cookie verification.
 *
 * Makes ONE server-side request to the StealthWriter origin using the account's
 * cookie bundle and classifies the result into a SAFE enum. It NEVER logs cookies,
 * tokens or secrets — it returns only { result, maskedId, httpStatus }.
 *
 * Detection is heuristic (StealthWriter's exact markers aren't known here) and the
 * patterns are overridable via env so they can be tuned without code changes:
 *   STEALTH_TARGET_ORIGIN   (default https://stealthwriter.ai)
 *   STEALTH_VERIFY_PATH     (default /dashboard)
 *   STEALTH_VERIFY_LOGIN_RE / _LIMIT_RE / _BLOCK_RE  (optional regex sources)
 *
 * Results: working | session_expired | limit_reached | wrong_account | blocked
 */
const TARGET = (process.env.STEALTH_TARGET_ORIGIN || 'https://stealthwriter.ai').replace(/\/$/, '');
const VERIFY_PATH = process.env.STEALTH_VERIFY_PATH || '/dashboard';

const LOGIN_RE = process.env.STEALTH_VERIFY_LOGIN_RE
  ? new RegExp(process.env.STEALTH_VERIFY_LOGIN_RE, 'i')
  : /(type=["']?password|name=["']?password|forgot[ -]?password|>\s*(log|sign)\s*in\b)/i;
const LIMIT_RE = process.env.STEALTH_VERIFY_LIMIT_RE
  ? new RegExp(process.env.STEALTH_VERIFY_LIMIT_RE, 'i')
  : /(limit reached|word limit|out of (words|credits)|quota (exceeded|reached)|upgrade to continue)/i;
const BLOCK_RE = process.env.STEALTH_VERIFY_BLOCK_RE
  ? new RegExp(process.env.STEALTH_VERIFY_BLOCK_RE, 'i')
  : /(account (suspended|banned|blocked|disabled)|access denied|you (have been|are) (banned|blocked))/i;

const EMAIL_RE = /[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}/ig;

function maskEmail(email) {
  if (!email) return null;
  const [local, domain] = String(email).split('@');
  if (!domain) return null;
  const head = local.slice(0, 1) || '*';
  return `${head}${'*'.repeat(Math.max(2, Math.min(local.length - 1, 4)))}@${domain}`;
}

// Pick the most likely "user" email — prefer one NOT on the target's own domain.
function extractMaskedIdentifier(body) {
  const matches = String(body || '').match(EMAIL_RE);
  if (!matches || matches.length === 0) return null;
  let targetHost = '';
  try { targetHost = new URL(TARGET).hostname.replace(/^www\./, ''); } catch (_) {}
  const external = matches.find(m => targetHost && !m.toLowerCase().endsWith('@' + targetHost) && !m.toLowerCase().includes('.' + targetHost));
  return maskEmail(external || matches[0]);
}

async function verifyAccountCookies(cookieHeader, expectedIdentifier) {
  if (!cookieHeader) return { result: 'session_expired', httpStatus: 0, maskedId: null };
  let resp;
  try {
    resp = await fetch(TARGET + VERIFY_PATH, {
      method: 'GET',
      headers: {
        cookie: cookieHeader,
        'user-agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36',
        'accept': 'text/html,application/xhtml+xml',
      },
      redirect: 'manual',
      signal: AbortSignal.timeout(8000),
    });
  } catch (_) {
    return { result: 'session_expired', httpStatus: 0, maskedId: null };
  }

  const status = resp.status;
  const loc = resp.headers.get('location') || '';

  if (status >= 300 && status < 400 && /login|sign-?in|auth|account\/login/i.test(loc)) {
    return { result: 'session_expired', httpStatus: status, maskedId: null };
  }
  if (status === 401) return { result: 'session_expired', httpStatus: 401, maskedId: null };
  if (status === 403) return { result: 'blocked', httpStatus: 403, maskedId: null };

  let body = '';
  try { body = (await resp.text()).slice(0, 200000); } catch (_) {}

  if (BLOCK_RE.test(body)) return { result: 'blocked', httpStatus: status, maskedId: null };
  if (LIMIT_RE.test(body)) return { result: 'limit_reached', httpStatus: status, maskedId: extractMaskedIdentifier(body) };
  if (status < 300 && LOGIN_RE.test(body)) return { result: 'session_expired', httpStatus: status, maskedId: null };

  const maskedId = extractMaskedIdentifier(body);
  if (expectedIdentifier) {
    const exp = String(expectedIdentifier).trim().toLowerCase();
    const found = (String(body).match(EMAIL_RE) || []).map(s => s.toLowerCase());
    if (found.length && !found.includes(exp)) {
      return { result: 'wrong_account', httpStatus: status, maskedId };
    }
  }
  return { result: 'working', httpStatus: status, maskedId };
}

module.exports = { verifyAccountCookies, maskEmail };
