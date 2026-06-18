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
const LEASE_TYPE = 'proxy_lease';

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
const LOGOUT_RE = /(^|\/)(logout|log-?out|sign-?out|signout)(\/|$)|auth\/(sign-?out|signout|logout)/i;
const BLOCK_NAV_RE = /(^|\/)(billing|subscription|subscriptions|pricing|plans?|upgrade|checkout|account|account-settings|settings|profile|affiliate|refer|referral|invite|rewards|api-keys?|apikeys?)(\/|$)/i;
const STUB_API_RE = /(^|\/)(billing|invoice|invoices|payment|payments|checkout|customer-portal|create-portal|portal|pricing|plans?|upgrade|affiliate|refer|referral|coupon|promo|api-keys?|apikeys?)(\/|$)/i;
const IDENTITY_ROUTE_RE = /(^|\/)(session|get-session|user|users|me|account|accounts|profile|customer|subscription|subscriptions|membership)(\/|$|\.)|auth\/(session|get-session)/i;
const KEY_NAME    = /^(name|fullname|full_name|displayname|display_name|firstname|first_name|lastname|last_name|username|user_name|nickname|handle)$/i;
const KEY_EMAIL   = /^(email|emailaddress|email_address|e_mail|billingemail|billing_email)$/i;
const KEY_NULLOUT = /^(avatar|avatarurl|avatar_url|image|imageurl|image_url|picture|photo|gravatar|phone|phonenumber|phone_number)$/i;
const KEY_BILLING = /^(price|priceid|price_id|amount|subtotal|total|currency|interval|card|cardlast4|last4|paymentmethod|payment_method|invoice|invoices|customerid|customer_id|stripeid|stripe_id|stripecustomerid|nextbillingdate|next_billing_date|renewaldate|renewal_date|billingaddress|billing_address|address|taxid|tax_id|vat|apikey|api_key|apikeys|api_keys|token|secret)$/i;

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

// ── Static assets (overlay) served locally under /__genz/ ────────────────────
const OVERLAY_JS = fs.readFileSync(path.join(__dirname, 'public', 'overlay.js'), 'utf8');
const OVERLAY_CSS = fs.readFileSync(path.join(__dirname, 'public', 'overlay.css'), 'utf8');

function sendBlockPage(res, code) {
  const messages = {
    lease_missing: `No active session. Please reopen ${TOOL_NAME} from your Gen Z dashboard.`,
    lease_invalid: `Your session token is invalid. Please reopen ${TOOL_NAME} from your dashboard.`,
    lease_expired: `Your 30-minute session has ended. Reopen ${TOOL_NAME} from your dashboard to continue.`,
    lease_revoked: 'Your session was ended by an administrator.',
    client_disabled: `Your ${TOOL_NAME} access is disabled. Contact support.`,
    plan_expired: `Your ${TOOL_NAME} access has expired. Contact support to renew.`,
    account_blocked: `${TOOL_NAME} is temporarily unavailable. Please contact support.`,
    account_no_session: `${TOOL_NAME} is temporarily unavailable. Please contact support.`,
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
function injectOverlay(html, capture) {
  const cfg = JSON.stringify({ api: API_BASE, capture: !!capture, toolName: TOOL_NAME, tool: TOOL_KEY });
  const tags =
    `<link rel="stylesheet" href="/__genz/overlay.css">` +
    `<script>window.__GENZ_GATEWAY__=${cfg};</script>` +
    `<script src="/__genz/overlay.js" defer></script>`;
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

// ── Reverse proxy ──────────────────────────────────────────────────────────────
function proxy(req, res, isHtmlNav, session, ctx) {
  ctx = ctx || {};
  const chunks = [];
  req.on('data', c => chunks.push(c));
  req.on('end', () => {
    const bodyBuf = Buffer.concat(chunks);
    const headers = { ...req.headers };
    headers.host = targetUrl.host;
    // Rewrite Origin/Referer to the upstream origin so the tool's CSRF/same-origin
    // checks accept mutating POSTs (Humanize / Check for AI) made from the gateway host.
    if (headers.origin) headers.origin = targetUrl.origin;
    if (headers.referer) {
      try { const rf = new URL(headers.referer); rf.protocol = targetUrl.protocol; rf.host = targetUrl.host; headers.referer = rf.toString(); }
      catch (_) { headers.referer = targetUrl.origin + '/'; }
    }
    delete headers['accept-encoding'];
    headers['accept-encoding'] = 'identity';
    delete headers.cookie; // never forward our lease cookie upstream
    if (session && session.cookieHeader) {
      headers.cookie = session.cookieHeader; // inject the vault account's cookies (server-side only)
    } else if (session && session.noAccount) {
      const passthru = stripLeaseCookie(req.headers.cookie);
      if (passthru) headers.cookie = passthru;
    }

    const upstream = httpLib.request(`${TARGET_ORIGIN}${req.url}`, { method: req.method, headers }, (uRes) => {
      const ct = String(uRes.headers['content-type'] || '');
      const isHtml = ct.includes('text/html');
      const rawLoc = String(uRes.headers['location'] || '');
      const redirectedToSignIn = uRes.statusCode >= 300 && uRes.statusCode < 400 && /\/(sign-?in|log-?in|auth\/login)\b/i.test(rawLoc);
      const upstreamForbidden = uRes.statusCode === 401 || uRes.statusCode === 403;
      const errorSource = (redirectedToSignIn || upstreamForbidden) ? 'upstream' : null;

      if (isHtmlNav) {
        safeLog('proxy', {
          request_path: String(req.url || '').split('?')[0],
          lease_id: ctx.jti || null,
          account_id: (session && session.accountId) || null,
          has_session_cookie: !!(session && (session.hasSessionCookie || (session.cookieCount || 0) > 0)),
          cookies_count_attached: (session && session.cookieCount) || 0,
          response_status: uRes.statusCode,
          error_source: errorSource,
          redirected_to_sign_in: redirectedToSignIn,
        });
        // On a real /sign-in redirect, flag the bound account session_expired so it
        // is skipped for NEW leases. Not on a generic 401/403 (could be a WAF block).
        if (redirectedToSignIn && !ctx.capture && session && session.accountId && ctx.token) {
          gatewayApiPost('/account-expired', ctx.token, {}).then(() => {}).catch(() => {});
        }
      }

      // Never pass a raw upstream "Forbidden"/login document to the client.
      if ((isHtmlNav || isHtml) && upstreamForbidden && !ctx.capture) {
        safeLog('forbidden_blocked', { request_path: String(req.url || '').split('?')[0], lease_id: ctx.jti || null, response_status: uRes.statusCode, reason: 'upstream_forbidden' });
        uRes.resume();
        return sendBlockPage(res, 'unavailable');
      }

      const outHeaders = {};
      for (const [k, v] of Object.entries(uRes.headers)) {
        if (STRIP_RESP_HEADERS.has(k.toLowerCase())) continue;
        if (k.toLowerCase() === 'set-cookie') { outHeaders[k] = rewriteSetCookie(v); continue; }
        if (k.toLowerCase() === 'location' && PUBLIC_ORIGIN && typeof v === 'string') { outHeaders[k] = v.replace(TARGET_ORIGIN, PUBLIC_ORIGIN); continue; }
        outHeaders[k] = v;
      }

      // Identity JSON sanitization: only buffer identity/account routes, never an
      // event-stream — so humanizer/detector responses (which may stream) pass through.
      const sanitizeJson = ctx.sanitizeBody && ct.includes('application/json') && !ct.includes('event-stream') && !ctx.capture;

      if (isHtml) {
        const buf = [];
        uRes.on('data', c => buf.push(c));
        uRes.on('end', () => {
          let html = Buffer.concat(buf).toString('utf8');
          if (!ctx.capture) html = redactHtmlIdentity(html);
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

  if (pathName === '/__genz/overlay.js') {
    res.writeHead(200, { 'content-type': 'application/javascript; charset=utf-8', 'cache-control': 'no-cache' });
    return res.end(OVERLAY_JS);
  }
  if (pathName === '/__genz/overlay.css') {
    res.writeHead(200, { 'content-type': 'text/css; charset=utf-8', 'cache-control': 'no-cache' });
    return res.end(OVERLAY_CSS);
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

  // ── Server-side account/billing/logout shield (client leases only) ─────────
  if (!capture) {
    if (LOGOUT_RE.test(pathName)) {
      safeLog('route_blocked', { request_path: pathName, kind: 'logout', is_nav: isHtmlNav });
      if (isHtmlNav) { res.writeHead(302, { location: DEFAULT_PATH, 'cache-control': 'no-store' }); return res.end(); }
      res.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store' });
      return res.end('{}');
    }
    if (isHtmlNav && BLOCK_NAV_RE.test(pathName)) {
      safeLog('route_blocked', { request_path: pathName, kind: 'nav' });
      res.writeHead(302, { location: DEFAULT_PATH, 'cache-control': 'no-store' });
      return res.end();
    }
    if (!isHtmlNav && STUB_API_RE.test(pathName)) {
      safeLog('route_blocked', { request_path: pathName, kind: 'api_stub' });
      res.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store' });
      return res.end('{}');
    }
  }
  const sanitizeBody = !capture && IDENTITY_ROUTE_RE.test(pathName);

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
