'use strict';
/**
 * Rebuilds and re-sends anything the outbox still has pending.
 *
 * This is what turns the outbox from a record into a recovery: without it, a row that failed
 * its first attempt would sit pending forever and the user would still never get their email.
 *
 * Runs on an interval inside the long-lived Node process — no cron, no queue server. Every
 * failure path here is swallowed on purpose: a sweeper that throws would take down the API,
 * and a lost retry is never worth that.
 */

const EmailVerification = require('../models/EmailVerification');
const outbox = require('./emailOutbox');
const { sendVerificationEmail, sendRenewalReminderEmail, isEmailEnabled } = require('./email');

const SWEEP_INTERVAL_MS = Number(process.env.EMAIL_SWEEP_INTERVAL_MS) || 60 * 1000;

/**
 * How each row type is rebuilt.
 *
 * signup_otp deliberately ISSUES A FRESH CODE instead of replaying the original: the outbox
 * never stores an OTP, and a code minted at first-attempt time would likely be expired by the
 * time a retry runs anyway. enforceCooldown:false because the cooldown exists to rate-limit
 * the USER's resend button, not our own recovery of a mail we already promised to send.
 */
const senders = {
  async signup_otp(row) {
    const pending = await EmailVerification.findPendingSignup(row.refId);
    if (!pending || pending.status === 'consumed') {
      // Already verified, or the registration was abandoned. Nothing left to deliver.
      return { skipped: true, code: 'OUTBOX_NO_LONGER_NEEDED' };
    }
    const issued = await EmailVerification.issueSignupOtp({
      email: row.refId,
      fullName: pending.fullName,
      passwordHash: pending.passwordHash,
      enforceCooldown: false,
    });
    if (!issued || !issued.code) return { error: 'could not re-issue an OTP', code: 'EMAIL_SEND_FAILED' };
    const r = await sendVerificationEmail(row.refId, issued.code, { deferred: true });
    if (r && !r.error && !r.skipped) await EmailVerification.markSignupSent(row.refId);
    return r;
  },

  async renewal_reminder(row) {
    const p = row.payload || {};
    if (!Array.isArray(p.tools) || !p.tools.length) {
      return { skipped: true, code: 'OUTBOX_NO_LONGER_NEEDED' };
    }
    return sendRenewalReminderEmail(row.recipient, {
      clientName: p.clientName, tools: p.tools, offer: p.offer, deferred: true,
    });
  },
};

let timer = null;

async function runOnce(now = new Date()) {
  if (!isEmailEnabled()) return { skipped: true };
  return outbox.sweep(senders, { now });
}

function start() {
  if (timer) return timer;
  if (process.env.EMAIL_SWEEP_DISABLED === '1') {
    console.log('ℹ️  Email outbox sweeper disabled (EMAIL_SWEEP_DISABLED=1).');
    return null;
  }
  timer = setInterval(() => {
    runOnce().catch((e) => console.error(`[outbox] sweep crashed: ${e && e.message}`));
  }, SWEEP_INTERVAL_MS);
  if (typeof timer.unref === 'function') timer.unref();  // never hold the process open
  console.log(`✅ Email outbox sweeper started (every ${Math.round(SWEEP_INTERVAL_MS / 1000)}s) — pending mail is retried until delivered.`);
  return timer;
}

function stop() {
  if (timer) { clearInterval(timer); timer = null; }
}

module.exports = { senders, runOnce, start, stop, SWEEP_INTERVAL_MS };
