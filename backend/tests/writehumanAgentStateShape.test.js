'use strict';
/**
 * The admin agent-state aggregator, exercised against real account rows.
 *
 * This is the endpoint the WriteHuman dashboard polls every 30 seconds. If it throws, the page goes
 * blank; if it mislabels, the operator is sent to do work that isn't needed. Neither failure was
 * covered by a test before, and the second one is exactly what the one-hour bug was.
 *
 * The models are stubbed in the require cache before the router loads, so this runs against the
 * real Express route with no database.
 */
const test = require('node:test');
const assert = require('node:assert');
const crypto = require('crypto');
const http = require('http');

process.env.JWT_SECRET = process.env.JWT_SECRET || 'x'.repeat(64);
process.env.JWT_REFRESH_SECRET = process.env.JWT_REFRESH_SECRET || 'y'.repeat(64);
process.env.COOKIES_ENCRYPTION_KEY = process.env.COOKIES_ENCRYPTION_KEY || crypto.randomBytes(32).toString('hex');
process.env.PROXY_VAULT_KEY = process.env.PROXY_VAULT_KEY || crypto.randomBytes(32).toString('hex');
process.env.DATABASE_URL = process.env.DATABASE_URL || 'mysql://u:p@127.0.0.1:3306/db';
delete process.env.PROXY_AGENT_SYNC_KEY;

const vaultCrypto = require('../utils/proxy/vaultCrypto');

// --- stub the models + auth BEFORE the router captures them -----------------
let ACCOUNTS = [];
const stub = (p, exports) => { const id = require.resolve(p); require.cache[id] = { id, filename: id, loaded: true, exports }; };
stub('../models/proxy/ProxyAccount', { find: async () => ACCOUNTS, findById: async (id) => ACCOUNTS.find(a => a._id === id) || null });
stub('../models/proxy/ProxyClient', { find: async () => [] });
stub('../models/proxy/ProxyLease', { find: async () => [], updateMany: async () => ({}) });
stub('../models/ActivityLog', { log: async () => {} });
stub('../middleware/authEnhanced', {
  requireAuth: (req, _res, next) => { req.userId = 'admin1'; next(); },
  requireAdmin: (_req, _res, next) => next(),
  getClientIp: () => '127.0.0.1',
});

const express = require('express');
const router = require('../routes/admin/proxyTools');

/** A bundle whose Supabase access token expires `ttlSec` from now (negative = already expired). */
function bundleWithToken(ttlSec) {
  const now = Math.floor(Date.now() / 1000);
  const jwt = (payload) => ['e30', Buffer.from(JSON.stringify(payload)).toString('base64url'), 'sig'].join('.');
  const session = {
    access_token: jwt({ exp: now + ttlSec, iat: now - 60, session_id: 'sess-1', email: 'k@example.com' }),
    refresh_token: 'refresh-abc',
    user: { email: 'k@example.com' },
  };
  return {
    cookies: [{
      name: 'sb-hicfsbrfkzsxbwayibfm-auth-token',
      value: 'base64-' + Buffer.from(JSON.stringify(session)).toString('base64url'),
      domain: '.writehuman.ai', path: '/',
    }],
  };
}

function account(over = {}) {
  const ttl = over.tokenTtlSec === undefined ? 1800 : over.tokenTtlSec;
  const now = Date.now();
  const dev = {
    deviceId: 'dev_rdp01', name: 'RDP-01', hostname: 'RDP-01', agentVersion: '3.4.0',
    keyHash: 'h', revoked: false,
    lastSeenAt: new Date(now - (over.agentSeenMs === undefined ? 30_000 : over.agentSeenMs)),
    report: { cdp: '200', chrome: true, authCookies: 2, receivedAt: new Date(now - 30_000), host: 'RDP-01', version: '3.4.0' },
  };
  return Object.assign({
    _id: 'acct1', tool: 'writehuman', isPrimary: true, label: 'WriteHuman',
    status: 'active', session_status: 'working',
    sessionEncrypted: vaultCrypto.encrypt(JSON.stringify(bundleWithToken(ttl))),
    sessionMeta: { cookieCount: 1 },
    cookieHash: 'abc123',
    verification: { result: 'working', maskedId: 'k****@example.com', httpStatus: 200, checkedAt: new Date(now - 120_000) },
    lastVerifiedAt: new Date(now - 120_000),
    lastSyncedAt: new Date(now - (over.syncMs === undefined ? 300_000 : over.syncMs)),
    lastSyncSuccessAt: new Date(now - (over.syncMs === undefined ? 300_000 : over.syncMs)),
    lastAgentSeenAt: dev.lastSeenAt,
    lastSyncResultCode: 'PROMOTED',
    syncCount: 12, bundleVersion: 9,
    syncDevices: [dev],
    activeSource: { deviceId: 'dev_rdp01', name: 'RDP-01', promotedAt: new Date(now - 600_000), bundleVersion: 9 },
    pendingCommands: [], commandLog: [], rollbackBundles: [],
    save() { return Promise.resolve(this); },
  }, over.account || {});
}

function serve() {
  const app = express();
  app.use(express.json());
  app.use('/api/crm/admin/proxy-tools', router);
  const server = http.createServer(app);
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const port = server.address().port;
      resolve({
        server,
        async state() {
          const r = await fetch(`http://127.0.0.1:${port}/api/crm/admin/proxy-tools/writehuman/agent-state`);
          return { status: r.status, body: await r.json() };
        },
        close() { return new Promise((r) => server.close(r)); },
      });
    });
  });
}

test('a healthy account reports green on all five signals', async () => {
  ACCOUNTS = [account()];
  const s = await serve();
  try {
    const { status, body } = await s.state();
    assert.strictEqual(status, 200);
    assert.ok(body.healthSignals, 'healthSignals must be published — the page renders from it');
    assert.strictEqual(body.healthSignals.session.state, 'HEALTHY');
    assert.strictEqual(body.healthSignals.verification.state, 'recent');
    assert.strictEqual(body.healthSignals.agent.state, 'ONLINE');
    assert.strictEqual(body.healthSignals.chrome.state, 'CONNECTED');
    assert.strictEqual(body.healthSignals.cookieSync.state, 'FRESH');
    assert.strictEqual(body.health, 'up');
    assert.strictEqual(body.loginRequired, false);
    assert.strictEqual(body.refreshTokenPresent, true);
    assert.ok(body.account.accessTokenExpiresInSec > 0);
  } finally { await s.close(); }
});

test('THE ONE-HOUR BUG, end to end: an expired access token does NOT degrade the account', async () => {
  // The exact production state: token aged out, refresh session fine, agent fine, product working.
  ACCOUNTS = [account({ tokenTtlSec: -300 })];
  const s = await serve();
  try {
    const { body } = await s.state();
    assert.strictEqual(body.account.tokenExpired, true, 'the token really is expired');
    assert.strictEqual(body.refreshTokenPresent, true, 'and the refresh half is still there');

    // What the operator must NOT be told.
    assert.strictEqual(body.healthSignals.session.state, 'REFRESHING');
    assert.strictEqual(body.loginRequired, false);
    assert.strictEqual(body.health, 'up', 'an aged token must no longer read as `degraded`');
    assert.strictEqual(body.account.workingUnverified, false, 'must no longer read as "working · unverified"');
    assert.strictEqual(body.lifecycleState, 'HEALTHY');

    // Where it DOES show up, and nowhere else.
    assert.strictEqual(body.healthSignals.verification.state, 'due');
    assert.strictEqual(body.healthSignals.agent.state, 'ONLINE');
    assert.strictEqual(body.healthSignals.chrome.state, 'CONNECTED');
    assert.strictEqual(body.healthSignals.cookieSync.state, 'FRESH');
  } finally { await s.close(); }
});

test('agent offline + cookies behind: session stays HEALTHY and says which bundle is in use', async () => {
  ACCOUNTS = [account({ agentSeenMs: 5 * 60 * 60 * 1000, syncMs: 5 * 60 * 60 * 1000 })];
  const s = await serve();
  try {
    const { body } = await s.state();
    assert.strictEqual(body.healthSignals.session.state, 'HEALTHY');
    assert.strictEqual(body.loginRequired, false);
    assert.strictEqual(body.healthSignals.agent.state, 'OFFLINE');
    assert.strictEqual(body.healthSignals.cookieSync.state, 'BEHIND');
    assert.match(body.healthSignals.summary, /using the last verified bundle/);
    // Telemetry from an offline device is withheld rather than rendered as current.
    assert.strictEqual(body.healthSignals.chrome.state, 'UNKNOWN');
  } finally { await s.close(); }
});

test('a proven auth failure still reads as LOGIN_REQUIRED', async () => {
  ACCOUNTS = [account({ account: { session_status: 'needs_login' } })];
  const s = await serve();
  try {
    const { body } = await s.state();
    assert.strictEqual(body.healthSignals.session.state, 'LOGIN_REQUIRED');
    assert.strictEqual(body.loginRequired, true);
    assert.strictEqual(body.health, 'down');
  } finally { await s.close(); }
});

test('the response publishes an ADDRESSED command queue, never a bare pending string', async () => {
  ACCOUNTS = [account()];
  const s = await serve();
  try {
    const { body } = await s.state();
    assert.ok(Array.isArray(body.pendingCommands));
    assert.strictEqual(body.pendingCommand, undefined, 'the untargeted field must be gone');
    assert.ok(body.commandMinAgentVersion);
  } finally { await s.close(); }
});

test('no account at all answers cleanly instead of throwing', async () => {
  ACCOUNTS = [];
  const s = await serve();
  try {
    const { status, body } = await s.state();
    assert.strictEqual(status, 200);
    assert.strictEqual(body.account, null);
    assert.deepStrictEqual(body.pendingCommands, []);
  } finally { await s.close(); }
});

test('an account with no bundle is ERROR, not a crash', async () => {
  ACCOUNTS = [account({ account: { sessionEncrypted: null } })];
  const s = await serve();
  try {
    const { status, body } = await s.state();
    assert.strictEqual(status, 200);
    assert.strictEqual(body.healthSignals.session.state, 'ERROR');
    assert.strictEqual(body.loginRequired, false);
  } finally { await s.close(); }
});

/**
 * Verify Session, with the upstream stubbed so the test is hermetic. `canaryStatus` is what
 * Supabase's /auth/v1/user answers; requests to our own loopback server pass through untouched.
 */
async function verifySession(canaryStatus, canaryBody) {
  const app = express();
  app.use(express.json());
  app.use('/api/crm/admin/proxy-tools', router);
  const server = http.createServer(app);
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const realFetch = global.fetch;
  let upstreamCalls = 0;
  global.fetch = async (url, opts) => {
    if (String(url).includes('127.0.0.1')) return realFetch(url, opts);
    upstreamCalls += 1;
    if (canaryStatus === 'network') throw new Error('ECONNRESET');
    return new Response(JSON.stringify(canaryBody || {}), { status: canaryStatus, headers: { 'content-type': 'application/json' } });
  };
  try {
    const port = server.address().port;
    const r = await realFetch(`http://127.0.0.1:${port}/api/crm/admin/proxy-tools/writehuman/verify-session`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}',
    });
    return { status: r.status, body: await r.json(), upstreamCalls };
  } finally { global.fetch = realFetch; await new Promise((r) => server.close(r)); }
}

test('Verify Session is server-side: no Chrome launched, no device contacted, source untouched', async () => {
  ACCOUNTS = [account()];
  const { status, body } = await verifySession(200, { email: 'k@example.com' });
  assert.strictEqual(status, 200);
  assert.strictEqual(body.result, 'working');
  assert.strictEqual(body.canary, 'passed', 'a REAL authenticated check ran, not a local JWT decode');
  assert.strictEqual(body.chromeLaunched, false);
  assert.strictEqual(body.deviceContacted, null);
  assert.strictEqual(ACCOUNTS[0].activeSource.deviceId, 'dev_rdp01', 'a verify never moves the active source');
  assert.deepStrictEqual(ACCOUNTS[0].pendingCommands, [], 'a verify never queues a command');
});

test('Verify Session works with the source machine OFFLINE — that is the point of storing a session', async () => {
  ACCOUNTS = [account({ agentSeenMs: 6 * 60 * 60 * 1000, syncMs: 6 * 60 * 60 * 1000 })];
  const { body } = await verifySession(200, { email: 'k@example.com' });
  assert.strictEqual(body.result, 'working');
  assert.strictEqual(body.chromeLaunched, false);
});

test('a canary 401 is proof the session is dead', async () => {
  ACCOUNTS = [account()];
  const { body } = await verifySession(401, { msg: 'invalid JWT' });
  assert.strictEqual(body.canary, 'failed');
  assert.strictEqual(body.result, 'needs_login');
});

test('a canary 403 or 5xx or network error NEVER downgrades a live session', async () => {
  for (const s of [403, 429, 500, 'network']) {
    ACCOUNTS = [account()];
    const { body } = await verifySession(s);
    assert.strictEqual(body.result, 'working', 'status ' + s + ' must stay working');
    assert.strictEqual(body.canary, 'inconclusive', 'status ' + s + ' must be inconclusive');
    assert.strictEqual(ACCOUNTS[0].session_status, 'working', 'status ' + s);
  }
});

test('with the token already expired, read-only verify does not rotate and does not expire', async () => {
  ACCOUNTS = [account({ tokenTtlSec: -300 })];
  const { body, upstreamCalls } = await verifySession(200, { email: 'k@example.com' });
  assert.strictEqual(upstreamCalls, 0, 'no exchange, no call — the browser is the rotator');
  assert.strictEqual(body.result, 'unknown', 'inconclusive, NOT expired');
  assert.strictEqual(body.refreshed, false);
  assert.strictEqual(ACCOUNTS[0].session_status, 'working', 'a live session must survive an aged token');
});
