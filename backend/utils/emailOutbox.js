'use strict';
/**
 * Durable outbox for outbound email.
 *
 * The contract, in one line: a send is recorded BEFORE the provider is called and is only
 * marked done once the provider ACCEPTS it — so nothing can be silently lost, and anything
 * left pending is retried until it succeeds or is explicitly abandoned.
 *
 * This is the piece that makes the fix permanent rather than merely visible. The hard
 * deadline in utils/email.js guarantees a hung provider call now RETURNS; this guarantees the
 * email still gets DELIVERED afterwards instead of being dropped on the floor. Both are
 * needed: without the deadline a send hangs forever, and without the outbox a failed send is
 * a mail the user never receives.
 *
 * Deliberately dependency-light: no queue server, no cron. The sweeper is an interval inside
 * the long-lived Node process, and every row it needs is already in MySQL.
 */

const EmailOutbox = require('../models/EmailOutbox');

// Backoff per attempt. Front-loaded because the observed failures are transient host/network
// stalls that clear in minutes, and a signup OTP is worthless once its 10-minute TTL expires.
const BACKOFF_MS = [30 * 1000, 2 * 60 * 1000, 10 * 60 * 1000, 30 * 60 * 1000];
const MAX_ATTEMPTS = 5;
// A signup OTP that could not be delivered within its own lifetime must not be retried
// forever — the code it would carry is already expired and the user has long since tapped
// Resend. Renewal reminders stay useful for much longer.
const TTL_MS = { signup_otp: 15 * 60 * 1000, renewal_reminder: 24 * 60 * 60 * 1000 };

const maskEmail = (e) => {
  const s = String(e || '');
  const at = s.indexOf('@');
  return at <= 0 ? (s ? '***' : '(none)') : s[0] + '***' + s.slice(at);
};

function backoffFor(attempts) {
  return BACKOFF_MS[Math.min(attempts, BACKOFF_MS.length - 1)];
}

/** Record the INTENT to send, before any provider call. Returns the row (or null). */
async function enqueue({ type, recipient, refId, payload = {}, correlationId = null }) {
  try {
    return await EmailOutbox.create({
      type,
      recipient,
      refId: String(refId || ''),
      payload,
      status: 'pending',
      attempts: 0,
      nextAttemptAt: new Date(),
      lastCode: null,
      lastError: null,
      providerMessageId: null,
      correlationId,
      createdAt: new Date(),
    });
  } catch (e) {
    // A failure to record must never block the send itself — a sent-but-unrecorded email is
    // far better than an email nobody ever tried to send.
    console.error(`[outbox] enqueue failed type=${type}: ${e.message}`);
    return null;
  }
}

/** Provider accepted it. This is the ONLY thing that ends a row's life successfully. */
async function markSent(row, messageId) {
  if (!row) return;
  try {
    row.status = 'sent';
    row.attempts = Number(row.attempts || 0) + 1;
    row.providerMessageId = messageId || null;
    row.sentAt = new Date();
    row.nextAttemptAt = null;
    await row.save();
  } catch (e) {
    console.error(`[outbox] markSent failed id=${row && row._id}: ${e.message}`);
  }
}

/** Provider did not accept it. Stays pending and retryable until the attempt budget runs out. */
async function markFailed(row, code, error) {
  if (!row) return;
  try {
    const attempts = Number(row.attempts || 0) + 1;
    const age = Date.now() - new Date(row.createdAt || Date.now()).getTime();
    const ttl = TTL_MS[row.type] || TTL_MS.renewal_reminder;
    const exhausted = attempts >= MAX_ATTEMPTS || age > ttl;

    row.attempts = attempts;
    row.lastCode = code || null;
    row.lastError = error ? String(error).slice(0, 300) : null;
    row.status = exhausted ? 'abandoned' : 'pending';
    row.nextAttemptAt = exhausted ? null : new Date(Date.now() + backoffFor(attempts));
    await row.save();

    if (exhausted) {
      console.error(`[outbox] ABANDONED type=${row.type} to=${maskEmail(row.recipient)} attempts=${attempts} code=${code} — this email will NOT be delivered.`);
    }
  } catch (e) {
    console.error(`[outbox] markFailed failed id=${row && row._id}: ${e.message}`);
  }
}

/**
 * Run a send under the outbox: record intent, attempt, and record the outcome.
 * `attempt` must resolve to the mailer's own result shape ({ messageId } | { error, code }).
 */
async function withOutbox(meta, attempt) {
  const row = await enqueue(meta);
  let r;
  try {
    r = await attempt();
  } catch (err) {
    await markFailed(row, 'EMAIL_SEND_FAILED', err && err.message);
    throw err;
  }
  if (!r || r.error || r.skipped) {
    await markFailed(row, (r && r.code) || 'EMAIL_SEND_FAILED', r && r.error);
  } else {
    await markSent(row, r.messageId);
  }
  return { result: r, row };
}

/** Rows that are due for another attempt, oldest first. */
async function due(now = new Date(), limit = 25) {
  const rows = await EmailOutbox.find({ status: 'pending' }).sort({ createdAt: 1 }).limit(200);
  const t = new Date(now).getTime();
  return (rows || [])
    .filter((r) => !r.nextAttemptAt || new Date(r.nextAttemptAt).getTime() <= t)
    .slice(0, limit);
}

/**
 * Retry everything that is due. `senders` maps a row type to a function that rebuilds and
 * sends the message — kept injectable so this module never imports the routes, and so the
 * sweep is testable without a database or a provider.
 */
async function sweep(senders, { now = new Date(), limit = 25 } = {}) {
  const stats = { considered: 0, sent: 0, failed: 0, skipped: 0 };
  let rows = [];
  try {
    rows = await due(now, limit);
  } catch (e) {
    console.error(`[outbox] sweep could not read rows: ${e.message}`);
    return stats;
  }
  for (const row of rows) {
    stats.considered += 1;
    const send = senders && senders[row.type];
    if (typeof send !== 'function') { stats.skipped += 1; continue; }
    try {
      const r = await send(row);
      if (r && !r.error && !r.skipped) {
        await markSent(row, r.messageId);
        stats.sent += 1;
        console.log(`[outbox] retry SUCCEEDED type=${row.type} to=${maskEmail(row.recipient)} attempt=${Number(row.attempts || 0)} msgId=${r.messageId || '-'}`);
      } else {
        await markFailed(row, (r && r.code) || 'EMAIL_SEND_FAILED', r && r.error);
        stats.failed += 1;
      }
    } catch (e) {
      await markFailed(row, 'EMAIL_SEND_FAILED', e && e.message);
      stats.failed += 1;
    }
  }
  if (stats.considered) {
    console.log(`[outbox] sweep considered=${stats.considered} sent=${stats.sent} failed=${stats.failed} skipped=${stats.skipped}`);
  }
  return stats;
}

/** Counts for the admin health endpoint — the monitoring signal for delivery. */
async function stats() {
  const out = { pending: 0, sent: 0, abandoned: 0, oldestPendingAgeMs: null };
  try {
    const rows = await EmailOutbox.find({}).sort({ createdAt: -1 }).limit(1000);
    let oldest = null;
    for (const r of rows || []) {
      if (r.status === 'sent') out.sent += 1;
      else if (r.status === 'abandoned') out.abandoned += 1;
      else {
        out.pending += 1;
        const t = new Date(r.createdAt || Date.now()).getTime();
        if (oldest === null || t < oldest) oldest = t;
      }
    }
    if (oldest !== null) out.oldestPendingAgeMs = Date.now() - oldest;
  } catch (e) {
    console.error(`[outbox] stats failed: ${e.message}`);
  }
  return out;
}

module.exports = {
  BACKOFF_MS, MAX_ATTEMPTS, TTL_MS,
  backoffFor, enqueue, markSent, markFailed, withOutbox, due, sweep, stats,
};
