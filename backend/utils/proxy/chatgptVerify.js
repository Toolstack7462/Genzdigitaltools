'use strict';
/**
 * ChatGPT (chatgpt.com) account verification — ISOLATED, chatgpt-only.
 *
 * WHY a dedicated verifier: chatgpt.com is Cloudflare-fronted. Its HTML pages get bot-challenged
 * from a datacenter IP, so the generic HTML verifier saw a 403 challenge, returned "unsupported",
 * and verifyAndApply then wrongly marked a perfectly good account BLOCKED (the "unsupported" the
 * operator sees on Verify). chatgpt.com's JSON API passes Cloudflare cleanly and returns a real
 * auth signal, so we verify the stored session cookies against the authenticated session endpoint
 * (default /api/auth/session):
 *   HTTP 200 + a populated `user` (email)         → working
 *   HTTP 200 with no `user` (empty session) / 401 → session_expired  (loggedOut → needs_login)
 *   a genuine Cloudflare challenge / network error / unrecognized shape → unknown (never downgrade)
 *
 * NEVER returns 'unsupported', so a Cloudflare blip never auto-blocks the account. Cookies stay
 * server-side; only safe fields (result, status, MASKED id) are returned; nothing is logged.
 * Reached ONLY when tools.verifyMode('chatgpt') === 'chatgpt_api', so no other tool is touched.
 */
const tools = require('./tools');

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36';
const EMAIL_RE = /[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}/ig;

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
// Authenticated endpoint used to decide logged-in vs logged-out. Overridable via env (no code
// change), e.g. /backend-api/me (401 vs 200). Defaults to the NextAuth session endpoint.
function apiPath() {
  const p = process.env.CHATGPT_API_VERIFY_PATH || '/api/auth/session';
  return p.startsWith('/') ? p : '/' + p;
}
const R = (result, extra = {}) => Object.assign(
  { result, httpStatus: 0, finalPath: apiPath(), redirectedToSignIn: false, loggedOut: false, maskedId: null },
  extra,
);

async function verifyChatgptApi(tool, cookieHeader, expectedIdentifier, opts = {}) {
  const TARGET = tools.targetOrigin(tool); // https://chatgpt.com
  if (!cookieHeader) return R('session_expired', { loggedOut: true, redirectedToSignIn: true });

  let resp;
  try {
    resp = await fetch(TARGET + apiPath(), {
      method: 'GET',
      headers: {
        // Look like a genuine in-app XHR so a captured cf_clearance is honoured by Cloudflare.
        cookie: cookieHeader,
        'user-agent': UA,
        'accept': '*/*',
        'accept-language': 'en-US,en;q=0.9',
        'origin': TARGET,
        'referer': TARGET + '/',
        'sec-fetch-site': 'same-origin',
        'sec-fetch-mode': 'cors',
        'sec-fetch-dest': 'empty',
        'sec-ch-ua': '"Chromium";v="124", "Google Chrome";v="124", "Not-A.Brand";v="99"',
        'sec-ch-ua-mobile': '?0',
        'sec-ch-ua-platform': '"Windows"',
      },
      redirect: 'manual',
      signal: AbortSignal.timeout(12000),
    });
  } catch (_) {
    return R('unknown'); // network/timeout: inconclusive — never downgrade
  }

  const status = resp.status;
  const server = String(resp.headers.get('server') || '');
  const cfMitigated = String(resp.headers.get('cf-mitigated') || '').toLowerCase().includes('challenge');
  const ct = String(resp.headers.get('content-type') || '');

  if (status >= 300 && status < 400) {
    const loc = String(resp.headers.get('location') || '');
    const out = /\/(login|log-?in|sign-?in|auth\/login)\b/i.test(loc);
    return R('session_expired', { httpStatus: status, finalPath: loc || apiPath(), redirectedToSignIn: out, loggedOut: out });
  }
  // A GENUINE Cloudflare interactive challenge (HTML, not the app's JSON) → inconclusive, not blocked.
  if (cfMitigated || (status === 403 && /cloudflare/i.test(server) && /text\/html/i.test(ct))) {
    return R('unknown', { httpStatus: status, reason: 'cf_challenge' });
  }

  let body = '';
  try { body = (await resp.text()).slice(0, 100000); } catch (_) {}
  let data = null;
  try { data = JSON.parse(body); } catch (_) { data = null; }
  const maskedId = extractMaskedIdentifier(body, TARGET);

  if (status >= 200 && status < 300) {
    // /api/auth/session → { user:{email,...}, accessToken, expires } logged in; {WARNING_BANNER} / {} logged out.
    if (data && data.user && (data.user.email || data.user.id)) {
      return R('working', { httpStatus: status, maskedId: maskEmail(data.user.email) || maskedId });
    }
    // /backend-api/me shape → { email, ... } logged in.
    if (data && !data.detail && (data.email || data.id)) {
      return R('working', { httpStatus: status, maskedId: maskEmail(data.email) || maskedId });
    }
    // 200 but no user (empty session / just the warning banner) → logged out.
    return R('session_expired', { httpStatus: status, loggedOut: true });
  }
  if (status === 401 || status === 403) {
    return R('session_expired', { httpStatus: status }); // Unauthorized → the cookies don't authenticate
  }
  // 429 / 5xx → inconclusive, never downgrade.
  return R('unknown', { httpStatus: status, maskedId });
}

module.exports = { verifyChatgptApi };
