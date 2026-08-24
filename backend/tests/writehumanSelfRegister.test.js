'use strict';
/**
 * Zero-touch enrolment: an agent registers itself with the shared bootstrap key, is issued its own
 * per-agent key on that first request, and can claim the active source once.
 *
 * The property worth stating plainly, because it is what makes dropping manual pairing acceptable:
 * self-registration relaxes ONLY enrolment. Everything protecting the live session sits downstream
 * and is unchanged - the candidate is still staged, still verified against the expected account,
 * still promoted atomically with a rollback kept. Someone holding the shared key can enrol an agent
 * and OFFER cookies; they cannot replace a working session with cookies that do not authenticate as
 * the right account.
 *
 * Runs against the real Express router with the model stubbed. No database, no network.
 */
const test = require('node:test');
const assert = require('node:assert');
const crypto = require('crypto');
const http = require('http');

const SHARED = 'c'.repeat(64);
process.env.PROXY_VAULT_KEY = process.env.PROXY_VAULT_KEY || crypto.randomBytes(32).toString('hex');
process.env.PROXY_AGENT_SYNC_KEY = SHARED;
delete process.env.PROXY_AGENT_SYNC_ALLOW_IPS;

const modelPath = require.resolve('../models/proxy/ProxyAccount');
let ACCOUNTS = [];
require.cache[modelPath] = { id: modelPath, filename: modelPath, loaded: true, exports: { find: async () => ACCOUNTS } };
require('../utils/proxy/healthAlerts').onVerifyApplied = async () => {};
let VERIFY = { result: 'working', httpStatus: 200, maskedId: 'op***@example.com' };
require('../utils/proxy/verify').verifyAccountCookies = async () => VERIFY;

const express = require('express');
const deviceSync = require('../utils/proxy/deviceSync');
const vaultCrypto = require('../utils/proxy/vaultCrypto');
const router = require('../routes/proxy/agentSync');

const REF = 'hicfsbrfkzsxbwayibfm';
function jwt(iat, sid) {
  const b64 = (o) => Buffer.from(JSON.stringify(o)).toString('base64').replace(/=+$/, '');
  return b64({ alg: 'HS256' }) + '.' + b64({ iat, exp: iat + 3600, session_id: sid || 'sess-A' }) + '.sig';
}
function cookies(iat, sid) {
  const payload = JSON.stringify({ access_token: jwt(iat, sid), refresh_token: 'rt', user: { email: 'operator@example.com' } });
  return [{ name: 'sb-' + REF + '-auth-token', value: 'base64-' + Buffer.from(payload).toString('base64'), domain: '.writehuman.ai', path: '/' }];
}
function makeAccount(iat) {
  const a = {
    _id: 'acct1', tool: 'writehuman', isPrimary: true, label: 'WriteHuman',
    status: 'active', session_status: 'working',
    verification: { result: 'working', maskedId: 'op***@example.com', httpStatus: 200 },
    save() { return Promise.resolve(this); },
  };
  a.sessionEncrypted = vaultCrypto.encrypt(JSON.stringify({ cookies: cookies(iat || 1000) }));
  return a;
}
function serve() {
  const app = express();
  app.use('/api/crm/proxy/agent', router);
  const server = http.createServer(app);
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const port = server.address().port;
      resolve({
        server,
        async post(body, headers) {
          const res = await fetch(`http://127.0.0.1:${port}/api/crm/proxy/agent/writehuman/cookies`, {
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
const AGENT = 'agent_' + 'a'.repeat(32);
function hdr(id, key) { return { 'x-agent-id': id, 'x-agent-key': key || SHARED }; }

test('an unknown agent enrols itself on first contact - no code, no approval', async () => {
  const acct = makeAccount();
  ACCOUNTS = [acct];
  const { server, post } = await serve();
  try {
    const r = await post({ heartbeat: true, agent: { host: 'OFFICE-PC', version: '3.1.0' } }, hdr(AGENT));
    assert.strictEqual(r.status, 200);
    const devs = deviceSync.getDevices(acct);
    assert.strictEqual(devs.length, 1, 'the agent appears in the registry immediately');
    assert.strictEqual(devs[0].deviceId, AGENT);
    assert.strictEqual(devs[0].autoRegistered, true);
    assert.strictEqual(devs[0].name, 'OFFICE-PC', 'it names itself from its own hostname');
  } finally { server.close(); }
});

test('enrolment issues a per-agent key exactly once, and only as a hash on the server', async () => {
  const acct = makeAccount();
  ACCOUNTS = [acct];
  const { server, post } = await serve();
  try {
    const first = await post({ heartbeat: true, agent: { host: 'OFFICE-PC' } }, hdr(AGENT));
    assert.match(first.body.issuedDeviceKey || '', /^[0-9a-f]{64}$/, 'a key is issued on enrolment');
    assert.strictEqual(first.body.deviceId, AGENT);
    const issued = first.body.issuedDeviceKey;
    assert.ok(!JSON.stringify(deviceSync.getDevices(acct)).includes(issued), 'stored as a hash, never in the clear');

    // Second contact must NOT re-issue - the agent already has its credential.
    const second = await post({ heartbeat: true }, hdr(AGENT));
    assert.strictEqual(second.status, 200);
    assert.strictEqual(second.body.issuedDeviceKey, undefined, 'issued once, not on every request');

    // And the issued key authenticates on its own, without the shared key.
    const third = await post({ heartbeat: true }, { 'x-device-id': AGENT, 'x-agent-key': issued });
    assert.strictEqual(third.status, 200, 'the agent can now authenticate as itself');
  } finally { server.close(); }
});

test('a wrong shared key enrols nothing and cannot touch the session', async () => {
  const acct = makeAccount();
  ACCOUNTS = [acct];
  const before = acct.sessionEncrypted;
  const { server, post } = await serve();
  try {
    const r = await post({ cookies: cookies(9000) }, hdr('agent_' + 'b'.repeat(32), 'd'.repeat(64)));
    assert.strictEqual(r.status, 403);
    assert.strictEqual(deviceSync.getDevices(acct).length, 0, 'no registry entry from a bad key');
    assert.strictEqual(acct.sessionEncrypted, before, 'the working bundle is untouched');
  } finally { server.close(); }
});

test('a self-registered agent claims the source once on its first verified sync', async () => {
  const acct = makeAccount(1000);
  ACCOUNTS = [acct];
  const { server, post } = await serve();
  try {
    // Same session id as the active bundle - the copied-cookie case. Only the first-verified-sync
    // claim can authorise this; hash and session id say "routine".
    const r = await post({ cookies: cookies(5000, 'sess-A'), agent: { host: 'OFFICE-PC' } }, hdr(AGENT));
    assert.strictEqual(r.status, 200);
    assert.strictEqual(r.body.code, deviceSync.CODES.PROMOTED);
    assert.strictEqual(acct.activeSource.deviceId, AGENT, 'it became the active source');
    assert.ok(acct.bundleVersion > 0);
    assert.ok(acct.rollbackBundles.length >= 1, 'the previous bundle is retained for rollback');
  } finally { server.close(); }
});

test('a wrong-account candidate is rejected and the working bundle survives', async () => {
  const acct = makeAccount(1000);
  ACCOUNTS = [acct];
  const before = acct.sessionEncrypted;
  const { server, post } = await serve();
  try {
    VERIFY = { result: 'wrong_account', httpStatus: 200, maskedId: 'ot***@example.com' };
    const r = await post({ cookies: cookies(9000, 'sess-Z'), agent: { host: 'OFFICE-PC' } }, hdr(AGENT));
    assert.strictEqual(r.body.code, deviceSync.CODES.ACCOUNT_MISMATCH);
    assert.strictEqual(acct.sessionEncrypted, before, 'a self-registered agent cannot hijack the account');
    assert.strictEqual(acct.session_status, 'working');
  } finally {
    VERIFY = { result: 'working', httpStatus: 200, maskedId: 'op***@example.com' };
    server.close();
  }
});

test('a revoked agent cannot re-register itself under the same id', async () => {
  const acct = makeAccount();
  ACCOUNTS = [acct];
  const { server, post } = await serve();
  try {
    await post({ heartbeat: true, agent: { host: 'OFFICE-PC' } }, hdr(AGENT));
    deviceSync.revokeDevice(acct, AGENT, { force: true });
    const r = await post({ heartbeat: true }, hdr(AGENT));
    assert.strictEqual(r.status, 403);
    assert.strictEqual(r.body.code, deviceSync.CODES.DEVICE_REVOKED, 'revocation outlives the shared key');
  } finally { server.close(); }
});

test('a malformed agent id is refused rather than creating junk rows', async () => {
  const acct = makeAccount();
  ACCOUNTS = [acct];
  const { server, post } = await serve();
  try {
    // Too short, whitespace, path traversal: all refused outright.
    for (const bad of ['x', 'has spaces here', '../../etc/passwd']) {
      const r = await post({ heartbeat: true }, { 'x-agent-id': bad, 'x-agent-key': SHARED });
      assert.notStrictEqual(r.status, 200, `id ${JSON.stringify(bad)} must not enrol`);
    }
    // An EMPTY header is not a malformed id - it means "no agent id", which is the pre-multi-device
    // agent. That is deliberately accepted and adopted under one fixed row so the old agent still
    // goes through the candidate pipeline instead of getting a bypass.
    const legacy = await post({ heartbeat: true }, { 'x-agent-id': '', 'x-agent-key': SHARED });
    assert.strictEqual(legacy.status, 200, 'the pre-multi-device agent is still accepted');

    const rows = deviceSync.getDevices(acct).map(d => d.deviceId);
    assert.deepStrictEqual(rows, ['agent_legacy_shared'], 'only the legacy row exists - no junk from malformed ids');
  } finally { server.close(); }
});
