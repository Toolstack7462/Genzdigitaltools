'use strict';
/**
 * WriteHuman V2 — standalone service entry.
 *
 * One HTTP server, two logical surfaces:
 *   1. V2 API  (/v2/*)  — in-process replacement for the production backend gateway route.
 *   2. Gateway (everything else) — the cloned WriteHuman reverse proxy (gateway/proxy.js),
 *      with its "backend" calls injected to the in-process session manager (no remote API).
 *
 * Fully isolated from production: own process/port, own secrets, own data store. Touches
 * no production file at runtime.
 *
 * IMPORTANT: applyGatewayEnv() MUST run before requiring gateway/proxy.js, because that
 * module reads the generic env names (TARGET_ORIGIN/LEASE_SECRET/…) at load time.
 */
const http = require('http');
const crypto = require('crypto');

const { config, applyGatewayEnv } = require('./lib/config');
applyGatewayEnv();

const log = require('./lib/log');
const store = require('./store/accountStore');
const sm = require('./session/sessionManager');
const scheduler = require('./session/scheduler');
const syncIngest = require('./session/syncIngest');
const gateway = require('./gateway/proxy'); // required AFTER applyGatewayEnv()

store.init();
sm.init();

// Inject the in-process backend into the gateway (replaces its remote HTTP calls).
gateway.setBackend({
  validate: (token) => sm.validate(token),
  call: (subpath, token, body) => sm.callGateway(subpath, token, body),
});

// Smart session timer: one verify when due, reschedule on result. Inert if disabled.
scheduler.init({
  verifyFn: () => sm.verifyTick(),
  getLast: () => (store.get() || {}).lastVerifiedAt,
  intervalMs: config.verifyIntervalMs,
  retryMs: config.verifyRetryMs,
  enabled: config.schedulerEnabled,
});

// ── helpers ───────────────────────────────────────────────────────────────────
function send(res, status, obj) {
  if (res.headersSent) { try { res.end(); } catch (_) {} return; }
  const body = JSON.stringify(obj == null ? {} : obj);
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
  res.end(body);
}

function readJson(req, limitBytes = 2 * 1024 * 1024) {
  return new Promise((resolve) => {
    const chunks = []; let size = 0; let aborted = false;
    req.on('data', (c) => {
      size += c.length;
      if (size > limitBytes) { aborted = true; try { req.destroy(); } catch (_) {} return; }
      chunks.push(c);
    });
    req.on('end', () => {
      if (aborted) return resolve(null);
      const raw = Buffer.concat(chunks).toString('utf8').trim();
      if (!raw) return resolve({});
      try { resolve(JSON.parse(raw)); } catch (_) { resolve(null); }
    });
    req.on('error', () => resolve(null));
  });
}

function parseCookies(header) {
  const out = {};
  (header || '').split(';').forEach((pair) => {
    const i = pair.indexOf('=');
    if (i > -1) out[pair.slice(0, i).trim()] = pair.slice(i + 1).trim();
  });
  return out;
}

function getLeaseToken(req, body) {
  const auth = req.headers.authorization;
  if (auth && auth.startsWith('Bearer ')) return auth.slice(7).trim();
  const c = parseCookies(req.headers.cookie)['pg_lease'];
  if (c) { try { return decodeURIComponent(c); } catch (_) { return c; } }
  return (body && body.lease) || null;
}

function keyMatches(got, expected) {
  const a = Buffer.from(String(got || ''));
  const b = Buffer.from(String(expected || ''));
  return a.length === b.length && a.length > 0 && crypto.timingSafeEqual(a, b);
}
function hasGatewayKey(req) { return keyMatches(req.headers['x-gateway-key'], config.gatewayKey); }
function hasAdminKey(req) { return keyMatches(req.headers['x-admin-key'], config.adminKey); }
// Ingest accepts the admin key OR the dedicated agent key (so the long-lived sync agent
// doesn't carry the full admin key). Check both header slots against both keys.
function hasIngestKey(req) {
  const got = req.headers['x-agent-key'] || req.headers['x-admin-key'];
  return keyMatches(got, config.agentKey) || keyMatches(got, config.adminKey);
}

function healthBody() {
  const a = store.get() || {};
  return {
    ok: true,
    service: 'writehuman-v2',
    step: 1,
    target: (() => { try { return new URL(config.targetOrigin).host; } catch (_) { return null; } })(),
    store: store.driver(),
    supabaseConfigured: !!(config.supabase.url && config.supabase.anonKey),
    account: {
      status: a.status || null,
      sessionStatus: a.session_status || null,
      hasBundle: !!a.sessionEncrypted,
      hasCookieHash: !!a.cookieHash,            // boolean only — never the hash value
      lastVerifiedAt: a.lastVerifiedAt || null,
      verificationResult: (a.verification && a.verification.result) || null,
    },
    scheduler: { running: scheduler.isRunning() }, // inert in Step 1
  };
}

// ── V2 API router ───────────────────────────────────────────────────────────
async function handleV2(req, res, pathName) {
  const method = req.method;

  if (pathName === '/v2/health') return send(res, 200, healthBody());

  // Read the body once for POST routes that need it.
  const needsBody = method === 'POST';
  const body = needsBody ? await readJson(req) : {};
  if (needsBody && body === null) return send(res, 400, { ok: false, code: 'bad_json' });

  if (pathName === '/v2/validate' && method === 'POST') {
    const r = sm.validate(getLeaseToken(req, body));
    return send(res, r.status, r.body);
  }

  if (pathName === '/v2/session' && method === 'POST') {
    if (!hasGatewayKey(req)) return send(res, 403, { ok: false, code: 'forbidden' });
    const r = sm.session(getLeaseToken(req, body));
    return send(res, r.status, r.body);
  }

  if (pathName === '/v2/account-expired' && method === 'POST') {
    if (!hasGatewayKey(req)) return send(res, 403, { ok: false, code: 'forbidden' });
    const r = await sm.accountExpired(getLeaseToken(req, body));
    return send(res, r.status, r.body);
  }

  if (pathName === '/v2/cookies/ingest' && method === 'POST') {
    // Cookie Sync Agent target (admin or agent key).
    if (!hasIngestKey(req)) return send(res, 403, { ok: false, code: 'forbidden' });
    const r = await syncIngest.handle(body);
    return send(res, r.status, r.body);
  }

  if (pathName === '/v2/admin/seed' && method === 'POST') {
    if (!hasAdminKey(req)) return send(res, 403, { ok: false, code: 'forbidden' });
    const r = sm.seed(body, body && body.label);
    return send(res, r.status, r.body);
  }

  if (pathName === '/v2/admin/lease' && method === 'POST') {
    if (!hasAdminKey(req)) return send(res, 403, { ok: false, code: 'forbidden' });
    const r = sm.mintLease({ capture: !!(body && body.capture), ttlMinutes: body && body.ttlMinutes });
    return send(res, r.status, r.body);
  }

  if (pathName === '/v2/admin/verify' && method === 'POST') {
    if (!hasAdminKey(req)) return send(res, 403, { ok: false, code: 'forbidden' });
    const r = await sm.verifyNow();
    return send(res, r.status, r.body);
  }

  return send(res, 404, { ok: false, code: 'not_found' });
}

const server = http.createServer((req, res) => {
  let pathName = '/';
  try { pathName = new URL(req.url, 'http://localhost').pathname; } catch (_) {}
  if (pathName === '/v2' || pathName.startsWith('/v2/')) {
    handleV2(req, res, pathName).catch((err) => {
      log.error('v2_handler', { path: pathName, message: err && err.message });
      send(res, 500, { ok: false, code: 'server_error' });
    });
    return;
  }
  // Everything else → the cloned WriteHuman gateway.
  Promise.resolve(gateway.handle(req, res)).catch((err) => {
    log.error('gateway_handler', { path: pathName, message: err && err.message });
    if (!res.headersSent) { try { res.writeHead(502, { 'content-type': 'text/plain' }); res.end('Gateway error'); } catch (_) {} }
  });
});

server.listen(config.port, () => {
  log.info('listening', {
    port: config.port,
    target: (() => { try { return new URL(config.targetOrigin).host; } catch (_) { return null; } })(),
    store: store.driver(),
    publicOrigin: config.publicOrigin || ('http://localhost:' + config.port),
    scheduler: config.schedulerEnabled ? 'on' : 'off',
  });
  scheduler.start();
});

module.exports = { server }; // exported for the test harness
