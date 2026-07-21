'use strict';
/**
 * HIX AI — standalone reverse-proxy gateway (deploy on hix1.genzdigitalstore.com).
 *
 * Self-contained and SEPARATE from StealthWriter and from BypassGPT: its own target
 * origin, its own lease cookie, and the backend scopes its cookie vault by tool=hix.
 * Defaults are baked in so it runs out-of-the-box; every value can be overridden by
 * an env var. It:
 *   1. Accepts a signed 30-min lease at /gateway?lease=TOKEN, stores a host-scoped
 *      cookie, redirects to HIX's default path.
 *   2. Validates the lease on EVERY request (signature + expiry locally; backend
 *      /validate on HTML page loads).
 *   3. Reverse-proxies to https://hix.ai, attaching the selected vault account's
 *      cookies SERVER-SIDE (never to the browser), hiding account/billing/identity,
 *      and injecting a small Gen Z widget. No usage metering, no daily limits.
 *
 * Dependency-free (Node core only). Never logs cookies, tokens, headers or secrets.
 */
const http = require('http');
const https = require('https');
const { URL } = require('url');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const zlib = require('zlib');

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

function cleanPath(p, def) { p = String(p || '').trim(); if (!p) return def; return p.startsWith('/') ? p : '/' + p; }

const PORT = process.env.PORT || 3000;
const TOOL_KEY = process.env.TOOL_KEY || 'hix';
const TOOL_NAME = process.env.TOOL_NAME || 'HIX AI';
const TARGET_ORIGIN = (process.env.HIX_TARGET_ORIGIN || process.env.TARGET_ORIGIN || 'https://hix.ai').replace(/\/$/, '');
const DEFAULT_PATH = cleanPath(process.env.HIX_DEFAULT_PATH || process.env.DEFAULT_PATH, '/app/bypass-ai-detection/dashboard');
const SIGNIN_PATH = cleanPath(process.env.SIGNIN_PATH, '/login');
const PUBLIC_ORIGIN = (process.env.GATEWAY_PUBLIC_ORIGIN || process.env.HIX_GATEWAY_URL || 'https://hix1.genzdigitalstore.com').replace(/\/$/, '');
const API_BASE = (process.env.API_BASE || 'https://api.genzdigitalstore.com/api/crm/proxy/gateway').replace(/\/$/, '');
const LEASE_SECRET = process.env.LEASE_SECRET || process.env.PROXY_LEASE_SECRET || ''; // must match backend PROXY_LEASE_SECRET
const GATEWAY_KEY = process.env.GATEWAY_KEY || process.env.PROXY_GATEWAY_KEY || '';     // must match backend PROXY_GATEWAY_KEY
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
      const headers = Object.assign({ 'content-type': 'application/json', 'content-length': body.length, 'authorization': `Bearer ${token}` }, extraHeaders || {});
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
// MEMORY: entries are keyed by lease jti and the 60s TTL was only ever checked on READ, so a
// key never read again was never removed - every lease issued left its account cookie header
// plus localStorage/sessionStorage blobs resident for the life of the worker, which is why RSS
// climbed the longer a process stayed up. Sweep expired entries on a timer. .unref() so this
// never holds the process open. Behaviour is unchanged: an entry past its TTL was already
// treated as a miss and refetched.
const _sessionCacheGc = setInterval(() => {
  const now = Date.now();
  for (const [k, v] of sessionCache) if (!v || v.exp <= now) sessionCache.delete(k);
}, 60000);
if (_sessionCacheGc.unref) _sessionCacheGc.unref();
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
      cookieHeader, cookieCount, hasSessionCookie: cookieCount > 0,
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

function safeLog(event, fields) {
  try { console.log(`[proxy-gw:${TOOL_KEY}] ${event} ${JSON.stringify(fields)}`); } catch (_) {}
}

// ════════════════════════════════════════════════════════════════════════════
// SERVER-SIDE IDENTITY / ACCOUNT / BILLING SHIELD (never reaches the browser).
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
function sanitizeJsonBody(text) { try { return JSON.stringify(deepRedact(JSON.parse(text), 0)); } catch (_) { return text; } }
const EMAIL_GLOBAL_RE = /[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi;
function redactHtmlIdentity(html) { try { return html.replace(EMAIL_GLOBAL_RE, BRAND_EMAIL); } catch (_) { return html; } }

// ── Static assets (overlay) served locally under /__genz/ ────────────────────
const OVERLAY_JS = fs.readFileSync(path.join(__dirname, 'public', 'overlay.js'), 'utf8');
const OVERLAY_CSS = fs.readFileSync(path.join(__dirname, 'public', 'overlay.css'), 'utf8');

// Content hashes → immutable cache URLs that bust themselves on deploy. Short digest is
// plenty: it only has to change when the file does, and reveals nothing about contents.
const OVERLAY_JS_HASH = crypto.createHash('sha256').update(OVERLAY_JS).digest('hex').slice(0, 12);
const OVERLAY_CSS_HASH = crypto.createHash('sha256').update(OVERLAY_CSS).digest('hex').slice(0, 12);
const OVERLAY_JS_ETAG = '"' + OVERLAY_JS_HASH + '"';
const OVERLAY_CSS_ETAG = '"' + OVERLAY_CSS_HASH + '"';

// Confirmed authorization denials — the ONLY codes that block a navigation outright.
// Mirrors TERMINAL_CODES in backend/utils/proxy/validationResponse.js.
const NAV_TERMINAL_CODES = new Set([
  'lease_expired', 'lease_revoked', 'lease_invalid', 'lease_missing',
  'client_disabled', 'client_not_found', 'plan_expired',
  'account_blocked', 'account_no_session',
]);
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

const STRIP_RESP_HEADERS = new Set([
  'content-security-policy', 'content-security-policy-report-only',
  'x-frame-options', 'content-encoding', 'content-length', 'transfer-encoding',
  'strict-transport-security',
]);
function rewriteSetCookie(values) { return [].concat(values || []).map(v => v.replace(/;\s*Domain=[^;]+/ig, '')); }

function injectOverlay(html, capture) {
  const cfg = JSON.stringify({ api: API_BASE, capture: !!capture, toolName: TOOL_NAME, tool: TOOL_KEY });
  const tags =
    `<link rel="stylesheet" href="/__genz/overlay.css?v=${OVERLAY_CSS_HASH}">` +
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
    if (headers.origin) headers.origin = targetUrl.origin;
    if (headers.referer) {
      try { const rf = new URL(headers.referer); rf.protocol = targetUrl.protocol; rf.host = targetUrl.host; headers.referer = rf.toString(); }
      catch (_) { headers.referer = targetUrl.origin + '/'; }
    }
    delete headers['accept-encoding'];
    headers['accept-encoding'] = 'identity';
    delete headers.cookie;
    if (session && session.cookieHeader) {
      headers.cookie = session.cookieHeader;
    } else if (session && session.noAccount) {
      const passthru = stripLeaseCookie(req.headers.cookie);
      if (passthru) headers.cookie = passthru;
    }

    const upstream = httpLib.request(`${TARGET_ORIGIN}${req.url}`, { method: req.method, headers, agent: agentFor(TARGET_ORIGIN) }, (uRes) => {
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
        if (redirectedToSignIn && !ctx.capture && session && session.accountId && ctx.token) {
          gatewayApiPost('/account-expired', ctx.token, {}).then(() => {}).catch(() => {});
        }
      }

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
          endMaybeCompressed(req, res, uRes.statusCode || 200, outHeaders, html);
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
        pipeMaybeCompressed(req, res, uRes.statusCode || 200, outHeaders, uRes);
      }
    });
    upstream.on('error', () => { if (!res.headersSent) { res.writeHead(502, { 'content-type': 'text/plain' }); } res.end('Upstream error'); });
    upstream.end(bodyBuf);
  });
}

// ── Request handler ─────────────────────────────────────────────────────────────

// ── Upstream connection reuse ────────────────────────────────────────────────
// PERF: without an explicit agent each proxied request can pay a fresh TCP + TLS
// handshake to the upstream origin. Those origins sit behind Cloudflare, where the
// handshake dominates, and one page load fans out into dozens of asset requests.
// Pooled keep-alive sockets amortise that away; 'lifo' keeps sockets warm.
const GENZ_AGENT_OPTS = {
  keepAlive: true,
  keepAliveMsecs: 15000,
  maxSockets: parseInt(process.env.UPSTREAM_MAX_SOCKETS, 10) || 64,
  maxFreeSockets: 16,
  timeout: parseInt(process.env.UPSTREAM_TIMEOUT_MS, 10) || 30000,
  scheduling: 'lifo',
};
const upstreamAgents = {
  'https:': new https.Agent(GENZ_AGENT_OPTS),
  'http:': new http.Agent(GENZ_AGENT_OPTS),
};
function agentFor(originOrUrl) {
  try { return upstreamAgents[new URL(String(originOrUrl)).protocol] || undefined; }
  catch (_) { return undefined; }
}

// ── Response compression ─────────────────────────────────────────────────────
// PERF: the gateway asks upstream for 'accept-encoding: identity' (the overlay
// injection and URL rewriting need plaintext bodies) and strips 'content-encoding'
// from the response. Net effect: EVERY byte — HTML, JS bundles, CSS, JSON — crossed
// the gateway→browser leg UNCOMPRESSED, typically 3-5x what the origin would send.
// This re-compresses on the way out. Purely a transport change: the bytes the browser
// ends up with are identical. Disable with GATEWAY_COMPRESSION=0.
const COMPRESSION_ON = process.env.GATEWAY_COMPRESSION !== '0';
const COMPRESS_MIN_BYTES = parseInt(process.env.GATEWAY_COMPRESS_MIN_BYTES, 10) || 1024;
// Already-compressed payloads (images, video, fonts, archives) are left alone.
const COMPRESSIBLE_RE = /^(?:text\/|application\/(?:javascript|x-javascript|json|xml|manifest\+json|ld\+json|wasm)|image\/svg\+xml)/i;
// NEVER compress Server-Sent Events / streaming responses: the compressor buffers, which
// stalls token-by-token delivery (Claude chat, and any SSE the tools use). Also skip
// anything already carrying a content-encoding.
const NO_COMPRESS_RE = /^text\/event-stream/i;
function isCompressible(contentType) {
  const ct = String(contentType || '');
  if (NO_COMPRESS_RE.test(ct)) return false;
  return COMPRESSIBLE_RE.test(ct);
}
function pickEncoding(req) {
  if (!COMPRESSION_ON) return null;
  const ae = String((req.headers && req.headers['accept-encoding']) || '').toLowerCase();
  if (/\bbr\b/.test(ae)) return 'br';
  if (/\bgzip\b/.test(ae)) return 'gzip';
  return null;
}
function compressBuffer(enc, buf, cb) {
  try {
    if (enc === 'br') {
      // Quality 5 ≈ gzip CPU with better ratios; 11 is far too slow per-request.
      return zlib.brotliCompress(buf, { params: {
        [zlib.constants.BROTLI_PARAM_QUALITY]: 5,
        [zlib.constants.BROTLI_PARAM_SIZE_HINT]: buf.length,
      } }, (err, out) => cb(err ? null : out));
    }
    return zlib.gzip(buf, { level: 6 }, (err, out) => cb(err ? null : out));
  } catch (_) { return cb(null); }
}
function compressStream(enc) {
  if (enc === 'br') return zlib.createBrotliCompress({ params: { [zlib.constants.BROTLI_PARAM_QUALITY]: 5 } });
  return zlib.createGzip({ level: 6 });
}
/** Send a buffered body, compressing when worthwhile. Falls back to raw on any failure. */
function endMaybeCompressed(req, res, status, outHeaders, body) {
  const buf = Buffer.isBuffer(body) ? body : Buffer.from(String(body), 'utf8');
  const enc = pickEncoding(req);
  if (!enc || buf.length < COMPRESS_MIN_BYTES || !isCompressible(outHeaders['content-type'])) {
    res.writeHead(status, outHeaders);
    return res.end(buf);
  }
  compressBuffer(enc, buf, (out) => {
    if (!out || out.length >= buf.length) {          // never ship a bigger body
      res.writeHead(status, outHeaders);
      return res.end(buf);
    }
    outHeaders['content-encoding'] = enc;
    outHeaders['vary'] = outHeaders['vary'] ? outHeaders['vary'] + ', Accept-Encoding' : 'Accept-Encoding';
    delete outHeaders['content-length'];
    res.writeHead(status, outHeaders);
    res.end(out);
  });
}
/** Streamed pass-through with on-the-fly compression for compressible types. */
function pipeMaybeCompressed(req, res, status, outHeaders, uRes) {
  const enc = pickEncoding(req);
  if (enc && isCompressible(outHeaders['content-type'])) {
    outHeaders['content-encoding'] = enc;
    outHeaders['vary'] = outHeaders['vary'] ? outHeaders['vary'] + ', Accept-Encoding' : 'Accept-Encoding';
    delete outHeaders['content-length'];
    res.writeHead(status, outHeaders);
    const gz = compressStream(enc);
    gz.on('error', () => { try { res.end(); } catch (_) {} });
    return uRes.pipe(gz).pipe(res);
  }
  res.writeHead(status, outHeaders);
  return uRes.pipe(res);
}

const server = http.createServer(async (req, res) => {
  const u = new URL(req.url, 'http://localhost');
  const pathName = u.pathname;

  if (pathName === '/__genz/overlay.js') {
    // PERF: was 'no-cache', so the browser revalidated on EVERY navigation. Now
    // content-addressed (?v=<hash>) and immutable, so a nav costs zero requests for it
    // while a deploy busts the URL instantly.
    res.writeHead(200, {
      'content-type': 'application/javascript; charset=utf-8',
      'cache-control': u.searchParams.get('v') ? 'public, max-age=31536000, immutable' : 'no-cache',
      'etag': OVERLAY_JS_ETAG,
    });
    return res.end(OVERLAY_JS);
  }
  if (pathName === '/__genz/overlay.css') {
    if (String(req.headers['if-none-match'] || '').replace(/^W\//, '') === OVERLAY_CSS_ETAG) { res.writeHead(304); return res.end(); }
    res.writeHead(200, {
      'content-type': 'text/css; charset=utf-8',
      'cache-control': u.searchParams.get('v') ? 'public, max-age=31536000, immutable' : 'no-cache',
      'etag': OVERLAY_CSS_ETAG,
    });
    return res.end(OVERLAY_CSS);
  }

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
    // Only a CONFIRMED authorization denial blocks a navigation. A transient backend
    // failure (status 0 network/timeout, 429, 5xx, malformed body) falls back to the LOCAL
    // lease check, which still enforces the JWT signature and expiry — so an outage degrades
    // to signature+expiry enforcement instead of throwing a block page at a valid session.
    // Fails closed whenever the local check is also inconclusive.
    const vTerminal = (v.body && typeof v.body.terminal === 'boolean')
      ? v.body.terminal
      : NAV_TERMINAL_CODES.has(String((v.body && v.body.code) || ''));
    if (v.status === 200 && v.body && v.body.valid === true) {
      // authoritative pass — continue
    } else if (vTerminal) {
      return sendBlockPage(res, (v.body && v.body.code) || 'lease_expired');
    } else if (local && local.unknown) {
      return sendBlockPage(res, 'lease_invalid');
    }
  }

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
