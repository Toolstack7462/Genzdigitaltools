'use strict';
/**
 * Generic Proxy-Tool Gateway — a standalone reverse proxy used (separately) for
 * HIX AI and BypassGPT. Deploy ONE instance per tool/subdomain with its own .env:
 *   - HIX:       hix1.genzdigitalstore.com       → TARGET_ORIGIN=https://hix.ai
 *   - BypassGPT: bypassgpt1.genzdigitalstore.com → TARGET_ORIGIN=https://www.bypassgpt.ai
 *
 * Each deployment is fully independent: its own target, its own cookie vault (the
 * backend scopes accounts by the lease's `tool`), its own lease cookie. It:
 *   1. Accepts a signed 30-min lease at /gateway?lease=TOKEN, stores a host-scoped
 *      cookie, and redirects to the tool's default path.
 *   2. Validates the lease on EVERY request (signature + expiry locally; backend
 *      /validate on HTML page loads, the authority for revocation/expiry/access).
 *   3. Reverse-proxies to the real tool origin, attaching the selected vault
 *      account's cookies SERVER-SIDE (never exposed to the browser), hiding
 *      account/billing/identity, and injecting a small Gen Z widget.
 *
 * No usage metering, no daily limits. Dependency-free (Node core only).
 * Never logs cookies, tokens, headers or secrets.
 */
const http = require('http');
const https = require('https');
const { URL } = require('url');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

// Minimal .env loader (dependency-free). Real environment wins (hPanel/Passenger).
(function loadEnv() {
  try {
    const raw = fs.readFileSync(path.join(__dirname, '.env'), 'utf8');
    for (const line of raw.split(/\r?\n/)) {
      const m = /^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/i.exec(line);
      if (!m || line.trim().startsWith('#')) continue;
      const key = m[1];
      let val = m[2];
      if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) val = val.slice(1, -1);
      if (process.env[key] === undefined) process.env[key] = val;
    }
  } catch (_) { /* rely on real environment */ }
})();

const PORT = process.env.PORT || 3000;
const TARGET_ORIGIN = (process.env.TARGET_ORIGIN || '').replace(/\/$/, '');
const API_BASE = (process.env.API_BASE || '').replace(/\/$/, ''); // e.g. https://api.genzdigitalstore.com/api/crm/proxy/gateway
const PUBLIC_ORIGIN = (process.env.GATEWAY_PUBLIC_ORIGIN || '').replace(/\/$/, '');
function cleanPath(p, def) { p = String(p || '').trim(); if (!p) return def; return p.startsWith('/') ? p : '/' + p; }
const DEFAULT_PATH = cleanPath(process.env.DEFAULT_PATH, '/');
const SIGNIN_PATH = cleanPath(process.env.SIGNIN_PATH, '/login');
const LEASE_SECRET = process.env.LEASE_SECRET || ''; // must match backend PROXY_LEASE_SECRET
const GATEWAY_KEY = process.env.GATEWAY_KEY || '';   // must match backend PROXY_GATEWAY_KEY
const TOOL_KEY = process.env.TOOL_KEY || '';         // 'hix' | 'bypassgpt' (lease.tool must match)
const TOOL_NAME = process.env.TOOL_NAME || 'AI Tool';
const LEASE_COOKIE = 'pg_lease';
// Max time to wait for the upstream tool to respond before failing over to a friendly
// retry page (prevents indefinite hanging / blank loading). Override via UPSTREAM_TIMEOUT_MS.
const UPSTREAM_TIMEOUT_MS = parseInt(process.env.UPSTREAM_TIMEOUT_MS, 10) || 30000;
// Pinned upstream browser identity. Kept IDENTICAL for capture + client proxying so a
// Cloudflare cf_clearance cookie (bound to its minting UA) stays valid, and matched to
// the backend verifier's UA (utils/proxy/verify.js) so an account that Verifies
// "working" also opens cleanly through the gateway.
const UPSTREAM_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36';
// Client-hint headers pinned to MATCH UPSTREAM_UA (a UA that claims Chrome but ships
// mismatched/absent sec-ch-ua is a Cloudflare bot tell).
const UPSTREAM_CH_UA = '"Chromium";v="124", "Google Chrome";v="124", "Not-A.Brand";v="99"';
const UPSTREAM_CH_PLATFORM = '"Windows"';
// Extra upstream origins (CDN / asset / API subdomains) the tool's pages reference
// ABSOLUTELY — e.g. BypassGPT serves CSS/JS from https://cdn.bypassgpt.ai. Each is
// proxied under ASSET_PREFIX/<index>/ and rewritten in HTML/CSS/JS so the browser loads
// it same-origin THROUGH the gateway (no cross-origin/CORS/cookie loss). Configure per
// tool via ASSET_ORIGINS, comma-separated. HIX needs none (assets are on hix.ai itself).
const ASSET_ORIGINS = String(process.env.ASSET_ORIGINS || '')
  .split(',').map(s => s.trim().replace(/\/+$/, '')).filter(Boolean);
const ASSET_PREFIX = '/__pxo';
// Captcha / challenge endpoint prefixes the tool loads from a THIRD-PARTY, DOMAIN-BOUND
// provider (e.g. Google reCAPTCHA Enterprise on HIX). These keys are registered for the
// tool's own domain, so on the gateway host the widget refuses to initialise. We proxy
// just these endpoints and present the TOOL's origin to the provider (Origin/Referer +
// the reCAPTCHA `co` origin param) so the REAL widget renders and the user solves it
// manually — we never bypass, auto-solve, or alter the challenge itself. Configure per
// tool via CAPTCHA_ORIGINS as full path-prefixes, e.g.
// "https://www.google.com/recaptcha,https://www.gstatic.com/recaptcha,https://recaptcha.net/recaptcha".
const CAPTCHA_ORIGINS = String(process.env.CAPTCHA_ORIGINS || '')
  .split(',').map(s => s.trim().replace(/\/+$/, '')).filter(Boolean);
// Captcha request paths — many tools (HIX) SELF-PROXY reCAPTCHA under their own domain
// at /recaptcha/…, so the challenge requests come back to the gateway on the MAIN origin
// (not a third-party CAPTCHA_ORIGINS host). These also need the `co` origin rewritten and
// the tool origin presented, and their (minified Google) bodies must be left untouched.
const CAPTCHA_PATH_RE = /(^|\/)recaptcha\//i;
// One indexed list proxied under ASSET_PREFIX/<i>/. Captcha entries get origin-spoofing.
const PROXIED_ORIGINS = ASSET_ORIGINS.map(o => ({ base: o, captcha: false }))
  .concat(CAPTCHA_ORIGINS.map(o => ({ base: o, captcha: true })));
// [captchaPrefix, gatewayPrefix] pairs for the in-browser shim (runtime URL rewriting).
const CAPTCHA_MAP_JSON = JSON.stringify(
  PROXIED_ORIGINS.map((p, i) => (p.captcha ? [p.base, `${ASSET_PREFIX}/${i}`] : null)).filter(Boolean)
);
// Proxy/hop headers LiteSpeed-Passenger injects that a real browser never sends — they
// reveal the proxy to the tool's WAF, so they are stripped from every upstream request.
const STRIP_REQ_HEADERS = [
  'x-forwarded-for', 'x-forwarded-proto', 'x-forwarded-host', 'x-forwarded-port',
  'x-forwarded-server', 'x-real-ip', 'x-client-ip', 'forwarded', 'via', 'cdn-loop',
  'x-lsws-request-id', 'x-powered-by', 'x-passenger-request-id', 'proxy-connection',
];
const LEASE_TYPE = 'proxy_lease';

// ── Cloudflare "managed challenge" pass-through (opt-in per gateway) ──────────
// Some upstreams (e.g. grok.com) gate their app behind a Cloudflare managed/JS
// challenge. From a datacenter IP the upstream answers 403 with an interactive
// "Verifying you are human" page whose cf_clearance is bound to the IP + UA that
// SOLVES it — so a cf_clearance captured in a normal browser is invalid here. When
// CF_CHALLENGE_PASSTHROUGH=1 the gateway:
//   (a) passes that challenge page THROUGH to the client (instead of our block page)
//       so the user solves the REAL challenge in-browser. Every request egresses this
//       server's single IP + pinned UA, so the cf_clearance Cloudflare then mints is
//       valid for the proxy.
//   (b) forwards the browser's Cloudflare cookies (cf_clearance / __cf_bm / cf_chl*)
//       UPSTREAM alongside the vault account cookies, so the challenge flow completes
//       and the cleared session reaches the app.
// It never bypasses, auto-solves or alters the challenge. Default OFF → every other
// tool's behavior is byte-for-byte unchanged.
const CF_CHALLENGE_PASSTHROUGH = process.env.CF_CHALLENGE_PASSTHROUGH === '1' || /^true$/i.test(process.env.CF_CHALLENGE_PASSTHROUGH || '');
// How to handle a detected Cloudflare challenge on a client nav:
//   'block'       (default) → the generic "access could not be verified" block page.
//   'passthrough'           → serve the real challenge so the user solves it (only viable
//                             for a same-origin JS challenge; an INTERACTIVE challenge that
//                             loads challenges.cloudflare.com cross-origin can NOT be solved
//                             through a proxy — origin+IP bound — so don't use it there).
//   'unsupported'           → show a clear, friendly "not available through the secure
//                             proxy" page (used for tools whose challenge a proxy can't
//                             satisfy, e.g. grok.com's interactive managed challenge).
// CF_CHALLENGE_PASSTHROUGH=1 is back-compat for mode 'passthrough'. Default keeps every
// other gateway byte-for-byte unchanged.
const CF_CHALLENGE_MODE = (process.env.CF_CHALLENGE_MODE || (CF_CHALLENGE_PASSTHROUGH ? 'passthrough' : 'block')).toLowerCase();
const CF_COOKIE_RE = /^(cf_clearance|__cf_bm|__cflb|cf_chl|__cf_chl|__cf_waf)/i;

function isCloudflareChallenge(statusCode, headers) {
  if (!(statusCode === 403 || statusCode === 503 || statusCode === 429)) return false;
  if (String(headers['cf-mitigated'] || '').toLowerCase().includes('challenge')) return true;
  // A managed/JS-challenge interstitial is served by Cloudflare (cf-ray present) as
  // text/html. A hard WAF deny is also cloudflare+cf-ray, so this is only consulted
  // when pass-through is explicitly enabled for this gateway (opt-in).
  const server = String(headers['server'] || '').toLowerCase();
  const ct = String(headers['content-type'] || '').toLowerCase();
  return server.includes('cloudflare') && !!headers['cf-ray'] && ct.includes('text/html');
}

// Pull ONLY Cloudflare-managed cookies out of a raw browser Cookie header (never the
// lease cookie) so they can be forwarded upstream next to the vault session.
function extractCfCookies(rawCookieHeader) {
  return String(rawCookieHeader || '').split(';').map(s => s.trim()).filter(Boolean)
    .filter(p => { const i = p.indexOf('='); const name = (i < 0 ? p : p.slice(0, i)).trim(); return name !== LEASE_COOKIE && CF_COOKIE_RE.test(name); })
    .join('; ');
}
// Merge two "a=b; c=d" cookie headers; the second wins on a name clash.
function mergeCookieHeaders(a, b) {
  const map = new Map();
  for (const part of [a, b]) {
    String(part || '').split(';').map(s => s.trim()).filter(Boolean).forEach(p => {
      const i = p.indexOf('='); if (i < 0) return; map.set(p.slice(0, i).trim(), p.slice(i + 1));
    });
  }
  return [...map.entries()].map(([n, v]) => `${n}=${v}`).join('; ');
}

if (!TARGET_ORIGIN) { console.error('FATAL: TARGET_ORIGIN is required'); process.exit(1); }
if (!API_BASE) { console.error('FATAL: API_BASE is required'); process.exit(1); }
if (!LEASE_SECRET || LEASE_SECRET.length < 32) {
  console.warn('⚠️  LEASE_SECRET missing/weak — local lease verification disabled; relying on backend /validate only.');
}
if (!GATEWAY_KEY) {
  console.warn('⚠️  GATEWAY_KEY not set — account session injection disabled (proxy will not inject account sessions).');
}

const targetUrl = new URL(TARGET_ORIGIN);
const httpLib = targetUrl.protocol === 'https:' ? https : http;

// ── Minimal JWT (HS256) verification — no external deps ─────────────────────
function b64urlToBuf(s) { return Buffer.from(s.replace(/-/g, '+').replace(/_/g, '/'), 'base64'); }
function verifyLeaseLocal(token) {
  if (!LEASE_SECRET || LEASE_SECRET.length < 32) return { unknown: true };
  try {
    const [h, p, sig] = String(token).split('.');
    if (!h || !p || !sig) return null;
    const expected = crypto.createHmac('sha256', LEASE_SECRET).update(`${h}.${p}`).digest('base64')
      .replace(/=/g, '').replace(/\+/g, '-').replace(/\//g, '_');
    if (!crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(expected))) return null;
    const payload = JSON.parse(b64urlToBuf(p).toString('utf8'));
    if (payload.type !== LEASE_TYPE) return null;
    if (TOOL_KEY && payload.tool && String(payload.tool) !== String(TOOL_KEY)) return null;
    if (payload.exp && Date.now() / 1000 > payload.exp) return null;
    return payload;
  } catch (_) { return null; }
}

// ── Cookie helpers ──────────────────────────────────────────────────────────
function parseCookies(header) {
  const out = {};
  (header || '').split(';').forEach(pair => {
    const i = pair.indexOf('=');
    if (i > -1) out[pair.slice(0, i).trim()] = decodeURIComponent(pair.slice(i + 1).trim());
  });
  return out;
}
function getLease(req) { return parseCookies(req.headers.cookie)[LEASE_COOKIE] || null; }

// Strip ONLY the lease cookie, preserving every other cookie byte-for-byte.
function stripLeaseCookie(rawCookieHeader) {
  return String(rawCookieHeader || '').split(';').map(s => s.trim()).filter(Boolean)
    .filter(p => { const i = p.indexOf('='); const name = (i < 0 ? p : p.slice(0, i)).trim(); return name !== LEASE_COOKIE; })
    .join('; ');
}

// ── Backend calls (server-to-server) ────────────────────────────────────────
function backendPost(subpath, token, extraHeaders, jsonBody) {
  return new Promise((resolve) => {
    try {
      const u = new URL(`${API_BASE}${subpath}`);
      const lib = u.protocol === 'https:' ? https : http;
      const body = Buffer.from(JSON.stringify(jsonBody || {}));
      const headers = Object.assign({
        'content-type': 'application/json',
        'content-length': body.length,
        'authorization': `Bearer ${token}`,
      }, extraHeaders || {});
      const r = lib.request(u, { method: 'POST', headers, timeout: 8000 }, (resp) => {
        let data = '';
        resp.on('data', c => { data += c; });
        resp.on('end', () => { try { resolve({ status: resp.statusCode, body: JSON.parse(data || '{}') }); } catch { resolve({ status: resp.statusCode, body: {} }); } });
      });
      r.on('error', () => resolve({ status: 0, body: {} }));
      r.on('timeout', () => { r.destroy(); resolve({ status: 0, body: {} }); });
      r.end(body);
    } catch { resolve({ status: 0, body: {} }); }
  });
}
function backendValidate(token) { return backendPost('/validate', token, null, {}); }
function gatewayApiPost(subpath, token, jsonBody) {
  if (!GATEWAY_KEY) return Promise.resolve({ status: 0, body: {} });
  return backendPost(subpath, token, { 'x-gateway-key': GATEWAY_KEY }, jsonBody);
}

// ── Account Vault session (gateway-only) — fetch + short in-process cache ─────
const sessionCache = new Map();
const SESSION_TTL_MS = 60 * 1000;

function hostMatchesCookieDomain(cookieDomain, host) {
  if (!cookieDomain) return true;
  const d = String(cookieDomain).replace(/^\./, '').toLowerCase();
  const h = String(host || '').toLowerCase();
  if (!h) return true;
  return h === d || h.endsWith('.' + d) || d.endsWith('.' + h);
}
function buildCookieHeader(bundle) {
  const host = targetUrl.hostname;
  let arr = bundle && bundle.cookies;
  if (typeof arr === 'string') {
    arr = arr.split(';').map(p => p.trim()).filter(Boolean).map(p => { const i = p.indexOf('='); return i < 0 ? null : { name: p.slice(0, i).trim(), value: p.slice(i + 1).trim() }; }).filter(Boolean);
  }
  if (!Array.isArray(arr)) return '';
  const map = new Map();
  for (const c of arr) {
    if (!c || !c.name) continue;
    if (c.domain && !hostMatchesCookieDomain(c.domain, host)) continue;
    map.set(c.name, c.value == null ? '' : c.value);
  }
  return [...map.entries()].map(([n, v]) => `${n}=${v}`).join('; ');
}
async function fetchAccountSession(token) {
  if (!GATEWAY_KEY) return { noKey: true };
  return gatewayApiPost('/session', token, {});
}
async function getSession(token, jti) {
  const key = jti || ('t:' + String(token).slice(-24));
  const hit = sessionCache.get(key);
  if (hit && hit.exp > Date.now()) return hit.data;
  const r = await fetchAccountSession(token);
  let data;
  if (r.noKey) data = { noAccount: true };
  else if (r.status === 0) data = hit ? hit.data : { noInject: true };
  else if (r.body && r.body.ok === true && r.body.account == null) data = { noAccount: true };
  else if (r.body && r.body.ok === true && r.body.bundle) {
    const cookieHeader = buildCookieHeader(r.body.bundle);
    const cookieCount = cookieHeader ? cookieHeader.split('; ').filter(Boolean).length : 0;
    data = {
      cookieHeader, cookieCount,
      hasSessionCookie: cookieCount > 0,
      localStorage: r.body.bundle.localStorage || null,
      sessionStorage: r.body.bundle.sessionStorage || null,
      accountId: (r.body.account && r.body.account.id) || null,
      accountLabel: (r.body.account && r.body.account.label) || null,
    };
  }
  else data = { blocked: true, code: (r.body && r.body.code) || 'account_no_session' };
  sessionCache.set(key, { exp: Date.now() + SESSION_TTL_MS, data });
  return data;
}

// Safe structured log — IDs / counts / status only. NEVER cookie names or values.
function safeLog(event, fields) {
  try { console.log(`[proxy-gw:${TOOL_KEY || '?'}] ${event} ${JSON.stringify(fields)}`); } catch (_) {}
}

// ════════════════════════════════════════════════════════════════════════════
// SERVER-SIDE IDENTITY / ACCOUNT / BILLING SHIELD (account name/email/plan never
// reach the browser). Same approach as the StealthWriter gateway.
// ════════════════════════════════════════════════════════════════════════════
const BRAND = 'Gen Z Digital Store';
const BRAND_EMAIL = 'member@genzdigitalstore.com';
// Identity/billing REDACTION of JSON API responses + account/billing nav blocking is
// OPT-IN. It deep-redacts the tool's auth/session/user API payloads, which breaks
// token-based SPAs (e.g. better-auth's /api/auth/session) → the app thinks it is
// logged out and renders blank. Default OFF so the proxied tool renders + stays
// authenticated; set IDENTITY_SHIELD=1 only once it is proven auth-safe. The
// logout-block below is ALWAYS on (protects the shared account) and never redacts.
const IDENTITY_SHIELD = process.env.IDENTITY_SHIELD === '1' || /^true$/i.test(process.env.IDENTITY_SHIELD || '');
// ── Account shield (route blocking) — DECOUPLED from IDENTITY_SHIELD ──────────
// Blocking account/billing/settings PAGE loads + pure billing API calls is auth-SAFE
// (it never touches the session/auth JSON the SPA needs), so it is ON by default for
// every proxy tool. IDENTITY_SHIELD remains a SEPARATE, default-OFF switch that ALSO
// deep-redacts identity JSON (which can log token SPAs out) — see sanitizeBody below.
// Set ACCOUNT_SHIELD=0 to disable route blocking for a tool whose working area lives
// under one of these path words (tune with NAV_BLOCK_EXCLUDE first).
const ACCOUNT_SHIELD = !(process.env.ACCOUNT_SHIELD === '0' || /^false$/i.test(process.env.ACCOUNT_SHIELD || ''));
const LOGOUT_RE = /(^|\/)(logout|log-?out|sign-?out|signout)(\/|$)|auth\/(sign-?out|signout|logout)/i;
const BLOCK_NAV_RE = /(^|\/)(billing|subscription|subscriptions|pricing|plans?|upgrade|checkout|account|account-settings|settings|profile|affiliate|refer|referral|invite|rewards|api-keys?|apikeys?)(\/|$)/i;
const STUB_API_RE = /(^|\/)(billing|invoice|invoices|payment|payments|checkout|customer-portal|create-portal|portal|pricing|plans?|upgrade|affiliate|refer|referral|coupon|promo|api-keys?|apikeys?)(\/|$)/i;
// Optional per-tool tuning (each gateway is its own deployment with its own env, so this
// IS the per-tool config). NAV_BLOCK_EXTRA adds comma-separated path fragments to block;
// NAV_BLOCK_EXCLUDE removes a tool's working-area path that would otherwise match a word
// above (e.g. a tool whose editor lives at /settings). Matched on the pathname only.
const NAV_BLOCK_EXTRA = String(process.env.NAV_BLOCK_EXTRA || '').split(',').map(s => s.trim()).filter(Boolean);
const NAV_BLOCK_EXCLUDE = String(process.env.NAV_BLOCK_EXCLUDE || '').split(',').map(s => s.trim()).filter(Boolean);
function pathHasFragment(pathName, frags) { const p = String(pathName || '').toLowerCase(); return frags.some(f => p.includes(f.toLowerCase())); }
function isBlockedAccountNav(pathName) {
  if (NAV_BLOCK_EXCLUDE.length && pathHasFragment(pathName, NAV_BLOCK_EXCLUDE)) return false;
  return BLOCK_NAV_RE.test(pathName) || (NAV_BLOCK_EXTRA.length && pathHasFragment(pathName, NAV_BLOCK_EXTRA));
}
function isStubApi(pathName) {
  if (NAV_BLOCK_EXCLUDE.length && pathHasFragment(pathName, NAV_BLOCK_EXCLUDE)) return false;
  return STUB_API_RE.test(pathName) || (NAV_BLOCK_EXTRA.length && pathHasFragment(pathName, NAV_BLOCK_EXTRA));
}
// Optional extra CSS selectors (comma-separated) for a tool's EXACT account/top-bar/
// avatar containers an obfuscated class hides behind. Mirrors stealth-gateway's
// STEALTH_HIDE_SELECTORS; shipped in the critical hide CSS (before first paint) and to
// overlay.js. NEVER include selectors matching the editor / chat / upload / result area.
const HIDE_SELECTORS = String(process.env.HIDE_SELECTORS || '').split(',').map(s => s.trim()).filter(Boolean);

// ── Logged-out detection (opt-in; default OFF) ───────────────────────────────
// Some tools (WriteHuman, Ryne) serve their PUBLIC marketing/login page at the default
// path with HTTP 200 when the injected vault session is dead — so the client would see
// "Log in / Sign Up" instead of the tool. When DETECT_LOGGED_OUT=1, the gateway checks
// the MAIN nav document: if account cookies WERE attached but the page shows a logged-out
// shell (sign-in AND sign-up CTA, and NO logout/account control), it flags the account
// session-expired (server-to-server) and shows a friendly "session expired" page instead
// of the public page. Requiring all three signals avoids ever tripping on a real logged-in
// editor. Default OFF → every other tool is byte-for-byte unchanged.
const DETECT_LOGGED_OUT = process.env.DETECT_LOGGED_OUT === '1' || /^true$/i.test(process.env.DETECT_LOGGED_OUT || '');
const LO_LOGIN_RE  = /(log\s*in|sign\s*in)\b/i;
const LO_SIGNUP_RE = /(sign\s*up|get\s*started|start\s*(for\s*)?free|try\s*(it\s*)?free|create\s*(an\s*)?account)\b/i;
const LO_LOGOUT_RE = /(log\s*out|sign\s*out|\/logout|my\s*account|account\s*settings|data-testid="[^"]*account|aria-label="[^"]*log\s*out)/i;
function htmlLooksLoggedOut(html) {
  const s = String(html || '');
  if (LO_LOGOUT_RE.test(s)) return false;
  return LO_LOGIN_RE.test(s) && LO_SIGNUP_RE.test(s);
}
const IDENTITY_ROUTE_RE = /(^|\/)(session|get-session|user|users|me|account|accounts|profile|customer|subscription|subscriptions|membership)(\/|$|\.)|auth\/(session|get-session)/i;
const KEY_NAME    = /^(name|fullname|full_name|displayname|display_name|firstname|first_name|lastname|last_name|username|user_name|nickname|handle)$/i;
const KEY_EMAIL   = /^(email|emailaddress|email_address|e_mail|billingemail|billing_email)$/i;
const KEY_NULLOUT = /^(avatar|avatarurl|avatar_url|image|imageurl|image_url|picture|photo|gravatar|phone|phonenumber|phone_number)$/i;
// NOTE: deliberately EXCLUDES token/secret/apikey — those are session credentials the
// SPA needs to stay authenticated (the client already holds the session via the
// injected cookies, so this is not a new leak). Blanking them logs the user out.
const KEY_BILLING = /^(price|priceid|price_id|amount|subtotal|total|currency|interval|card|cardlast4|last4|paymentmethod|payment_method|invoice|invoices|customerid|customer_id|stripeid|stripe_id|stripecustomerid|nextbillingdate|next_billing_date|renewaldate|renewal_date|billingaddress|billing_address|address|taxid|tax_id|vat)$/i;

function deepRedact(val, depth) {
  if (depth > 8 || val == null) return val;
  if (Array.isArray(val)) { for (let i = 0; i < val.length; i++) val[i] = deepRedact(val[i], depth + 1); return val; }
  if (typeof val === 'object') {
    for (const k of Object.keys(val)) {
      const v = val[k];
      if (KEY_EMAIL.test(k) && typeof v === 'string') val[k] = BRAND_EMAIL;
      else if (KEY_NAME.test(k) && typeof v === 'string') val[k] = BRAND;
      else if (KEY_NULLOUT.test(k)) val[k] = null;
      else if (KEY_BILLING.test(k)) {
        if (typeof v === 'string') val[k] = '';
        else if (typeof v === 'number') val[k] = 0;
        else if (Array.isArray(v)) val[k] = [];
        else if (v && typeof v === 'object') val[k] = deepRedact(v, depth + 1);
        else val[k] = null;
      } else val[k] = deepRedact(v, depth + 1);
    }
    return val;
  }
  return val;
}
function sanitizeJsonBody(text) {
  try { return JSON.stringify(deepRedact(JSON.parse(text), 0)); } catch (_) { return text; }
}
const EMAIL_GLOBAL_RE = /[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi;
function redactHtmlIdentity(html) { try { return html.replace(EMAIL_GLOBAL_RE, BRAND_EMAIL); } catch (_) { return html; } }

// ── Upstream URL rewriting ───────────────────────────────────────────────────
// Map every upstream origin the page references to a gateway-served URL so the
// browser fetches assets/scripts/API same-origin through the proxy:
//   TARGET_ORIGIN           → PUBLIC_ORIGIN          (e.g. https://hix.ai → https://hix1…)
//   ASSET_ORIGINS[i]        → PUBLIC_ORIGIN/__pxo/i  (e.g. https://cdn.bypassgpt.ai → …/__pxo/0)
// Handled in plain (https://h), escaped-JSON (https:\/\/h, common in __NEXT_DATA__) and
// protocol-relative (//h) forms. Literal split/join — no regex, no escaping pitfalls.
const ORIGIN_REPLACEMENTS = (() => {
  const reps = [];
  if (PUBLIC_ORIGIN && TARGET_ORIGIN) reps.push([TARGET_ORIGIN, PUBLIC_ORIGIN]);
  // Asset + captcha origins share the /__pxo/<i>/ index space.
  PROXIED_ORIGINS.forEach((p, i) => { if (PUBLIC_ORIGIN) reps.push([p.base, `${PUBLIC_ORIGIN}${ASSET_PREFIX}/${i}`]); });
  return reps;
})();
// reCAPTCHA reports the embedding origin in the `co` query param (base64url of
// "https://host:port"). For a domain-bound key to render, that must encode the TOOL's
// origin, not the gateway's — so we swap the gateway host for the target host. This only
// makes the provider RENDER the challenge for the right key; the user still solves it.
function rewriteCaptchaCo(qs) {
  if (!qs) return qs;
  return qs.replace(/([?&]co=)([^&]+)/i, (m, pfx, val) => {
    try {
      const b = val.replace(/-/g, '+').replace(/_/g, '/').replace(/\./g, '=');
      let dec = Buffer.from(b, 'base64').toString('utf8');
      if (!dec || !/^https?:\/\//i.test(dec)) return m;
      const gwHost = new URL(PUBLIC_ORIGIN).host;
      dec = dec.split(PUBLIC_ORIGIN).join(TARGET_ORIGIN).split(gwHost).join(targetUrl.host);
      const enc = Buffer.from(dec, 'utf8').toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=/g, '.');
      return pfx + enc;
    } catch (_) { return m; }
  });
}
function rewriteUpstreamUrls(text) {
  let applied = false;
  for (const [from, to] of ORIGIN_REPLACEMENTS) {
    if (!from) continue;
    if (text.includes(from)) { text = text.split(from).join(to); applied = true; }
    const esc = from.replace(/\//g, '\\/'), escTo = to.replace(/\//g, '\\/');
    if (text.includes(esc)) { text = text.split(esc).join(escTo); applied = true; }
    const pr = from.replace(/^https?:/i, ''), prTo = to.replace(/^https?:/i, '');
    if (pr && text.includes(pr)) { text = text.split(pr).join(prTo); applied = true; }
  }
  return { text, applied };
}
// Drop in-document CSP/security <meta> tags — the proxied view loads assets/scripts
// from the gateway origin, which a tool's own CSP would otherwise block.
function stripSecurityMeta(html) {
  return html.replace(/<meta[^>]+http-equiv=["']?(?:content-security-policy|x-frame-options)["']?[^>]*>/ig, '');
}
// Some upstreams (e.g. Next.js apps) inject a "canonical host" guard that runs
//   if (location.hostname !== '<their host>') location.replace('https://<host>'+location.pathname+location.search)
// to bounce any non-canonical host back to themselves. Behind this same-origin
// gateway that host check always fails, and because the gateway rewrites the target
// URL back to itself, the page reloads forever (infinite blank/loading loop). Defuse
// ONLY that specific redirect-to-own-origin call — both the raw <head> copy and the
// RSC/flight-serialized copy — leaving everything else byte-for-byte intact. Must run
// BEFORE rewriteUpstreamUrls so the canonical-host literal is still present to match.
const TARGET_HOST = (() => { try { return new URL(TARGET_ORIGIN).host.replace(/^www\./, ''); } catch (_) { return ''; } })();
const HOST_GUARD_RE = TARGET_HOST
  ? new RegExp(
      "location\\.replace\\(\\s*(['\"])https?://(?:www\\.)?" +
      TARGET_HOST.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') +
      "\\1\\s*\\+\\s*location\\.pathname\\s*\\+\\s*location\\.search\\s*\\)", 'g')
  : null;
function neutralizeHostGuard(html) {
  return HOST_GUARD_RE ? html.replace(HOST_GUARD_RE, 'void 0') : html;
}
// Text bodies worth rewriting upstream origins inside (never images/fonts/streams).
function isRewritableText(ct) {
  return /(javascript|ecmascript|text\/css|application\/json|application\/manifest|text\/plain|application\/xml|text\/xml)/i.test(ct)
    && !ct.includes('event-stream');
}

// Captcha runtime-URL shim. reCAPTCHA libs build the provider URL at RUNTIME from a bare
// host string (e.g. "recaptcha.net"+"/recaptcha/…"), so static body rewriting can't catch
// it. This tiny script (injected FIRST in <head>) rewrites ONLY captcha-provider URLs at
// the DOM/network layer (script/iframe src, fetch, XHR) to the gateway's /__pxo route so
// the challenge loads through the proxy with the tool origin spoofed. Every non-captcha
// URL is returned untouched, so the rest of the app is unaffected. Does NOT bypass or
// auto-solve the captcha — the user still solves the real challenge.
function injectCaptchaShim(html) {
  if (!CAPTCHA_ORIGINS.length) return html;
  const shim = '<script>(function(){try{var M=' + CAPTCHA_MAP_JSON + ',G=location.origin;' +
    'function rw(u){try{if(typeof u!=="string"||!u)return u;for(var i=0;i<M.length;i++){var f=M[i][0],t=M[i][1];' +
    'if(u.indexOf(f)===0)return G+t+u.slice(f.length);var p=f.replace(/^https?:/,"");if(u.indexOf(p)===0)return G+t+u.slice(p.length);}return u;}catch(e){return u;}}' +
    '["HTMLScriptElement","HTMLIFrameElement"].forEach(function(T){try{var d=Object.getOwnPropertyDescriptor(window[T].prototype,"src");' +
    'if(d&&d.set)Object.defineProperty(window[T].prototype,"src",{configurable:true,enumerable:d.enumerable,get:d.get,set:function(v){d.set.call(this,rw(v));}});}catch(e){}});' +
    'var sa=Element.prototype.setAttribute;Element.prototype.setAttribute=function(n,v){if((n==="src"||n==="href")&&typeof v==="string")v=rw(v);return sa.call(this,n,v);};' +
    'if(window.fetch){var of=window.fetch;window.fetch=function(i,o){try{if(typeof i==="string")i=rw(i);else if(i&&i.url&&typeof Request!=="undefined")i=new Request(rw(i.url),i);}catch(e){}return of.call(this,i,o);};}' +
    'var ox=XMLHttpRequest.prototype.open;XMLHttpRequest.prototype.open=function(m,u){try{arguments[1]=rw(u);}catch(e){}return ox.apply(this,arguments);};' +
    '}catch(e){}})();</script>';
  const m = html.match(/<head[^>]*>/i);
  if (m) return html.replace(m[0], m[0] + shim);
  return shim + html;
}

// ── Static assets (overlay) served locally under /__genz/ ────────────────────
const OVERLAY_JS = fs.readFileSync(path.join(__dirname, 'public', 'overlay.js'), 'utf8');
const OVERLAY_CSS = fs.readFileSync(path.join(__dirname, 'public', 'overlay.css'), 'utf8');
// Inlined into <head> (not <script src defer>) so its MutationObserver/hiding starts
// before <body> paints — same no-flash technique as the StealthWriter gateway.
const OVERLAY_JS_INLINE = OVERLAY_JS.replace(/<\/script>/gi, '<\\/script>');

function sendBlockPage(res, code) {
  const messages = {
    lease_missing: `No active session. Please reopen ${TOOL_NAME} from your Gen Z dashboard.`,
    lease_invalid: `Your session token is invalid. Please reopen ${TOOL_NAME} from your dashboard.`,
    lease_expired: `Your session has ended. Reopen ${TOOL_NAME} from your dashboard to continue.`,
    lease_revoked: 'Your session was ended by an administrator.',
    client_disabled: `Your ${TOOL_NAME} access is disabled. Contact support.`,
    plan_expired: `Your ${TOOL_NAME} access has expired. Contact support to renew.`,
    account_blocked: `${TOOL_NAME} is temporarily unavailable. Please contact support.`,
    account_no_session: `${TOOL_NAME} is temporarily unavailable. Please contact support.`,
    session_expired: `${TOOL_NAME} needs to sign in again. We're refreshing the session — please try again shortly or contact support.`,
    unavailable: 'Access could not be verified. Please refresh or contact support.',
  };
  const msg = messages[code] || 'Access could not be verified. Please refresh or contact support.';
  const html = `<!doctype html><html><head><meta charset="utf-8"><title>Session ended</title>
<meta name="viewport" content="width=device-width, initial-scale=1">
<style>body{margin:0;font-family:system-ui,-apple-system,Segoe UI,Roboto,sans-serif;background:#0b1220;color:#e2e8f0;display:flex;min-height:100vh;align-items:center;justify-content:center}
.card{max-width:420px;text-align:center;padding:40px 32px;background:#111a2e;border:1px solid rgba(6,182,212,.25);border-radius:16px}
h1{font-size:20px;margin:0 0 12px}p{color:#94a3b8;line-height:1.6;margin:0 0 20px}
a{display:inline-block;background:linear-gradient(135deg,#2563EB,#06B6D4);color:#fff;text-decoration:none;padding:11px 22px;border-radius:10px;font-weight:600}</style></head>
<body><div class="card"><h1>${TOOL_NAME} session ended</h1><p>${msg}</p>
<a href="https://app.genzdigitalstore.com/client/dashboard">Back to dashboard</a></div></body></html>`;
  res.writeHead(403, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
  res.end(html);
}

// ── Friendly NON-blocking notice (loading trouble / upstream down / reload loop) ──
// Unlike the 403 block page, this offers a manual retry and never auto-redirects, so
// it replaces blank/hanging pages and breaks reload loops. No secrets, ever.
function sendNoticePage(res, { status = 503, title, msg, retryPath = DEFAULT_PATH } = {}) {
  if (res.headersSent) { try { res.end(); } catch (_) {} return; }
  const safeTitle = title || `${TOOL_NAME} is taking a moment`;
  const html = `<!doctype html><html><head><meta charset="utf-8"><title>${TOOL_NAME}</title>
<meta name="viewport" content="width=device-width, initial-scale=1">
<style>body{margin:0;font-family:system-ui,-apple-system,Segoe UI,Roboto,sans-serif;background:#0b1220;color:#e2e8f0;display:flex;min-height:100vh;align-items:center;justify-content:center}
.card{max-width:440px;text-align:center;padding:40px 32px;background:#111a2e;border:1px solid rgba(6,182,212,.25);border-radius:16px}
h1{font-size:20px;margin:0 0 12px}p{color:#94a3b8;line-height:1.6;margin:0 0 22px}
.row{display:flex;gap:10px;justify-content:center;flex-wrap:wrap}
a{font:inherit;display:inline-block;text-decoration:none;padding:11px 20px;border-radius:10px;font-weight:600}
.primary{background:linear-gradient(135deg,#2563EB,#06B6D4);color:#fff}
.ghost{background:transparent;color:#7DE3F2;border:1px solid rgba(6,182,212,.4)}</style></head>
<body><div class="card"><h1>${safeTitle}</h1><p>${msg || 'Please try again in a moment.'}</p>
<div class="row"><a class="primary" href="${retryPath}">Try again</a>
<a class="ghost" href="https://app.genzdigitalstore.com/client/dashboard">Back to dashboard</a></div></div></body></html>`;
  res.writeHead(status, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
  res.end(html);
}

// ── Friendly "managed section" notice for blocked account/billing/settings pages ──
// Shown when a client navigates to an account / billing / subscription / settings page
// that the shield blocks. Instead of breaking the tool or silently bouncing, it tells
// them plainly that account & billing are handled by Gen Z Digital Store and offers a
// one-click way back into the working tool. Never exposes any account data.
function sendAccountNotice(res, retryPath) {
  if (res.headersSent) { try { res.end(); } catch (_) {} return; }
  const back = retryPath || DEFAULT_PATH;
  const html = `<!doctype html><html><head><meta charset="utf-8"><title>${TOOL_NAME}</title>
<meta name="viewport" content="width=device-width, initial-scale=1">
<style>body{margin:0;font-family:system-ui,-apple-system,Segoe UI,Roboto,sans-serif;background:#0b1220;color:#e2e8f0;display:flex;min-height:100vh;align-items:center;justify-content:center}
.card{max-width:440px;text-align:center;padding:40px 32px;background:#111a2e;border:1px solid rgba(6,182,212,.25);border-radius:16px}
h1{font-size:20px;margin:0 0 12px}p{color:#94a3b8;line-height:1.6;margin:0 0 22px}
.row{display:flex;gap:10px;justify-content:center;flex-wrap:wrap}
a{font:inherit;display:inline-block;text-decoration:none;padding:11px 20px;border-radius:10px;font-weight:600}
.primary{background:linear-gradient(135deg,#2563EB,#06B6D4);color:#fff}
.ghost{background:transparent;color:#7DE3F2;border:1px solid rgba(6,182,212,.4)}</style></head>
<body><div class="card"><h1>Managed by Gen Z Digital Store</h1>
<p>Account, billing and subscription settings are handled by Gen Z Digital Store, so this
section isn't available here. Your ${TOOL_NAME} workspace is ready to use.</p>
<div class="row"><a class="primary" href="${back}">Back to ${TOOL_NAME}</a>
<a class="ghost" href="https://app.genzdigitalstore.com/client/dashboard">My dashboard</a></div></div></body></html>`;
  res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
  res.end(html);
}

// ── "Unsupported" notice — the upstream's anti-bot challenge can't be satisfied ──
// Shown when a tool sits behind a security check (e.g. Cloudflare's interactive managed
// challenge that loads cross-origin from challenges.cloudflare.com and binds clearance to
// the solving browser's IP + origin) that a server-side proxy cannot legitimately pass.
// We never try to bypass it — we just tell the user clearly instead of looping a blank
// or "unable to connect" screen.
function sendUnsupportedPage(res) {
  if (res.headersSent) { try { res.end(); } catch (_) {} return; }
  const html = `<!doctype html><html><head><meta charset="utf-8"><title>${TOOL_NAME}</title>
<meta name="viewport" content="width=device-width, initial-scale=1">
<style>body{margin:0;font-family:system-ui,-apple-system,Segoe UI,Roboto,sans-serif;background:#0b1220;color:#e2e8f0;display:flex;min-height:100vh;align-items:center;justify-content:center}
.card{max-width:460px;text-align:center;padding:40px 32px;background:#111a2e;border:1px solid rgba(6,182,212,.25);border-radius:16px}
h1{font-size:20px;margin:0 0 12px}p{color:#94a3b8;line-height:1.6;margin:0 0 22px}
a{display:inline-block;background:linear-gradient(135deg,#2563EB,#06B6D4);color:#fff;text-decoration:none;padding:11px 22px;border-radius:10px;font-weight:600}</style></head>
<body><div class="card"><h1>${TOOL_NAME} isn't available through the secure proxy</h1>
<p>${TOOL_NAME} uses a browser security check that can't be completed through our secure
proxy. This isn't a problem with your account. Please contact support for access options.</p>
<a href="https://app.genzdigitalstore.com/client/dashboard">Back to dashboard</a></div></body></html>`;
  res.writeHead(503, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
  res.end(html);
}

// ── Reload-loop breaker ──────────────────────────────────────────────────────
// A proxied SPA that re-navigates to the same path on every load creates an
// infinite blank-page loop (observed on this gateway: the same nav repeated
// hundreds of times). Track HTML navs per lease; if the SAME path repeats too
// often in a short window, serve a friendly notice instead of proxying again.
const NAV_LOOP_MAX = 6;            // repeats tolerated within the window
const NAV_LOOP_WINDOW_MS = 9000;
const navLoopState = new Map();    // jti -> { path, count, windowStart }
function isNavLoop(jti, navPath) {
  if (!jti) return false;
  const now = Date.now();
  const s = navLoopState.get(jti);
  if (!s || s.path !== navPath || (now - s.windowStart) > NAV_LOOP_WINDOW_MS) {
    navLoopState.set(jti, { path: navPath, count: 1, windowStart: now });
    return false;
  }
  s.count += 1;
  if (s.count > NAV_LOOP_MAX) { navLoopState.delete(jti); return true; } // reset so a manual retry is allowed
  return false;
}
const _navLoopGc = setInterval(() => { if (navLoopState.size > 500) navLoopState.clear(); }, 60000);
if (_navLoopGc.unref) _navLoopGc.unref();

// ── Header sanitising for proxied responses ──────────────────────────────────
const STRIP_RESP_HEADERS = new Set([
  'content-security-policy', 'content-security-policy-report-only',
  'x-frame-options', 'content-encoding', 'content-length', 'transfer-encoding',
  'strict-transport-security',
]);
function rewriteSetCookie(values) {
  return [].concat(values || []).map(v => v.replace(/;\s*Domain=[^;]+/ig, ''));
}

// ── Overlay injection ─────────────────────────────────────────────────────────
// ── Critical hide CSS (injected at the START of <head> → applies before first paint) ──
// Ports the StealthWriter gateway's no-flash fix to every proxy tool: the static
// account / billing / pricing / settings / logout hiding rules ship in the initial
// <head> so the browser never paints them, instead of overlay.js adding them after the
// app has already rendered (which caused a 1–2s flash). href + aria-label/data-testid
// based (robust against obfuscated class names); operator HIDE_SELECTORS appended. The
// overlay's sweep()/MutationObserver remain the backup for text-matched / SPA nodes.
// NEVER matches the editor / chat / upload / result area.
function buildCriticalCss() {
  const hrefs = ['pricing', 'billing', 'account', 'affiliate', 'discord', '/faq', 'support',
    'subscription', 'upgrade', 'refer', '/plans', '/settings', '/profile', '/me',
    'api-key', 'apikey', 'logout', 'log-out', 'sign-out', 'signout'];
  const sel = hrefs.map(h => `a[href*="${h}" i]`);
  const attrs = ['account', 'profile', 'user menu', 'usermenu', 'user-menu', 'avatar',
    'upgrade', 'billing', 'subscription', 'affiliate', 'log out', 'logout', 'sign out'];
  attrs.forEach(a => { sel.push(`[aria-label*="${a}" i]`); sel.push(`[data-testid*="${a}" i]`); });
  HIDE_SELECTORS.forEach(s => sel.push(s));      // per-tool exact selectors
  sel.push('[data-genz-hidden="1"]');            // anything overlay.js marks at runtime
  return `/* genz critical hide */\n${sel.join(',')}{display:none !important;}`;
}
// Everything is injected into <head> so hiding applies before the app paints, and the
// overlay JS is INLINED (executes during head parse, no extra round-trip) so its
// MutationObserver is registered before <body> content is inserted. Capture (admin)
// mode omits the critical CSS so the operator can still reach account pages to log in.
function injectOverlay(html, capture) {
  const cfg = JSON.stringify({ api: API_BASE, capture: !!capture, toolName: TOOL_NAME, tool: TOOL_KEY, hideSelectors: HIDE_SELECTORS });
  const critical = capture ? '' : `<style id="genz-critical-hide">${buildCriticalCss()}</style>`;
  const tags =
    critical +
    `<link rel="stylesheet" href="/__genz/overlay.css">` +
    `<script>window.__GENZ_GATEWAY__=${cfg};</script>` +
    `<script id="genz-overlay">${OVERLAY_JS_INLINE}</script>`;
  const m = html.match(/<head[^>]*>/i);
  if (m) return html.replace(m[0], m[0] + tags);
  if (html.includes('</body>')) return html.replace('</body>', tags + '</body>');
  if (html.includes('</html>')) return html.replace('</html>', tags + '</html>');
  return html + tags;
}
function injectSessionBootstrap(html, session) {
  if (!session || (!session.localStorage && !session.sessionStorage)) return html;
  const ls = JSON.stringify(session.localStorage || {});
  const ss = JSON.stringify(session.sessionStorage || {});
  const script = `<script>(function(){try{var L=${ls};for(var k in L)localStorage.setItem(k,L[k]);}catch(e){}try{var S=${ss};for(var k in S)sessionStorage.setItem(k,S[k]);}catch(e){}})();</script>`;
  const m = html.match(/<head[^>]*>/i);
  if (m) return html.replace(m[0], m[0] + script);
  return script + html;
}

// ── Upstream request headers ─────────────────────────────────────────────────
// The target sites sit behind Cloudflare bot management. The top-level document
// navigation gets a MINIMAL, clean, consistent fingerprint (the shape that passes
// Cloudflare — same as the backend verifier). Every other request (assets, XHR,
// _next/data, API) FORWARDS the app's own headers so the SPA keeps working, but with
// the UA + client-hints pinned and the proxy/hop headers stripped. UA is pinned
// everywhere so a Cloudflare cf_clearance cookie (bound to its minting UA) stays valid.
function buildUpstreamHeaders(req, upURL, session, minimal) {
  let headers;
  if (minimal) {
    headers = {
      host: upURL.host,
      'user-agent': UPSTREAM_UA,
      'sec-ch-ua': UPSTREAM_CH_UA, 'sec-ch-ua-mobile': '?0', 'sec-ch-ua-platform': UPSTREAM_CH_PLATFORM,
      'upgrade-insecure-requests': '1',
      'accept': req.headers['accept'] || 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8',
      'accept-language': req.headers['accept-language'] || 'en-US,en;q=0.9',
      'accept-encoding': 'identity',
      'sec-fetch-dest': 'document', 'sec-fetch-mode': 'navigate', 'sec-fetch-site': 'none', 'sec-fetch-user': '?1',
    };
    for (const h of ['content-type', 'content-length', 'x-requested-with']) if (req.headers[h]) headers[h] = req.headers[h];
  } else {
    headers = { ...req.headers };
    headers.host = upURL.host;
    headers['user-agent'] = UPSTREAM_UA;
    headers['sec-ch-ua'] = UPSTREAM_CH_UA; headers['sec-ch-ua-mobile'] = '?0'; headers['sec-ch-ua-platform'] = UPSTREAM_CH_PLATFORM;
    for (const h of STRIP_REQ_HEADERS) delete headers[h];
  }
  // Overlay/rewriting need uncompressed bodies.
  headers['accept-encoding'] = 'identity';
  // Rewrite Origin/Referer to the upstream origin so CSRF/same-origin checks pass.
  if (req.headers.origin) headers.origin = upURL.origin;
  if (req.headers.referer) {
    try { const rf = new URL(req.headers.referer); rf.protocol = upURL.protocol; rf.host = upURL.host; headers.referer = rf.toString(); }
    catch (_) { headers.referer = upURL.origin + '/'; }
  }
  // Our lease cookie never goes upstream; inject the vault account's cookies (client
  // lease) or pass the admin's own login cookies (capture). Asset/CDN origins get none.
  delete headers.cookie;
  if (session && session.cookieHeader) {
    headers.cookie = session.cookieHeader;
    // CF pass-through: also forward the browser's Cloudflare cookies (cf_clearance /
    // __cf_bm / cf_chl*) so a challenge solved through THIS gateway reaches the upstream
    // together with the vault session. Only Cloudflare-managed cookies are forwarded.
    if (CF_CHALLENGE_PASSTHROUGH) {
      const cf = extractCfCookies(req.headers.cookie);
      if (cf) headers.cookie = mergeCookieHeaders(headers.cookie, cf);
    }
  }
  else if (session && session.noAccount) { const p = stripLeaseCookie(req.headers.cookie); if (p) headers.cookie = p; }
  return headers;
}

// ── Reverse proxy ──────────────────────────────────────────────────────────────
function proxy(req, res, isHtmlNav, session, ctx) {
  ctx = ctx || {};
  const upOrigin = ctx.upstreamOrigin || TARGET_ORIGIN;
  let upURL; try { upURL = new URL(upOrigin); } catch (_) { upURL = targetUrl; }
  const upLib = upURL.protocol === 'https:' ? https : http;
  const upPath = ctx.upstreamPath || req.url;
  const reqPathOnly = String(upPath).split('?')[0];
  // Minimal fingerprint ONLY for the top-level document navigation (the Cloudflare-
  // sensitive request); assets/XHR/API forward the app's headers.
  const minimal = !!isHtmlNav && !ctx.asset;
  // A captcha request is either a proxied third-party provider origin (ctx.captcha) OR a
  // same-origin self-proxied path like hix.ai/recaptcha/… . Both need the `co` origin and
  // Origin/Referer presented as the TOOL, and their bodies left intact (no rewrite/overlay).
  const isCaptchaReq = !!ctx.captcha || CAPTCHA_PATH_RE.test(reqPathOnly);
  // Rewrite the reCAPTCHA `co` (embedding origin) param in the query: gateway host → tool.
  const effUpPath = isCaptchaReq ? rewriteCaptchaCo(upPath) : upPath;

  const chunks = [];
  req.on('data', c => chunks.push(c));
  req.on('end', () => {
    let bodyBuf = Buffer.concat(chunks);
    const headers = buildUpstreamHeaders(req, upURL, session, minimal);

    // Captcha: present the TOOL's origin so a domain-bound widget renders for its key
    // (the user still solves it). Origin/Referer forced to the tool; the `co` origin in a
    // form-encoded POST body (anchor/reload) is rewritten too.
    if (isCaptchaReq) {
      headers.origin = TARGET_ORIGIN;
      headers.referer = TARGET_ORIGIN + '/';
      if (bodyBuf.length && /application\/x-www-form-urlencoded/i.test(headers['content-type'] || '')) {
        const rewritten = rewriteCaptchaCo('?' + bodyBuf.toString('utf8')).slice(1);
        bodyBuf = Buffer.from(rewritten, 'utf8');
        headers['content-length'] = Buffer.byteLength(bodyBuf);
      }
    }

    const upstream = upLib.request(`${upURL.origin}${effUpPath}`, { method: req.method, headers }, (uRes) => {
      const ct = String(uRes.headers['content-type'] || '');
      const isHtml = ct.includes('text/html');
      const rawLoc = String(uRes.headers['location'] || '');
      const redirectedToLogin = uRes.statusCode >= 300 && uRes.statusCode < 400 && /\/(sign-?in|log-?in|auth\/login)\b/i.test(rawLoc);
      const upstreamForbidden = uRes.statusCode === 401 || uRes.statusCode === 403;
      // Detect a genuine Cloudflare challenge on a client view. How we respond depends on
      // CF_CHALLENGE_MODE: 'passthrough' serves it for the user to solve (and gets NO
      // overlay/identity injection); 'unsupported' shows a clear notice; else block page.
      const cfChallengeDetected = !ctx.capture && !ctx.asset && !isCaptchaReq
        && isCloudflareChallenge(uRes.statusCode, uRes.headers);
      const cfPassthrough = cfChallengeDetected && CF_CHALLENGE_MODE === 'passthrough';

      // Safe debug — IDs/paths/status only, NEVER cookies/tokens/secrets. Logged for
      // navigations and for any failing/asset-relevant response.
      const logIt = (asset_rewrite_applied) => {
        // Safe debug — log navigations and any failing/redirected response (set
        // PROXY_LOG_ALL=1 to log every asset/XHR). Never cookies/tokens/secrets.
        const verbose = process.env.PROXY_LOG_ALL === '1';
        if (!(verbose || isHtmlNav || uRes.statusCode >= 400 || redirectedToLogin)) return;
        const rec = {
          tool_code: TOOL_KEY,
          request_path: reqPathOnly,
          upstream_url: `${upURL.origin}${reqPathOnly}`,
          upstream_status: uRes.statusCode,
          content_type: ct.split(';')[0] || null,
          asset_rewrite_applied: !!asset_rewrite_applied,
          redirected_to_login: redirectedToLogin,
          cookies_attached: (session && session.cookieCount) || 0,
          is_nav: !!isHtmlNav,
          lease_id: ctx.jti || null,
        };
        // Captcha-debug: the reCAPTCHA query carries only public values (k=sitekey,
        // co=origin, v=version, hl=lang) — no secrets — and shows exactly where/how the
        // widget tries to load, plus where the upstream redirects it.
        if (isCaptchaReq) {
          rec.captcha = true;
          rec.method = req.method;
          rec.query = (String(effUpPath).split('?')[1] || '').slice(0, 400);
          rec.location = (uRes.headers['location'] || '').slice(0, 300) || undefined;
        }
        safeLog(ctx.asset ? 'asset' : 'proxy', rec);
      };

      // A real login redirect on the main tool nav → flag the account session_expired
      // so it is skipped for NEW leases (not on a generic 401/403 WAF block).
      if (isHtmlNav && redirectedToLogin && !ctx.capture && session && session.accountId && ctx.token) {
        gatewayApiPost('/account-expired', ctx.token, {}).then(() => {}).catch(() => {});
      }

      // Never pass a raw upstream "Forbidden"/login document to the client (main view
      // only — captcha sub-responses handle their own errors). A detected Cloudflare
      // challenge branches on the configured mode instead of always blocking.
      if ((isHtmlNav || isHtml) && upstreamForbidden && !ctx.capture && !ctx.asset && !isCaptchaReq && !cfPassthrough) {
        if (cfChallengeDetected && CF_CHALLENGE_MODE === 'unsupported') {
          logIt(false); uRes.resume();
          safeLog('cf_unsupported', { request_path: reqPathOnly, upstream_status: uRes.statusCode, is_nav: !!isHtmlNav });
          return isHtmlNav ? sendUnsupportedPage(res) : sendBlockPage(res, 'unavailable');
        }
        logIt(false);
        uRes.resume();
        return sendBlockPage(res, 'unavailable');
      }
      if (cfPassthrough) safeLog('cf_challenge_passthrough', { request_path: reqPathOnly, upstream_status: uRes.statusCode, is_nav: !!isHtmlNav });

      const outHeaders = {};
      for (const [k, v] of Object.entries(uRes.headers)) {
        if (STRIP_RESP_HEADERS.has(k.toLowerCase())) continue;
        if (k.toLowerCase() === 'set-cookie') { outHeaders[k] = rewriteSetCookie(v); continue; }
        if (k.toLowerCase() === 'location' && typeof v === 'string') { outHeaders[k] = rewriteUpstreamUrls(v).text; continue; }
        outHeaders[k] = v;
      }

      const sanitizeJson = ctx.sanitizeBody && ct.includes('application/json') && !ct.includes('event-stream') && !ctx.capture;
      // Never rewrite captcha JS/JSON bodies — Google's minified reCAPTCHA code must be
      // served byte-for-byte intact (the in-browser shim + co-rewrite handle routing).
      const rewriteText = isRewritableText(ct) && !isCaptchaReq;

      if (isHtml) {
        const buf = [];
        uRes.on('data', c => buf.push(c));
        uRes.on('end', () => {
          let html = Buffer.concat(buf).toString('utf8');
          // Logged-out guard (opt-in): if the injected vault session is dead, the main view
          // is the tool's PUBLIC page. Flag the account expired + show a friendly notice
          // instead of leaking the public login/sign-up page to the client. Only when we
          // actually attached account cookies (we expected a logged-in page).
          if (DETECT_LOGGED_OUT && isHtmlNav && !ctx.asset && !isCaptchaReq && !cfPassthrough
              && !ctx.capture && session && session.cookieCount > 0 && htmlLooksLoggedOut(html)) {
            uRes.resume && uRes.resume();
            safeLog('logged_out_detected', { request_path: reqPathOnly, lease_id: ctx.jti || null });
            if (ctx.token) gatewayApiPost('/account-expired', ctx.token, {}).then(() => {}).catch(() => {});
            return sendBlockPage(res, 'session_expired');
          }
          html = neutralizeHostGuard(html);
          html = stripSecurityMeta(html);
          const rw = rewriteUpstreamUrls(html); html = rw.text;
          // Only the MAIN app view gets the overlay/identity treatment. Proxied asset and
          // captcha HTML (e.g. the reCAPTCHA iframe document), and a passed-through
          // Cloudflare challenge page, are rewritten for same-origin loading but otherwise
          // left intact so the challenge renders and solves cleanly.
          if (!ctx.asset && !isCaptchaReq && !cfPassthrough) {
            if (IDENTITY_SHIELD && !ctx.capture) html = redactHtmlIdentity(html);
            // All three are <head> inserts placed immediately after <head>, so the LAST
            // call ends up FIRST in the document. Order them so the captcha shim and the
            // session bootstrap still run before the app's own scripts, while the overlay
            // (critical hide CSS + widget) is injected before <body> paints (no flash).
            html = injectOverlay(html, ctx.capture);
            html = injectSessionBootstrap(html, session);
            html = injectCaptchaShim(html); // last <head> insert → runs FIRST, before app scripts
          }
          outHeaders['content-type'] = 'text/html; charset=utf-8';
          outHeaders['cache-control'] = 'no-store';
          logIt(rw.applied);
          res.writeHead(uRes.statusCode || 200, outHeaders);
          res.end(html);
        });
      } else if (sanitizeJson || rewriteText) {
        const buf = [];
        uRes.on('data', c => buf.push(c));
        uRes.on('end', () => {
          let body = Buffer.concat(buf).toString('utf8');
          if (sanitizeJson) body = sanitizeJsonBody(body);
          const rw = rewriteUpstreamUrls(body); body = rw.text;
          if (sanitizeJson) outHeaders['cache-control'] = 'no-store';
          logIt(rw.applied);
          res.writeHead(uRes.statusCode || 200, outHeaders);
          res.end(body);
        });
      } else {
        logIt(false);
        res.writeHead(uRes.statusCode || 200, outHeaders);
        uRes.pipe(res);
      }
    });
    // Upstream failure / timeout handling: never hang the browser on a dead or slow
    // upstream. A main page navigation gets a friendly retry page (not a blank screen
    // or bare error); asset/API requests get a plain 502 the browser can handle.
    const onUpstreamFail = () => {
      if (res.headersSent) { try { res.end(); } catch (_) {} return; }
      if (isHtmlNav && !ctx.asset && !isCaptchaReq && !ctx.capture) {
        return sendNoticePage(res, {
          status: 502,
          title: `${TOOL_NAME} is unavailable right now`,
          msg: `We couldn't reach ${TOOL_NAME}. This is usually temporary — please try again in a moment.`,
        });
      }
      res.writeHead(502, { 'content-type': 'text/plain', 'cache-control': 'no-store' });
      res.end('Upstream error');
    };
    upstream.setTimeout(UPSTREAM_TIMEOUT_MS, () => { try { upstream.destroy(new Error('upstream_timeout')); } catch (_) {} });
    upstream.on('error', onUpstreamFail);
    upstream.end(bodyBuf);
  });
}

// ── Request handler ─────────────────────────────────────────────────────────────
const server = http.createServer(async (req, res) => {
  const u = new URL(req.url, 'http://localhost');
  const pathName = u.pathname;

  if (pathName === '/__genz/overlay.js') {
    res.writeHead(200, { 'content-type': 'application/javascript; charset=utf-8', 'cache-control': 'no-cache' });
    return res.end(OVERLAY_JS);
  }
  if (pathName === '/__genz/overlay.css') {
    res.writeHead(200, { 'content-type': 'text/css; charset=utf-8', 'cache-control': 'no-cache' });
    return res.end(OVERLAY_CSS);
  }

  // Lease-free health/status endpoint. Returns a clear JSON readiness report instead
  // of a blank page or 403 when something is misconfigured. SECRET-SAFE: only booleans
  // and the NAMES of any missing env vars — never their values, tokens, or cookies.
  if (pathName === '/__genz/health') {
    const missingEnv = [
      !TARGET_ORIGIN && 'TARGET_ORIGIN',
      !API_BASE && 'API_BASE',
      !PUBLIC_ORIGIN && 'GATEWAY_PUBLIC_ORIGIN',
      !LEASE_SECRET && 'LEASE_SECRET',
      !GATEWAY_KEY && 'GATEWAY_KEY',
      !TOOL_KEY && 'TOOL_KEY',
    ].filter(Boolean);
    const body = {
      ok: missingEnv.length === 0,
      tool: TOOL_KEY || null,
      name: TOOL_NAME,
      target: (() => { try { return new URL(TARGET_ORIGIN).host; } catch (_) { return null; } })(),
      defaultPath: DEFAULT_PATH,
      config: {
        hasTargetOrigin: !!TARGET_ORIGIN,
        hasApiBase: !!API_BASE,
        hasPublicOrigin: !!PUBLIC_ORIGIN,
        hasLeaseSecret: !!LEASE_SECRET,
        hasGatewayKey: !!GATEWAY_KEY,
        assetOrigins: ASSET_ORIGINS.length,
      },
      missingEnv,
    };
    res.writeHead(missingEnv.length ? 503 : 200, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
    return res.end(JSON.stringify(body));
  }

  // Proxied CDN/asset/API origins (rewritten into the page as /__pxo/<i>/…). Served
  // through the gateway so the browser loads them same-origin. Gated by a valid lease
  // cookie so the gateway is never an open proxy; no per-asset backend call (perf) and
  // no account cookies injected (these origins host public assets).
  if (pathName === ASSET_PREFIX || pathName.startsWith(ASSET_PREFIX + '/')) {
    const after = req.url.slice(ASSET_PREFIX.length).replace(/^\//, ''); // "<i>/path?query"
    const mm = after.match(/^(\d+)(\/[\s\S]*)?$/);
    const idx = mm ? parseInt(mm[1], 10) : -1;
    const entry = PROXIED_ORIGINS[idx];
    const token = getLease(req);
    if (!entry || !token || verifyLeaseLocal(token) === null) {
      res.writeHead(404, { 'content-type': 'text/plain', 'cache-control': 'no-store' });
      return res.end('Not found');
    }
    const baseUrl = new URL(entry.base);
    const rest = (mm && mm[2]) ? mm[2] : '/'; // proxy() applies the reCAPTCHA `co` rewrite
    const upstreamPath = baseUrl.pathname.replace(/\/$/, '') + rest;
    return proxy(req, res, false, { noAccount: true }, {
      token, asset: true, captcha: entry.captcha, upstreamOrigin: baseUrl.origin, upstreamPath,
    });
  }

  // Entry point: capture the lease into a host-scoped cookie, redirect to the tool.
  if (pathName === '/gateway') {
    const token = u.searchParams.get('lease');
    if (!token) return sendBlockPage(res, 'lease_missing');
    const secure = (PUBLIC_ORIGIN.startsWith('https://')) ? ' Secure;' : '';
    const cap = !!(verifyLeaseLocal(token) || {}).cap;
    const landing = cap ? SIGNIN_PATH : DEFAULT_PATH;
    res.writeHead(302, {
      'set-cookie': `${LEASE_COOKIE}=${encodeURIComponent(token)}; Path=/; SameSite=Lax;${secure}`,
      'location': landing,
      'cache-control': 'no-store',
    });
    return res.end();
  }

  const token = getLease(req);
  if (!token) return sendBlockPage(res, 'lease_missing');

  const local = verifyLeaseLocal(token);
  if (local === null) return sendBlockPage(res, 'lease_invalid');
  const capture = !!(local && local.cap);

  // Capture-mode save: collect the cookies accumulated under this gateway host and
  // post them to the backend (server-side) to (re)fill the account.
  if (pathName === '/__genz/save-session') {
    if (!capture) { res.writeHead(403, { 'content-type': 'application/json' }); return res.end('{"ok":false,"code":"not_capture"}'); }
    const raw = stripLeaseCookie(req.headers.cookie);
    const r = await gatewayApiPost('/capture-session', token, { cookies: raw });
    safeLog('capture-save', { lease_id: local && local.jti, account_id: (local && local.acid) || null, upstream_status: r.status, cookies_count_attached: raw ? raw.split('; ').filter(Boolean).length : 0 });
    res.writeHead((r.status === 200 && r.body && r.body.ok) ? 200 : 400, { 'content-type': 'application/json', 'cache-control': 'no-store' });
    return res.end(JSON.stringify(r.body || { ok: false }));
  }

  const accept = String(req.headers.accept || '');
  const isHtmlNav = req.method === 'GET' && accept.includes('text/html');
  if (isHtmlNav && !capture) {
    const v = await backendValidate(token);
    if (v.status === 0) {
      if (local && local.unknown) return sendBlockPage(res, 'lease_invalid');
    } else if (v.status !== 200 || !v.body || v.body.valid !== true) {
      return sendBlockPage(res, (v.body && v.body.code) || 'lease_expired');
    }
  }

  // ── Reload-loop guard (client leases only) ────────────────────────────────
  // If a page navigation to the SAME path repeats abnormally often for one lease in
  // a short window, the proxied SPA is stuck re-navigating (infinite blank/loading
  // loop). Break it with a friendly retry page rather than letting the browser hammer
  // the upstream forever. Asset/API requests are not counted (HTML navs only).
  if (!capture && isHtmlNav && isNavLoop(local && local.jti, pathName)) {
    safeLog('nav_loop_break', { request_path: pathName, lease_id: local && local.jti });
    return sendNoticePage(res, {
      status: 503,
      title: `${TOOL_NAME} is having trouble loading`,
      msg: `${TOOL_NAME} kept reloading and couldn't finish opening. This usually clears on a retry; if it keeps happening, reopen ${TOOL_NAME} from your dashboard.`,
    });
  }

  // ── Server-side account/billing/logout shield (client leases only) ─────────
  // Route blocking is auth-safe and ON by default (ACCOUNT_SHIELD). It is intentionally
  // SEPARATE from the default-OFF IDENTITY_SHIELD, which additionally deep-redacts the
  // identity JSON (and can log token SPAs out) via sanitizeBody below.
  if (!capture) {
    // 1) Logout / sign-out: never proxied — it would destroy the shared vault session
    //    for every client. Nav bounces back into the tool; API calls get a benign no-op
    //    so the app's own in-page session token is left intact.
    if (LOGOUT_RE.test(pathName)) {
      safeLog('route_blocked', { request_path: pathName, kind: 'logout', is_nav: isHtmlNav });
      if (isHtmlNav) { res.writeHead(302, { location: DEFAULT_PATH, 'cache-control': 'no-store' }); return res.end(); }
      res.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store' });
      return res.end('{}');
    }
    if (ACCOUNT_SHIELD) {
      // 2) Account / billing / subscription / settings PAGE loads → friendly notice
      //    (instead of breaking the tool or silently bouncing).
      if (isHtmlNav && isBlockedAccountNav(pathName)) {
        safeLog('route_blocked', { request_path: pathName, kind: 'nav' });
        return sendAccountNotice(res, DEFAULT_PATH);
      }
      // 3) Pure billing / payment / pricing API → empty stub, never proxied.
      if (!isHtmlNav && isStubApi(pathName)) {
        safeLog('route_blocked', { request_path: pathName, kind: 'api_stub' });
        res.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store' });
        return res.end('{}');
      }
    }
  }
  // 4) Identity JSON deep-redaction stays OPT-IN (IDENTITY_SHIELD) — it preserves auth
  //    structure but can break token SPAs, so it's per-tool and off by default.
  const sanitizeBody = IDENTITY_SHIELD && !capture && IDENTITY_ROUTE_RE.test(pathName);

  let session;
  if (capture) {
    session = { noAccount: true, capture: true };
  } else {
    session = await getSession(token, local && local.jti);
    if (session && session.blocked) return sendBlockPage(res, session.code || 'account_no_session');
  }

  return proxy(req, res, isHtmlNav, session, { token, jti: local && local.jti, capture, sanitizeBody });
});

server.listen(PORT, () => {
  console.log(`${TOOL_NAME} proxy gateway listening on :${PORT}`);
  console.log(`  tool      -> ${TOOL_KEY}`);
  console.log(`  proxying  -> ${TARGET_ORIGIN}`);
  console.log(`  api base  -> ${API_BASE}`);
});
