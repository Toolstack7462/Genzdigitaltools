'use strict';
const crypto = require('crypto');
const { createModel } = require('../db/mysqlAdapter');
const {
  OTP_TTL_MS, MAX_ATTEMPTS, OTP_DIGITS,
  normalizeEmail, cooldownRemainingMs, sendBudget, isExpired,
} = require('../utils/signupPolicy');

// Record kinds stored in this table.
const TYPE_VERIFY = 'verify';  // legacy: OTP for an account that ALREADY exists
const TYPE_RESET = 'reset';    // password-reset token
const TYPE_SIGNUP = 'signup';  // PENDING registration — no user row exists yet

/** Constant-time compare of two hex digests (avoids leaking the code via timing). */
function hashesEqual(a, b) {
  const ba = Buffer.from(String(a || ''), 'hex');
  const bb = Buffer.from(String(b || ''), 'hex');
  if (ba.length === 0 || ba.length !== bb.length) return false;
  return crypto.timingSafeEqual(ba, bb);
}

/**
 * One-time, expiring secrets for email flows. Two kinds:
 *   type 'verify' — a 6-digit OTP emailed on signup / resend (codeHash stored)
 *   type 'reset'  — a random token behind a password-reset link (tokenHash stored)
 *
 * Raw codes/tokens are NEVER stored or logged — only their SHA-256 hash. Each
 * record expires and can be consumed exactly once. Issuing a new secret for the
 * same email+type invalidates any outstanding one.
 */
const EmailVerification = createModel('EmailVerification', {
  statics: {
    hash(value) {
      return crypto.createHash('sha256').update(String(value || '')).digest('hex');
    },

    async _invalidateOutstanding(email, type) {
      const open = await this.find({ email, type, status: 'active' });
      for (const doc of open) {
        doc.status = 'invalidated';
        doc.consumedAt = doc.consumedAt || new Date();
        await doc.save();
      }
    },

    // ── Email verification OTP ────────────────────────────────────────────────
    async issueOtp({ userId, email, ttlMs = 10 * 60 * 1000 }) {
      await this._invalidateOutstanding(email, 'verify');
      const code = String(crypto.randomInt(0, 1000000)).padStart(6, '0');
      await this.create({
        userId, email, type: 'verify',
        codeHash: this.hash(code),
        expiresAt: new Date(Date.now() + ttlMs),
        attempts: 0,
        consumedAt: null,
        status: 'active',
      });
      return { code }; // returned to caller for emailing only — never logged
    },

    async verifyOtp({ email, code }) {
      const doc = await this.findOne({ email, type: 'verify', status: 'active' }).sort({ createdAt: -1 });
      if (!doc) return { ok: false, reason: 'not_found' };
      if (new Date(doc.expiresAt).getTime() <= Date.now()) return { ok: false, reason: 'expired' };
      if (Number(doc.attempts || 0) >= 5) {
        doc.status = 'locked'; await doc.save();
        return { ok: false, reason: 'locked' };
      }
      if (doc.codeHash !== this.hash(code)) {
        doc.attempts = Number(doc.attempts || 0) + 1;
        await doc.save();
        return { ok: false, reason: 'mismatch' };
      }
      doc.consumedAt = new Date();
      doc.status = 'consumed';
      await doc.save();
      return { ok: true, userId: doc.userId, email: doc.email };
    },

    // ── Password reset token ──────────────────────────────────────────────────
    async issueResetToken({ userId, email, ttlMs = 30 * 60 * 1000 }) {
      await this._invalidateOutstanding(email, 'reset');
      const token = crypto.randomBytes(32).toString('hex');
      await this.create({
        userId, email, type: 'reset',
        tokenHash: this.hash(token),
        expiresAt: new Date(Date.now() + ttlMs),
        consumedAt: null,
        status: 'active',
      });
      return { token }; // returned for emailing only — never logged
    },

    // ── PENDING REGISTRATION (type 'signup') ──────────────────────────────────
    // A signup that has NOT been verified yet. No `users` row exists while this
    // record is outstanding, so a failed or undelivered email can never leave an
    // active, unverified account behind.
    //
    // The record id is DERIVED FROM THE NORMALIZED EMAIL, so the table's PRIMARY
    // KEY enforces exactly one pending registration per address: the adapter's
    // INSERT … ON DUPLICATE KEY UPDATE makes a repeat signup an idempotent
    // in-place refresh instead of a second row. That is what turns "Email already
    // exists" into "here's a fresh code".

    /** Deterministic 26-char id ('pr' + 24 hex) — fits id VARCHAR(32), never collides with newId(). */
    pendingIdFor(email) {
      return 'pr' + crypto.createHash('sha256').update(normalizeEmail(email)).digest('hex').slice(0, 24);
    },

    async findPendingSignup(email) {
      const doc = await this.findById(this.pendingIdFor(email));
      return doc && doc.type === TYPE_SIGNUP ? doc : null;
    },

    /**
     * Create or refresh the pending registration and mint a new OTP.
     *
     * Deliberately does NOT stamp lastSentAt/sendCount — those are advanced only
     * by markSignupSent() AFTER the provider confirms acceptance, so a provider
     * outage cannot burn the resend budget or lock the user out.
     *
     * Returns { code } (for emailing only — never logged) or { cooldownMs } /
     * { sendsExhausted } when the caller must back off.
     */
    async issueSignupOtp({ email, fullName, passwordHash, now = new Date(), ttlMs = OTP_TTL_MS, enforceCooldown = true }) {
      const normalized = normalizeEmail(email);
      const _id = this.pendingIdFor(normalized);
      const existing = await this.findById(_id);

      if (existing && existing.type === TYPE_SIGNUP && enforceCooldown) {
        const wait = cooldownRemainingMs(existing.lastSentAt, now);
        if (wait > 0) return { cooldownMs: wait };
        const budget = sendBudget(existing, now);
        if (budget.exhausted) return { sendsExhausted: true };
      }

      const code = String(crypto.randomInt(0, 10 ** OTP_DIGITS)).padStart(OTP_DIGITS, '0');
      const carried = existing && existing.type === TYPE_SIGNUP ? existing : null;
      const budget = sendBudget(carried, now);

      await this.create({
        _id,
        type: TYPE_SIGNUP,
        email: normalized,
        fullName,
        passwordHash,          // already bcrypt-hashed by the caller — never a plaintext password
        codeHash: this.hash(code),
        expiresAt: new Date(new Date(now).getTime() + ttlMs),
        attempts: 0,
        sendCount: budget.used, // preserved across refreshes; reset once the window goes stale
        lastSentAt: carried ? carried.lastSentAt || null : null,
        consumedAt: null,
        status: 'active',
        createdAt: carried ? carried.createdAt : new Date(now),
      });
      return { code };
    },

    /** Record a CONFIRMED send: advances the cooldown clock and the send budget. */
    async markSignupSent(email, now = new Date()) {
      const doc = await this.findPendingSignup(email);
      if (!doc) return null;
      const budget = sendBudget(doc, now);
      doc.sendCount = budget.used + 1;
      doc.lastSentAt = new Date(now);
      await doc.save();
      return doc;
    },

    /**
     * Check an OTP against the pending registration and, on success, CONSUME it.
     * Consuming before the account is created means a replayed code can never
     * produce a second account.
     */
    async verifySignupOtp({ email, code, now = new Date() }) {
      const doc = await this.findPendingSignup(email);
      if (!doc) return { ok: false, reason: 'not_found' };
      if (doc.status === 'consumed') return { ok: false, reason: 'consumed' };
      if (doc.status === 'locked') return { ok: false, reason: 'locked' };
      if (doc.status !== 'active') return { ok: false, reason: 'not_found' };
      if (isExpired(doc.expiresAt, now)) return { ok: false, reason: 'expired' };

      if (Number(doc.attempts || 0) >= MAX_ATTEMPTS) {
        doc.status = 'locked';
        await doc.save();
        return { ok: false, reason: 'locked' };
      }
      if (!hashesEqual(doc.codeHash, this.hash(code))) {
        doc.attempts = Number(doc.attempts || 0) + 1;
        await doc.save();
        const left = Math.max(0, MAX_ATTEMPTS - doc.attempts);
        if (left === 0) { doc.status = 'locked'; await doc.save(); }
        return { ok: false, reason: 'mismatch', attemptsLeft: left };
      }

      doc.consumedAt = new Date(now);
      doc.status = 'consumed';
      await doc.save();
      return {
        ok: true,
        pending: { email: doc.email, fullName: doc.fullName, passwordHash: doc.passwordHash },
      };
    },

    async consumeResetToken(token) {
      if (!token) return null;
      const doc = await this.findOne({ tokenHash: this.hash(token), type: 'reset', status: 'active' }).sort({ createdAt: -1 });
      if (!doc) return null;
      if (new Date(doc.expiresAt).getTime() <= Date.now()) return null;
      doc.consumedAt = new Date();
      doc.status = 'consumed';
      await doc.save();
      return { userId: doc.userId, email: doc.email };
    },
  },
});

EmailVerification.TYPE_VERIFY = TYPE_VERIFY;
EmailVerification.TYPE_RESET = TYPE_RESET;
EmailVerification.TYPE_SIGNUP = TYPE_SIGNUP;

module.exports = EmailVerification;
