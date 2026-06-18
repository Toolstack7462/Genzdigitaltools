'use strict';
/**
 * StealthWriter Proxy Gateway — standalone reverse proxy.
 *
 * Deployed at https://stealth1.genzdigitalstore.com. It:
 *   1. Accepts a signed lease at /gateway?lease=TOKEN, stores it in a host-scoped
 *      cookie, and redirects to the app root.
 *   2. Validates the lease on EVERY request (signature + expiry locally; for HTML
 *      page loads it additionally calls the Genz backend /validate endpoint, which
 *      is the authoritative source for revocation, client status, plan expiry and
 *      usage limits). When invalid/expired it serves a block page instead of the app.
 *   3. Reverse-proxies everything else to the real StealthWriter origin, injecting a
 *      small Genz usage overlay (countdown + remaining limits) into HTML responses
 *      and stripping frame-blocking headers.
 *
 * Dependency-free (Node core only). Never logs cookies, tokens, headers or secrets.
 *
 * Required env: STEALTH_TARGET_ORIGIN, STEALTH_LEASE_SECRET (must match backend),
 *               STEALTH_API_BASE, GATEWAY_PUBLIC_ORIGIN. See .env.example.
 */
const http = require('http');
const https = require('https');
const { URL } = require('url');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

// Minimal .env loader — dependency-free so the gateway needs no `npm install`.
// Only sets keys NOT already present in the real environment (hPanel/Passenger wins).
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
  } catch (_) { /* no .env file — rely on real environment */ }
})();

// Passenger may pass a unix socket path in PORT — pass it through unchanged.
const PORT = process.env.PORT || 3000;
const TARGET_ORIGIN = (process.env.STEALTH_TARGET_ORIGIN || '').replace(/\/$/, '');
const API_BASE = (process.env.STEALTH_API_BASE || '').replace(/\/$/, ''); // e.g. https://api.genzdigitalstore.com/api/crm/stealth/gateway
const PUBLIC_ORIGIN = (process.env.GATEWAY_PUBLIC_ORIGIN || '').replace(/\/$/, '');
// Landing path AFTER the lease cookie is set — go straight to the authenticated
// humanizer dashboard so a logged-in account is not bounced to the marketing/sign-in root.
function cleanPath(p, def) { p = String(p || '').trim(); if (!p) return def; return p.startsWith('/') ? p : '/' + p; }
const DEFAULT_PATH = cleanPath(process.env.STEALTH_DEFAULT_PATH, '/dashboard/humanizer');
const HUMANIZER_PATH = cleanPath(process.env.STEALTH_HUMANIZER_PATH, '/dashboard/humanizer');
const DETECTOR_PATH = cleanPath(process.env.STEALTH_DETECTOR_PATH, '/dashboard/ai-detector');
const LEASE_SECRET = process.env.STEALTH_LEASE_SECRET || '';
const GATEWAY_KEY = process.env.STEALTH_GATEWAY_KEY || ''; // shared key for the backend /session endpoint
const LEASE_COOKIE = 'sw_lease';
const LEASE_TYPE = 'stealth_lease';

// Optional: extra CSS selectors (comma-separated) for StealthWriter's exact top-bar
// and bottom account-area containers. These are added to the critical hide CSS that
// is injected into <head> BEFORE first paint, so they never flash. Use this to hide
// StealthWriter's structural chrome (e.g. ".sidebar-account, header.topbar") that the
// generic href/attribute rules can't target by class alone. Editor/working area must
// NOT be matched here.
const EXTRA_HIDE_SELECTORS = String(process.env.STEALTH_HIDE_SELECTORS || '')
  .split(',').map(s => s.trim()).filter(Boolean);

// ════════════════════════════════════════════════════════════════════════════
// SERVER-SIDE IDENTITY / ACCOUNT / BILLING SHIELD
// The browser overlay (overlay.js) is now only a cosmetic *backup*. The real
// account name / email / plan / billing / logout are blocked or sanitized HERE,
// at the proxy, so they do not reach the browser in the first place.
// ════════════════════════════════════════════════════════════════════════════
const BRAND = 'Gen Z Digital Store';
const BRAND_EMAIL = 'member@genzdigitalstore.com';

// Logout / sign-out — must NEVER reach upstream: it would destroy the injected
// vault session for everyone. Navigations bounce to the editor; API calls are
// answered with a benign no-op so the app's own session token is left intact.
const LOGOUT_RE = /(^|\/)(logout|log-?out|sign-?out|signout)(\/|$)|auth\/(sign-?out|signout|logout)/i;

// Page navigations the member should never be able to open — bounced to the
// editor. (Matched on pathname only; the editor lives at /dashboard/* so it is
// never caught.)
const BLOCK_NAV_RE = /(^|\/)(billing|subscription|subscriptions|pricing|plans?|upgrade|checkout|account|account-settings|settings|profile|affiliate|refer|referral|invite|rewards)(\/|$)/i;

// Pure billing / payment / pricing API calls the editor never needs — answered
// with an empty stub instead of proxying, so no billing data reaches the browser.
const STUB_API_RE = /(^|\/)(billing|invoice|invoices|payment|payments|checkout|customer-portal|create-portal|portal|pricing|plans?|upgrade|affiliate|refer|referral|coupon|promo)(\/|$)/i;

// Responses on these routes may carry account identity / plan — their JSON bodies
// are deep-redacted (identity replaced with the brand; billing detail neutralized)
// while auth/session structure is preserved so the app stays logged in & working.
const IDENTITY_ROUTE_RE = /(^|\/)(session|get-session|user|users|me|account|accounts|profile|customer|subscription|subscriptions|membership)(\/|$|\.)|auth\/(session|get-session)/i;

// JSON key classes for deep redaction.
const KEY_NAME    = /^(name|fullname|full_name|displayname|display_name|firstname|first_name|lastname|last_name|username|user_name|nickname|handle)$/i;
const KEY_EMAIL   = /^(email|emailaddress|email_address|e_mail|billingemail|billing_email)$/i;
const KEY_NULLOUT = /^(avatar|avatarurl|avatar_url|image|imageurl|image_url|picture|photo|gravatar|phone|phonenumber|phone_number)$/i;
// Billing/financial detail — neutralized in type. Plan/tier/status are KEPT so
// the upstream app's own gating (which decides if Humanizer is usable) still works.
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
      } else {
        val[k] = deepRedact(v, depth + 1);
      }
    }
    return val;
  }
  return val; // primitives untouched
}

// Sanitize a JSON response body string. Fails safe: on any parse error the body
// is returned UNCHANGED so a non-identity payload is never corrupted.
function sanitizeJsonBody(text) {
  try { return JSON.stringify(deepRedact(JSON.parse(text), 0)); }
  catch (_) { return text; }
}

// Redact email addresses anywhere in an HTML / SSR payload (e.g. Next.js
// __NEXT_DATA__ / RSC flight data) so the real account email is never shipped.
// Names are intentionally NOT regex-replaced in HTML (too many false positives in
// framework state) — they are handled by the JSON session redaction + overlay.
const EMAIL_GLOBAL_RE = /[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi;
function redactHtmlIdentity(html) {
  try { return html.replace(EMAIL_GLOBAL_RE, BRAND_EMAIL); } catch (_) { return html; }
}

if (!TARGET_ORIGIN) { console.error('FATAL: STEALTH_TARGET_ORIGIN is required'); process.exit(1); }
if (!API_BASE) { console.error('FATAL: STEALTH_API_BASE is required'); process.exit(1); }
if (!LEASE_SECRET || LEASE_SECRET.length < 32) {
  console.warn('⚠️  STEALTH_LEASE_SECRET missing/weak — local lease verification disabled; relying on backend /validate only.');
}
if (!GATEWAY_KEY) {
  console.warn('⚠️  STEALTH_GATEWAY_KEY not set — Account Vault session injection disabled (proxy will not inject account sessions).');
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
function getLease(req) {
  return parseCookies(req.headers.cookie)[LEASE_COOKIE] || null;
}

// Strip ONLY the sw_lease cookie from a raw Cookie header, preserving every other
// cookie's value byte-for-byte (no decode/encode) — important for tokens like
// __Secure-better-auth.session_token that contain %2B / %2F / %3D / dots.
function stripLeaseCookie(rawCookieHeader) {
  return String(rawCookieHeader || '').split(';').map(s => s.trim()).filter(Boolean)
    .filter(p => { const i = p.indexOf('='); const name = (i < 0 ? p : p.slice(0, i)).trim(); return name !== LEASE_COOKIE; })
    .join('; ');
}

// ── Authoritative backend validation (HTML loads) ───────────────────────────
function backendValidate(token) {
  return new Promise((resolve) => {
    try {
      const u = new URL(`${API_BASE}/validate`);
      const lib = u.protocol === 'https:' ? https : http;
      const body = Buffer.from(JSON.stringify({}));
      const r = lib.request(u, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'content-length': body.length,
          'authorization': `Bearer ${token}`,
        },
        timeout: 5000,
      }, (resp) => {
        let data = '';
        resp.on('data', c => { data += c; });
        resp.on('end', () => {
          try { resolve({ status: resp.statusCode, body: JSON.parse(data || '{}') }); }
          catch { resolve({ status: resp.statusCode, body: {} }); }
        });
      });
      r.on('error', () => resolve({ status: 0, body: {} }));
      r.on('timeout', () => { r.destroy(); resolve({ status: 0, body: {} }); });
      r.end(body);
    } catch { resolve({ status: 0, body: {} }); }
  });
}

// ── Account Vault session (gateway-only) — fetch + short in-process cache ─────
// Calls the backend /session endpoint with the gateway key to obtain the decrypted
// session bundle for the lease's bound account, then injects it into upstream
// requests. Cached briefly per-lease to avoid a backend round-trip per asset.
const sessionCache = new Map(); // key -> { exp, data }
const SESSION_TTL_MS = 60 * 1000;

function fetchAccountSession(token) {
  return new Promise((resolve) => {
    if (!GATEWAY_KEY) return resolve({ noKey: true });
    try {
      const ul = new URL(`${API_BASE}/session`);
      const lib = ul.protocol === 'https:' ? https : http;
      const body = Buffer.from('{}');
      const r = lib.request(ul, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'content-length': body.length,
          'authorization': `Bearer ${token}`,
          'x-gateway-key': GATEWAY_KEY,
        },
        timeout: 5000,
      }, (resp) => {
        let d = '';
        resp.on('data', c => { d += c; });
        resp.on('end', () => { try { resolve({ status: resp.statusCode, body: JSON.parse(d || '{}') }); } catch { resolve({ status: resp.statusCode, body: {} }); } });
      });
      r.on('error', () => resolve({ status: 0, body: {} }));
      r.on('timeout', () => { r.destroy(); resolve({ status: 0, body: {} }); });
      r.end(body);
    } catch { resolve({ status: 0, body: {} }); }
  });
}

function hostMatchesCookieDomain(cookieDomain, host) {
  if (!cookieDomain) return true;
  const d = String(cookieDomain).replace(/^\./, '').toLowerCase();
  const h = String(host || '').toLowerCase();
  if (!h) return true;
  return h === d || h.endsWith('.' + d) || d.endsWith('.' + h);
}

// Build "name=value; ..." for the upstream target host. Includes only cookies whose
// domain matches the target (host-only cookies always included). Last value wins.
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

async function getSession(token, jti) {
  const key = jti || ('t:' + String(token).slice(-24));
  const hit = sessionCache.get(key);
  if (hit && hit.exp > Date.now()) return hit.data;
  const r = await fetchAccountSession(token);
  let data;
  if (r.noKey) data = { noAccount: true };                              // vault disabled — manual login
  else if (r.status === 0) data = hit ? hit.data : { noInject: true };  // transient backend blip — don't hard-block
  else if (r.body && r.body.ok === true && r.body.account == null) data = { noAccount: true };
  else if (r.body && r.body.ok === true && r.body.bundle) {
    const cookieHeader = buildCookieHeader(r.body.bundle);
    const cookieCount = cookieHeader ? cookieHeader.split('; ').filter(Boolean).length : 0;
    data = {
      cookieHeader,
      cookieCount,
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

// Generic gateway→backend POST (gateway-key + lease bearer). Used for the
// account-expired signal and capture-session save. Never carries the lease cookie
// to the browser; cookie payloads are sent only here, server-to-server.
function gatewayApiPost(subpath, token, jsonBody) {
  return new Promise((resolve) => {
    if (!GATEWAY_KEY) return resolve({ status: 0, body: {} });
    try {
      const ul = new URL(`${API_BASE}${subpath}`);
      const lib = ul.protocol === 'https:' ? https : http;
      const body = Buffer.from(JSON.stringify(jsonBody || {}));
      const r = lib.request(ul, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'content-length': body.length, 'authorization': `Bearer ${token}`, 'x-gateway-key': GATEWAY_KEY },
        timeout: 8000,
      }, (resp) => { let d = ''; resp.on('data', c => { d += c; }); resp.on('end', () => { try { resolve({ status: resp.statusCode, body: JSON.parse(d || '{}') }); } catch { resolve({ status: resp.statusCode, body: {} }); } }); });
      r.on('error', () => resolve({ status: 0, body: {} }));
      r.on('timeout', () => { r.destroy(); resolve({ status: 0, body: {} }); });
      r.end(body);
    } catch { resolve({ status: 0, body: {} }); }
  });
}

// Safe structured log — IDs / counts / status only. NEVER cookie names or values.
function safeLog(event, fields) {
  try { console.log(`[stealth-gw] ${event} ${JSON.stringify(fields)}`); } catch (_) {}
}

// ── Static assets (overlay) served locally under /__genz/ ────────────────────
const OVERLAY_JS = fs.readFileSync(path.join(__dirname, 'public', 'overlay.js'), 'utf8');
const OVERLAY_CSS = fs.readFileSync(path.join(__dirname, 'public', 'overlay.css'), 'utf8');

function sendBlockPage(res, code) {
  const messages = {
    lease_missing: 'No active session. Please reopen StealthWriter from your Gen Z dashboard.',
    lease_invalid: 'Your session token is invalid. Please reopen StealthWriter from your dashboard.',
    lease_expired: 'Your 30-minute session has ended. Reopen StealthWriter from your dashboard to continue.',
    lease_revoked: 'Your session was ended by an administrator.',
    client_disabled: 'Your StealthWriter access is disabled. Contact support.',
    plan_expired: 'Your StealthWriter plan has expired. Contact support to renew.',
    account_blocked: 'StealthWriter is temporarily unavailable. Please contact support.',
    account_no_session: 'StealthWriter is temporarily unavailable. Please contact support.',
    unavailable: 'Access could not be verified. Please refresh or contact support.',
  };
  // Never surface technical codes — anything unknown maps to a friendly message.
  const msg = messages[code] || 'Access could not be verified. Please refresh or contact support.';
  const html = `<!doctype html><html><head><meta charset="utf-8"><title>Session ended</title>
<meta name="viewport" content="width=device-width, initial-scale=1">
<style>body{margin:0;font-family:system-ui,-apple-system,Segoe UI,Roboto,sans-serif;background:#0b1220;color:#e2e8f0;display:flex;min-height:100vh;align-items:center;justify-content:center}
.card{max-width:420px;text-align:center;padding:40px 32px;background:#111a2e;border:1px solid rgba(6,182,212,.25);border-radius:16px}
h1{font-size:20px;margin:0 0 12px}p{color:#94a3b8;line-height:1.6;margin:0 0 20px}
a{display:inline-block;background:linear-gradient(135deg,#2563EB,#06B6D4);color:#fff;text-decoration:none;padding:11px 22px;border-radius:10px;font-weight:600}</style></head>
<body><div class="card"><h1>StealthWriter session ended</h1><p>${msg}</p>
<a href="https://app.genzdigitalstore.com/client/dashboard">Back to dashboard</a></div></body></html>`;
  res.writeHead(403, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
  res.end(html);
}

// ── Header sanitising for proxied responses ──────────────────────────────────
const STRIP_RESP_HEADERS = new Set([
  'content-security-policy', 'content-security-policy-report-only',
  'x-frame-options', 'content-encoding', 'content-length', 'transfer-encoding',
  'strict-transport-security',
]);
function rewriteSetCookie(values) {
  // Strip the upstream Domain attribute so cookies bind to the gateway host.
  return [].concat(values || []).map(v => v.replace(/;\s*Domain=[^;]+/ig, ''));
}

// ── Critical hide CSS (injected into <head>, applies before first paint) ────────
// This is the #1 fix for the "hidden UI flashes for 1–2s" problem: the static
// account / billing / pricing / support / plan / logout hiding rules are shipped in
// the initial HTML <head> so the browser never paints them, instead of being added
// by JS after the React app has already rendered. The overlay's MutationObserver is
// only a backup for text-matched / SPA-rerendered nodes (see overlay.js).
function buildCriticalCss() {
  // href-based (robust against obfuscated class names).
  const hrefs = ['pricing', 'billing', 'account', 'affiliate', 'discord', '/faq', 'support',
    'subscription', 'upgrade', 'refer', '/plans', '/settings', '/profile', '/me',
    'logout', 'log-out', 'sign-out', 'signout'];
  const sel = hrefs.map(h => `a[href*="${h}" i]`);
  // aria-label / data-testid based (account, profile, user-menu, billing, upgrade…).
  const attrs = ['account', 'profile', 'user menu', 'usermenu', 'user-menu', 'avatar',
    'upgrade', 'billing', 'subscription', 'affiliate', 'log out', 'logout', 'sign out'];
  attrs.forEach(a => { sel.push(`[aria-label*="${a}" i]`); sel.push(`[data-testid*="${a}" i]`); });
  // Operator-supplied exact selectors for StealthWriter's top bar / bottom account area.
  EXTRA_HIDE_SELECTORS.forEach(s => sel.push(s));
  // Anything the overlay JS marks for hiding.
  sel.push('[data-genz-hidden="1"]');
  return `/* genz critical hide */\n${sel.join(',')}{display:none !important;}`;
}

// ── Overlay injection ─────────────────────────────────────────────────────────
// Everything is injected into <head> so hiding applies before the app paints. The
// overlay JS is inlined (not an external <script src>) so it executes during head
// parse with zero extra network round-trip — its MutationObserver is registered
// before <body> content is inserted, eliminating the flash for text-matched nodes
// too. Building the floating widget still waits for DOMContentLoaded (see overlay.js).
const OVERLAY_JS_INLINE = OVERLAY_JS.replace(/<\/script>/gi, '<\\/script>');
function injectOverlay(html, capture) {
  const cfg = JSON.stringify({ api: API_BASE, capture: !!capture });
  // Capture (admin) mode must NOT hide account UI — the operator needs to log in and
  // reach account pages to capture a session — so the critical hide CSS is omitted.
  const critical = capture ? '' : `<style id="genz-critical-hide">${buildCriticalCss()}</style>`;
  const tags =
    critical +
    `<link rel="stylesheet" href="/__genz/overlay.css">` +
    `<script>window.__GENZ_GATEWAY__=${cfg};</script>` +
    `<script id="genz-overlay">${OVERLAY_JS_INLINE}</script>`;
  const m = html.match(/<head[^>]*>/i);
  if (m) return html.replace(m[0], m[0] + tags);
  // No <head> (rare / fragment) — fall back to before </body> or append.
  if (html.includes('</body>')) return html.replace('</body>', tags + '</body>');
  return html + tags;
}

// Inject the account's localStorage/sessionStorage before the app's own scripts run.
function injectSessionBootstrap(html, session) {
  if (!session || (!session.localStorage && !session.sessionStorage)) return html;
  const ls = JSON.stringify(session.localStorage || {});
  const ss = JSON.stringify(session.sessionStorage || {});
  const script = `<script>(function(){try{var L=${ls};for(var k in L)localStorage.setItem(k,L[k]);}catch(e){}try{var S=${ss};for(var k in S)sessionStorage.setItem(k,S[k]);}catch(e){}})();</script>`;
  const m = html.match(/<head[^>]*>/i);
  if (m) return html.replace(m[0], m[0] + script);
  return script + html;
}

// ── Reverse proxy ──────────────────────────────────────────────────────────────
function proxy(req, res, isHtmlNav, session, ctx) {
  ctx = ctx || {};
  const chunks = [];
  req.on('data', c => chunks.push(c));
  req.on('end', () => {
    const bodyBuf = Buffer.concat(chunks);
    const headers = { ...req.headers };
    headers.host = targetUrl.host;
    // Rewrite Origin/Referer to the upstream origin. The browser sends the gateway
    // host here; StealthWriter's CSRF / same-origin check rejects mutating POSTs
    // (Humanize / AI Detector) with a 403 Forbidden when Origin ≠ its own host —
    // even though the Genz limit is fine. GET page loads carry no Origin, so they
    // pass, which is why only the humanize/detect actions broke.
    if (headers.origin) headers.origin = targetUrl.origin;
    if (headers.referer) {
      try { const rf = new URL(headers.referer); rf.protocol = targetUrl.protocol; rf.host = targetUrl.host; headers.referer = rf.toString(); }
      catch (_) { headers.referer = targetUrl.origin + '/'; }
    }
    delete headers['accept-encoding']; // ask upstream for identity so we can inject
    headers['accept-encoding'] = 'identity';
    delete headers.cookie; // never forward our lease cookie upstream
    if (session && session.cookieHeader) {
      // Inject the selected vault account's session cookies (server-side only).
      headers.cookie = session.cookieHeader;
    } else if (session && session.noAccount) {
      // Legacy / no-vault / capture: pass through the browser's non-lease cookies
      // for the target — value-preserving (no decode/encode).
      const passthru = stripLeaseCookie(req.headers.cookie);
      if (passthru) headers.cookie = passthru;
    }

    const upstream = httpLib.request(`${TARGET_ORIGIN}${req.url}`, { method: req.method, headers }, (uRes) => {
      const ct = String(uRes.headers['content-type'] || '');
      const isHtml = ct.includes('text/html');
      const rawLoc = String(uRes.headers['location'] || '');
      const redirectedToSignIn = uRes.statusCode >= 300 && uRes.statusCode < 400 && /\/(sign-?in|login|auth\/login)\b/i.test(rawLoc);
      const upstreamForbidden = uRes.statusCode === 401 || uRes.statusCode === 403;
      const errorSource = (redirectedToSignIn || upstreamForbidden) ? 'upstream' : null;

      if (isHtmlNav) {
        safeLog('proxy', {
          request_path: String(req.url || '').split('?')[0],
          lease_id: ctx.jti || null,
          account_id: (session && session.accountId) || null,
          account_label: (session && session.accountLabel) || null,
          has_session_cookie: !!(session && (session.hasSessionCookie || (session.cookieCount || 0) > 0)),
          cookies_count_attached: (session && session.cookieCount) || 0,
          target_path: String(req.url || '').split('?')[0],
          response_status: uRes.statusCode,
          error_source: errorSource,
          redirected_to_sign_in: redirectedToSignIn,
        });
        // Flag the account session_expired ONLY on a real /sign-in redirect — not on
        // a generic 401/403 (which may be a WAF/Cloudflare block, not a dead session).
        if (redirectedToSignIn && !ctx.capture && session && session.accountId && ctx.token) {
          gatewayApiPost('/account-expired', ctx.token, {}).then(() => {}).catch(() => {});
        }
      }

      // Never pass a raw upstream "Forbidden"/login document through to the client.
      // Serve a clean page; the floating widget explains it in friendly terms.
      // Covers both top-level navigations and any HTML error doc the app fetches.
      if ((isHtmlNav || isHtml) && upstreamForbidden && !ctx.capture) {
        // Safe log: status + source only — never cookies, tokens, headers or secrets.
        safeLog('forbidden_blocked', {
          request_path: String(req.url || '').split('?')[0],
          lease_id: ctx.jti || null,
          account_id: (session && session.accountId) || null,
          response_status: uRes.statusCode,
          reason: 'upstream_forbidden',
          error_source: 'upstream',
        });
        uRes.resume(); // drain
        return sendBlockPage(res, 'unavailable');
      }

      const outHeaders = {};
      for (const [k, v] of Object.entries(uRes.headers)) {
        if (STRIP_RESP_HEADERS.has(k.toLowerCase())) continue;
        if (k.toLowerCase() === 'set-cookie') { outHeaders[k] = rewriteSetCookie(v); continue; }
        if (k.toLowerCase() === 'location' && PUBLIC_ORIGIN && typeof v === 'string') {
          outHeaders[k] = v.replace(TARGET_ORIGIN, PUBLIC_ORIGIN); continue;
        }
        outHeaders[k] = v;
      }

      // JSON identity sanitization: only buffer+rewrite identity/account routes,
      // and never an event-stream — so humanizer/detector responses (which may
      // stream) pipe straight through untouched and usage counting is unaffected.
      const sanitizeJson = ctx.sanitizeBody && ct.includes('application/json') && !ct.includes('event-stream') && !ctx.capture;

      if (isHtml) {
        const buf = [];
        uRes.on('data', c => buf.push(c));
        uRes.on('end', () => {
          let html = Buffer.concat(buf).toString('utf8');
          if (!ctx.capture) html = redactHtmlIdentity(html); // strip account emails from SSR/state
          html = injectSessionBootstrap(html, session);
          html = injectOverlay(html, ctx.capture);
          outHeaders['content-type'] = 'text/html; charset=utf-8';
          outHeaders['cache-control'] = 'no-store';
          res.writeHead(uRes.statusCode || 200, outHeaders);
          res.end(html);
        });
      } else if (sanitizeJson) {
        const buf = [];
        uRes.on('data', c => buf.push(c));
        uRes.on('end', () => {
          const out = sanitizeJsonBody(Buffer.concat(buf).toString('utf8'));
          outHeaders['cache-control'] = 'no-store';
          res.writeHead(uRes.statusCode || 200, outHeaders);
          res.end(out);
        });
      } else {
        res.writeHead(uRes.statusCode || 200, outHeaders);
        uRes.pipe(res);
      }
    });
    upstream.on('error', () => { if (!res.headersSent) { res.writeHead(502, { 'content-type': 'text/plain' }); } res.end('Upstream error'); });
    upstream.end(bodyBuf);
  });
}

// ── Request handler ─────────────────────────────────────────────────────────────
const server = http.createServer(async (req, res) => {
  const u = new URL(req.url, 'http://localhost');
  const pathName = u.pathname;

  // Local overlay assets — never proxied, never gated.
  if (pathName === '/__genz/overlay.js') {
    res.writeHead(200, { 'content-type': 'application/javascript; charset=utf-8', 'cache-control': 'no-cache' });
    return res.end(OVERLAY_JS);
  }
  if (pathName === '/__genz/overlay.css') {
    res.writeHead(200, { 'content-type': 'text/css; charset=utf-8', 'cache-control': 'no-cache' });
    return res.end(OVERLAY_CSS);
  }

  // Entry point: capture the lease, set a host-scoped cookie, redirect to app root.
  if (pathName === '/gateway') {
    const token = u.searchParams.get('lease');
    if (!token) return sendBlockPage(res, 'lease_missing');
    // Not HttpOnly on purpose: the injected overlay reads this to authenticate its
    // /validate and /consume calls. The lease is already visible in the open URL,
    // and it only authorizes metered, backend-validated StealthWriter usage.
    const secure = (PUBLIC_ORIGIN.startsWith('https://')) ? ' Secure;' : '';
    // Capture (admin) leases land on the sign-in page to log in fresh; client leases
    // land directly on the authenticated humanizer dashboard.
    const cap = !!(verifyLeaseLocal(token) || {}).cap;
    const landing = cap ? (process.env.STEALTH_SIGNIN_PATH || '/sign-in') : DEFAULT_PATH;
    res.writeHead(302, {
      'set-cookie': `${LEASE_COOKIE}=${encodeURIComponent(token)}; Path=/; SameSite=Lax;${secure}`,
      'location': landing,
      'cache-control': 'no-store',
    });
    return res.end();
  }

  const token = getLease(req);
  if (!token) return sendBlockPage(res, 'lease_missing');

  // Local signature/expiry check (fast fail).
  const local = verifyLeaseLocal(token);
  if (local === null) return sendBlockPage(res, 'lease_invalid');
  const capture = !!(local && local.cap); // admin "Refresh Cookies Through Proxy" lease

  // Capture-mode save: collect the StealthWriter cookies accumulated under this
  // gateway host (server-side) and post them to the backend to (re)fill the account.
  if (pathName === '/__genz/save-session') {
    if (!capture) { res.writeHead(403, { 'content-type': 'application/json' }); return res.end('{"ok":false,"code":"not_capture"}'); }
    const raw = stripLeaseCookie(req.headers.cookie); // value-preserving (no decode/encode)
    const r = await gatewayApiPost('/capture-session', token, { cookies: raw });
    safeLog('capture-save', { lease_id: local && local.jti, account_id: (local && local.acid) || null, upstream_status: r.status, cookies_count_attached: raw ? raw.split('; ').filter(Boolean).length : 0 });
    res.writeHead((r.status === 200 && r.body && r.body.ok) ? 200 : 400, { 'content-type': 'application/json', 'cache-control': 'no-store' });
    return res.end(JSON.stringify(r.body || { ok: false }));
  }

  // For top-level HTML navigations, authoritatively re-validate against the backend.
  // Capture leases have no client plan, so they skip the client/plan validation.
  const accept = String(req.headers.accept || '');
  const isHtmlNav = req.method === 'GET' && accept.includes('text/html');
  if (isHtmlNav && !capture) {
    const v = await backendValidate(token);
    if (v.status === 0) {
      // Backend unreachable — fail closed only if we couldn't verify locally either.
      if (local && local.unknown) return sendBlockPage(res, 'lease_invalid');
    } else if (v.status !== 200 || !v.body || v.body.valid !== true) {
      return sendBlockPage(res, (v.body && v.body.code) || 'lease_expired');
    }
  }

  // ── Server-side account/billing/logout shield ──────────────────────────────
  // Applied to real client leases only. Capture (admin) leases are exempt so the
  // operator can log in and reach account pages to capture a fresh session.
  if (!capture) {
    // 1) Logout / sign-out: never proxied — it would kill the shared vault session.
    if (LOGOUT_RE.test(pathName)) {
      safeLog('route_blocked', { request_path: pathName, kind: 'logout', is_nav: isHtmlNav });
      if (isHtmlNav) { res.writeHead(302, { location: DEFAULT_PATH, 'cache-control': 'no-store' }); return res.end(); }
      res.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store' });
      return res.end('{}');
    }
    // 2) Account / billing / subscription / pricing PAGE loads → bounce to editor.
    if (isHtmlNav && BLOCK_NAV_RE.test(pathName)) {
      safeLog('route_blocked', { request_path: pathName, kind: 'nav' });
      res.writeHead(302, { location: DEFAULT_PATH, 'cache-control': 'no-store' });
      return res.end();
    }
    // 3) Pure billing / payment / pricing API → empty stub, never proxied.
    if (!isHtmlNav && STUB_API_RE.test(pathName)) {
      safeLog('route_blocked', { request_path: pathName, kind: 'api_stub' });
      res.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store' });
      return res.end('{}');
    }
  }
  // 4) Identity/account/subscription responses get their JSON bodies deep-redacted
  //    (and HTML emails stripped) so real name/email/billing never reach the browser.
  const sanitizeBody = !capture && IDENTITY_ROUTE_RE.test(pathName);

  // Capture mode: do NOT inject the stored bundle — let the admin log in fresh so
  // the gateway can capture a session valid in the proxy context.
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
  console.log(`StealthWriter gateway listening on :${PORT}`);
  console.log(`  proxying  -> ${TARGET_ORIGIN}`);
  console.log(`  api base  -> ${API_BASE}`);
});
