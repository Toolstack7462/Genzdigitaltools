'use strict';
/**
 * WriteHuman telemetry honesty — the 2026-10-05 incident.
 *
 * What the operator saw: "live" · health degraded · Session REFRESHING · Agent OFFLINE ·
 * Cookie sync FAILED · telemetry ~2 h old, and the sentence "The access token is rotating. The
 * stored session is still valid — no action needed."
 *
 * What the server record proved (read-only audit): the active source WIN-K0R6CCFHB4L last reported
 * at 07:12Z with a candidate whose access token had already EXPIRED (last good bundle 02:21Z), so
 * the server correctly refused it (VERIFICATION_INCONCLUSIVE). Nothing was rotating the token — the
 * source's Chrome is the sole rotator and the source had gone silent; server refresh is off. The
 * "rotating / still valid / no action needed" sentence claimed a rotation that was not happening
 * and a validity nobody had proven, for hours.
 *
 * These tests pin the honest version, without inventing expiry in the other direction:
 *   A. classification   — REFRESHING only while something can actually rotate; otherwise STALLED.
 *   B. sync outcome      — FAILED comes from the ACTIVE source's real sync outcomes; a heartbeat or
 *                          a standby's refusal can neither set nor clear it.
 *   C. command delivery  — a reply the agent will not act on must not spend a command.
 */
const test = require('node:test');
const assert = require('node:assert');
const crypto = require('crypto');

process.env.PROXY_VAULT_KEY = process.env.PROXY_VAULT_KEY || crypto.randomBytes(32).toString('hex');

const { deriveHealth, deriveLifecycle } = require('../utils/proxy/sessionHealth');

// ── A. classification ──────────────────────────────────────────────────────────────────────────
const healthy = {
  hasBundle: true, sessionStatus: 'working', browserAuthCookies: 1, tokenExpired: false,
  refreshTokenPresent: true, lastVerifyResult: 'working', verificationAgeSec: 120,
  verificationDueSec: 20 * 60, agentStale: false, agentSeenSec: 60, agentStaleSec: 10 * 60,
  devicesPaired: 1, onlineDeviceCount: 1, cdpConnected: true, ingestConfigured: true,
  cookieSyncAgeSec: 300, cookieSyncStaleSec: 90 * 60, lastSyncFailed: false,
};
// The exact incident snapshot: source silent ~3 h, last good bundle ~7.7 h old, token expired,
// last push refused, latest verification "unknown" (not proof of anything).
const incident = {
  ...healthy, tokenExpired: true, browserAuthCookies: null, lastVerifyResult: 'unknown',
  verificationAgeSec: 11 * 60, agentStale: true, agentSeenSec: 176 * 60, onlineDeviceCount: 0,
  cdpConnected: null, cookieSyncAgeSec: 467 * 60, lastSyncFailed: true,
};
const H = (o) => deriveHealth({ ...healthy, ...o });
const CLAIMS = /still valid|no action needed|is rotating/i;

test('INCIDENT: an expired token with NOTHING able to rotate it is STALLED, not "rotating — no action needed"', () => {
  const h = deriveHealth(incident);
  assert.strictEqual(h.session.state, 'STALLED');
  assert.doesNotMatch(h.session.reason, CLAIMS, 'must not claim a rotation or a validity nobody proved');
  assert.match(h.session.reason, /not reporting|cannot rotate|nothing is renewing/i);
  // ...and it must not swing to the opposite lie either: stale telemetry is not proof of logout.
  assert.strictEqual(h.session.loginRequired, false);
  assert.notStrictEqual(h.session.state, 'LOGIN_REQUIRED');
  assert.strictEqual(h.agent.state, 'OFFLINE');
  assert.strictEqual(h.chrome.state, 'UNKNOWN');
  assert.strictEqual(h.cookieSync.state, 'FAILED');
  assert.strictEqual(h.verification.state, 'due');
});

test('expired token + live rotator (agent online, Chrome connected, sync current) stays REFRESHING — without claiming validity', () => {
  const h = H({ tokenExpired: true });
  assert.strictEqual(h.session.state, 'REFRESHING');
  assert.doesNotMatch(h.session.reason, /still valid|no action needed/i);
  assert.strictEqual(h.session.loginRequired, false);
});

test('expired token + agent online but Chrome DISCONNECTED: nothing can rotate → STALLED', () => {
  const h = H({ tokenExpired: true, cdpConnected: false });
  assert.strictEqual(h.agent.state, 'ONLINE', 'agent liveness is independent of the browser');
  assert.strictEqual(h.chrome.state, 'DISCONNECTED');
  assert.strictEqual(h.session.state, 'STALLED');
  assert.strictEqual(h.session.loginRequired, false);
});

test('expired token + rotator nominally live but cookies past the CONFIGURED sync limit → STALLED (rotation overdue)', () => {
  const h = H({ tokenExpired: true, cookieSyncAgeSec: 91 * 60, cookieSyncStaleSec: 90 * 60 });
  assert.strictEqual(h.cookieSync.state, 'BEHIND');
  assert.strictEqual(h.session.state, 'STALLED');
  assert.match(h.session.reason, /overdue/i);
});

test('telemetry loss ALONE does not expire or degrade a session whose token is still valid', () => {
  const h = H({ agentStale: true, agentSeenSec: 3 * 3600, onlineDeviceCount: 0, cdpConnected: null, browserAuthCookies: null });
  assert.strictEqual(h.session.state, 'HEALTHY');
  assert.strictEqual(h.agent.state, 'OFFLINE');
});

test('confirmed provider auth failure is still LOGIN_REQUIRED, whatever the agent says', () => {
  for (const extra of [{}, { agentStale: true, onlineDeviceCount: 0 }, { tokenExpired: true }]) {
    const h = H({ lastVerifyResult: 'session_expired', ...extra });
    assert.strictEqual(h.session.state, 'LOGIN_REQUIRED');
    assert.strictEqual(h.loginRequired, true);
  }
});

test('stale telemetry + recently verified session: verification stays its own fact', () => {
  const h = H({ agentStale: true, agentSeenSec: 2 * 3600, onlineDeviceCount: 0, cdpConnected: null, verificationAgeSec: 60 });
  assert.strictEqual(h.verification.state, 'recent');
  assert.strictEqual(h.session.state, 'HEALTHY');
});

test('legacy lifecycle label never says HEALTHY for the incident', () => {
  const lc = deriveLifecycle(incident);
  assert.notStrictEqual(lc.state, 'HEALTHY');
  assert.strictEqual(lc.loginRequired, false);
  assert.doesNotMatch(lc.reason, CLAIMS);
});

// ── B. sync outcome ────────────────────────────────────────────────────────────────────────────
const { recordAttempt, syncOutcome } = require('../utils/proxy/candidateSync');
const T = (min) => new Date(Date.UTC(2026, 9, 5, 7, min));

function fleet() {
  const active = { deviceId: 'dev_src', name: 'WIN-SRC', keyHash: 'k1', agentVersion: '3.5.0' };
  const standby = { deviceId: 'dev_sb', name: 'WIN-SB', keyHash: 'k2', agentVersion: '3.5.0' };
  const acct = { _id: 'a1', tool: 'writehuman', syncDevices: [active, standby], activeSource: { deviceId: 'dev_src', name: 'WIN-SRC' } };
  return { acct, active, standby };
}
const dev = (acct, id) => acct.syncDevices.find((d) => d.deviceId === id);

test('a refused candidate from the ACTIVE source is a failed sync', () => {
  const { acct, active } = fleet();
  recordAttempt(acct, active, 'VERIFICATION_INCONCLUSIVE', { error: 'unknown', now: T(12) });
  const o = syncOutcome(acct);
  assert.strictEqual(o.failed, true);
  assert.strictEqual(o.code, 'VERIFICATION_INCONCLUSIVE');
});

test('a HEARTBEAT does not clear a sync failure (it is liveness, not a sync)', () => {
  const { acct, active } = fleet();
  recordAttempt(acct, active, 'VERIFICATION_INCONCLUSIVE', { error: 'unknown', now: T(12) });
  recordAttempt(acct, dev(acct, 'dev_src'), 'HEARTBEAT', { now: T(15) });
  assert.strictEqual(syncOutcome(acct).failed, true);
  assert.strictEqual(syncOutcome(acct).code, 'VERIFICATION_INCONCLUSIVE');
});

test('a HEARTBEAT does not fabricate a sync success either', () => {
  const { acct, active } = fleet();
  recordAttempt(acct, active, 'HEARTBEAT', { now: T(15) });
  const o = syncOutcome(acct);
  assert.strictEqual(o.failed, false);
  assert.strictEqual(o.code, null, 'no sync has happened yet');
});

test('a NEWER successful sync from the active source supersedes the older failure', () => {
  const { acct, active } = fleet();
  recordAttempt(acct, active, 'VERIFICATION_INCONCLUSIVE', { error: 'unknown', now: T(12) });
  recordAttempt(acct, dev(acct, 'dev_src'), 'PROMOTED', { success: true, now: T(20) });
  assert.strictEqual(syncOutcome(acct).failed, false);
  assert.strictEqual(syncOutcome(acct).code, 'PROMOTED');
});

test("a STANDBY device's refusal cannot mark the active source's sync as failed", () => {
  const { acct, active, standby } = fleet();
  recordAttempt(acct, active, 'PROMOTED', { success: true, now: T(10) });
  recordAttempt(acct, dev(acct, 'dev_sb'), 'ACCOUNT_MISMATCH', { error: 'other account', now: T(11) });
  assert.strictEqual(syncOutcome(acct).failed, false);
  assert.strictEqual(syncOutcome(acct).deviceId, active.deviceId);
  void standby;
});

test('routine non-failures (STALE_BUNDLE, REPLAY_REJECTED) do not read as a failed sync', () => {
  const { acct, active } = fleet();
  recordAttempt(acct, active, 'PROMOTED', { success: true, now: T(10) });
  recordAttempt(acct, dev(acct, 'dev_src'), 'STALE_BUNDLE', { now: T(11) });
  recordAttempt(acct, dev(acct, 'dev_src'), 'REPLAY_REJECTED', { now: T(12) });
  assert.strictEqual(syncOutcome(acct).failed, false);
});

// ── C. command delivery ────────────────────────────────────────────────────────────────────────
const agentCommands = require('../utils/proxy/agentCommands');
const { agentDirectives } = require('../routes/proxy/agentSync');

function cmdFleet(agentVersion) {
  const src = { deviceId: 'dev_src', name: 'WIN-SRC', hostname: 'WIN-SRC', keyHash: 'k1', agentVersion, lastSeenAt: new Date(), pairedAt: new Date(Date.now() - 86400000) };
  const acct = { _id: 'a1', tool: 'writehuman', syncDevices: [src], activeSource: { deviceId: 'dev_src', name: 'WIN-SRC', promotedAt: new Date() }, pendingCommands: [], commandLog: [] };
  agentCommands.enqueue(acct, { type: 'resync', device: src, tool: 'writehuman' });
  return { acct, src };
}

test('a 409 reply to a 3.5.0 agent (which ignores non-2xx bodies) does NOT spend the pending command', () => {
  const { acct, src } = cmdFleet('3.5.0');
  const d = agentDirectives(acct, 'writehuman', src, { replyOk: false });
  assert.strictEqual(d.command, null, 'the command would be marked delivered and then dropped by the agent');
  assert.strictEqual(agentCommands.publicCommands(acct).length, 1, 'still pending for the next 2xx reply');
});

test('a 409 reply to an agent that honours directives on refusals (3.5.1+) does deliver it', () => {
  const { acct, src } = cmdFleet('3.5.1');
  const d = agentDirectives(acct, 'writehuman', src, { replyOk: false });
  assert.ok(d.command && d.command.type === 'resync');
});

test('a 2xx reply delivers exactly as before (unchanged behaviour)', () => {
  const { acct, src } = cmdFleet('3.5.0');
  const d = agentDirectives(acct, 'writehuman', src, { replyOk: true });
  assert.ok(d.command && d.command.type === 'resync');
  assert.strictEqual(agentDirectives(acct, 'writehuman', src, { replyOk: true }).command, null, 'single use');
});

test('commands still never reach a device that is not their target', () => {
  const { acct } = cmdFleet('3.5.1');
  const other = { deviceId: 'dev_other', name: 'OTHER', keyHash: 'k9', agentVersion: '3.5.1', lastSeenAt: new Date() };
  acct.syncDevices.push(other);
  assert.strictEqual(agentDirectives(acct, 'writehuman', other, { replyOk: false }).command, null);
  assert.strictEqual(agentDirectives(acct, 'writehuman', other, { replyOk: true }).command, null);
});
