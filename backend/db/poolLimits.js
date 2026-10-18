'use strict';
/**
 * Pool saturation policy.
 *
 * The pool was created with `queueLimit: 0` — mysql2's "unbounded queue". With
 * `waitForConnections: true` and `connectionLimit: 10`, a slow or stalled MySQL meant requests
 * piled up without any ceiling: each one holding an open HTTP connection, a request object and its
 * closures, waiting for a connection that was not coming. Nothing shed load, so the Node process
 * grew until the platform killed it or the proxy gave up on the sockets — which is what a 502/503
 * or "Site Can't Be Reached" looks like from outside, long after the real cause (a slow query)
 * passed.
 *
 * A bounded queue converts that into back-pressure: the queue absorbs an ordinary burst, and beyond
 * it requests are refused IMMEDIATELY and honestly instead of being accepted and silently starved.
 * Refusing early is what keeps the process alive to serve the requests it can.
 *
 * Both numbers stay environment-overridable, and MYSQL_QUEUE_LIMIT=0 restores the previous
 * unbounded behaviour exactly — the rollback is a single env var, no redeploy of code.
 */

const DEFAULT_CONNECTION_LIMIT = 10;
// Depth beyond the connection limit. 20 absorbs a burst roughly twice the pool's width before
// shedding, which covers normal concurrency spikes without letting an outage queue without end.
const DEFAULT_QUEUE_LIMIT = 20;

function intFromEnv(env, name, fallback) {
  const raw = env[name];
  if (raw === undefined || raw === null) return fallback;
  const s = String(raw).trim();
  // PLAIN DECIMAL DIGITS ONLY. Number() would read '0x10' as 16 and '1e3' as 1000, so an operator
  // typo could quietly resize the pool. Reject anything else rather than let a bad value turn the
  // guard off; explicit '0' is honoured, because that IS the documented escape hatch.
  if (!/^\d+$/.test(s)) return fallback;
  const n = Number(s);
  return Number.isSafeInteger(n) ? n : fallback;
}

/**
 * Resolve the pool's sizing from the environment.
 * @param {object} [env] defaults to process.env
 * @returns {{connectionLimit:number, queueLimit:number, unbounded:boolean}}
 */
function poolLimits(env = process.env) {
  const connectionLimit = Math.max(1, intFromEnv(env, 'MYSQL_CONNECTION_LIMIT', DEFAULT_CONNECTION_LIMIT));
  const queueLimit = intFromEnv(env, 'MYSQL_QUEUE_LIMIT', DEFAULT_QUEUE_LIMIT);
  return { connectionLimit, queueLimit, unbounded: queueLimit === 0 };
}

// mysql2 rejects a request that overflows the queue with `Error('Queue limit reached.')`. It
// carries no stable driver code, so the message is matched as well as the codes that mean the same
// thing from the server side (too many connections).
const SATURATION_CODES = new Set(['ER_CON_COUNT_ERROR', 'ER_TOO_MANY_USER_CONNECTIONS', 'ER_USER_LIMIT_REACHED']);

/** True when an error means "no capacity right now", as opposed to a real failure. */
function isPoolSaturationError(err) {
  if (!err) return false;
  if (err.code && SATURATION_CODES.has(err.code)) return true;
  return /queue limit reached/i.test(String(err.message || ''));
}

module.exports = {
  poolLimits, isPoolSaturationError,
  DEFAULT_CONNECTION_LIMIT, DEFAULT_QUEUE_LIMIT, SATURATION_CODES,
};
