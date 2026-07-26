'use strict';

/**
 * Minimal in-process mutex keyed by a string.
 *
 * Used to serialise "verify OTP → create account" for a single email so two
 * simultaneous verification requests cannot both pass the existence check and
 * create two accounts.
 *
 * SCOPE, honestly stated: this serialises within ONE Node process. The storage
 * layer (db/mysqlAdapter.js) exposes no transactions and the `users` table has
 * no unique index on email, so a cross-process guarantee is not available
 * without a schema change. Defence in depth is therefore layered:
 *   1. the OTP is CONSUMED before the account is created (one-time use), and
 *   2. the account creation re-checks for an existing user inside the lock and
 *      returns it instead of creating a second one (idempotent).
 * A UNIQUE index on users(gc_email) would close the remaining cross-process
 * window; see scripts/reconcile-registrations.js for the pre-flight check.
 */
const chains = new Map();

async function withLock(key, fn) {
  const k = String(key);
  const previous = chains.get(k) || Promise.resolve();

  let release;
  const current = new Promise((resolve) => { release = resolve; });
  // Queue behind whatever is already running for this key.
  const tail = previous.then(() => current);
  chains.set(k, tail);

  await previous.catch(() => {}); // a prior failure must not poison the queue
  try {
    return await fn();
  } finally {
    release();
    // Drop the entry only if nobody queued behind us, so the map cannot grow forever.
    if (chains.get(k) === tail) chains.delete(k);
  }
}

module.exports = { withLock };
