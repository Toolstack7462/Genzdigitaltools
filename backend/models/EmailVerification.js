'use strict';
const crypto = require('crypto');
const { createModel } = require('../db/mysqlAdapter');

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

module.exports = EmailVerification;
