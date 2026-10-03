'use strict';
/**
 * WriteHuman: a routine provider-token rotation must NOT end a member's Gen Z access.
 *
 * THE DEFECT (production, 2026-09-26..10-03): the live Cookie Sync Agent promotes the
 * account's rotated Supabase tokens roughly hourly. Each promotion revoked every in-flight
 * lease on the account (`revokedReason: 'agent_sync'`). /validate treats `revoked` as TERMINAL
 * (`lease_revoked`), so the overlay showed "Your access session ended" and froze the countdown
 * at the time still left — e.g. "20:09" of a 30-minute lease. 125 of 158 WriteHuman leases in a
 * week were revoked this way, 44 of them with 1–30 minutes remaining, in hourly clusters.
 *
 * Revocation was never needed for the new cookies to reach a live session: the gateway caches
 * a lease's session for 60 s and /session re-reads the account's CURRENT vault bundle. The
 * browser-side Supabase session is now re-injected when its fingerprint changes.
 *   node --test backend/tests/writehumanLeaseContinuity.test.js
 */
const test = require('node:test');
const assert = require('node:assert');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

process.env.PROXY_VAULT_KEY = process.env.PROXY_VAULT_KEY || crypto.randomBytes(32).toString('hex');

// --- stubs installed BEFORE the units capture them ---------------------------------------------
// Lease store: a spy. Pre-fix candidateSync required this module, so the spy saw its revocations.
const leaseCalls = [];
const leasePath = require.resolve('../models/proxy/ProxyLease');
require.cache[leasePath] = {
  id: leasePath, filename: leasePath, loaded: true,
  exports: { updateMany: async (q, u) => { leaseCalls.push({ q, u }); return { modifiedCount: 1 }; } },
};
const logPath = require.resolve('../models/ActivityLog');
require.cache[logPath] = { id: logPath, filename: logPath, loaded: true, exports: { log: async () => {} } };
const verifyMod = require('../utils/proxy/verify');
verifyMod.verifyAccountCookies = async () => ({ result: 'working', httpStatus: 200, maskedId: 'op***@example.com' });
require('../utils/proxy/healthAlerts').onVerifyApplied = async () => {};

const deviceSync = require('../utils/proxy/deviceSync');
const { ingestCandidate } = require('../utils/proxy/candidateSync');
const { applyAccountSession } = require('../utils/proxy/applySession');
const { authCookieHash } = require('../utils/proxy/cookies');
const vaultCrypto = require('../utils/proxy/vaultCrypto');

const TOOL = 'writehuman';
const REF = 'hicfsbrfkzsxbwayibfm';
const { CODES } = deviceSync;

function jwt(iat, sid) {
  const b64 = (o) => Buffer.from(JSON.stringify(o)).toString('base64').replace(/=+$/, '').replace(/\+/g, '-').replace(/\//g, '_');
  return b64({ alg: 'HS256' }) + '.' + b64({ iat, exp: iat + 3600, email: 'operator@example.com', session_id: sid }) + '.sig';
}
// Same GoTrue session, newer token = a routine ROTATION (what the agent pushes hourly).
function bundle(iat, sid = 'sess-A') {
  const payload = JSON.stringify({ access_token: jwt(iat, sid), refresh_token: 'rt-' + iat, user: { email: 'operator@example.com' } });
  return { cookies: [{ name: 'sb-' + REF + '-auth-token', value: 'base64-' + Buffer.from(payload).toString('base64'), domain: '.writehuman.ai', path: '/', secure: true, httpOnly: false, sameSite: 'lax' }], origin: 'https://writehuman.ai' };
}
function account(initial) {
  return {
    _id: 'acct1', tool: TOOL, label: 'WriteHuman', isPrimary: true, status: 'active', session_status: 'working',
    verification: { result: 'working', maskedId: 'op***@example.com', httpStatus: 200, checkedAt: new Date() },
    sessionEncrypted: vaultCrypto.encrypt(JSON.stringify(initial)), cookieHash: authCookieHash(initial, REF), bundleVersion: 1,
    save() { return Promise.resolve(this); },
  };
}
function pair(acct, name) {
  const { code } = deviceSync.createPairingCode(acct, name);
  const r = deviceSync.redeemPairingCode(acct, code, { hostname: name });
  return deviceSync.findDevice(acct, r.deviceId);
}
const revocations = () => leaseCalls.filter(c => c.u && c.u.$set && c.u.$set.revoked === true);

// ── the proven cause ──────────────────────────────────────────────────────────────────────────
test('an hourly token rotation is promoted WITHOUT revoking any live lease', async () => {
  leaseCalls.length = 0;
  const a = account(bundle(1000));
  const dev = pair(a, 'RDP-PC');
  await ingestCandidate(a, TOOL, dev, bundle(2000).cookies, {});           // the device becomes the source
  leaseCalls.length = 0;
  const r = await ingestCandidate(a, TOOL, dev, bundle(5600).cookies, {}); // +1 h rotation, bytes differ
  assert.strictEqual(r.code, CODES.PROMOTED);
  assert.strictEqual(r.changed, true, 'the bundle really changed — this is the case that used to revoke');
  assert.strictEqual(revocations().length, 0, 'a routine rotation must not end members\' access (no lease revoked)');
  assert.strictEqual(deviceSync.bundleTokenIat(JSON.parse(vaultCrypto.decrypt(a.sessionEncrypted)), TOOL), 5600,
    'the new cookies are still stored, so the gateway serves them on its next 60 s session refresh');
});

test('several rotations in a row, and an identical re-push, never revoke', async () => {
  const a = account(bundle(1000));
  const dev = pair(a, 'RDP-PC');
  await ingestCandidate(a, TOOL, dev, bundle(2000).cookies, {});
  leaseCalls.length = 0;
  for (const iat of [5600, 9200, 12800]) await ingestCandidate(a, TOOL, dev, bundle(iat).cookies, {});
  await ingestCandidate(a, TOOL, dev, bundle(12800).cookies, {});            // duplicate delivery
  assert.strictEqual(revocations().length, 0);
});

// ── legitimate restrictions are preserved ─────────────────────────────────────────────────────
test('the admin "Refresh session" action still revokes in-flight leases', async () => {
  leaseCalls.length = 0;
  const a = account(bundle(1000));
  const r = await applyAccountSession(a, bundle(9000), { tool: TOOL });
  assert.strictEqual(revocations().length, 1, 'an explicit admin session replacement still ends current leases');
  assert.strictEqual(revocations()[0].u.$set.revokedReason, 'session_refreshed');
  assert.strictEqual(r.revokedLeases, 1);
});

// ── browser-side Supabase session follows a rotation within the same lease ─────────────────────
function loadInjector(enabled) {
  const src = fs.readFileSync(path.join(__dirname, '..', '..', 'proxy-gateway', 'server.js'), 'utf8').replace(/\r\n/g, '\n');
  const start = src.indexOf('function injectSupabaseBrowserSession(');
  const end = src.indexOf('\n}\n', start) + 3;
  assert.ok(start > 0 && end > start, 'injectSupabaseBrowserSession not found in proxy-gateway/server.js');
  const ctx = { crypto, SUPABASE_BROWSER_SESSION: enabled, safeLog() {}, JSON, String };
  vm.createContext(ctx);
  vm.runInContext(src.slice(start, end) + '\nthis.f = injectSupabaseBrowserSession;', ctx);
  return ctx.f;
}
const marker = (html) => { const m = /var K="__genz_sb",J="([^"]+)"/.exec(html); return m && m[1]; };
const page = '<html><head></head><body></body></html>';
const sess = (v) => ({ cookieHeader: 'sb-' + REF + '-auth-token=' + v + '; other=1' });

test('gateway re-injects the browser session when the vault cookies rotate, not otherwise', () => {
  const inject = loadInjector(true);
  const a1 = marker(inject(page, sess('token-A'), { jti: 'lease1' }));
  const a2 = marker(inject(page, sess('token-A'), { jti: 'lease1' }));
  const b = marker(inject(page, sess('token-B'), { jti: 'lease1' }));
  assert.ok(a1 && a1.startsWith('lease1:'), 'marker is bound to the lease');
  assert.strictEqual(a1, a2, 'same lease + unchanged cookies → same marker → no re-injection');
  assert.notStrictEqual(a1, b, 'same lease + rotated cookies → new marker → the page picks up the fresh session');
  assert.ok(!a1.includes('token-A') && !b.includes('token-B'), 'the marker is a hash, never a cookie value');
});

test('browser-session injection stays a no-op for every tool that has not opted in', () => {
  const inject = loadInjector(false);
  assert.strictEqual(inject(page, sess('token-A'), { jti: 'lease1' }), page);
});
