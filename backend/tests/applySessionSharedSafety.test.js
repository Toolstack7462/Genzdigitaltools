'use strict';
/**
 * applySession.js is the SHARED vault-write path for every proxy tool — hix, bypassgpt, ryne,
 * chatgpt, grok, claude and writehuman all reach it through the admin "Refresh session" route.
 * A WriteHuman change landing here is a change to all of them, so this pins the blast radius.
 *
 * The specific risk: `cookieHash` is meaningful only where a paired device compares its cookies
 * against it. The other tools have no project ref, so an unguarded write would put `null` on their
 * accounts — harmless in effect, but a shared behaviour change made for no reason, and exactly the
 * kind of thing that is invisible until something downstream starts trusting the field.
 *
 * These tests assert the write happens for WriteHuman and for nothing else, and that every other
 * field applyAccountSession sets behaves identically across tools.
 */
const test = require('node:test');
const assert = require('node:assert');
const crypto = require('crypto');

process.env.PROXY_VAULT_KEY = process.env.PROXY_VAULT_KEY || crypto.randomBytes(32).toString('hex');

// Neither the network verifier nor the lease store may be touched by a unit test.
const verifyMod = require('../utils/proxy/verify');
verifyMod.verifyAccountCookies = async () => ({ result: 'working', httpStatus: 200, maskedId: 'op***@example.com' });
const leasePath = require.resolve('../models/proxy/ProxyLease');
require.cache[leasePath] = {
  id: leasePath, filename: leasePath, loaded: true,
  exports: { updateMany: async () => ({ modifiedCount: 0 }) },
};
const logPath = require.resolve('../models/ActivityLog');
require.cache[logPath] = { id: logPath, filename: logPath, loaded: true, exports: { log: async () => {} } };
const alerts = require('../utils/proxy/healthAlerts');
alerts.onVerifyApplied = async () => {};

const tools = require('../utils/proxy/tools');
const { applyAccountSession } = require('../utils/proxy/applySession');
const { authCookieHash } = require('../utils/proxy/cookies');
const vaultCrypto = require('../utils/proxy/vaultCrypto');

const WH_REF = 'hicfsbrfkzsxbwayibfm';
const OTHER_TOOLS = ['hix', 'bypassgpt', 'ryne', 'chatgpt', 'grok', 'claude'];

function account(tool) {
  return {
    _id: 'acct-' + tool, tool, label: tool, isPrimary: true,
    status: 'active', session_status: 'working',
    verification: { result: 'working', maskedId: 'op***@example.com', httpStatus: 200 },
    save() { return Promise.resolve(this); },
  };
}
/** A bundle carrying a WriteHuman-shaped Supabase auth cookie plus an ordinary one. */
function bundle(host) {
  return {
    cookies: [
      { name: 'sb-' + WH_REF + '-auth-token', value: 'base64-abc', domain: '.' + host, path: '/' },
      { name: 'other', value: 'x', domain: '.' + host, path: '/' },
    ],
    origin: 'https://' + host,
  };
}

test('exactly one tool is a live-agent tool, so the gate is provably narrow', () => {
  const live = ['hix', 'bypassgpt', 'ryne', 'chatgpt', 'grok', 'claude', 'writehuman']
    .filter(t => tools.hasLiveAgent(t));
  assert.deepStrictEqual(live, ['writehuman'], 'if another tool ever gains liveAgent, revisit this gate');
});

test('WriteHuman: the admin write path records a hash of the bundle it stored', async () => {
  const a = account('writehuman');
  await applyAccountSession(a, bundle(tools.targetHost('writehuman')), { tool: 'writehuman' });
  const stored = JSON.parse(vaultCrypto.decrypt(a.sessionEncrypted));
  assert.ok(a.cookieHash, 'a hash is written');
  assert.strictEqual(a.cookieHash, authCookieHash(stored, WH_REF), 'and it describes what was stored');
});

test('every other tool is left byte-for-byte unchanged in behaviour', async () => {
  for (const tool of OTHER_TOOLS) {
    const a = account(tool);
    const before = Object.keys(a).sort().join(',');
    await applyAccountSession(a, bundle(tools.targetHost(tool)), { tool });

    assert.ok(!('cookieHash' in a), `${tool}: no cookieHash field may be introduced`);
    // The rest of the contract must still hold for these tools.
    assert.ok(a.sessionEncrypted, `${tool}: bundle encrypted`);
    assert.ok(a.sessionMeta && a.sessionMeta.updatedAt, `${tool}: meta rebuilt`);
    assert.strictEqual(a.session_status, 'working', `${tool}: verify result applied`);
    const after = Object.keys(a).sort().join(',');
    assert.notStrictEqual(before, after, `${tool}: sanity — the function did run`);
  }
});

test('a pre-existing cookieHash on another tool is never clobbered', async () => {
  // Defensive: the old ingest route was mounted for any tool, so a stray hash could exist.
  const a = account('hix');
  a.cookieHash = 'preexisting-value';
  await applyAccountSession(a, bundle(tools.targetHost('hix')), { tool: 'hix' });
  assert.strictEqual(a.cookieHash, 'preexisting-value', 'another tool\'s stored value is left alone');
});

test('the shared write path still returns the same shape for every tool', async () => {
  for (const tool of OTHER_TOOLS.concat(['writehuman'])) {
    const a = account(tool);
    const r = await applyAccountSession(a, bundle(tools.targetHost(tool)), { tool });
    assert.ok(r && typeof r === 'object', `${tool}: returns a result`);
    for (const k of ['verifyResult', 'warning', 'revokedLeases', 'cookieNames', 'maskedId']) {
      assert.ok(k in r, `${tool}: result keeps the key '${k}'`);
    }
  }
});

test('a bundle with no auth cookie still stores, and WriteHuman records a null hash honestly', async () => {
  const a = account('writehuman');
  await applyAccountSession(a, { cookies: [{ name: 'plain', value: '1', domain: '.writehuman.ai', path: '/' }] }, { tool: 'writehuman' });
  assert.ok(a.sessionEncrypted, 'the bundle is still stored');
  assert.strictEqual(a.cookieHash, null, 'no auth cookie means no hash — not a stale one');
});
