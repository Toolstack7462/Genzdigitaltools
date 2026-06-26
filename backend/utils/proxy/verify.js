'use strict';
/**
 * Proxy-tool account cookie verification (HIX / BypassGPT). Isolated copy of the
 * StealthWriter verifier, parameterized by tool.
 *
 * Makes ONE server-side request to the tool's authenticated path with the account's
 * cookie, FOLLOWS redirects, and decides from the FINAL path:
 *   - final path is /sign-in (or /login)  → session_expired
 *   - reached the app                      → working (or wrong_account on mismatch)
 *   - could not reach upstream             → unknown (never falsely "expired")
 *
 * Returns only safe fields. Never logs cookies, tokens or secrets.
 */
const tools = require('./tools');

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36';
const SIGNIN_RE = /\/(sign-?in|log-?in|auth\/login|account\/login)\b/i;
const EMAIL_RE = /[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}/ig;

// ── Content-based logged-out heuristic ───────────────────────────────────────
// Some tools (WriteHuman, Ryne) serve their PUBLIC marketing page at the default path
// with HTTP 200 (no redirect to /sign-in) when the session is dead — so status/redirect
// alone reads it as "working". A logged-out marketing page reliably shows BOTH a sign-in
// and a sign-up/get-started CTA and has NO logout/account control; a logged-in app shell
// has a logout/account control (and no sign-up CTA). Requiring all three signals keeps
// this from ever flagging a genuinely logged-in editor. Used ONLY for tools that opt in
// via tools.shouldDetectLoggedOut(), so other tools are unaffected.
const LOGIN_CTA_RE  = /(log\s*in|sign\s*in)\b/i;
const SIGNUP_CTA_RE = /(sign\s*up|get\s*started|start\s*(for\s*)?free|try\s*(it\s*)?free|create\s*(an\s*)?account)\b/i;
const LOGOUT_CTRL_RE = /(log\s*out|sign\s*out|\/logout|my\s*account|account\s*settings|data-testid="[^"]*account|aria-label="[^"]*log\s*out)/i;
function looksLoggedOut(body) {
  const html = String(body || '');
  if (LOGOUT_CTRL_RE.test(html)) return false;          // a logout/account control → logged in
  return LOGIN_CTA_RE.test(html) && SIGNUP_CTA_RE.test(html);
}

// Safe, public-only page signals to help an admin SEE which account/plan the stored
// cookies actually load — never any cookie/token/secret. Title is public; plan flags are
// keyword presence; loggedOut is the heuristic above.
function pageDiagnostics(body) {
  const s = String(body || '');
  const tm = s.match(/<title[^>]*>([\s\S]{0,120}?)<\/title>/i);
  return {
    title: tm ? tm[1].replace(/\s+/g, ' ').trim() : null,
    loggedOut: looksLoggedOut(s),
    plan: {
      free: /\bfree\b/i.test(s), pro: /\bpro\b/i.test(s), premium: /\bpremium\b/i.test(s),
      unlimited: /\bunlimited\b/i.test(s), upgrade: /\bupgrade\b/i.test(s),
    },
  };
}

function maskEmail(email) {
  if (!email) return null;
  const [local, domain] = String(email).split('@');
  if (!domain) return null;
  const head = local.slice(0, 1) || '*';
  return `${head}${'*'.repeat(Math.max(2, Math.min(local.length - 1, 4)))}@${domain}`;
}

function extractMaskedIdentifier(body, targetOrigin) {
  const matches = String(body || '').match(EMAIL_RE);
  if (!matches || matches.length === 0) return null;
  let host = '';
  try { host = new URL(targetOrigin).hostname.replace(/^www\./, ''); } catch (_) {}
  const external = matches.find(m => host && !m.toLowerCase().endsWith('@' + host) && !m.toLowerCase().includes('.' + host));
  return maskEmail(external || matches[0]);
}

async function verifyAccountCookies(tool, cookieHeader, expectedIdentifier) {
  const TARGET = tools.targetOrigin(tool);
  const VERIFY_PATH = tools.verifyPath(tool);

  if (!cookieHeader) {
    return { result: 'session_expired', httpStatus: 0, finalPath: null, redirectedToSignIn: true, maskedId: null };
  }
  let resp;
  try {
    resp = await fetch(TARGET + VERIFY_PATH, {
      method: 'GET',
      headers: { cookie: cookieHeader, 'user-agent': UA, 'accept': 'text/html,application/xhtml+xml' },
      redirect: 'follow',
      signal: AbortSignal.timeout(10000),
    });
  } catch (_) {
    return { result: 'unknown', httpStatus: 0, finalPath: null, redirectedToSignIn: false, maskedId: null };
  }

  const httpStatus = resp.status;
  let finalPath = VERIFY_PATH;
  try { finalPath = new URL(resp.url).pathname || VERIFY_PATH; } catch (_) {}
  const redirectedToSignIn = SIGNIN_RE.test(finalPath);

  if (redirectedToSignIn) {
    return { result: 'session_expired', httpStatus, finalPath, redirectedToSignIn: true, maskedId: null };
  }

  // The upstream is behind an anti-bot challenge (e.g. Cloudflare's interactive managed
  // challenge) that a server-side proxy cannot legitimately pass — report it honestly as
  // 'unsupported' instead of a misleading 'working' on a 403. We never try to bypass it.
  const cfMitigated = String(resp.headers.get('cf-mitigated') || '').toLowerCase().includes('challenge');
  const cfServer = /cloudflare/i.test(resp.headers.get('server') || '');
  const ctHeader = String(resp.headers.get('content-type') || '');
  if (cfMitigated || (httpStatus === 403 && cfServer && /text\/html/i.test(ctHeader))) {
    return { result: 'unsupported', httpStatus, finalPath, redirectedToSignIn: false, maskedId: null };
  }

  let body = '';
  try { body = (await resp.text()).slice(0, 200000); } catch (_) {}
  const maskedId = extractMaskedIdentifier(body, TARGET);

  // Logged-out marketing page served at the default path with 200 (no sign-in redirect).
  // Only for opted-in tools, and only when the page clearly shows a logged-out shell.
  if (tools.shouldDetectLoggedOut(tool) && httpStatus >= 200 && httpStatus < 300 && looksLoggedOut(body)) {
    return { result: 'session_expired', httpStatus, finalPath, redirectedToSignIn: false, maskedId: null };
  }

  const diag = pageDiagnostics(body);
  if (expectedIdentifier) {
    const exp = String(expectedIdentifier).trim().toLowerCase();
    const found = (String(body).match(EMAIL_RE) || []).map(s => s.toLowerCase());
    if (found.length && !found.includes(exp)) {
      return { result: 'wrong_account', httpStatus, finalPath, redirectedToSignIn: false, maskedId, ...diag };
    }
  }
  return { result: 'working', httpStatus, finalPath, redirectedToSignIn: false, maskedId, ...diag };
}

module.exports = { verifyAccountCookies, maskEmail, pageDiagnostics };
