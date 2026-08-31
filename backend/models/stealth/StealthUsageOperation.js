'use strict';
/**
 * StealthUsageOperation — the durable RESERVED → COMMITTED / CANCELLED / EXPIRED
 * record behind "StealthWriter usage is charged only after a real result".
 *
 * WHY THIS TABLE EXISTS
 * The old flow charged on the CLICK: the overlay called /consume before the upstream
 * request was even dispatched, so a StealthWriter "service is temporarily unavailable
 * due to high demand" error still cost the member one Humanizer credit. Charging only
 * after a verified result needs two things a click cannot provide — capacity held
 * across the round trip (so concurrent attempts cannot exceed the daily limit), and an
 * idempotency key so a retried commit cannot charge twice. Both live here, in the
 * database, so they survive multiple Passenger workers, a page reload and a restart.
 *
 * TWO ROW KINDS, ONE TABLE
 *   reservation  _id = 'r' + sha256(clientId|action)[0..30]   (32 chars, leading 'r')
 *   outcome      _id = operationId                            (32 hex chars)
 * The reservation id is DETERMINISTIC per (client, action). That is the whole
 * concurrency design: the primary key itself guarantees at most one active
 * reservation per client+action, so two racing reserves leave exactly one surviving
 * operationId and only that one can ever be committed. The leading 'r' is not a hex
 * digit, so a reservation id can never collide with an operationId.
 *
 * THE ATOMIC GATE is DELETE-by-primary-key, exactly as utils/launchStore.js does for
 * one-time launch codes and for the same reason: db/mysqlAdapter.js implements
 * findOneAndUpdate as read → merge in JS → write, which is NOT safe against concurrent
 * callers. InnoDB serializes the row delete and mysql2 reports affectedRows exactly, so
 * `deletedCount === 1` is the single database-enforced answer to "did I win the claim".
 *
 * NEVER store submitted text, generated output, cookies, tokens, headers, credentials
 * or any request body here — only ids, the action, the lifecycle status, a short
 * outcome code, the upstream HTTP status and timestamps.
 */
const crypto = require('crypto');
const { createModel } = require('../../db/mysqlAdapter');

const STATUSES = ['reserved', 'committed', 'cancelled', 'expired'];

/** Deterministic reservation-row id for one (client, action) pair. */
function reservationId(clientId, action) {
  const digest = crypto.createHash('sha256').update(`${clientId}|${action}`).digest('hex');
  return 'r' + digest.slice(0, 31); // 32 chars total; 'r' keeps it out of the operationId space
}

/** Cryptographically random, unguessable operation id (128 bits, 32 hex chars). */
function newOperationId() {
  return crypto.randomBytes(16).toString('hex');
}

/** Shape check before an id is ever used in a lookup. */
function isOperationId(value) {
  return typeof value === 'string' && /^[0-9a-f]{32}$/.test(value);
}

/** Constant-time equality for two operation ids (no timing signal on a near-miss). */
function operationIdsEqual(a, b) {
  if (!isOperationId(a) || !isOperationId(b)) return false;
  return crypto.timingSafeEqual(Buffer.from(a, 'hex'), Buffer.from(b, 'hex'));
}

const StealthUsageOperation = createModel('StealthUsageOperation', {
  preSave: async (data) => {
    if (!STATUSES.includes(data.status)) data.status = 'reserved';
    if (!data.kind) data.kind = data.status === 'reserved' ? 'reservation' : 'outcome';
    if (data.outcomeCode) data.outcomeCode = String(data.outcomeCode).slice(0, 48);
    if (data.upstreamStatus !== undefined && data.upstreamStatus !== null) {
      const n = Math.trunc(Number(data.upstreamStatus));
      data.upstreamStatus = Number.isFinite(n) ? n : null;
    }
    return data;
  },
  methods: {
    isExpired(now = new Date()) {
      if (!this.expiresAt) return true;
      return new Date(this.expiresAt).getTime() <= now.getTime();
    },
  },
  statics: { reservationId, newOperationId, isOperationId, operationIdsEqual, STATUSES },
});

// The helpers are reachable as statics on the model (StealthUsageOperation.reservationId,
// .newOperationId, .isOperationId, .operationIdsEqual) — createModel installs them as
// non-writable properties, so they are not re-assigned here.
module.exports = StealthUsageOperation;
