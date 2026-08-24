'use strict';
/**
 * The pre-multi-device shared key (PROXY_AGENT_SYNC_KEY): what it can and cannot do.
 *
 * The rollout plan is to leave it UNSET and pair devices instead, because a single shared env var
 * is exactly what failed: losing it disabled the whole pipeline for 38 days, and it authenticates
 * "some agent somewhere" rather than a specific machine. But the variable is still supported for
 * the already-deployed agent, so its behaviour has to be pinned rather than assumed.
 *
 * Two properties matter. An old agent presenting the shared key is adopted as a REAL device row, so
 * it goes through the same candidate/verify/promote pipeline as everything else and cannot write
 * straight to the vault. And a rejected push — wrong key, revoked device, replayed sequence —
 * leaves the stored session untouched, which is the guarantee the whole rollout rests on.
 *
 * This lives in its own file because the router reads the env var once at module load, so it cannot
 * share a process with the tests that assert the unset case.
 */
const test = require('node:test');
const assert = require('node:assert');
const crypto = require('crypto');
const http = require('http');

const LEGACY_KEY = 'a'.repeat(64);
process.env.PROXY_VAULT_KEY = process.env.PROXY_VAULT_KEY || crypto.randomBytes(32).toString('hex');
process.env.PROXY_AGENT_SYNC_KEY = LEGACY_KEY;      // the condition under test
delete process.env.PROXY_AGENT_SYNC_ALLOW_IPS;

const modelPath = require.resolve('../models/proxy/ProxyAccount');
let ACCOUNTS = [];
require.cache[modelPath] = {
  id: modelPath, filename: modelPath, loaded: true,
  exports: { find: async () => ACCOUNTS },
};
require('../utils/proxy/healthAlerts').onVerifyApplied = async () => {};
// No network: a candidate that reaches verification would otherwise call Supabase.
require('../utils/proxy/verify').verifyAccountCookies = async () => ({ result: 'working', httpStatus: 200, maskedId: 'op***@example.com' });

const express = require('express');
const deviceSync = require('../utils/proxy/deviceSync');
const vaultCrypto = require('../utils/proxy/vaultCrypto');
const router = require('../routes/proxy/agentSync');

const REF = 'hicfsbrfkzsxbwayibfm';

function jwt(iat) {
  const b64 = (o) => Buffer.from(JSON.stringify(o)).toString('base64').replace(/=+$/, '');
  return b64({ alg: 'HS256' }) + '.' + b64({ iat, exp: iat + 3600, session_id: 'sess-X' }) + '.sig';
}
function cookies(iat) {
  const payload = JSON.stringify({ access_token: jwt(iat), refresh_token: 'rt', user: { email: 'operator@example.com' } });
  return [{ name: 'sb-' + REF + '-auth-token', value: 'base64-' + Buffer.from(payload).toString('base64'), domain: '.writehuman.ai', path: '/' }];
}
function makeAccount() {
  const a = {
    _id: 'acct1', tool: 'writehuman', isPrimary: true, label: 'WriteHuman',
    status: 'active', session_status: 'working',
    verification: { result: 'working', maskedId: 'op***@example.com', httpStatus: 200 },
    save() { return Promise.resolve(this); },
  };
  a.sessionEncrypted = vaultCrypto.encrypt(JSON.stringify({ cookies: cookies(1000) }));
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

test('an agent with NO key is refused even while the shared key is configured', async () => {
  const acct = makeAccount();
  ACCOUNTS = [acct];
  const before = acct.sessionEncrypted;
  const { server, post } = await serve();
  try {
    const r = await post('/api/crm/proxy/agent/writehuman/cookies', { cookies: cookies(9000) });
    assert.strictEqual(r.status, 403);
    assert.strictEqual(r.body.code, deviceSync.CODES.AUTH_INVALID);
    assert.strictEqual(acct.sessionEncrypted, before, 'a refused push never touches the vault');
  } finally { server.close(); }
});

test('a WRONG key is refused and cannot overwrite the active bundle', async () => {
  const acct = makeAccount();
  ACCOUNTS = [acct];
  const before = acct.sessionEncrypted;
  const { server, post } = await serve();
  try {
    const r = await post('/api/crm/proxy/agent/writehuman/cookies', { cookies: cookies(9000) }, { 'x-agent-key': 'b'.repeat(64) });
    assert.strictEqual(r.status, 403);
    assert.strictEqual(acct.sessionEncrypted, before);
    assert.strictEqual(acct.session_status, 'working', 'and never downgrades the session');
  } finally { server.close(); }
});

test('the legacy shared key is adopted as a real device row, not a bypass', async () => {
  const acct = makeAccount();
  ACCOUNTS = [acct];
  const { server, post } = await serve();
  try {
    const r = await post('/api/crm/proxy/agent/writehuman/cookies', { heartbeat: true }, { 'x-agent-key': LEGACY_KEY });
    assert.strictEqual(r.status, 200);
    const devices = deviceSync.getDevices(acct);
    assert.strictEqual(devices.length, 1, 'it appears in the device registry like any other machine');
    assert.strictEqual(devices[0].deviceId, 'dev_legacy');
    assert.ok(devices[0].keyHash, 'stored as a hash');
    assert.ok(!JSON.stringify(devices).includes(LEGACY_KEY), 'the raw key is never persisted');
  } finally { server.close(); }
});

test('a legacy push still goes through candidate verification before it can promote', async () => {
  const acct = makeAccount();
  ACCOUNTS = [acct];
  const { server, post } = await serve();
  try {
    const r = await post('/api/crm/proxy/agent/writehuman/cookies', { cookies: cookies(9000) }, { 'x-agent-key': LEGACY_KEY });
    assert.strictEqual(r.status, 200);
    assert.strictEqual(r.body.code, deviceSync.CODES.PROMOTED);
    // It promoted only because the stubbed verification PASSED. The point is that it took the same
    // route as a paired device: staged, verified, then promoted — never a direct vault write.
    assert.ok(acct.candidate, 'a candidate record exists');
    assert.strictEqual(acct.candidate.status, 'promoted');
    assert.ok(acct.rollbackBundles && acct.rollbackBundles.length >= 1, 'the previous bundle is kept for rollback');
  } finally { server.close(); }
});

test('once revoked, the legacy agent fails closed and the session is untouched', async () => {
  const acct = makeAccount();
  ACCOUNTS = [acct];
  const { server, post } = await serve();
  try {
    await post('/api/crm/proxy/agent/writehuman/cookies', { heartbeat: true }, { 'x-agent-key': LEGACY_KEY });
    deviceSync.revokeDevice(acct, 'dev_legacy', { force: true });
    const before = acct.sessionEncrypted;

    const r = await post('/api/crm/proxy/agent/writehuman/cookies', { cookies: cookies(9500) }, { 'x-agent-key': LEGACY_KEY });
    assert.strictEqual(r.status, 403);
    assert.strictEqual(r.body.code, deviceSync.CODES.DEVICE_REVOKED);
    assert.strictEqual(acct.sessionEncrypted, before,
      'revoking the old agent stops it writing WITHOUT disturbing the session it last supplied');
  } finally { server.close(); }
});
