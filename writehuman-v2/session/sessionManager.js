'use strict';
/**
 * WriteHuman V2 — session manager (in-process backend).
 *
 * Replaces the production backend's gateway route (backend/routes/proxy/gateway.js) with
 * an in-process implementation against the single-account store. The cloned gateway calls
 * these via an injected backend (server.js → gateway.setBackend), and the HTTP /v2/*
 * endpoints call the same methods — so there is no shared backend service.
 *
 * Every method returns the production-compatible { status, body } shape so the gateway can
 * treat them exactly like the HTTP responses it used to receive.
 *
 * Step-1 behaviour is at parity with production: verify uses the cloned supabase_refresh
 * logic (idempotent JWT-exp check → single refresh exchange → rotation persisted). The
 * smart timer / cookie-hash auto-replace are Step-2 (see scheduler.js / syncIngest.js).
 */
const { config } = require('../lib/config');
const log = require('../lib/log');
const lease = require('../lib/lease');
const cookies = require('../lib/cookies');
const verify = require('../lib/verify');
const cookieManager = require('./cookieManager');
const scheduler = require('./scheduler');
const store = require('../store/accountStore');

function targetHost() { try { return new URL(config.targetOrigin).hostname; } catch (_) { return ''; } }
function nowSec() { return Math.floor(Date.now() / 1000); }
function ok(body) { return { status: 200, body }; }
function err(status, code) { return { status, body: { valid: false, ok: false, code } }; }
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Single-flight guards: at most one verify and one ingest critical-section at a time, so the
// scheduler tick and a cookie ingest can never double-verify or race the bundle replace.
let _verifyInFlight = null;
let _ingestChain = Promise.resolve();

function init() { store.init(); }

// Resolve + validate a lease token. Returns { payload } or { error: {status,code} }.
function resolveLease(token) {
  if (!token) return { error: { status: 401, code: 'lease_missing' } };
  const payload = lease.verifyLease(token);
  if (!payload) return { error: { status: 401, code: 'lease_invalid' } };
  return { payload };
}

function secondsRemaining(payload) {
  return Math.max(0, (payload.exp || 0) - nowSec());
}

// ── /validate ────────────────────────────────────────────────────────────────
function validate(token) {
  const r = resolveLease(token);
  if (r.error) return err(r.error.status, r.error.code);
  return ok({ valid: true, tool: 'writehuman', toolName: config.toolName, secondsRemaining: secondsRemaining(r.payload) });
}

// ── /session (gateway-only over HTTP; in-process for the gateway) ─────────────
function session(token) {
  const r = resolveLease(token);
  if (r.error) return { status: r.error.status, body: { ok: false, code: r.error.code } };
  const a = store.get();
  if (!a) return ok({ ok: true, account: null });
  if (a.status === 'blocked') return ok({ ok: false, blocked: true, code: 'account_blocked' });
  const bundle = store.getDecryptedBundle();
  if (!bundle) return ok({ ok: false, blocked: true, code: 'account_no_session' });
  return ok({ ok: true, account: { id: a.id, status: a.status, label: a.label }, bundle });
}

// ── Verify core (single run) ──────────────────────────────────────────────────
// Verifies the stored bundle, records the result, applies DEFINITIVE status transitions
// (working / confirmed-logout) and persists token rotation. Leaves status unchanged on a
// transient 'unknown'. Returns the raw verify result.
async function _verifyCore(trigger) {
  const a = store.get();
  if (!a) return { result: 'unknown', httpStatus: 0 };
  const bundle = store.getDecryptedBundle();
  if (!bundle) {
    store.setStatus('session_expired', 'needs_login');
    store.setVerification({ result: 'session_expired', httpStatus: 0 });
    log.browserNotAuthenticated({ account_id: a.id, reason: 'no_bundle', trigger });
    return { result: 'session_expired', httpStatus: 0, loggedOut: true };
  }
  const cookieHeader = cookies.buildCookieHeader(bundle, targetHost());
  log.verifyStarted({ trigger, account_id: a.id });
  let v;
  try { v = await verify.verifyAccountCookies(cookieHeader, a.expectedIdentifier); }
  catch (_) { return { result: 'unknown', httpStatus: 0 }; }
  store.setVerification(v);

  if (v.result === 'working') {
    if (v.refreshedSession) {
      try {
        const updated = verify.applySupabaseRefresh(bundle, config.supabase.projectRef, v.refreshedSession);
        if (updated) { store.setBundle(updated); store.setCookieHash(cookieManager.cookieHash(updated)); log.sessionRefreshed({ account_id: a.id }); }
      } catch (_) { /* best-effort */ }
    }
    store.setStatus('active', 'working');
    log.verifySuccess({ account_id: a.id, http_status: v.httpStatus });
  } else if (v.result === 'session_expired') {
    // Reached ONLY on a confirmed logout (missing/invalid refresh token → 400/401/403).
    store.setStatus('session_expired', v.loggedOut ? 'needs_login' : 'session_expired');
    log.verifyFailed({ account_id: a.id, result: v.result, http_status: v.httpStatus });
    if (v.loggedOut) log.browserNotAuthenticated({ account_id: a.id });
  } else {
    // 'unknown' (network/429/5xx) or 'wrong_account' → never expire here; leave status as-is.
    log.verifyFailed({ account_id: a.id, result: v.result, http_status: v.httpStatus });
  }
  return v;
}

// Single-flight verify with retry ONLY on a transient 'unknown'. This is what implements
// "do NOT immediately show Need Login on failure — retry; only show Need Login if the browser
// is actually logged out / 401/403": a confirmed logout flips status inside _verifyCore; a
// transient unknown is retried and leaves the session active.
function verifyWithRetry(trigger) {
  if (_verifyInFlight) return _verifyInFlight; // de-dupe concurrent verifies (scheduler + ingest)
  _verifyInFlight = (async () => {
    let v = { result: 'unknown', httpStatus: 0 };
    for (let attempt = 0; attempt <= config.verifyMaxRetries; attempt++) {
      v = await _verifyCore(trigger);
      if (v.result !== 'unknown') break;
      if (attempt < config.verifyMaxRetries) {
        log.info('verify_retry', { trigger, attempt: attempt + 1, in_ms: config.verifyRetryMs });
        await sleep(config.verifyRetryMs);
      }
    }
    return v;
  })();
  _verifyInFlight.finally(() => { _verifyInFlight = null; });
  return _verifyInFlight;
}

// Scheduler tick — same single-flight verify path.
function verifyTick() { return verifyWithRetry('scheduler'); }

// ── /account-expired (gateway signal; verify-gated) ───────────────────────────
async function accountExpired(token) {
  const r = resolveLease(token);
  if (r.error) return { status: r.error.status, body: { ok: false, code: r.error.code } };
  const a = store.get();
  if (!a || a.status !== 'active') return ok({ ok: true, updated: false });
  const v = await verifyWithRetry('account_expired');
  const updated = (store.get() || {}).status === 'session_expired';
  return ok({ ok: true, updated, confirmed: updated, verify_result: v ? v.result : 'verify_failed' });
}

// ── Cookie ingest (Step-2) — the Cookie Sync Agent target ─────────────────────
// Monitors ONLY auth cookies. If the incoming auth-cookie hash matches the stored one →
// no-op. If it changed → REPLACE (never merge) the auth cookies, persist, then auto-verify
// and reset the smart timer. Serialized so concurrent pushes can't race the replace.
function ingestCookies(incoming) {
  const run = _ingestChain.then(() => _ingestCore(incoming));
  _ingestChain = run.catch(() => {}); // keep the chain alive even if one ingest throws
  return run;
}
async function _ingestCore(incoming) {
  const a = store.get();
  const list = Array.isArray(incoming) ? incoming : [];
  const incomingAuth = list.filter((c) => c && cookieManager.isAuthCookieName(c.name));
  // Require the primary auth-token cookie before replacing — a partial/transient read must
  // NOT wipe a valid stored session (that would be a self-inflicted logout).
  const base = cookieManager.authTokenBase();
  const hasAuthToken = incomingAuth.some((c) => c.name === base || c.name.startsWith(base + '.'));
  if (!hasAuthToken) {
    log.browserNotAuthenticated({ reason: 'no_auth_in_payload', auth_in_payload: incomingAuth.length });
    return { ok: true, changed: false, code: 'no_auth_in_payload' };
  }
  const host = targetHost();
  const norm = incomingAuth.map((c) => ({ name: c.name, value: c.value, domain: c.domain || host, path: c.path || '/' }));
  const newHash = cookieManager.cookieHash({ cookies: norm });
  if (a && a.cookieHash && newHash === a.cookieHash) {
    return { ok: true, changed: false }; // identical → do nothing (spec)
  }
  // Hash PREFIX only (one-way digest, not a secret) for debuggability.
  log.cookieHashChanged({ old: a && a.cookieHash ? a.cookieHash.slice(0, 8) : null, neu: newHash ? newHash.slice(0, 8) : null });
  const stored = store.getDecryptedBundle() || { cookies: [] };
  const merged = cookieManager.replaceAuthCookies(stored, norm); // REPLACE, never merge
  store.setBundle(merged);
  store.setCookieHash(newHash);
  log.cookieSynchronized({ source: 'ingest', auth_cookie_count: norm.length });
  const v = await verifyWithRetry('ingest');
  scheduler.reschedule(); // reset the smart timer after an ingest-triggered verify
  return { ok: true, changed: true, result: v.result, httpStatus: v.httpStatus };
}

// ── /capture-session (capture lease only) ─────────────────────────────────────
function captureSession(token, body) {
  const r = resolveLease(token);
  if (r.error) return { status: r.error.status, body: { ok: false, code: r.error.code } };
  if (!r.payload.cap) return { status: 403, body: { ok: false, code: 'not_capture_lease' } };
  const bundle = cookies.normalizeCookieBundle(body && body.cookies);
  if (!bundle || !Array.isArray(bundle.cookies) || bundle.cookies.length === 0) {
    return { status: 400, body: { ok: false, code: 'no_cookies_captured' } };
  }
  const host = targetHost();
  bundle.cookies = bundle.cookies.map(c => ({ ...c, domain: c.domain || host }));
  store.setBundle(bundle);
  store.setCookieHash(cookieManager.cookieHash(bundle));
  store.setStatus('active', 'working');
  store.setVerification({ result: 'working', httpStatus: 200 });
  log.cookieSynchronized({ source: 'capture', cookie_count: bundle.cookies.length });
  return ok({ ok: true, cookiesSaved: bundle.cookies.length });
}

// In-process dispatch used by the gateway's injected backend (server.js).
function callGateway(subpath, token, body) {
  if (subpath === '/session') return Promise.resolve(session(token));
  if (subpath === '/account-expired') return accountExpired(token);
  if (subpath === '/capture-session') return Promise.resolve(captureSession(token, body));
  return Promise.resolve({ status: 0, body: {} });
}

// ── Admin / test helpers (guarded by the admin key in server.js) ──────────────

// Seed/import the single account's cookie bundle (same format the prod admin pastes).
function seed(input, label) {
  const bundle = cookies.normalizeCookieBundle((input && input.cookies) || input);
  if (!bundle || !Array.isArray(bundle.cookies) || bundle.cookies.length === 0) {
    return { status: 400, body: { ok: false, code: 'no_cookies' } };
  }
  const host = targetHost();
  bundle.cookies = bundle.cookies.map(c => ({ ...c, domain: c.domain || host }));
  store.setBundle(bundle);
  store.setCookieHash(cookieManager.cookieHash(bundle));
  store.setStatus('active', 'working');
  if (label) store.update({ label: String(label) });
  log.cookieSynchronized({ source: 'admin_seed', cookie_count: bundle.cookies.length });
  return ok({ ok: true, cookiesSaved: bundle.cookies.length, driver: store.driver() });
}

// Mint a lease (client or capture) for the single account — replaces the dashboard open
// flow for Step-1 testing. Not wired into the production dashboard.
function mintLease(opts) {
  opts = opts || {};
  const { token, payload } = lease.signLease({ accountId: store.ACCOUNT_ID, capture: !!opts.capture, ttlMinutes: opts.ttlMinutes });
  const base = config.publicOrigin || ('http://localhost:' + config.port);
  return ok({ ok: true, token, jti: payload.jti, capture: !!opts.capture, secondsRemaining: secondsRemaining(payload), url: `${base}/gateway?lease=${encodeURIComponent(token)}` });
}

// Run a verify now (admin/test). Uses the shared single-flight + retry path.
async function verifyNow() {
  const a = store.get();
  if (!a) return { status: 404, body: { ok: false, code: 'no_account' } };
  const v = await verifyWithRetry('verify_now');
  return ok({ ok: true, result: v.result, httpStatus: v.httpStatus || 0, maskedId: v.maskedId || null });
}

module.exports = {
  init, validate, session, accountExpired, captureSession, callGateway,
  seed, mintLease, verifyNow, verifyTick, ingestCookies, resolveLease, secondsRemaining,
};
