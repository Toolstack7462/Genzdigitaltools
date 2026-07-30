'use strict';
const { createModel } = require('../db/mysqlAdapter');

/**
 * EmailOutbox — one row per outbound email that MUST eventually be delivered.
 *
 * WHY THIS EXISTS. Signup and renewal mail is sent off the request path, and a send that
 * never completes used to leave nothing behind at all: no row, no log, no signal. During the
 * 2026-07-30 outage the deferred task produced neither a success nor a failure line for any
 * attempt, so a total delivery failure was indistinguishable from nobody having clicked. The
 * mail was simply lost, permanently, and the only recovery was a human noticing and retrying.
 *
 * A row is written BEFORE the provider is called, so the intent to send is durable even if
 * the process is killed mid-flight. The sweeper then retries anything still pending, which is
 * what makes a transient provider or network stall self-healing instead of a lost email.
 *
 * SECURITY: no OTP code, password, token or rendered email body is ever stored here. A signup
 * retry re-issues a fresh code through EmailVerification rather than replaying an old one, and
 * `payload` carries only non-secret display data (tool names, dates, the chosen offer).
 *
 * Fields:
 *   type        'signup_otp' | 'renewal_reminder'
 *   recipient   destination address
 *   refId       what the send is about (normalised email, or clientId)
 *   payload     non-secret data needed to rebuild the message
 *   status      'pending' | 'sent' | 'abandoned'
 *   attempts    how many provider calls have been made
 *   nextAttemptAt  when the sweeper may try again (backoff)
 *   lastCode    last structured failure code (EMAIL_*)
 *   providerMessageId  set once, on acceptance — the proof of delivery to the provider
 *   correlationId      ties the row to the log lines for one send
 */
const EmailOutbox = createModel('EmailOutbox', {});

module.exports = EmailOutbox;
