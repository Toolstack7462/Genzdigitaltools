'use strict';
/**
 * Route-level tests for the agent ingest endpoint.
 *
 * These cover the property that matters operationally: when cookie sync is not configured, the
 * INGEST endpoint fails closed and nothing else changes. That is the shape the 38-day outage took —
 * ingest answered 503 while the rest of the API served normally — so it must stay a deliberate,
 * tested behaviour rather than an accident, and the 503 must now be distinguishable from a
 * credential rejection so the next operator can tell "nothing is paired" from "your key is wrong".
 *
 * The ProxyAccount model is stubbed in the require cache before the router loads, so these run
 * against the real Express router with no database.
 */
const test = require('node:test');
const assert = require('node:assert');
const crypto = require('crypto');
const http = require('http');


process.env.PROXY_VAULT_KEY = process.env.PROXY_VAULT_KEY || crypto.randomBytes(32).toString('hex');
delete process.env.PROXY_AGENT_SYNC_KEY;          // the production condition under test
delete process.env.PROXY_AGENT_SYNC_ALLOW_IPS;

// --- stub the model BEFORE the router captures it ---------------------------
const modelPath = require.resolve('../models/proxy/ProxyAccount');
let ACCOUNTS = [];
require.cache[modelPath] = {
  id: modelPath, filename: modelPath, loaded: true, exports: {
    find: async () => ACCOUNTS,
  },
};
// healthAlerts must not try to send mail from a test.
const alertsPath = require.resolve('../utils/proxy/healthAlerts');
require(alertsPath).onVerifyApplied = async () => {};

const express = require('express');
const deviceSync = require('../utils/proxy/deviceSync');
const router = require('../routes/proxy/agentSync');

function makeAccount() {
  return {
    _id: 'acct1', tool: 'writehuman', isPrimary: true, label: 'WriteHuman',
    status: 'active', session_status: 'working',
    save() { return Promise.resolve(this); },
  };
}

/** Start the router on an ephemeral port and return a request helper. */
function serve() {
  const app = express();
  app.use('/api/crm/proxy/agent', router);
  const server = http.createServer(app);
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const port = server.address().port;
      resolve({
        server,
        async post(p, body, headers) {
          const res = await fetch(`http://127.0.0.1:${port}${p}`, {
            method: 'POST',
            headers: Object.assign({ 'content-type': 'application/json' }, headers || {}),
            body: JSON.stringify(body || {}),
          });
          let json = null; try { json = await res.json(); } catch (_) {}
          return { status: res.status, body: json };
        },
      });
    });
  });
}

test('with nothing paired and no key, ingest fails closed with a diagnosable code', async () => {
  ACCOUNTS = [makeAccount()];
  const { server, post } = await serve();
  try {
    const r = await post('/api/crm/proxy/agent/writehuman/cookies', { heartbeat: true });
    assert.strictEqual(r.status, 503);
    assert.strictEqual(r.body.code, 'agent_sync_not_configured');
    // The hint is the whole point: the old 503 said nothing, and an operator could not tell it
    // apart from a bad key. This one names the remedy.
    assert.match(r.body.hint || '', /pair/i);
  } finally { server.close(); }
});

test('an unknown tool 404s rather than leaking that WriteHuman exists', async () => {
  ACCOUNTS = [makeAccount()];
  const { server, post } = await serve();
  try {
    const r = await post('/api/crm/proxy/agent/notatool/cookies', { heartbeat: true });
    assert.strictEqual(r.status, 404);
    assert.strictEqual(r.body.code, 'unknown_tool');
  } finally { server.close(); }
});

test('a paired device makes ingest live again — no env variable involved', async () => {
  const acct = makeAccount();
  ACCOUNTS = [acct];
  const { code } = deviceSync.createPairingCode(acct, 'LOCAL-PC');
  const { server, post } = await serve();
  try {
    // Redeem the code exactly as the agent does.
    const paired = await post('/api/crm/proxy/agent/writehuman/pair', { code, hostname: 'LOCAL-PC' });
    assert.strictEqual(paired.status, 200);
    assert.match(paired.body.deviceKey, /^[0-9a-f]{64}$/);
    assert.ok(paired.body.deviceId);

    // Ingest now authenticates against the DB-held device, with PROXY_AGENT_SYNC_KEY still unset.
    assert.strictEqual(process.env.PROXY_AGENT_SYNC_KEY, undefined, 'no env key is in play');
    const hb = await post('/api/crm/proxy/agent/writehuman/cookies', { heartbeat: true },
      { 'x-device-id': paired.body.deviceId, 'x-agent-key': paired.body.deviceKey });
    assert.strictEqual(hb.status, 200);
    assert.strictEqual(hb.body.code, 'HEARTBEAT');
  } finally { server.close(); }
});

test('a wrong device key is refused, and is distinguishable from "not configured"', async () => {
  const acct = makeAccount();
  ACCOUNTS = [acct];
  const { code } = deviceSync.createPairingCode(acct, 'LOCAL-PC');
  const { server, post } = await serve();
  try {
    const paired = await post('/api/crm/proxy/agent/writehuman/pair', { code });
    const bad = await post('/api/crm/proxy/agent/writehuman/cookies', { heartbeat: true },
      { 'x-device-id': paired.body.deviceId, 'x-agent-key': 'f'.repeat(64) });
    assert.strictEqual(bad.status, 403);
    assert.strictEqual(bad.body.code, deviceSync.CODES.AUTH_INVALID);
  } finally { server.close(); }
});

test('a replayed sequence number is refused', async () => {
  const acct = makeAccount();
  ACCOUNTS = [acct];
  const { code } = deviceSync.createPairingCode(acct, 'LOCAL-PC');
  const { server, post } = await serve();
  try {
    const p = await post('/api/crm/proxy/agent/writehuman/pair', { code });
    const h = { 'x-device-id': p.body.deviceId, 'x-agent-key': p.body.deviceKey };
    const first = await post('/api/crm/proxy/agent/writehuman/cookies', { heartbeat: true, seq: 5 }, h);
    assert.strictEqual(first.status, 200);
    const replay = await post('/api/crm/proxy/agent/writehuman/cookies', { heartbeat: true, seq: 5 }, h);
    assert.strictEqual(replay.status, 409);
    assert.strictEqual(replay.body.code, deviceSync.CODES.REPLAY_REJECTED);
  } finally { server.close(); }
});

test('a revoked device cannot push, and a used pairing code cannot be redeemed twice', async () => {
  const acct = makeAccount();
  ACCOUNTS = [acct];
  const { code } = deviceSync.createPairingCode(acct, 'LOCAL-PC');
  const { server, post } = await serve();
  try {
    const p = await post('/api/crm/proxy/agent/writehuman/pair', { code });
    const again = await post('/api/crm/proxy/agent/writehuman/pair', { code });
    assert.strictEqual(again.status, 403);
    assert.strictEqual(again.body.code, deviceSync.CODES.PAIRING_CODE_USED);

    deviceSync.revokeDevice(acct, p.body.deviceId, { force: true });
    const push = await post('/api/crm/proxy/agent/writehuman/cookies', { heartbeat: true },
      { 'x-device-id': p.body.deviceId, 'x-agent-key': p.body.deviceKey });
    assert.strictEqual(push.status, 403);
    assert.strictEqual(push.body.code, deviceSync.CODES.DEVICE_REVOKED);
  } finally { server.close(); }
});

test('no response from the ingest endpoint ever carries a cookie value or a key', async () => {
  const acct = makeAccount();
  ACCOUNTS = [acct];
  const { code } = deviceSync.createPairingCode(acct, 'LOCAL-PC');
  const { server, post } = await serve();
  try {
    const p = await post('/api/crm/proxy/agent/writehuman/pair', { code });
    const hb = await post('/api/crm/proxy/agent/writehuman/cookies', { heartbeat: true },
      { 'x-device-id': p.body.deviceId, 'x-agent-key': p.body.deviceKey });
    const text = JSON.stringify(hb.body);
    assert.ok(!text.includes(p.body.deviceKey), 'the device key is never echoed back');
    assert.ok(!/sb-[a-z0-9]{10,}-auth-token/.test(text), 'no auth cookie name/value is returned');
  } finally { server.close(); }
});
