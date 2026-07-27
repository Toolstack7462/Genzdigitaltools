# Proxy-Tools Module — HIX AI & BypassGPT

Two **separate** proxy tools built on the StealthWriter pattern, fully isolated from
StealthWriter, auth, the admin panel, the client dashboard, the extension flow, the
old cookie system, and the existing tools (HIX existing logic, Paperpal, SciSpace,
Jenni). HIX AI and BypassGPT are independent: separate gateway subdomains, separate
target origins, **separate encrypted cookie vaults** (accounts are tagged by `tool`),
separate client grants, separate leases. Nothing is shared except a reusable code
template.

Key differences from StealthWriter (by request):
- **No humanization limit, no AI-detector limit, no usage metering** (no `/consume`).
- 30-minute access lease, exactly like StealthWriter.

> **Claude exception (added later):** the **Claude AI** proxy tool alone carries an isolated,
> additive **estimated token-quota** layer (per-client + shared-account allowances, plan
> scaling, 5-hour/weekly resets, safety reserve). It is claude-gated and does not change HIX,
> BypassGPT, ChatGPT, Ryne, WriteHuman or Grok, which remain metering-free as described above.
> All Claude figures are **"Estimated local token usage"** (a proxy-side estimate, not
> Anthropic's official metering). See `CLAUDE_TOKEN_QUOTA.md`.


> **Launch flow (2026-07-27):** Claude AI now launches via a one-time **POST**
> bootstrap — the dashboard submits a single-use code to the gateway's `/launch`, the
> gateway redeems it server-to-server and 303s to a clean URL. No lease/JWT ever appears
> in a URL, history, Referer or an access log. The `?lease=` flow below is retained
> behind `ALLOW_URL_LEASE` for rollback and is still what HIX / BypassGPT / ChatGPT /
> Ryne / Grok / WriteHuman use, unchanged. See `LAUNCH_BOOTSTRAP.md`.

## Flow
```
Client dashboard → "Open HIX AI"/"Open BypassGPT" (assigned-tool card)
  POST /api/crm/client/proxy-tools/:tool/open   ← validates grant (status/expiry)
     mints a signed 30-min lease (JWT), picks an account from that tool's vault
  → https://hix1… / https://bypassgpt1….  /gateway?lease=TOKEN
     • host-scoped lease cookie, validates lease every request (+ backend /validate on HTML)
     • attaches the account's cookies SERVER-SIDE (Cookie header) — never to the browser
     • hides account/email/plan/pricing/billing/subscription/upgrade/logout/API-keys/profile
     • injects a small widget: Gen Z Digital Store · <tool> · session time · support
  → real tool (hix.ai / www.bypassgpt.ai), proxied
```

## Backend (all additive)
- `models/proxy/ProxyAccount.js` — vault account, tagged by `tool` (`proxy_accounts`)
- `models/proxy/ProxyLease.js` — 30-min lease, hash only (`proxy_leases`)
- `models/proxy/ProxyClient.js` — per-(user,tool) access grant (`proxy_clients`)
- `utils/proxy/tools.js` — tool registry + per-tool env (target/gateway/path)
- `utils/proxy/vaultCrypto.js` — AES-256-GCM, key `PROXY_VAULT_KEY` (own namespace)
- `utils/proxy/lease.js` — JWT, secret `PROXY_LEASE_SECRET` (own namespace)
- `utils/proxy/accountSelect.js`, `cookies.js`, `verify.js` — isolated copies
- `routes/admin/proxyTools.js`  → `/api/crm/admin/proxy-tools/:tool/...`
- `routes/client/proxyTools.js` → `/api/crm/client/proxy-tools`
- `routes/proxy/gateway.js`     → `/api/crm/proxy/gateway` (validate/session/account-expired/capture-session)
- `db/mysqlAdapter.js` — 3 new table names registered
- `server-crm.js` — 3 mounts + 2 gateway origins added to CORS

## Standalone gateway — `proxy-gateway/`
ONE codebase, deployed twice (one per subdomain) with its own `.env`
(`.env.hix.example`, `.env.bypassgpt.example`). No metering. Identity shield + brand
widget. Never logs cookies/tokens/secrets.

## Backend env (additive — nothing existing changes)
```
PROXY_LEASE_SECRET=<random 32+ chars>     # must match BOTH gateways' LEASE_SECRET
PROXY_GATEWAY_KEY=<random 32+ chars>      # must match BOTH gateways' GATEWAY_KEY
PROXY_VAULT_KEY=<64 hex chars>            # optional; else derived from JWT_SECRET
# Optional overrides (defaults shown):
HIX_GATEWAY_URL=https://hix1.genzdigitalstore.com
HIX_TARGET_ORIGIN=https://hix.ai
HIX_DEFAULT_PATH=/app/bypass-ai-detection/dashboard
BYPASSGPT_GATEWAY_URL=https://bypassgpt1.genzdigitalstore.com
BYPASSGPT_TARGET_ORIGIN=https://www.bypassgpt.ai
BYPASSGPT_DEFAULT_PATH=/ai-humanizer
PROXY_ACCOUNT_SELECTION_MODE=auto_failover
```

## Admin
`/admin/proxy-tools` → tab per tool (HIX AI / BypassGPT). Per tool: Account Vault
(add/update cookies, verify, set primary, mark active/standby/limit_reached/
session_expired/blocked, capture-via-proxy, revoke sessions, delete) and Client
Access (grant/edit/remove, set expiry, revoke sessions).

## Client
HIX AI and BypassGPT appear as normal assigned-tool cards on the Dashboard and My
Tools (not sidebar items). "Open" mints a 30-min lease and opens the gateway tab.

## Safety
For the operator's OWN authorized accounts and client access control only. Does NOT
bypass, modify, reset, increase or interfere with the tools' official usage,
subscription, captcha, login, payment or account limits. Never logs cookies, tokens,
sessions, passwords, authorization headers or secrets.

---

## Grok (added) — `grok1.genzdigitalstore.com`
Grok is added as a normal, **isolated** proxy tool — NOT an API integration. It reuses
the exact same backend cookie/session vault + reverse-proxy/lease architecture as the
other proxy tools and is **registry-driven**, so it appears automatically in Admin
Proxy Tools, Assignments, the Client Dashboard and My Tools once registered + granted.

- **Registry:** one entry `grok` in `backend/utils/proxy/tools.js`
  (`TARGET_ORIGIN=https://grok.com`, gateway `grok1.genzdigitalstore.com`,
  `DEFAULT_PATH=/chat`). grok.com is the standalone cookie-session web app (not
  `x.com/i/grok`). No mixing with StealthWriter/HIX/BypassGPT/WriteHuman/ChatGPT logic.
- **Vault / admin:** the existing `/admin/proxy-tools/:tool/...` routes already serve
  Grok — add multiple accounts, cookies encrypted at rest (AES-256-GCM, never returned
  after save), verify against a logged-in page, statuses
  active/standby/session_expired/blocked/limit_reached, refresh + capture-via-proxy.
- **Gateway:** dedicated **`grok-gateway/`** folder (a copy of the generic, hardened
  `proxy-gateway/server.js`, byte-identical so fixes apply everywhere). Cookies are
  attached **server-side**; never set in the browser. Cloudflare/Turnstile-aware
  (pinned UA/client-hints, renders the REAL challenge for the user to solve). Health
  route `GET /__genz/health`, friendly notice/block pages (never blank), reload-loop
  breaker. Safe logs only (route/target/status/account_id/lease/error) — never cookies,
  tokens, sessions or secrets. Deploy steps + the `public_html/.htaccess` SetEnv block
  are in `grok-gateway/README.md` and `grok-gateway/.env.example`.
- **Unsupported fallback:** if Grok blocks reverse-proxy use or needs an unsupported
  browser-security flow, the gateway shows a clear notice/block page and the account
  verifies as `session_expired`/`unknown` — mark it blocked/session_expired in the
  vault. Nothing else breaks.

### Customizable countdown (session length)
The client-facing countdown = the backend lease length, now **configurable** instead of
a fixed 30 min (the overlay countdown is driven by the lease's expiry, so changing the
length changes the countdown):
- **Per-client:** `ProxyClient.leaseMinutes` (1–1440), editable in Admin → Proxy Tools →
  *(tool)* → Client Access → *Session length*.
- **Per-tool / global default** (used when a client has no override): env
  `GROK_LEASE_MINUTES` (or `<TOOL>_LEASE_MINUTES`) → `PROXY_LEASE_MINUTES` → 30.
- Resolved in `routes/client/proxyTools.js` via `tools.defaultLeaseMinutes()`; the
  effective value is returned to the client card and the admin table.

### Deploy notes
- **No `deploy-hostinger.sh` change needed** — every edited backend file
  (`utils/proxy/tools.js`, `models/proxy/ProxyClient.js`, `routes/admin/proxyTools.js`,
  `routes/client/proxyTools.js`) is already in the curl list. CORS auto-derives the
  `grok1` origin from `TOOL_KEYS`. `leaseMinutes` is a JSON field — no migration.
- **Frontend** changes (`ProxyToolCard.js`, `AdminProxyTools.js`) require
  `cd frontend && npm run build` before `deploy-hostinger.sh`.
- **Gateway** is deployed manually (like the others): create the `grok1` subdomain in
  hPanel, upload `grok-gateway/` to `~/grok-gateway`, write the subdomain `.htaccess`
  (see README), delete `default.php`, write `tmp/restart.txt`. Verify `/__genz/health`.

---

## Session validation: terminal vs. retryable (2026-07-21)

### The bug
The injected overlay treated **every** non-200 `/validate` response as a permanent access
failure — `showMessage(friendly(code), true)`, where `true` sets `state.terminal`. Once
terminal, both `validate()` and `tick()` early-return, so the countdown **froze at its last
value** while the widget showed *"Access could not be verified. Please refresh or contact
support."* That is the reported symptom: a stale time still on the clock next to a fatal error.

Three inputs reached that branch without being real denials:
- **HTTP 429** — the production trigger. `apiLimiter` (100 req / 15 min) was keyed by the
  express default `req.ip`, which behind Hostinger's CDN is a **rotating, shared edge IP**.
  The overlay polls every 30s (30 req/session/window), so ~3 concurrent sessions sharing a
  key exhausted the budget. The 429 body has no `code`, so `friendly(undefined)` fell
  through to the generic message. (Identical to the already-fixed `authLimiter` bug.)
- **HTTP 5xx** — a Passenger restart or DB blip returned `{code:'server_error'}`, which is
  not in `MSG`, so it also produced the generic terminal message.
- **Malformed JSON** — `r.json().catch(→{})` yields `{}`, so `body.valid` is undefined and
  the response fell into the same else-branch.

### The contract
`backend/utils/proxy/validationResponse.js` is the single source of truth. Every
`/validate` response now carries:

```
{ valid, terminal, retryable, code, secondsRemaining, expiresAt, serverTime, correlationId }
```

`terminal` is derived from a **closed** list of confirmed authorization denials —
`lease_expired`, `lease_revoked`, `lease_invalid`, `lease_missing`, `client_disabled`,
`client_not_found`, `plan_expired`, `account_blocked`, `account_no_session`. Anything else
(429, 5xx, network error, timeout, malformed body, an unknown future code) is `retryable`.
Unknown codes therefore fail **safe for availability** while still denying access.

HTTP statuses are unchanged: 401 for lease problems, 403 for revoked/expired/status, 500 on
a server fault. Nothing that blocked before stops blocking.

### Client behaviour
- Retryable failure → compact **"Connection interrupted — retrying…"** warning
  (`.genz-sw-degraded`, calmer than the error state). Never sets `state.terminal`.
- Retries with **exponential backoff + jitter** — 2s, 4s, 8s, 16s, capped at 30s, ±30%.
- The warning **auto-clears** on the next successful validation.
- The countdown is anchored to the absolute server-issued `expiresAt`, corrected for clock
  skew via `serverTime`, so it can never freeze or drift and self-heals after a stalled tab.
- A short last-known-good grace period (`CFG.validateGraceMs`, default 120s) suppresses the
  warning for brief blips. It cannot extend access: the absolute expiry keeps running.
- `state.inFlight` collapses concurrent validations so overlapping calls cannot corrupt state.
- `log()` emits tool/route/status/code/latency only — never the lease, cookies or credentials.

### Rate limiting
- `apiLimiter` now uses the existing `clientIp` keyGenerator (real visitor, not the CDN edge).
- `/validate` gets its own `validateLimiter` — 400 req / 15 min, tunable via
  `VALIDATE_RATE_LIMIT_MAX` / `VALIDATE_RATE_LIMIT_WINDOW_MS`. Its 429 body is explicitly
  `{terminal:false, retryable:true}`.

### Gateway behaviour
- **HTML navigation** (`server.js`): only a confirmed terminal code renders a block page. A
  transient failure falls back to the **local** JWT check, which still enforces signature and
  expiry — so an outage degrades to signature+expiry enforcement instead of blocking a valid
  session. Still fails closed when the local check is also inconclusive. This extends the
  behaviour that already existed for `status === 0` (network/timeout) to 429/5xx.
  **Tradeoff:** during a backend outage an admin *revocation* may not be observed until the
  backend returns. Expiry is unaffected.
- **Claude** (`claude-gateway/server.js` `/__genz/validate`): previously **any** non-200 —
  including `status: 0` from the 8s timeout — called `claudeRevoke()` and expired the opaque
  session cookie, permanently destroying a valid lease on a transient blip with no possible
  client-side recovery. It now revokes **only** on a confirmed terminal code.

### CORS
`server-crm.js` now derives the StealthWriter gateway origin with the same fallback as
`utils/stealth/lease.js` (`https://stealth1.genzdigitalstore.com`). Previously the allowlist
entry required `STEALTH_GATEWAY_URL` while lease minting did not, so with the env unset the
backend issued leases for an origin its own CORS rejected. Proxy-tool gateway origins were
already auto-derived from `utils/proxy/tools.js` and were never affected.
`writehuman-v2` (writehuman2) is not in `TOOLS` and still needs a manual `ALLOWED_ORIGINS` entry.

### Tests
`backend/tests/validationResponse.test.js` (contract) and
`backend/tests/overlayValidation.test.js` (behaviour — loads each shipped `overlay.js` into a
DOM/fetch sandbox with a virtual clock and drives the real validation loop across all seven
gateways). Both are in `npm test`. Verified meaningful: they fail against the pre-fix overlay.

### Deploy
Backend: `utils/proxy/validationResponse.js` (**new — must ship**), `routes/proxy/gateway.js`,
`routes/stealth/gateway.js`, `middleware/rateLimiter.js`, `server-crm.js`. Each gateway:
`server.js` + `public/overlay.js` + `public/overlay.css`. Confirm the new util actually
lands — a split feature silently half-works if only one file ships.
