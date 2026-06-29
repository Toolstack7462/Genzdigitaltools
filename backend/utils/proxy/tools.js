'use strict';
/**
 * Proxy-Tools registry — the SINGLE source of truth for which extra tools are
 * served through their own reverse-proxy gateway (HIX AI, BypassGPT). This module
 * is fully isolated from StealthWriter and from the existing Tool/ToolAssignment
 * system: it only describes the proxy tools and reads their per-tool env config.
 *
 * Each tool keeps its OWN encrypted cookie vault (ProxyAccount rows are tagged with
 * `tool`), its OWN gateway origin and its OWN target origin. No usage metering and
 * no daily limits are applied here.
 */

const TOOLS = {
  hix: {
    key: 'hix',
    name: 'HIX AI',
    category: 'AI',
    tagline: 'AI Humanizer & Detector',
    // Config (env first, sane defaults second).
    targetOriginEnv: 'HIX_TARGET_ORIGIN',
    defaultTargetOrigin: 'https://hix.ai',
    gatewayUrlEnv: 'HIX_GATEWAY_URL',
    defaultGatewayUrl: 'https://hix1.genzdigitalstore.com',
    defaultPathEnv: 'HIX_DEFAULT_PATH',
    defaultPath: '/app/bypass-ai-detection/dashboard',
    // Sign-in path used by the server-side account verifier.
    verifyPathEnv: 'HIX_VERIFY_PATH',
  },
  bypassgpt: {
    key: 'bypassgpt',
    name: 'BypassGPT',
    category: 'AI',
    tagline: 'Undetectable AI Humanizer',
    targetOriginEnv: 'BYPASSGPT_TARGET_ORIGIN',
    defaultTargetOrigin: 'https://www.bypassgpt.ai',
    gatewayUrlEnv: 'BYPASSGPT_GATEWAY_URL',
    defaultGatewayUrl: 'https://bypassgpt1.genzdigitalstore.com',
    defaultPathEnv: 'BYPASSGPT_DEFAULT_PATH',
    defaultPath: '/ai-humanizer',
    verifyPathEnv: 'BYPASSGPT_VERIFY_PATH',
  },
  chatgpt: {
    key: 'chatgpt',
    name: 'ChatGPT',
    category: 'AI',
    tagline: 'OpenAI ChatGPT',
    targetOriginEnv: 'CHATGPT_TARGET_ORIGIN',
    defaultTargetOrigin: 'https://chatgpt.com',
    gatewayUrlEnv: 'CHATGPT_GATEWAY_URL',
    defaultGatewayUrl: 'https://chatgpt1.genzdigitalstore.com',
    defaultPathEnv: 'CHATGPT_DEFAULT_PATH',
    defaultPath: '/',
    verifyPathEnv: 'CHATGPT_VERIFY_PATH',
  },
  ryne: {
    key: 'ryne',
    name: 'Ryne AI',
    category: 'AI',
    tagline: 'AI Essay Writer & Humanizer',
    targetOriginEnv: 'RYNE_TARGET_ORIGIN',
    defaultTargetOrigin: 'https://ryne.ai',
    gatewayUrlEnv: 'RYNE_GATEWAY_URL',
    defaultGatewayUrl: 'https://ryne1.genzdigitalstore.com',
    defaultPathEnv: 'RYNE_DEFAULT_PATH',
    defaultPath: '/',
    verifyPathEnv: 'RYNE_VERIFY_PATH',
    // Ryne's logged-out state is its marketing page served at '/' with HTTP 200 (no
    // redirect to /sign-in), so a dead session can't be detected by status/redirect
    // alone. Opt this tool into the content-based logged-out heuristic (see verify.js).
    detectLoggedOut: true,
  },
  writehuman: {
    key: 'writehuman',
    name: 'WriteHuman',
    category: 'AI',
    tagline: 'Undetectable AI Humanizer',
    targetOriginEnv: 'WRITEHUMAN_TARGET_ORIGIN',
    defaultTargetOrigin: 'https://writehuman.ai',
    gatewayUrlEnv: 'WRITEHUMAN_GATEWAY_URL',
    defaultGatewayUrl: 'https://writehuman1.genzdigitalstore.com',
    defaultPathEnv: 'WRITEHUMAN_DEFAULT_PATH',
    defaultPath: '/',
    verifyPathEnv: 'WRITEHUMAN_VERIFY_PATH',
    // WriteHuman authenticates with Supabase. Its session cookie (`sb-<ref>-auth-token`,
    // sometimes split into `.0`/`.1` chunks) carries a SHORT-LIVED access-token JWT (~1h) and
    // a LONG-LIVED refresh token; the app mints a fresh session from the refresh token on
    // load. So "can these cookies log in?" is decided by the REFRESH TOKEN — NOT by an HTML
    // page (the client-hydrated shell always looks logged-out) and NOT by an app/JSON route
    // that only validates the access token (an aged-out-but-refreshable session would falsely
    // read as expired). verify therefore exchanges the refresh token at Supabase's own token
    // endpoint — the exact call the app makes: 200 = a live, refreshable session → working;
    // 400/401 = truly invalid → session_expired. Cookie-only; no email/password login.
    verifyMode: 'supabase_refresh',
    supabase: {
      projectRef: 'hicfsbrfkzsxbwayibfm',
      urlEnv: 'WRITEHUMAN_SUPABASE_URL',
      defaultUrl: 'https://hicfsbrfkzsxbwayibfm.supabase.co',
      // PUBLIC anon apikey (the same key WriteHuman ships to every browser; required by the
      // Supabase token endpoint). Not a secret and never sent to our frontend or logged.
      // Overridable via env if WriteHuman ever rotates it.
      anonKeyEnv: 'WRITEHUMAN_SUPABASE_ANON_KEY',
      defaultAnonKey: 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImhpY2ZzYnJma3pzeGJ3YXlpYmZtIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzMwMzE4MDgsImV4cCI6MjA4ODYwNzgwOH0.8vN4qjWB6aBGHuz7ixzoLRrMgKO3Lnc-Vmm2SjbW9n0',
    },
    // NOTE: the content-based logged-out heuristic (detectLoggedOut) is intentionally NOT
    // used for WriteHuman — it misfires on this client-hydrated SPA. The supabase_refresh
    // verify above (and, on the gateway, DETECT_LOGGED_OUT=0) is the authoritative signal.
  },
  grok: {
    key: 'grok',
    name: 'Grok',
    category: 'AI',
    tagline: 'xAI Grok Assistant',
    // grok.com is the standalone, cookie-session web app (separate from x.com/i/grok).
    // It sits behind Cloudflare; the gateway already handles cf_clearance/UA pinning and
    // renders real Turnstile/captcha challenges for the user to solve manually.
    targetOriginEnv: 'GROK_TARGET_ORIGIN',
    defaultTargetOrigin: 'https://grok.com',
    gatewayUrlEnv: 'GROK_GATEWAY_URL',
    defaultGatewayUrl: 'https://grok1.genzdigitalstore.com',
    defaultPathEnv: 'GROK_DEFAULT_PATH',
    defaultPath: '/chat', // logged-in chat surface (verify against the live app at deploy)
    verifyPathEnv: 'GROK_VERIFY_PATH',
    // Per-tool session-length override (minutes). Falls back to PROXY_LEASE_MINUTES, then 30.
    leaseMinutesEnv: 'GROK_LEASE_MINUTES',
  },
};

const TOOL_KEYS = Object.keys(TOOLS);

function isValidTool(tool) {
  return Object.prototype.hasOwnProperty.call(TOOLS, String(tool || ''));
}

function getTool(tool) {
  return TOOLS[String(tool || '')] || null;
}

function stripSlash(s) { return String(s || '').replace(/\/+$/, ''); }

function targetOrigin(tool) {
  const t = getTool(tool); if (!t) return '';
  return stripSlash(process.env[t.targetOriginEnv] || t.defaultTargetOrigin);
}

function targetHost(tool) {
  try { return new URL(targetOrigin(tool)).hostname; } catch (_) { return ''; }
}

// Public gateway base, e.g. https://hix1.genzdigitalstore.com  (no trailing /gateway).
function gatewayBase(tool) {
  const t = getTool(tool); if (!t) return '';
  return stripSlash(process.env[t.gatewayUrlEnv] || t.defaultGatewayUrl);
}

// Build the open URL: <gatewayBase>/gateway?lease=<token>
function gatewayOpenUrl(tool, token) {
  const base = gatewayBase(tool);
  if (!base) return '';
  return `${base}/gateway?lease=${encodeURIComponent(token)}`;
}

function defaultPath(tool) {
  const t = getTool(tool); if (!t) return '/';
  const p = process.env[t.defaultPathEnv] || t.defaultPath;
  return p.startsWith('/') ? p : '/' + p;
}

function verifyPath(tool) {
  const t = getTool(tool); if (!t) return '/';
  // Per-tool env override → per-tool registry default (e.g. WriteHuman's authed /api/me) →
  // the tool's default landing path. Only tools that set `defaultVerifyPath` change here;
  // every other tool falls back to defaultPath exactly as before.
  return process.env[t.verifyPathEnv] || t.defaultVerifyPath || defaultPath(tool);
}

// Per-tool verify interpretation mode. 'supabase_refresh' (WriteHuman) verifies by
// exchanging the session's refresh token at Supabase instead of scraping an HTML page;
// undefined for every other tool → the default HTML-based verify is used unchanged.
function verifyMode(tool) {
  const t = getTool(tool); if (!t) return null;
  return t.verifyMode || null;
}

// Resolved Supabase config for a tool that verifies via 'supabase_refresh' (WriteHuman).
// Returns { url, projectRef, anonKey } (env overrides → public defaults), or null otherwise.
// The anonKey is a PUBLIC apikey — never logged and never returned to the frontend.
function supabaseConfig(tool) {
  const t = getTool(tool); if (!t || !t.supabase) return null;
  const s = t.supabase;
  const url = stripSlash((s.urlEnv && process.env[s.urlEnv]) || s.defaultUrl || '');
  const anonKey = (s.anonKeyEnv && process.env[s.anonKeyEnv]) || s.defaultAnonKey || '';
  if (!url || !anonKey) return null;
  return { url, projectRef: s.projectRef || '', anonKey };
}

// Whether to run the content-based logged-out heuristic for this tool (for tools whose
// logged-out page is a 200 at the default path rather than a redirect to /sign-in).
// Per-tool env `<TOOL>_DETECT_LOGGEDOUT` (1/0) overrides the registry default; off for
// every tool that doesn't set it, so HIX/BypassGPT/ChatGPT/Grok are unaffected.
function shouldDetectLoggedOut(tool) {
  const t = getTool(tool); if (!t) return false;
  const env = process.env[`${String(t.key).toUpperCase()}_DETECT_LOGGEDOUT`];
  if (env != null && env !== '') return env === '1' || /^true$/i.test(env);
  return !!t.detectLoggedOut;
}

const ABS_FALLBACK_LEASE_MINUTES = 30; // historical default (StealthWriter parity)

function clampMinutes(v) {
  const n = parseInt(v, 10);
  if (!Number.isFinite(n)) return null;
  return Math.min(1440, Math.max(1, n)); // 1 min .. 24 h
}

// Resolve the session-lease length (= the client-facing countdown) for a tool.
// Precedence: per-tool env (e.g. GROK_LEASE_MINUTES) → global PROXY_LEASE_MINUTES → 30.
// A per-CLIENT override (ProxyClient.leaseMinutes) takes precedence over this and is
// applied in the client open route, not here.
function defaultLeaseMinutes(tool) {
  const t = getTool(tool);
  const perTool = t && t.leaseMinutesEnv ? process.env[t.leaseMinutesEnv] : undefined;
  const perToolGeneric = t ? process.env[`${String(t.key).toUpperCase()}_LEASE_MINUTES`] : undefined;
  return clampMinutes(perTool) || clampMinutes(perToolGeneric)
    || clampMinutes(process.env.PROXY_LEASE_MINUTES) || ABS_FALLBACK_LEASE_MINUTES;
}

// Safe public descriptor for the client UI (never any secret/config).
function publicInfo(tool) {
  const t = getTool(tool); if (!t) return null;
  return { tool: t.key, name: t.name, category: t.category, tagline: t.tagline };
}

module.exports = {
  TOOLS, TOOL_KEYS, isValidTool, getTool,
  targetOrigin, targetHost, gatewayBase, gatewayOpenUrl, defaultPath, verifyPath, verifyMode, supabaseConfig, publicInfo,
  defaultLeaseMinutes, clampMinutes, ABS_FALLBACK_LEASE_MINUTES, shouldDetectLoggedOut,
};
