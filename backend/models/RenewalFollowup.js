'use strict';
const { createModel } = require('../db/mysqlAdapter');

/**
 * RenewalFollowup — ONE row per client (upserted by clientId) holding the renewal
 * RECOVERY state for clients who haven't renewed after expiry. Keeps the Renewals
 * page lightweight: the follow-up STAGE itself is DERIVED at read time from how
 * overdue the client is (see routes/admin/renewals.deriveStage) — this record only
 * stores the things that can't be derived: what the admin has DONE.
 *
 * Fields (safe metadata only — NO secrets):
 *   clientId        (string, the upsert key)
 *   status          'open' | 'snoozed' | 'lost' | 'recovered'
 *   lastFollowupAt  Date — when the admin last followed up
 *   lastChannel     'email' | 'whatsapp'
 *   lastStage       stage label at the last follow-up (e.g. 'day3')
 *   offer           'none' | 'discount10' | 'bonus2' — the retention offer last
 *                   extended (admin-controlled; NEVER auto-applied)
 *   note            admin free-text note
 *   snoozeUntil     Date — hide/deprioritise until this date
 *   lostReason      free-text when status='lost'
 *   updatedBy       admin userId
 */
const RenewalFollowup = createModel('RenewalFollowup', {});

module.exports = RenewalFollowup;
