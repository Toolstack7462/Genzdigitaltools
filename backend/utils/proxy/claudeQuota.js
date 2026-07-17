'use strict';
/**
 * Claude token-quota engine — ISOLATED, claude-only, PURE (no I/O, no DB, no secrets).
 *
 * Everything here is an ESTIMATE of *local* token usage computed from the length of the
 * text that flows through the Gen Z reverse proxy. It is NOT Anthropic's official metering
 * and never touches Claude credentials, cookies, sessions or account internals — it only
 * ever sees character counts. All user-facing values carry the label
 * `Estimated local token usage`.
 *
 * Responsibilities (all deterministic, hence fully unit-testable):
 *   1. Token estimation from character counts / text (input, output, system, context,
 *      attachments) — a chars/N heuristic.
 *   2. Official five-hour + weekly reset CYCLES, anchored on operator-supplied reset
 *      timestamps. All math is epoch-millisecond / UTC, so it is timezone-safe.
 *   3. Plan SCALING — Pro 1x, Max 5x, Max 20x — with a configurable safety reserve.
 *   4. The allowance CHECK: given current usage, is one more request within BOTH the
 *      per-client allowance AND the shared per-account capacity?
 *
 * This module is required by the backend routes and mirrored (char-extraction only) in the
 * claude-gateway; keeping the numeric policy in ONE place means the gateway and the admin
 * UI can never disagree about a limit.
 */

const USAGE_LABEL = 'Estimated local token usage';

// ── Tunables (env-overridable; safe defaults) ────────────────────────────────
const CYCLE_MS = 5 * 60 * 60 * 1000;        // official five-hour Claude cycle
const WEEK_MS = 7 * 24 * 60 * 60 * 1000;    // weekly reset window

function intEnv(name, def, min, max) {
  const n = parseInt(process.env[name], 10);
  if (!Number.isFinite(n)) return def;
  let v = n;
  if (min != null) v = Math.max(min, v);
  if (max != null) v = Math.min(max, v);
  return v;
}

// ── Admin-editable GLOBAL overrides (runtime) ────────────────────────────────
// A single in-process object the settings loader populates from the ClaudeSettings row on boot
// and on every admin save. When a key is set here it takes precedence over the env default, so
// every enforcement path (open gate, gateway precheck, dashboard) uses the admin's global value
// without threading it through call sites. Priority is unchanged: client → account → GLOBAL →
// fallback. An unset/null key transparently falls back to env → hardcoded default.
const OVERRIDE_KEYS = ['defaultClientLimit', 'defaultWeeklyClientLimit', 'accountBaseTokens', 'accountWeeklyBaseTokens', 'safetyReservePct'];
let _globalOverrides = {};
function setGlobalConfig(cfg) {
  const clean = {};
  for (const k of OVERRIDE_KEYS) {
    const v = cfg && cfg[k];
    if (v != null && v !== '' && Number.isFinite(Number(v)) && Number(v) >= 0) clean[k] = Math.trunc(Number(v));
  }
  _globalOverrides = clean;
  return clean;
}
function getGlobalOverrides() { return Object.assign({}, _globalOverrides); }
function ov(key, envValue) { return _globalOverrides[key] != null ? _globalOverrides[key] : envValue; }

// Characters per estimated token (chars/N heuristic). ~4 chars/token is the common English
// rule of thumb for Claude/GPT BPE tokenizers. Override with CLAUDE_CHARS_PER_TOKEN.
function charsPerToken() { return intEnv('CLAUDE_CHARS_PER_TOKEN', 4, 1, 100); }

// Default PER-CLIENT allowance per five-hour cycle (the requested 20,000). Admin global
// override → env → hardcoded.
function defaultClientLimit() { return ov('defaultClientLimit', intEnv('CLAUDE_DEFAULT_CLIENT_TOKENS', 20000, 0, 1e12)); }

// Base (Pro 1x) usable estimate of a single account's five-hour capacity, BEFORE the safety
// reserve and BEFORE plan scaling. Scaled by the plan multiplier below.
function accountBaseTokens() { return ov('accountBaseTokens', intEnv('CLAUDE_ACCOUNT_BASE_TOKENS', 44000, 0, 1e12)); }

// Safety reserve percentage (kept UNused as headroom). Default 20%.
function safetyReservePct() { return Math.min(95, Math.max(0, ov('safetyReservePct', intEnv('CLAUDE_SAFETY_RESERVE_PCT', 20, 0, 95)))); }

// Default GLOBAL per-client WEEKLY allowance (the requested 150,000). Override with
// CLAUDE_DEFAULT_WEEKLY_CLIENT_TOKENS. A hard 200,000 fallback (below) applies only if this
// somehow resolves to an invalid value.
function defaultWeeklyClientLimit() { return ov('defaultWeeklyClientLimit', intEnv('CLAUDE_DEFAULT_WEEKLY_CLIENT_TOKENS', 150000, 0, 1e12)); }
const WEEKLY_HARD_FALLBACK = 200000; // last-resort weekly allowance per spec

// Base (Pro 1x) usable estimate of a single account's WEEKLY capacity, before scaling/reserve.
function accountWeeklyBaseTokens() { return ov('accountWeeklyBaseTokens', intEnv('CLAUDE_ACCOUNT_WEEKLY_BASE_TOKENS', 300000, 0, 1e12)); }

// ── Plans ────────────────────────────────────────────────────────────────────
// Canonical plan keys and their capacity multipliers relative to Pro.
const PLANS = ['pro', 'max5', 'max20', 'unknown'];
const PLAN_MULTIPLIER = { pro: 1, max5: 5, max20: 20, unknown: 1 };
const PLAN_LABEL = { pro: 'Claude Pro', max5: 'Claude Max 5x', max20: 'Claude Max 20x', unknown: 'Unknown / unset' };

function isValidPlan(p) { return Object.prototype.hasOwnProperty.call(PLAN_MULTIPLIER, String(p || '')); }
function normalizePlan(p) { return isValidPlan(p) ? String(p) : 'unknown'; }
function planMultiplier(p) { return PLAN_MULTIPLIER[normalizePlan(p)]; }
function planLabel(p) { return PLAN_LABEL[normalizePlan(p)]; }

// ── Token estimation ─────────────────────────────────────────────────────────
// A single non-negative integer estimate from a character count.
function tokensFromChars(chars) {
  const c = Math.max(0, Math.trunc(Number(chars) || 0));
  return Math.ceil(c / charsPerToken());
}

// Estimate from a piece of text (utf-8 length). Safe on null/undefined/non-strings.
function tokensFromText(text) {
  if (text == null) return 0;
  const s = typeof text === 'string' ? text : String(text);
  return tokensFromChars(s.length);
}

// Sum a request's component character counts into a single estimated-token figure.
// Every component (input/prompt, system, context, attachments) is counted, per spec.
function estimateRequestTokens(parts) {
  const p = parts || {};
  const chars =
    Math.max(0, Math.trunc(Number(p.inputChars) || 0)) +
    Math.max(0, Math.trunc(Number(p.systemChars) || 0)) +
    Math.max(0, Math.trunc(Number(p.contextChars) || 0)) +
    Math.max(0, Math.trunc(Number(p.attachmentChars) || 0));
  return tokensFromChars(chars);
}

// ── Reset cycles (timezone-safe: pure epoch-ms math) ─────────────────────────
// Resolve the anchor epoch (ms) from an operator-supplied reset timestamp. When absent we
// fall back to a stable per-account anchor (createdAt) or the Unix epoch, so cycles are still
// deterministic. `windowMs` is CYCLE_MS or WEEK_MS.
function anchorMs(resetAt, fallback) {
  const t = resetAt ? new Date(resetAt).getTime() : NaN;
  if (Number.isFinite(t)) return t;
  const f = fallback ? new Date(fallback).getTime() : NaN;
  return Number.isFinite(f) ? f : 0;
}

// Given an anchor reset time and `now`, return the CURRENT window {index, startMs, endMs, key}.
// The anchor may be in the future or the past; index can be negative — that's fine, the window
// containing `now` is always returned. `key` is a stable string used to bucket usage rows.
function cycleWindow(windowMs, resetAt, now, fallbackAnchor) {
  const anchor = anchorMs(resetAt, fallbackAnchor);
  const nowMs = now == null ? Date.now() : new Date(now).getTime();
  const index = Math.floor((nowMs - anchor) / windowMs);
  const startMs = anchor + index * windowMs;
  const endMs = startMs + windowMs;
  return { index, startMs, endMs, key: `${anchor}:${windowMs}:${index}` };
}

function fiveHourWindow(resetAt, now, fallbackAnchor) {
  return cycleWindow(CYCLE_MS, resetAt, now, fallbackAnchor);
}
function weeklyWindow(resetAt, now, fallbackAnchor) {
  return cycleWindow(WEEK_MS, resetAt, now, fallbackAnchor);
}

// Seconds until the current five-hour window ends (for UI countdowns / "resets in").
function secondsUntilReset(windowObj, now) {
  const nowMs = now == null ? Date.now() : new Date(now).getTime();
  return Math.max(0, Math.round((windowObj.endMs - nowMs) / 1000));
}

// ── Capacity + allowance ─────────────────────────────────────────────────────
// The shared per-account capacity for ONE five-hour cycle, scaled by plan and net of the
// safety reserve. `opts` lets tests/routes inject base/reserve without env.
function accountCapacity(plan, opts) {
  const o = opts || {};
  const base = o.baseTokens != null ? Math.max(0, Math.trunc(o.baseTokens)) : accountBaseTokens();
  const reserve = o.reservePct != null ? Math.min(95, Math.max(0, o.reservePct)) : safetyReservePct();
  const scaled = base * planMultiplier(plan);
  return Math.floor(scaled * (1 - reserve / 100));
}

// Resolve a client's effective FIVE-HOUR allowance by the required priority:
//   client override → account default → global default → fallback.
// `accountDefault` is optional (older single-arg callers get client override → global default).
// A valid value is any finite number >= 0 (0 is a legitimate hard-stop).
function clientAllowance(clientOverride, accountDefault) {
  const asInt = (v) => (v == null || v === '' ? NaN : parseInt(v, 10));
  const c = asInt(clientOverride);
  if (Number.isFinite(c) && c >= 0) return c;            // client override
  const a = asInt(accountDefault);
  if (Number.isFinite(a) && a >= 0) return a;            // account default
  return defaultClientLimit();                            // global default (env or 20,000)
}

// The shared per-account WEEKLY capacity, scaled by plan and net of the safety reserve.
function accountWeeklyCapacity(plan, opts) {
  const o = opts || {};
  const base = o.baseTokens != null ? Math.max(0, Math.trunc(o.baseTokens)) : accountWeeklyBaseTokens();
  const reserve = o.reservePct != null ? Math.min(95, Math.max(0, o.reservePct)) : safetyReservePct();
  const scaled = base * planMultiplier(plan);
  return Math.floor(scaled * (1 - reserve / 100));
}

// Resolve a client's effective WEEKLY allowance by the required priority:
//   client override → account default → global default → 200,000 hard fallback.
// A valid number is any finite value >= 0 (0 is a legitimate hard-stop).
function weeklyClientAllowance(clientOverride, accountDefault) {
  const asInt = (v) => (v == null || v === '' ? NaN : parseInt(v, 10));
  const c = asInt(clientOverride);
  if (Number.isFinite(c) && c >= 0) return c;         // client override
  const a = asInt(accountDefault);
  if (Number.isFinite(a) && a >= 0) return a;         // account default
  const g = defaultWeeklyClientLimit();               // global default (env or 150,000)
  if (Number.isFinite(g) && g >= 0) return g;
  return WEEKLY_HARD_FALLBACK;                          // last-resort fallback
}

/**
 * The core gate. Returns whether ONE more request of `estIncoming` estimated tokens fits
 * within BOTH the per-client allowance AND the shared per-account capacity.
 *
 *   { allowed, reason, clientLimit, clientUsed, clientRemaining,
 *     accountCapacity, accountUsed, accountRemaining, estIncoming, label }
 *
 * `reason` ∈ null | 'client_limit' | 'account_capacity'. Client limit is checked first so the
 * message is the most actionable for the operator ("this client is out", vs "the shared
 * account is saturated"). A zero/negative limit or capacity means "blocked" (used=any → deny),
 * which lets an operator hard-stop a client by setting limit 0.
 */
function checkAllowance(input) {
  const i = input || {};
  const N = (v) => Math.max(0, Math.trunc(Number(v) || 0));
  const clientLimit = Math.max(0, Math.trunc(Number(i.clientLimit != null ? i.clientLimit : defaultClientLimit())));
  const clientUsed = N(i.clientUsed);
  const capacity = N(i.accountCapacity);
  const accountUsed = N(i.accountUsed);
  const estIncoming = N(i.estIncoming);

  const clientRemaining = Math.max(0, clientLimit - clientUsed);
  const accountRemaining = Math.max(0, capacity - accountUsed);

  // Weekly params are OPTIONAL — when omitted, the weekly gates are skipped entirely, so the
  // five-hour-only callers (and their tests) are unaffected.
  const hasWeekly = i.weeklyClientLimit != null || i.weeklyAccountCapacity != null;
  const weeklyClientLimit = i.weeklyClientLimit != null ? Math.max(0, Math.trunc(Number(i.weeklyClientLimit))) : null;
  const weeklyClientUsed = N(i.weeklyClientUsed);
  const weeklyAccountCapacity = i.weeklyAccountCapacity != null ? Math.max(0, Math.trunc(Number(i.weeklyAccountCapacity))) : null;
  const weeklyAccountUsed = N(i.weeklyAccountUsed);
  const weeklyClientRemaining = weeklyClientLimit != null ? Math.max(0, weeklyClientLimit - weeklyClientUsed) : null;
  const weeklyAccountRemaining = weeklyAccountCapacity != null ? Math.max(0, weeklyAccountCapacity - weeklyAccountUsed) : null;

  // Deny on the FIRST gate crossed. Order: five-hour client → five-hour account →
  // weekly client → weekly account. `reason` names exactly which one.
  let allowed = true;
  let reason = null;
  if (clientUsed + estIncoming > clientLimit) { allowed = false; reason = 'client_limit'; }
  else if (accountUsed + estIncoming > capacity) { allowed = false; reason = 'account_capacity'; }
  else if (weeklyClientLimit != null && weeklyClientUsed + estIncoming > weeklyClientLimit) { allowed = false; reason = 'weekly_client_limit'; }
  else if (weeklyAccountCapacity != null && weeklyAccountUsed + estIncoming > weeklyAccountCapacity) { allowed = false; reason = 'weekly_account_capacity'; }

  const out = {
    allowed, reason,
    clientLimit, clientUsed, clientRemaining,
    accountCapacity: capacity, accountUsed, accountRemaining,
    estIncoming, label: USAGE_LABEL,
  };
  if (hasWeekly) {
    out.weeklyClientLimit = weeklyClientLimit;
    out.weeklyClientUsed = weeklyClientUsed;
    out.weeklyClientRemaining = weeklyClientRemaining;
    out.weeklyAccountCapacity = weeklyAccountCapacity;
    out.weeklyAccountUsed = weeklyAccountUsed;
    out.weeklyAccountRemaining = weeklyAccountRemaining;
  }
  return out;
}

// ── Enforcement mode ─────────────────────────────────────────────────────────
// 'off'     — feature disabled (no counting, no blocking).
// 'count'   — count usage + surface estimates everywhere; block only the coarse action of
//             STARTING a new session when a client/account has zero remaining allowance
//             (safe: no per-message body parsing). This is the safe default.
// 'enforce' — everything in 'count' PLUS the gateway blocks an individual over-quota message
//             before it is forwarded to Claude (the strict per-request gate).
function quotaMode() {
  const m = String(process.env.CLAUDE_QUOTA_MODE || 'count').toLowerCase();
  return ['off', 'count', 'enforce'].includes(m) ? m : 'count';
}

// Reduce a decision to CLIENT-SAFE fields (no account id/label/identity ever). Every figure is
// an estimate; `label` restates that for any UI that renders it.
function presentDecision(d) {
  d = d || {};
  return {
    allowed: !!d.allowed, reason: d.reason || null,
    clientLimit: d.clientLimit ?? null, clientUsed: d.clientUsed ?? null, clientRemaining: d.clientRemaining ?? null,
    accountUsed: d.accountUsed ?? null, accountCapacity: d.accountCapacity ?? null, accountRemaining: d.accountRemaining ?? null,
    // Weekly figures (null when the caller didn't compute weekly).
    weeklyClientLimit: d.weeklyClientLimit ?? null, weeklyClientUsed: d.weeklyClientUsed ?? null, weeklyClientRemaining: d.weeklyClientRemaining ?? null,
    weeklyAccountUsed: d.weeklyAccountUsed ?? null, weeklyAccountCapacity: d.weeklyAccountCapacity ?? null, weeklyAccountRemaining: d.weeklyAccountRemaining ?? null,
    plan: d.plan || null, planLabel: d.planLabel || null,
    label: USAGE_LABEL,
  };
}

module.exports = {
  USAGE_LABEL,
  CYCLE_MS, WEEK_MS,
  quotaMode, presentDecision, setGlobalConfig, getGlobalOverrides, OVERRIDE_KEYS,
  PLANS, PLAN_MULTIPLIER, PLAN_LABEL,
  isValidPlan, normalizePlan, planMultiplier, planLabel,
  charsPerToken, defaultClientLimit, accountBaseTokens, safetyReservePct,
  defaultWeeklyClientLimit, accountWeeklyBaseTokens, WEEKLY_HARD_FALLBACK,
  tokensFromChars, tokensFromText, estimateRequestTokens,
  cycleWindow, fiveHourWindow, weeklyWindow, secondsUntilReset,
  accountCapacity, clientAllowance, accountWeeklyCapacity, weeklyClientAllowance, checkAllowance,
};
