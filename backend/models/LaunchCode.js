'use strict';
/**
 * LaunchCode — a single-use, 30–60 second bootstrap record that lets a gateway exchange a
 * POST'ed code for an already-authorized lease, without the lease ever appearing in a URL.
 *
 * The row's `_id` IS the first 128 bits of the code's SHA-256 digest. That is deliberate:
 * redemption is then a DELETE by primary key, whose affectedRows count is an exact,
 * database-enforced "did I win the race" answer — the only way to get truly atomic
 * one-time redemption on this adapter, whose findOneAndUpdate is a read-then-write in JS
 * and therefore NOT safe against concurrent redeemers.
 *
 * The full digest is stored alongside and compared in constant time, so a truncated-hash
 * collision cannot redeem another client's code.
 *
 * NEVER store the raw code, a lease token, cookies or any credential here — only the digest,
 * the ids needed to rebuild the lease, and audit timestamps.
 */
const { createModel } = require('../db/mysqlAdapter');

const LaunchCode = createModel('LaunchCode', {
  preSave: async (data) => {
    if (!data.issuedAt) data.issuedAt = new Date();
    if (!data.module) data.module = 'proxy';
    if (data.capture === undefined) data.capture = false;
    if (data.userAgent) data.userAgent = String(data.userAgent).slice(0, 256);
    return data;
  },
  methods: {
    isExpired(now = new Date()) {
      if (!this.expiresAt) return true;
      return new Date(this.expiresAt).getTime() <= now.getTime();
    },
  },
});

module.exports = LaunchCode;
