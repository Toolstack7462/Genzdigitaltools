'use strict';
/**
 * Run an outbound email send AFTER the HTTP response has been flushed.
 *
 * WHY THIS EXISTS (measured on this host, twice — 2026-07-27 and 2026-07-28).
 * The web server kills a worker whose request is still open after roughly 2 seconds and
 * serves its OWN 503 page. That page bypasses Express, so it carries no CORS header and no
 * JSON body: the browser reports a CORS error, axios sees no response, and the UI falls back
 * to a generic "Could not send the email." Meanwhile the outbound call to the mail provider
 * from this box regularly takes longer than that — observed kills at 1.99s, 2.24s, 2.35s,
 * 3.1s, 5.7s, 7.7s and one request that hung to a 504 at 55s, against a HEALTHY send of
 * ~1.1s. There is no timeout value that reliably fits between 1.1s and 2.0s, so capping the
 * provider call cannot fix this — it was tried, and it did not.
 *
 * The fix is to take the provider call off the request's critical path entirely. Every send
 * site here already persists its state (the pending registration row and its OTP, or the
 * reminder record) BEFORE sending, and that part completes in ~0.5s like every other database
 * route. So we answer the client immediately from that persisted state and deliver afterwards.
 *
 * WHAT THIS DELIBERATELY GIVES UP: we can no longer tell the caller "it was sent", because we
 * genuinely do not know yet. Callers must word their response accordingly ("we're sending…"),
 * and every site must leave its retry path usable — in practice that means NOT marking the
 * send as consumed until the provider actually accepts, so the user's "Resend" button still
 * works immediately when delivery failed. That is a real trade-off, and it is the right one
 * while the alternative is a 503 that lets nobody sign up at all.
 *
 * The work runs in-process on the same long-lived Node server (this is not PHP-FPM), so a
 * floating promise does continue after the response. If the worker is torn down first the
 * send is simply lost — the caller already has a useful answer and a working retry, which is
 * strictly better than the 503 it replaces.
 */

/**
 * @param {import('http').ServerResponse} res  the response that must be flushed first
 * @param {string} label                       short tag for logs (never user data)
 * @param {() => Promise<any>} task            the send; must handle its own outcome logging
 */
function sendAfterResponse(res, label, task) {
  let started = false;
  const run = () => {
    if (started) return;          // 'finish' and 'close' both fire — run exactly once
    started = true;
    Promise.resolve()
      .then(task)
      .catch((err) => {
        // A throw here can never reach the client, so it must never be silent either.
        console.error(`[deferred-send] ${label} threw after response: ${err && err.message}`);
      });
  };

  // Already flushed (e.g. a synchronous res.json above) — start now.
  if (res.writableEnded || res.finished) { run(); return; }
  res.once('finish', run);
  res.once('close', run);
}

module.exports = { sendAfterResponse };
