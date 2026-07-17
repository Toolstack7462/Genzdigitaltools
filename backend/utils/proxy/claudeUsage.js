'use strict';
/**
 * Claude usage aggregation — ISOLATED, claude-only. Bridges the append-only ClaudeUsage
 * ledger and the pure quota engine (claudeQuota). The numeric POLICY lives entirely in
 * claudeQuota; this module only buckets usage into the shared five-hour / weekly cycles and
 * sums the current bucket.
 *
 * SHARED RESETS: the cycle anchor is taken from the ACCOUNT's operator-supplied reset
 * timestamps (cycleResetAt / weeklyResetAt), so EVERY client pinned to (or auto-assigned to)
 * one account shares that account's official five-hour and weekly reset times, exactly as
 * required. Only estimated integer token counts are ever read or written — never any secret.
 *
 * The pure helpers (cycleKeysFor, usageForCycle) take plain objects and are unit-tested; the
 * DB wrappers (readUsage, recordUsage) are thin and fail-safe.
 */
const quota = require('./claudeQuota');

// PURE: resolve the current five-hour + weekly cycle buckets for an account.
// `account` supplies the reset anchors; createdAt is the stable fallback anchor.
function cycleKeysFor(account, now) {
  const a = account || {};
  const fallback = a.createdAt || 0;
  const five = quota.fiveHourWindow(a.cycleResetAt || null, now, fallback);
  const week = quota.weeklyWindow(a.weeklyResetAt || null, now, fallback);
  return { cycleKey: five.key, weekKey: week.key, fiveWindow: five, weekWindow: week };
}

// PURE: sum totalTokens over the ledger rows that belong to `cycleKey`. Ignores non-'usage'
// kinds unless includeAll is set. Safe on empty / malformed rows.
function usageForCycle(rows, cycleKey, includeAll) {
  let sum = 0;
  for (const r of rows || []) {
    if (!r) continue;
    if (String(r.cycleKey) !== String(cycleKey)) continue;
    if (!includeAll && r.kind && r.kind !== 'usage') continue;
    sum += Math.max(0, Math.trunc(Number(r.totalTokens) || 0));
  }
  return sum;
}

// PURE: assemble the full quota picture (capacity, allowance, used, remaining, allow/deny) for
// ONE more request of `estIncoming` estimated tokens. Takes already-summed usage numbers, so it
// is deterministic and unit-testable without a DB.
function resolveDecision({ account, client, clientUsed, accountUsed, estIncoming }) {
  const plan = quota.normalizePlan(account && account.plan);
  const capacity = quota.accountCapacity(plan);
  const clientLimit = quota.clientAllowance(client && client.tokenLimit);
  const decision = quota.checkAllowance({
    clientLimit, clientUsed, accountCapacity: capacity, accountUsed, estIncoming,
  });
  return Object.assign({ plan, planLabel: quota.planLabel(plan) }, decision);
}

// ── DB wrappers (thin, fail-safe) ────────────────────────────────────────────
function model() { return require('../../models/proxy/ClaudeUsage'); }

// Read current-cycle usage for a (client, account) pair. Returns summed client + account
// estimated tokens for the account's current five-hour bucket. Fail-safe: on any DB error it
// returns zero usage so a transient blip never falsely blocks a client (fail-open by design).
async function readUsage(account, client, now) {
  const keys = cycleKeysFor(account, now);
  let clientUsed = 0, accountUsed = 0;
  try {
    const Usage = model();
    const accountRows = account && account._id ? await Usage.find({ accountId: String(account._id), cycleKey: keys.cycleKey }) : [];
    accountUsed = usageForCycle(accountRows, keys.cycleKey);
    if (client && client._id) {
      const clientRows = accountRows.filter(r => r && String(r.proxyClientId) === String(client._id));
      clientUsed = usageForCycle(clientRows, keys.cycleKey);
    }
  } catch (_) { /* fail-open: treat as no usage recorded */ }
  return { clientUsed, accountUsed, keys };
}

// Append a settled usage row for a completed request. Fail-safe: never throws to the caller.
async function recordUsage({ account, client, userId, inputTokens, outputTokens, now }) {
  try {
    const Usage = model();
    const keys = cycleKeysFor(account, now);
    await Usage.create({
      accountId: account && account._id ? String(account._id) : null,
      proxyClientId: client && client._id ? String(client._id) : null,
      userId: userId != null ? String(userId) : null,
      cycleKey: keys.cycleKey,
      weekKey: keys.weekKey,
      inputTokens: Math.max(0, Math.trunc(Number(inputTokens) || 0)),
      outputTokens: Math.max(0, Math.trunc(Number(outputTokens) || 0)),
      at: new Date(),
      kind: 'usage',
    });
    return true;
  } catch (_) { return false; }
}

// Opportunistic cleanup: delete ledger rows older than two weekly windows so the table never
// grows unbounded. Bounded, cheap, best-effort; never affects the current cycle's rows.
async function pruneOld(now) {
  try {
    const Usage = model();
    const cutoff = new Date((now == null ? Date.now() : new Date(now).getTime()) - 2 * quota.WEEK_MS);
    if (Usage.deleteMany) await Usage.deleteMany({ at: { $lt: cutoff } });
  } catch (_) { /* best-effort */ }
}

module.exports = { cycleKeysFor, usageForCycle, resolveDecision, readUsage, recordUsage, pruneOld };
