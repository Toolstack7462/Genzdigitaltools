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

const ClaudeSettings = createModel('ClaudeSettings', {
  preSave: async (data) => {
    data._id = SINGLETON_ID; // enforce a single row
    for (const k of NUM_KEYS) {
      if (data[k] === undefined || data[k] === null || data[k] === '') { data[k] = null; continue; }
      const n = parseInt(data[k], 10);
      data[k] = Number.isFinite(n) && n >= 0 ? n : null;
    }
    if (data.safetyReservePct != null) data.safetyReservePct = Math.min(95, data.safetyReservePct);
    return data;
  },
  statics: {
    SINGLETON_ID() { return SINGLETON_ID; },
    NUM_KEYS() { return NUM_KEYS.slice(); },
  },
});

module.exports = ClaudeSettings;
