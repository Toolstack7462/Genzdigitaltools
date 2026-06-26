'use strict';
/**
 * StealthClient — per-CRM-client StealthWriter plan + usage record.
 *
 * Isolated from the core User/Tool/Assignment flow. One StealthClient row maps
 * to exactly one CRM User (role CLIENT) via `userId`. The backend is the single
 * source of truth for limits and usage — never the frontend / localStorage.
 *
 * Daily limits use -1 to mean "unlimited". Usage counters reset every day at
 * 05:00 Asia/Karachi (Pakistan) time via cron + lazy reset (see utils/stealth/time.js).
 */
const { createModel } = require('../../db/mysqlAdapter');

const StealthClient = createModel('StealthClient', {
  preSave: async (data) => {
    if (!data.status) data.status = 'active';
    if (data.planName === undefined || data.planName === null) data.planName = 'StealthWriter';
    // Limits: -1 = unlimited. Coerce to safe integers.
    if (data.dailyHumanizerLimit === undefined || data.dailyHumanizerLimit === null) data.dailyHumanizerLimit = 50;
    if (data.dailyDetectorLimit === undefined || data.dailyDetectorLimit === null) data.dailyDetectorLimit = 50;
    data.dailyHumanizerLimit = Math.trunc(Number(data.dailyHumanizerLimit));
    data.dailyDetectorLimit = Math.trunc(Number(data.dailyDetectorLimit));
    if (!Number.isFinite(data.dailyHumanizerLimit)) data.dailyHumanizerLimit = 0;
    if (!Number.isFinite(data.dailyDetectorLimit)) data.dailyDetectorLimit = 0;
    if (!data.usage || typeof data.usage !== 'object') {
      data.usage = { humanizerUsed: 0, detectorUsed: 0, lastResetAt: new Date() };
    }
    data.usage.humanizerUsed = Math.max(0, Math.trunc(Number(data.usage.humanizerUsed || 0)));
    data.usage.detectorUsed = Math.max(0, Math.trunc(Number(data.usage.detectorUsed || 0)));

    // Optional account pinning (admin-controlled). Default 'auto' = use the
    // global pool exactly as before. pinnedAccountId references a StealthAccount;
    // pinnedAccountLabel is a denormalized SAFE label for display (no secrets).
    const PIN_MODES = ['auto', 'specific', 'specific_or_auto'];
    if (!PIN_MODES.includes(data.accountPinMode)) data.accountPinMode = 'auto';
    if (data.accountPinMode === 'auto') {
      data.pinnedAccountId = null;
      data.pinnedAccountLabel = null;
    } else {
      data.pinnedAccountId = data.pinnedAccountId ? String(data.pinnedAccountId) : null;
      if (!data.pinnedAccountId) {
        // A pin mode without a target is meaningless — fall back to auto.
        data.accountPinMode = 'auto';
        data.pinnedAccountLabel = null;
      } else {
        data.pinnedAccountLabel = data.pinnedAccountLabel ? String(data.pinnedAccountLabel).slice(0, 160) : null;
      }
    }
    return data;
  },
  methods: {
    isUnlimited(action) {
      const limit = action === 'humanizer' ? this.dailyHumanizerLimit : this.dailyDetectorLimit;
      return Number(limit) < 0;
    }
  }
});

module.exports = StealthClient;
