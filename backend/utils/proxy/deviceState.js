'use strict';
/**
 * deviceState — the ONE canonical operational state of a WriteHuman sync device.
 *
 * WHY THIS EXISTS
 * ---------------
 * "Is this machine allowed to act?" used to be answered by four different expressions in four
 * different files, and they disagreed:
 *
 *   proxyTools agent-state   `!d.revoked && d.online`                     (dashboard)
 *   agentCommands            revoked / superseded / online / credential   (command router)
 *   candidateSync            `activeSource.deviceId === device.deviceId`  (promotion policy)
 *   the agent itself         `state.isActiveSource === true`              (browser launching)
 *
 * A device could therefore be "the active source" on the dashboard, "not addressable" to the
 * router, and "allowed to promote" to the ingest, all at the same instant — which is exactly the
 * shape of the incident where a REVOKED device was still named as the active source while its
 * heartbeats 403'd.
 *
 * One function, `stateOf()`, now answers it for every caller. Everything else is derived from it.
 *
 * THE STATES (exactly the eight, in precedence order)
 * --------------------------------------------------
 *   REVOKED      an admin took this machine's write access away. Terminal.
 *   UNINSTALLED  the agent reported its own removal from that machine. Terminal.
 *   SUPERSEDED   the same machine re-enrolled under a new id; this row is a dead duplicate.
 *   OFFLINE      authorized, but no heartbeat inside the staleness window.
 *   ERROR        online, but its last exchange with the server failed in a way that needs a human.
 *   ACTIVE       the ONE device whose routine cookie refresh may update the live bundle.
 *   STANDBY      authorized and online, has held (or could hold) the title, but does not now.
 *   READY        authorized and online, never yet activated.
 *
 * Precedence is deliberate and load-bearing:
 *   - the three terminal states outrank everything, so a revoked machine can never read as ACTIVE;
 *   - OFFLINE outranks ACTIVE, so "the active source is offline" is visible as OFFLINE rather than
 *     a green ACTIVE badge on a machine that is switched off. `isActiveSource` is reported
 *     separately for exactly that case, and nothing auto-selects a replacement.
 *
 * Pure: no I/O, no clock other than the one passed in, no mutation. Safe to call per render.
 */
const deviceSync = require('./deviceSync');

const STATES = ['READY', 'ACTIVE', 'STANDBY', 'OFFLINE', 'REVOKED', 'SUPERSEDED', 'UNINSTALLED', 'ERROR'];

/** Terminal: the machine has lost the right to act and cannot regain it without a new identity. */
const TERMINAL = ['REVOKED', 'SUPERSEDED', 'UNINSTALLED'];

/**
 * Result codes that mean the device's last exchange failed in a way a human should look at.
 * Deliberately NOT here: STALE_BUNDLE and STANDBY_ROUTINE_REFRESH (both are the policy working as
 * designed), NO_ALLOWED_COOKIES (the browser is merely signed out) and COOKIE_BUNDLE_UNCHANGED
 * (the normal idle answer). Flagging those as ERROR is how a dashboard becomes noise.
 */
const ERROR_CODES = ['ACCOUNT_MISMATCH', 'PROMOTION_FAILED', 'REPLAY_REJECTED', 'CANDIDATE_SCHEMA_INVALID', 'ROLLBACK_COMPLETED'];

const DEFAULT_STALE_MS = 10 * 60 * 1000;

/**
 * The operational state of one device row.
 *
 * @param {object} account  the primary ProxyAccount (for activeSource + sibling devices)
 * @param {object} dev      the device row
 * @param {object} [opts]   { staleMs }
 * @returns {{state:string, isActiveSource:boolean, online:boolean, terminal:boolean, reason:string}}
 */
function stateOf(account, dev, opts) {
  const o = opts || {};
  const staleMs = o.staleMs || DEFAULT_STALE_MS;
  if (!dev) return { state: 'REVOKED', isActiveSource: false, online: false, terminal: true, reason: 'Unknown device.' };

  const activeId = account && account.activeSource && account.activeSource.deviceId;
  const isActiveSource = !!(activeId && activeId === dev.deviceId);
  const online = deviceSync.isOnline(dev, staleMs);

  // UNINSTALLED is checked FIRST because it is the more specific fact. Retiring a device also
  // stamps the revocation bookkeeping (the credential must die either way), so testing `revoked`
  // first would report every uninstalled machine as "revoked by an admin" — which is not what
  // happened, and sends the operator looking for an admin action that never took place.
  if (dev.uninstalledAt) {
    return {
      state: 'UNINSTALLED', isActiveSource, online: false, terminal: true,
      reason: 'The agent was uninstalled on that machine and reported its own removal. Run the installer again to enrol a new identity.',
    };
  }
  if (dev.revoked) {
    return {
      state: 'REVOKED', isActiveSource, online: false, terminal: true,
      reason: 'Revoked by an admin. It cannot sync, receive commands or open Chrome. Reinstalling the agent enrols a new identity.',
    };
  }
  if (dev.supersededBy || deviceSync.isSupersededDevice(account, dev, staleMs)) {
    return {
      state: 'SUPERSEDED', isActiveSource, online: false, terminal: true,
      reason: 'Replaced by a newer enrolment of the same machine. Kept for history only.',
    };
  }
  if (!online) {
    return {
      state: 'OFFLINE', isActiveSource, online: false, terminal: false,
      reason: isActiveSource
        ? 'Active source is offline. WriteHuman keeps using the last verified session; no other device is promoted automatically.'
        : 'No heartbeat inside the last ' + Math.round(staleMs / 60000) + ' minutes.',
    };
  }
  if (!isActiveSource && ERROR_CODES.includes(dev.lastResultCode)) {
    return {
      state: 'ERROR', isActiveSource: false, online: true, terminal: false,
      reason: 'Last exchange failed: ' + dev.lastResultCode + '. This device needs attention before it can take over.',
    };
  }
  if (isActiveSource) {
    return {
      state: 'ACTIVE', isActiveSource: true, online: true, terminal: false,
      reason: 'Supplying the live WriteHuman session. Only this device may update the active bundle.',
    };
  }
  // STANDBY vs READY is about history, not capability: both may be activated, but only one of them
  // has ever held the title. Keeping them apart is what lets the operator see "this is the machine
  // I moved off" as distinct from "this is the machine I just installed".
  const heldBefore = !!(dev.demotedAt || (dev.promotionCount || 0) > 0);
  if (heldBefore) {
    return {
      state: 'STANDBY', isActiveSource: false, online: true, terminal: false,
      reason: 'Authorized and online. Its routine cookie changes are recorded but never promoted — press Mark Active to hand it the session.',
    };
  }
  return {
    state: 'READY', isActiveSource: false, online: true, terminal: false,
    reason: 'Authorized and online, not yet activated. Press Mark Active to capture and verify this machine’s session.',
  };
}

/** May a device in this state be given the active-source title? */
function canActivate(state) { return state === 'READY' || state === 'STANDBY'; }

/**
 * May a device in this state be addressed AT ALL — command, cookie push, anything?
 * The three terminal states are the whole answer, and it is the same answer everywhere.
 */
function mayAct(state) { return !TERMINAL.includes(state); }

/**
 * May this device's ROUTINE cookie refresh update the live bundle? Only the active source.
 * This is the standby-protection rule in one place; candidateSync defers to it.
 */
function mayRefreshActiveBundle(state) { return state === 'ACTIVE'; }

/** Convenience: the state of every device on the account, in registry order. */
function fleet(account, opts) {
  return deviceSync.getDevices(account)
    .map(d => Object.assign({ deviceId: d.deviceId, name: d.name || null }, stateOf(account, d, opts)));
}

/**
 * Invariant check used by the tests and by the admin state route: at most ONE device may be ACTIVE.
 * Returns the offending device ids, or an empty array when the invariant holds.
 */
function activeConflicts(account, opts) {
  return fleet(account, opts).filter(f => f.state === 'ACTIVE').map(f => f.deviceId).slice(1);
}

module.exports = {
  STATES, TERMINAL, ERROR_CODES, DEFAULT_STALE_MS,
  stateOf, canActivate, mayAct, mayRefreshActiveBundle, fleet, activeConflicts,
};
