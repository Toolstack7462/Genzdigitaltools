'use strict';
/**
 * Issue and redeem one-time launch codes.
 *
 * ATOMICITY — the part that actually matters
 * A "one-time" code is only one-time if two simultaneous redemptions cannot both succeed.
 * The obvious shape (`findOneAndUpdate({used:false},{$set:{used:true}})`) is NOT safe on this
 * adapter: db/mysqlAdapter.js implements findOneAndUpdate as a read, then a JS merge, then a
 * write, so two concurrent callers both read `used:false` and both proceed. Double-clicking
 * the dashboard button is enough to hit that window.
 *
 * So redemption is a DELETE by primary key instead. InnoDB serializes the row delete, and
 * mysql2 reports `affectedRows` exactly: the first caller gets 1, every later caller gets 0.
 * `deletedCount === 1` is therefore the single, database-enforced authority on who won —
 * and it satisfies "delete or invalidate the launch code immediately after redemption"
 * literally, because the row is gone before the lease is handed back.
 *
 * The lookup that precedes the DELETE only loads the bindings; it decides nothing.
 *
 * NOTHING here logs a raw code.
 */
const LaunchCode = require('../models/LaunchCode');
const lc = require('./launchCode');

/**
 * Mint a launch code for an already-authorized lease.
 *
 * The caller MUST have completed every existing authorization check first (client,
 * subscription, tool grant, expiry, account selection, quota). This function does not
 * authorize anything — it only records the decision the caller already made, so the
 * gateway can pick it up once, seconds later.
 *
 * @returns {Promise<{code:string, expiresAt:Date, ttlSeconds:number}>} the RAW code is
 *   returned to the caller exactly once and is never persisted or logged.
 */
async function issue({ module, tool, userId, clientRefId, accountId, leaseId, capture, ip, userAgent }) {
  const code = lc.generate();
  const ttl = lc.ttlSeconds();
  const issuedAt = new Date();
  const expiresAt = new Date(issuedAt.getTime() + ttl * 1000);

  await LaunchCode.create({
    _id: lc.idOf(code),          // truncated digest AS the primary key — see the header
    codeHash: lc.fullHash(code), // full digest, constant-time compared at redemption
    module: String(module),
    tool: tool ? String(tool) : null,
    userId: userId ? String(userId) : null,
    clientRefId: clientRefId ? String(clientRefId) : null,
    accountId: accountId ? String(accountId) : null,
    leaseId: leaseId ? String(leaseId) : null,
    capture: !!capture,
    issuedAt,
    expiresAt,
    ip: ip || null,
    userAgent: userAgent || '',
  });

  return { code, expiresAt, ttlSeconds: ttl };
}

/**
 * Atomically redeem a code exactly once.
 *
 * @returns {Promise<{ok:true, record:object}|{ok:false, code:string}>}
 *   failure codes: launch_code_invalid | launch_code_expired | launch_code_used
 *
 * A replay of an already-redeemed code and a code that never existed both surface as
 * launch_code_invalid to the caller's user — but they are distinguished here so the
 * gateway/backend logs can tell a genuine replay attempt from a typo'd request.
 */
async function redeem(rawCode) {
  if (!lc.looksValid(rawCode)) return { ok: false, code: 'launch_code_invalid' };

  const id = lc.idOf(rawCode);
  const row = await LaunchCode.findById(id);
  if (!row) return { ok: false, code: 'launch_code_invalid' };

  // Constant-time confirmation against the FULL digest. Guards the (astronomically
  // unlikely) truncated-id collision, and keeps the comparison free of timing signal.
  if (!lc.hashesEqual(row.codeHash, lc.fullHash(rawCode))) {
    return { ok: false, code: 'launch_code_invalid' };
  }

  if (row.isExpired()) {
    // Clear it out rather than leaving a dead row for the sweeper.
    try { await LaunchCode.deleteOne({ _id: id }); } catch (_) {}
    return { ok: false, code: 'launch_code_expired' };
  }

  // ── The atomic gate ──────────────────────────────────────────────────────────
  const del = await LaunchCode.deleteOne({ _id: id });
  if (!del || del.deletedCount !== 1) return { ok: false, code: 'launch_code_used' };

  return {
    ok: true,
    record: {
      module: row.module,
      tool: row.tool || null,
      userId: row.userId || null,
      clientRefId: row.clientRefId || null,
      accountId: row.accountId || null,
      leaseId: row.leaseId || null,
      capture: !!row.capture,
      issuedAt: row.issuedAt,
      expiresAt: row.expiresAt,
    },
  };
}

/**
 * Best-effort removal of codes nobody redeemed. Rows live under a minute, so this exists
 * only so an abandoned launch cannot accumulate. Never throws; never blocks a request.
 */
async function sweepExpired(now = new Date()) {
  try {
    const rows = await LaunchCode.find({ expiresAt: { $lt: now } });
    let removed = 0;
    for (const r of rows || []) {
      const d = await LaunchCode.deleteOne({ _id: r._id });
      removed += (d && d.deletedCount) || 0;
    }
    return removed;
  } catch (_) { return 0; }
}

module.exports = { issue, redeem, sweepExpired };
