'use strict';
const { createModel } = require('../db/mysqlAdapter');

/**
 * Admin announcement shown to clients (maintenance notice, new tool, etc.).
 * Fields: title, body, level ('info'|'success'|'warning'), active (published),
 * createdBy, createdAt/updatedAt. No secrets. Clients only ever read active ones.
 */
const LEVELS = ['info', 'success', 'warning'];

const Announcement = createModel('Announcement', {
  statics: { LEVELS: () => LEVELS.slice() },
});

module.exports = Announcement;
