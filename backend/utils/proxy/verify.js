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

  // Per-tool verify mode that does NOT scrape the tool's HTML page (WriteHuman → Supabase
  // refresh-token exchange). Other tools have no verifyMode and fall through unchanged.
  if (tools.verifyMode && tools.verifyMode(tool) === 'supabase_refresh') {
    return verifySupabaseRefresh(tool, cookieHeader, expectedIdentifier);
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

// ── Supabase refresh-token verify (opt-in per tool; WriteHuman) ───────────────
// Pull the Supabase session's refresh_token out of the cookie header and read the account
// email (for masking only). The @supabase/ssr cookie `sb-<ref>-auth-token` holds the session
// JSON — usually `base64-<base64url(json)>`, and may be split across `.0`/`.1`/… chunks that
// must be concatenated in order. Values are preserved exactly by the cookie builder; we only
// decode here. Returns { refreshToken, email } (either may be null). Never logs any token.
function extractSupabaseSession(cookieHeader, projectRef) {
  try {
    const base = 'sb-' + String(projectRef || '') + '-auth-token';
    const pairs = String(cookieHeader || '').split(';').map(s => s.trim()).filter(Boolean);
    let whole = null;
    const chunks = [];
    for (const p of pairs) {
      const i = p.indexOf('='); if (i < 0) continue;
      const name = p.slice(0, i).trim();
      const val = p.slice(i + 1);
      if (name === base) whole = val;
      else if (name.startsWith(base + '.')) {
        const idx = parseInt(name.slice(base.length + 1), 10);
        if (Number.isFinite(idx)) chunks.push([idx, val]);
      }
    }
    let raw = whole;
    if (chunks.length) { chunks.sort((a, b) => a[0] - b[0]); raw = chunks.map(c => c[1]).join(''); }
    if (!raw) return { refreshToken: null, email: null };
    // The value may be URL-encoded (e.g. captured from a Cookie header).
    if (/%[0-9A-Fa-f]{2}/.test(raw)) { try { raw = decodeURIComponent(raw); } catch (_) {} }
    let json = raw;
    if (raw.startsWith('base64-')) {
      const b = raw.slice(7).replace(/-/g, '+').replace(/_/g, '/');
      try { json = Buffer.from(b, 'base64').toString('utf8'); } catch (_) { json = raw; }
    }
    const rt = json.match(/"refresh_token":"([^"]+)"/);
    const at = json.match(/"access_token":"([^"]+)"/);
    const em = json.match(/"email":"([^"]+)"/i);
    return { refreshToken: rt ? rt[1] : null, accessToken: at ? at[1] : null, email: em ? em[1] : null };
  } catch (_) { return { refreshToken: null, accessToken: null, email: null }; }
}

// Decode a JWT's `exp` (seconds) without verifying the signature — used only to tell whether
// the stored access token is still within its lifetime, so we can confirm a live session
// WITHOUT a rotating refresh-token exchange. Returns a number or null. Never logs the token.
function jwtExp(token) {
  try {
    const part = String(token || '').split('.')[1];
    if (!part) return null;
    const json = Buffer.from(part.replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8');
    const exp = JSON.parse(json).exp;
    return Number.isFinite(exp) ? exp : null;
  } catch (_) { return null; }
}

// Re-encode a refreshed Supabase session back into the account's cookie bundle (WriteHuman).
// A successful refresh-token exchange ROTATES the tokens; if the rotated session is not stored,
// the next check finds the old refresh token already-used → a FALSE "session expired". This
// rewrites ONLY the `sb-<ref>-auth-token` cookie's token fields, preserving the exact format
// (base64url `base64-` prefix, optional URL-encoding) and chunk layout (.0/.1) we found, so the
// stored session stays live and the admin never has to re-export. FAIL-SAFE: returns null (the
// caller then leaves the bundle untouched — never corrupts it) for anything it can't cleanly
// round-trip. All other cookies are preserved exactly. WriteHuman-only (guarded by callers).
function applySupabaseRefresh(bundle, projectRef, newSession) {
  try {
    if (!bundle || !Array.isArray(bundle.cookies) || !projectRef || !newSession || !newSession.refresh_token) return null;
    const base = 'sb-' + projectRef + '-auth-token';
    const whole = bundle.cookies.find(c => c && c.name === base);
    const chunks = bundle.cookies
      .filter(c => c && typeof c.name === 'string' && c.name.startsWith(base + '.'))
      .map(c => ({ c, n: parseInt(c.name.slice(base.length + 1), 10) }))
      .filter(x => Number.isFinite(x.n))
      .sort((a, b) => a.n - b.n);
    const isChunked = !whole && chunks.length > 0;
    const templ = whole || (chunks[0] && chunks[0].c);
    if (!templ) return null;                                  // no auth-token cookie present
    let rawValue = whole ? whole.value : chunks.map(x => x.c.value).join('');
    if (rawValue == null) return null;

    let urlEncoded = false;
    if (/%[0-9A-Fa-f]{2}/.test(rawValue)) { urlEncoded = true; try { rawValue = decodeURIComponent(rawValue); } catch (_) { return null; } }
    if (!rawValue.startsWith('base64-')) return null;         // only the standard base64url format
    let obj;
    try { obj = JSON.parse(Buffer.from(rawValue.slice(7).replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8')); }
    catch (_) { return null; }
    if (!obj || typeof obj !== 'object' || Array.isArray(obj) || !('refresh_token' in obj)) return null;

    // Merge ONLY the rotating fields from the fresh session; keep everything else (user, etc.).
    const merged = Object.assign({}, obj);
    for (const k of ['access_token', 'refresh_token', 'expires_in', 'expires_at', 'token_type', 'provider_token', 'provider_refresh_token']) {
      if (newSession[k] !== undefined) merged[k] = newSession[k];
    }
    if (newSession.user && typeof newSession.user === 'object') merged.user = newSession.user;

    let outVal = 'base64-' + Buffer.from(JSON.stringify(merged), 'utf8').toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
    if (urlEncoded) outVal = encodeURIComponent(outVal);

    const meta = {};
    if (templ.domain) meta.domain = templ.domain;
    if (templ.path) meta.path = templ.path;
    const others = bundle.cookies.filter(c => !(c && typeof c.name === 'string' && (c.name === base || c.name.startsWith(base + '.'))));
    let newAuthCookies;
    if (isChunked) {
      const C = String(chunks[0].c.value || '').length || 3600;   // mirror the SDK's chunk size
      const parts = [];
      for (let i = 0; i < outVal.length; i += C) parts.push(outVal.slice(i, i + C));
      newAuthCookies = parts.map((v, idx) => Object.assign({ name: base + '.' + idx, value: v }, meta));
    } else {
      newAuthCookies = [Object.assign({ name: base, value: outVal }, meta)];
    }
    return Object.assign({}, bundle, { cookies: others.concat(newAuthCookies) });
  } catch (_) { return null; }
}

async function verifySupabaseRefresh(tool, cookieHeader, expectedIdentifier) {
  const cfg = tools.supabaseConfig(tool);
  if (!cfg) return { result: 'unknown', httpStatus: 0, finalPath: null, redirectedToSignIn: false, maskedId: null };

  const { refreshToken, accessToken, email: cookieEmail } = extractSupabaseSession(cookieHeader, cfg.projectRef);

  // STABLE / NON-DESTRUCTIVE check first: if the stored access-token JWT is still within its
  // lifetime, the session is authenticated right now — report working WITHOUT exchanging (and
  // thereby ROTATING) the refresh token. This makes re-verification idempotent (like HIX/Ryne's
  // read-only check) so repeated verifies never consume the token, and the session stays valid
  // as long as the cookies are valid. No timeout ever expires it here.
  const exp = jwtExp(accessToken);
  if (exp && exp * 1000 > Date.now() + 120000) {
    return { result: 'working', httpStatus: 200, finalPath: '/auth (jwt)', redirectedToSignIn: false, maskedId: cookieEmail ? maskEmail(cookieEmail) : null };
  }

  if (!refreshToken) {
    // No Supabase session in the bundle → the httpOnly auth-token cookie wasn't captured.
    // Report logged-out so the account is never served; admin is told to use Capture session.
    return { result: 'session_expired', httpStatus: 0, finalPath: null, redirectedToSignIn: false, loggedOut: true, maskedId: null };
  }

  let resp;
  try {
    resp = await fetch(cfg.url + '/auth/v1/token?grant_type=refresh_token', {
      method: 'POST',
      headers: { 'apikey': cfg.anonKey, 'authorization': 'Bearer ' + cfg.anonKey, 'content-type': 'application/json', 'user-agent': UA },
      body: JSON.stringify({ refresh_token: refreshToken }),
      signal: AbortSignal.timeout(10000),
    });
  } catch (_) {
    return { result: 'unknown', httpStatus: 0, finalPath: null, redirectedToSignIn: false, maskedId: null };
  }

  const httpStatus = resp.status;
  let body = '';
  try { body = (await resp.text()).slice(0, 100000); } catch (_) {}

  if (httpStatus >= 200 && httpStatus < 300) {
    // A fresh session was minted → these cookies CAN log in. Read the email (response → cookie
    // fallback) only to mask it; tokens in the body are never logged or returned.
    const em = body.match(/"email":"([^"]+)"/i);
    const email = (em && em[1]) || cookieEmail || null;
    const maskedId = email ? maskEmail(email) : null;
    // The exchange ROTATED the tokens — return the fresh session so the caller can persist it
    // back into the stored cookie bundle (keeps the account live; the old refresh token is now
    // consumed). Parsed here only to hand back; tokens are never logged.
    let refreshedSession = null;
    try { const s = JSON.parse(body); if (s && s.refresh_token) refreshedSession = s; } catch (_) {}
    if (expectedIdentifier && email && String(expectedIdentifier).trim().toLowerCase() !== email.toLowerCase()) {
      return { result: 'wrong_account', httpStatus, finalPath: '/auth/v1/token', redirectedToSignIn: false, maskedId, refreshedSession };
    }
    return { result: 'working', httpStatus, finalPath: '/auth/v1/token', redirectedToSignIn: false, maskedId, refreshedSession };
  }
  // 400/401/403 → the refresh token is invalid/expired/revoked → truly can't log in.
  if (httpStatus === 400 || httpStatus === 401 || httpStatus === 403) {
    return { result: 'session_expired', httpStatus, finalPath: '/auth/v1/token', redirectedToSignIn: false, loggedOut: true, maskedId: null };
  }
  // 429 / 5xx / unexpected → don't falsely expire a possibly-valid session.
  return { result: 'unknown', httpStatus, finalPath: '/auth/v1/token', redirectedToSignIn: false, maskedId: null };
}

module.exports = { verifyAccountCookies, maskEmail, pageDiagnostics, applySupabaseRefresh };
