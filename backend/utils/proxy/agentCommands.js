'use strict';
/**
 * agentCommands — ADDRESSED, single-use, expiring commands for WriteHuman source agents.
 *
 * WHAT THIS REPLACES, AND WHY
 * ---------------------------
 * The previous design was one string on the account:
 *
 *     account.pendingCommand = 'relaunch-chrome';         // admin route
 *     const pending = account.pendingCommand; ...          // ingest route, for ANY device
 *     const clearPending = () => { account.pendingCommand = null; };
 *
 * It carried no target, no id, no expiry and no nonce, and it was handed to — and CONSUMED BY —
 * whichever paired agent happened to POST first: a heartbeat, a cookie push, anything. So "Open
 * WriteHuman Chrome" reliably opened Chrome on the wrong machine: the admin's own laptop, a
 * standby, the most recently online box — never necessarily the active source. Exactly the
 * "latest heartbeat wins / first online agent wins" behaviour that must not exist.
 *
 * Every command now carries all of:
 *   id            stable identifier, so an ack can be matched to an issue
 *   type          one of TYPES
 *   tool          scope — a WriteHuman command is only ever valid for WriteHuman
 *   targetDeviceId          the ONE device allowed to execute it
 *   targetKeyFingerprint    the credential identity expected on that device, so a re-enrolled
 *                           machine that reused the id cannot pick up a command minted for the
 *                           credential it no longer holds
 *   createdAt / expiresAt   commands die on their own; a forgotten click cannot fire tomorrow
 *   nonce                   one-time; spent on delivery, so a replayed poll re-runs nothing
 *   minAgentVersion         an agent too old to validate addressing is never given a command
 *
 * There is NO fallback device, by construction: `takeFor` compares against the caller's own device
 * id and returns null on any mismatch. The server also refuses to ADDRESS a revoked, superseded,
 * inactive or non-active-source device in the first place, so the two checks are independent.
 */
const crypto = require('crypto');
const deviceSync = require('./deviceSync');

// Command vocabulary. Deliberately small, and split so the two dangerous verbs are distinct:
//   open-chrome   launches the dedicated WriteHuman Chrome. Only ever for a genuine login/cookie
//                 refresh, only ever on the ACTIVE SOURCE, only ever when explicitly asked for.
//   resync        re-read cookies and push them. Never launches a browser.
//   rotate-token  nudge the WriteHuman tab so Supabase rotates the access token ON TIME. This is
//                 what removes the hourly "go and refresh the RDP browser" chore: the browser
//                 stays the sole rotator, it is just no longer allowed to be late.
const TYPES = ['open-chrome', 'resync', 'rotate-token'];
// Types that may launch a browser process. Everything else is guaranteed not to.
const LAUNCHES_BROWSER = ['open-chrome'];
// The agent release that understands addressed commands (id/target/nonce) and validates them.
// Older agents receive nothing at all rather than an unaddressed instruction.
const MIN_AGENT_VERSION = process.env.PROXY_COMMAND_MIN_AGENT_VERSION || '3.4.0';

const DEFAULT_TTL_MS = Math.max(60_000, Number(process.env.PROXY_COMMAND_TTL_MS || 10 * 60_000));
const MAX_QUEUE = 8;

const CODES = {
  OK: 'OK',
  DEVICE_UNKNOWN: 'DEVICE_UNKNOWN',
  DEVICE_REVOKED: 'DEVICE_REVOKED',
  DEVICE_SUPERSEDED: 'DEVICE_SUPERSEDED',
  DEVICE_NOT_ACTIVE_SOURCE: 'DEVICE_NOT_ACTIVE_SOURCE',
  NO_ACTIVE_SOURCE: 'NO_ACTIVE_SOURCE',
  ACTIVE_SOURCE_OFFLINE: 'ACTIVE_SOURCE_OFFLINE',
  DEVICE_OFFLINE: 'DEVICE_OFFLINE',
  DEVICE_NO_CREDENTIAL: 'DEVICE_NO_CREDENTIAL',
  COMMAND_VERSION_UNSUPPORTED: 'COMMAND_VERSION_UNSUPPORTED',
  UNKNOWN_COMMAND: 'UNKNOWN_COMMAND',
};

// Tiny local semver compare. Deliberately NOT a require of utils/semver.js: the deploy manifest
// guard only checks utils/proxy/, so a cross-directory dependency here would be invisible to it —
// and a missing module is how this API has booted into "Cannot find module" before.
function atLeast(version, minimum) {
  const p = (v) => String(v || '0').split('.').map(n => parseInt(n, 10) || 0);
  const a = p(version), b = p(minimum);
  for (let i = 0; i < 3; i++) {
    if ((a[i] || 0) > (b[i] || 0)) return true;
    if ((a[i] || 0) < (b[i] || 0)) return false;
  }
  return true;
}

function getCommands(account) {
  const c = account && account.pendingCommands;
  return Array.isArray(c) ? c : [];
}
function setCommands(account, list) {
  account.pendingCommands = list.slice(-MAX_QUEUE);
}
/** The credential identity a command is bound to. Derived from the stored hash — never the key. */
function keyFingerprint(device) {
  if (!device || !device.keyHash) return null;
  return crypto.createHash('sha256').update(String(device.keyHash)).digest('hex').slice(0, 16);
}

/** Drop anything expired or already spent. Called on every read and write. */
function prune(account, now) {
  const t = (now || new Date()).getTime();
  const live = getCommands(account).filter(c =>
    c && c.status === 'pending' && new Date(c.expiresAt).getTime() > t);
  if (live.length !== getCommands(account).length) setCommands(account, live);
  return live;
}

/**
 * May this device be ADDRESSED at all? Every refusal is a distinct code so the admin sees the real
 * reason instead of a generic failure — and so no branch can quietly fall through to another box.
 *
 * opts.requireActiveSource   the command only makes sense on the machine supplying the session
 * opts.requireOnline         the command needs the agent to actually be there to run it
 * opts.staleMs               the heartbeat window that defines "online"
 */
function validateTarget(account, deviceId, opts) {
  const o = opts || {};
  const staleMs = o.staleMs || 10 * 60_000;
  const dev = deviceSync.findDevice(account, deviceId);
  if (!dev) return { ok: false, code: CODES.DEVICE_UNKNOWN, message: 'That device is not paired with this account.' };
  if (dev.revoked) return { ok: false, code: CODES.DEVICE_REVOKED, message: 'That device is revoked and can no longer be given commands.' };
  if (deviceSync.isSupersededDevice(account, dev, staleMs)) {
    return { ok: false, code: CODES.DEVICE_SUPERSEDED, message: 'That device record has been superseded by a newer enrolment of the same machine.' };
  }
  if (!dev.keyHash) return { ok: false, code: CODES.DEVICE_NO_CREDENTIAL, message: 'That device has no per-agent credential, so a command could not be addressed to it.' };

  if (o.requireActiveSource) {
    const activeId = account.activeSource && account.activeSource.deviceId;
    if (!activeId) return { ok: false, code: CODES.NO_ACTIVE_SOURCE, message: 'No device is currently the active source.' };
    if (activeId !== dev.deviceId) {
      return { ok: false, code: CODES.DEVICE_NOT_ACTIVE_SOURCE, message: 'That device is not the current active source. WriteHuman commands only ever go to the active source.' };
    }
  }
  if (o.requireOnline && !deviceSync.isOnline(dev, staleMs)) {
    const isActive = account.activeSource && account.activeSource.deviceId === dev.deviceId;
    return {
      ok: false,
      code: isActive ? CODES.ACTIVE_SOURCE_OFFLINE : CODES.DEVICE_OFFLINE,
      message: isActive
        ? 'Active source is offline. WriteHuman continues using the last verified session. Reconnect that source before opening Chrome.'
        : 'That device is offline.',
      device: dev,
    };
  }
  if (o.requireCommandSupport && !atLeast(dev.agentVersion, MIN_AGENT_VERSION)) {
    return {
      ok: false, code: CODES.COMMAND_VERSION_UNSUPPORTED,
      message: 'That device runs agent ' + (dev.agentVersion || 'an unknown version') + '. Addressed commands need ' + MIN_AGENT_VERSION + ' or newer — update the agent on that machine.',
      device: dev,
    };
  }
  return { ok: true, code: CODES.OK, device: dev };
}

/**
 * Mint a command for ONE device. Replaces any pending command of the same type for that device
 * (pressing a button twice must not queue two Chrome launches), and never touches any other
 * device's queue.
 */
function enqueue(account, opts) {
  const o = opts || {};
  const device = o.device;
  if (!TYPES.includes(o.type)) return { ok: false, code: CODES.UNKNOWN_COMMAND };
  if (!device || !device.deviceId) return { ok: false, code: CODES.DEVICE_UNKNOWN };
  const now = o.now || new Date();
  const live = prune(account, now).filter(c => !(c.targetDeviceId === device.deviceId && c.type === o.type));
  const cmd = {
    id: 'cmd_' + crypto.randomBytes(9).toString('hex'),
    type: o.type,
    tool: o.tool || 'writehuman',
    targetDeviceId: device.deviceId,
    targetDeviceName: device.name || null,
    targetKeyFingerprint: keyFingerprint(device),
    nonce: crypto.randomBytes(16).toString('hex'),
    minAgentVersion: MIN_AGENT_VERSION,
    createdAt: now,
    expiresAt: new Date(now.getTime() + (o.ttlMs || DEFAULT_TTL_MS)),
    issuedBy: o.issuedBy || null,
    reason: o.reason || null,
    status: 'pending',
    deliveredAt: null,
    ackedAt: null,
    ackResult: null,
  };
  setCommands(account, live.concat([cmd]));
  return { ok: true, code: CODES.OK, command: cmd };
}

/**
 * Hand this device the command addressed to IT, if there is one. The whole no-wrong-machine
 * guarantee lives in these comparisons — a mismatch returns null, never someone else's command.
 * The nonce is spent here, so a duplicate poll (or a replayed request) gets nothing.
 */
function takeFor(account, device, opts) {
  const o = opts || {};
  if (!device || !device.deviceId || device.revoked) return null;
  const now = o.now || new Date();
  const live = prune(account, now);
  const fp = keyFingerprint(device);
  const idx = live.findIndex(c =>
    c.targetDeviceId === device.deviceId
    && (!c.tool || !o.tool || c.tool === o.tool)
    && (!c.targetKeyFingerprint || !fp || c.targetKeyFingerprint === fp));
  if (idx < 0) return null;
  const cmd = live[idx];
  if (!atLeast(o.agentVersion || device.agentVersion, cmd.minAgentVersion)) return null;
  // Spend it. Delivered-but-unacked commands are simply gone; the admin can press again. That is
  // deliberately safer than a redelivery loop, which is how a single click becomes five Chromes.
  live.splice(idx, 1);
  setCommands(account, live);
  const delivered = Object.assign({}, cmd, { status: 'delivered', deliveredAt: now });
  const log = Array.isArray(account.commandLog) ? account.commandLog : [];
  account.commandLog = log.concat([{
    id: delivered.id, type: delivered.type, targetDeviceId: delivered.targetDeviceId,
    targetDeviceName: delivered.targetDeviceName, issuedBy: delivered.issuedBy,
    createdAt: delivered.createdAt, deliveredAt: now, status: 'delivered',
  }]).slice(-20);
  // What the agent receives. The nonce and target go with it so the AGENT can re-check the
  // addressing itself — belt and braces, because a server bug must not be able to move a browser.
  return {
    id: delivered.id, type: delivered.type, tool: delivered.tool,
    targetDeviceId: delivered.targetDeviceId, nonce: delivered.nonce,
    expiresAt: delivered.expiresAt, minAgentVersion: delivered.minAgentVersion,
    launchesBrowser: LAUNCHES_BROWSER.includes(delivered.type),
  };
}

/** Record what the agent did with a delivered command. Purely observational. */
function ack(account, device, body) {
  const b = body || {};
  if (!b.commandId || !device) return { ok: false };
  const log = Array.isArray(account.commandLog) ? account.commandLog : [];
  const entry = log.find(e => e && e.id === b.commandId && e.targetDeviceId === device.deviceId);
  if (!entry) return { ok: false };
  entry.status = b.ok === false ? 'failed' : 'acked';
  entry.ackedAt = new Date();
  entry.ackResult = b.result ? String(b.result).slice(0, 120) : null;
  account.commandLog = log;
  return { ok: true };
}

/**
 * Drop every pending command for a device. Called the moment a device is revoked or superseded —
 * a machine that has just lost the right to write must not still be holding an instruction.
 */
function purgeForDevice(account, deviceId, reason) {
  const before = getCommands(account);
  const after = before.filter(c => c && c.targetDeviceId !== deviceId);
  if (after.length !== before.length) {
    setCommands(account, after);
    const log = Array.isArray(account.commandLog) ? account.commandLog : [];
    account.commandLog = log.concat([{
      id: 'purge_' + deviceId, type: 'purge', targetDeviceId: deviceId,
      createdAt: new Date(), status: 'purged', ackResult: reason || null,
    }]).slice(-20);
  }
  return before.length - after.length;
}

/** Safe projection for the admin page — no nonce, ever. */
function publicCommands(account, now) {
  return prune(account, now).map(c => ({
    id: c.id, type: c.type, targetDeviceId: c.targetDeviceId, targetDeviceName: c.targetDeviceName,
    createdAt: c.createdAt, expiresAt: c.expiresAt, status: c.status,
    launchesBrowser: LAUNCHES_BROWSER.includes(c.type),
  }));
}

module.exports = {
  TYPES, LAUNCHES_BROWSER, CODES, MIN_AGENT_VERSION, DEFAULT_TTL_MS,
  validateTarget, enqueue, takeFor, ack, purgeForDevice, publicCommands, prune, keyFingerprint, atLeast,
};
