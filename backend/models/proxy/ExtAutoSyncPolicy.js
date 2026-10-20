'use strict';
/**
 * ExtAutoSyncPolicy — the persistent, admin-approved WriteHuman (live-agent) extension auto-sync
 * policy, stored in its OWN record keyed by { tool, accountId }.
 *
 * WHY A SEPARATE RECORD (not a field on ProxyAccount): the hardened agent pipeline
 * (candidateSync/agentSync) whole-record-saves the ProxyAccount many times per cycle from an
 * in-memory copy loaded at request start. A policy field living on the account would be silently
 * RESTORED to its stale value by any such save landing after an admin disable/rebind — undoing the
 * admin action. Keeping the policy in its own record means those account saves never touch it, so an
 * admin disable/rebind cannot be reverted by a concurrent stale account save. The engine writes only
 * the `sync` sub-object (status); the admin endpoint writes the control fields + bumps `policyEpoch`.
 *
 * Fields: tool, accountId, enabled, mode('observe'|'enforce'), officialDomain, disabledExplicitly,
 * boundAt, boundBy, policyEpoch (monotonic, bumped on every control change), sync:{...status}.
 */
const { createModel } = require('../../db/mysqlAdapter');

module.exports = createModel('ExtAutoSyncPolicy', {
  preSave: async (data) => {
    if (!data.mode) data.mode = 'observe';
    if (typeof data.enabled !== 'boolean') data.enabled = false;
    return data;
  },
});
