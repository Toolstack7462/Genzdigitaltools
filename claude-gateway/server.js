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

// ── One-time POST launch bootstrap ───────────────────────────────────────────
// /launch accepts a single-use code in a POST BODY, redeems it server-to-server against the
// backend, installs the opaque session cookie and 303s to the clean tool URL. Nothing
// sensitive ever appears in a URL, in history, in a Referer or in an access log.
//
// ALLOW_URL_LEASE keeps the ORIGINAL /gateway?lease=<JWT> entry point alive so a backend
// rollback (LAUNCH_FLOW=url) works without redeploying this gateway. Ship with it on, then
// set `SetEnv ALLOW_URL_LEASE 0` once the POST flow is confirmed — that is the moment the
// lease genuinely stops being URL-reachable. Default ON for backward compatibility.
const ALLOW_URL_LEASE = String(process.env.ALLOW_URL_LEASE || '1') !== '0';
// A launch body carries one ~43-char code and nothing else. Anything larger is not ours.
const LAUNCH_BODY_LIMIT = 4096;
// ── Claude token-quota tap (claude-only) ─────────────────────────────────────
// Pure char-extraction helpers; only ever handle character COUNTS, never prompt text/secrets.
// Mode: 'off' (disabled) | 'count' (measure + report only, never blocks) | 'enforce' (block an
// over-quota message before forwarding). Default 'count' — safe: it cannot break a Claude chat.
const quotaTap = require('./lib/quotaTap');
const QUOTA_MODE = (() => { const m = String(process.env.CLAUDE_QUOTA_MODE || 'count').toLowerCase(); return ['off', 'count', 'enforce'].includes(m) ? m : 'count'; })();

// ── Claude default-effort preference (claude-only) ───────────────────────────
// The overlay auto-selects this effort on a fresh Claude session / new conversation. Admin-
// configurable via env (like the other gateway prefs): CLAUDE_DEFAULT_EFFORT ∈
// low|medium|high|extra|max (default medium), CLAUDE_THINKING_DEFAULT (off by default; 1/on to
// auto-enable extended thinking), and an OPTIONAL exact CSS selector CLAUDE_EFFORT_TRIGGER_SEL to
// pin the effort control if the heuristic can't find it on the live DOM. Never touches the model.
const effortPrefs = require('./lib/effortPrefs');
const CLAUDE_DEFAULT_EFFORT = effortPrefs.normalizeEffort(process.env.CLAUDE_DEFAULT_EFFORT, 'medium');
const CLAUDE_THINKING_DEFAULT = effortPrefs.parseThinkingDefault(process.env.CLAUDE_THINKING_DEFAULT);

// ── Model allowlist (claude-only) ────────────────────────────────────────────
// ADMIN SETTING — "Allow Fable 5: On/Off", OFF by default:
//     SetEnv CLAUDE_ALLOW_FABLE5 1     → On  (original behaviour, nothing is filtered)
//     unset / 0 / false / anything else → Off (Fable 5 blocked)
// Set in this gateway's .htaccess exactly like CLAUDE_DEFAULT_EFFORT / CLAUDE_THINKING_DEFAULT,
// so it is reversible with a one-line change and no deploy. When On, every code path below
// short-circuits and the proxy behaves byte-for-byte as it did before this feature existed.
//
// The fallback's EFFORT and THINKING are not separate settings here: CLAUDE_DEFAULT_EFFORT
// already defaults to 'medium' and CLAUDE_THINKING_DEFAULT already defaults to off, which is
// exactly the required fallback profile. They stay independently configurable.
const modelPolicy = require('./lib/modelPolicy');
const CLAUDE_ALLOW_FABLE5 = modelPolicy.parseAllowSetting(process.env.CLAUDE_ALLOW_FABLE5);
const CLAUDE_FALLBACK_MODEL = modelPolicy.normalizeFallback(process.env.CLAUDE_FALLBACK_MODEL);
const CLAUDE_EFFORT_TRIGGER_SEL = String(process.env.CLAUDE_EFFORT_TRIGGER_SEL || '').trim();
// ── Effort allowlist (claude-only) ───────────────────────────────────────────
// Only Low and Medium may be used. Enforced on the way upstream (unbypassable) and mirrored into
// the picker on the way back. CLAUDE_ALLOW_ALL_EFFORTS=1 is a reversible kill-switch that restores
// the previous behaviour exactly, with no other code path involved.
const effortPolicy = require('./lib/effortPolicy');
const CLAUDE_ALLOW_ALL_EFFORTS = effortPolicy.parseAllowSetting(process.env.CLAUDE_ALLOW_ALL_EFFORTS);
const CLAUDE_DEFAULT_MODEL = effortPolicy.normalizeDefaultModel(process.env.CLAUDE_DEFAULT_MODEL);
const LEASE_COOKIE = 'pg_lease';
// ── Two SEPARATE upstream budgets ────────────────────────────────────────────
// REGRESSION-SENSITIVE. These must never be collapsed back into one socket timer.
//   headersMs — how long the upstream may take to START responding. A page that never answers
//               must fail over to a friendly retry page rather than hang.
//   idleMs    — how long it may pause BETWEEN chunks once it HAS started, reset on every chunk.
// The old code used a single `upstream.setTimeout(30s)`, which maps onto `socket.setTimeout` and
// therefore stayed armed DURING the streamed answer. Claude legitimately goes quiet for longer
// than 30s while thinking, running a tool or writing a file, so the socket was destroyed
// mid-answer and the client got a clean EOF with no terminating SSE event — "Claude's response was
// interrupted", a spinner that never resolves, and files stuck on "Creating file".
const streamGuard = require('./lib/streamGuard');
const UPSTREAM_BUDGETS = streamGuard.resolveBudgets(process.env, 30000);
const UPSTREAM_TIMEOUT_MS = UPSTREAM_BUDGETS.headersMs;
const STREAM_IDLE_TIMEOUT_MS = UPSTREAM_BUDGETS.idleMs;
// Pinned upstream browser identity. Kept IDENTICAL for capture + client proxying so a
// Cloudflare cf_clearance cookie (bound to its minting UA) stays valid, and matched to
// the backend verifier's UA (utils/proxy/verify.js) so an account that Verifies
// "working" also opens cleanly through the gateway.
const UPSTREAM_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36';
// Client-hint headers pinned to MATCH UPSTREAM_UA (a UA that claims Chrome but ships
// mismatched/absent sec-ch-ua is a Cloudflare bot tell).
const UPSTREAM_CH_UA = '"Chromium";v="124", "Google Chrome";v="124", "Not-A.Brand";v="99"';
const UPSTREAM_CH_PLATFORM = '"Windows"';

// ── Device-consistent identity for Cloudflare's managed challenge ─────────────
// A Cloudflare challenge runs JS IN THE CLIENT'S BROWSER and reports the real navigator
// (UA / platform / mobile). Cloudflare then cross-checks that in-browser fingerprint
// against the HTTP request headers. If we pin a DESKTOP UA + sec-ch-ua-mobile:?0 for a
// phone, the two disagree and the challenge can NEVER clear on mobile → endless challenge
// / "Unable to connect". Desktop clients already match the pinned identity, so they are
// left EXACTLY as before. For a mobile client we forward its OWN honest UA + client-hints
// so the HTTP request matches what its browser's JS reports — the user then solves the
// REAL challenge and Cloudflare mints a cf_clearance bound to THAT device. We never spoof,
// auto-solve or weaken the check, and each device gets its own clearance (never shared).
// High-entropy hints (sec-ch-ua-platform, model, etc.) are only forwarded if the client
// actually sent them — a mobile UA paired with an invented desktop sec-ch-ua is itself a
// bot tell, and Safari legitimately sends no sec-ch-ua at all.
const CLIENT_CH_HEADERS = [
  'sec-ch-ua', 'sec-ch-ua-mobile', 'sec-ch-ua-platform', 'sec-ch-ua-platform-version',
  'sec-ch-ua-full-version-list', 'sec-ch-ua-full-version', 'sec-ch-ua-model',
  'sec-ch-ua-arch', 'sec-ch-ua-bitness', 'sec-ch-ua-wow64',
];
// The three low-entropy hints we PIN to the desktop identity. They are overwritten in place
// rather than purged-and-reappended, because deleting a key and re-adding it moves it to the
// END of the header list — an ordering only mobile clients would get, which is itself a
// fingerprint tell. See the non-minimal branch of buildUpstreamHeaders.
const PINNED_CH_HEADERS = new Set(['sec-ch-ua', 'sec-ch-ua-mobile', 'sec-ch-ua-platform']);
// ── Device classification — computed ONCE, at ingress, from the UNTOUCHED request ──────────
// REGRESSION-SENSITIVE. Two different things must never be conflated:
//   (a) the CLIENT's real device class — a property of the browser that made this request. It is
//       decided here, before anything rewrites a header, and then never recomputed.
//   (b) the UPSTREAM compatibility headers we choose to send to claude.ai. Those are an output.
// Deriving (a) lazily from `req.headers` at each call site invites a future header rewrite to
// silently flip the classification mid-request; `classifyDevice` + `deviceOf` make (a) immutable.
//
// A duplicated header arrives joined ("?1, ?1"), and a proxy hop may pad it, so the hint is
// matched loosely rather than by strict equality — a strict `=== '?1'` silently fell through to
// the UA test whenever anything reformatted the value. The UA token check remains the fallback
// for browsers that send no client hints at all (Safari and Firefox never do).
const DEVICE_UA_MOBILE_RE = /\b(Mobi|Mobile|Android|iPhone|iPad|iPod|Windows Phone|IEMobile|BlackBerry|Silk|Kindle|Opera Mini)\b/i;
function classifyDevice(headers) {
  const h = headers || {};
  const raw = h['sec-ch-ua-mobile'];
  const chm = Array.isArray(raw) ? raw.join(',') : String(raw == null ? '' : raw);
  const ua = String(h['user-agent'] || '');
  const uaMobile = DEVICE_UA_MOBILE_RE.test(ua);
  // The client hint is authoritative when the client actually sent one — including a phone in
  // "Request desktop site" mode, which deliberately presents itself as a desktop and whose
  // in-browser challenge fingerprint reports desktop too.
  if (/\?1/.test(chm)) return { mobile: true, signal: 'ch:?1' };
  if (/\?0/.test(chm)) {
    // A UA that still carries a mobile token beside `?0` is worth recording: it is the signature
    // of desktop-site mode (or of a hop rewriting one of the two), and it is exactly the case
    // that made real phones look like desktops in the log.
    return { mobile: false, signal: uaMobile ? 'ch:?0+mobile-ua' : 'ch:?0' };
  }
  if (uaMobile) return { mobile: true, signal: 'ua' };
  return { mobile: false, signal: ua ? 'ua:desktop' : 'none' };
}
// Read the class decided at ingress. Falls back to classifying on the spot for the few internal
// call sites that run outside the main handler (and for tests that call it directly).
function deviceOf(req) {
  if (req && req.__genzDevice) return req.__genzDevice;
  return classifyDevice(req && req.headers);
}
function isMobileClient(req) { return deviceOf(req).mobile; }
function deviceLabel(req) { return deviceOf(req).mobile ? 'mobile' : 'desktop'; }
// EVIDENCE (live claude1 console.log, 2026-07-22): the gateway's egress is a DATACENTER IP, and the
// ONLY Cloudflare cf_clearance that is valid for it is the vault's — minted via Capture-through-the-
// gateway with the PINNED DESKTOP UA. With that clearance + desktop UA, /api/* returns 200 for the
// vast majority of calls (481×200 vs 120×403). A mobile client, however, was sending its OWN UA AND
// having the vault clearance stripped (the two "mobile identity" experiments), so it had NO usable
// clearance → Cloudflare challenged nearly every /api/* call → Claude's app navigated the tab to
// /api/challenge_redirect to solve it → that returns a 403 CF challenge through the proxy on 100% of
// hits (54/54) and NEVER clears (an interactive managed challenge cannot complete same-origin through
// a reverse proxy) → endless verification loop → nav_loop_break. That is the recurring mobile bug.
//
// FIX: a mobile client rides the SAME upstream identity + reused vault clearance as desktop, so it
// gets the same 200s and never triggers the unsolvable challenge_redirect loop. The browser stays a
// real mobile browser; only the UPSTREAM HTTP identity (and the reused clearance) are the desktop
// vault's. Because a valid clearance means Cloudflare does not present a challenge, its in-browser
// fingerprint is never cross-checked, so the old mobile↔desktop mismatch never arises. Reversible:
// CLAUDE_MOBILE_UPSTREAM=own restores the (currently broken) per-device path for A/B testing.
//
// ★ REVERSED 2026-07-22 — the premise above was FALSE. A diagnostic on the live gateway showed
// the vault bundle carries NO cf_clearance at all (25/25 sampled navigations:
// cf_vault_clearance:false), so there was never a "working vault clearance" for a mobile client
// to ride. Forcing the pinned DESKTOP User-Agent onto a phone therefore bought nothing, while
// costing the one thing that can still work: a Cloudflare challenge is solved by JS in the REAL
// browser, and it can only clear if the HTTP request agrees with what that browser reports. A
// phone sending a desktop UA can never clear its own challenge.
//
// ★ SETTLED 2026-07-29 — the default is 'vault' (mobile presents the SAME pinned upstream identity
// as desktop). The 'own' experiment is retained only as a kill-switch. Reasons, in order of weight:
//
//   1. 'own' mode makes a phone DEPEND ON A CLEARANCE IT CANNOT OBTAIN. Mobile sends its own UA and
//      stripCfCookies drops the vault's CF cookies, so the only clearance it can use is one its own
//      browser solved on this origin — and a Cloudflare interactive/managed challenge cannot clear
//      same-origin through a reverse proxy (live-proved: /api/challenge_redirect 54/54 → 403, never
//      once cleared). So 'own' leaves mobile with NO usable clearance by construction.
//   2. It also makes the upstream identity UNSTABLE and device-derived: every phone model presents a
//      different UA + hint set to Cloudflare from one shared datacenter egress IP, which is a worse
//      bot signal than one consistent, known browser identity.
//   3. Riding the vault does NOT copy a clearance between devices or accounts: there is exactly one
//      authorised vault bundle per Claude account, captured through this gateway from this egress.
//      Nothing a device solved is ever reused for a different device or client.
//
// HONEST LIMIT: the vault bundle currently carries NO cf_clearance at all (live: cf_vault_clearance
// false on every sampled request). Vault mode therefore gives mobile a STABLE, desktop-identical
// identity — which is what removes the mobile-only penalty — but it cannot manufacture a clearance
// that was never captured. Making Claude reliably challenge-free still requires an operator to
// re-add the account with "Capture via proxy", which mints a clearance for THIS egress IP under
// THIS pinned UA. No gateway logic substitutes for that, and none here pretends to.
//
// DESKTOP IS UNAFFECTED by this constant in either mode — it has always sent, and still sends, the
// pinned identity. `CLAUDE_MOBILE_UPSTREAM=own` restores the previous per-device behaviour.
const MOBILE_RIDES_VAULT = String(process.env.CLAUDE_MOBILE_UPSTREAM || 'vault').toLowerCase() !== 'own';
// Returns { ua, ch } to send upstream. Desktop, and mobile in the default 'vault' mode → the pinned
// desktop identity (which is what the vault clearance is bound to). Mobile in 'own' mode → the
// client's own UA + whatever client-hints it actually sent (kept only as a reversible kill-switch).
function upstreamIdentity(req) {
  if (!isMobileClient(req) || MOBILE_RIDES_VAULT) {
    return { ua: UPSTREAM_UA, ch: { 'sec-ch-ua': UPSTREAM_CH_UA, 'sec-ch-ua-mobile': '?0', 'sec-ch-ua-platform': UPSTREAM_CH_PLATFORM } };
  }
  const ch = {};
  let sentAny = false;
  for (const h of CLIENT_CH_HEADERS) { const v = req.headers && req.headers[h]; if (v != null) { ch[h] = v; sentAny = true; } }
  // Only synthesise the mobile flag for a Chromium client that sends hints but happened to
  // omit it. A hint-less client (e.g. iOS Safari sends NO Sec-CH-UA at all) must stay
  // hint-less — inventing a client-hint Safari never sends is itself a bot tell.
  if (sentAny && ch['sec-ch-ua-mobile'] == null) ch['sec-ch-ua-mobile'] = '?1';
  return { ua: String((req.headers && req.headers['user-agent']) || '') || UPSTREAM_UA, ch };
}
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
// ── Transient Cloudflare challenge on a page navigation ──────────────────────
// Live evidence (see the boundary comment in proxy()): identical requests to /new alternate
// between 200 and a 403 challenge, so a challenged navigation is a TRANSIENT condition of the
// shared datacenter egress IP, not a property of the request. Re-send it a bounded number of
// times before giving up; nav-only and bounded so we never hammer an IP that is already being
// rate-limited. Set CLAUDE_CF_NAV_RETRIES=0 to disable.
const CF_NAV_RETRIES = Math.max(0, Math.min(4, parseInt(process.env.CLAUDE_CF_NAV_RETRIES, 10) >= 0 ? parseInt(process.env.CLAUDE_CF_NAV_RETRIES, 10) : 2));
const CF_NAV_RETRY_DELAY_MS = Math.max(100, parseInt(process.env.CLAUDE_CF_NAV_RETRY_DELAY_MS, 10) || 700);
// After the retries are spent, show a recoverable notice rather than Cloudflare's own challenge
// document — that document refreshes ITSELF and can never clear through a reverse proxy, which is
// the "reloads a few times then lands on the verification page" the client reports.
// CLAUDE_CF_NAV_NOTICE=0 restores the raw passthrough.
const CF_NAV_NOTICE = process.env.CLAUDE_CF_NAV_NOTICE !== '0';

// ── Mobile-only: keep a Cloudflare challenge OUT of Claude's background fetches ────────────────
// ROOT CAUSE (live console.log, 4,591 lines): the shared datacenter egress IP is CF-challenged on
// ~35% of requests, and NONE of those challenges is a login/session problem (redirected_to_login
// is false on 100% of them — pure Cloudflare). When one lands on an XHR/API fetch, the gateway used
// to forward the raw 403 challenge DOCUMENT into Claude's SPA, which reacts by full-page-navigating
// the tab to /api/challenge_redirect to "solve" it. Through a reverse proxy from a datacenter IP an
// interactive managed challenge can never clear same-origin, so it just re-challenges: 179 XHR
// challenges → 288 challenge_redirect navs (all 403) → retries spent → the 3–4 reloads clients see.
// This shield returns a benign, NON-navigating transient error for those XHR challenges (Fix A) and
// bounces a stray challenge_redirect navigation straight back to the app (Fix B), so the loop cannot
// form. DESKTOP IS UNAFFECTED — every use is gated on isMobileClient(req), so the desktop path stays
// byte-for-byte frozen. Auth is untouched (the vault session still goes upstream; we only decline to
// forward an unsolvable challenge document to a background fetch). Default ON; =0 restores passthrough.
const CLAUDE_MOBILE_XHR_SHIELD = TOOL_KEY === 'claude' && process.env.CLAUDE_MOBILE_XHR_SHIELD !== '0';

// ── Honest failure classification for a page navigation ──────────────────────
// A single catch-all message ("… is busy right now") was actively harmful: it reported a
// CAPACITY problem for what were really Cloudflare verifications and, worse, for a vault account
// whose captured session carries no Cloudflare clearance — the one condition an operator can
// actually fix. Each condition now gets its own safe code, its own HTTP status and its own
// wording. Codes are stable identifiers for the log; they contain no cookie, lease or session.
const UPSTREAM_ERROR = {
  CLOUDFLARE_CHALLENGE: 'CLOUDFLARE_CHALLENGE',
  ACCOUNT_SESSION_INVALID: 'ACCOUNT_SESSION_INVALID',
  RATE_LIMITED: 'RATE_LIMITED',
  UPSTREAM_OVERLOADED: 'UPSTREAM_OVERLOADED',
  NETWORK_TIMEOUT: 'NETWORK_TIMEOUT',
};
// Does the vault bundle actually carry a Cloudflare clearance? PRESENCE only, never the value.
// Live evidence (2026-07-22): 25/25 sampled navigations had NO vault clearance, which is why
// almost every request was challenged from the datacenter egress IP.
function hasVaultClearance(session) {
  return !!(session && session.cookieHeader && /(^|;\s*)cf_clearance=/.test(session.cookieHeader));
}
function classifyUpstreamFailure({ status, cfChallenge, vaultClearance, retries }) {
  if (cfChallenge) {
    // A Cloudflare challenge is a RECOVERABLE condition, never a confirmation that the account
    // session is dead. The earlier "no vault clearance ⇒ account needs reconnecting" branch was a
    // FALSE POSITIVE: the same live diagnostic that added the nav-retry logic proved the vault
    // bundle essentially never carries a cf_clearance (25/25 sampled navigations: none), yet those
    // very navigations alternate 200 ⇄ 403 with identical cookies and mostly succeed on a retry —
    // i.e. absence of a vault clearance says nothing about session validity. Mapping it to
    // "needs to be reconnected / contact support" therefore fired that operator-facing page for a
    // perfectly valid account on any transient datacenter-IP challenge, and (per requirement) the
    // reconnect page must show ONLY for a CONFIRMED-invalid session. A confirmed-invalid session is
    // detected independently — a real login redirect or a logged-out document → /account-expired +
    // sendBlockPage('session_expired') — and is unaffected by this. So a surviving challenge always
    // classifies as the recoverable CLOUDFLARE_CHALLENGE ("try again"). `vaultClearance` is retained
    // in the signature for the caller/log; it no longer gates the message. Reversible: nothing here
    // touches identity, cookies or retry behaviour — only the wording of the post-retry notice.
    return {
      code: UPSTREAM_ERROR.CLOUDFLARE_CHALLENGE,
      httpStatus: 503,
      title: `${TOOL_NAME} asked us to verify the connection`,
      msg: `${TOOL_NAME} ran a routine security check that we could not complete automatically. This usually clears within a minute. Your session is still active — please try again.`,
    };
  }
  if (status === 429) {
    return {
      code: UPSTREAM_ERROR.RATE_LIMITED, httpStatus: 503,
      title: `${TOOL_NAME} is rate limiting us`,
      msg: `${TOOL_NAME} is temporarily limiting how fast we can connect. Please wait a moment and try again — your session is still active.`,
    };
  }
  if (status >= 500) {
    return {
      code: UPSTREAM_ERROR.UPSTREAM_OVERLOADED, httpStatus: 503,
      title: `${TOOL_NAME} is busy right now`,
      msg: `${TOOL_NAME} reported that it is overloaded. This is on ${TOOL_NAME}'s side and usually clears quickly — please try again in a moment.`,
    };
  }
  return {
    code: UPSTREAM_ERROR.NETWORK_TIMEOUT, httpStatus: 502,
    title: `${TOOL_NAME} did not respond`,
    msg: `We could not reach ${TOOL_NAME} just now. This is usually temporary — please try again in a moment.`,
  };
}
// Per-device Cloudflare clearance (default ON). cf_clearance is bound to the minting
// UA + egress IP, so the vault's desktop-minted clearance is invalid on a mobile UA.
const PER_DEVICE_CLEARANCE = process.env.CLAUDE_PER_DEVICE_CLEARANCE !== '0';
// Remove Cloudflare-managed cookies from a cookie header, leaving auth/session cookies.
function stripCfCookies(rawCookieHeader) {
  return String(rawCookieHeader || '').split(';').map(s => s.trim()).filter(Boolean)
    .filter(p => { const i = p.indexOf('='); const name = (i < 0 ? p : p.slice(0, i)).trim(); return !CF_COOKIE_RE.test(name); })
    .join('; ');
}

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

// Read a single named cookie from a raw browser Cookie header (used to forward Claude's native
// `lastActiveOrg` workspace preference upstream so the native switch persists through the proxy).
function readBrowserCookie(rawCookieHeader, name) {
  const parts = String(rawCookieHeader || '').split(';');
  for (const p of parts) { const s = p.trim(); const i = s.indexOf('='); if (i < 0) continue; if (s.slice(0, i).trim() === name) { try { return decodeURIComponent(s.slice(i + 1)); } catch (_) { return s.slice(i + 1); } } }
  return null;
}
const CLAUDE_ORG_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

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
// Resolve the lease JWT for THIS request: Claude reads it from the opaque server-side session
// (via the __Host-claude_session cookie); every other tool reads the pg_lease cookie unchanged.
function resolveLeaseToken(req) {
  if (TOOL_KEY === 'claude') { const s = claudeGetSession(req); return s ? s.jwt : null; }
  return getLease(req);
}

// ── Claude opaque session store ──────────────────────────────────────────────
// SECURITY: the browser must NOT hold the readable lease JWT (it embeds tool/account/lease/exp
// claims and, being non-HttpOnly, is readable by page JS and any cookie-editor extension). For
// Claude we instead issue a short-lived, opaque, HttpOnly, host-only `__Host-claude_session`
// token that maps to THIS server-side record; the lease JWT is kept here and used only for
// server→backend /validate calls. The opaque token reveals no user/account/tool/lease/expiry.
// A cookie-editor can still READ the opaque token, but it is useless without this record and is
// revocable + short-lived + rotated. In-memory (Passenger single-worker); a restart just makes
// clients re-open from the dashboard (leases are short). Never logged.
const CLAUDE_SESSION_COOKIE = '__Host-claude_session';
// ── Opaque session store — DURABLE across Passenger workers + process recycles ──
// ROOT CAUSE this replaces: the session used to live ONLY in this process's in-memory Map,
// so when Passenger recycled the idle worker (no PassengerMinInstances pinning) or routed a
// request to a different worker, the browser's __Host-claude_session cookie resolved to
// nothing → sendBlockPage('lease_missing') → the app reloaded into the verification page.
// Fix: back the Map with an AES-256-GCM-ENCRYPTED file under the app's own tmp/ (shared by
// every worker on the same filesystem). The Map stays the hot path; on a miss we rehydrate
// from the encrypted file. The browser still holds only the random opaque sid — never the
// JWT. Server-side authorisation/revocation is UNCHANGED (revoke deletes the file too, and
// the backend /validate remains authoritative on every nav + 30s overlay poll).
const claudeSessions = new Map(); // sid -> { jwt, jti, exp(ms), cap, createdAt, lastSeen, rotatedAt }
const SESSION_DIR = path.join(__dirname, 'tmp', 'sessions');
try { fs.mkdirSync(SESSION_DIR, { recursive: true }); } catch (_) {}
// Boot-time probe: is the durable session store actually WRITABLE? If tmp/sessions cannot be
// written (wiped/perms-changed by a deploy, read-only mount), the opaque session can't persist
// across Passenger workers/recycles — which silently reintroduces the "reloads into the Cloudflare
// verification page mid-session" bug on mobile. Surfaced in /__genz/health so a deploy check can
// catch the drift instead of a user discovering it. Read-only probe result; never on the hot path.
const SESSION_STORE_WRITABLE = (function () {
  try {
    const probe = path.join(SESSION_DIR, '.wtest-' + process.pid);
    fs.writeFileSync(probe, '1'); fs.unlinkSync(probe);
    return true;
  } catch (_) { return false; }
})();
// Single source of truth for the "is Claude mobile still correctly configured?" invariants, used
// by BOTH the /__genz/health report and the boot-time warning. Each is a documented requirement of
// the mobile Cloudflare fix:
//   • cfChallengePassthrough / cfChallengeMode=passthrough — if Cloudflare ever does present a
//     challenge, its page/assets must be forwarded to the browser rather than blocked.
//   • mobileRidesVaultClearance — mobile must ride the SAME desktop upstream identity + reused vault
//     cf_clearance as desktop. Off (CLAUDE_MOBILE_UPSTREAM=own) strips the clearance and sends a
//     mobile UA the datacenter IP has no clearance for → Cloudflare challenges every /api/* call →
//     the unsolvable /api/challenge_redirect loop (the recurring mobile bug — proven in live logs).
//   • durableSessionStore — the opaque session must persist across Passenger workers/recycles;
//     a non-writable store → cross-worker session miss → reload into the verification page.
// Booleans only; no secret. Off is never fatal (documented kill-switches exist) — just loud.
function claudeMobileInvariants() {
  return [
    { key: 'cfChallengePassthrough', value: CF_CHALLENGE_PASSTHROUGH, ok: CF_CHALLENGE_PASSTHROUGH === true },
    { key: 'cfChallengeMode', value: CF_CHALLENGE_MODE, ok: CF_CHALLENGE_MODE === 'passthrough' },
    // A phone must present its OWN identity upstream, so the challenge its own browser is asked to
    // solve can actually clear. Reversed 2026-07-22 — see MOBILE_RIDES_VAULT.
    // Mobile must present the SAME pinned upstream identity as desktop and reuse the authorised
    // vault bundle. Off ('own') strips the vault's CF cookies and sends a device-derived UA, which
    // leaves a phone depending on a clearance it cannot obtain through a reverse proxy — the
    // recurring mobile-only fault. See MOBILE_RIDES_VAULT for the full reasoning.
    { key: 'mobileRidesVaultClearance', value: MOBILE_RIDES_VAULT, ok: MOBILE_RIDES_VAULT === true },
    { key: 'durableSessionStore', value: SESSION_STORE_WRITABLE, ok: SESSION_STORE_WRITABLE === true },
  ];
}
// Short per-worker id so timing logs reveal WHICH Passenger process served a request — this
// is how a multi-worker/recycle session miss shows up (same sid, different instance).
const INSTANCE_ID = crypto.randomBytes(3).toString('hex');
// Key derived from the same secret every worker already has via env — so any worker can
// decrypt, but the on-disk blob is useless without it. Never logged.
const SESSION_ENC_KEY = crypto.createHash('sha256')
  .update('claude-opaque-session:v1|' + (process.env.LEASE_SECRET || process.env.PROXY_LEASE_SECRET || process.env.JWT_SECRET || ''))
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
  } catch (_) { return null; }   // tampered / wrong-key / corrupt → treated as no session
}
function sessPersist(sid, rec) {
  try {
    const tmp = sessFile(sid) + '.' + process.pid + '.tmp';
    fs.writeFileSync(tmp, sessEncrypt({ jwt: rec.jwt, jti: rec.jti, exp: rec.exp, cap: rec.cap, createdAt: rec.createdAt, rotatedAt: rec.rotatedAt }));
    fs.renameSync(tmp, sessFile(sid));   // atomic publish
  } catch (_) {}
}
function sessLoad(sid) {
  try {
    const o = sessDecrypt(fs.readFileSync(sessFile(sid)));
    if (!o) return null;
    if (Date.now() > o.exp) { try { fs.unlinkSync(sessFile(sid)); } catch (_) {} return null; }
    return o;
  } catch (_) { return null; }   // no file → no session
}
function sessRemove(sid) { try { fs.unlinkSync(sessFile(sid)); } catch (_) {} }

function newSid() { return crypto.randomBytes(32).toString('base64url'); }
function claudeCreateSession(jwt, payload) {
  const sid = newSid();
  const exp = payload && payload.exp ? payload.exp * 1000 : Date.now() + 30 * 60 * 1000;
  const rec = { jwt, jti: (payload && payload.jti) || null, exp, cap: !!(payload && payload.cap), createdAt: Date.now(), lastSeen: Date.now(), rotatedAt: Date.now() };
  claudeSessions.set(sid, rec);
  sessPersist(sid, rec);
  return sid;
}
function claudeGetSession(req) {
  const sid = parseCookies(req.headers.cookie)[CLAUDE_SESSION_COOKIE];
  if (!sid) return null;
  let s = claudeSessions.get(sid);
  let source = 'memory';
  if (!s) {
    // Hot-path miss (this worker never held it, or was recycled): rehydrate from the shared
    // encrypted file. This is what keeps the session alive across workers/restarts.
    const o = sessLoad(sid);
    if (!o) return null;
    s = { jwt: o.jwt, jti: o.jti, exp: o.exp, cap: o.cap, createdAt: o.createdAt || Date.now(), lastSeen: Date.now(), rotatedAt: o.rotatedAt || Date.now() };
    claudeSessions.set(sid, s);
    source = 'rehydrated';   // recovered from the durable store — the case that used to fail
  }
  if (Date.now() > s.exp) { claudeSessions.delete(sid); sessRemove(sid); return null; }
  s.lastSeen = Date.now();
  return Object.assign({ sid, source }, s);
}
function claudeRevoke(sid) { if (sid) { claudeSessions.delete(sid); sessRemove(sid); } }
// Rotate the opaque id (session-fixation defence + limits token lifetime); keeps the same
// record. The new sid's file is written and the old one removed GLOBALLY (via the shared
// store), so after rotation the new sid resolves on every worker — not just this one.
function claudeRotate(sid) {
  const s = claudeSessions.get(sid) || (function () { const o = sessLoad(sid); return o ? { jwt: o.jwt, jti: o.jti, exp: o.exp, cap: o.cap, createdAt: o.createdAt, rotatedAt: o.rotatedAt } : null; })();
  if (!s) return null;
  claudeSessions.delete(sid); sessRemove(sid);
  const nsid = newSid(); s.rotatedAt = Date.now(); s.lastSeen = Date.now();
  claudeSessions.set(nsid, s); sessPersist(nsid, s);
  return nsid;
}
// __Host- prefix REQUIRES Secure + Path=/ + NO Domain (host-only). HttpOnly + SameSite=Lax.
function claudeSessionCookie(sid, maxAgeSec) {
  return `${CLAUDE_SESSION_COOKIE}=${sid}; Path=/; Secure; HttpOnly; SameSite=Lax; Max-Age=${Math.max(30, maxAgeSec)}`;
}
function claudeExpireCookie() { return `${CLAUDE_SESSION_COOKIE}=; Path=/; Secure; HttpOnly; SameSite=Lax; Max-Age=0`; }
setInterval(() => {
  const now = Date.now();
  for (const [sid, s] of claudeSessions) if (now > s.exp) claudeSessions.delete(sid);
  // Sweep expired encrypted session files so tmp/sessions doesn't grow unbounded.
  try {
    for (const f of fs.readdirSync(SESSION_DIR)) {
      if (!f.endsWith('.bin')) continue;
      const fp = path.join(SESSION_DIR, f);
      try { const o = sessDecrypt(fs.readFileSync(fp)); if (!o || now > o.exp) fs.unlinkSync(fp); } catch (_) {}
    }
  } catch (_) {}
}, 60000).unref();

// ── Short-lived backend-validate cache + in-flight dedup (nav speed) ──────────
// The nav path re-hits the backend /validate on EVERY navigation (8s timeout). A cold
// backend made that ~8s, and two navs in the same second issued two identical calls. Cache
// only a CONFIRMED-VALID result for a few seconds and coalesce concurrent calls, so warm
// loads and duplicate navs are instant. Failures are NEVER cached — a revoked/expired lease
// is still caught on the very next call, so revocation stays prompt. Keyed by jti (per lease).
const VALIDATE_CACHE_TTL_MS = Math.max(0, parseInt(process.env.CLAUDE_VALIDATE_CACHE_MS, 10) || 8000);
const validateCache = new Map();   // jti -> { until, result }
const validateInflight = new Map(); // jti -> Promise
function backendValidateCached(token, jti) {
  const key = jti || ('t:' + String(token).slice(-24));
  const hit = validateCache.get(key);
  if (hit && hit.until > Date.now()) return Promise.resolve(hit.result);
  const flying = validateInflight.get(key);
  if (flying) return flying;        // coalesce simultaneous validations into one round-trip
  const p = backendValidate(token).then((v) => {
    // Cache ONLY an authoritative success; leave every failure uncached so it re-checks.
    if (VALIDATE_CACHE_TTL_MS > 0 && v && v.status === 200 && v.body && v.body.valid === true) {
      validateCache.set(key, { until: Date.now() + VALIDATE_CACHE_TTL_MS, result: v });
    }
    return v;
  }).finally(() => { validateInflight.delete(key); });
  validateInflight.set(key, p);
  return p;
}
setInterval(() => { const now = Date.now(); for (const [k, v] of validateCache) if (v.until <= now) validateCache.delete(k); }, 30000).unref();

// Strip ONLY the lease cookie, preserving every other cookie byte-for-byte.
function stripLeaseCookie(rawCookieHeader) {
  return String(rawCookieHeader || '').split(';').map(s => s.trim()).filter(Boolean)
    .filter(p => { const i = p.indexOf('='); const name = (i < 0 ? p : p.slice(0, i)).trim(); return name !== LEASE_COOKIE; })
    .join('; ');
}

// ── Backend calls (server-to-server) ────────────────────────────────────────
// Confirmed authorization denials — the ONLY codes that revoke the opaque Claude session.
// Mirrors TERMINAL_CODES in backend/utils/proxy/validationResponse.js. Anything absent from
// this set (429, 5xx, network failure, malformed body) is treated as temporary.
const CLAUDE_TERMINAL_CODES = new Set([
  'lease_expired', 'lease_revoked', 'lease_invalid', 'lease_missing',
  'client_disabled', 'client_not_found', 'plan_expired',
  'account_blocked', 'account_no_session',
]);

function backendPost(subpath, token, extraHeaders, jsonBody) {
  return new Promise((resolve) => {
    try {
      const u = new URL(`${API_BASE}${subpath}`);
      const lib = u.protocol === 'https:' ? https : http;
      const body = Buffer.from(JSON.stringify(jsonBody || {}));
      const headers = Object.assign({
        'content-type': 'application/json',
        'content-length': body.length,
      }, token ? { 'authorization': `Bearer ${token}` } : {}, extraHeaders || {});
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

// ── One-time launch redemption ───────────────────────────────────────────────
// No lease exists yet, so this call is authenticated solely by the shared gateway key. The
// backend redeems the code atomically, re-checks the client/plan/lease, and hands back a
// freshly signed lease token — which stays in this process and is never sent to the browser.
function redeemLaunchCode(code) {
  return gatewayApiPost('/redeem-launch', null, { code });
}

// ── Request body reader (bounded) ────────────────────────────────────────────
// Used ONLY by /launch. Bounded so a hostile POST cannot buffer memory here, and it accepts
// both form-encoded (the dashboard's hidden form) and JSON (tests / programmatic launches).
function readLaunchBody(req) {
  return new Promise((resolve) => {
    const ct = String(req.headers['content-type'] || '').toLowerCase();
    let size = 0;
    const chunks = [];
    let done = false;
    const finish = (val) => { if (!done) { done = true; resolve(val); } };
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
        const params = new URLSearchParams(raw);
        const out = {};
        for (const [k, v] of params) out[k] = v;
        return finish(out);
      } catch (_) { return finish(null); }
    });
  });
}

// ── Account Vault session (gateway-only) — fetch + short in-process cache ─────
const sessionCache = new Map();
const SESSION_TTL_MS = Math.max(1, parseInt(process.env.CLAUDE_SESSION_TTL_MS, 10) || 60 * 1000);
// ── Transient vs CONFIRMED on the account-vault fetch ────────────────────────────────────────
// ROOT CAUSE this fixes (desktop, laptop and incognito alike): the lease/validate path already
// separates a confirmed authorization denial from a transient infrastructure failure, but the
// OTHER backend call every request makes — POST /session, which fetches the vault bundle — did
// not. Every response that was not a recognised success became `{ blocked: true }`, and the
// request handler renders that as the 403 "<tool> session ended" page. So a 429 from the
// backend's shared per-IP budget (its `code` is `rate_limited`, absent from sendBlockPage's
// message map → the generic "Access could not be verified."), a 500, a 503 or a malformed body
// each ENDED a live session whose lease and vault account were both perfectly valid — and the
// verdict was cached for a minute, so refreshing repeated it.
//
// Only these codes are a CONFIRMED account/authorization denial (mirrors CLAUDE_TERMINAL_CODES
// and TERMINAL_CODES in backend/utils/proxy/validationResponse.js). Anything else — 429, 5xx,
// a network failure, a malformed body, a gateway-key misconfiguration — is temporary by
// definition and must be retried, never terminated. Unknown codes therefore fail SAFE for
// availability while still granting nothing: a transient verdict injects no account cookies.
const ACCOUNT_TERMINAL_CODES = new Set([
  'account_blocked', 'account_no_session',
  'lease_expired', 'lease_revoked', 'lease_invalid', 'lease_missing',
  'client_disabled', 'client_not_found', 'plan_expired',
]);
// How long a lease's LAST KNOWN GOOD vault bundle may be reused while the backend is failing.
// This is what keeps a live page working through a backend blip instead of interrupting it: the
// bundle is the account's own cookies, already served to this same lease, so reusing it grants
// nothing new. Bounded, and it can never outlive the lease — authorization is still decided by
// the backend /validate on every navigation and every 30s overlay poll, which is unchanged.
const SESSION_GRACE_MS = Math.max(0, parseInt(process.env.CLAUDE_SESSION_GRACE_MS, 10) || 10 * 60 * 1000);
// Coalesce concurrent /session calls for one lease into a single round-trip, exactly as
// backendValidateCached already does for /validate. Without this, a page's parallel requests
// each issued their own fetch and the LAST one to resolve won the cache — so a late failure
// could overwrite a good bundle that a newer, successful response had already stored.
const sessionInflight = new Map();
// MEMORY: entries are keyed by lease jti and the 60s TTL was only ever checked on READ, so a
// key that is never read again was never removed — every lease issued left a permanent entry
// holding its cookie header plus localStorage/sessionStorage blobs (tens of KB each). Over a
// long-lived worker that is unbounded growth, and it is why RSS climbed the longer a process
// stayed up. Sweep expired entries on a timer, exactly as validateCache already does.
// .unref() so this never keeps the process alive. Behaviour is unchanged: an entry past its
// TTL was already treated as a miss and refetched.
// A GOOD entry is kept past its serving TTL until `graceUntil` so it can still be reused while
// the backend is failing (see SESSION_GRACE_MS); every other entry is removed at `exp` exactly as
// before. Still strictly bounded — nothing outlives graceUntil, and a lease is short-lived.
const _sessionCacheGc = setInterval(() => {
  const now = Date.now();
  for (const [k, v] of sessionCache) if (!v || (v.graceUntil || v.exp) <= now) sessionCache.delete(k);
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
// Returns exactly one of:
//   { noAccount }            — this lease legitimately has no vault account (nothing to inject)
//   { …bundle fields }       — a usable account session
//   { blocked, code }        — a CONFIRMED denial; the caller may end the session
//   { transient, code }      — a TEMPORARY failure; the caller must keep the session and retry
async function getSession(token, jti) {
  const key = jti || ('t:' + String(token).slice(-24));
  const hit = sessionCache.get(key);
  if (hit && hit.exp > Date.now()) return hit.data;
  const flying = sessionInflight.get(key);
  if (flying) return flying;                 // one round-trip per lease, no last-writer-wins race
  const p = getSessionFresh(token, key, hit);
  sessionInflight.set(key, p);
  p.finally(() => { sessionInflight.delete(key); }).catch(() => {});
  return p;
}
async function getSessionFresh(token, key, hit) {
  const r = await fetchAccountSession(token);
  // The last KNOWN-GOOD bundle for this same lease, if it is still inside its grace window.
  const lastGood = (hit && hit.good && (hit.graceUntil || 0) > Date.now()) ? hit.data : null;
  let data;
  let cache = true;
  if (r.noKey) data = { noAccount: true };
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
      // "Allow Fable 5" as set in the admin panel. Only trusted when the backend actually sent
      // a boolean; anything else leaves it undefined so the env fallback decides. This rides on
      // the existing 60s session cache, so an admin toggle takes effect within ~a minute with
      // no redeploy.
      allowFable5: (typeof r.body.allowFable5 === 'boolean') ? r.body.allowFable5 : undefined,
    };
  }
  else {
    const code = (r.body && r.body.code) || null;
    // status 0 is our own network error / 8s timeout — never an authorization decision.
    const terminal = r.status !== 0 && ACCOUNT_TERMINAL_CODES.has(String(code || ''));
    if (terminal) {
      data = { blocked: true, code };
    } else if (lastGood) {
      // Keep the live page working: reuse the bundle this lease was already served. Not cached,
      // so the very next call re-checks and the moment the backend answers we are back to normal.
      data = lastGood;
      cache = false;
      safeLog('account_session_stale_served', { instance: INSTANCE_ID, upstream_status: r.status, code: code || 'account_session_unavailable' });
    } else {
      data = { transient: true, code: code || 'account_session_unavailable', upstreamStatus: r.status };
      cache = false;             // a temporary verdict must never be remembered
    }
  }
  if (cache) {
    const good = !data.blocked && !data.transient;
    const exp = Date.now() + SESSION_TTL_MS;
    sessionCache.set(key, { exp, good, graceUntil: good ? Date.now() + SESSION_GRACE_MS : exp, data });
  }
  return data;
}

// Safe structured log — IDs / counts / status only. NEVER cookie names or values.
// Redact anything that looks like a secret before it can reach a log line: emails, JWTs,
// long hex/base64 blobs (cookie/token values), UUIDs (org/account/device ids) and known
// sensitive keys. Callers already pass only counts/booleans, but this makes leakage impossible.
// NOTE on `device`: this used to match the bare key `device`, whose only value anywhere in this
// file is the literal string 'mobile' or 'desktop' — a device CLASS, not an identifier. Redacting
// it made the mobile-vs-desktop diagnostics unreadable in the live log, which is precisely the
// signal needed to diagnose a mobile-only Cloudflare regression. Narrowed to device *identifiers*
// (device_id / device-id / deviceId), which stay redacted, as do org/account/clearance/lease ids.
const REDACT_KEY_RE = /(cookie|token|auth|authorization|secret|jwt|lease|sid|session|email|password|bearer|set-cookie|org|account|device[_-]?id|clearance)/i;
function redactValue(v) {
  if (v == null) return v;
  if (typeof v === 'number' || typeof v === 'boolean') return v;
  const s = String(v);
  if (/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/i.test(s)) return '[redacted:email]';
  if (/^[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}$/.test(s)) return '[redacted:jwt]';
  if (/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(s)) return '[redacted:uuid]';
  if (/^[A-Za-z0-9+/_=-]{24,}$/.test(s)) return '[redacted]';
  return s;
}
function redactFields(f) {
  if (!f || typeof f !== 'object') return f;
  const out = Array.isArray(f) ? [] : {};
  for (const k of Object.keys(f)) {
    const val = f[k];
    if (val && typeof val === 'object') out[k] = redactFields(val);
    else if (REDACT_KEY_RE.test(k) && typeof val === 'string') out[k] = val ? '[redacted]' : val;
    else out[k] = redactValue(val);
  }
  return out;
}
function safeLog(event, fields) {
  try { console.log(`[proxy-gw:${TOOL_KEY || '?'}] ${event} ${JSON.stringify(redactFields(fields))}`); } catch (_) {}
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

// ── Per-lease browser-storage reset (opt-in; default OFF) ─────────────────────
// Some tools (WriteHuman, Ryne) are client-side token SPAs that cache the signed-in
// account's identity — and frequently a bearer token they replay in an Authorization
// header, which bypasses cookies entirely — in localStorage/sessionStorage on the GATEWAY
// origin. The gateway controls cookies fully server-side (it drops the browser cookie and
// injects the vault account's cookies on every upstream request), so the cookie layer
// already switches accounts correctly. But that browser STORAGE survives an account switch:
// after an admin updates the vault cookies, the next launch injects the NEW account's
// cookies, yet the SPA resurrects the OLD account (or replays its old token) from storage →
// the client opens the old/invalid account. Cookie-session tools (HIX/BypassGPT) read
// identity from the cookie on each request and cache nothing in storage, so they're immune.
// When RESET_STORAGE_ON_NEW_LEASE=1 the gateway clears localStorage+sessionStorage exactly
// ONCE per lease (keyed by the lease jti) on the first HTML navigation. Each cookie update
// revokes the account's leases, so the next launch mints a FRESH lease (new jti) → storage
// is wiped → the freshly injected cookies define the account. Within a session (same jti)
// storage persists so the app works normally. Default OFF → every other tool is byte-for-
// byte unchanged. Set per tool via this gateway's .env / .htaccess SetEnv.
const RESET_STORAGE_ON_NEW_LEASE = process.env.RESET_STORAGE_ON_NEW_LEASE === '1' || /^true$/i.test(process.env.RESET_STORAGE_ON_NEW_LEASE || '');

// ── Client-side Supabase session injection (opt-in; default OFF) ──────────────
// WriteHuman authenticates ENTIRELY client-side with Supabase: the session lives in the
// `sb-<ref>-auth-token` cookie (sometimes chunked into `.0`/`.1`) that the in-browser
// Supabase SDK reads from document.cookie to hydrate a logged-in app. Server-rendered
// cookie-session tools (HIX/BypassGPT) only need the vault cookie attached to the UPSTREAM
// request — nothing has to reach the browser. But for a client-side-auth SPA that upstream
// cookie is invisible to the browser, so the SDK finds no session and renders the PUBLIC
// "Log in / Sign Up" page even when valid cookies sit in the vault. When
// SUPABASE_BROWSER_SESSION=1 the gateway materialises ONLY the vault's Supabase auth cookies
// (names starting `sb-`) onto THIS gateway origin so the SDK can hydrate — clearing any
// previous account's `sb-*` cookies FIRST so a stale session can never win. Default OFF →
// every other tool is byte-for-byte unchanged. This delivers exactly the same session
// material the localStorage bootstrap already provides for token SPAs; no identity is exposed.
const SUPABASE_BROWSER_SESSION = process.env.SUPABASE_BROWSER_SESSION === '1' || /^true$/i.test(process.env.SUPABASE_BROWSER_SESSION || '');
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

// Content hashes → immutable cache URLs that bust themselves on deploy.
const OVERLAY_JS_HASH = crypto.createHash("sha256").update(OVERLAY_JS).digest("hex").slice(0, 12);
const OVERLAY_CSS_HASH = crypto.createHash("sha256").update(OVERLAY_CSS).digest("hex").slice(0, 12);
const OVERLAY_JS_ETAG = '"' + OVERLAY_JS_HASH + '"';
const OVERLAY_CSS_ETAG = '"' + OVERLAY_CSS_HASH + '"';
// Inlined into <head> (not <script src defer>) so its MutationObserver/hiding starts
// before <body> paints — same no-flash technique as the StealthWriter gateway.
const OVERLAY_JS_INLINE = OVERLAY_JS.replace(/<\/script>/gi, '<\\/script>');

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
  // This page is the one a phone is most likely to cache and replay. When the session is
  // genuinely over (a lease code — NOT a transient 'unavailable'/'session_expired'/account
  // hiccup, where wiping the app's storage would be destructive and pointless), make it
  // dismantle the replay machinery on its way out: drop any service worker registered on
  // this origin, empty Cache Storage, and clear local/sessionStorage. So the NEXT dashboard
  // launch reaches the server for real instead of being served from the device.
  // Self-healing only — it removes stale client-side state and grants nothing.
  const wipe = /^lease_/.test(String(code || ''));
  const heal = wipe
    ? '<script>(function(){try{if(navigator.serviceWorker&&navigator.serviceWorker.getRegistrations)'
      + 'navigator.serviceWorker.getRegistrations().then(function(r){for(var i=0;i<r.length;i++){try{r[i].unregister();}catch(e){}}}).catch(function(){});}catch(e){}'
      + 'try{if(window.caches&&caches.keys)caches.keys().then(function(k){for(var i=0;i<k.length;i++){try{caches.delete(k[i]);}catch(e){}}}).catch(function(){});}catch(e){}'
      + 'try{localStorage.clear();}catch(e){}try{sessionStorage.clear();}catch(e){}})();</script>'
    : '';
  // ── Mobile block-page resume-recovery (CLAUDE ONLY) ──────────────────────────
  // ROOT CAUSE this fixes: on a phone, "reopen from the dashboard" resurfaces the EXISTING tab that
  // is showing THIS expired block page, rather than building a fresh document (desktop uses a real
  // new tab, so it never sees a stale block page). This page carries no overlay, so nothing noticed
  // that an authorized dashboard relaunch had already installed a FRESH __Host-claude_session cookie
  // on this origin — the phone just kept showing "session ended" through refreshes and app-switches.
  //
  // Fix: on a RESUME event only (never on first paint), ask the server — same-origin, the HttpOnly
  // session cookie is sent automatically — whether a valid session now exists, and if so replace the
  // page with the app. It NEVER renews anything itself: it only mirrors the backend's own valid:true,
  // which requires the fresh lease cookie that only a dashboard relaunch mints. A plain refresh (no
  // relaunch) still resolves to valid:false → stays expired, exactly as required. location.replace()
  // is a full navigation, so no stale terminal/countdown/validation state can survive into the new
  // session, and an in-flight guard + one-shot `done` flag stop a delayed response from acting twice.
  //
  // SCOPE (regression-sensitive): gated to `wipe`, i.e. the lease_* codes only — the states an
  // authorized dashboard relaunch genuinely resolves. It must NOT ride along on a TRANSIENT block
  // ('unavailable', 'session_expired', account/plan codes), because there the lease is still valid,
  // so /__genz/validate answers valid:true and the page would navigate back into a screen that is
  // still failing — a reload-on-temporary-error loop, driven once per app-switch. Temporary trouble
  // is the notice page's job (manual retry, never automatic).
  const recover = (TOOL_KEY === 'claude' && wipe)
    ? '<script>(function(){var GO=' + JSON.stringify(DEFAULT_PATH || '/') + ';var busy=false,done=false,last=0;'
      + 'function chk(){if(done||busy)return;var n=Date.now();if(n-last<2500)return;last=n;busy=true;'
      + "try{fetch('/__genz/validate',{method:'POST',credentials:'same-origin',cache:'no-store',headers:{'content-type':'application/json'}})"
      + '.then(function(r){return r.json().catch(function(){return{};});})'
      + '.then(function(j){busy=false;if(j&&j.valid===true){done=true;location.replace(GO);}})'
      + '.catch(function(){busy=false;});}catch(e){busy=false;}}'
      + "document.addEventListener('visibilitychange',function(){if(document.visibilityState==='visible')chk();});"
      + "window.addEventListener('focus',chk);window.addEventListener('online',chk);"
      + "window.addEventListener('pageshow',function(e){if(e&&e.persisted)chk();});})();</script>"
    : '';
  const html = `<!doctype html><html><head><meta charset="utf-8"><title>Session ended</title>
<meta name="viewport" content="width=device-width, initial-scale=1">${heal}${recover}
<style>body{margin:0;font-family:system-ui,-apple-system,Segoe UI,Roboto,sans-serif;background:#0b1220;color:#e2e8f0;display:flex;min-height:100vh;align-items:center;justify-content:center}
.card{max-width:420px;text-align:center;padding:40px 32px;background:#111a2e;border:1px solid rgba(6,182,212,.25);border-radius:16px}
h1{font-size:20px;margin:0 0 12px}p{color:#94a3b8;line-height:1.6;margin:0 0 20px}
a{display:inline-block;background:linear-gradient(135deg,#2563EB,#06B6D4);color:#fff;text-decoration:none;padding:11px 22px;border-radius:10px;font-weight:600}</style></head>
<body><div class="card"><h1>${TOOL_NAME} session ended</h1><p>${msg}</p>
<a href="https://app.genzdigitalstore.com/client/dashboard">Back to dashboard</a></div></body></html>`;
  // no-referrer: this page can be reached from a launch attempt, so it must never pass this
  // origin (or anything on its URL) onward in a Referer header.
  const headers = { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store', 'referrer-policy': 'no-referrer' };
  // REGRESSION-SENSITIVE (session ⇄ Cloudflare boundary). Standards-based equivalent of the
  // script above, for browsers that honour it (Chrome/Android). The directive list is
  // deliberately "cache", "storage" and MUST NEVER gain "cookies" or "*": Cloudflare clearance
  // and the opaque session both live in cookies on this origin, and clearing them on every
  // expiry would force a fresh challenge the proxy cannot help solve — i.e. it would recreate
  // the verification loop this whole file exists to prevent. Renewing a lease replaces the
  // application lease and nothing else. Safari ignores the header, which is why the inline
  // script exists too — and it, likewise, touches only caches and DOM storage.
  if (wipe && TOOL_KEY === 'claude') headers['clear-site-data'] = '"cache", "storage"';
  res.writeHead(403, headers);
  res.end(html);
}

// Claude quota block (claude-only, enforce mode). A completion request is an XHR/SSE fetch, so
// we answer with a claude-shaped JSON error the SPA can render — NOT an HTML page (which would
// break the app's fetch handler). Carries only an estimated-usage message; no secret.
function sendQuotaBlock(res, info) {
  const usage = (info && info.usage) || {};
  const weekly = usage.reason === 'weekly_client_limit' || usage.reason === 'weekly_account_capacity';
  const window = (info && info.window) || (weekly ? 'weekly' : '5-hour');
  const secs = info && info.resetInSeconds ? info.resetInSeconds : 0;
  const tail = secs
    ? ` It resets in about ${weekly ? Math.max(1, Math.round(secs / 3600)) + ' hour(s)' : Math.max(1, Math.round(secs / 60)) + ' minute(s)'}.`
    : '';
  const shared = usage.reason === 'account_capacity' || usage.reason === 'weekly_account_capacity';
  const msg = shared
    ? `This Claude account has reached its estimated local token capacity for the current ${window} cycle.${tail}`
    : `You have reached your estimated local Claude token allowance for the current ${window} cycle.${tail}`;
  const payload = JSON.stringify({ error: { type: 'genz_quota_exceeded', message: msg }, genz_estimated_local_usage: true });
  try {
    if (!res.headersSent) res.writeHead(429, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
    res.end(payload);
  } catch (_) { try { res.end(); } catch (__) {} }
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
  // Upstream / infra / debug identifiers — never surface claude.ai / Cloudflare / Anthropic /
  // origin details or tracing ids to the client (this gateway is Claude-only, so this is scoped).
  'server', 'x-powered-by', 'via', 'x-served-by', 'x-cache', 'x-cache-hits', 'x-timer',
  'cf-ray', 'cf-cache-status', 'cf-request-id', 'report-to', 'reporting-endpoints', 'nel',
  'expect-ct', 'server-timing', 'x-request-id', 'x-amzn-trace-id', 'x-amz-cf-id', 'x-amz-cf-pop',
  'x-envoy-upstream-service-time', 'x-anthropic-ratelimit-requests-remaining', 'x-should-retry',
  'x-runtime', 'x-vercel-id', 'x-vercel-cache', 'x-anthropic-organization-id', 'anthropic-organization-id',
]);
function rewriteSetCookie(values, capture) {
  const list = [].concat(values || []);
  // Claude (client sessions): NEVER leak claude.ai's own Set-Cookie to the browser. The account's
  // auth/session/refresh/org/device/tracking cookies live ONLY in the server-side vault and are
  // attached upstream in-process — the browser needs none of them. Forward ONLY Cloudflare
  // challenge cookies (cf_clearance / __cf_bm / cf_chl*) and ONLY when passthrough is on, because
  // the browser must store + resend those to complete a challenge it solves. Everything else is
  // dropped, so anthropic-device-id / activitySessionId / sessionKey / lastActiveOrg / ajs_* /
  // analytics cookies never appear in DevTools or a cookie-editor.
  // EXCEPTION — capture mode: the admin is logging into claude.ai THROUGH the gateway to save a
  // session, so the login cookies MUST reach the admin's browser to be captured. Pass them through
  // (admin-only, authenticated capture lease) — this never happens for a client session.
  if (TOOL_KEY === 'claude' && !capture) {
    if (!CF_CHALLENGE_PASSTHROUGH) return [];
    return list.filter(v => { const n = String(v).split('=')[0].trim(); return CF_COOKIE_RE.test(n); })
               .map(v => v.replace(/;\s*Domain=[^;]+/ig, ''));  // host-only even for CF cookies
  }
  return list.map(v => v.replace(/;\s*Domain=[^;]+/ig, ''));
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
function injectOverlay(html, capture, accountLabel, allowFable5Eff) {
  // accountLabel is the operator's SAFE account label (e.g. "Account 1") from the
  // backend /session response — never an email/cookie/token. Shown in the widget.
  const cfg = JSON.stringify({ api: API_BASE, capture: !!capture, toolName: TOOL_NAME, tool: TOOL_KEY, hideSelectors: HIDE_SELECTORS, accountLabel: accountLabel || null,
    defaultEffort: CLAUDE_DEFAULT_EFFORT, thinkingDefault: CLAUDE_THINKING_DEFAULT, effortTriggerSel: CLAUDE_EFFORT_TRIGGER_SEL || null,
    // Model allowlist, for the UI layer only. The block itself is enforced server-side; these
    // just let the overlay hide the entry and explain why. No secret, no account data.
    // Effective setting: admin panel when known, else the env fallback. Both default to blocked.
    allowFable5: (typeof allowFable5Eff === 'boolean') ? allowFable5Eff : CLAUDE_ALLOW_FABLE5,
    blockedModelMsg: modelPolicy.BLOCKED_MESSAGE,
    // Effort allowlist, for the UI layer only — the block itself is enforced server-side on the
    // way upstream. These let the overlay remove the entries from the picker, migrate a stale
    // saved preference, and explain why. No secret, no account data.
    allowedEfforts: CLAUDE_ALLOW_ALL_EFFORTS ? null : effortPolicy.ALLOWED_EFFORTS,
    blockedEffortMsg: effortPolicy.BLOCKED_MESSAGE,
    defaultModel: CLAUDE_DEFAULT_MODEL });
  const critical = capture ? '' : `<style id="genz-critical-hide">${buildCriticalCss()}</style>`;
  const tags =
    critical +
    `<link rel="stylesheet" href="/__genz/overlay.css?v=${OVERLAY_CSS_HASH}">` +
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
// One-time per-lease wipe of localStorage+sessionStorage on the gateway origin (see the
// RESET_STORAGE_ON_NEW_LEASE note above). Injected LAST so it ends up FIRST in <head> and
// runs before the session bootstrap (which re-seeds any vault storage) and before the app's
// own scripts. Marker key holds the current lease jti; storage is cleared only when the
// marker differs (i.e. a new lease = a fresh launch after a cookie update), so a normal
// in-session navigation leaves storage intact. No secrets are ever written.
function injectStorageReset(html, ctx) {
  if (!RESET_STORAGE_ON_NEW_LEASE) return html;
  if (!ctx || ctx.capture || ctx.asset) return html;     // never during admin capture / asset proxy
  const jti = String(ctx.jti || '');
  if (!jti) return html;
  const script = '<script>(function(){try{var K="__genz_lease",J=' + JSON.stringify(jti) + ';'
    + 'if(localStorage.getItem(K)!==J){try{localStorage.clear();}catch(e){}'
    + 'try{sessionStorage.clear();}catch(e){}try{localStorage.setItem(K,J);}catch(e){}}}catch(e){}})();</script>';
  const m = html.match(/<head[^>]*>/i);
  if (m) return html.replace(m[0], m[0] + script);
  return script + html;
}
// Materialise the vault's Supabase auth cookies onto the gateway origin so a client-side-auth
// SPA (WriteHuman) can hydrate a logged-in session. Opt-in via SUPABASE_BROWSER_SESSION (see
// the note above) → no-op for every other tool. Runs ONCE per lease, AFTER the per-lease
// storage reset (so the reset can't wipe its marker): it first EXPIRES any prior account's
// `sb-*` cookies on this origin, then sets the current vault session cookies, so the latest
// saved cookies always define the account and a stale session can never resurface. Within a
// session (same jti) it skips, letting the SDK manage its own refreshed cookies. Only `sb-`
// auth cookies are emitted — never any other cookie — and no value is ever logged.
function injectSupabaseBrowserSession(html, session, ctx) {
  if (!SUPABASE_BROWSER_SESSION) return html;
  if (!ctx || ctx.capture || ctx.asset) return html;          // never during admin capture / asset proxy
  if (!session || !session.cookieHeader) return html;
  const jti = String((ctx && ctx.jti) || '');
  if (!jti) return html;
  // Pull ONLY the Supabase auth cookies (sb-…-auth-token and its .0/.1 chunks) out of the
  // server-side vault cookie header. Value kept verbatim (cookie-safe base64url); never logged.
  const sb = [];
  for (const part of String(session.cookieHeader).split(';')) {
    const s = part.trim(); if (!s) continue;
    const i = s.indexOf('='); if (i < 0) continue;
    const name = s.slice(0, i).trim();
    if (/^sb-/.test(name)) sb.push([name, s.slice(i + 1)]);
  }
  if (!sb.length) return html;
  // Safe diagnostic: the COUNT of Supabase auth cookies materialised for this launch and the
  // lease id — never a cookie name beyond the count, never a value/token.
  safeLog('supabase_session_injected', { lease_id: jti, sb_cookie_count: sb.length });
  const data = JSON.stringify(sb);
  const script = '<script>(function(){try{var K="__genz_sb",J=' + JSON.stringify(jti) + ';'
    + 'if(localStorage.getItem(K)===J)return;'                                    // once per lease
    + 'var C=' + data + ';'
    + 'try{document.cookie.split(";").forEach(function(c){var n=c.split("=")[0].trim();'
    + 'if(/^sb-/.test(n)){document.cookie=n+"=; Path=/; Max-Age=0; SameSite=Lax";}});}catch(e){}'  // clear stale
    + 'for(var i=0;i<C.length;i++){try{document.cookie=C[i][0]+"="+C[i][1]+"; Path=/; SameSite=Lax";}catch(e){}}' // inject new
    + 'try{localStorage.setItem(K,J);}catch(e){}'
    + '}catch(e){}})();</script>';
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
  // REGRESSION-SENSITIVE (mobile ⇄ Cloudflare identity). Desktop AND vault-mode mobile → the pinned
  // desktop identity (which the vault cf_clearance is bound to); only the 'own' kill-switch sends a
  // real mobile UA. The UA and the client-hints MUST agree in BOTH branches below, or Cloudflare
  // challenges every request. See upstreamIdentity + the non-minimal branch's boundary comment.
  const id = upstreamIdentity(req);
  // `...id.ch` sits in the SAME position the pinned hints held before (right after user-agent) so the
  // header set is byte- and order-identical for desktop; for vault-mode mobile id.ua/id.ch are ALSO
  // the desktop identity, so the minimal (HTML-nav) request is inherently consistent.
  let headers;
  if (minimal) {
    headers = {
      host: upURL.host,
      'user-agent': id.ua,
      ...id.ch,
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
    headers['user-agent'] = id.ua;
    // ┌─ REGRESSION-SENSITIVE: the mobile ⇄ Cloudflare identity boundary. DO NOT let the UA and the
    // │  client-hints below disagree. `id.ua` is the PINNED DESKTOP UA for a mobile client in the
    // │  default 'vault' mode (see upstreamIdentity + MOBILE_RIDES_VAULT), which is what the vault
    // │  cf_clearance is bound to. If the hints here stay MOBILE while the UA is desktop, Cloudflare's
    // │  fingerprint cross-check fails and every XHR/API call is challenged → the /api/challenge_redirect
    // │  loop returns. That is precisely the regression commit 75341b4 left in THIS branch (it changed
    // │  id.ua but not these hints). The minimal branch above is already consistent via `...id.ch`.
    if (isMobileClient(req) && !MOBILE_RIDES_VAULT) {
      // 'own' kill-switch ONLY (CLAUDE_MOBILE_UPSTREAM=own): the device sends its OWN real UA, so
      // keep its OWN hints — UA and hints still agree (both mobile).
      if (headers['sec-ch-ua-mobile'] == null) headers['sec-ch-ua-mobile'] = '?1';
    } else {
      // Desktop, AND vault-mode mobile: present the pinned desktop identity. For a mobile client we
      // first PURGE every client-hint the spread carried, so no leftover mobile high-entropy hint
      // (sec-ch-ua-model:"Pixel 8", sec-ch-ua-platform-version, …) survives beside the desktop
      // sec-ch-ua — that pairing is itself a fingerprint mismatch. Desktop clients are untouched by
      // the purge (they keep their own matching high-entropy hints exactly as before).
      // Purge ONLY the hints we do not pin, and overwrite the pinned three IN PLACE: a
      // delete-then-reassign appends them at the end of the header list, giving mobile a
      // header ORDER no real Chrome produces (order is part of Cloudflare's fingerprint).
      if (isMobileClient(req)) { for (const chh of CLIENT_CH_HEADERS) if (!PINNED_CH_HEADERS.has(chh)) delete headers[chh]; }
      headers['sec-ch-ua'] = UPSTREAM_CH_UA; headers['sec-ch-ua-mobile'] = '?0'; headers['sec-ch-ua-platform'] = UPSTREAM_CH_PLATFORM;
    }
    // └─ end mobile⇄Cloudflare identity boundary ─────────────────────────────────────────────────
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
    // Cloudflare binds cf_clearance to BOTH the egress IP and the exact User-Agent that
    // minted it. The vault bundle's clearance was minted with the pinned DESKTOP UA, so
    // sending it on a request that (correctly) carries a MOBILE UA is a guaranteed
    // mismatch → Cloudflare rejects it → fresh challenge → the app reloads into the
    // verification page. Desktop is unaffected (its UA matches the minting UA).
    // So for a mobile client we drop ONLY the vault's Cloudflare cookies and let that
    // device use its OWN clearance, which it solved through this gateway and which is
    // therefore bound to the correct UA *and* to the gateway's egress IP. The vault's
    // auth/session cookies (sessionKey etc.) are NOT UA-bound and are still sent, so the
    // account stays logged in. Clearance becomes per-device; the session stays shared.
    // Kill-switch: CLAUDE_PER_DEVICE_CLEARANCE=0 restores the previous behaviour.
    // SUPERSEDED by MOBILE_RIDES_VAULT (default): the live logs proved a mobile device CANNOT solve
    // its own clearance through the proxy (challenge_redirect loops 100%), so stripping the vault
    // clearance just guarantees the loop. In the default 'vault' mode we KEEP the vault clearance for
    // mobile and send the matching desktop UA (see upstreamIdentity), so mobile rides the same working
    // clearance as desktop. Only the 'own' kill-switch (CLAUDE_MOBILE_UPSTREAM=own) still strips.
    if (!MOBILE_RIDES_VAULT && PER_DEVICE_CLEARANCE && isMobileClient(req)) {
      headers.cookie = stripCfCookies(headers.cookie);
    }
    // CF pass-through: also forward the browser's Cloudflare cookies (cf_clearance /
    // __cf_bm / cf_chl*) so a challenge solved through THIS gateway reaches the upstream
    // together with the vault session. Only Cloudflare-managed cookies are forwarded.
    // ┌─ REGRESSION-SENSITIVE: the mobile ⇄ Cloudflare CLEARANCE boundary. This is the third and
    // │  last place the "mobile rides the vault clearance" decision has to be honoured (the other
    // │  two are upstreamIdentity and the two buildUpstreamHeaders branches above).
    // │
    // │  mergeCookieHeaders is b-wins, so `merge(vault, browserCf)` lets ANY Cloudflare cookie the
    // │  device happens to hold on this origin REPLACE the vault's on the upstream leg. On desktop
    // │  that is harmless: the device's clearance was minted through this same gateway, from this
    // │  same egress IP, under the same pinned desktop UA, so the two are interchangeable.
    // │
    // │  On MOBILE in the default 'vault' mode it is the bug. The gateway now presents the pinned
    // │  DESKTOP identity upstream, but a clearance the phone obtained was solved by a MOBILE
    // │  browser, so Cloudflare bound it to a mobile fingerprint. Letting it override the vault's
    // │  clearance silently undoes the entire fix: the one clearance that is valid for this egress
    // │  IP is dropped, every /api/* call is challenged, Claude's app funnels each challenge through
    // │  /api/challenge_redirect, and an interactive challenge cannot complete same-origin through a
    // │  reverse proxy — the reload-into-verification loop. It also explains the "works, then breaks"
    // │  shape: a fresh phone has no CF cookie of its own and rides the vault clearance happily until
    // │  the first challenge response deposits one, after which every request is poisoned.
    // │
    // │  So in vault mode a mobile client merges the OTHER way round — the vault's Cloudflare
    // │  cookies WIN. Nothing is deleted: a browser CF cookie the vault does not have is still
    // │  forwarded, so a device is never left worse off than before. DESKTOP AND 'own' MODE KEEP
    // │  THE ORIGINAL b-wins ORDER, byte for byte.
    if (CF_CHALLENGE_PASSTHROUGH) {
      const cf = extractCfCookies(req.headers.cookie);
      if (cf) {
        const vaultWins = TOOL_KEY === 'claude' && MOBILE_RIDES_VAULT && isMobileClient(req);
        headers.cookie = vaultWins
          ? mergeCookieHeaders(cf, headers.cookie)   // vault clearance survives the merge
          : mergeCookieHeaders(headers.cookie, cf);  // unchanged for desktop / 'own' mode
      }
    }
    // └─ end mobile ⇄ Cloudflare clearance boundary ────────────────────────────────────────────
    // Claude NATIVE workspace switch: claude.ai's own account dropdown sets `lastActiveOrg`
    // client-side when the user picks a workspace. Browser cookies are otherwise stripped before
    // upstream, so forward JUST that one native preference (overriding the vault default) — this
    // makes claude.ai's OWN switch persist through the proxy without any custom handler, so
    // selecting Personal genuinely loads the Personal workspace (and clears a stale Team state).
    // Only a valid org UUID is honoured; auth/session cookies are never touched.
    if (TOOL_KEY === 'claude') {
      const lao = readBrowserCookie(req.headers.cookie, 'lastActiveOrg');
      if (lao && CLAUDE_ORG_RE.test(lao)) headers.cookie = mergeCookieHeaders(headers.cookie, 'lastActiveOrg=' + lao);
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

    // ── Claude token-quota tap (claude-only, mode-gated) ─────────────────────
    // Detect the Claude message-send request and extract ESTIMATED input char counts from the
    // body (never the text itself). In 'enforce' mode we gate the request on the backend quota
    // check BEFORE forwarding; in every mode we tap the streamed answer for output chars and
    // report settled usage. Wrapped so ANY failure fails OPEN and never breaks the proxy.
    const isClaudeCompletion = TOOL_KEY === 'claude' && QUOTA_MODE !== 'off'
      && !ctx.capture && !ctx.asset && quotaTap.isCompletionRequest(req.method, reqPathOnly);
    let quotaParts = null, quotaRequestId = null, quotaReserved = false;
    if (isClaudeCompletion) {
      try { quotaParts = quotaTap.extractRequestChars(bodyBuf); } catch (_) { quotaParts = null; }
      // Per-request idempotency key so a completed request is charged AT MOST once, even on an
      // accidental re-send (duplicate-charge guard is enforced server-side on this id). In enforce
      // mode the SAME id ties the pre-request reservation to its later settle/release.
      try { quotaRequestId = crypto.randomBytes(16).toString('hex'); } catch (_) { quotaRequestId = null; }
    }

    // ── Model allowlist enforcement (claude-only, request side) ──────────────
    // THE authoritative block. The picker is claude.ai's own React state, so hiding Fable 5 in
    // the UI stops an honest click and nothing else — a modified request, a replayed or cached
    // body, a direct call to the completion endpoint or a devtools fetch all bypass the UI.
    // Rewriting here, on the way upstream, is the one place that cannot be bypassed from the
    // browser. An existing conversation pinned to Fable 5 is therefore moved onto the fallback
    // on its very next request, which is what "safely switch on the next request" means.
    // Rewrites only ever go blocked -> fallback; no path here can emit a fable id.
    // Cost: a byte scan for "fable" on request bodies only; JSON.parse happens only on the rare
    // body that actually contains it. Fails OPEN — an unparseable body is forwarded untouched.
    // Effective setting: the ADMIN PANEL wins when the backend supplied one (it rides on the
    // /session response and refreshes with the 60s session cache), otherwise the CLAUDE_ALLOW_FABLE5
    // env var is the fallback — which also covers capture mode and any moment the backend is
    // unreachable. Both default to blocked, so no failure mode re-enables Fable 5.
    const allowFable5 = (session && typeof session.allowFable5 === 'boolean')
      ? session.allowFable5 : CLAUDE_ALLOW_FABLE5;
    let modelSwitchedFrom = null;
    if (TOOL_KEY === 'claude' && !allowFable5 && !ctx.capture && !ctx.asset && bodyBuf.length) {
      try {
        const pol = modelPolicy.applyToRequestBody(bodyBuf, { allowed: false, fallback: CLAUDE_FALLBACK_MODEL });
        if (pol.changed) {
          bodyBuf = pol.body;
          modelSwitchedFrom = pol.from;
          safeLog('model_blocked', {
            request_path: reqPathOnly,
            from_model: pol.from,               // a model id, not a secret
            to_model: CLAUDE_FALLBACK_MODEL,
            auto_switch_disabled: !!pol.autoSwitchDisabled,
            lease_id: ctx.jti || null,
          });
        }
      } catch (_) { /* policy failure must never break the proxy */ }
    }

    // ── Effort allowlist enforcement (claude-only, request side) ─────────────
    // Same reasoning as the model block above, and for the same reason it lives here: the picker
    // is claude.ai's own React state, so removing High/Extra/Max from the menu stops an honest
    // click and nothing else. A replayed body, a conversation already pinned to a higher level, or
    // a direct call to the completion endpoint all still ask for it. Rewriting on the way upstream
    // is the one place that cannot be bypassed from the browser — and it is also what makes a
    // saved "Opus Extra" conversation come back as "Opus Medium" on its very next request.
    // Fails OPEN on anything unrecognised: an effort vocabulary we cannot canonicalise is left
    // exactly as it is, because breaking a chat to enforce a preference is never the right trade.
    let effortSwitchedFrom = null;
    if (TOOL_KEY === 'claude' && !CLAUDE_ALLOW_ALL_EFFORTS && !ctx.capture && !ctx.asset && bodyBuf.length) {
      try {
        const eff = effortPolicy.applyToRequestBody(bodyBuf, { allowed: false });
        if (eff.changed) {
          bodyBuf = eff.body;
          effortSwitchedFrom = eff.from;
          safeLog('effort_blocked', {
            request_path: reqPathOnly,
            from_effort: eff.from,                       // a level name, not a secret
            to_effort: effortPolicy.DEFAULT_EFFORT,
            lease_id: ctx.jti || null,
          });
        }
      } catch (_) { /* policy failure must never break the proxy */ }
    }

    // How many times this navigation has already been re-sent after a Cloudflare challenge.
    // Lives OUTSIDE runDispatch so a retry can re-enter it with the same buffered body.
    let cfNavRetries = 0;
    // Which dispatch attempt is CURRENT. A Cloudflare retry abandons the previous upstream
    // response and starts a new one; the abandoned response's stream guards must not be able to
    // fail the (still healthy) request that replaced it. Every guard captures the generation it
    // belongs to and goes silent once it is no longer the live attempt.
    let dispatchGen = 0;
    const runDispatch = () => {
    const myGen = ++dispatchGen;
    const headers = buildUpstreamHeaders(req, upURL, session, minimal);
    // The rewrite above changes the body length, so the upstream must be told the new size or
    // it will hang waiting for bytes that never arrive (or truncate the JSON). If the client
    // sent the body CHUNKED there is no content-length to correct, and adding one while
    // `transfer-encoding: chunked` is still present is a framing conflict that a strict server
    // answers with 400 - so drop the chunked header whenever we set an explicit length.
    // BOTH policies (model and effort) can change the length, so both are checked here.
    if (modelSwitchedFrom !== null || effortSwitchedFrom !== null) {
      delete headers['transfer-encoding'];
      headers['content-length'] = Buffer.byteLength(bodyBuf);
    }

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

    // Same effective setting as the request-side block, hoisted so the response filter and the
    // overlay config agree with what was enforced on the way upstream.
    const allowFable5Eff = allowFable5;
    const upstream = upLib.request(`${upURL.origin}${effUpPath}`, { method: req.method, headers, agent: agentFor(upURL.origin) }, (uRes) => {
      const ct = String(uRes.headers['content-type'] || '');

      // ┌─ REGRESSION-SENSITIVE: the lifetime of a STREAMED response ────────────────────────────
      // │  The upstream has now STARTED responding, so the pre-response budget has done its job.
      // │  Disarm it: `upstream.setTimeout` is `socket.setTimeout`, an IDLE timer that otherwise
      // │  stays armed for the rest of the socket's life — including while the answer streams. A
      // │  quiet stretch longer than that budget (extended thinking, a tool call, writing a file)
      // │  destroyed the socket mid-answer, and the teardown path saw headers already sent and
      // │  called a bare `res.end()`. That hands the browser a CLEAN EOF in the middle of an SSE
      // │  stream — no terminating event, no error — which is indistinguishable from a finished
      // │  answer. That is the "response was interrupted" / stuck spinner / stuck "Creating file".
      // │
      // │  In its place: an idle budget that RESETS ON EVERY CHUNK, so a long answer is bounded by
      // │  SILENCE and never by total duration, plus a real failure path that terminates the
      // │  stream honestly. Do not merge these two budgets back together.
      const isSse = streamGuard.isEventStream(ct);
      try { upstream.setTimeout(0); } catch (_) {}
      let idleTimer = null, streamSettled = false;
      const clearIdle = () => { if (idleTimer) { clearTimeout(idleTimer); idleTimer = null; } };
      const settle = () => { streamSettled = true; clearIdle(); };
      const isCurrent = () => myGen === dispatchGen;
      const armIdle = () => {
        if (streamSettled) return;
        clearIdle();
        idleTimer = setTimeout(() => { idleTimer = null; onStreamBroken(streamGuard.CODES.STREAM_IDLE_TIMEOUT); }, STREAM_IDLE_TIMEOUT_MS);
      };
      // Ends a response whose headers are ALREADY on the wire. An SSE stream gets a terminating
      // error frame so the client stops its spinner and shows exactly ONE accurate message, and
      // keeps whatever it had already rendered. Before headers, the ordinary failure path still
      // owns the response (friendly retry page for a navigation, plain error for a fetch).
      function onStreamBroken(code) {
        if (streamSettled || !isCurrent()) return;
        settle();
        safeLog('stream_failed', {
          cid: ctx.cid || null, instance: INSTANCE_ID, request_path: reqPathOnly,
          error_code: code, is_sse: isSse, headers_sent: !!res.headersSent,
          device: deviceLabel(req), lease_id: ctx.jti || null,
          latency_ms: ctx.t0 ? (Date.now() - ctx.t0) : null,
        });
        try { uRes.destroy(); } catch (_) {}
        try { upstream.destroy(); } catch (_) {}
        if (!res.headersSent) { try { onUpstreamFail(); } catch (_) {} return; }
        try { if (isSse) res.write(streamGuard.sseErrorFrame(code)); } catch (_) {}
        try { res.end(); } catch (_) {}
      }
      uRes.on('error', (e) => onStreamBroken(streamGuard.classifyStreamError(e)));
      uRes.on('aborted', () => onStreamBroken(streamGuard.CODES.GATEWAY_RESTARTED));
      uRes.on('data', armIdle);
      uRes.on('end', settle);
      uRes.on('close', settle);
      // The browser going away must tear the upstream leg down at once. Without this a
      // backgrounded mobile tab leaves claude.ai streaming into a dead response, holding a
      // keep-alive pool slot until the idle budget expires — which starves later requests and
      // looks, from the client side, like the gateway hanging.
      res.on('close', () => {
        const finished = res.writableEnded;
        settle();
        if (!finished && isCurrent()) { try { uRes.destroy(); } catch (_) {} try { upstream.destroy(); } catch (_) {} }
      });
      armIdle();
      // └─ end stream lifetime guards ───────────────────────────────────────────────────────────
      // A file DOWNLOAD is content, not a page — it must reach the browser byte-for-byte.
      // Binary types (PDF/DOCX/XLSX/PPTX/images/ZIP) were already safe because they are
      // piped untouched, but a download whose type happens to be text-ish was not:
      //   • text/html  → took the isHtml branch and got the overlay, critical hide CSS and
      //                  URL rewriting injected INTO the saved file;
      //   • text/plain, application/json, application/xml → got upstream-URL rewriting,
      //                  silently altering the bytes the user downloaded.
      // Content-Disposition: attachment is the upstream saying "this is a file". Honour it:
      // no injection, no rewriting, no buffering — just stream it through with its own
      // headers (filename, type, length) intact. Inline/preview responses are untouched, so
      // preview, artifacts and the app's own JSON keep working exactly as before.
      const isAttachment = /(^|;|\s)attachment\b/i.test(String(uRes.headers['content-disposition'] || ''));
      const isHtml = ct.includes('text/html') && !isAttachment;
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
          cid: ctx.cid || null,
          instance: INSTANCE_ID,
          tool_code: TOOL_KEY,
          request_path: reqPathOnly,
          upstream_url: `${upURL.origin}${reqPathOnly}`,
          upstream_status: uRes.statusCode,
          content_type: ct.split(';')[0] || null,
          asset_rewrite_applied: !!asset_rewrite_applied,
          redirected_to_login: redirectedToLogin,
          // Redirect chain, PATH ONLY — the query string is dropped because a redirect target can
          // carry a one-time token. This is what makes a reload/redirect loop legible in the log
          // alongside cid + instance + latency, without ever recording a credential.
          redirect_to: (uRes.statusCode >= 300 && uRes.statusCode < 400 && rawLoc) ? String(rawLoc).split('?')[0].slice(0, 200) : null,
          cf_challenge: !!cfChallengeDetected,
          // WHICH Cloudflare clearance went upstream — booleans only, never a cookie value. This
          // is what distinguishes "the vault clearance was challenged" (an egress-IP/bot-score
          // problem, nothing in the request to fix) from "the browser's stale clearance displaced
          // the vault's" (a precedence problem). Presence, not content.
          cf_vault_clearance: !!(session && session.cookieHeader && /(^|;\s*)cf_clearance=/.test(session.cookieHeader)),
          cf_browser_clearance: /(^|;\s*)cf_clearance=/.test(String(req.headers.cookie || '')),
          upstream_error: (uRes.statusCode >= 500 ? 'upstream_5xx' : cfChallengeDetected ? 'cf_challenge' : uRes.statusCode === 403 ? 'forbidden' : uRes.statusCode === 429 ? 'rate_limited' : null),
          device: deviceLabel(req),
          device_signal: deviceOf(req).signal,
          cookies_attached: (session && session.cookieCount) || 0,
          is_nav: !!isHtmlNav,
          latency_ms: ctx.t0 ? (Date.now() - ctx.t0) : null,
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
      // ┌─ Fix B (mobile-only): break the loop's TAIL ───────────────────────────────────────────
      // /api/challenge_redirect is Claude's attempt to solve a challenge by NAVIGATING the whole
      // tab; through this proxy it can never clear, so don't retry it or show a notice — bounce
      // straight back to the app so the loop cannot form. Runs BEFORE the nav-retry block so a
      // mobile client never spends the 2 retry waits on this dead path. Desktop is untouched.
      if (cfChallengeDetected && isHtmlNav && CLAUDE_MOBILE_XHR_SHIELD && isMobileClient(req)
          && /^\/api\/challenge_redirect\b/.test(reqPathOnly) && !res.headersSent) {
        logIt(false); uRes.resume();
        safeLog('cf_redirect_break', {
          cid: ctx.cid || null, instance: INSTANCE_ID, request_path: reqPathOnly,
          device: deviceLabel(req), device_signal: deviceOf(req).signal, lease_id: ctx.jti || null,
        });
        // 204, NOT a redirect. A 302 here was still a full-page navigation: it tore down the
        // working Claude page, and if that fresh navigation was itself challenged (likely — the
        // challenge rate on this egress IP is what started the whole sequence) it spent the nav
        // retries and landed on the "asked us to verify the connection" notice roughly ten
        // seconds after a successful load. That is the reported mobile symptom, and the loop
        // breaker was feeding it.
        //
        // A 204 to a top-level navigation is defined to ABORT that navigation: the browser stays
        // exactly where it is. The app keeps running, the conversation and scroll position are
        // untouched, no reload happens, and the background fetch that triggered this simply
        // retries in place (Fix A already gives those a retryable JSON error). Nothing about the
        // challenge is solved, bypassed or automated — we decline to navigate the user into a
        // page that cannot clear through a reverse proxy.
        res.writeHead(204, { 'cache-control': 'no-store' });
        return res.end();
      }
      // └─ end Fix B ────────────────────────────────────────────────────────────────────────────
      // ┌─ REGRESSION-SENSITIVE: a Cloudflare challenge on a page navigation ─────────────────────
      // │
      // │  LIVE EVIDENCE (claude1 console.log, 2026-07-22, `device` finally legible): navigations
      // │  to /new alternate between 200 and a 403 challenge with the SAME 21 vault cookies, the
      // │  SAME pinned identity and the SAME device, minutes apart — 200,200 → 403,403 → 200,200 →
      // │  403,403,403. Nothing about the request changes between a success and a challenge. So
      // │  this is NOT a clearance/UA/fingerprint mismatch (the theory the earlier device-specific
      // │  fixes were built on, none of which even ran here — every request classifies as
      // │  'desktop'). It is Cloudflare transiently challenging this gateway's shared datacenter
      // │  egress IP, and it clears by itself on a later attempt.
      // │
      // │  1) RETRY. A challenged navigation is a TRANSIENT upstream condition, so re-send it
      // │     server-side after a short pause instead of surfacing it. This is an ordinary
      // │     retry of our own request — it does not solve, bypass, automate or weaken the
      // │     challenge, and it is deliberately bounded and nav-only so it cannot become a
      // │     hammer on an IP that is already being rate-limited.
      if (cfChallengeDetected && isHtmlNav && !ctx.asset && !isCaptchaReq && !ctx.capture
          && cfNavRetries < CF_NAV_RETRIES && !res.headersSent) {
        cfNavRetries += 1;
        logIt(false); uRes.resume();
        safeLog('cf_challenge_retry', {
          cid: ctx.cid || null, instance: INSTANCE_ID, request_path: reqPathOnly,
          upstream_status: uRes.statusCode, attempt: cfNavRetries, device: deviceLabel(req),
          latency_ms: ctx.t0 ? (Date.now() - ctx.t0) : null,
        });
        const wait = CF_NAV_RETRY_DELAY_MS * cfNavRetries;
        return setTimeout(() => { try { runDispatch(); } catch (_) { try { onUpstreamFail(); } catch (__) {} } }, wait);
      }
      // │  2) NEVER REPLAY THE CHALLENGE DOCUMENT. Once the retries are spent, serving Cloudflare's
      // │     real challenge page is what produces the reported failure: it refreshes ITSELF, so
      // │     the client sees the page reload three or four times and settle on the verification
      // │     screen. It can never clear, because the browser solving it is not the party making
      // │     the upstream request — the proxy is, from a different IP with a different TLS
      // │     fingerprint. Serve ONE recoverable notice with a MANUAL retry instead. This is
      // │     device-independent on purpose: the live log shows the failure has nothing to do
      // │     with mobile-vs-desktop, and gating it by device is exactly why earlier rounds
      // │     changed nothing. Kill-switch CLAUDE_CF_NAV_NOTICE=0 restores the raw passthrough.
      if (cfPassthrough && isHtmlNav && !ctx.asset && TOOL_KEY === 'claude' && CF_NAV_NOTICE) {
        logIt(false); uRes.resume();
        // Classify what ACTUALLY happened instead of collapsing every failure into one message.
        // "busy" is reserved for a confirmed upstream overload; a Cloudflare challenge is a
        // verification condition; and a challenge on a request that carried NO account clearance
        // is an account-session problem the operator has to fix — telling the client "busy" there
        // hides the one thing that would get it working again.
        const cls = classifyUpstreamFailure({
          status: uRes.statusCode, cfChallenge: true,
          vaultClearance: hasVaultClearance(session), retries: cfNavRetries,
        });
        safeLog('nav_failed', {
          cid: ctx.cid || null, instance: INSTANCE_ID, request_path: reqPathOnly,
          upstream_status: uRes.statusCode, error_code: cls.code, challenge_category: 'managed_challenge',
          device: deviceLabel(req), device_signal: deviceOf(req).signal,
          reload_reason: 'cf_challenge_nav', redirect_count: cfNavRetries, retries_spent: cfNavRetries,
          latency_ms: ctx.t0 ? (Date.now() - ctx.t0) : null, lease_id: ctx.jti || null,
        });
        return sendNoticePage(res, { status: cls.httpStatus, title: cls.title, msg: cls.msg });
      }
      // └─ end Cloudflare-challenge navigation handling ─────────────────────────────────────────
      // ┌─ Fix A (mobile-only): a Cloudflare challenge on an XHR/API fetch must NOT reach the app ─
      // Return a benign, NON-navigating transient error so Claude's SPA retries the call in place
      // instead of navigating the whole tab into the unsolvable /api/challenge_redirect loop. This
      // is the HEAD of the loop (Fix B above is the tail). Auth is untouched — the challenge is
      // never a login/session failure (redirected_to_login=false on 100% of these); we only refuse
      // to forward an unsolvable challenge DOCUMENT to a background fetch. Desktop never reaches here.
      if (cfChallengeDetected && !isHtmlNav && CLAUDE_MOBILE_XHR_SHIELD && isMobileClient(req) && !res.headersSent) {
        logIt(false); uRes.resume();
        safeLog('cf_xhr_shield', {
          cid: ctx.cid || null, instance: INSTANCE_ID, request_path: reqPathOnly,
          upstream_status: uRes.statusCode, device: deviceLabel(req), device_signal: deviceOf(req).signal,
          lease_id: ctx.jti || null,
        });
        res.writeHead(503, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
        return res.end(streamGuard.jsonErrorBody(streamGuard.CODES.CLOUDFLARE_CHALLENGE));
      }
      // └─ end Fix A ────────────────────────────────────────────────────────────────────────────
      // `device` lets us correlate a mobile-vs-desktop challenge outcome by lease id
      // without ever logging a cookie, token or the UA string itself.
      if (cfPassthrough) safeLog('cf_challenge_passthrough', { cid: ctx.cid || null, instance: INSTANCE_ID, request_path: reqPathOnly, upstream_status: uRes.statusCode, is_nav: !!isHtmlNav, device: deviceLabel(req), lease_id: ctx.jti || null });

      const outHeaders = {};
      for (const [k, v] of Object.entries(uRes.headers)) {
        const lk = k.toLowerCase();
        // content-length is stripped in general because injection/rewriting changes the body
        // length. An attachment is now passed through byte-for-byte, so its real length is
        // still correct and worth keeping: without it the download streams chunked with an
        // unknown size — no progress bar, and large files are markedly less reliable on iOS
        // Safari. If this response ends up compressed, pipeMaybeCompressed drops it again.
        if (lk === 'content-length' && isAttachment) { outHeaders[k] = v; continue; }
        if (STRIP_RESP_HEADERS.has(lk)) continue;
        if (k.toLowerCase() === 'set-cookie') { outHeaders[k] = rewriteSetCookie(v, ctx && ctx.capture); continue; }
        if (k.toLowerCase() === 'location' && typeof v === 'string') { outHeaders[k] = rewriteUpstreamUrls(v).text; continue; }
        outHeaders[k] = v;
      }

      const sanitizeJson = ctx.sanitizeBody && ct.includes('application/json') && !ct.includes('event-stream') && !ctx.capture && !isAttachment;
      // Never rewrite captcha JS/JSON bodies — Google's minified reCAPTCHA code must be
      // served byte-for-byte intact (the in-browser shim + co-rewrite handle routing) — and
      // never rewrite an attachment, which is a file the user is saving (see above).
      const rewriteText = isRewritableText(ct) && !isCaptchaReq && !isAttachment;

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
            html = injectOverlay(html, ctx.capture, session && session.accountLabel, allowFable5Eff);
            html = injectSessionBootstrap(html, session);
            // Client-side-auth SPA (WriteHuman): seed the vault's Supabase session cookies into
            // the browser so the in-browser SDK hydrates a logged-in app. Inserted before the
            // storage-reset call below so it EXECUTES AFTER the reset (last <head> insert runs
            // first), letting the reset clear stale localStorage without wiping this injector's
            // per-lease marker. Opt-in (SUPABASE_BROWSER_SESSION) → no-op for every other tool.
            html = injectSupabaseBrowserSession(html, session, ctx);
            html = injectCaptchaShim(html);
            // Last <head> insert → runs FIRST: wipe stale per-account browser storage for a
            // fresh lease BEFORE the bootstrap re-seeds vault storage and the app boots, so
            // an account switch can't be overridden by a previous account's cached token.
            html = injectStorageReset(html, ctx);
          }
          outHeaders['content-type'] = 'text/html; charset=utf-8';
          outHeaders['cache-control'] = 'no-store';
          logIt(rw.applied);
          endMaybeCompressed(req, res, uRes.statusCode || 200, outHeaders, html);
        });
      } else if (sanitizeJson || rewriteText) {
        const buf = [];
        uRes.on('data', c => buf.push(c));
        uRes.on('end', () => {
          let body = Buffer.concat(buf).toString('utf8');
          if (sanitizeJson) body = sanitizeJsonBody(body);
          // ── Model allowlist (response side) — this is the picker removal ──
          // The model list the picker renders comes down as JSON, so dropping the blocked
          // entries here is what makes Fable 5 absent from the client-facing picker, for every
          // client, without patching claude.ai's bundle. Any lingering scalar still naming the
          // blocked model is rewritten to the fallback so a conversation previously on Fable 5
          // renders as the fallback rather than an unknown/blank model. Every other model is
          // passed through untouched. Attachments never reach this branch (isAttachment above),
          // so a downloaded file that merely mentions the word is never altered.
          if (TOOL_KEY === 'claude' && !allowFable5Eff && !ctx.asset && !isCaptchaReq) {
            try {
              const pol = modelPolicy.applyToResponseBody(body, { allowed: false, fallback: CLAUDE_FALLBACK_MODEL });
              if (pol.changed) { body = pol.text; safeLog('model_filtered', { request_path: reqPathOnly }); }
            } catch (_) { /* filtering failure must never break the app */ }
          }
          // ── Effort allowlist (response side) — this is the picker removal ──
          // The selectable effort levels come down as JSON, so dropping the blocked entries here
          // is what makes High/Extra/Max absent from the client-facing picker without patching
          // claude.ai's bundle — and, because it runs on EVERY such response, an upstream metadata
          // refresh cannot quietly restore them later in the session. A scalar still naming a
          // blocked level is rewritten to Medium, so a conversation saved at a higher level
          // REOPENS as Medium instead of showing a level it is no longer allowed to use.
          if (TOOL_KEY === 'claude' && !CLAUDE_ALLOW_ALL_EFFORTS && !ctx.asset && !isCaptchaReq) {
            try {
              const eff = effortPolicy.applyToResponseBody(body, { allowed: false });
              if (eff.changed) { body = eff.text; safeLog('effort_filtered', { request_path: reqPathOnly, options_removed: !!eff.optionsRemoved }); }
            } catch (_) { /* filtering failure must never break the app */ }
          }
          const rw = rewriteUpstreamUrls(body); body = rw.text;
          if (sanitizeJson) outHeaders['cache-control'] = 'no-store';
          logIt(rw.applied);
          endMaybeCompressed(req, res, uRes.statusCode || 200, outHeaders, body);
        });
      } else {
        logIt(false);
        // Claude quota tap: count the streamed answer's output chars WITHOUT buffering or
        // altering it (a passive 'data' listener coexists with pipe), then report settled usage
        // on stream end. Only for the completion response; fully fail-safe (never affects the
        // stream the client receives).
        if (isClaudeCompletion) {
          try {
            const counter = new quotaTap.SseCounter();
            uRes.on('data', (c) => { try { counter.write(c); } catch (_) {} });
            uRes.on('end', () => {
              try {
                const outputChars = counter.end();
                if (ctx.token) gatewayApiPost('/usage-report', ctx.token, Object.assign({}, quotaParts || {}, { outputChars, requestId: quotaRequestId })).catch(() => {});
              } catch (_) {}
            });
          } catch (_) { /* tap failure must never affect the response */ }
        }
        // The tap above listens on uRes, i.e. BEFORE compression, so usage counts are
        // unaffected. SSE/streaming content types are never compressed (see isCompressible).
        pipeMaybeCompressed(req, res, uRes.statusCode || 200, outHeaders, uRes);
      }
    });
    // Upstream failure / timeout handling: never hang the browser on a dead or slow
    // upstream. A main page navigation gets a friendly retry page (not a blank screen
    // or bare error); asset/API requests get a plain 502 the browser can handle.
    const onUpstreamFail = () => {
      // A reserved request that never reached Claude must free its held quota immediately (don't
      // wait for the TTL). Idempotent + fail-safe on the backend.
      if (quotaReserved && ctx.token && quotaRequestId) {
        try { gatewayApiPost('/quota-release', ctx.token, { requestId: quotaRequestId }).catch(() => {}); } catch (_) {}
        quotaReserved = false;
      }
      if (res.headersSent) { try { res.end(); } catch (_) {} return; }
      if (isHtmlNav && !ctx.asset && !isCaptchaReq && !ctx.capture) {
        return sendNoticePage(res, {
          status: 502,
          title: `${TOOL_NAME} is unavailable right now`,
          msg: `We couldn't reach ${TOOL_NAME}. This is usually temporary — please try again in a moment.`,
        });
      }
      // A BACKGROUND request gets a structured, machine-readable body — never an HTML document.
      // Handing an error PAGE to a fetch is what makes Claude's app treat a transient blip as a
      // reason to navigate the whole tab, which is how a working page ends up on an error screen.
      // `retryable` says plainly that the caller may try again; nothing here ends a session.
      res.writeHead(502, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
      res.end(streamGuard.jsonErrorBody(streamGuard.CODES.UPSTREAM_UNAVAILABLE));
    };
    // PRE-RESPONSE budget ONLY. The response callback disarms this the moment upstream headers
    // arrive and hands over to the chunk-resetting idle budget — see the stream lifetime guards.
    // Leaving it armed is what used to cut long answers off mid-stream.
    upstream.setTimeout(UPSTREAM_TIMEOUT_MS, () => { try { upstream.destroy(new Error('upstream_timeout')); } catch (_) {} });
    upstream.on('error', onUpstreamFail);
    upstream.end(bodyBuf);
    }; // end runDispatch

    // Enforce mode ONLY: ask the backend whether this message fits the client + shared-account
    // allowance before forwarding. Fail-OPEN — any error/timeout/non-ok just dispatches, so a
    // metering hiccup never blocks a real Claude message. In 'count'/'off' modes we dispatch
    // immediately (measurement happens on the response side).
    if (isClaudeCompletion && QUOTA_MODE === 'enforce' && ctx.token) {
      // Reserve + strict check on the backend BEFORE forwarding. A blocked request returns 429 and
      // is NEVER sent to Claude. An allowed request holds a reservation (settled by /usage-report
      // on stream end, or released by onUpstreamFail below if the upstream dies).
      gatewayApiPost('/quota-precheck', ctx.token, Object.assign({}, quotaParts || {}, { requestId: quotaRequestId })).then((r) => {
        const b = (r && r.body) || {};
        if (b.ok === true && b.allowed === false) {
          safeLog('quota_block', { request_path: reqPathOnly, reason: (b.usage && b.usage.reason) || null });
          return sendQuotaBlock(res, b);
        }
        quotaReserved = (b.ok === true && b.reserved === true);
        if (quotaReserved) {
          // Catch-all so a reservation is NEVER held past the request: the streaming branch settles
          // via /usage-report on stream end (which records real usage), but a NON-streaming
          // completion response (e.g. a JSON error from Claude) or a mid-stream client abort never
          // reaches that settle. `close` fires in every case when the client response finishes/aborts
          // → release the (by then usually already-settled → no-op) reservation. Never double-charges.
          res.once('close', function () {
            if (quotaReserved && ctx.token && quotaRequestId) { quotaReserved = false; try { gatewayApiPost('/quota-release', ctx.token, { requestId: quotaRequestId }).catch(function () {}); } catch (e) {} }
          });
        }
        runDispatch();
      }).catch(() => runDispatch());
    } else {
      runDispatch();
    }
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
  // Per-request correlation id + start clock for safe startup-timing diagnostics.
  const cid = crypto.randomBytes(6).toString('hex');
  const reqT0 = Date.now();
  // REGRESSION-SENSITIVE: pin the CLIENT's real device class here, from the untouched inbound
  // headers, before any handler can rewrite one. Everything downstream reads this snapshot, so
  // the upstream compatibility headers we later choose can never feed back into the
  // classification. `device_signal` records WHICH input decided it, which is what makes a
  // "real phone logged as desktop" report diagnosable instead of a guess.
  req.__genzDevice = classifyDevice(req.headers);

  if (pathName === '/__genz/overlay.js') {
    // PERF: was no-cache → revalidated on EVERY navigation. Content-addressed (?v=<hash>)
    // and immutable now, so a nav costs zero requests while a deploy busts the URL.
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
        // Boolean only (no secret): lets a deploy be verified externally — confirms the
        // client-side Supabase session injection is live on WriteHuman and OFF on the rest.
        supabaseBrowserSession: SUPABASE_BROWSER_SESSION,
      },
      missingEnv,
    };
    // ── Mobile-critical invariants (claude only) ──────────────────────────────
    // These three env flags + a writable durable store are what keep Claude working on mobile
    // WITHOUT the recurring Cloudflare verification loop. They are configured server-side in this
    // gateway's .htaccess (NOT in the repo), so a redeploy or a hand-edit can silently flip one
    // and the mobile fix quietly regresses while the repo tests stay green and health stays 200.
    // Expose them here (booleans only — no secret) so a deploy/monitoring check catches the drift
    // immediately. `mobileReady` is false when any is wrong; it does NOT force health to 503 (these
    // have documented kill-switches, and a restart loop would be worse than the warning).
    if (TOOL_KEY === 'claude') {
      const inv = claudeMobileInvariants();
      body.claudeMobile = Object.assign({ mobileReady: inv.every(i => i.ok) },
        inv.reduce((o, i) => { o[i.key] = i.value; return o; }, {}));
      // How THIS request was classified, and which header decided it. Reflects only the caller's
      // own request, contains no secret, and is the fastest way to answer "is my phone actually
      // being seen as a phone?" — open this URL on the device itself. It is also how we can prove
      // whether a hosting hop between the browser and Node is stripping or rewriting the client
      // hints, which is otherwise invisible.
      const d = classifyDevice(req.headers);
      body.client = { device: d.mobile ? 'mobile' : 'desktop', signal: d.signal };
    }
    res.writeHead(missingEnv.length ? 503 : 200, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
    return res.end(JSON.stringify(body));
  }

  // ── Service workers are never allowed on this origin (CLAUDE ONLY) ──────────
  // A worker registered by the proxied app is scoped to the GATEWAY origin and serves
  // navigations out of its own Cache Storage. Once it has cached a "session ended" page it
  // replays that document on every later visit — including the /gateway?lease=<NEW> launch —
  // so the request never reaches this server, the fresh session cookie is never set, and no
  // server-side change can dislodge it. Cache Storage also survives clearing cookies, which
  // is why the expired screen came back after a restart. Phones are hit hardest: mobile
  // browsers install and retain workers far more readily than desktop.
  //
  // The overlay already unregisters workers and blocks navigator.serviceWorker.register for
  // Claude, so Claude is designed to run with no worker here — but that code only runs on a
  // page the worker still lets through. Refusing the SCRIPT closes the loop: a new
  // registration can never install, and an existing registration's update check gets a 404,
  // which makes the browser drop the registration on its own.
  if (TOOL_KEY === 'claude'
      && (String(req.headers['sec-fetch-dest'] || '') === 'serviceworker'
          || req.headers['service-worker'] === 'script'
          || /^\/(sw|service-?worker|firebase-messaging-sw)[\w.-]*\.js$/i.test(pathName)
          || /^\/workbox-[\w.-]+\.js$/i.test(pathName))) {
    safeLog('service_worker_blocked', { request_path: pathName });
    res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store' });
    return res.end('Not found');
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
    const token = resolveLeaseToken(req);
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

  // ── Entry point (preferred): one-time POST launch bootstrap ─────────────────
  // The dashboard submits a hidden form here with a single-use `code` in the BODY. We redeem
  // it once, server-to-server, install the opaque HttpOnly session and 303 to the clean tool
  // URL. Compared to /gateway?lease=<JWT> this removes the credential from the address bar,
  // browser history, the Referer header and every access log on the path — and the code is
  // dead the instant it is used, so a captured request body cannot be replayed.
  //
  // 303 (not 302) is deliberate: it forces the follow-up to be a GET of the landing page. A
  // 302 leaves the method up to the browser, and a POST replayed onto the tool root is both
  // wrong and re-submittable from history.
  if (pathName === '/launch') {
    const launchHeaders = { 'cache-control': 'no-store', 'referrer-policy': 'no-referrer' };
    if (req.method !== 'POST') {
      // A GET here means someone reached for /launch as a URL — which is exactly the habit
      // this endpoint exists to remove. Never treat it as a launch.
      res.writeHead(405, Object.assign({ 'content-type': 'text/plain; charset=utf-8', 'allow': 'POST' }, launchHeaders));
      return res.end('Method Not Allowed');
    }
    const body = await readLaunchBody(req);
    const code = body && typeof body.code === 'string' ? body.code.trim() : '';
    if (!code) { safeLog('launch_reject', { reason: 'code_missing' }); return sendBlockPage(res, 'lease_missing'); }

    const r = await redeemLaunchCode(code); // the code is NEVER logged, here or in backendPost
    if (!(r.status === 200 && r.body && r.body.ok && r.body.lease)) {
      const code0 = (r.body && r.body.code) || (r.status === 0 ? 'unavailable' : 'lease_invalid');
      // `failure_code`, not `code` — this is the backend's error code (launch_code_used, …).
      // Naming it `code` here would read, to anyone auditing the logs, as the launch code
      // itself. The launch code is never logged, in any field, anywhere.
      safeLog('launch_reject', { upstream_status: r.status, failure_code: code0 });
      // launch_code_* codes mean "this launch is spent or stale" — the user's fix is the same
      // as an expired lease: reopen from the dashboard. Map them onto that message rather
      // than inventing a new screen.
      const shown = /^launch_code_/.test(String(code0)) ? 'lease_expired' : code0;
      return sendBlockPage(res, shown);
    }

    const token = r.body.lease;
    const payload = verifyLeaseLocal(token);
    if (payload === null) { safeLog('launch_reject', { reason: 'lease_unverifiable' }); return sendBlockPage(res, 'lease_invalid'); }

    const landing = payload.cap ? SIGNIN_PATH : DEFAULT_PATH;
    const sid = claudeCreateSession(token, payload);
    const maxAge = Math.floor(((payload.exp ? payload.exp * 1000 : Date.now() + 1800000) - Date.now()) / 1000);
    safeLog('launch_ok', { jti: payload.jti, cap: !!payload.cap, seconds: maxAge }); // no code, sid or JWT
    res.writeHead(303, Object.assign({
      // Opaque session only. Also clears any legacy readable pg_lease a previous build left.
      'set-cookie': [claudeSessionCookie(sid, maxAge), `${LEASE_COOKIE}=; Path=/; Max-Age=0; SameSite=Lax`],
      'location': landing,
    }, launchHeaders));
    return res.end();
  }

  // ── Entry point (legacy, feature-flagged): lease in the URL ─────────────────
  // Retained ONLY so a backend rollback to LAUNCH_FLOW=url works without redeploying this
  // gateway. Set ALLOW_URL_LEASE=0 to close it once the POST flow is verified.
  if (pathName === '/gateway') {
    if (!ALLOW_URL_LEASE) {
      safeLog('url_lease_disabled', { request_path: pathName });
      return sendBlockPage(res, 'lease_missing');
    }
    const token = u.searchParams.get('lease');
    if (!token) return sendBlockPage(res, 'lease_missing');
    // Claude: exchange the one-time lease JWT (in the URL) for an OPAQUE server-side session.
    // The JWT is stored server-side and NEVER written to the browser; the browser gets only the
    // random __Host-claude_session token. A fresh sid per open = session-fixation safe.
    if (TOOL_KEY === 'claude') {
      const payload = verifyLeaseLocal(token);
      if (payload === null) return sendBlockPage(res, 'lease_invalid');
      const landing = payload.cap ? SIGNIN_PATH : DEFAULT_PATH;
      const sid = claudeCreateSession(token, payload);
      const maxAge = Math.floor(((payload.exp ? payload.exp * 1000 : Date.now() + 1800000) - Date.now()) / 1000);
      safeLog('session_open', { jti: payload.jti, cap: !!payload.cap }); // opaque sid + JWT never logged
      res.writeHead(302, {
        // Set the opaque session AND proactively clear any legacy readable pg_lease cookie a
        // previous build may have left in the browser (host-only expiry).
        'set-cookie': [claudeSessionCookie(sid, maxAge), `${LEASE_COOKIE}=; Path=/; Max-Age=0; SameSite=Lax`],
        'location': landing, 'cache-control': 'no-store', 'referrer-policy': 'no-referrer',
      });
      return res.end();
    }
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

  // Claude resolves the lease JWT from the OPAQUE server-side session (via __Host-claude_session);
  // every other tool reads the pg_lease cookie unchanged. Keep the session ref so an invalid lease
  // (admin revoke / expiry) also revokes the opaque session.
  const claudeSess = (TOOL_KEY === 'claude') ? claudeGetSession(req) : null;
  const token = (TOOL_KEY === 'claude') ? (claudeSess ? claudeSess.jwt : null) : getLease(req);
  // The overlay's own XHR endpoints must always answer in JSON. Falling through to the HTML
  // block page here made `fetch(...).json()` fail, which the overlay (correctly) cannot read
  // as a verdict — so an expired session was classified RETRYABLE and the widget sat on
  // "Connection interrupted — retrying…" instead of stating plainly that the session ended.
  // Answer the contract explicitly, and expire the dead opaque cookie on the way out.
  if (TOOL_KEY === 'claude' && !token && (pathName === '/__genz/validate' || pathName === '/__genz/usage')) {
    const jsonHeaders = { 'content-type': 'application/json', 'cache-control': 'no-store', 'set-cookie': claudeExpireCookie() };
    res.writeHead(200, jsonHeaders);
    return res.end(pathName === '/__genz/usage'
      ? JSON.stringify({ ok: true, enabled: true, synced: false })
      : JSON.stringify({ valid: false, terminal: true, retryable: false, code: 'lease_missing' }));
  }
  if (!token) return sendBlockPage(res, 'lease_missing');

  const local = verifyLeaseLocal(token);
  if (local === null) { if (claudeSess) claudeRevoke(claudeSess.sid); return sendBlockPage(res, 'lease_invalid'); }
  const capture = !!(local && local.cap);

  // Claude: overlay session/lease check. The browser holds ONLY the opaque HttpOnly session
  // cookie (it cannot read the JWT), so the overlay calls THIS same-origin endpoint instead of the
  // backend directly. We validate the server-side JWT with the backend and return ONLY
  // {valid, secondsRemaining} — no token/claims. Rotate the opaque sid periodically (session-
  // fixation defence) and revoke + clear the cookie on an invalid/expired/revoked lease.
  if (pathName === '/__genz/validate') {
    if (TOOL_KEY !== 'claude') { res.writeHead(404, { 'content-type': 'application/json', 'cache-control': 'no-store' }); return res.end('{"valid":false}'); }
    // LOAD: the overlay polls this every 30s per open tab, and each poll used to be its own
    // backend round-trip even when a navigation had just validated the same lease. Share the
    // nav path's short cache instead: only CONFIRMED-valid results are cached (failures never
    // are), so revocation stays as prompt as it already is for navigations, and the countdown
    // is anchored to the absolute expiresAt rather than the relative count, so a few seconds
    // of staleness cannot affect it.
    const r = await backendValidateCached(token, local && local.jti);
    const headers = { 'content-type': 'application/json', 'cache-control': 'no-store' };
    let out;
    if (r.status === 200 && r.body && r.body.valid) {
      // Relay the ABSOLUTE server-issued deadline, not just the relative countdown. The
      // overlay anchors to `expiresAt` (corrected by `serverTime`), so a resumed mobile tab
      // re-anchors to the NEW lease's expiry instead of carrying a stale local counter.
      // Still no token/claims — these two fields are timestamps, not credentials.
      out = {
        valid: true,
        secondsRemaining: r.body.secondsRemaining || 0,
        expiresAt: r.body.expiresAt || null,
        serverTime: r.body.serverTime || new Date().toISOString(),
      };
      if (claudeSess && Date.now() - claudeSess.rotatedAt > 600000) {
        const nsid = claudeRotate(claudeSess.sid); const s = nsid && claudeSessions.get(nsid);
        if (s) headers['set-cookie'] = claudeSessionCookie(nsid, Math.floor((s.exp - Date.now()) / 1000));
      }
    } else {
      // A transient backend failure must NOT destroy a valid session. Previously ANY non-200
      // — including status 0 (network error / the 8s timeout) — revoked the opaque session and
      // cleared the cookie, so one backend blip permanently killed a live lease and no amount
      // of client-side retrying could recover it. Only a CONFIRMED authorization denial from
      // the backend revokes now; everything else is reported as retryable and the session is
      // left intact for the overlay to retry against. Enforcement is unchanged: the backend is
      // still the source of truth, and every terminal code below still revokes immediately.
      const code = (r.body && r.body.code) || null;
      const terminal = (r.body && typeof r.body.terminal === 'boolean')
        ? r.body.terminal
        : CLAUDE_TERMINAL_CODES.has(String(code || ''));
      if (terminal) {
        if (claudeSess) claudeRevoke(claudeSess.sid);
        headers['set-cookie'] = claudeExpireCookie();
        out = { valid: false, terminal: true, retryable: false, code: code || 'lease_invalid' };
      } else {
        out = { valid: false, terminal: false, retryable: true, code: code || 'backend_unavailable' };
      }
      safeLog('validate-fail', { upstream_status: r.status, code: out.code, terminal: out.terminal });
    }
    res.writeHead(200, headers);
    return res.end(JSON.stringify(out));
  }

  // Claude: READ-ONLY estimated usage snapshot for the overlay widget. The browser holds only
  // the opaque HttpOnly session cookie, so the overlay calls THIS same-origin endpoint (cookie
  // sent automatically) and we relay to the backend with the server-side lease + gateway key.
  // Returns ONLY the client-safe usage figures (never a token/account id). Never records.
  if (pathName === '/__genz/usage') {
    if (TOOL_KEY !== 'claude') { res.writeHead(404, { 'content-type': 'application/json', 'cache-control': 'no-store' }); return res.end('{"ok":false}'); }
    const r = await gatewayApiPost('/quota-status', token, {});
    const headers = { 'content-type': 'application/json', 'cache-control': 'no-store' };
    // On any transport failure (status 0) the widget must show "Not synced", never a made-up 0.
    const out = (r.status === 200 && r.body && r.body.ok) ? r.body : { ok: true, enabled: true, synced: false };
    res.writeHead(200, headers);
    return res.end(JSON.stringify(out));
  }

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
  // Kick off the account-session fetch NOW so it runs CONCURRENTLY with backend validation
  // instead of after it. These were sequential (validate → then session), stacking two
  // up-to-8s waits into the ~15s cold load; run in parallel the nav pays max(one), not sum.
  const sessionP = capture ? Promise.resolve({ noAccount: true, capture: true }) : getSession(token, local && local.jti);
  if (isHtmlNav && !capture) {
    // Cached + deduped: a recent CONFIRMED-valid result is reused for a few seconds and
    // simultaneous navs share one round-trip; failures are never cached (revocation stays
    // prompt). We do not wait the full 8s when a valid result is already known.
    const v = await backendValidateCached(token, local && local.jti);
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

  // Await the session fetch started concurrently above (already in flight during validate).
  const session = await sessionP;
  // A CONFIRMED vault-account denial is terminal — unchanged.
  if (!capture && session && session.blocked) return sendBlockPage(res, session.code || 'account_no_session');
  // A TRANSIENT vault-fetch failure is NOT. The lease is untouched, the account is untouched and
  // the next attempt will very likely succeed, so nothing here may set a terminal state: no 403
  // block page, no expired session cookie, no Clear-Site-Data. A navigation gets the recoverable
  // notice with a MANUAL retry (the same page a transient upstream failure already uses); a
  // background fetch gets a small non-navigating 503 JSON, so the app retries the call in place
  // instead of reacting to an HTML error document by navigating the whole tab.
  if (!capture && session && session.transient) {
    safeLog('account_session_transient', {
      cid, instance: INSTANCE_ID, request_path: pathName, code: session.code,
      upstream_status: session.upstreamStatus, device: deviceLabel(req),
      is_nav: !!isHtmlNav, lease_id: local && local.jti,
    });
    if (isHtmlNav) {
      return sendNoticePage(res, {
        status: 503,
        title: `${TOOL_NAME} is reconnecting`,
        msg: `We could not reach the Gen Z session service for a moment. Your access is still active — please try again.`,
      });
    }
    res.writeHead(503, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
    return res.end('{"error":"session_unavailable","retryable":true}');
  }

  // Safe startup-timing diagnostic — correlation id + stage total + which worker + whether
  // the session had to be rehydrated from the durable store (the old failure mode) + device.
  // Cookie PRESENCE only; never a cookie value, lease, session or credential.
  if (isHtmlNav) {
    safeLog('nav_timing', {
      cid, instance: INSTANCE_ID, request_path: pathName,
      device: deviceLabel(req),
      device_signal: deviceOf(req).signal,
      session_source: (claudeSess && claudeSess.source) || 'memory',
      has_session_cookie: !!(claudeSess),
      resolve_ms: Date.now() - reqT0,
    });
  }
  return proxy(req, res, isHtmlNav, session, { token, jti: local && local.jti, capture, sanitizeBody, cid, t0: reqT0 });
});

server.listen(PORT, () => {
  console.log(`${TOOL_NAME} proxy gateway listening on :${PORT}`);
  console.log(`  tool      -> ${TOOL_KEY}`);
  console.log(`  proxying  -> ${TARGET_ORIGIN}`);
  console.log(`  api base  -> ${API_BASE}`);
  // Fail LOUD (not fatal) if a mobile-critical invariant has drifted — this is what stops the
  // Cloudflare-verification-on-mobile bug from silently returning after a redeploy/.htaccess edit.
  if (TOOL_KEY === 'claude') {
    const bad = claudeMobileInvariants().filter(i => !i.ok);
    if (bad.length) {
      console.warn('  ⚠ MOBILE CONFIG DRIFT — Claude may loop on Cloudflare verification on phones:');
      for (const i of bad) console.warn(`      ${i.key} = ${JSON.stringify(i.value)} (expected the mobile-safe value)`);
      console.warn('      See /__genz/health .claudeMobile and claude-gateway/README.md before granting mobile clients.');
    } else {
      console.log('  mobile    -> OK (cf passthrough + honest per-device identity + durable session store)');
    }
  }
});
