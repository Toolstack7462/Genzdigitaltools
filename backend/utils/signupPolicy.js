'use strict';

/**
 * Pure signup / email-verification policy helpers.
 *
 * No database, no HTTP, no secrets — every function here is deterministic and
 * unit-testable (mirrors the utils/renewalWindow.js pattern already used by the
 * renewals engine). The route handlers and the EmailVerification model import
 * these so normalization, expiry, attempt and cooldown rules have exactly ONE
 * definition and can never drift between signup, resend and verify.
 */

// ── Tunables ────────────────────────────────────────────────────────────────
const OTP_TTL_MS = 10 * 60 * 1000;   // a code is valid for 10 minutes
const MAX_ATTEMPTS = 5;              // wrong-code attempts before the challenge locks
const RESEND_COOLDOWN_MS = 60 * 1000; // minimum gap between two SUCCESSFUL sends
const MAX_SENDS = 5;                 // successful sends per rolling window
const SEND_WINDOW_MS = 60 * 60 * 1000; // after 1h of no successful send, the budget resets
const OTP_DIGITS = 6;

/**
 * Canonical email form used for storage AND lookup.
 *
 * Trims (including unicode/NBSP whitespace, which a phone keyboard or a paste
 * from WhatsApp can introduce) and lowercases. Deliberately does NOT strip
 * gmail-style dots or +aliases: those identify genuinely different addresses to
 * some providers, and collapsing them here would silently merge distinct
 * people. Alias collisions are surfaced by scripts/reconcile-registrations.js
 * as a report instead.
 */
function normalizeEmail(raw) {
  return String(raw == null ? '' : raw)
    .replace(/^[\s ​-‍﻿]+|[\s ​-‍﻿]+$/g, '')
    .toLowerCase();
}

/**
 * Anchored, case-insensitive, whitespace-tolerant lookup for an email column.
 *
 * The MySQL adapter compares strings with a case-SENSITIVE `String(a)===String(b)`
 * (db/mysqlAdapter.js valuesEqual), so a bare `findOne({ email })` misses any
 * legacy row stored with different case or stray surrounding whitespace — which
 * is exactly how a duplicate account gets created. Regex metacharacters are
 * escaped so `.` and `+` in real addresses stay literal.
 */
function emailMatch(email) {
  const escaped = normalizeEmail(email).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return { $regex: `^\\s*${escaped}\\s*$`, $options: 'i' };
}

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
function isValidEmail(email) {
  return EMAIL_RE.test(normalizeEmail(email));
}

/**
 * How an already-existing user row should be treated by signup.
 *   'verified'   — a real, proven account: send them to login / password reset,
 *                  never touch the record.
 *   'unverified' — a legacy account created by the old "create first, email
 *                  later" flow: let them resume verification, but do NOT
 *                  overwrite the password (that would be an account-takeover
 *                  vector, since these accounts can already log in today).
 *   null         — no account.
 */
function classifyExisting(user) {
  if (!user) return null;
  return user.emailVerified ? 'verified' : 'unverified';
}

/** Milliseconds still to wait before another send is allowed (0 = send now). */
function cooldownRemainingMs(lastSentAt, now = new Date(), cooldownMs = RESEND_COOLDOWN_MS) {
  if (!lastSentAt) return 0;
  const elapsed = new Date(now).getTime() - new Date(lastSentAt).getTime();
  if (!Number.isFinite(elapsed) || elapsed < 0) return 0;
  return Math.max(0, cooldownMs - elapsed);
}

/**
 * Send budget. `sendCount` only ever counts CONFIRMED sends, so a provider
 * outage can never exhaust it — a failed attempt must not lock the user out.
 * The budget resets once a full window has passed with no successful send.
 */
function sendBudget(pending, now = new Date(), { maxSends = MAX_SENDS, windowMs = SEND_WINDOW_MS } = {}) {
  const last = pending && pending.lastSentAt ? new Date(pending.lastSentAt).getTime() : 0;
  const stale = !last || (new Date(now).getTime() - last) >= windowMs;
  const used = stale ? 0 : Number((pending && pending.sendCount) || 0);
  return { used, remaining: Math.max(0, maxSends - used), exhausted: used >= maxSends, reset: stale };
}

function isExpired(expiresAt, now = new Date()) {
  if (!expiresAt) return true;
  return new Date(expiresAt).getTime() <= new Date(now).getTime();
}

module.exports = {
  OTP_TTL_MS,
  MAX_ATTEMPTS,
  RESEND_COOLDOWN_MS,
  MAX_SENDS,
  SEND_WINDOW_MS,
  OTP_DIGITS,
  normalizeEmail,
  emailMatch,
  isValidEmail,
  classifyExisting,
  cooldownRemainingMs,
  sendBudget,
  isExpired,
};
