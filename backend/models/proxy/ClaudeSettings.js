'use strict';
/**
 * ClaudeSettings — a SINGLE-row store for admin-editable GLOBAL Claude quota defaults
 * (five-hour + weekly per-client defaults, per-account base capacities, safety reserve).
 * Claude-only and isolated. Every field is optional; a null/unset field transparently falls
 * back to the server env default, then to the hardcoded default. Contains NO secrets.
 *
 * The row is keyed by a fixed id so there is always exactly one document.
 */
const { createModel } = require('../../db/mysqlAdapter');

const SINGLETON_ID = 'claude_global';
const NUM_KEYS = ['defaultClientLimit', 'defaultWeeklyClientLimit', 'accountBaseTokens', 'accountWeeklyBaseTokens', 'safetyReservePct'];
// Boolean admin flags. Kept SEPARATE from NUM_KEYS because the numeric pipeline coerces with
// parseInt and drops anything non-finite — a boolean routed through it would silently become
// null. `allowFable5` is the "Allow Fable 5: On/Off" switch; a missing row or a missing key
// means OFF (blocked), so the safe state is also the default state.
const BOOL_KEYS = ['allowFable5'];

/** Strict, explicit truthiness — anything not clearly "on" is false. */
function toBool(v) {
  if (v === true) return true;
  if (v == null) return false;
  return /^(1|true|on|yes)$/i.test(String(v).trim());
}

const ClaudeSettings = createModel('ClaudeSettings', {
  preSave: async (data) => {
    data._id = SINGLETON_ID; // enforce a single row
    for (const k of NUM_KEYS) {
      if (data[k] === undefined || data[k] === null || data[k] === '') { data[k] = null; continue; }
      const n = parseInt(data[k], 10);
      data[k] = Number.isFinite(n) && n >= 0 ? n : null;
    }
    if (data.safetyReservePct != null) data.safetyReservePct = Math.min(95, data.safetyReservePct);
    for (const k of BOOL_KEYS) data[k] = toBool(data[k]);
    return data;
  },
  statics: {
    SINGLETON_ID() { return SINGLETON_ID; },
    NUM_KEYS() { return NUM_KEYS.slice(); },
    BOOL_KEYS() { return BOOL_KEYS.slice(); },
    toBool,
  },
});

module.exports = ClaudeSettings;
