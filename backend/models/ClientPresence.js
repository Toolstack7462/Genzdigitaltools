'use strict';
const { createModel } = require('../db/mysqlAdapter');

// Lightweight live-presence record for the admin Client Activity Monitor.
// ONE row per client (upserted by clientId) — this is a bounded presence table,
// NOT an append-only event log, so it stays tiny and fast to scan regardless of
// traffic. Stores only safe metadata (name/email snapshot, last event type, last
// tool name, ip, last-seen time) — never cookies/tokens/credentials/content.
const ClientPresence = createModel('ClientPresence', {
  preSave: async (data) => {
    if (data.clientId) data.clientId = String(data.clientId);
    return data;
  }
});

module.exports = ClientPresence;
