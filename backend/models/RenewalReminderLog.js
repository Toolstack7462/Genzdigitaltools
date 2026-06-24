'use strict';
const { createModel } = require('../db/mysqlAdapter');

/**
 * RenewalReminderLog — one row per renewal reminder an admin sends to a client
 * (via email or WhatsApp) from the Renewals view. Powers the "last reminded"
 * indicator so admins can see who was already contacted and avoid double-nagging,
 * and keeps a small history that survives the ActivityLog 7-day purge.
 *
 * Fields (safe metadata only — NO secrets):
 *   clientId, clientEmail, channel ('email'|'whatsapp'), toolCount,
 *   tools ([{ toolId, toolName, endDate }]), sentBy (admin userId), sentAt.
 */
const RenewalReminderLog = createModel('RenewalReminderLog', {});

module.exports = RenewalReminderLog;
