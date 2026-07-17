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

// PURE: sum totalTokens over ledger rows whose `field` equals `key`. Ignores non-'usage'
// kinds unless includeAll is set. Safe on empty / malformed rows.
function sumRowsByKey(rows, key, field, includeAll) {
  let sum = 0;
  for (const r of rows || []) {
    if (!r) continue;
    if (String(r[field]) !== String(key)) continue;
    if (!includeAll && r.kind && r.kind !== 'usage') continue;
    sum += Math.max(0, Math.trunc(Number(r.totalTokens) || 0));
  }
  return sum;
}
// Current five-hour cycle sum.
function usageForCycle(rows, cycleKey, includeAll) { return sumRowsByKey(rows, cycleKey, 'cycleKey', includeAll); }
// Current weekly-window sum (shares the append-only ledger; the weekly bucket rolls over
// atomically when weekKey changes — no counter mutation, so concurrent requests can't bypass it).
function usageForWeek(rows, weekKey, includeAll) { return sumRowsByKey(rows, weekKey, 'weekKey', includeAll); }

// PURE: assemble the full quota picture (capacity, allowance, used, remaining, allow/deny) for
// ONE more request of `estIncoming` estimated tokens. Takes already-summed usage numbers, so it
// is deterministic and unit-testable without a DB.
function resolveDecision({ account, client, clientUsed, accountUsed, weeklyClientUsed, weeklyAccountUsed, estIncoming }) {
  const plan = quota.normalizePlan(account && account.plan);
  const capacity = quota.accountCapacity(plan);
  // Five-hour: client override → account default → global default.
  const clientLimit = quota.clientAllowance(client && client.tokenLimit, account && account.clientTokenLimit);
  // Weekly: client override → account default → global default → 200k fallback; shared account
  // weekly capacity is plan-scaled. Weekly usage is passed by the caller (0 when unknown).
  const weeklyClientLimit = quota.weeklyClientAllowance(client && client.weeklyTokenLimit, account && account.weeklyClientTokenLimit);
  const weeklyCapacity = quota.accountWeeklyCapacity(plan);
  const decision = quota.checkAllowance({
    clientLimit, clientUsed, accountCapacity: capacity, accountUsed,
    weeklyClientLimit, weeklyClientUsed: weeklyClientUsed || 0,
    weeklyAccountCapacity: weeklyCapacity, weeklyAccountUsed: weeklyAccountUsed || 0,
    estIncoming,
  });
  return Object.assign({ plan, planLabel: quota.planLabel(plan) }, decision);
}

// ── DB wrappers (thin, fail-safe) ────────────────────────────────────────────
function model() { return require('../../models/proxy/ClaudeUsage'); }

// Read current five-hour AND weekly usage for a (client, account) pair from the shared ledger.
// One indexed query by accountId returns the account's recent rows (bounded to ~2 weeks by
// pruneOld); we sum the current 5-hour bucket and the current weekly bucket in memory.
// Fail-safe: on any DB error it returns zero usage AND `synced:false` so callers can show
// "Not synced" instead of a fabricated 0, while enforcement fails OPEN (never falsely blocks).
async function readUsage(account, client, now) {
  const keys = cycleKeysFor(account, now);
  let clientUsed = 0, accountUsed = 0, weeklyClientUsed = 0, weeklyAccountUsed = 0, synced = true;
  try {
    const Usage = model();
    const accountRows = account && account._id ? await Usage.find({ accountId: String(account._id) }) : [];
    accountUsed = usageForCycle(accountRows, keys.cycleKey);
    weeklyAccountUsed = usageForWeek(accountRows, keys.weekKey);
    if (client && client._id) {
      const clientRows = accountRows.filter(r => r && String(r.proxyClientId) === String(client._id));
      clientUsed = usageForCycle(clientRows, keys.cycleKey);
      weeklyClientUsed = usageForWeek(clientRows, keys.weekKey);
    }
  } catch (_) { synced = false; /* fail-open for enforcement; flagged not-synced for display */ }
  return { clientUsed, accountUsed, weeklyClientUsed, weeklyAccountUsed, keys, synced };
}

// Append a settled usage row for a completed request. Records the input / context / output
// breakdown. IDEMPOTENT: if `requestId` was already recorded for this account, it is NOT charged
// again (duplicate-charge guard). Fail-safe: never throws to the caller.
// Returns { recorded, duplicate }.
async function recordUsage({ account, client, userId, inputTokens, contextTokens, outputTokens, requestId, now }) {
  try {
    const Usage = model();
    const keys = cycleKeysFor(account, now);
    const acctId = account && account._id ? String(account._id) : null;
    // Duplicate-charge guard: append-only ledger + a per-request idempotency key. Since a
    // completed request is reported exactly once, a matching requestId means an accidental
    // re-send → skip. (A single request is never reported concurrently, so no RMW race here.)
    if (requestId && acctId) {
      try {
        const existing = await Usage.find({ accountId: acctId });
        if ((existing || []).some(r => r && String(r.requestId) === String(requestId))) {
          return { recorded: false, duplicate: true };
        }
      } catch (_) { /* if the check fails, fall through and record (fail-open on the guard) */ }
    }
    await Usage.create({
      accountId: acctId,
      proxyClientId: client && client._id ? String(client._id) : null,
      userId: userId != null ? String(userId) : null,
      cycleKey: keys.cycleKey,
      weekKey: keys.weekKey,
      inputTokens: Math.max(0, Math.trunc(Number(inputTokens) || 0)),
      contextTokens: Math.max(0, Math.trunc(Number(contextTokens) || 0)),
      outputTokens: Math.max(0, Math.trunc(Number(outputTokens) || 0)),
      requestId: requestId || null,
      at: now ? new Date(now) : new Date(), // event time (defaults to real now in production)
      kind: 'usage',
    });
    return { recorded: true, duplicate: false };
  } catch (_) { return { recorded: false, duplicate: false }; }
}

// Recent settled usage rows for a (account, client), newest first — for the admin history view.
// Safe fields only (token estimates + timestamps); never any prompt text or secret. Fail-safe.
async function recentHistory(accountId, clientId, limit = 25) {
  try {
    if (!accountId) return [];
    const Usage = model();
    let rows = await Usage.find({ accountId: String(accountId) });
    rows = (rows || []).filter(r => r && (!clientId || String(r.proxyClientId) === String(clientId)) && (!r.kind || r.kind === 'usage'));
    rows.sort((a, b) => new Date(b.at || 0).getTime() - new Date(a.at || 0).getTime());
    return rows.slice(0, Math.min(200, Math.max(1, limit))).map(r => ({
      at: r.at || null,
      inputTokens: Math.max(0, Math.trunc(Number(r.inputTokens) || 0)),
      contextTokens: Math.max(0, Math.trunc(Number(r.contextTokens) || 0)),
      outputTokens: Math.max(0, Math.trunc(Number(r.outputTokens) || 0)),
      totalTokens: Math.max(0, Math.trunc(Number(r.totalTokens) || 0)),
    }));
  } catch (_) { return []; }
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

module.exports = { cycleKeysFor, usageForCycle, usageForWeek, sumRowsByKey, resolveDecision, readUsage, recordUsage, recentHistory, pruneOld };
