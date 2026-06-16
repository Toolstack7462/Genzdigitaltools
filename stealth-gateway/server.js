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
    data = {
      cookieHeader,
      cookieCount: cookieHeader ? cookieHeader.split('; ').filter(Boolean).length : 0,
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
    account_blocked: 'This StealthWriter session was stopped by an administrator. Please reopen from your dashboard.',
    account_no_session: 'This StealthWriter session needs to be refreshed. Please reopen from your dashboard shortly.',
  };
  const msg = messages[code] || 'Your StealthWriter session is no longer valid.';
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

// ── Overlay injection ─────────────────────────────────────────────────────────
function injectOverlay(html, capture) {
  const cfg = JSON.stringify({ api: API_BASE, capture: !!capture });
  const tags =
    `<link rel="stylesheet" href="/__genz/overlay.css">` +
    `<script>window.__GENZ_GATEWAY__=${cfg};</script>` +
    `<script src="/__genz/overlay.js" defer></script>`;
  if (html.includes('</body>')) return html.replace('</body>', tags + '</body>');
  if (html.includes('</html>')) return html.replace('</html>', tags + '</html>');
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
    delete headers['accept-encoding']; // ask upstream for identity so we can inject
    headers['accept-encoding'] = 'identity';
    delete headers.cookie; // never forward our lease cookie upstream
    if (session && session.cookieHeader) {
      // Inject the selected vault account's session cookies (server-side only).
      headers.cookie = session.cookieHeader;
    } else if (session && session.noAccount) {
      // Legacy / no-vault: pass through the user's own non-lease cookies for the target.
      const cookies = parseCookies(req.headers.cookie);
      const passthru = Object.entries(cookies).filter(([k]) => k !== LEASE_COOKIE)
        .map(([k, v]) => `${k}=${encodeURIComponent(v)}`).join('; ');
      if (passthru) headers.cookie = passthru;
    }

    const upstream = httpLib.request(`${TARGET_ORIGIN}${req.url}`, { method: req.method, headers }, (uRes) => {
      const ct = String(uRes.headers['content-type'] || '');
      const isHtml = ct.includes('text/html');
      const rawLoc = String(uRes.headers['location'] || '');
      const redirectedToSignIn = uRes.statusCode >= 300 && uRes.statusCode < 400 && /\/(sign-?in|login|auth\/login)\b/i.test(rawLoc);

      if (isHtmlNav) {
        safeLog('proxy', {
          lease_id: ctx.jti || null,
          account_id: (session && session.accountId) || null,
          account_label: (session && session.accountLabel) || null,
          path_requested: String(req.url || '').split('?')[0],
          cookies_count_attached: (session && session.cookieCount) || 0,
          upstream_status: uRes.statusCode,
          redirected_to_sign_in: redirectedToSignIn,
        });
        // If an account-backed lease lands on /sign-in, the cookies are dead →
        // flag the account session_expired so it's skipped for NEW leases.
        if (redirectedToSignIn && !ctx.capture && session && session.accountId && ctx.token) {
          gatewayApiPost('/account-expired', ctx.token, {}).then(() => {}).catch(() => {});
        }
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

      if (isHtml) {
        const buf = [];
        uRes.on('data', c => buf.push(c));
        uRes.on('end', () => {
          let html = Buffer.concat(buf).toString('utf8');
          html = injectSessionBootstrap(html, session);
          html = injectOverlay(html, ctx.capture);
          outHeaders['content-type'] = 'text/html; charset=utf-8';
          outHeaders['cache-control'] = 'no-store';
          res.writeHead(uRes.statusCode || 200, outHeaders);
          res.end(html);
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
    const cookies = parseCookies(req.headers.cookie);
    const raw = Object.entries(cookies).filter(([k]) => k !== LEASE_COOKIE).map(([k, v]) => `${k}=${v}`).join('; ');
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

  // Capture mode: do NOT inject the stored bundle — let the admin log in fresh so
  // the gateway can capture a session valid in the proxy context.
  let session;
  if (capture) {
    session = { noAccount: true, capture: true };
  } else {
    session = await getSession(token, local && local.jti);
    if (session && session.blocked) return sendBlockPage(res, session.code || 'account_no_session');
  }

  return proxy(req, res, isHtmlNav, session, { token, jti: local && local.jti, capture });
});

server.listen(PORT, () => {
  console.log(`StealthWriter gateway listening on :${PORT}`);
  console.log(`  proxying  -> ${TARGET_ORIGIN}`);
  console.log(`  api base  -> ${API_BASE}`);
});
