'use strict';
/**
 * COMMAND ROUTING — a WriteHuman source command must reach exactly one machine: the current active
 * source. Never the admin's own computer, never the most recently online agent, never the first
 * online agent, never an inactive, standby, revoked or superseded device.
 *
 * WHAT WENT WRONG. The queue was one string on the account:
 *
 *     account.pendingCommand = 'relaunch-chrome';
 *     const pending = account.pendingCommand;      // read by ANY device, on ANY request
 *     clearPending();                              // and CONSUMED by whoever got there first
 *
 * No target, no id, no expiry, no nonce. Whichever agent POSTed first — a heartbeat from a laptop
 * on a desk, a standby, anything — received it and spent it. "Open WriteHuman Chrome" therefore
 * opened Chrome on the wrong computer, reproducibly.
 *
 * These tests pin the replacement: every command is ADDRESSED, and both the server and the agent
 * check the address independently.
 */
const test = require('node:test');
const assert = require('node:assert');
const crypto = require('crypto');

const deviceSync = require('../utils/proxy/deviceSync');
const agentCommands = require('../utils/proxy/agentCommands');

const STALE_MS = 10 * 60 * 1000;
const ago = (ms) => new Date(Date.now() - ms);

/** A device row as the registry stores it. `keyHash` stands in for a real per-agent credential. */
function device(id, name, opts = {}) {
  return {
    deviceId: id,
    name,
    hostname: name,
    agentVersion: opts.agentVersion || '3.4.0',
    keyHash: opts.noCredential ? null : crypto.createHash('sha256').update(id).digest('hex'),
    revoked: !!opts.revoked,
    lastSeenAt: opts.lastSeenAt === null ? null : (opts.lastSeenAt || ago(30 * 1000)),
    pairedAt: ago(24 * 60 * 60 * 1000),
  };
}

function account(devices, activeDeviceId) {
  return {
    _id: 'acct1', tool: 'writehuman',
    syncDevices: devices,
    activeSource: activeDeviceId ? { deviceId: activeDeviceId, name: (devices.find(d => d.deviceId === activeDeviceId) || {}).name, promotedAt: ago(60000) } : null,
    pendingCommands: [],
    commandLog: [],
  };
}

/** The standard fleet: RDP-01 is the active source; the local PC is online but only a standby. */
function fleet() {
  const rdp = device('dev_rdp01', 'RDP-01');
  const local = device('dev_localpc', 'LOCAL-PC', { lastSeenAt: ago(1000) }); // MORE recently seen
  return { rdp, local, acct: account([rdp, local], 'dev_rdp01') };
}

// ── 4. OPEN ACTIVE SOURCE ─────────────────────────────────────────────────────
test('a command addressed to the active source reaches ONLY that device', () => {
  const { rdp, local, acct } = fleet();
  const q = agentCommands.enqueue(acct, { type: 'open-chrome', device: rdp, tool: 'writehuman' });
  assert.strictEqual(q.ok, true);

  // The local PC polls first — it is online, and it was seen more recently than RDP-01. Under the
  // old design that alone won it the command.
  assert.strictEqual(agentCommands.takeFor(acct, local, { tool: 'writehuman' }), null);

  // RDP-01 polls and gets it.
  const got = agentCommands.takeFor(acct, rdp, { tool: 'writehuman' });
  assert.ok(got, 'the active source must receive its own command');
  assert.strictEqual(got.type, 'open-chrome');
  assert.strictEqual(got.targetDeviceId, 'dev_rdp01');
  assert.strictEqual(got.launchesBrowser, true);
});

test('a command is single-use — one click can never become two Chrome launches', () => {
  const { rdp, acct } = fleet();
  agentCommands.enqueue(acct, { type: 'open-chrome', device: rdp, tool: 'writehuman' });
  assert.ok(agentCommands.takeFor(acct, rdp, { tool: 'writehuman' }));
  assert.strictEqual(agentCommands.takeFor(acct, rdp, { tool: 'writehuman' }), null, 'a second poll must get nothing');
});

test('pressing the button twice queues ONE command, not two', () => {
  const { rdp, acct } = fleet();
  agentCommands.enqueue(acct, { type: 'open-chrome', device: rdp, tool: 'writehuman' });
  agentCommands.enqueue(acct, { type: 'open-chrome', device: rdp, tool: 'writehuman' });
  assert.strictEqual(agentCommands.publicCommands(acct).length, 1);
});

// ── 5. REVOKED DEVICE ─────────────────────────────────────────────────────────
test('a revoked device can neither be addressed nor collect a command', () => {
  const { rdp, local, acct } = fleet();
  local.revoked = true;

  const t = agentCommands.validateTarget(acct, 'dev_localpc', { staleMs: STALE_MS });
  assert.strictEqual(t.ok, false);
  assert.strictEqual(t.code, agentCommands.CODES.DEVICE_REVOKED);

  // Even if one had somehow been minted for it, it collects nothing.
  agentCommands.enqueue(acct, { type: 'open-chrome', device: rdp, tool: 'writehuman' });
  local.revoked = true;
  assert.strictEqual(agentCommands.takeFor(acct, local, { tool: 'writehuman' }), null);
});

test('revoking a device purges the commands it was holding', () => {
  const { rdp, local, acct } = fleet();
  agentCommands.enqueue(acct, { type: 'resync', device: local, tool: 'writehuman' });
  agentCommands.enqueue(acct, { type: 'resync', device: rdp, tool: 'writehuman' });
  assert.strictEqual(agentCommands.publicCommands(acct).length, 2);

  const purged = agentCommands.purgeForDevice(acct, 'dev_localpc', 'device_revoked');
  assert.strictEqual(purged, 1);
  const left = agentCommands.publicCommands(acct);
  assert.strictEqual(left.length, 1);
  assert.strictEqual(left[0].targetDeviceId, 'dev_rdp01', 'the other device keeps its own command');
});

// ── 6. SUPERSEDED DEVICE ──────────────────────────────────────────────────────
test('a superseded duplicate record cannot receive commands', () => {
  // The same machine reinstalled: a NEW device id, same name, seen more recently. The old row is
  // history, not a target.
  const oldRow = device('dev_old', 'RDP-01', { lastSeenAt: ago(6 * 60 * 60 * 1000) });
  const newRow = device('dev_new', 'RDP-01', { lastSeenAt: ago(20 * 1000) });
  const acct = account([oldRow, newRow], 'dev_new');

  assert.strictEqual(deviceSync.isSupersededDevice(acct, oldRow, STALE_MS), true);
  const t = agentCommands.validateTarget(acct, 'dev_old', { staleMs: STALE_MS });
  assert.strictEqual(t.ok, false);
  assert.strictEqual(t.code, agentCommands.CODES.DEVICE_SUPERSEDED);
});

test('the ACTIVE source is never treated as superseded by its own older twin', () => {
  const oldRow = device('dev_old', 'RDP-01', { lastSeenAt: ago(20 * 1000) });
  const active = device('dev_new', 'RDP-01', { lastSeenAt: ago(6 * 60 * 60 * 1000) });
  const acct = account([oldRow, active], 'dev_new');
  assert.strictEqual(deviceSync.isSupersededDevice(acct, active, STALE_MS), false);
});

// ── 3. INACTIVE / STANDBY DEVICE ──────────────────────────────────────────────
test('an online standby is refused as a target for source-specific commands', () => {
  const { acct } = fleet();
  const t = agentCommands.validateTarget(acct, 'dev_localpc', { requireActiveSource: true, staleMs: STALE_MS });
  assert.strictEqual(t.ok, false);
  assert.strictEqual(t.code, agentCommands.CODES.DEVICE_NOT_ACTIVE_SOURCE);
});

test('a device with no per-agent credential cannot be addressed', () => {
  const noCred = device('dev_nocred', 'ODD-ONE', { noCredential: true });
  const acct = account([noCred], 'dev_nocred');
  const t = agentCommands.validateTarget(acct, 'dev_nocred', { staleMs: STALE_MS });
  assert.strictEqual(t.ok, false);
  assert.strictEqual(t.code, agentCommands.CODES.DEVICE_NO_CREDENTIAL);
});

test('a re-enrolled device that reused the id cannot collect the old credential\'s command', () => {
  const { rdp, acct } = fleet();
  agentCommands.enqueue(acct, { type: 'resync', device: rdp, tool: 'writehuman' });
  // Same id, brand-new key: a different credential identity.
  const reissued = Object.assign({}, rdp, { keyHash: crypto.randomBytes(32).toString('hex') });
  assert.strictEqual(agentCommands.takeFor(acct, reissued, { tool: 'writehuman' }), null);
});

// ── 7. ACTIVE SOURCE OFFLINE ──────────────────────────────────────────────────
test('an offline active source is reported, and NO other device is chosen instead', () => {
  const rdp = device('dev_rdp01', 'RDP-01', { lastSeenAt: ago(3 * 60 * 60 * 1000) });   // offline
  const local = device('dev_localpc', 'LOCAL-PC', { lastSeenAt: ago(1000) });            // online
  const acct = account([rdp, local], 'dev_rdp01');

  const t = agentCommands.validateTarget(acct, 'dev_rdp01', { requireActiveSource: true, requireOnline: true, staleMs: STALE_MS });
  assert.strictEqual(t.ok, false);
  assert.strictEqual(t.code, agentCommands.CODES.ACTIVE_SOURCE_OFFLINE);
  assert.match(t.message, /Active source is offline\. WriteHuman continues using the last verified session\. Reconnect that source before opening Chrome\./);

  // Nothing was queued anywhere — in particular not on the online local PC.
  assert.strictEqual(agentCommands.publicCommands(acct).length, 0);
  assert.strictEqual(agentCommands.takeFor(acct, local, { tool: 'writehuman' }), null);
});

test('no active source at all is its own refusal, not a free-for-all', () => {
  const local = device('dev_localpc', 'LOCAL-PC');
  const acct = account([local], null);
  const t = agentCommands.validateTarget(acct, 'dev_localpc', { requireActiveSource: true, staleMs: STALE_MS });
  assert.strictEqual(t.ok, false);
  assert.strictEqual(t.code, agentCommands.CODES.NO_ACTIVE_SOURCE);
});

// ── 8. SOURCE SWITCH ──────────────────────────────────────────────────────────
test('after the source moves, later commands follow it and the old source gets nothing', () => {
  const { rdp, local, acct } = fleet();
  // RDP-02 is promoted.
  acct.activeSource = { deviceId: 'dev_localpc', name: 'LOCAL-PC', promotedAt: new Date() };

  const t = agentCommands.validateTarget(acct, 'dev_localpc', { requireActiveSource: true, requireOnline: true, staleMs: STALE_MS });
  assert.strictEqual(t.ok, true);
  agentCommands.enqueue(acct, { type: 'open-chrome', device: t.device, tool: 'writehuman' });

  assert.strictEqual(agentCommands.takeFor(acct, rdp, { tool: 'writehuman' }), null, 'the previous source must get nothing');
  const got = agentCommands.takeFor(acct, local, { tool: 'writehuman' });
  assert.ok(got);
  assert.strictEqual(got.targetDeviceId, 'dev_localpc');
});

// ── expiry, versioning, scope ─────────────────────────────────────────────────
test('a command expires on its own, so a forgotten click cannot fire tomorrow', () => {
  const { rdp, acct } = fleet();
  agentCommands.enqueue(acct, { type: 'open-chrome', device: rdp, tool: 'writehuman', ttlMs: 60000 });
  const later = new Date(Date.now() + 90 * 1000);
  assert.strictEqual(agentCommands.takeFor(acct, rdp, { tool: 'writehuman', now: later }), null);
  assert.strictEqual(agentCommands.publicCommands(acct, later).length, 0);
});

test('an agent too old to validate addressing is given nothing at all', () => {
  const { rdp, acct } = fleet();
  const t = agentCommands.validateTarget(acct, 'dev_rdp01', { requireCommandSupport: true, staleMs: STALE_MS });
  assert.strictEqual(t.ok, true, 'a 3.4.0 agent is fine');

  const old = Object.assign({}, rdp, { agentVersion: '3.3.0' });
  const acctOld = account([old], 'dev_rdp01');
  const t2 = agentCommands.validateTarget(acctOld, 'dev_rdp01', { requireCommandSupport: true, staleMs: STALE_MS });
  assert.strictEqual(t2.ok, false);
  assert.strictEqual(t2.code, agentCommands.CODES.COMMAND_VERSION_UNSUPPORTED);

  // And even if one were queued, the old agent does not collect it — so it can never receive an
  // instruction it has no way to check the address of.
  agentCommands.enqueue(acctOld, { type: 'open-chrome', device: old, tool: 'writehuman' });
  assert.strictEqual(agentCommands.takeFor(acctOld, old, { tool: 'writehuman', agentVersion: '3.3.0' }), null);
});

test('a WriteHuman command is scoped to WriteHuman', () => {
  const { rdp, acct } = fleet();
  agentCommands.enqueue(acct, { type: 'resync', device: rdp, tool: 'writehuman' });
  assert.strictEqual(agentCommands.takeFor(acct, rdp, { tool: 'stealthwriter' }), null);
  assert.ok(agentCommands.takeFor(acct, rdp, { tool: 'writehuman' }));
});

test('every command carries id, target, credential identity, expiry, nonce, type and scope', () => {
  const { rdp, acct } = fleet();
  const q = agentCommands.enqueue(acct, { type: 'resync', device: rdp, tool: 'writehuman', issuedBy: 'admin1' });
  const c = q.command;
  for (const f of ['id', 'type', 'tool', 'targetDeviceId', 'targetKeyFingerprint', 'nonce', 'createdAt', 'expiresAt', 'minAgentVersion']) {
    assert.ok(c[f], 'missing ' + f);
  }
  assert.strictEqual(c.tool, 'writehuman');
  assert.strictEqual(c.issuedBy, 'admin1');
  // The nonce is never exposed to the admin surface.
  assert.strictEqual(agentCommands.publicCommands(acct).some(p => p.nonce), false);
});

test('only open-chrome is allowed to launch a browser', () => {
  assert.deepStrictEqual(agentCommands.LAUNCHES_BROWSER, ['open-chrome']);
  for (const t of agentCommands.TYPES.filter(x => x !== 'open-chrome')) {
    assert.strictEqual(agentCommands.LAUNCHES_BROWSER.includes(t), false, t);
  }
});

test('version comparison is numeric, not lexicographic', () => {
  assert.strictEqual(agentCommands.atLeast('3.10.0', '3.4.0'), true);
  assert.strictEqual(agentCommands.atLeast('3.4.0', '3.4.0'), true);
  assert.strictEqual(agentCommands.atLeast('3.3.9', '3.4.0'), false);
  assert.strictEqual(agentCommands.atLeast(null, '3.4.0'), false);
});
