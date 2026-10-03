'use strict';
/**
 * Central access / usage engine for the StealthWriter module.
 *
 * The backend is the single source of truth. Every gateway action re-validates
 * the client's status, plan expiry and daily limits here — the frontend / overlay
 * is never trusted. Lazy reset (5:00 AM PKT) is applied before any limit check.
 */
const { applyLazyReset } = require('./time');
const StealthUsageOperation = require('../../models/stealth/StealthUsageOperation');

const ACTIONS = ['humanizer', 'detector'];

const REASONS = {
  OK: 'ok',
  CLIENT_DISABLED: 'client_disabled',
  PLAN_EXPIRED: 'plan_expired',
  LIMIT_REACHED: 'limit_reached',
  INVALID_ACTION: 'invalid_action',
};

function limitFor(client, action) {
  return action === 'humanizer' ? Number(client.dailyHumanizerLimit) : Number(client.dailyDetectorLimit);
}
function usedFor(client, action) {
  const u = client.usage || {};
  return action === 'humanizer' ? Number(u.humanizerUsed || 0) : Number(u.detectorUsed || 0);
}

/** Remaining for one action. null = unlimited. */
function remainingFor(client, action) {
  const limit = limitFor(client, action);
  if (limit < 0) return null; // unlimited
  return Math.max(0, limit - usedFor(client, action));
}

/** Status + expiry gate only (no usage). */
function assessStatus(client, now = new Date()) {
  if (!client || client.status !== 'active') return { allowed: false, reason: REASONS.CLIENT_DISABLED };
  if (client.expiryDate) {
    const exp = new Date(client.expiryDate).getTime();
    if (!Number.isNaN(exp) && exp <= now.getTime()) return { allowed: false, reason: REASONS.PLAN_EXPIRED };
  }
  return { allowed: true, reason: REASONS.OK };
}

/** Snapshot used by dashboards / lease validation (applies lazy reset, persists if changed). */
async function snapshot(client, now = new Date()) {
  if (applyLazyReset(client, now)) {
    try { await client.save(); } catch (_) {}
  }
  const status = assessStatus(client, now);
  return {
    status: client.status,
    planName: client.planName,
    expiryDate: client.expiryDate || null,
    expired: status.reason === REASONS.PLAN_EXPIRED,
    active: status.allowed,
    limits: {
      humanizer: limitFor(client, 'humanizer'),
      detector: limitFor(client, 'detector'),
    },
    used: {
      humanizer: usedFor(client, 'humanizer'),
      detector: usedFor(client, 'detector'),
    },
    remaining: {
      humanizer: remainingFor(client, 'humanizer'),
      detector: remainingFor(client, 'detector'),
    },
  };
}

/**
 * Attempt to consume one unit of `action`. Applies lazy reset, validates status,
 * expiry and limits, increments usage and persists. Returns the decision plus the
 * post-action remaining counts. Persists the client document.
 */
async function consume(client, action, now = new Date()) {
  if (!ACTIONS.includes(action)) {
    return { allowed: false, reason: REASONS.INVALID_ACTION, remaining: {} };
  }
  applyLazyReset(client, now);

  const status = assessStatus(client, now);
  if (!status.allowed) {
    // Persist any lazy-reset change even on a blocked action.
    try { await client.save(); } catch (_) {}
    return {
      allowed: false,
      reason: status.reason,
      remaining: { humanizer: remainingFor(client, 'humanizer'), detector: remainingFor(client, 'detector') },
    };
  }

  const remaining = remainingFor(client, action); // null = unlimited
  if (remaining !== null && remaining <= 0) {
    try { await client.save(); } catch (_) {}
    return {
      allowed: false,
      reason: REASONS.LIMIT_REACHED,
      remaining: { humanizer: remainingFor(client, 'humanizer'), detector: remainingFor(client, 'detector') },
    };
  }

  // Grant: increment our own usage counter (single source of truth).
  if (!client.usage) client.usage = { humanizerUsed: 0, detectorUsed: 0, lastResetAt: now };
  if (action === 'humanizer') client.usage.humanizerUsed = usedFor(client, 'humanizer') + 1;
  else client.usage.detectorUsed = usedFor(client, 'detector') + 1;
  await client.save();

  return {
    allowed: true,
    reason: REASONS.OK,
    remaining: { humanizer: remainingFor(client, 'humanizer'), detector: remainingFor(client, 'detector') },
  };
}


// ════════════════════════════════════════════════════════════════════════════
// RESERVE → COMMIT / CANCEL — charge only after a verified result
// ════════════════════════════════════════════════════════════════════════════
// `consume()` above is the LEGACY charge-on-click path. It is deliberately left
// untouched so an older cached overlay still works during a rollout, but nothing new
// should use it: it increments the counter before StealthWriter has produced anything,
// which is exactly why a "service is temporarily unavailable due to high demand" error
// still cost the member a Humanizer credit.
//
// The lifecycle below splits that single act into three:
//
//   reserve()  holds capacity and mints one unguessable operation id. The visible
//              used counter does NOT move.
//   commit()   increments the counter EXACTLY once, and only when the gateway has
//              verified from the real upstream response that a result was produced.
//   cancel()   releases the reservation and leaves the counter untouched.
//
// Everything is keyed on the database, never on an in-memory lock, so it is correct
// across Passenger workers, a page reload and a gateway restart.
//
// CONCURRENCY. The reservation row's primary key is derived from (clientId, action),
// so the table itself allows at most ONE active reservation per client and action. Two
// racing reserves therefore leave exactly one surviving operation id, and only that id
// can be claimed at commit — which is what makes "1 remaining, two concurrent attempts"
// resolve to at most one charge. The claim itself is a DELETE by primary key, whose
// affectedRows count is the database's own answer to "did I win" (see the header of
// models/stealth/StealthUsageOperation.js).
//
// NOTHING here reads, stores or logs submitted text, generated output, cookies, tokens
// or credentials — only ids, the action, a lifecycle status and a short outcome code.

// Bounded, evidence-based reservation TTL. StealthWriter advertises a result in under
// 10 seconds; 180s leaves generous headroom for a slow or queued response while keeping
// the window in which an abandoned reservation blocks the next attempt short.
const RESERVATION_TTL_SEC = (() => {
  const n = parseInt(process.env.STEALTH_USAGE_OP_TTL_SEC, 10);
  return Number.isFinite(n) && n >= 15 && n <= 900 ? n : 180;
})();

// How long a terminal outcome row is kept so a late duplicate commit/cancel stays idempotent.
const OUTCOME_RETENTION_SEC = (() => {
  const n = parseInt(process.env.STEALTH_USAGE_OP_RETENTION_SEC, 10);
  return Number.isFinite(n) && n >= 300 ? n : 24 * 3600;
})();

const OP_REASONS = {
  IN_FLIGHT: 'operation_in_flight',
  NOT_FOUND: 'operation_not_found',
  SUPERSEDED: 'operation_superseded',
  EXPIRED: 'operation_expired',
  CANCELLED: 'operation_cancelled',
  INVALID: 'operation_invalid',
};

function remainingBoth(client) {
  return { humanizer: remainingFor(client, 'humanizer'), detector: remainingFor(client, 'detector') };
}

/** Load the single active-or-stale reservation row for (client, action), or null. */
async function loadReservation(clientId, action) {
  try { return await StealthUsageOperation.findById(StealthUsageOperation.reservationId(clientId, action)); }
  catch (_) { return null; }
}

/** Load a terminal outcome row by operation id, or null. */
async function loadOutcome(operationId) {
  if (!StealthUsageOperation.isOperationId(operationId)) return null;
  try { return await StealthUsageOperation.findById(operationId); }
  catch (_) { return null; }
}

async function writeOutcome(base, status, outcomeCode, upstreamStatus, now) {
  const doc = {
    _id: base.operationId,
    kind: 'outcome',
    operationId: base.operationId,
    clientId: base.clientId,
    leaseId: base.leaseId || null,
    accountId: base.accountId || null,
    action: base.action,
    status,
    outcomeCode: outcomeCode || null,
    upstreamStatus: (upstreamStatus === undefined || upstreamStatus === null) ? null : upstreamStatus,
    reservedAt: base.reservedAt || null,
    committedAt: status === 'committed' ? now : null,
    cancelledAt: (status === 'cancelled' || status === 'expired') ? now : null,
    purgeAt: new Date(now.getTime() + OUTCOME_RETENTION_SEC * 1000),
  };
  try { await StealthUsageOperation.create(doc); } catch (_) {}
  return doc;
}

/**
 * Step 1 — RESERVE. Validates status, plan expiry and available limit, then mints one
 * operation. The visible used counter is NOT incremented.
 *
 * Returns { ok:true, operationId, expiresAt, remaining } or { ok:false, reason, remaining }.
 * `reason` is one of REASONS.* (client_disabled / plan_expired / limit_reached /
 * invalid_action) or OP_REASONS.IN_FLIGHT.
 */
async function reserve(client, action, ctx = {}, now = new Date()) {
  if (!ACTIONS.includes(action)) return { ok: false, reason: REASONS.INVALID_ACTION, remaining: {} };

  applyLazyReset(client, now);
  const status = assessStatus(client, now);
  if (!status.allowed) {
    try { await client.save(); } catch (_) {}
    return { ok: false, reason: status.reason, remaining: remainingBoth(client) };
  }

  // One in-flight operation per (client, action). A live reservation from a DIFFERENT
  // lease blocks — that is what stops two sessions from spending the same last credit.
  // A live reservation from the SAME lease is superseded instead of blocking: the row is
  // overwritten, so the previous operation id can never be claimed and can never charge,
  // and a member who reloaded or re-clicked is not locked out for the whole TTL.
  const existing = await loadReservation(client._id, action);
  if (existing && existing.status === 'reserved' && !existing.isExpired(now)) {
    const sameLease = ctx.leaseId && existing.leaseId && String(existing.leaseId) === String(ctx.leaseId);
    if (!sameLease) {
      return { ok: false, reason: OP_REASONS.IN_FLIGHT, remaining: remainingBoth(client) };
    }
  }

  // Capacity. Because at most one reservation can be active for this (client, action),
  // "remaining >= 1" already accounts for the credit this reservation is about to hold.
  const remaining = remainingFor(client, action); // null = unlimited
  if (remaining !== null && remaining <= 0) {
    try { await client.save(); } catch (_) {}
    return { ok: false, reason: REASONS.LIMIT_REACHED, remaining: remainingBoth(client) };
  }

  const operationId = StealthUsageOperation.newOperationId();
  const expiresAt = new Date(now.getTime() + RESERVATION_TTL_SEC * 1000);
  await StealthUsageOperation.create({
    _id: StealthUsageOperation.reservationId(client._id, action),
    kind: 'reservation',
    operationId,
    clientId: String(client._id),
    leaseId: ctx.leaseId ? String(ctx.leaseId) : null,
    accountId: ctx.accountId ? String(ctx.accountId) : null,
    action,
    status: 'reserved',
    reservedAt: now,
    expiresAt,
  });
  try { await client.save(); } catch (_) {} // persist any lazy reset

  return { ok: true, reason: REASONS.OK, operationId, expiresAt, remaining: remainingBoth(client) };
}

/**
 * Claim the reservation for `operationId` atomically. Returns { won:true, row } on a win,
 * otherwise a description of why no charge may happen.
 */
async function claimReservation(client, action, operationId, now) {
  if (!StealthUsageOperation.isOperationId(operationId)) return { won: false, reason: OP_REASONS.INVALID };

  const row = await loadReservation(client._id, action);
  if (row && row.status === 'reserved' && StealthUsageOperation.operationIdsEqual(row.operationId, operationId)) {
    if (row.isExpired(now)) return { won: false, reason: OP_REASONS.EXPIRED };
    // ── The atomic gate: exactly one caller gets deletedCount === 1. ──
    const del = await StealthUsageOperation.deleteOne({ _id: StealthUsageOperation.reservationId(client._id, action) });
    if (del && del.deletedCount === 1) return { won: true, row };
    // Lost the race to a concurrent commit/cancel — fall through to the outcome record.
  }

  const outcome = await loadOutcome(operationId);
  if (outcome && outcome.kind === 'outcome') return { won: false, reason: 'outcome_' + outcome.status, outcome };
  if (row) return { won: false, reason: OP_REASONS.SUPERSEDED };
  return { won: false, reason: OP_REASONS.NOT_FOUND };
}

/**
 * Step 2 — COMMIT. Increments the counter exactly once, and only for an operation the
 * caller can prove it reserved. Safe to retry with the same operation id: a duplicate
 * returns the recorded result instead of charging again. A commit after a cancel, after
 * an expiry, or for a superseded operation is refused and charges nothing.
 */
async function commit(client, action, operationId, meta = {}, now = new Date()) {
  if (!ACTIONS.includes(action)) return { ok: false, committed: false, reason: REASONS.INVALID_ACTION, remaining: {} };

  const claim = await claimReservation(client, action, operationId, now);
  if (!claim.won) {
    if (claim.outcome && claim.outcome.status === 'committed') {
      // Duplicate commit / retried callback — the charge already happened exactly once.
      return { ok: true, committed: true, duplicate: true, reason: REASONS.OK, remaining: remainingBoth(client) };
    }
    const reason = claim.outcome
      ? (claim.outcome.status === 'cancelled' ? OP_REASONS.CANCELLED : OP_REASONS.EXPIRED)
      : claim.reason;
    return { ok: false, committed: false, reason, remaining: remainingBoth(client) };
  }

  // Re-check authorization at commit time: an admin may have disabled the client or the
  // plan may have expired while the request was in flight.
  applyLazyReset(client, now);
  const status = assessStatus(client, now);
  if (!status.allowed) {
    await writeOutcome(claim.row, 'cancelled', status.reason, meta.upstreamStatus, now);
    try { await client.save(); } catch (_) {}
    return { ok: false, committed: false, reason: status.reason, remaining: remainingBoth(client) };
  }

  if (!client.usage) client.usage = { humanizerUsed: 0, detectorUsed: 0, lastResetAt: now };
  if (action === 'humanizer') client.usage.humanizerUsed = usedFor(client, 'humanizer') + 1;
  else client.usage.detectorUsed = usedFor(client, 'detector') + 1;
  await client.save();

  await writeOutcome(claim.row, 'committed', meta.outcomeCode || 'result_verified', meta.upstreamStatus, now);
  return { ok: true, committed: true, duplicate: false, reason: REASONS.OK, remaining: remainingBoth(client) };
}

/**
 * Step 3 — CANCEL. Releases the reservation on a confirmed failure. Idempotent: a repeat
 * cancel is harmless, and a cancel that arrives after a commit reports the commit and
 * never undoes valid usage.
 */
async function cancel(client, action, operationId, meta = {}, now = new Date()) {
  if (!ACTIONS.includes(action)) return { ok: false, reason: REASONS.INVALID_ACTION, remaining: {} };

  const claim = await claimReservation(client, action, operationId, now);
  if (!claim.won) {
    if (claim.outcome && claim.outcome.status === 'committed') {
      return { ok: true, cancelled: false, committed: true, reason: OP_REASONS.CANCELLED, remaining: remainingBoth(client) };
    }
    // Already cancelled / expired / superseded / unknown — nothing was charged, so this is
    // a harmless no-op by design: a cancel that cannot be delivered must never become a charge.
    return { ok: true, cancelled: true, duplicate: true, reason: claim.reason, remaining: remainingBoth(client) };
  }

  await writeOutcome(claim.row, 'cancelled', meta.outcomeCode || 'upstream_failed', meta.upstreamStatus, now);
  return { ok: true, cancelled: true, duplicate: false, reason: REASONS.OK, remaining: remainingBoth(client) };
}

/**
 * Best-effort removal of rows nobody will look at again: reservations well past their TTL
 * and outcome rows past their retention window. Never throws, never blocks a request.
 * Self-throttled so a busy gateway does not scan the table on every action.
 */
let lastSweepAt = 0;
async function sweepUsageOperations(now = new Date(), force = false) {
  if (!force && now.getTime() - lastSweepAt < 10 * 60 * 1000) return 0;
  lastSweepAt = now.getTime();
  let removed = 0;
  try {
    const rows = await StealthUsageOperation.find({});
    for (const r of rows || []) {
      const dead = r.kind === 'outcome'
        ? (r.purgeAt && new Date(r.purgeAt).getTime() <= now.getTime())
        : (r.expiresAt && new Date(r.expiresAt).getTime() + OUTCOME_RETENTION_SEC * 1000 <= now.getTime());
      if (!dead) continue;
      const d = await StealthUsageOperation.deleteOne({ _id: r._id });
      removed += (d && d.deletedCount) || 0;
    }
  } catch (_) {}
  return removed;
}

module.exports = {
  ACTIONS, REASONS, OP_REASONS, remainingFor, assessStatus, snapshot, consume, limitFor, usedFor,
  // charge-only-on-success lifecycle (see the block comment above)
  reserve, commit, cancel, sweepUsageOperations,
  RESERVATION_TTL_SEC, OUTCOME_RETENTION_SEC,
};
