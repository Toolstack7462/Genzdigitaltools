'use strict';
/**
 * StealthSettings — single-row, admin-configurable module settings.
 *
 *  - leaseDurationMinutes : lifetime of a fixed lease (default 30).
 *  - fixedLeaseEnabled    : when true, every lease expires after
 *                           leaseDurationMinutes and the gateway shows a
 *                           countdown. When false, the admin has disabled the
 *                           fixed timer — leases run for maxSessionMinutes
 *                           instead, BUT the backend still validates client
 *                           status, expiry and usage limits on every action.
 *  - maxSessionMinutes    : lease lifetime when fixedLeaseEnabled is false.
 *
 * Access via utils/stealth/config.js (getSettings / updateSettings), which
 * guarantees a row exists and clamps values to safe ranges.
 */
const { createModel } = require('../../db/mysqlAdapter');

const StealthSettings = createModel('StealthSettings', {
  preSave: async (data) => {
    if (data.leaseDurationMinutes === undefined || data.leaseDurationMinutes === null) data.leaseDurationMinutes = 30;
    if (data.fixedLeaseEnabled === undefined || data.fixedLeaseEnabled === null) data.fixedLeaseEnabled = true;
    if (data.maxSessionMinutes === undefined || data.maxSessionMinutes === null) data.maxSessionMinutes = 720;
    data.leaseDurationMinutes = Math.min(720, Math.max(1, Math.trunc(Number(data.leaseDurationMinutes)) || 30));
    data.maxSessionMinutes = Math.min(1440, Math.max(5, Math.trunc(Number(data.maxSessionMinutes)) || 720));
    data.fixedLeaseEnabled = !!data.fixedLeaseEnabled;
    return data;
  }
});

module.exports = StealthSettings;
