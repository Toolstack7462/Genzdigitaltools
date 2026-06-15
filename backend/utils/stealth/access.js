'use strict';
/**
 * Central access / usage engine for the StealthWriter module.
 *
 * The backend is the single source of truth. Every gateway action re-validates
 * the client's status, plan expiry and daily limits here — the frontend / overlay
 * is never trusted. Lazy reset (5:00 AM PKT) is applied before any limit check.
 */
const { applyLazyReset } = require('./time');

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

module.exports = { ACTIONS, REASONS, remainingFor, assessStatus, snapshot, consume, limitFor, usedFor };
