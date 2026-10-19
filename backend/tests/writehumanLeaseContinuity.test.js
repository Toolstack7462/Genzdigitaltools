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
verifyMod.verifyAccountCookies = async () => ({ result: 'working', httpStatus: 200, maskedId: 'op***@example.com', canary: 'passed' });
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

// ── the member's browser session is aligned to the vault by GENERATION, not by a marker ───────
//
// This used to be decided in the browser: the injected script read `__genz_sb` out of localStorage
// and skipped when it equalled `lease:fingerprint`. Two failures came out of that, and both look
// exactly like the 2026-10-18 report (source signed in, dashboard healthy, member on WriteHuman's
// own logged-out page):
//
//   · the whole seed hung off a localStorage READ inside a try/catch, so where storage on the
//     gateway origin is unavailable or throws the member was NEVER seeded, permanently;
//   · the marker describes what we last injected, not what the browser now holds, so a browser
//     that had drifted could be skipped — and one that had legitimately rotated AHEAD was
//     clobbered with the vault's older generation, logging a working member out.
//
// The decision is server-side now, from the access token's `iat` in the cookies the browser sent.
// The behavioural version of this runs the real gateway process against a mock backend and
// upstream: proxy-gateway/test/writehumanClientSessionAlignment.test.js (8 tests).
function loadInjector(enabled) {
  const src = fs.readFileSync(path.join(__dirname, '..', '..', 'proxy-gateway', 'server.js'), 'utf8').replace(/\r\n/g, '\n');
  const pick = (name) => {
    const start = src.indexOf(`function ${name}(`);
    assert.ok(start > 0, `${name} not found in proxy-gateway/server.js`);
    const end = src.indexOf('\n}\n', start) + 3;
    return src.slice(start, end);
  };
  const ctx = { crypto, SUPABASE_BROWSER_SESSION: enabled, safeLog() {}, JSON, String, Buffer, Number };
  vm.createContext(ctx);
  vm.runInContext(
    [pick('sbAuthCookiePairs'), pick('sbSessionIat'), pick('shouldAlignBrowserSession'), pick('injectSupabaseBrowserSession')].join('\n')
      + '\nthis.f = injectSupabaseBrowserSession; this.decide = shouldAlignBrowserSession;',
    ctx);
  return ctx;
}
const page = '<html><head></head><body></body></html>';
/** A real @supabase/ssr auth cookie whose access token was issued at `iat` (SIMULATED time). */
function sbHeader(iat) {
  const b64u = (o) => Buffer.from(JSON.stringify(o)).toString('base64').replace(/=+$/, '').replace(/\+/g, '-').replace(/\//g, '_');
  const at = `${b64u({ alg: 'HS256' })}.${b64u({ iat, exp: iat + 3600 })}.sig`;
  const json = JSON.stringify({ access_token: at, refresh_token: 'rt-' + iat });
  return `sb-${REF}-auth-token=base64-${Buffer.from(json).toString('base64')}; other=1`;
}
const sess = (iat) => ({ cookieHeader: sbHeader(iat) });
const seeded = (html) => /document\.cookie\s*=\s*C\[i\]\[0\]/.test(html);

test('the member is re-seeded when BEHIND the vault, and left alone when level or ahead', () => {
  const { f: inject, decide } = loadInjector(true);
  const ctx = { jti: 'lease1' };
  const behind = inject(page, sess(5600), ctx, { headers: { cookie: sbHeader(2000) } });
  const level = inject(page, sess(5600), ctx, { headers: { cookie: sbHeader(5600) } });
  const ahead = inject(page, sess(5600), ctx, { headers: { cookie: sbHeader(9200) } });
  const none = inject(page, sess(5600), ctx, { headers: {} });

  assert.ok(seeded(behind), 'a dead generation in the member\u2019s browser must be replaced');
  assert.ok(!seeded(level), 'the same generation is a no-op');
  assert.ok(!seeded(ahead), 'a newer in-browser session must NOT be clobbered with an older one');
  assert.ok(seeded(none), 'a member with no session is seeded');

  assert.strictEqual(decide(sbHeader(2000), sbHeader(5600)).reason, 'browser_behind_vault');
  assert.strictEqual(decide(sbHeader(9200), sbHeader(5600)).reason, 'browser_ahead_of_vault');
  assert.strictEqual(decide(sbHeader(5600), sbHeader(5600)).reason, 'same_generation');
  assert.strictEqual(decide('', sbHeader(5600)).reason, 'browser_has_no_readable_session');
});

test('no storage read-back can silence the seed, and no cookie value is emitted as a marker', () => {
  const { f: inject } = loadInjector(true);
  const html = inject(page, sess(5600), { jti: 'lease1' }, { headers: { cookie: sbHeader(2000) } });
  assert.ok(!/localStorage\.getItem/.test(html), 'the seed must not depend on reading storage back');
  assert.ok(!html.includes('rt-5600'), 'no refresh token in the page');
});

test('the same stale generation is re-seeded on EVERY load, not once per lease', () => {
  const { f: inject } = loadInjector(true);
  const ctx = { jti: 'lease-same' };
  const a = inject(page, sess(5600), ctx, { headers: { cookie: sbHeader(2000) } });
  const b = inject(page, sess(5600), ctx, { headers: { cookie: sbHeader(2000) } });
  assert.ok(seeded(a) && seeded(b));
});

test('browser-session injection stays a no-op for every tool that has not opted in', () => {
  const { f: inject } = loadInjector(false);
  assert.strictEqual(inject(page, sess(5600), { jti: 'lease1' }, { headers: { cookie: sbHeader(2000) } }), page);
});
