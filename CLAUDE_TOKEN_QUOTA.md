# Claude Token Quota (Estimated Local Usage)

Isolated, additive token-quota metering for the **Claude AI** proxy tool only. Every other
proxy tool (HIX, BypassGPT, ChatGPT, Ryne, WriteHuman, Grok) and all authentication, payment,
database and UI behaviour are **unchanged**. All figures are **Estimated local token usage** —
a proxy-side estimate derived from character counts, **not** Anthropic's official metering — and
no Claude credential, cookie, session or account internal is ever exposed.

## What it does

- **Plan detection & selection.** On *Verify*, the account's plan (Pro / Max 5× / Max 20×) is
  auto-detected from claude.ai's authenticated API **when reliable information is available**;
  the result is advisory. An admin can always set/override the plan manually (Pro / Max 5× /
  Max 20× / Unknown). Manual selection wins.
- **Per-client allowance (five-hour AND weekly).** Defaults: **20,000 estimated tokens per
  official five-hour cycle** and **150,000 per week**, both configurable. Each limit resolves by
  the priority **client override → Claude-account default → global default → system fallback**
  (5-hour fallback 20,000; weekly fallback 200,000). `0` is a valid hard-stop at any level. The
  five-hour and weekly overrides are stored **separately** — changing one never overwrites the
  other, and removing an override returns the client to the inherited default.
- **Account assignment.** Each client can be **pinned** to a specific Claude account or left on
  **automatic** selection. All clients on one account **share that account's** five-hour and
  weekly reset times.
- **Reset timestamps.** Admin can enter or correct the official five-hour and weekly reset
  timestamps per account; cycles are anchored on them (all math is UTC/epoch — timezone-safe).
- **Capacity scaling + safety reserve.** Shared per-account capacity = `base × plan multiplier ×
  (1 − reserve)`. Multipliers: Pro 1×, Max 5×, Max 20×. A configurable **20% safety reserve** is
  always withheld.
- **Four-sided check.** Before a request is allowed, **all** of these are checked: the client's
  five-hour allowance, the shared account's five-hour capacity, the client's weekly allowance,
  and the shared account's weekly capacity. Input, output, system-prompt, context and attachment
  characters are all counted. The widget shows both cycles (used, remaining, a thin bar, and the
  exact reset time), or **"Not synced"** when usage or the official reset time is unavailable —
  values are never fabricated.
- **Admin usage dashboard** (Admin → Claude → **Usage**). For every Claude client: name + status,
  assigned account, five-hour and weekly limit/used/remaining, five-hour and weekly reset times,
  Custom/Default indicator, limit-reached and account-at-capacity status, and expandable **recent
  usage history** (per request: input / context / output / total estimated tokens + timestamp).
  Editable **global** defaults (five-hour + weekly per-client, account base capacities, reserve)
  are on the same screen and apply immediately. All figures labelled *Estimated local token usage*.
- **Editable globals + accurate accounting.** Global defaults are admin-editable (stored in a
  single `ClaudeSettings` row; env is the fallback) — so the priority is client override →
  account default → **global default (editable)** → system fallback. Each settled request is
  recorded once with its input/context/output breakdown on the append-only ledger, guarded by a
  per-request idempotency key so a re-send can never double-charge; counters and enforcement are
  entirely server-side and race-safe.

## Client widget — "Estimated usage" progress lines

The always-visible Claude account widget shows two compact, Claude-style usage lines beneath the
session countdown (the Account, Session, Personal/Team **Workspace**, and Contact-support rows are
unchanged):

```
ESTIMATED USAGE
5-hour usage  Default              62% used
──────────────
12.4k / 20k · Resets today at 11:00 PM

Weekly usage  Custom               39% used
──────────────
78k / 200k · Resets Tuesday, 21 July at 5:00 PM PKT
```

- **Percentage** = used ÷ **effective** limit (accurate, integer). The **thin progress line** is
  capped at 100 % even when usage exceeds a newly reduced limit.
- **Used / total** tokens are shown compactly (`12.4k / 20k`), followed by the **exact reset
  moment**: the five-hour line reads *today / tomorrow / weekday* + time; the weekly line reads
  weekday, date, time **and the viewer's timezone**. All clients on one account share the same
  official reset timestamps, each rendered in the viewer's own locale.
- A discreet **Custom** / **Default** tag marks whether the effective limit came from a per-client
  override (*Custom*) or an inherited account/global default (*Default*).
- The widget uses the **client's effective limits live** — an admin limit change is reflected on
  the next refresh (~30 s) and simultaneously enforced by the gateway. Reducing a limit below the
  current usage turns the line red and **blocks further requests until the window resets**
  (existing recorded usage is preserved — the ledger is append-only, never reset by a limit edit).
- If usage or the official reset time is unavailable the line shows **"Not synced"** — never a
  fabricated value. When `CLAUDE_QUOTA_MODE=off` the usage lines are hidden entirely. The reset
  time is shown as "Not synced" **only when the account's official reset timestamp for that window
  is genuinely missing** (`cycleResetAt` for five-hour, `weeklyResetAt` for weekly) — usage still
  counts either way, and it is never "Not synced" because of a field-name/mapping mismatch.

The widget reads a **read-only** snapshot from the gateway's same-origin `/__genz/usage`, which
relays to the backend `POST …/quota-status` (gateway-key protected). This endpoint **records
nothing** and returns only client-safe figures (never an account id/label/plan-secret).

## Summary synchronization (ledger is the source of truth)

Every summary (client card, compact widget, admin table) is computed **live from the append-only
ledger on each request, page refresh and server restart** — there is no cached counter that can
drift. Current usage is the sum of the `totalTokens` of the rows whose **event time (`at`) falls
inside the active five-hour / weekly window** for the client's assigned account.

- **Aggregation is by event timestamp, not by a stored bucket key.** The earlier code summed rows
  by the `cycleKey`/`weekKey` string stored on each row. That string embeds the account's reset
  **anchor**, so the moment an operator **set or corrected** an account's official reset timestamp,
  the anchor shifted and the freshly recomputed key no longer matched the key stored on
  already-recorded rows — the usage was orphaned and the summary showed **0**, even though the
  (non-cycle-filtered) history still listed the request. Summing by the immutable `at` timestamp
  makes the ledger authoritative: a reset re-windows cleanly (a new cycle starts) and **never hides
  or deletes** recorded usage. The client widget and the admin table run the *same* aggregation, so
  they always agree.
- **Correct scoping.** Only rows for the correct `proxyClientId` **and** assigned `accountId`
  **and** inside the active window are counted; a different account's rows never leak in.
- **No double-counting.** Each settled request carries a `requestId`; a duplicate report is
  rejected before it is appended (idempotent), and the append-only design is race-safe.
- **Effective limits are read live** by the required priority (client override → account default →
  global default → fallback), so a client's real custom limit (e.g. 9,997) is used, and an admin
  limit change is reflected on the next read and enforced immediately. A reduced limit below current
  usage blocks further requests until the window resets; usage itself is preserved.

## Enforcement modes — `CLAUDE_QUOTA_MODE`

| Mode | Behaviour |
|------|-----------|
| `off` | Feature disabled: no counting, no blocking. |
| `count` *(default)* | Counts usage and shows estimates everywhere. Blocks only the coarse action of **starting a new session** when a client/account has zero remaining allowance. Never inspects message bodies, so it **cannot break a Claude chat**. |
| `enforce` | Strict per-action gate: before **every** Claude message the gateway **atomically reserves** the estimated tokens on the backend and blocks with **HTTP 429** — *without calling Claude* — if the five-hour, weekly **or** shared-account limit would be exceeded. |

**Rollout:** the safe default is `count`. Because the per-message gate parses claude.ai's live
completion API (which can only be validated against a real logged-in account), switch to
`enforce` **after** confirming the estimated counts look right for your account. Enforcement is
**fail-open**: any metering error, timeout or backend hiccup lets the message through — a
metering problem never blocks Claude. **Strict blocking only happens in `enforce` mode** — in
`count` mode messages are measured but never gated per-request.

### Strict enforcement (`enforce`) — reserve → check → settle

The server is the sole source of truth; the frontend only mirrors the state. For every Claude
action (prompt, search, file processing, any tool call — all go through the same completion
endpoint):

1. **Reserve atomically.** The backend appends a short-lived **reservation** row (append-only
   INSERT) for the estimated request tokens under a per-request idempotency id.
2. **Strict check.** It re-reads the ledger and admits the request only when, for the five-hour
   window, the weekly window **and** the shared-account capacity:
   `usedTokens + reservedTokens (this request + earlier in-flight) + estimatedRequestTokens ≤ effectiveLimit`.
   A blocked request is rolled back (holds no reservation) and the gateway returns **429**; Claude
   is never contacted.
3. **Settle or release.** On a successful response the reservation is **settled** to the actual
   input/context/output usage (deduped by the idempotency id → never double-charged); if the
   request fails/aborts upstream the reservation is **released** immediately, and any orphan expires
   after `CLAUDE_RESERVATION_TTL_MS` so a crash can never hold quota forever.

**Concurrency:** reserves for one account are serialized in-process, so simultaneous requests each
see every earlier reservation — the admitted set can never sum past the limit (proven by
`claudeQuotaEnforce.test.js`). Because a limit is read live at reserve time, **reducing a client's
limit below its current usage blocks the next request immediately**, until the official reset.

**Frontend mirror (never the source of truth):** when a window has no room left, the injected
overlay disables claude.ai's prompt field, send button, search controls and file-upload controls,
shows a banner with the exact reset time, and swallows Enter-to-send — but even if a control
slipped through, the backend 429 still refuses to call Claude. Progress bars cap at 100 % and read
**"Limit exceeded"** when usage is past the limit.

## Configuration (server env — all optional, safe defaults)

| Env | Default | Meaning |
|-----|---------|---------|
| `CLAUDE_QUOTA_MODE` | `count` | `off` / `count` / `enforce` (see above). |
| `CLAUDE_DEFAULT_CLIENT_TOKENS` | `20000` | Global default per-client allowance per five-hour cycle. |
| `CLAUDE_DEFAULT_WEEKLY_CLIENT_TOKENS` | `150000` | Global default per-client allowance per week (system fallback 200,000). |
| `CLAUDE_ACCOUNT_BASE_TOKENS` | `44000` | Pro (1×) base five-hour capacity, before scaling/reserve. |
| `CLAUDE_ACCOUNT_WEEKLY_BASE_TOKENS` | `300000` | Pro (1×) base weekly capacity, before scaling/reserve. |
| `CLAUDE_SAFETY_RESERVE_PCT` | `20` | Percent of capacity withheld as headroom. |
| `CLAUDE_CHARS_PER_TOKEN` | `4` | Chars-per-token estimation ratio. |
| `CLAUDE_RESERVATION_TTL_MS` | `300000` | How long an unsettled reservation holds quota before it expires (enforce mode). |
| `CLAUDE_COMPLETION_PATH_RE` | *(built-in)* | Override the completion-endpoint detection regex. |

Set `CLAUDE_QUOTA_MODE` in the **claude-gateway** environment (the per-request tap) **and** the
backend environment (the shared policy/endpoints). The gateway forwards only integer character
counts to the backend — never prompt text.

## Where it lives

**Backend (all claude-gated / additive):**
- `utils/proxy/claudeQuota.js` — pure engine: token estimation, five-hour/weekly cycles, plan
  scaling, safety reserve, capacity and the allowance check.
- `utils/proxy/claudeUsage.js` — buckets usage into the shared cycles and sums the current
  bucket (bridges the ledger and the engine).
- `models/proxy/ClaudeUsage.js` — **append-only** usage ledger (race-safe: no read-modify-write
  of a shared counter). Registered in `db/mysqlAdapter.js` as `claude_usage` (auto-created).
- `models/proxy/ProxyAccount.js` — adds `plan`, `planDetected`, `cycleResetAt`, `weeklyResetAt`
  (claude rows only).
- `models/proxy/ProxyClient.js` — adds `tokenLimit`, `pinnedAccountId` (claude rows only).
- `utils/proxy/accountSelect.js` — `resolveAccount()` (pinned-or-automatic; additive).
- `utils/proxy/claudeVerify.js` — best-effort `detectPlan()`.
- `routes/admin/proxyTools.js` — plan/reset/limit/pin admin controls; `GET …/quota-config`,
  `GET …/clients/:id/quota`.
- `routes/client/proxyTools.js` — pinned selection, coarse open-gate, per-card usage summary.
- `routes/proxy/gateway.js` — gateway-key-protected `POST …/quota-precheck` (reserves + strict
  check in enforce mode), `POST …/usage-report` (settles the reservation to real usage),
  `POST …/quota-release` (frees a reservation for a failed request), and the read-only
  `POST …/quota-status` (widget snapshot).
- `utils/proxy/claudeUsage.js` — `reserveAndCheck` (atomic reserve + strict `used+reserved+est`
  gate for both windows + shared account, per-account serialized), `settleUsage`,
  `releaseReservation`, `sumReservationsInWindow`, plus `usageStatus` (two-window widget data).
- `utils/proxy/claudeQuota.js` display helpers — `limitSource` (Custom/Default), `usagePercent`
  (capped 0–100).

**Gateway (claude-only; the file runs only on `claude1`):**
- `claude-gateway/lib/quotaTap.js` — pure helpers: completion detection, request char
  extraction, SSE output counting.
- `claude-gateway/server.js` — `TOOL_KEY==='claude'`-gated tap around the completion request, plus
  the same-origin `POST /__genz/usage` overlay endpoint (relays to `…/quota-status`).
- `claude-gateway/public/overlay.{js,css}` — the compact five-hour + weekly "Estimated usage"
  progress lines in the account widget (claude-only; no other tool's overlay changes).

## Security notes

- The per-request endpoints require the server-to-server `X-Gateway-Key`; a browser can never
  call them, so a client cannot fake or under-report usage.
- The pinned-account id is validated to belong to the Claude tool (no cross-tool / arbitrary-id
  assignment).
- The gateway sends only character **counts** to the backend; prompt text, cookies and sessions
  never leave the gateway. Logs carry counts/reasons/ids only — never secrets.
- The ledger stores only integer estimates plus ids/timestamps/cycle keys.

## Tests

`backend/tests/claudeQuota.test.js`, `claudeUsage.test.js`, `claudePlanDetect.test.js`,
`claudeUsagePipeline.test.js`, `claudeWeekly.test.js`, `claudeLimitOverride.test.js`,
`claudeUsageMgmt.test.js`, **`claudeUsageStatus.test.js`** (the widget data: percentage,
capped progress display, Custom/Default source, effective-limit priority, weekly reset day/date,
usage persistence across a limit change, and enforcement), **`claudeUsageSyncBug.test.js`**
(the summary-sync regression: usage survives a reset-anchor change, first event updates both
windows, multi-event aggregation, correct client/account/cycle scoping, idempotent dedup, reset
starts a new cycle without deleting history, concurrency), **`claudeUsageSyncE2E.test.js`**
(the same flow through the real mysqlAdapter), and **`claudeQuotaEnforce.test.js`** (strict
enforcement: over-limit is blocked, `used+reserved+est` gate for five-hour/weekly/shared-account,
**concurrency proof that simultaneous requests cannot bypass**, settle+dedup, release, expiry,
admin-reduce-below-usage) — all run via `npm test` — plus `claude-gateway/lib/quotaTap.test.js`
(`node --test claude-gateway/lib/quotaTap.test.js`).

## Operator go-live checklist

1. Deploy backend + rebuilt frontend + the claude-gateway.
2. Add/verify a Claude account (*Capture via proxy*) → plan auto-detects when available; set it
   manually otherwise.
3. Enter the official five-hour and weekly reset timestamps on the account.
4. (Optional) Set a global default via env; set per-client limits / pin accounts as needed.
5. Run in `count` first; confirm the estimated usage looks right against your real account.
6. Flip `CLAUDE_QUOTA_MODE=enforce` for strict per-message blocking.
