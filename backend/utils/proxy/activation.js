'use strict';
/**
 * activation — "Mark Active" as ONE transaction with a real, observable lifecycle.
 *
 * WHAT THIS REPLACES, AND WHY
 * ---------------------------
 * Mark Active used to be a single field:
 *
 *     account.activeSourceIntent = { deviceId, createdAt, expiresAt };   // and that was all
 *
 * Nothing was ever SENT to the device. The server simply recorded a wish and waited for that
 * machine to happen to push cookies of its own accord, at which point the intent would be spent.
 * Two consequences, both observed in production:
 *
 *   1. Clicking Mark Active on a freshly installed RDP did nothing at all for up to 15 minutes,
 *      and then silently expired. The UI had no stage to show, so it showed "syncing" forever.
 *   2. In the single most common case — the SAME WriteHuman login already present on the new
 *      machine — it could never work at all. The candidate's auth-cookie hash equalled the active
 *      bundle's, so the ingest short-circuited to COOKIE_BUNDLE_UNCHANGED *before* the intent was
 *      even looked at. The intent then expired unused, forever, however many times it was pressed.
 *
 * An activation is now a transaction: it names ONE device, carries a one-time nonce, mints a
 * targeted `capture-and-activate` command for that device and nobody else, moves through stages
 * that the operator can actually see, and always ends — ACTIVE, FAILED or EXPIRED. Never "syncing".
 *
 * SECURITY SHAPE
 * --------------
 * The nonce is the capability. A device may only spend an activation whose `targetDeviceId` is its
 * own authenticated id AND whose nonce it can present, and it is spent exactly once. That is what
 * lets the ingest safely relax its normal anti-flap rules (unchanged hash, identical session id)
 * for this one bundle: the relaxation is authorised by an admin action, addressed to one machine,
 * and it still has to pass full account verification before anything is promoted.
 *
 * The nonce is never returned by any admin/read route — `publicView()` cannot emit it.
 */
const crypto = require('crypto');

/**
 * The lifecycle, in order. The UI renders the operator-facing sentence for whichever one is
 * current, so there is always something true to show and never an indefinite spinner.
 */
const STAGES = [
  'REQUESTING_CAPTURE',       // created; the command exists but the agent has not collected it yet
  'WAITING_FOR_AGENT',        // command minted, waiting for that device to poll
  'OPENING_CHROME',           // the agent has it and is bringing its dedicated Chrome up
  'WAITING_FOR_AUTH_COOKIES', // Chrome is up but nobody is signed in to WriteHuman on it
  'CAPTURING',                // reading the allowlisted cookies over loopback CDP
  'UPLOADING',                // pushing the bundle back with the activation id + nonce
  'VERIFYING_ACCOUNT',        // server: does this bundle authenticate as the expected account?
  'TESTING_WRITEHUMAN',       // server: one real authenticated WriteHuman/Supabase call
  'PROMOTING',                // server: atomic promote + source switch
  'ACTIVE',                   // done — this device is the active source
  'FAILED',                   // done — previous source and bundle untouched
  'EXPIRED',                  // done — nobody completed it inside the window
];
const TERMINAL = ['ACTIVE', 'FAILED', 'EXPIRED'];

/**
 * Stages an AGENT is allowed to claim. Everything after UPLOADING is decided by the server, so a
 * compromised or buggy agent cannot report itself into PROMOTING or ACTIVE — it can only describe
 * what it is doing on its own machine.
 */
const AGENT_STAGES = ['OPENING_CHROME', 'WAITING_FOR_AUTH_COOKIES', 'CAPTURING', 'UPLOADING'];

const CODES = {
  OK: 'OK',
  NO_ACTIVATION: 'NO_ACTIVATION',
  ACTIVATION_UNKNOWN: 'ACTIVATION_UNKNOWN',
  ACTIVATION_EXPIRED: 'ACTIVATION_EXPIRED',
  ACTIVATION_COMPLETE: 'ACTIVATION_COMPLETE',
  ACTIVATION_WRONG_DEVICE: 'ACTIVATION_WRONG_DEVICE',
  ACTIVATION_NONCE_INVALID: 'ACTIVATION_NONCE_INVALID',
  ACTIVATION_IN_PROGRESS: 'ACTIVATION_IN_PROGRESS',
};

// 12 minutes: long enough for a cold RDP to bring Chrome up and for a human to sign in if the
// browser turns out to be signed out; short enough that a forgotten click cannot fire later.
const DEFAULT_TTL_MS = Math.max(5 * 60_000, Number(process.env.PROXY_ACTIVATION_TTL_MS || 12 * 60_000));
const MAX_HISTORY = 12;   // stage transitions kept on the live transaction
const MAX_LOG = 6;        // completed transactions kept for the audit panel

function newId() { return 'act_' + crypto.randomBytes(9).toString('hex'); }
function newNonce() { return crypto.randomBytes(32).toString('hex'); }
function timingEq(a, b) {
  const x = Buffer.from(String(a || ''), 'utf8');
  const y = Buffer.from(String(b || ''), 'utf8');
  return x.length === y.length && x.length > 0 && crypto.timingSafeEqual(x, y);
}
function stageIndex(s) { return STAGES.indexOf(s); }
function isTerminal(a) { return !!(a && TERMINAL.includes(a.stage)); }

/**
 * The sentence shown to the operator for the current stage. The three wordings the runbook calls
 * for verbatim — offline agent, no signed-in session, Chrome coming up — live here so the UI can
 * never invent a vaguer one.
 */
function stageMessage(stage, ctx) {
  const c = ctx || {};
  const who = c.deviceName || c.deviceId || 'the selected device';
  switch (stage) {
    case 'REQUESTING_CAPTURE':
    case 'WAITING_FOR_AGENT':
      return c.deviceOffline ? 'Target RDP agent is offline.' : 'Waiting for ' + who + ' to pick up the capture request.';
    case 'OPENING_CHROME': return 'Opening WriteHuman Chrome on the selected RDP.';
    case 'WAITING_FOR_AUTH_COOKIES': return 'Waiting for a signed-in WriteHuman session on this RDP.';
    case 'CAPTURING': return 'Reading the WriteHuman session cookies on ' + who + '.';
    case 'UPLOADING': return 'Uploading the captured session from ' + who + '.';
    case 'VERIFYING_ACCOUNT': return 'Checking the captured session signs in as the expected WriteHuman account.';
    case 'TESTING_WRITEHUMAN': return 'Running one real WriteHuman check with the captured session.';
    case 'PROMOTING': return 'Promoting the verified session and switching the active source.';
    case 'ACTIVE': return who + ' is now the active source.';
    case 'FAILED': return c.failureMessage || 'Activation failed. The previous active source and session are unchanged.';
    case 'EXPIRED': return 'Activation expired before ' + who + ' produced a verified session. The previous active source and session are unchanged.';
    default: return 'Activation in progress.';
  }
}

/** The live transaction, expiring it in place if its window has closed. Never returns a stale one. */
function current(account, now) {
  const a = account && account.activation;
  if (!a || !a.activationId) return null;
  if (isTerminal(a)) return a;
  const t = (now || new Date()).getTime();
  if (new Date(a.expiresAt).getTime() <= t) {
    a.stage = 'EXPIRED';
    a.endedAt = new Date(t);
    a.failureCode = CODES.ACTIVATION_EXPIRED;
    pushHistory(a, 'EXPIRED', t);
    archive(account, a);
    return a;
  }
  return a;
}

/** Is there a transaction still in flight (not terminal, not expired)? */
function inFlight(account, now) {
  const a = current(account, now);
  return a && !isTerminal(a) ? a : null;
}

function pushHistory(a, stage, t) {
  const h = Array.isArray(a.history) ? a.history : [];
  a.history = h.concat([{ stage, at: new Date(t || Date.now()) }]).slice(-MAX_HISTORY);
}

/** Copy a finished transaction into the bounded audit ring. Carries no nonce. */
function archive(account, a) {
  if (!a || !isTerminal(a)) return;
  const log = Array.isArray(account.activationLog) ? account.activationLog : [];
  if (log.some(e => e && e.activationId === a.activationId)) return;
  account.activationLog = log.concat([{
    activationId: a.activationId,
    targetDeviceId: a.targetDeviceId,
    targetDeviceName: a.targetDeviceName || null,
    previousDeviceId: a.previousDeviceId || null,
    stage: a.stage,
    failureCode: a.failureCode || null,
    failureMessage: a.failureMessage || null,
    issuedBy: a.issuedBy || null,
    createdAt: a.createdAt,
    endedAt: a.endedAt || new Date(),
  }]).slice(-MAX_LOG);
}

/**
 * Open a transaction for ONE device.
 *
 * A second Mark Active while one is still running replaces it: the operator has changed their mind,
 * and leaving a stale transaction addressed to the old machine is how two devices end up racing.
 * The replaced one is failed explicitly (never silently dropped) so the audit shows what happened.
 */
function create(account, opts) {
  const o = opts || {};
  const device = o.device;
  if (!device || !device.deviceId) return { ok: false, code: CODES.ACTIVATION_UNKNOWN };
  const now = o.now || new Date();

  const live = inFlight(account, now);
  if (live && live.targetDeviceId !== device.deviceId) {
    live.stage = 'FAILED';
    live.endedAt = now;
    live.failureCode = 'SUPERSEDED_BY_NEW_REQUEST';
    live.failureMessage = 'Replaced by a newer Mark Active request for a different device.';
    pushHistory(live, 'FAILED', now.getTime());
    archive(account, live);
  }

  const a = {
    activationId: newId(),
    targetDeviceId: device.deviceId,
    targetDeviceName: device.name || null,
    previousDeviceId: (account.activeSource && account.activeSource.deviceId) || null,
    previousDeviceName: (account.activeSource && account.activeSource.name) || null,
    nonce: newNonce(),
    // Per the transaction contract this starts at REQUESTING_CAPTURE; it becomes WAITING_FOR_AGENT
    // the moment the command is minted, and OPENING_CHROME when the agent actually collects it.
    stage: 'REQUESTING_CAPTURE',
    state: 'REQUESTING_CAPTURE',
    createdAt: now,
    stageAt: now,
    expiresAt: new Date(now.getTime() + (o.ttlMs || DEFAULT_TTL_MS)),
    issuedBy: o.issuedBy || null,
    commandId: null,
    endedAt: null,
    failureCode: null,
    failureMessage: null,
    history: [{ stage: 'REQUESTING_CAPTURE', at: now }],
  };
  account.activation = a;
  return { ok: true, code: CODES.OK, activation: a };
}

/** Record which addressed command carries this activation, and move to WAITING_FOR_AGENT. */
function attachCommand(account, activationId, commandId, now) {
  const a = current(account, now);
  if (!a || a.activationId !== activationId || isTerminal(a)) return false;
  a.commandId = commandId || null;
  return advance(account, { activationId, stage: 'WAITING_FOR_AGENT', now }).ok;
}

/**
 * Is this device allowed to spend this activation right now? Every failure is a distinct code so
 * the agent's rejection is explainable rather than a generic 403.
 */
function validate(account, opts) {
  const o = opts || {};
  const now = o.now || new Date();
  const a = current(account, now);
  if (!a) return { ok: false, code: CODES.NO_ACTIVATION };
  if (a.stage === 'EXPIRED') return { ok: false, code: CODES.ACTIVATION_EXPIRED, activation: a };
  if (isTerminal(a)) return { ok: false, code: CODES.ACTIVATION_COMPLETE, activation: a };
  if (!o.activationId || o.activationId !== a.activationId) return { ok: false, code: CODES.ACTIVATION_UNKNOWN, activation: a };
  if (!o.deviceId || o.deviceId !== a.targetDeviceId) return { ok: false, code: CODES.ACTIVATION_WRONG_DEVICE, activation: a };
  if (!timingEq(o.nonce, a.nonce)) return { ok: false, code: CODES.ACTIVATION_NONCE_INVALID, activation: a };
  return { ok: true, code: CODES.OK, activation: a };
}

/**
 * Move the transaction forward. Monotonic: a stage may never go backwards, so a late-arriving
 * agent report cannot drag a transaction that is already VERIFYING_ACCOUNT back to CAPTURING and
 * make the UI flicker. `fromAgent` restricts the caller to the stages an agent may legitimately
 * claim about its own machine.
 */
function advance(account, opts) {
  const o = opts || {};
  const now = o.now || new Date();
  const a = current(account, now);
  if (!a) return { ok: false, code: CODES.NO_ACTIVATION };
  if (isTerminal(a)) return { ok: false, code: CODES.ACTIVATION_COMPLETE, activation: a };
  if (o.activationId && o.activationId !== a.activationId) return { ok: false, code: CODES.ACTIVATION_UNKNOWN, activation: a };
  if (o.deviceId && o.deviceId !== a.targetDeviceId) return { ok: false, code: CODES.ACTIVATION_WRONG_DEVICE, activation: a };
  const stage = o.stage;
  if (stageIndex(stage) < 0) return { ok: false, code: CODES.ACTIVATION_UNKNOWN, activation: a };
  if (o.fromAgent && !AGENT_STAGES.includes(stage)) return { ok: false, code: CODES.ACTIVATION_UNKNOWN, activation: a };
  if (stageIndex(stage) <= stageIndex(a.stage)) return { ok: true, code: CODES.OK, activation: a, noop: true };

  a.stage = stage;
  a.state = 'IN_PROGRESS';
  a.stageAt = now;
  if (o.note) a.note = String(o.note).slice(0, 160);
  pushHistory(a, stage, now.getTime());
  return { ok: true, code: CODES.OK, activation: a };
}

/** End the transaction as a safe, explained failure. The live session is never touched by this. */
function fail(account, opts) {
  const o = opts || {};
  const now = o.now || new Date();
  const a = current(account, now);
  if (!a || isTerminal(a)) return { ok: false, code: CODES.NO_ACTIVATION, activation: a || null };
  if (o.activationId && o.activationId !== a.activationId) return { ok: false, code: CODES.ACTIVATION_UNKNOWN, activation: a };
  a.stage = 'FAILED';
  a.state = 'FAILED';
  a.stageAt = now;
  a.endedAt = now;
  a.failureCode = o.code || 'ACTIVATION_FAILED';
  a.failureMessage = o.message ? String(o.message).slice(0, 200) : null;
  pushHistory(a, 'FAILED', now.getTime());
  archive(account, a);
  return { ok: true, code: CODES.OK, activation: a };
}

/** End the transaction as a success. Called only after an atomic promotion has actually happened. */
function complete(account, opts) {
  const o = opts || {};
  const now = o.now || new Date();
  const a = current(account, now);
  if (!a || isTerminal(a)) return { ok: false, code: CODES.NO_ACTIVATION, activation: a || null };
  if (o.activationId && o.activationId !== a.activationId) return { ok: false, code: CODES.ACTIVATION_UNKNOWN, activation: a };
  a.stage = 'ACTIVE';
  a.state = 'COMPLETED';
  a.stageAt = now;
  a.endedAt = now;
  a.bundleVersion = o.bundleVersion || null;
  a.maskedId = o.maskedId || null;
  pushHistory(a, 'ACTIVE', now.getTime());
  archive(account, a);
  return { ok: true, code: CODES.OK, activation: a };
}

/**
 * Cancel any live transaction that targets a device — used the moment that device is revoked,
 * superseded or uninstalled. A machine that has just lost the right to write must not be sitting
 * on an activation that would let it promote a bundle.
 */
function cancelForDevice(account, deviceId, reason) {
  const a = account && account.activation;
  if (!a || a.targetDeviceId !== deviceId || isTerminal(a)) return false;
  fail(account, { activationId: a.activationId, code: 'DEVICE_NO_LONGER_ELIGIBLE', message: reason || 'The target device is no longer eligible.' });
  return true;
}

/**
 * Safe projection for the admin page. Deliberately constructed field by field rather than by
 * copying and deleting — the nonce must be impossible to leak by forgetting a `delete`.
 */
function publicView(account, ctx) {
  const c = ctx || {};
  const a = current(account, c.now);
  if (!a) return null;
  const terminal = isTerminal(a);
  return {
    activationId: a.activationId,
    targetDeviceId: a.targetDeviceId,
    targetDeviceName: a.targetDeviceName || null,
    previousDeviceId: a.previousDeviceId || null,
    stage: a.stage,
    state: a.state || null,
    stages: STAGES,
    stageIndex: stageIndex(a.stage),
    message: stageMessage(a.stage, {
      deviceName: a.targetDeviceName, deviceId: a.targetDeviceId,
      deviceOffline: !!c.deviceOffline, failureMessage: a.failureMessage,
    }),
    inFlight: !terminal,
    terminal,
    failureCode: a.failureCode || null,
    failureMessage: a.failureMessage || null,
    maskedId: a.maskedId || null,
    bundleVersion: a.bundleVersion || null,
    createdAt: a.createdAt,
    stageAt: a.stageAt,
    expiresAt: a.expiresAt,
    endedAt: a.endedAt || null,
    expiresInSec: terminal ? 0 : Math.max(0, Math.round((new Date(a.expiresAt).getTime() - Date.now()) / 1000)),
    history: (Array.isArray(a.history) ? a.history : []).map(h => ({ stage: h.stage, at: h.at })),
  };
}

/** The bounded audit ring of finished transactions. Never carries a nonce. */
function publicLog(account) {
  return (Array.isArray(account && account.activationLog) ? account.activationLog : []).slice(-MAX_LOG);
}

module.exports = {
  STAGES, TERMINAL, AGENT_STAGES, CODES, DEFAULT_TTL_MS,
  create, attachCommand, validate, advance, fail, complete, cancelForDevice,
  current, inFlight, publicView, publicLog, stageMessage, isTerminal,
};
