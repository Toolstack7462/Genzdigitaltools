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
const { getClientIp, requireAuth, requireAdmin } = require('../middleware/authEnhanced');
const { normalizeAuthInputs } = require('../middleware/normalize');
const { authLimiter } = require('../middleware/rateLimiter');
const { normalizeEmail, emailMatch } = require('../utils/signupPolicy');
const { completeSignup } = require('../utils/completeSignup');
const { sendAfterResponse } = require('../utils/deferredSend');
const { withOutbox, stats: outboxStats } = require('../utils/emailOutbox');
const {
  isEmailEnabled,
  diagnostics: emailDiagnostics,
  verifyProvider,
  sendVerificationEmail,
  sendPasswordResetEmail,
  sendPasswordResetSuccessEmail,
} = require('../utils/email');

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const GENERIC_OK = { success: true, message: 'If that email exists, we just sent it a message.' };

const REASON_MESSAGES = {
  expired: 'This code has expired. Please request a new one.',
  locked: 'Too many attempts. Please request a new code.',
  not_found: 'Invalid or expired code.',
  consumed: 'This code has already been used.',
  mismatch: 'Invalid code. Please check and try again.',
};

// ─── POST /verify-email ────────────────────────────────────────────────────────
// Body: { email, code }.
//
// Two shapes are handled, in this order:
//   1. PENDING REGISTRATION (no user row yet) — the code is consumed and the
//      account is created here. This is the ONLY place a public signup becomes a
//      real account, so an unverified email can never yield a usable login.
//   2. LEGACY unverified account (a user row that predates the pending flow) —
//      unchanged behaviour: flag it verified.
router.post('/verify-email', authLimiter, normalizeAuthInputs, async (req, res) => {
  try {
    const email = normalizeEmail(req.body && req.body.email);
    const code = req.body && req.body.code;
    if (!email || !code) return res.status(400).json({ error: 'Email and code are required' });

    // ── 1. Pending registration ────────────────────────────────────────────
    const pending = await EmailVerification.findPendingSignup(email);
    if (pending) {
      const result = await completeSignup({ email, code });
      if (!result.ok) {
        return res.status(400).json({
          error: REASON_MESSAGES[result.reason] || 'Invalid or expired code.',
          code: `OTP_${String(result.reason || 'invalid').toUpperCase()}`,
          ...(typeof result.attemptsLeft === 'number' ? { attemptsLeft: result.attemptsLeft } : {}),
        });
      }

      await ActivityLog.log('SYSTEM', result.user._id, result.created ? 'ACCOUNT_CREATED_VERIFIED' : 'EMAIL_VERIFIED', {
        email, ip: getClientIp(req),
      });
      console.log(`[signup] stage=verified created=${result.created} email=${String(email).charAt(0)}***`);
      return res.json({
        success: true,
        created: result.created,
        message: result.replay
          ? 'Your email is already verified. You can log in.'
          : 'Email verified — your account is ready. You can now log in.',
      });
    }

    // ── 2. Legacy account already in `users` ───────────────────────────────
    const result = await EmailVerification.verifyOtp({ email, code: String(code).trim() });
    if (!result.ok) {
      return res.status(400).json({
        error: REASON_MESSAGES[result.reason] || 'Invalid or expired code.',
        code: `OTP_${String(result.reason || 'invalid').toUpperCase()}`,
      });
    }

    const user = await User.findOne({ email: emailMatch(email) });
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
// Body: { email } — re-issues an OTP for a PENDING registration or a legacy
// unverified account. Enumeration-safe: the response is identical either way.
// A cooldown breach is the one exception — the caller must be told to wait.
router.post('/resend-verification', authLimiter, normalizeAuthInputs, async (req, res) => {
  try {
    const email = normalizeEmail(req.body && req.body.email);
    if (!email || !EMAIL_RE.test(email)) return res.status(400).json({ error: 'A valid email is required' });

    // Pending registration first — no user row exists for these yet.
    const pending = await EmailVerification.findPendingSignup(email);
    if (pending && pending.status !== 'consumed') {
      const issued = await EmailVerification.issueSignupOtp({
        email,
        fullName: pending.fullName,
        passwordHash: pending.passwordHash, // carried forward untouched
      });
      if (issued.cooldownMs) {
        const retryAfter = Math.ceil(issued.cooldownMs / 1000);
        res.set('Retry-After', String(retryAfter));
        return res.status(429).json({
          error: `Please wait ${retryAfter}s before requesting another code.`,
          code: 'RESEND_COOLDOWN',
          retryAfterSeconds: retryAfter,
        });
      }
      if (issued.sendsExhausted) {
        return res.status(429).json({ error: 'Too many codes requested. Please try again later.', code: 'RESEND_LIMIT' });
      }
      // Answer FIRST, deliver after — same reason as /public/register, and doubly important
      // here: this endpoint IS the recovery path when a signup send fails, so it must not be
      // capable of failing the same way. markSignupSent stays in the deferred task so a
      // failed resend does not consume the cooldown and the user can simply tap it again.
      const ip = getClientIp(req);
      res.json({ success: true, message: 'A new verification code is on its way.' });
      sendAfterResponse(res, 'resend-verification', async () => {
        const { result: r } = await withOutbox(
          { type: 'signup_otp', recipient: email, refId: email },
          () => sendVerificationEmail(email, issued.code, { deferred: true }),
        );
        if (r.error || r.skipped) {
          console.error(`[resend] result=failed code=${r.code || 'UNKNOWN'} note=cooldown-not-consumed outbox=pending-will-retry`);
          return;
        }
        await EmailVerification.markSignupSent(email);
        await ActivityLog.log('SYSTEM', null, 'EMAIL_VERIFICATION_RESENT', { email, ip });
      });
      return;
    }

    const user = await User.findOne({ email: emailMatch(email) });
    if (user && !user.emailVerified) {
      const { code } = await EmailVerification.issueOtp({ userId: user._id, email });
      const ip = getClientIp(req);
      // Response is already generic by design (it must not reveal whether the address
      // exists), so deferring the send changes nothing the caller can observe.
      res.json({ success: true, message: 'If your account needs verification, a new code is on its way.' });
      sendAfterResponse(res, 'resend-verification-legacy', async () => {
        await sendVerificationEmail(email, code, { deferred: true });
        await ActivityLog.log('SYSTEM', null, 'EMAIL_VERIFICATION_RESENT', { email, ip });
      });
      return;
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

    // Case-insensitive so a legacy mixed-case row can still recover its password.
    const user = await User.findOne({ email: emailMatch(email) });
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
// Deliberately shallow and unauthenticated: it only reports whether the two env vars are
// set. It CANNOT detect a revoked key, an unverified domain or blocked egress — for that
// see /email-health below, which is why that one is admin-only.
router.get('/email-status', (req, res) => res.json({ success: true, emailEnabled: isEmailEnabled() }));

// ─── GET /email-health (ADMIN ONLY — performs a REAL provider check) ───────────
//
// Answers, in one call, the question that took hours of black-box probing during the last
// two outages: is the mailer actually able to talk to the provider right now, and if not,
// which layer is broken? It hits the provider's authenticated /domains endpoint — no email
// is sent, no send quota is consumed — so it exercises DNS, TCP, TLS, credentials and
// domain verification in one shot.
//
// Admin-only because it makes an authenticated outbound call on demand; leaving it open
// would hand anyone a free way to burn the server's outbound capacity.
// Returns booleans, codes, latency and domain names only — never the API key.
router.get('/email-health', requireAuth, requireAdmin, async (req, res) => {
  const config = emailDiagnostics();
  if (!config.enabled) {
    return res.status(503).json({
      success: false, ok: false, code: 'EMAIL_CONFIG_MISSING', config,
      error: 'Email is not configured on the server (RESEND_API_KEY / EMAIL_FROM).',
    });
  }
  const probe = await verifyProvider();
  // Delivery backlog: the signal that tells you mail is silently piling up. `abandoned > 0`
  // or a large `oldestPendingAgeMs` means real users are not receiving email right now.
  const delivery = await outboxStats();
  // 200 when the provider is genuinely reachable AND the sending domain is usable;
  // 503 otherwise, so an uptime check can key on the status alone.
  return res.status(probe.ok ? 200 : 503).json({
    success: probe.ok,
    ok: probe.ok,
    code: probe.code || null,
    providerStatus: probe.status || null,
    latencyMs: probe.latencyMs,
    fromDomain: probe.fromDomain || null,
    sendingDomainVerified: probe.sendingVerified,
    domains: probe.domains || [],
    error: probe.ok ? null : (probe.adminMessage || 'The email provider check failed.'),
    config,
    delivery,
  });
});

module.exports = router;
