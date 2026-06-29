'use strict';
/**
 * WriteHuman V2 — account cookie verification (Supabase refresh-token mode ONLY).
 *
 * Isolated clone of the `supabase_refresh` path from backend/utils/proxy/verify.js.
 * WriteHuman authenticates entirely client-side with Supabase: the session lives in the
 * `sb-<ref>-auth-token` cookie (sometimes chunked `.0`/`.1`) which carries a short-lived
 * access-token JWT and a long-lived refresh token. "Can these cookies log in?" is decided
 * by the REFRESH TOKEN, not by an HTML page. So we:
 *   1. If the stored access-token JWT is still within its lifetime → `working` with NO
 *      network call (idempotent; never consumes/rotates the refresh token).
 *   2. Else exchange the refresh token at Supabase's token endpoint — exactly the call the
 *      app makes. 200 → `working` (+ the rotated session to persist); 400/401/403 →
 *      `session_expired`; 429/5xx/unknown → `unknown` (never falsely expire).
 *
 * Returns only safe fields. Never logs cookies, tokens, or secrets.
 */
const { supabaseConfig } = require('./supabase');

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36';

function maskEmail(email) {
  if (!email) return null;
  const [local, domain] = String(email).split('@');
  if (!domain) return null;
  const head = local.slice(0, 1) || '*';
  return `${head}${'*'.repeat(Math.max(2, Math.min(local.length - 1, 4)))}@${domain}`;
}

// Pull the Supabase session's refresh/access token + email out of the cookie header.
// The cookie value is usually `base64-<base64url(json)>` and may be split across `.0`/`.1`
// chunks concatenated in order. Never logs any token.
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
    if (!raw) return { refreshToken: null, accessToken: null, email: null };
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

// Decode a JWT's `exp` (seconds) WITHOUT verifying the signature — used only to tell whether
// the stored access token is still within its lifetime. Returns a number or null.
function jwtExp(token) {
  try {
    const part = String(token || '').split('.')[1];
    if (!part) return null;
    const json = Buffer.from(part.replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8');
    const exp = JSON.parse(json).exp;
    return Number.isFinite(exp) ? exp : null;
  } catch (_) { return null; }
}

// Re-encode a refreshed Supabase session back into the cookie bundle, preserving exact
// format (base64url `base64-` prefix, optional URL-encoding) and chunk layout (.0/.1).
// FAIL-SAFE: returns null (caller leaves the bundle untouched) for anything it can't
// cleanly round-trip. All other cookies are preserved exactly.
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
    if (!templ) return null;
    let rawValue = whole ? whole.value : chunks.map(x => x.c.value).join('');
    if (rawValue == null) return null;

    let urlEncoded = false;
    if (/%[0-9A-Fa-f]{2}/.test(rawValue)) { urlEncoded = true; try { rawValue = decodeURIComponent(rawValue); } catch (_) { return null; } }
    if (!rawValue.startsWith('base64-')) return null;
    let obj;
    try { obj = JSON.parse(Buffer.from(rawValue.slice(7).replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8')); }
    catch (_) { return null; }
    if (!obj || typeof obj !== 'object' || Array.isArray(obj) || !('refresh_token' in obj)) return null;

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
      const C = String(chunks[0].c.value || '').length || 3600;
      const parts = [];
      for (let i = 0; i < outVal.length; i += C) parts.push(outVal.slice(i, i + C));
      newAuthCookies = parts.map((v, idx) => Object.assign({ name: base + '.' + idx, value: v }, meta));
    } else {
      newAuthCookies = [Object.assign({ name: base, value: outVal }, meta)];
    }
    return Object.assign({}, bundle, { cookies: others.concat(newAuthCookies) });
  } catch (_) { return null; }
}

// WriteHuman-only verifier. cookieHeader is the built "name=value; ..." string for the
// target host. Returns { result, httpStatus, maskedId, loggedOut?, refreshedSession? }.
async function verifyAccountCookies(cookieHeader, expectedIdentifier) {
  const cfg = supabaseConfig();
  if (!cfg) return { result: 'unknown', httpStatus: 0, maskedId: null };
  if (!cookieHeader) return { result: 'session_expired', httpStatus: 0, loggedOut: true, maskedId: null };

  const { refreshToken, accessToken, email: cookieEmail } = extractSupabaseSession(cookieHeader, cfg.projectRef);

  // Idempotent fast-path: a still-valid access token proves authentication WITHOUT exchanging
  // (and thereby rotating) the refresh token. No timeout ever expires it here.
  const exp = jwtExp(accessToken);
  if (exp && exp * 1000 > Date.now() + 120000) {
    return { result: 'working', httpStatus: 200, finalPath: '/auth (jwt)', maskedId: cookieEmail ? maskEmail(cookieEmail) : null };
  }

  if (!refreshToken) {
    // No Supabase session in the bundle → the httpOnly auth-token cookie wasn't captured.
    return { result: 'session_expired', httpStatus: 0, loggedOut: true, maskedId: null };
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
    return { result: 'unknown', httpStatus: 0, maskedId: null };
  }

  const httpStatus = resp.status;
  let body = '';
  try { body = (await resp.text()).slice(0, 100000); } catch (_) {}

  if (httpStatus >= 200 && httpStatus < 300) {
    const em = body.match(/"email":"([^"]+)"/i);
    const email = (em && em[1]) || cookieEmail || null;
    const maskedId = email ? maskEmail(email) : null;
    let refreshedSession = null;
    try { const s = JSON.parse(body); if (s && s.refresh_token) refreshedSession = s; } catch (_) {}
    if (expectedIdentifier && email && String(expectedIdentifier).trim().toLowerCase() !== email.toLowerCase()) {
      return { result: 'wrong_account', httpStatus, maskedId, refreshedSession };
    }
    return { result: 'working', httpStatus, maskedId, refreshedSession };
  }
  if (httpStatus === 400 || httpStatus === 401 || httpStatus === 403) {
    return { result: 'session_expired', httpStatus, loggedOut: true, maskedId: null };
  }
  return { result: 'unknown', httpStatus, maskedId: null };
}

module.exports = { verifyAccountCookies, applySupabaseRefresh, maskEmail, extractSupabaseSession, jwtExp };
