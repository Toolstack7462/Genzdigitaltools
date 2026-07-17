'use strict';
/**
 * Claude (claude.ai) account verification — ISOLATED, claude-only.
 *
 * WHY a dedicated verifier: claude.ai is a Cloudflare-fronted, client-hydrated SPA. Its HTML
 * pages (e.g. /new) are Cloudflare-CACHED shells that can be bot-challenged from a datacenter
 * IP — so the generic HTML verifier saw a 403 challenge, returned "unsupported", and
 * verifyAndApply then wrongly marked a perfectly good account BLOCKED. claude.ai's JSON API,
 * by contrast, passes straight through Cloudflare and returns a CLEAN application-level auth
 * signal. So we verify the stored session cookies against the AUTHENTICATED API endpoint
 * (default /api/organizations):
 *   HTTP 200 + a non-empty org array (or a populated bootstrap account) → working
 *   HTTP 200 { account: null } / 401 / 403 with the app's auth-error JSON → session_expired
 *   a genuine Cloudflare interactive challenge, a network error, or an unrecognized shape
 *     → unknown  (NEVER downgrade a possibly-live account on an inconclusive check)
 *
 * We NEVER return 'unsupported' here, so the account is never auto-blocked by a Cloudflare
 * blip. Cookies stay server-side; only safe fields (result, status, MASKED id) are returned,
 * and no cookie/token value is ever logged. Reached ONLY when tools.verifyMode('claude') ===
 * 'claude_api', so no other tool's verification is touched.
 */
const tools = require('./tools');

// Match the gateway + generic verifier UA so a cf_clearance captured in-context stays valid.
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36';
const EMAIL_RE = /[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}/ig;

function maskEmail(email) {
  if (!email) return null;
  const [local, domain] = String(email).split('@');
  if (!domain) return null;
  const head = local.slice(0, 1) || '*';
  return `${head}${'*'.repeat(Math.max(2, Math.min(local.length - 1, 4)))}@${domain}`;
}

// Best-effort masked identifier from a response body (never a raw value to the frontend).
function extractMaskedIdentifier(body, targetOrigin) {
  const matches = String(body || '').match(EMAIL_RE);
  if (!matches || matches.length === 0) return null;
  let host = '';
  try { host = new URL(targetOrigin).hostname.replace(/^www\./, ''); } catch (_) {}
  const external = matches.find(m => host && !m.toLowerCase().endsWith('@' + host) && !m.toLowerCase().includes('.' + host));
  return maskEmail(external || matches[0]);
}

// The authenticated endpoint used to decide logged-in vs logged-out. Overridable via env
// (no code change) if claude.ai ever moves it. Defaults to the canonical org-list API.
function apiPath() {
  const p = process.env.CLAUDE_API_VERIFY_PATH || '/api/organizations';
  return p.startsWith('/') ? p : '/' + p;
}

// ── Best-effort PLAN detection (advisory) ────────────────────────────────────
// "Detect Claude Pro / Max 5x / Max 20x when reliable information is available." claude.ai's
// authenticated payloads sometimes carry a rate-limit tier / billing hint (e.g. a string like
// "default_claude_max_20x", "claude_max_5x", "claude_pro"). We scan the JSON + raw body for a
// CONFIDENT signal and return one of 'pro' | 'max5' | 'max20', or null when nothing reliable is
// present (→ the operator sets the plan manually). Never returns anything but a plan key; reads
// no secret. Pure + unit-testable. Order matters: 20x before 5x before pro (most specific first).
function detectPlan(data, rawBody) {
  const hay = [];
  try { hay.push(JSON.stringify(data || null)); } catch (_) {}
  if (typeof rawBody === 'string') hay.push(rawBody.slice(0, 100000));
  const s = hay.join(' ').toLowerCase();
  if (!s) return null;
  if (/max[\s_-]*20\s*x?|20\s*x\s*max|claude[\s_-]*max[\s_-]*20/.test(s)) return 'max20';
  if (/max[\s_-]*5\s*x?|5\s*x\s*max|claude[\s_-]*max[\s_-]*5/.test(s)) return 'max5';
  // A bare "claude_max" (no multiplier) is ambiguous — treat as the entry Max tier (5x).
  if (/claude[\s_-]*max\b|"max"|_max_|\bmax_tier\b/.test(s)) return 'max5';
  if (/claude[\s_-]*pro\b|"pro"|_pro_|\bpro_tier\b|raven_pro/.test(s)) return 'pro';
  return null;
}

// Recognise claude.ai's application-level "not authenticated" error JSON.
function isAuthError(err) {
  if (!err || typeof err !== 'object') return false;
  const type = String(err.type || '').toLowerCase();
  const code = String((err.details && err.details.error_code) || '').toLowerCase();
  const msg = String(err.message || '').toLowerCase();
  return /permission_error|authentication_error|unauthorized|invalid_request/.test(type)
    || /session_invalid|account_session_invalid|unauthenticated|not_authenticated|invalid_api_key/.test(code)
    || /invalid authorization|not authenticated|please (log|sign) ?in/.test(msg);
}

const R = (result, extra = {}) => Object.assign(
  { result, httpStatus: 0, finalPath: apiPath(), redirectedToSignIn: false, loggedOut: false, maskedId: null },
  extra,
);

/**
 * Returns the same safe shape as verify.js's verifyAccountCookies:
 *   { result, httpStatus, finalPath, redirectedToSignIn, loggedOut, maskedId, [title] }
 * result ∈ { working | session_expired | unknown }.  (loggedOut splits session_expired into
 * "needs_login" downstream in verifyAndApply.)
 */
async function verifyClaudeApi(tool, cookieHeader, expectedIdentifier, opts = {}) {
  const TARGET = tools.targetOrigin(tool); // https://claude.ai
  if (!cookieHeader) return R('session_expired', { loggedOut: true, redirectedToSignIn: true });

  let resp;
  try {
    resp = await fetch(TARGET + apiPath(), {
      method: 'GET',
      headers: {
        // Look like a genuine claude.ai in-app XHR so a vault cf_clearance (minted through the
        // gateway from THIS server's egress) is honoured by Cloudflare. Without a valid
        // cf_clearance the request is challenged → classified 'unknown' below (never blocked).
        cookie: cookieHeader,
        'user-agent': UA,
        'accept': '*/*',
        'accept-language': 'en-US,en;q=0.9',
        'origin': TARGET,
        'referer': TARGET + '/',
        'anthropic-client-platform': 'web_claude_ai',
        'sec-fetch-site': 'same-origin',
        'sec-fetch-mode': 'cors',
        'sec-fetch-dest': 'empty',
        'sec-ch-ua': '"Chromium";v="124", "Google Chrome";v="124", "Not-A.Brand";v="99"',
        'sec-ch-ua-mobile': '?0',
        'sec-ch-ua-platform': '"Windows"',
      },
      redirect: 'manual', // a 302 to /login means logged-out — don't follow into the HTML shell
      signal: AbortSignal.timeout(12000),
    });
  } catch (_) {
    return R('unknown'); // network/timeout: inconclusive — never downgrade
  }

  const status = resp.status;
  const server = String(resp.headers.get('server') || '');
  const cfMitigated = String(resp.headers.get('cf-mitigated') || '').toLowerCase().includes('challenge');
  const ct = String(resp.headers.get('content-type') || '');

  // A redirect to the sign-in page = the session is logged out.
  if (status >= 300 && status < 400) {
    const loc = String(resp.headers.get('location') || '');
    const out = /\/(login|log-?in|sign-?in)\b/i.test(loc);
    return R('session_expired', { httpStatus: status, finalPath: loc || apiPath(), redirectedToSignIn: out, loggedOut: out });
  }

  // A GENUINE Cloudflare interactive challenge (HTML, not the app's JSON auth error) is
  // inconclusive from the server — never block a good account on it.
  if (cfMitigated || (status === 403 && /cloudflare/i.test(server) && /text\/html/i.test(ct))) {
    return R('unknown', { httpStatus: status, reason: 'cf_challenge' });
  }

  let body = '';
  try { body = (await resp.text()).slice(0, 100000); } catch (_) {}
  let data = null;
  try { data = JSON.parse(body); } catch (_) { data = null; }
  const maskedId = extractMaskedIdentifier(body, TARGET);

  if (status >= 200 && status < 300) {
    // /api/organizations → a JSON array of orgs (each with a uuid) when authenticated.
    if (Array.isArray(data)) {
      if (data.length > 0 && data.some(o => o && (o.uuid || o.id))) {
        const orgName = (data.find(o => o && o.name) || {}).name || null;
        return R('working', { httpStatus: status, maskedId, title: orgName, plan: detectPlan(data, body) });
      }
      return R('session_expired', { httpStatus: status, loggedOut: true }); // authed shell w/ no orgs → treat as logged out
    }
    // bootstrap-style { account: {...} } populated → working; { account: null } / auth error → logged out.
    if (data && data.account && (data.account.uuid || data.account.email_address)) {
      return R('working', { httpStatus: status, maskedId: maskEmail(data.account.email_address) || maskedId, plan: detectPlan(data, body) });
    }
    if (data && (data.account === null || isAuthError(data.error))) {
      return R('session_expired', { httpStatus: status, loggedOut: true });
    }
    return R('unknown', { httpStatus: status, maskedId }); // 200 but unrecognized → inconclusive
  }

  if (status === 401 || status === 403) {
    if (data && isAuthError(data.error)) {
      return R('session_expired', { httpStatus: status }); // cookies present but rejected → expired
    }
    return R('unknown', { httpStatus: status, maskedId }); // 403 w/o a clear auth error → inconclusive
  }

  // 429 rate-limit / 5xx upstream → inconclusive, never downgrade.
  return R('unknown', { httpStatus: status, maskedId });
}

module.exports = { verifyClaudeApi, detectPlan };
