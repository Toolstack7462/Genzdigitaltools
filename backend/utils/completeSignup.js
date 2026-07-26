'use strict';

/**
 * Turn a verified PENDING registration into a real account.
 *
 * Lives outside the route so the atomicity/idempotency rules can be tested
 * directly (tests/signupFlow.test.js) instead of only through HTTP.
 *
 * Guarantees:
 *  - the OTP is consumed BEFORE the account is created, so a replayed code
 *    cannot mint a second account;
 *  - creation is serialised per email and re-checks for an existing user inside
 *    the lock, so two simultaneous correct-code requests yield ONE account and
 *    both callers see success;
 *  - the stored bcrypt hash is carried over untouched (User.preSave detects an
 *    existing hash and does not re-hash it).
 */
const User = require('../models/User');
const EmailVerification = require('../models/EmailVerification');
const { withLock } = require('./keyedLock');
const { normalizeEmail, emailMatch } = require('./signupPolicy');

/**
 * @returns {Promise<{ok:true, created:boolean, user:object, replay?:boolean}
 *                  | {ok:false, reason:string, attemptsLeft?:number}>}
 */
async function completeSignup({ email, code, now = new Date() }) {
  const normalized = normalizeEmail(email);

  const result = await EmailVerification.verifySignupOtp({ email: normalized, code: String(code == null ? '' : code).trim(), now });

  if (!result.ok) {
    // A code that is already consumed AND whose account exists is a double-submit
    // of a request that succeeded — report the true state rather than an error.
    if (result.reason === 'consumed') {
      const already = await User.findOne({ email: emailMatch(normalized) });
      if (already) return { ok: true, created: false, replay: true, user: already };
    }
    return { ok: false, reason: result.reason, ...(typeof result.attemptsLeft === 'number' ? { attemptsLeft: result.attemptsLeft } : {}) };
  }

  return withLock(`signup:${normalized}`, async () => {
    const existing = await User.findOne({ email: emailMatch(normalized) });
    if (existing) {
      if (!existing.emailVerified) {
        existing.emailVerified = true;
        existing.emailVerifiedAt = new Date(now);
        await existing.save();
      }
      return { ok: true, created: false, user: existing };
    }

    const user = await User.create({
      fullName: result.pending.fullName,
      email: result.pending.email,
      passwordHash: result.pending.passwordHash, // already bcrypt
      role: 'CLIENT',
      status: 'active',
      emailVerified: true,
      emailVerifiedAt: new Date(now),
      devicePolicy: { enabled: true, maxDevices: 1 },
    });
    return { ok: true, created: true, user };
  });
}

module.exports = { completeSignup };
