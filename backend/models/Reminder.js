'use strict';
const { createModel } = require('../db/mysqlAdapter');

/**
 * Admin follow-up reminder (simple CRM task — NOT a calendar system).
 * Fields: clientId, title, note, dueDate, status (pending|done|cancelled),
 * createdBy (admin user id), createdAt/updatedAt (added by the adapter).
 * No secrets are ever stored here.
 */
const STATUSES = ['pending', 'done', 'cancelled'];

const Reminder = createModel('Reminder', {
  statics: {
    STATUSES: () => STATUSES.slice(),
  },
});

module.exports = Reminder;
