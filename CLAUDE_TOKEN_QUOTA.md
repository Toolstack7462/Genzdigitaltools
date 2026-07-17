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
- **Per-client allowance.** Default **20,000 estimated tokens per official five-hour cycle**,
  configurable globally and per client (a custom limit; `0` hard-stops a client).
- **Account assignment.** Each client can be **pinned** to a specific Claude account or left on
  **automatic** selection. All clients on one account **share that account's** five-hour and
  weekly reset times.
- **Reset timestamps.** Admin can enter or correct the official five-hour and weekly reset
  timestamps per account; cycles are anchored on them (all math is UTC/epoch — timezone-safe).
- **Capacity scaling + safety reserve.** Shared per-account capacity = `base × plan multiplier ×
  (1 − reserve)`. Multipliers: Pro 1×, Max 5×, Max 20×. A configurable **20% safety reserve** is
  always withheld.
- **Two-sided check.** Before a request is allowed, **both** the client allowance **and** the
  shared account capacity are checked. Input, output, system-prompt, context and attachment
  characters are all counted.

## Enforcement modes — `CLAUDE_QUOTA_MODE`

| Mode | Behaviour |
|------|-----------|
| `off` | Feature disabled: no counting, no blocking. |
| `count` *(default)* | Counts usage and shows estimates everywhere. Blocks only the coarse action of **starting a new session** when a client/account has zero remaining allowance. Never inspects message bodies, so it **cannot break a Claude chat**. |
| `enforce` | Everything in `count` **plus** the gateway blocks an individual over-quota message *before* it is forwarded to Claude (the strict per-request gate). |

**Rollout:** the safe default is `count`. Because the per-message gate parses claude.ai's live
completion API (which can only be validated against a real logged-in account), switch to
`enforce` **after** confirming the estimated counts look right for your account. Enforcement is
**fail-open**: any metering error, timeout or backend hiccup lets the message through — a
metering problem never blocks Claude.

## Configuration (server env — all optional, safe defaults)

| Env | Default | Meaning |
|-----|---------|---------|
| `CLAUDE_QUOTA_MODE` | `count` | `off` / `count` / `enforce` (see above). |
| `CLAUDE_DEFAULT_CLIENT_TOKENS` | `20000` | Default per-client allowance per five-hour cycle. |
| `CLAUDE_ACCOUNT_BASE_TOKENS` | `44000` | Pro (1×) base capacity per cycle, before scaling/reserve. |
| `CLAUDE_SAFETY_RESERVE_PCT` | `20` | Percent of capacity withheld as headroom. |
| `CLAUDE_CHARS_PER_TOKEN` | `4` | Chars-per-token estimation ratio. |
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
- `routes/proxy/gateway.js` — gateway-key-protected `POST …/quota-precheck` and
  `POST …/usage-report`.

**Gateway (claude-only; the file runs only on `claude1`):**
- `claude-gateway/lib/quotaTap.js` — pure helpers: completion detection, request char
  extraction, SSE output counting.
- `claude-gateway/server.js` — `TOOL_KEY==='claude'`-gated tap around the completion request.

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
`claudeUsagePipeline.test.js` (run via `npm test`), and `claude-gateway/lib/quotaTap.test.js`
(`node --test claude-gateway/lib/quotaTap.test.js`).

## Operator go-live checklist

1. Deploy backend + rebuilt frontend + the claude-gateway.
2. Add/verify a Claude account (*Capture via proxy*) → plan auto-detects when available; set it
   manually otherwise.
3. Enter the official five-hour and weekly reset timestamps on the account.
4. (Optional) Set a global default via env; set per-client limits / pin accounts as needed.
5. Run in `count` first; confirm the estimated usage looks right against your real account.
6. Flip `CLAUDE_QUOTA_MODE=enforce` for strict per-message blocking.
