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
const zlib = require('zlib');

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

// ── One-time POST launch bootstrap ───────────────────────────────────────────
// /launch takes a single-use code in a POST BODY, redeems it server-to-server, installs an
// OPAQUE HttpOnly session cookie and 303s to the clean tool URL. Replaces the old
// /gateway?lease=<JWT> entry point, which put a bearer credential in the address bar, in
// history, in the Referer of the first upstream request and in every access log on the way —
// and then stored that same JWT in a NON-HttpOnly `sw_lease` cookie that page script and any
// cookie-editor extension could read straight back out.
//
// ALLOW_URL_LEASE keeps /gateway alive so a backend rollback (LAUNCH_FLOW=url /
// STEALTH_LAUNCH_FLOW=url) works without redeploying this gateway. Set
// `SetEnv ALLOW_URL_LEASE 0` once the POST flow is verified. Default ON.
const ALLOW_URL_LEASE = String(process.env.ALLOW_URL_LEASE || '1') !== '0';
// A launch body carries one ~43-char code and nothing else.
const LAUNCH_BODY_LIMIT = 4096;
// __Host- REQUIRES Secure + Path=/ + NO Domain, so the cookie is host-only and cannot be set
// or overwritten by any other host under genzdigitalstore.com.
const SESSION_COOKIE = '__Host-stealth_session';

// Optional: extra CSS selectors (comma-separated) for StealthWriter's exact top-bar
// and bottom account-area containers. These are added to the critical hide CSS that
// is injected into <head> BEFORE first paint, so they never flash. Use this to hide
// StealthWriter's structural chrome (e.g. ".sidebar-account, header.topbar") that the
// generic href/attribute rules can't target by class alone. Editor/working area must
// NOT be matched here.
const EXTRA_HIDE_SELECTORS = String(process.env.STEALTH_HIDE_SELECTORS || '')
  .split(',').map(s => s.trim()).filter(Boolean);


// ════════════════════════════════════════════════════════════════════════════
// USAGE METERING — the gateway, not the browser, decides whether to charge
// ════════════════════════════════════════════════════════════════════════════
// The old flow charged on the CLICK: the overlay called /__genz/consume and only then
// dispatched the humanize request. A StealthWriter "service is temporarily unavailable
// due to high demand" therefore still cost the member a Humanizer credit.
//
// Now the overlay RESERVES capacity before dispatching, tags that one request with an
// opaque operation id, and THIS server decides the outcome from the real upstream
// response — committing the credit only when a result was genuinely produced, and
// cancelling otherwise. The browser cannot declare success: /__genz/usage/commit is
// refused outright (see the handler), and the backend commit endpoint additionally
// requires the gateway key, which no browser holds.
//
// Internal metering headers are STRIPPED from every request before it is forwarded, so
// nothing of ours ever reaches StealthWriter.
const USAGE_OP_HEADER = 'x-genz-op';
const USAGE_ACTION_HEADER = 'x-genz-action';
const USAGE_ACTIONS = new Set(['humanizer', 'detector']);

// How much of the response we look at to classify it. The body still streams to the
// browser untouched and undelayed — this is a bounded observer, not a buffer.
const CLASSIFY_MAX_BYTES = 64 * 1024;

// Safety net: if nothing has settled an operation by then (socket wedged, tab killed
// mid-flight, upstream never answers), cancel it. The backend reservation would expire
// on its own anyway; this just releases it promptly. Always below the backend TTL.
const OP_SAFETY_TIMEOUT_MS = (() => {
  const n = parseInt(process.env.STEALTH_OP_SAFETY_TIMEOUT_MS, 10);
  return Number.isFinite(n) && n >= 5000 && n <= 600000 ? n : 120000;
})();

// ── Success classification ───────────────────────────────────────────────────
// Default-deny: a credit is charged ONLY when the response positively proves a result
// was produced. Anything else — an error status, an error payload, an empty or
// malformed body, an unrecognised shape — is a no-charge outcome, because falsely
// charging a member is the failure this whole change exists to stop.
//
// AUDITED EVIDENCE (public StealthWriter bundle, landing scanner):
//   • failures are signalled as a NON-2xx status with a plain `{"error": "..."}` body
//     (`if (!res.ok) toast.error(json.error ?? "Scan failed.")`);
//   • successful payloads are returned as an OBFUSCATED ENVELOPE `{"d":"<base64>",
//     "s":"<salt>"}` and decoded client-side.
// So a non-empty `d` + `s` envelope on a 2xx IS proof that a payload was produced, and
// it is proof we can read WITHOUT ever decoding the member's text. That is the primary
// success signal; the plain result-key list below is the fallback for any endpoint that
// answers unencoded.
const SUCCESS_JSON_KEYS = (() => {
  const base = [
    'result', 'results', 'output', 'humanized', 'humanizedtext', 'humanized_text',
    'rewritten', 'rewrite', 'paraphrase', 'paraphrased', 'text', 'content',
    'score', 'aiscore', 'ai_score', 'humanscore', 'human_score', 'probability',
    'sentences', 'detection', 'prediction',
  ];
  const extra = String(process.env.STEALTH_SUCCESS_JSON_KEYS || '')
    .split(',').map(s => s.trim().toLowerCase()).filter(Boolean);
  return new Set(base.concat(extra));
})();

// Explicit upstream error markers inside a 2xx body.
const ERROR_JSON_KEYS = new Set(['error', 'errors', 'error_message', 'errormessage', 'detail']);

// Server Actions / RSC flight responses (`text/x-component`) serialize a FAILED action
// as a perfectly normal 200 too, so "bytes arrived" is not proof of a result there. Left
// classified as ambiguous (no charge) until a live audit of the authenticated Humanizer
// endpoint says otherwise; flip with STEALTH_RSC_SUCCESS=1 only once that audit exists.
const RSC_COUNTS_AS_SUCCESS = String(process.env.STEALTH_RSC_SUCCESS || '0') === '1';

// Optional post-audit backstop: once the exact Humanizer/Detector request paths are
// confirmed, set STEALTH_METERED_PATHS to a regex and a mutating request that matches it
// WITHOUT a valid reservation is refused instead of being proxied for free. Unset by
// default, so behaviour is unchanged until the audit lands.
const METERED_PATHS_RE = (() => {
  const raw = String(process.env.STEALTH_METERED_PATHS || '').trim();
  if (!raw) return null;
  try { return new RegExp(raw, 'i'); } catch (_) { return null; }
})();

/** Cheap, allocation-light scan of the first bytes of a JSON body. */
function classifyJsonHead(text) {
  let parsed = null;
  try { parsed = JSON.parse(text); } catch (_) { parsed = null; }

  if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
    for (const k of Object.keys(parsed)) {
      const lk = k.toLowerCase();
      const v = parsed[k];
      if (ERROR_JSON_KEYS.has(lk) && v !== null && v !== false && v !== '') {
        return { outcome: 'failure', code: 'upstream_error_payload' };
      }
    }
    if (parsed.success === false || parsed.ok === false) {
      return { outcome: 'failure', code: 'upstream_error_payload' };
    }
    // The audited obfuscated envelope: a real payload was produced. Never decoded.
    if (typeof parsed.d === 'string' && parsed.d.length > 0 && typeof parsed.s === 'string' && parsed.s.length > 0) {
      return { outcome: 'success', code: 'result_envelope' };
    }
    for (const k of Object.keys(parsed)) {
      if (!SUCCESS_JSON_KEYS.has(k.toLowerCase())) continue;
      const v = parsed[k];
      const nonEmpty = (typeof v === 'string' && v.trim().length > 0)
        || (typeof v === 'number' && Number.isFinite(v))
        || (Array.isArray(v) && v.length > 0)
        || (v && typeof v === 'object' && Object.keys(v).length > 0);
      if (nonEmpty) return { outcome: 'success', code: 'result_field' };
    }
    return { outcome: 'ambiguous', code: 'json_no_result_field' };
  }

  // A body we could not parse — either genuinely malformed, or simply longer than the
  // window we observed. Either way it is not proof of a result.
  if (/"\s*d\s*"\s*:\s*"[^"]/.test(text) && /"\s*s\s*"\s*:\s*"[^"]/.test(text)) {
    return { outcome: 'success', code: 'result_envelope_partial' };
  }
  if (/"\s*(error|errors|detail)\s*"\s*:/.test(text)) {
    return { outcome: 'failure', code: 'upstream_error_payload' };
  }
  return { outcome: 'ambiguous', code: 'json_unparsed' };
}

/**
 * Decide the outcome of one metered upstream exchange.
 * `ev` = { status, contentType, bytes, head, transport, aborted }
 * Returns { outcome: 'success'|'failure'|'ambiguous', code }.
 */
function classifyUpstreamOutcome(ev) {
  if (ev.aborted) return { outcome: 'failure', code: 'client_aborted' };
  if (ev.transport) return { outcome: 'failure', code: ev.transport };          // network / DNS / TLS / timeout
  const status = Number(ev.status) || 0;
  if (status < 200 || status >= 300) return { outcome: 'failure', code: 'upstream_status' };
  if (!ev.bytes) return { outcome: 'failure', code: 'empty_response' };

  const ct = String(ev.contentType || '').toLowerCase();
  const head = String(ev.head || '');

  if (ct.includes('application/json') || ct.includes('+json')) return classifyJsonHead(head);

  if (ct.includes('text/event-stream')) {
    // A stream that carried data and ended cleanly, with no error frame in the window.
    if (/\bevent:\s*error\b/i.test(head) || /"\s*error\s*"\s*:/.test(head)) {
      return { outcome: 'failure', code: 'upstream_error_payload' };
    }
    return ev.completed ? { outcome: 'success', code: 'stream_completed' }
      : { outcome: 'failure', code: 'stream_incomplete' };
  }

  if (ct.includes('text/x-component')) {
    if (/"\s*(error|digest)\s*"\s*:/.test(head)) return { outcome: 'failure', code: 'upstream_error_payload' };
    return RSC_COUNTS_AS_SUCCESS && ev.completed
      ? { outcome: 'success', code: 'rsc_completed' }
      : { outcome: 'ambiguous', code: 'rsc_unaudited' };
  }

  // Anything else (text/plain, octet-stream, …) is not positive proof on its own.
  return { outcome: 'ambiguous', code: 'unclassified_content_type' };
}

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

// ── Opaque session store — durable across Passenger workers + process recycles ──
// The browser must never hold the lease JWT. Instead it gets a random, opaque, HttpOnly,
// host-only `__Host-stealth_session` id that maps to THIS server-side record, which holds
// the JWT for server→backend calls only. The opaque id reveals no user, account, client,
// lease or expiry, and it is useless to anyone who cannot reach this store.
//
// WHY IT IS ON DISK, NOT JUST IN A MAP (learned the hard way on the Claude gateway): Passenger
// runs several Node workers and recycles idle ones, so a per-process Map means the next request
// can land on a worker that never saw the sid → "no session" → block page mid-session. The Map
// stays the hot path; a miss rehydrates from an AES-256-GCM-encrypted file under this app's own
// tmp/, which every worker on the box can read. The key is derived from the lease secret each
// worker already has, so the blob on disk is worthless on its own, and a tampered or
// wrong-key blob simply fails authentication and reads as "no session".
const stealthSessions = new Map(); // sid -> { jwt, jti, exp(ms), cap, createdAt, lastSeen, rotatedAt }
const SESSION_DIR = path.join(__dirname, 'tmp', 'sessions');
try { fs.mkdirSync(SESSION_DIR, { recursive: true }); } catch (_) {}
const SESSION_STORE_WRITABLE = (function () {
  try {
    const probe = path.join(SESSION_DIR, '.wtest-' + process.pid);
    fs.writeFileSync(probe, '1'); fs.unlinkSync(probe);
    return true;
  } catch (_) { return false; }
})();
const SESSION_ENC_KEY = crypto.createHash('sha256')
  .update('stealth-opaque-session:v1|' + (process.env.STEALTH_LEASE_SECRET || process.env.JWT_SECRET || ''))
  .digest();
function sessFile(sid) { return path.join(SESSION_DIR, crypto.createHash('sha256').update(String(sid)).digest('hex') + '.bin'); }
function sessEncrypt(obj) {
  const iv = crypto.randomBytes(12);
  const c = crypto.createCipheriv('aes-256-gcm', SESSION_ENC_KEY, iv);
  const ct = Buffer.concat([c.update(Buffer.from(JSON.stringify(obj), 'utf8')), c.final()]);
  return Buffer.concat([iv, c.getAuthTag(), ct]);
}
function sessDecrypt(buf) {
  try {
    const d = crypto.createDecipheriv('aes-256-gcm', SESSION_ENC_KEY, buf.subarray(0, 12));
    d.setAuthTag(buf.subarray(12, 28));
    return JSON.parse(Buffer.concat([d.update(buf.subarray(28)), d.final()]).toString('utf8'));
  } catch (_) { return null; }
}
function sessPersist(sid, rec) {
  try {
    const tmp = sessFile(sid) + '.' + process.pid + '.tmp';
    fs.writeFileSync(tmp, sessEncrypt({ jwt: rec.jwt, jti: rec.jti, exp: rec.exp, cap: rec.cap, createdAt: rec.createdAt, rotatedAt: rec.rotatedAt }));
    fs.renameSync(tmp, sessFile(sid)); // atomic publish
  } catch (_) {}
}
function sessLoad(sid) {
  try {
    const o = sessDecrypt(fs.readFileSync(sessFile(sid)));
    if (!o) return null;
    if (Date.now() > o.exp) { try { fs.unlinkSync(sessFile(sid)); } catch (_) {} return null; }
    return o;
  } catch (_) { return null; }
}
function sessRemove(sid) { try { fs.unlinkSync(sessFile(sid)); } catch (_) {} }

function newSid() { return crypto.randomBytes(32).toString('base64url'); }
function createSession(jwt, payload) {
  const sid = newSid(); // fresh id per launch → session fixation is not possible
  const exp = payload && payload.exp ? payload.exp * 1000 : Date.now() + 30 * 60 * 1000;
  const rec = { jwt, jti: (payload && payload.jti) || null, exp, cap: !!(payload && payload.cap), createdAt: Date.now(), lastSeen: Date.now(), rotatedAt: Date.now() };
  stealthSessions.set(sid, rec);
  sessPersist(sid, rec);
  return sid;
}
// NOTE the name: `getSession(token, jti)` further down is the ACCOUNT VAULT fetch and is a
// completely different thing. Both are function declarations, so reusing the name would have
// silently overwritten one with the other at parse time — with no syntax error and no test
// failure until the vault stopped loading in production.
function getOpaqueSession(req) {
  const sid = parseCookies(req.headers.cookie)[SESSION_COOKIE];
  if (!sid) return null;
  let s = stealthSessions.get(sid);
  if (!s) {
    const o = sessLoad(sid);
    if (!o) return null;
    s = { jwt: o.jwt, jti: o.jti, exp: o.exp, cap: o.cap, createdAt: o.createdAt || Date.now(), lastSeen: Date.now(), rotatedAt: o.rotatedAt || Date.now() };
    stealthSessions.set(sid, s);
  }
  if (Date.now() > s.exp) { stealthSessions.delete(sid); sessRemove(sid); return null; }
  s.lastSeen = Date.now();
  return Object.assign({ sid }, s);
}
function revokeSession(sid) { if (sid) { stealthSessions.delete(sid); sessRemove(sid); } }
function sessionCookie(sid, maxAgeSec) {
  return `${SESSION_COOKIE}=${sid}; Path=/; Secure; HttpOnly; SameSite=Lax; Max-Age=${Math.max(30, maxAgeSec)}`;
}
function expireSessionCookie() { return `${SESSION_COOKIE}=; Path=/; Secure; HttpOnly; SameSite=Lax; Max-Age=0`; }
setInterval(() => {
  const now = Date.now();
  for (const [sid, s] of stealthSessions) if (now > s.exp) stealthSessions.delete(sid);
  try {
    for (const f of fs.readdirSync(SESSION_DIR)) {
      if (!f.endsWith('.bin')) continue;
      const fp = path.join(SESSION_DIR, f);
      try { const o = sessDecrypt(fs.readFileSync(fp)); if (!o || now > o.exp) fs.unlinkSync(fp); } catch (_) {}
    }
  } catch (_) {}
}, 60000).unref();

// LEASE RESOLUTION (see the request handler): the opaque session wins; the legacy readable
// `sw_lease` cookie is still accepted so a session already in flight when this build deploys
// is not cut off mid-use. Nothing mints sw_lease any more — even the legacy /gateway entry
// point now exchanges the URL lease for an opaque session — so that fallback drains away on
// its own as live leases expire.

// ── Launch helpers ───────────────────────────────────────────────────────────
// No lease exists yet at redemption time, so this call is authenticated solely by the shared
// gateway key. The backend redeems atomically, re-checks lease/plan/revocation, and returns a
// freshly signed lease — which stays in this process.
function redeemLaunchCode(code) { return gatewayApiPost('/redeem-launch', null, { code }); }

// Bounded body reader for /launch only. Accepts the dashboard's form encoding and JSON.
function readLaunchBody(req) {
  return new Promise((resolve) => {
    const ct = String(req.headers['content-type'] || '').toLowerCase();
    let size = 0; const chunks = []; let done = false;
    const finish = (v) => { if (!done) { done = true; resolve(v); } };
    req.on('data', (c) => {
      size += c.length;
      if (size > LAUNCH_BODY_LIMIT) { try { req.destroy(); } catch (_) {} return finish(null); }
      chunks.push(c);
    });
    req.on('error', () => finish(null));
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8');
      try {
        if (ct.includes('application/json')) return finish(JSON.parse(raw || '{}'));
        const out = {};
        for (const [k, v] of new URLSearchParams(raw)) out[k] = v;
        return finish(out);
      } catch (_) { return finish(null); }
    });
  });
}

// Strip OUR OWN cookies (the legacy sw_lease and the opaque __Host-stealth_session) from a raw
// Cookie header, preserving every other cookie's value byte-for-byte (no decode/encode) —
// important for tokens like __Secure-better-auth.session_token that contain %2B / %2F / %3D
// / dots.
//
// Both callers make this security-critical, not cosmetic: one builds the Cookie header sent
// UPSTREAM in capture mode, the other collects the cookies that get saved into the account
// vault. Leaving the opaque session id in either would leak a Gen Z session id to
// stealthwriter.ai, or bake it into a stored vault bundle that is later replayed for every
// client on that account.
const OWN_COOKIES = new Set([LEASE_COOKIE, SESSION_COOKIE]);
function stripLeaseCookie(rawCookieHeader) {
  return String(rawCookieHeader || '').split(';').map(s => s.trim()).filter(Boolean)
    .filter(p => { const i = p.indexOf('='); const name = (i < 0 ? p : p.slice(0, i)).trim(); return !OWN_COOKIES.has(name); })
    .join('; ');
}

// ── Authoritative backend validation (HTML loads) ───────────────────────────
function backendValidate(token) { return backendPostJson('/validate', token, {}); }

/**
 * Lease-authenticated POST to the backend gateway API (NO gateway key — /validate and
 * /consume are authorized by the lease itself). Used by the HTML-nav validation and by the
 * same-origin overlay endpoints, which relay the response verbatim so StealthWriter's
 * metering, limits and reset labels behave exactly as they did when the overlay called the
 * backend directly.
 */
function backendPostJson(subpath, token, jsonBody) {
  return new Promise((resolve) => {
    try {
      const u = new URL(`${API_BASE}${subpath}`);
      const lib = u.protocol === 'https:' ? https : http;
      const body = Buffer.from(JSON.stringify(jsonBody || {}));
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
        // /redeem-launch runs BEFORE any lease exists, so it passes token=null and is
        // authenticated by the gateway key alone. Every other caller still sends its bearer.
        headers: Object.assign(
          { 'content-type': 'application/json', 'content-length': body.length, 'x-gateway-key': GATEWAY_KEY },
          token ? { 'authorization': `Bearer ${token}` } : {},
        ),
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

// ── Settling an operation (commit / cancel), with bounded retry ───────────────
// The upstream leg has already happened by the time we get here, so a backend blip must
// not turn a genuine result into a lost charge — nor a failure into a charge. Retries
// reuse the SAME operation id, and the backend is idempotent per operation id, so a
// retry can never double-charge. Bounded: five attempts over ~16s, then a loud sanitized
// warning and we stop. An operation we never manage to commit simply expires at the
// backend and costs the member nothing — the direction this whole change prefers.
const COMMIT_RETRY_DELAYS_MS = [0, 500, 1500, 4000, 10000];
const MAX_PENDING_SETTLES = 500; // hard ceiling so a backend outage cannot grow the heap
let pendingSettles = 0;

function settleOperation(op, outcome, code, upstreamStatus, extra) {
  if (!op || op.settled) return;
  op.settled = true;
  if (op.safetyTimer) { clearTimeout(op.safetyTimer); op.safetyTimer = null; }

  const commit = outcome === 'success';
  const sub = commit ? '/usage/commit' : '/usage/cancel';
  const payload = {
    action: op.action,
    operationId: op.operationId,
    outcomeCode: code || (commit ? 'result_verified' : 'upstream_failed'),
    upstreamStatus: (upstreamStatus === undefined || upstreamStatus === null) ? null : upstreamStatus,
  };

  // Safe outcome log — status, content type, sizes and SHAPE only. Never a byte of the
  // submitted text or the generated result, and never a cookie, token or header value.
  safeLog(commit ? 'usage_commit' : 'usage_cancel', Object.assign({
    lease_id: op.leaseId || null,
    action_type: op.action,
    outcome,
    outcome_code: payload.outcomeCode,
    upstream_status: payload.upstreamStatus,
  }, extra || {}));

  if (pendingSettles >= MAX_PENDING_SETTLES) {
    safeLog('usage_settle_dropped', { lease_id: op.leaseId || null, action_type: op.action, reason: 'pending_ceiling', warning: true });
    return;
  }
  pendingSettles++;

  let attempt = 0;
  const run = () => {
    gatewayApiPost(sub, op.token, payload).then((r) => {
      // 2xx/4xx is a definitive answer; 0 (transport) and 5xx are worth retrying.
      const definitive = r.status >= 200 && r.status < 500;
      if (definitive) {
        pendingSettles--;
        if (commit && !(r.body && r.body.committed)) {
          safeLog('usage_commit_refused', {
            lease_id: op.leaseId || null, action_type: op.action,
            code: (r.body && r.body.code) || null, response_status: r.status, warning: true,
          });
        }
        return;
      }
      attempt++;
      if (attempt >= COMMIT_RETRY_DELAYS_MS.length) {
        pendingSettles--;
        // Operational warning, not a charge: the reservation expires by itself.
        safeLog('usage_settle_unconfirmed', {
          lease_id: op.leaseId || null, action_type: op.action, intent: commit ? 'commit' : 'cancel',
          attempts: attempt, response_status: r.status, warning: true,
        });
        return;
      }
      const base = COMMIT_RETRY_DELAYS_MS[attempt];
      const t = setTimeout(run, Math.round(base * (0.8 + Math.random() * 0.4)));
      if (t.unref) t.unref();
    }).catch(() => { pendingSettles--; });
  };
  run();
}

/** Sanitized shape evidence for an outcome we could not classify — key NAMES only. */
function shapeEvidence(head) {
  try {
    const parsed = JSON.parse(head);
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      return Object.keys(parsed).filter(k => /^[A-Za-z0-9_]{1,32}$/.test(k)).slice(0, 12);
    }
  } catch (_) {}
  return null;
}

/** Bind an operation to one in-flight request, with a safety timer that releases it. */
function bindUsageOperation(req, token, leaseId) {
  const rawOp = String(req.headers[USAGE_OP_HEADER] || '').trim().toLowerCase();
  const rawAction = String(req.headers[USAGE_ACTION_HEADER] || '').trim().toLowerCase();
  if (!/^[0-9a-f]{32}$/.test(rawOp) || !USAGE_ACTIONS.has(rawAction)) return null;
  const op = { operationId: rawOp, action: rawAction, token, leaseId: leaseId || null, settled: false, safetyTimer: null };
  op.safetyTimer = setTimeout(() => settleOperation(op, 'failure', 'no_outcome_observed', null), OP_SAFETY_TIMEOUT_MS);
  if (op.safetyTimer.unref) op.safetyTimer.unref();
  return op;
}

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
  // no-referrer: this page is reachable from a launch attempt and must never pass this
  // origin (or anything on its URL) onward in a Referer header.
  res.writeHead(403, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store', 'referrer-policy': 'no-referrer' });
  res.end(html);
}

// ── Friendly "managed section" notice for blocked account/billing/settings pages ──
// Shown when a member navigates to an account/billing/subscription/settings page that
// the shield blocks — a clear message + one click back into the editor, instead of a
// silent bounce. Never exposes account data.
function sendAccountNotice(res, retryPath) {
  if (res.headersSent) { try { res.end(); } catch (_) {} return; }
  const back = retryPath || DEFAULT_PATH;
  const html = `<!doctype html><html><head><meta charset="utf-8"><title>StealthWriter</title>
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
section isn't available here. Your StealthWriter editor is ready to use.</p>
<div class="row"><a class="primary" href="${back}">Back to editor</a>
<a class="ghost" href="https://app.genzdigitalstore.com/client/dashboard">My dashboard</a></div></div></body></html>`;
  res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
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
function injectOverlay(html, capture, accountLabel) {
  // accountLabel is the operator's SAFE account label (e.g. "Account 1") from the
  // backend /session response — never an email/cookie/token. Shown in the widget.
  // sameOrigin tells the overlay to call THIS gateway's /__genz/validate + /__genz/consume
  // with the HttpOnly session cookie instead of the backend directly with a Bearer lease it
  // would have to read out of a JS-readable cookie. `api` is still published so an older
  // cached overlay keeps working during a rollout.
  const cfg = JSON.stringify({ api: API_BASE, capture: !!capture, accountLabel: accountLabel || null, sameOrigin: true });
  // Capture (admin) mode must NOT hide account UI — the operator needs to log in and
  // reach account pages to capture a session — so the critical hide CSS is omitted.
  const critical = capture ? '' : `<style id="genz-critical-hide">${buildCriticalCss()}</style>`;
  const tags =
    critical +
    `<link rel="stylesheet" href="/__genz/overlay.css?v=${OVERLAY_CSS_HASH}">` +
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
  // Set only when the overlay reserved a Humanizer/Detector credit for THIS request.
  const usageOp = ctx.usageOp || null;
  if (usageOp) {
    // The browser going away mid-request is a no-charge outcome: nothing was delivered.
    res.on('close', () => { if (!res.writableFinished) settleOperation(usageOp, 'failure', 'client_aborted', null); });
    req.on('aborted', () => settleOperation(usageOp, 'failure', 'client_aborted', null));
  }
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
    // Internal metering headers are OURS and must never leave this process. Stripped
    // unconditionally — including on requests we did not bind an operation to — so a page
    // script cannot smuggle anything to StealthWriter under an X-Genz-* name.
    for (const hk of Object.keys(headers)) { if (hk.toLowerCase().startsWith('x-genz-')) delete headers[hk]; }
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

    const upstream = httpLib.request(`${TARGET_ORIGIN}${req.url}`, { method: req.method, headers, agent: agentFor(TARGET_ORIGIN) }, (uRes) => {
      const ct = String(uRes.headers['content-type'] || '');

      // ── Metered request: observe the real response and decide the charge here. ──
      // A bounded tee — the body is NOT buffered, delayed or altered; we only look at the
      // first CLASSIFY_MAX_BYTES to tell a produced result from an error, and we never
      // decode or log a byte of it.
      if (usageOp) {
        let bytes = 0, head = '';
        uRes.on('data', (c) => {
          bytes += c.length;
          if (head.length < CLASSIFY_MAX_BYTES) head += c.toString('utf8', 0, Math.min(c.length, CLASSIFY_MAX_BYTES - head.length));
        });
        uRes.on('aborted', () => settleOperation(usageOp, 'failure', 'upstream_aborted', uRes.statusCode || null));
        uRes.on('error', () => settleOperation(usageOp, 'failure', 'upstream_stream_error', uRes.statusCode || null));
        uRes.on('end', () => {
          const ev = { status: uRes.statusCode, contentType: ct, bytes, head, completed: true };
          const verdict = classifyUpstreamOutcome(ev);
          const evidence = { content_type: ct.split(';')[0] || null, bytes };
          if (verdict.outcome === 'ambiguous') {
            // NO CHARGE + a safe audit warning carrying the response SHAPE (key names,
            // never values) so the classifier can be tightened from real evidence.
            const keys = shapeEvidence(head);
            safeLog('usage_outcome_ambiguous', {
              lease_id: usageOp.leaseId || null, action_type: usageOp.action,
              response_status: uRes.statusCode, content_type: evidence.content_type,
              bytes, json_keys: keys, code: verdict.code, warning: true,
            });
          }
          settleOperation(usageOp, verdict.outcome === 'success' ? 'success' : 'failure',
            verdict.code, uRes.statusCode || null, evidence);
        });
      }
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
          html = injectOverlay(html, ctx.capture, session && session.accountLabel);
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
    upstream.on('error', () => {
      // Network / DNS / TLS / socket failure — never a charge.
      settleOperation(usageOp, 'failure', 'upstream_transport', null);
      if (!res.headersSent) { res.writeHead(502, { 'content-type': 'text/plain' }); } res.end('Upstream error');
    });
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

  // Local overlay assets — never proxied, never gated.
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

  // ── Entry point (preferred): one-time POST launch bootstrap ─────────────────
  // The dashboard submits a hidden form here with a single-use `code` in the BODY. We redeem
  // it once, server-to-server, install the opaque HttpOnly session and 303 to the clean tool
  // URL. Nothing sensitive touches the address bar, history, Referer or an access log, and a
  // captured request body cannot be replayed because the code dies on first use.
  //
  // 303 (not 302) is deliberate: it forces the follow-up to be a GET, so the POST is never
  // replayed onto the app root or resubmittable from history.
  if (pathName === '/launch') {
    const launchHeaders = { 'cache-control': 'no-store', 'referrer-policy': 'no-referrer' };
    if (req.method !== 'POST') {
      res.writeHead(405, Object.assign({ 'content-type': 'text/plain; charset=utf-8', 'allow': 'POST' }, launchHeaders));
      return res.end('Method Not Allowed');
    }
    const body = await readLaunchBody(req);
    const code = body && typeof body.code === 'string' ? body.code.trim() : '';
    if (!code) { safeLog('launch_reject', { reason: 'code_missing' }); return sendBlockPage(res, 'lease_missing'); }

    const r = await redeemLaunchCode(code); // the code is NEVER logged
    if (!(r.status === 200 && r.body && r.body.ok && r.body.lease)) {
      const code0 = (r.body && r.body.code) || (r.status === 0 ? 'unavailable' : 'lease_invalid');
      // `failure_code`, not `code` — this is the backend's error code (launch_code_used, …).
      // Naming it `code` here would read, to anyone auditing the logs, as the launch code
      // itself. The launch code is never logged, in any field, anywhere.
      safeLog('launch_reject', { upstream_status: r.status, failure_code: code0 });
      // A spent or stale launch has the same user-facing remedy as an expired lease.
      return sendBlockPage(res, /^launch_code_/.test(String(code0)) ? 'lease_expired' : code0);
    }

    const leaseToken = r.body.lease;
    const payload = verifyLeaseLocal(leaseToken);
    if (payload === null) { safeLog('launch_reject', { reason: 'lease_unverifiable' }); return sendBlockPage(res, 'lease_invalid'); }

    const landing = payload.cap ? (process.env.STEALTH_SIGNIN_PATH || '/sign-in') : DEFAULT_PATH;
    const sid = createSession(leaseToken, payload);
    const maxAge = Math.floor(((payload.exp ? payload.exp * 1000 : Date.now() + 1800000) - Date.now()) / 1000);
    safeLog('launch_ok', { lease_id: payload.jti, cap: !!payload.cap, seconds: maxAge }); // no code, sid or JWT
    res.writeHead(303, Object.assign({
      // Opaque session only; also clear any legacy readable sw_lease this browser still holds.
      'set-cookie': [sessionCookie(sid, maxAge), `${LEASE_COOKIE}=; Path=/; Max-Age=0; SameSite=Lax`],
      'location': landing,
    }, launchHeaders));
    return res.end();
  }

  // ── Entry point (legacy, feature-flagged): lease in the URL ─────────────────
  // Retained ONLY so a backend rollback to the URL flow works without redeploying this
  // gateway. Even on this path the JWT is now exchanged for the same opaque session rather
  // than written into a readable cookie, so the browser never holds it either way.
  // Set ALLOW_URL_LEASE=0 to close this door once the POST flow is verified.
  if (pathName === '/gateway') {
    if (!ALLOW_URL_LEASE) {
      safeLog('url_lease_disabled', { request_path: pathName });
      return sendBlockPage(res, 'lease_missing');
    }
    const urlToken = u.searchParams.get('lease');
    if (!urlToken) return sendBlockPage(res, 'lease_missing');
    const payload = verifyLeaseLocal(urlToken);
    if (payload === null) return sendBlockPage(res, 'lease_invalid');
    const landing = payload.cap ? (process.env.STEALTH_SIGNIN_PATH || '/sign-in') : DEFAULT_PATH;
    const sid = createSession(urlToken, payload);
    const maxAge = Math.floor(((payload.exp ? payload.exp * 1000 : Date.now() + 1800000) - Date.now()) / 1000);
    safeLog('session_open', { lease_id: payload.jti, cap: !!payload.cap, via: 'url' });
    res.writeHead(302, {
      'set-cookie': [sessionCookie(sid, maxAge), `${LEASE_COOKIE}=; Path=/; Max-Age=0; SameSite=Lax`],
      'location': landing,
      'cache-control': 'no-store',
      'referrer-policy': 'no-referrer',
    });
    return res.end();
  }

  // The opaque session is the source of the lease; the legacy readable sw_lease cookie is
  // still accepted so a session already in flight when this build deploys is not cut off.
  const sess = getOpaqueSession(req);
  const token = sess ? sess.jwt : getLease(req);
  if (!token) return sendBlockPage(res, 'lease_missing');

  // Local signature/expiry check (fast fail).
  const local = verifyLeaseLocal(token);
  if (local === null) { if (sess) revokeSession(sess.sid); return sendBlockPage(res, 'lease_invalid'); }
  const capture = !!(local && local.cap); // admin "Refresh Cookies Through Proxy" lease

  // ── Same-origin overlay API (replaces the overlay's Bearer-authenticated calls) ──
  // The overlay used to read the lease JWT out of the non-HttpOnly sw_lease cookie and send
  // it to the backend as `Authorization: Bearer <lease>`. That is precisely what made the
  // cookie unable to be HttpOnly. Now the overlay calls THESE same-origin endpoints with
  // `credentials: 'same-origin'`; the HttpOnly cookie rides along automatically and the
  // server attaches the lease on its behalf. The backend's /validate and /consume responses
  // are relayed VERBATIM, so plan status, limits, metering and reset labels are unchanged.
  if (pathName === '/__genz/validate' || pathName === '/__genz/consume') {
    const jsonHeaders = { 'content-type': 'application/json', 'cache-control': 'no-store', 'referrer-policy': 'no-referrer' };
    if (req.method !== 'POST') { res.writeHead(405, jsonHeaders); return res.end('{"valid":false,"code":"method_not_allowed"}'); }
    const body = (await readLaunchBody(req)) || {};
    const sub = pathName === '/__genz/validate' ? '/validate' : '/consume';
    // Only the fields these endpoints actually take — never a caller-supplied lease.
    const payload = sub === '/consume' ? { action: body.action } : {};
    const r = await backendPostJson(sub, token, payload);
    if (r.status === 0) {
      // Transport failure is explicitly retryable: it must never be read as an ended session.
      res.writeHead(200, jsonHeaders);
      return res.end(JSON.stringify({ valid: false, terminal: false, retryable: true, code: 'backend_unavailable' }));
    }
    // A CONFIRMED terminal verdict also tears down the opaque session, so a later request
    // cannot ride a session the backend has already refused.
    const terminal = !!(r.body && r.body.terminal === true);
    if (terminal && sess) { revokeSession(sess.sid); jsonHeaders['set-cookie'] = expireSessionCookie(); }
    res.writeHead(r.status, jsonHeaders);
    return res.end(JSON.stringify(r.body || {}));
  }

  // ── Same-origin usage lifecycle: RESERVE before the request, CANCEL on a client-side
  // failure. There is deliberately NO browser-callable commit — see the 403 below.
  // These relay to the GATEWAY-ONLY backend endpoints, adding the gateway key the page
  // cannot hold and the lease the page cannot read.
  if (pathName === '/__genz/usage/reserve' || pathName === '/__genz/usage/cancel' || pathName === '/__genz/usage/commit') {
    const jsonHeaders = { 'content-type': 'application/json', 'cache-control': 'no-store', 'referrer-policy': 'no-referrer' };
    if (req.method !== 'POST') { res.writeHead(405, jsonHeaders); return res.end('{"ok":false,"code":"method_not_allowed"}'); }

    // A page script must never be able to turn "I think it worked" into a charge. The
    // commit decision is made from the real upstream response in settleOperation(), and
    // the backend commit endpoint additionally requires the gateway key. Answered here
    // (rather than left to fall through) so the path can never be proxied to StealthWriter.
    if (pathName === '/__genz/usage/commit') {
      safeLog('usage_commit_refused_from_browser', { lease_id: local && local.jti, response_status: 403 });
      res.writeHead(403, jsonHeaders);
      return res.end('{"ok":false,"committed":false,"code":"gateway_decides_outcome"}');
    }
    if (capture) { res.writeHead(403, jsonHeaders); return res.end('{"ok":false,"code":"not_metered"}'); }

    const body = (await readLaunchBody(req)) || {};
    const action = String(body.action || '').toLowerCase();
    const reserving = pathName === '/__genz/usage/reserve';
    const payload = reserving
      ? { action }
      : { action, operationId: String(body.operationId || ''), outcomeCode: 'client_cancelled' };
    const r = await gatewayApiPost(reserving ? '/usage/reserve' : '/usage/cancel', token, payload);

    if (r.status === 0) {
      // FAIL CLOSED. No reservation means the overlay must not dispatch the request, so
      // this is reported as an explicitly retryable connection problem — never as an
      // ended session, and never as a silent allow.
      res.writeHead(200, jsonHeaders);
      return res.end(JSON.stringify({ ok: false, allowed: false, terminal: false, retryable: true, code: 'backend_unavailable' }));
    }
    // A confirmed authorization denial also tears down the opaque session, exactly as
    // /__genz/validate does, so a later request cannot ride a session the backend refused.
    const code = String((r.body && r.body.code) || '');
    if (NAV_TERMINAL_CODES.has(code) && sess) { revokeSession(sess.sid); jsonHeaders['set-cookie'] = expireSessionCookie(); }
    res.writeHead(r.status, jsonHeaders);
    return res.end(JSON.stringify(r.body || {}));
  }

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
    // 2) Account / billing / subscription / pricing PAGE loads → friendly notice
    //    (instead of silently bouncing, so the member understands why).
    if (isHtmlNav && BLOCK_NAV_RE.test(pathName)) {
      safeLog('route_blocked', { request_path: pathName, kind: 'nav' });
      return sendAccountNotice(res, DEFAULT_PATH);
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

  // ── Bind the reserved usage operation to THIS request ──────────────────────
  // The overlay tags exactly the request it reserved for. The id is validated here and
  // the header is stripped in proxy() before anything is forwarded; the operation itself
  // is bound at the BACKEND to the client resolved from this lease, so a tagged request
  // can never touch another client's operation.
  let usageOp = null;
  if (!capture) {
    usageOp = bindUsageOperation(req, token, local && local.jti);
    // Post-audit backstop (off until STEALTH_METERED_PATHS is set): once the exact
    // Humanizer/Detector paths are confirmed, a mutating request to one of them without a
    // reservation is refused rather than served for free.
    if (!usageOp && METERED_PATHS_RE && ['POST', 'PUT', 'PATCH'].includes(String(req.method || '').toUpperCase()) && METERED_PATHS_RE.test(pathName)) {
      safeLog('usage_reservation_required', { request_path: pathName, lease_id: local && local.jti, response_status: 409 });
      res.writeHead(409, { 'content-type': 'application/json', 'cache-control': 'no-store' });
      return res.end('{"error":"usage_reservation_required"}');
    }
  }

  return proxy(req, res, isHtmlNav, session, { token, jti: local && local.jti, capture, sanitizeBody, usageOp });
});

server.listen(PORT, () => {
  console.log(`StealthWriter gateway listening on :${PORT}`);
  console.log(`  proxying  -> ${TARGET_ORIGIN}`);
  console.log(`  api base  -> ${API_BASE}`);
  console.log(`  launch    -> POST /launch${ALLOW_URL_LEASE ? ' (legacy /gateway?lease= still ACCEPTED — set ALLOW_URL_LEASE=0 to close it)' : ' (legacy URL lease CLOSED)'}`);
  // A non-writable store means the opaque session cannot survive a Passenger worker switch or
  // recycle, which shows up to users as a mid-session block page. Loud, but never fatal —
  // sessions still work within a single worker.
  if (!SESSION_STORE_WRITABLE) {
    console.warn('[stealth-gw] WARNING: tmp/sessions is not writable — opaque sessions cannot persist across Passenger workers/recycles. Fix permissions on stealth-gateway/tmp/sessions.');
  }
});
