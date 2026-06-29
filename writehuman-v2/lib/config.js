'use strict';
/**
 * WriteHuman V2 — dependency-free .env loader + resolved, typed configuration.
 *
 * This is the SINGLE source of truth for V2 secrets and runtime config. It is fully
 * isolated from the production proxy: it reads only `WRITEHUMAN_V2_*` env vars and its
 * own `<root>/.env`, and uses its OWN lease/vault/gateway/admin secrets so a V2 lease or
 * vault blob is never interchangeable with production.
 *
 * NEVER logs secret values. `applyGatewayEnv()` maps this config onto the generic env
 * names the cloned reverse-proxy (gateway/proxy.js) already reads, so the proxy core
 * stays a faithful clone and only its transport/wiring changes.
 */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const ROOT = path.join(__dirname, '..');

// 1) Load <root>/.env into process.env (real environment always wins — never overrides).
(function loadEnv() {
  try {
    const raw = fs.readFileSync(path.join(ROOT, '.env'), 'utf8');
    for (const line of raw.split(/\r?\n/)) {
      if (!line || line.trim().startsWith('#')) continue;
      const m = /^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/i.exec(line);
      if (!m) continue;
      let val = m[2];
      if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) val = val.slice(1, -1);
      if (process.env[m[1]] === undefined) process.env[m[1]] = val;
    }
  } catch (_) { /* rely on the real environment */ }
})();

function env(name, def) { const v = process.env[name]; return (v === undefined || v === '') ? def : v; }
function bool(name, def) { const v = process.env[name]; if (v == null || v === '') return def; return v === '1' || /^true$/i.test(v); }
function intEnv(name, def) { const n = parseInt(process.env[name], 10); return Number.isFinite(n) ? n : def; }

// Base secret used to DERIVE the lease/vault/gateway/admin secrets when a specific one is
// not provided. In production each should be set explicitly; the derivation keeps local
// dev runnable from a single value. Fails loudly rather than deriving from nothing.
const BASE_SECRET = env('WRITEHUMAN_V2_SECRET', '');
function deriveSecret(ns) {
  if (!BASE_SECRET || BASE_SECRET.length < 16) {
    throw new Error(`Missing secret: set WRITEHUMAN_V2_SECRET (>=16 chars) or the specific env for "${ns}".`);
  }
  return crypto.createHmac('sha256', BASE_SECRET).update('writehuman-v2:' + ns).digest('hex');
}

// Lease signing secret (HS256). >=32 chars so the gateway's local lease verify is enabled.
const leaseSecret = (() => {
  const explicit = env('WRITEHUMAN_V2_LEASE_SECRET', '');
  if (explicit && explicit.length >= 32) return explicit;
  return deriveSecret('lease:v1'); // 64 hex chars
})();

// Vault key (32 bytes) for AES-256-GCM encryption of the cookie bundle at rest.
const vaultKey = (() => {
  const hex = env('WRITEHUMAN_V2_VAULT_KEY', '');
  if (/^[0-9a-fA-F]{64}$/.test(hex)) return Buffer.from(hex, 'hex');
  const base = BASE_SECRET || leaseSecret;
  return crypto.createHmac('sha256', base).update('writehuman-v2:vault:v1').digest();
})();

// Gateway↔backend shared key. In V2 both run in one process, but the gateway still
// requires a non-empty key to enable account-session injection (parity with production).
const gatewayKey = (() => {
  const explicit = env('WRITEHUMAN_V2_GATEWAY_KEY', '');
  return explicit || deriveSecret('gateway:v1');
})();

// Admin key — guards /v2/admin/* and the /v2/cookies/ingest seeding surface.
const adminKey = (() => {
  const explicit = env('WRITEHUMAN_V2_ADMIN_KEY', '');
  return explicit || deriveSecret('admin:v1');
})();

// Agent key — a SEPARATE credential the Cookie Sync Agent uses for /v2/cookies/ingest, so
// the long-lived agent never needs the full admin key. Falls back to a derived value.
const agentKey = (() => {
  const explicit = env('WRITEHUMAN_V2_AGENT_KEY', '');
  return explicit || deriveSecret('agent:v1');
})();

const config = {
  port: parseInt(env('PORT', env('WRITEHUMAN_V2_PORT', '3100')), 10) || 3100,
  targetOrigin: env('WRITEHUMAN_V2_TARGET_ORIGIN', 'https://writehuman.ai').replace(/\/$/, ''),
  publicOrigin: env('WRITEHUMAN_V2_PUBLIC_ORIGIN', '').replace(/\/$/, ''),
  defaultPath: env('WRITEHUMAN_V2_DEFAULT_PATH', '/'),
  signinPath: env('WRITEHUMAN_V2_SIGNIN_PATH', '/signup?mode=login'),
  toolName: env('WRITEHUMAN_V2_TOOL_NAME', 'WriteHuman'),
  leaseMinutes: Math.min(1440, Math.max(1, parseInt(env('WRITEHUMAN_V2_LEASE_MINUTES', '30'), 10) || 30)),
  storeDriver: env('WRITEHUMAN_V2_STORE', 'auto'), // auto | sqlite | json
  leaseSecret, vaultKey, gatewayKey, adminKey, agentKey,
  // ── Step-2 smart session timer + verify retry ───────────────────────────────
  // The scheduler runs ONE verify when due (not a busy loop). On a still-valid access token
  // the verify is a no-network fast-path, so periodic verify is cheap. Defaults: verify every
  // 10 min; on a transient 'unknown' (network/429/5xx) retry sooner; never expire on unknown.
  schedulerEnabled: bool('WRITEHUMAN_V2_SCHEDULER', true),
  verifyIntervalMs: Math.max(30000, intEnv('WRITEHUMAN_V2_VERIFY_INTERVAL_MS', 10 * 60 * 1000)),
  verifyRetryMs: Math.max(2000, intEnv('WRITEHUMAN_V2_VERIFY_RETRY_MS', 60 * 1000)),
  verifyMaxRetries: Math.max(0, intEnv('WRITEHUMAN_V2_VERIFY_MAX_RETRIES', 3)),
  // Supabase config for the supabase_refresh verifier. The anon key is PUBLIC (the same key
  // WriteHuman ships to every browser) — not a secret, never logged. Overridable via env.
  supabase: {
    projectRef: env('WRITEHUMAN_V2_SUPABASE_REF', 'hicfsbrfkzsxbwayibfm'),
    url: env('WRITEHUMAN_V2_SUPABASE_URL', 'https://hicfsbrfkzsxbwayibfm.supabase.co').replace(/\/$/, ''),
    anonKey: env('WRITEHUMAN_V2_SUPABASE_ANON_KEY',
      'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImhpY2ZzYnJma3pzeGJ3YXlpYmZtIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzMwMzE4MDgsImV4cCI6MjA4ODYwNzgwOH0.8vN4qjWB6aBGHuz7ixzoLRrMgKO3Lnc-Vmm2SjbW9n0'),
  },
};

// Map V2 config → the generic env names the cloned gateway (gateway/proxy.js) reads at
// module-load. Only sets a var that isn't already present, so an explicit env/.env override
// still wins. server.js MUST call this BEFORE requiring gateway/proxy.js.
function applyGatewayEnv() {
  const set = (k, v) => { if (process.env[k] === undefined || process.env[k] === '') process.env[k] = String(v); };
  set('TARGET_ORIGIN', config.targetOrigin);
  set('API_BASE', '/v2');                                   // overlay.js calls `${api}/validate` same-origin
  set('GATEWAY_PUBLIC_ORIGIN', config.publicOrigin || ('http://localhost:' + config.port));
  set('LEASE_SECRET', config.leaseSecret);
  set('GATEWAY_KEY', config.gatewayKey);
  set('TOOL_KEY', 'writehuman');
  set('TOOL_NAME', config.toolName);
  set('DEFAULT_PATH', config.defaultPath);
  set('SIGNIN_PATH', config.signinPath);
  // WriteHuman-specific gateway behaviour, baked as defaults (see proxy-gateway/.env.writehuman.example).
  set('DETECT_LOGGED_OUT', '0');
  set('RESET_STORAGE_ON_NEW_LEASE', '1');
  set('SUPABASE_BROWSER_SESSION', '1');
  set('NAV_BLOCK_EXTRA', 'myaccount, my-account');
  set('HIDE_SELECTORS',
    'a[href*="/myaccount"], a[href*="/myaccount"] + button, a[href*="/myaccount"] ~ button, .flex.items-center.gap-2:has(a[href*="/myaccount"]), div:has(> a[href*="/myaccount"])');
}

module.exports = { config, applyGatewayEnv };
