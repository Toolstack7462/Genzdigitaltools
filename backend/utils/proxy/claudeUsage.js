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
// kinds unless includeAll is set. Safe on empty / malformed rows. (Retained for callers/tests
// that bucket by the stored key; the AUTHORITATIVE aggregation is sumRowsInWindow below.)
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

// PURE + AUTHORITATIVE: sum totalTokens over rows whose real EVENT TIME (`at`) falls inside the
// half-open window [startMs, endMs). This is the source-of-truth aggregation used by every summary.
//
// WHY by timestamp and NOT by the stored cycleKey/weekKey string: the bucket key embeds the
// account's reset ANCHOR. The moment an operator sets or corrects the account's official
// five-hour / weekly reset timestamp, the anchor — and therefore every freshly computed bucket
// key — shifts, so it no longer equals the key stored on already-recorded rows. Summing by key
// would then silently drop that usage (the reported "history shows 132 but summary shows 0" bug).
// Summing by the immutable event time reconciles against the ledger directly, so a reset-anchor
// change re-windows cleanly (a new cycle starts) WITHOUT ever hiding or deleting recorded usage.
function sumRowsInWindow(rows, windowObj, includeAll) {
  if (!windowObj) return 0;
  const start = Number(windowObj.startMs);
  const end = Number(windowObj.endMs);
  if (!Number.isFinite(start) || !Number.isFinite(end)) return 0;
  let sum = 0;
  for (const r of rows || []) {
    if (!r) continue;
    if (!includeAll && r.kind && r.kind !== 'usage') continue;
    const t = r.at != null ? new Date(r.at).getTime() : NaN;
    if (!Number.isFinite(t) || t < start || t >= end) continue;
    sum += Math.max(0, Math.trunc(Number(r.totalTokens) || 0));
  }
  return sum;
}

// Current five-hour cycle sum — by event time inside the active five-hour window.
function usageForCycle(rows, fiveWindow, includeAll) { return sumRowsInWindow(rows, fiveWindow, includeAll); }
// Current weekly-window sum — by event time inside the active weekly window (shares the append-only
// ledger; the window rolls over cleanly on the official weekly boundary, no counter mutation, so
// concurrent requests can't bypass it and a reset never deletes history).
function usageForWeek(rows, weekWindow, includeAll) { return sumRowsInWindow(rows, weekWindow, includeAll); }

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

// PURE: build the CLIENT-FACING usage STATUS for both the five-hour and weekly windows.
// This is DISPLAY ONLY — it never records anything and never exposes an account id/label/plan
// secret. It is what the read-only `/quota-status` endpoint (and the overlay widget) renders.
//
// `usage` is the object returned by readUsage (already-summed used tokens for the current
// windows + the resolved cycle windows + a `synced` flag). Effective limits are resolved by the
// SAME priority the enforcement path uses (client override → account default → global default →
// fallback), so what the widget shows can never disagree with what the gateway enforces.
//
// Each window carries: used, limit (effective), remaining, percent (capped 0-100), percentRaw
// (uncapped, so callers can tell "exactly full" from "over a reduced limit"), atLimit (no room
// left → future requests blocked until reset), over (usage strictly exceeds the limit), source
// ('custom' | 'account' | 'default'), resetAt (epoch ms of the window end) and resetInSeconds.
function usageStatus({ account, client, usage, now }) {
  const q = quota;
  const nowMs = now == null ? undefined : new Date(now).getTime();
  const u = usage || {};
  const keys = u.keys || cycleKeysFor(account, now);
  const synced = u.synced !== false;

  const fiveLimit = q.clientAllowance(client && client.tokenLimit, account && account.clientTokenLimit);
  const weekLimit = q.weeklyClientAllowance(client && client.weeklyTokenLimit, account && account.weeklyClientTokenLimit);
  const fiveSource = q.limitSource(client && client.tokenLimit, account && account.clientTokenLimit);
  const weekSource = q.limitSource(client && client.weeklyTokenLimit, account && account.weeklyClientTokenLimit);

  // `resetOfficial` is true only when the account carries an explicit reset timestamp for that
  // window. When false the window is still computed (from the account-age fallback anchor) so
  // usage keeps counting, but a UI must show the reset time as "Not synced" — never fabricate it.
  const mk = (used, limit, source, win, resetOfficial) => {
    const usedN = Math.max(0, Math.trunc(Number(used) || 0));
    const limitN = Math.max(0, Math.trunc(Number(limit) || 0));
    return {
      used: usedN,
      limit: limitN,
      remaining: Math.max(0, limitN - usedN),
      percent: q.usagePercent(usedN, limitN),                          // capped [0,100] for the bar
      percentRaw: limitN > 0 ? Math.round((usedN / limitN) * 100) : (usedN > 0 ? 100 : 0),
      atLimit: usedN >= limitN,                                        // no room → blocked until reset
      over: usedN > limitN,                                            // exceeds a (possibly reduced) limit
      source,
      resetOfficial: !!resetOfficial,
      resetAt: resetOfficial && win ? win.endMs : null,                // only expose an OFFICIAL reset
      resetInSeconds: resetOfficial && win ? q.secondsUntilReset(win, nowMs) : null,
    };
  };

  return {
    label: q.USAGE_LABEL,           // 'Estimated local token usage' — restated for any UI
    synced,
    fiveHour: mk(u.clientUsed, fiveLimit, fiveSource, keys.fiveWindow, !!(account && account.cycleResetAt)),
    weekly: mk(u.weeklyClientUsed, weekLimit, weekSource, keys.weekWindow, !!(account && account.weeklyResetAt)),
  };
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
    accountUsed = sumRowsInWindow(accountRows, keys.fiveWindow);
    weeklyAccountUsed = sumRowsInWindow(accountRows, keys.weekWindow);
    if (client && client._id) {
      const clientRows = accountRows.filter(r => r && String(r.proxyClientId) === String(client._id));
      clientUsed = sumRowsInWindow(clientRows, keys.fiveWindow);
      weeklyClientUsed = sumRowsInWindow(clientRows, keys.weekWindow);
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
        // Dedup only against SETTLED usage rows (a reservation shares the same requestId and must
        // NOT be mistaken for an already-charged request).
        if ((existing || []).some(r => r && (r.kind === 'usage' || !r.kind) && String(r.requestId) === String(requestId))) {
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

// ── Reservations — STRICT atomic enforcement before a Claude action ──────────
// Enforcement can't rely on settled usage alone: two concurrent requests both read the same "used"
// and both pass (a bypass). So before forwarding a Claude message we ATOMICALLY append a
// RESERVATION row (a single append-only INSERT → no lost write) for the estimated request tokens,
// then re-read and decide with the strict rule
//   used + reserved(earlier reservations + this one) + est  ≤  effective limit
// for BOTH the five-hour and weekly windows AND the shared account capacity. The reservation is
// SETTLED to real usage after a successful response (dedup by requestId) or RELEASED on failure,
// and EXPIRES after a TTL so a crashed request can never hold quota forever.
const RESERVATION_TTL_MS = (() => { const n = parseInt(process.env.CLAUDE_RESERVATION_TTL_MS, 10); return Number.isFinite(n) && n > 0 ? n : 5 * 60 * 1000; })();

// Deterministic total order over reservations (event time, then requestId). Concurrent reserves
// each count only reservations sorting strictly before themselves + their own est, so the set of
// admitted reservations can never sum past the limit (the winner order is stable across readers).
function reservationSortsBefore(r, marker) {
  const ra = r && r.at != null ? new Date(r.at).getTime() : 0;
  if (ra !== marker.atMs) return ra < marker.atMs;
  return String((r && r.requestId) || '') < String(marker.requestId || '');
}

// Sum ACTIVE (unexpired) reservation tokens whose event time is in the window. With
// `strictlyBefore`, only reservations sorting strictly before that marker are counted.
function sumReservationsInWindow(rows, windowObj, nowMs, strictlyBefore) {
  if (!windowObj) return 0;
  const start = Number(windowObj.startMs), end = Number(windowObj.endMs);
  if (!Number.isFinite(start) || !Number.isFinite(end)) return 0;
  const now = Number.isFinite(nowMs) ? nowMs : Date.now();
  let sum = 0;
  for (const r of rows || []) {
    if (!r || r.kind !== 'reservation') continue;
    const exp = r.expiresAt != null ? new Date(r.expiresAt).getTime() : Infinity;
    if (Number.isFinite(exp) && exp <= now) continue;             // expired reservation → freed
    const t = r.at != null ? new Date(r.at).getTime() : NaN;
    if (!Number.isFinite(t) || t < start || t >= end) continue;
    if (strictlyBefore && !reservationSortsBefore(r, strictlyBefore)) continue;
    sum += Math.max(0, Math.trunc(Number(r.totalTokens) || 0));
  }
  return sum;
}

// Delete the reservation row(s) for a request (settle or failure). Never touches settled usage
// (kind filter). Fail-safe.
async function releaseReservation({ accountId, requestId }) {
  try {
    if (!requestId) return { released: false };
    const Usage = model();
    if (!Usage.deleteMany) return { released: false };
    const r = await Usage.deleteMany({ requestId: String(requestId), kind: 'reservation' });
    return { released: true, count: (r && r.deletedCount) || 0 };
  } catch (_) { return { released: false }; }
}

// Per-account in-process serialization for the reserve critical section. INSERT-then-READ has a
// tiny race (two reserves that each read before the other's insert could both admit). Serializing
// reserves per account inside the enforcement process closes that window: each reserve's read
// always sees every prior reserve, so admitted reservations can never sum past the limit. (Across
// multiple Passenger workers a sub-millisecond window remains; the reservation + short settle keep
// it negligible vs. the previous behaviour of no reservation at all.)
const _accountLocks = new Map(); // accountId -> tail promise of the serialized chain
function withAccountLock(accountId, fn) {
  const key = String(accountId || '');
  const prev = _accountLocks.get(key) || Promise.resolve();
  const result = prev.then(fn, fn);            // run fn after the previous holder settles
  const tail = result.then(() => {}, () => {}); // never let a rejection break the chain
  _accountLocks.set(key, tail);
  tail.then(() => { if (_accountLocks.get(key) === tail) _accountLocks.delete(key); });
  return result;
}

// Reserve `estTokens` for this request, then decide strictly. Returns
//   { allowed, reserved, reason, decision, keys, synced, requestId, window, resetInSeconds }.
// On DENY the reservation is rolled back (released) so a blocked request holds nothing. On any DB
// error it fails OPEN (allowed:true, reserved:false, synced:false) — a metering hiccup must never
// break a real Claude chat.
async function reserveAndCheck({ account, client, userId, estTokens, requestId, now, ttlMs }) {
  const keys = cycleKeysFor(account, now);
  const nowMs = now == null ? Date.now() : new Date(now).getTime();
  const est = Math.max(0, Math.trunc(Number(estTokens) || 0));
  const acctId = account && account._id ? String(account._id) : null;
  const cliId = client && client._id ? String(client._id) : null;
  const rid = requestId || null;
  const ttl = Number.isFinite(ttlMs) && ttlMs > 0 ? ttlMs : RESERVATION_TTL_MS;

  const failOpen = (why) => {
    const decision = resolveDecision({ account, client, clientUsed: 0, accountUsed: 0, weeklyClientUsed: 0, weeklyAccountUsed: 0, estIncoming: est });
    return { allowed: true, reserved: false, reason: null, decision, keys, synced: false, requestId: rid, window: '5-hour', resetInSeconds: quota.secondsUntilReset(keys.fiveWindow, nowMs), _why: why };
  };
  if (!acctId) return failOpen('no_account');

  const Usage = model();
  // Serialize the whole insert→read→decide→rollback per account so each reserve sees every prior one.
  return withAccountLock(acctId, async () => {
    // 1) Reserve atomically (single append-only INSERT).
    try {
      await Usage.create({
        accountId: acctId, proxyClientId: cliId, userId: userId != null ? String(userId) : null,
        cycleKey: keys.cycleKey, weekKey: keys.weekKey,
        inputTokens: est, contextTokens: 0, outputTokens: 0,
        requestId: rid, at: new Date(nowMs), expiresAt: new Date(nowMs + ttl), kind: 'reservation',
      });
    } catch (_) { return failOpen('reserve_failed'); }

    // 2) Re-read and decide with the strict rule (usage + reservations-before-mine + my est).
    try {
      const rows = await Usage.find({ accountId: acctId });
      const marker = { atMs: nowMs, requestId: rid };
      const clientRows = cliId ? rows.filter(r => r && String(r.proxyClientId) === cliId) : [];
      const decision = resolveDecision({
        account, client,
        clientUsed: sumRowsInWindow(clientRows, keys.fiveWindow) + sumReservationsInWindow(clientRows, keys.fiveWindow, nowMs, marker),
        accountUsed: sumRowsInWindow(rows, keys.fiveWindow) + sumReservationsInWindow(rows, keys.fiveWindow, nowMs, marker),
        weeklyClientUsed: sumRowsInWindow(clientRows, keys.weekWindow) + sumReservationsInWindow(clientRows, keys.weekWindow, nowMs, marker),
        weeklyAccountUsed: sumRowsInWindow(rows, keys.weekWindow) + sumReservationsInWindow(rows, keys.weekWindow, nowMs, marker),
        estIncoming: est,
      });
      const weekly = decision.reason === 'weekly_client_limit' || decision.reason === 'weekly_account_capacity';
      const resetInSeconds = quota.secondsUntilReset(weekly ? keys.weekWindow : keys.fiveWindow, nowMs);
      if (!decision.allowed) {
        await releaseReservation({ accountId: acctId, requestId: rid });  // roll back — hold nothing
        return { allowed: false, reserved: false, reason: decision.reason, decision, keys, synced: true, requestId: rid, window: weekly ? 'weekly' : '5-hour', resetInSeconds };
      }
      return { allowed: true, reserved: true, reason: null, decision, keys, synced: true, requestId: rid, window: '5-hour', resetInSeconds: quota.secondsUntilReset(keys.fiveWindow, nowMs) };
    } catch (_) {
      await releaseReservation({ accountId: acctId, requestId: rid }).catch(() => {});
      return failOpen('read_failed');
    }
  });
}

// Settle a completed request: release its reservation, then record the ACTUAL usage (deduped
// against settled rows only). One call per request → charged at most once. Fail-safe.
async function settleUsage({ account, client, userId, inputTokens, contextTokens, outputTokens, requestId, now }) {
  const acctId = account && account._id ? String(account._id) : null;
  if (acctId && requestId) await releaseReservation({ accountId: acctId, requestId }).catch(() => {});
  return recordUsage({ account, client, userId, inputTokens, contextTokens, outputTokens, requestId, now });
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
    const nowMs = now == null ? Date.now() : new Date(now).getTime();
    const cutoff = new Date(nowMs - 2 * quota.WEEK_MS);
    if (Usage.deleteMany) {
      await Usage.deleteMany({ at: { $lt: cutoff } });
      // Also sweep EXPIRED reservations (a crashed request that never settled/released) so they
      // stop counting against the limit past their TTL.
      await Usage.deleteMany({ kind: 'reservation', expiresAt: { $lt: new Date(nowMs) } });
    }
  } catch (_) { /* best-effort */ }
}

module.exports = {
  cycleKeysFor, usageForCycle, usageForWeek, sumRowsByKey, sumRowsInWindow, sumReservationsInWindow,
  resolveDecision, usageStatus, readUsage, recordUsage, recentHistory, pruneOld,
  reserveAndCheck, settleUsage, releaseReservation, RESERVATION_TTL_MS,
};
