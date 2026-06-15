'use strict';

/**
 * Email verification + password reset endpoints (Resend-backed).
 * Mounted at /api/crm/auth — these are NEW paths and do not alter the existing
 * login / refresh / logout / register handlers.
 *
 * Security notes:
 *  - OTP codes and reset tokens are one-time use and expire (see EmailVerification).
 *  - Codes/tokens/passwords are never logged.
 *  - "forgot" and "resend" always return a generic success so the endpoints can't
 *    be used to enumerate which emails have accounts.
 */

const express = require('express');
const router = express.Router();
const User = require('../models/User');
const EmailVerification = require('../models/EmailVerification');
const ActivityLog = require('../models/ActivityLog');
const { getClientIp } = require('../middleware/authEnhanced');
const { normalizeAuthInputs } = require('../middleware/normalize');
const { authLimiter } = require('../middleware/rateLimiter');
const {
  isEmailEnabled,
  sendVerificationEmail,
  sendPasswordResetEmail,
  sendPasswordResetSuccessEmail,
} = require('../utils/email');

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const GENERIC_OK = { success: true, message: 'If that email exists, we just sent it a message.' };

// ─── POST /verify-email ────────────────────────────────────────────────────────
// Body: { email, code } — confirms the 6-digit OTP and flags the account verified.
router.post('/verify-email', authLimiter, normalizeAuthInputs, async (req, res) => {
  try {
    const { email, code } = req.body || {};
    if (!email || !code) return res.status(400).json({ error: 'Email and code are required' });

    const result = await EmailVerification.verifyOtp({ email, code: String(code).trim() });
    if (!result.ok) {
      const map = {
        expired: 'This code has expired. Please request a new one.',
        locked: 'Too many attempts. Please request a new code.',
        not_found: 'Invalid or expired code.',
        mismatch: 'Invalid code. Please check and try again.',
      };
      return res.status(400).json({ error: map[result.reason] || 'Invalid or expired code.' });
    }

    const user = await User.findOne({ email });
    if (user && !user.emailVerified) {
      user.emailVerified = true;
      user.emailVerifiedAt = new Date();
      await user.save();
    }
    await ActivityLog.log('SYSTEM', null, 'EMAIL_VERIFIED', { email, ip: getClientIp(req) });
    return res.json({ success: true, message: 'Email verified successfully.' });
  } catch (err) {
    console.error('verify-email error:', err.message);
    return res.status(500).json({ error: 'Verification failed' });
  }
});

// ─── POST /resend-verification ─────────────────────────────────────────────────
// Body: { email } — re-issues an OTP if the account exists and is unverified.
router.post('/resend-verification', authLimiter, normalizeAuthInputs, async (req, res) => {
  try {
    const { email } = req.body || {};
    if (!email || !EMAIL_RE.test(email)) return res.status(400).json({ error: 'A valid email is required' });

    const user = await User.findOne({ email });
    if (user && !user.emailVerified) {
      const { code } = await EmailVerification.issueOtp({ userId: user._id, email });
      await sendVerificationEmail(email, code);
      await ActivityLog.log('SYSTEM', null, 'EMAIL_VERIFICATION_RESENT', { email, ip: getClientIp(req) });
    }
    return res.json({ success: true, message: 'If your account needs verification, a new code is on its way.' });
  } catch (err) {
    console.error('resend-verification error:', err.message);
    return res.status(500).json({ error: 'Could not resend code' });
  }
});

// ─── POST /forgot-password ─────────────────────────────────────────────────────
// Body: { email } — emails a one-time reset link. Always responds generically.
router.post('/forgot-password', authLimiter, normalizeAuthInputs, async (req, res) => {
  try {
    const { email } = req.body || {};
    if (!email || !EMAIL_RE.test(email)) return res.status(400).json({ error: 'A valid email is required' });

    const user = await User.findOne({ email });
    if (user) {
      const { token } = await EmailVerification.issueResetToken({ userId: user._id, email });
      const base = (process.env.FRONTEND_URL || '').replace(/\/+$/, '');
      const resetUrl = `${base}/reset-password?token=${token}`;
      await sendPasswordResetEmail(email, resetUrl);
      await ActivityLog.log('SYSTEM', null, 'PASSWORD_RESET_REQUESTED', { email, ip: getClientIp(req) });
    }
    return res.json(GENERIC_OK);
  } catch (err) {
    console.error('forgot-password error:', err.message);
    return res.status(500).json({ error: 'Could not process request' });
  }
});

// ─── POST /reset-password ──────────────────────────────────────────────────────
// Body: { token, password } — consumes the token and sets a new password.
router.post('/reset-password', authLimiter, async (req, res) => {
  try {
    const { token, password } = req.body || {};
    if (!token || !password) return res.status(400).json({ error: 'Token and new password are required' });
    if (String(password).length < 8) return res.status(400).json({ error: 'Password must be at least 8 characters' });

    const consumed = await EmailVerification.consumeResetToken(String(token).trim());
    if (!consumed) return res.status(400).json({ error: 'This reset link is invalid or has expired.' });

    const user = await User.findById(consumed.userId);
    if (!user) return res.status(400).json({ error: 'This reset link is invalid or has expired.' });

    user.passwordHash = password; // hashed by the User pre-save hook
    await user.save();
    // Invalidate existing sessions issued before the reset.
    try { await user.forceLogout(); } catch (_) {}

    await ActivityLog.log(user.role || 'SYSTEM', user._id, 'PASSWORD_RESET_COMPLETED', { email: user.email, ip: getClientIp(req) });
    await sendPasswordResetSuccessEmail(user.email);

    return res.json({ success: true, message: 'Your password has been reset. You can now log in.' });
  } catch (err) {
    console.error('reset-password error:', err.message);
    return res.status(500).json({ error: 'Could not reset password' });
  }
});

// ─── GET /email-status (diagnostic; no secrets) ────────────────────────────────
router.get('/email-status', (req, res) => res.json({ success: true, emailEnabled: isEmailEnabled() }));

module.exports = router;
