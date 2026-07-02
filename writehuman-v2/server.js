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
const fs = require('fs');
const path = require('path');

const { config, applyGatewayEnv } = require('./lib/config');
applyGatewayEnv();

const log = require('./lib/log');
const store = require('./store/accountStore');
const sm = require('./session/sessionManager');
const scheduler = require('./session/scheduler');
const syncIngest = require('./session/syncIngest');
const rateLimit = require('./lib/rateLimit');
const events = require('./lib/events');
const gateway = require('./gateway/proxy'); // required AFTER applyGatewayEnv()

// Self-contained admin panel (served at /v2/admin). Read once at boot. All of its actions
// are gated by the admin key entered in the page → sent as x-admin-key. The HTML itself
// carries no secret. Kept separate from the production admin app (V2 stays isolated).
let ADMIN_HTML = '<!doctype html><title>WriteHuman V2</title><p>dashboard missing</p>';
try { ADMIN_HTML = fs.readFileSync(path.join(__dirname, 'public', 'dashboard.html'), 'utf8'); } catch (_) {}

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
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' });
  res.end(body);
}

// Client IP for rate-limiting/allowlisting. Behind LiteSpeed/Passenger the socket peer is the
// local proxy, so the real client is in X-Forwarded-For (first hop).
function clientIp(req) {
  const xff = req.headers['x-forwarded-for'];
  if (xff) return String(xff).split(',')[0].trim();
  return (req.socket && req.socket.remoteAddress) || 'unknown';
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

// Short-lived tokens for the SSE stream (EventSource can't send custom headers). Minted from
// the admin key; validated on connect; expire so a leaked URL is only briefly useful.
const streamTokens = new Map(); // token -> expiresAt
function mintStreamToken() {
  const token = crypto.randomBytes(24).toString('hex');
  streamTokens.set(token, Date.now() + 30 * 60000);
  if (streamTokens.size > 200) { const now = Date.now(); for (const [k, exp] of streamTokens) if (exp < now) streamTokens.delete(k); }
  return token;
}
function validStreamToken(token) {
  const exp = streamTokens.get(token);
  if (!exp) return false;
  if (Date.now() > exp) { streamTokens.delete(token); return false; }
  return true;
}

// Server-Sent Events: live state + log tail. Pushes state on connect + every 5s (covers agent
// telemetry that doesn't emit a log event) and every log event as it happens. Cleans up on close.
function sse(req, res) {
  res.writeHead(200, { 'content-type': 'text/event-stream; charset=utf-8', 'cache-control': 'no-cache, no-transform', connection: 'keep-alive', 'x-content-type-options': 'nosniff' });
  res.write('retry: 5000\n\n');
  const write = (event, data) => { try { res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`); } catch (_) {} };
  write('state', sm.getState());
  for (const e of events.recent(60)) write('log', e);
  const unsub = events.subscribe((e) => write('log', e));
  const stateTimer = setInterval(() => write('state', sm.getState()), 5000);
  const ka = setInterval(() => { try { res.write(': ka\n\n'); } catch (_) {} }, 15000);
  if (stateTimer.unref) stateTimer.unref();
  if (ka.unref) ka.unref();
  const cleanup = () => { unsub(); clearInterval(stateTimer); clearInterval(ka); };
  req.on('close', cleanup); req.on('error', cleanup); res.on('error', cleanup);
}
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
    mode: config.productionBacked ? 'production-backed' : 'standalone',
    prodValidate: !!(config.productionBacked && config.prodApiBase),
    account: {
      status: a.status || null,
      sessionStatus: a.session_status || null,
      hasBundle: !!a.sessionEncrypted,
      hasCookieHash: !!a.cookieHash,            // boolean only — never the hash value
      lastVerifiedAt: a.lastVerifiedAt || null,
      verificationResult: (a.verification && a.verification.result) || null,
      lastSyncedAt: a.lastSyncedAt || null,
      syncCount: a.syncCount || 0,
      // Cookie Sync Agent liveness: null = never synced; true = no sync within the stale window.
      agentStale: a.lastSyncedAt ? ((Date.now() - new Date(a.lastSyncedAt).getTime()) > config.agentStaleMin * 60000) : null,
    },
    scheduler: { running: scheduler.isRunning() }, // inert in Step 1
  };
}

// ── V2 API router ───────────────────────────────────────────────────────────
async function handleV2(req, res, pathName) {
  const method = req.method;
  const ip = clientIp(req);

  // Best-effort per-IP rate limit (generous default; disabled when rateLimitPerMin<=0).
  if (!rateLimit.allow('v2:' + ip, config.rateLimitPerMin)) {
    return send(res, 429, { ok: false, code: 'rate_limited' });
  }

  if (pathName === '/v2/admin' && method === 'GET') {
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' });
    return res.end(ADMIN_HTML);
  }

  if (pathName === '/v2/health') return send(res, 200, healthBody());

  // ── Dashboard read APIs (admin-key gated; GET) ──────────────────────────────
  if (pathName === '/v2/admin/state' && method === 'GET') {
    if (!hasAdminKey(req)) return send(res, 403, { ok: false, code: 'forbidden' });
    return send(res, 200, sm.getState());
  }
  if (pathName === '/v2/admin/logs' && method === 'GET') {
    if (!hasAdminKey(req)) return send(res, 403, { ok: false, code: 'forbidden' });
    let limit = 100; try { limit = parseInt(new URL(req.url, 'http://localhost').searchParams.get('limit'), 10) || 100; } catch (_) {}
    return send(res, 200, { ok: true, events: events.recent(limit) });
  }
  if (pathName === '/v2/admin/stream' && method === 'GET') {
    let token = ''; try { token = new URL(req.url, 'http://localhost').searchParams.get('token') || ''; } catch (_) {}
    if (!validStreamToken(token)) return send(res, 403, { ok: false, code: 'forbidden' });
    return sse(req, res);
  }

  // Read the body once for POST routes that need it.
  const needsBody = method === 'POST';
  const body = needsBody ? await readJson(req) : {};
  if (needsBody && body === null) return send(res, 400, { ok: false, code: 'bad_json' });

  if (pathName === '/v2/validate' && method === 'POST') {
    const r = await sm.validate(getLeaseToken(req, body));
    return send(res, r.status, r.body);
  }

  if (pathName === '/v2/session' && method === 'POST') {
    if (!config.exposeGatewayHttp) return send(res, 404, { ok: false, code: 'not_found' });
    if (!hasGatewayKey(req)) return send(res, 403, { ok: false, code: 'forbidden' });
    const r = sm.session(getLeaseToken(req, body));
    return send(res, r.status, r.body);
  }

  if (pathName === '/v2/account-expired' && method === 'POST') {
    if (!config.exposeGatewayHttp) return send(res, 404, { ok: false, code: 'not_found' });
    if (!hasGatewayKey(req)) return send(res, 403, { ok: false, code: 'forbidden' });
    const r = await sm.accountExpired(getLeaseToken(req, body));
    return send(res, r.status, r.body);
  }

  if (pathName === '/v2/cookies/ingest' && method === 'POST') {
    // Cookie Sync Agent target (admin or agent key). Optional IP allowlist for defense-in-depth.
    if (config.ingestAllowIps.length && !config.ingestAllowIps.includes(ip)) return send(res, 403, { ok: false, code: 'ip_not_allowed' });
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

  if (pathName === '/v2/admin/stream-token' && method === 'POST') {
    if (!hasAdminKey(req)) return send(res, 403, { ok: false, code: 'forbidden' });
    return send(res, 200, { ok: true, token: mintStreamToken(), expiresInSec: 1800 });
  }

  if (pathName === '/v2/admin/command' && method === 'POST') {
    if (!hasAdminKey(req)) return send(res, 403, { ok: false, code: 'forbidden' });
    const r = sm.queueCommand(body && body.command);
    return send(res, r.ok ? 200 : 400, r);
  }

  return send(res, 404, { ok: false, code: 'not_found' });
}

const server = http.createServer((req, res) => {
  let pathName = '/';
  try { pathName = new URL(req.url, 'http://localhost').pathname; } catch (_) {}
  if (pathName === '/admin') { // convenience redirect to the V2 admin panel
    res.writeHead(302, { location: '/v2/admin', 'cache-control': 'no-store' });
    return res.end();
  }
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
    mode: config.productionBacked ? 'production-backed' : 'standalone',
  });
  scheduler.start();
});

module.exports = { server }; // exported for the test harness
