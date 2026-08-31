# StealthWriter Proxy Gateway — Module Guide

An **isolated** add-on module. It does not modify existing auth, the admin panel,
the client dashboard, existing API routes, the database schema of other tables,
the Chrome extension flow, or existing tools (HIX, Paperpal, SciSpace, Jenni).
Everything lives behind its own routes, tables, models and a standalone gateway.

The backend (MySQL) is the **single source of truth** for status, expiry and
usage limits. The frontend / overlay / localStorage is never trusted.

---


> **Launch flow (2026-07-27):** StealthWriter now launches via a one-time **POST**
> bootstrap. The lease JWT is no longer placed in a URL, and no longer stored in the
> JS-readable `sw_lease` cookie — the browser holds only an opaque HttpOnly
> `__Host-stealth_session`, and the injected overlay authenticates via the gateway's
> same-origin `/__genz/validate` and `/__genz/consume`. Metering, daily limits and reset
> labels are relayed verbatim and are unchanged. The `?lease=` flow is retained behind
> `ALLOW_URL_LEASE` for rollback. See `LAUNCH_BOOTSTRAP.md`.

## 1. Architecture

```
Client dashboard (app.genzdigitalstore.com)
   │  "Open StealthWriter"
   ▼
POST /api/crm/client/stealth/open      ← validates status, expiry, limits
   │  mints a signed 30-min lease (JWT), stores hash in stealth_leases
   ▼
https://stealth1.genzdigitalstore.com/gateway?lease=TOKEN
   │  (standalone reverse proxy — /stealth-gateway)
   │  • stores lease in a host-scoped cookie
   │  • validates lease on every request (local JWT + backend /validate on HTML)
   │  • injects the Genz usage overlay, strips frame-blocking headers
   ▼
Real StealthWriter app (proxied)
   │  overlay intercepts humanize / AI-detector network calls
   ▼
POST /api/crm/stealth/gateway/consume  ← re-checks limits, increments OUR usage
```

Daily usage resets at **05:00 Asia/Karachi (Pakistan)** via cron **and** lazy
reset on read, so a missed cron run never lets stale counters through.

---

## 2. New files (all additive)

**Backend (`/backend`)**
- `models/stealth/StealthClient.js` — plan + limits + usage per CRM client
- `models/stealth/StealthLease.js` — signed 30-min leases (hash only)
- `models/stealth/StealthUsageLog.js` — per-action audit
- `models/stealth/StealthSettings.js` — lease duration + fixed-lease toggle
- `utils/stealth/time.js` — 05:00 PKT reset window + lazy reset
- `utils/stealth/config.js` — settings get/update
- `utils/stealth/lease.js` — lease sign/verify (dedicated secret)
- `utils/stealth/access.js` — central status/expiry/limit engine + consume
- `utils/stealth/resetAll.js` — daily reset helper
- `routes/admin/stealth.js` — admin management API
- `routes/client/stealth.js` — client dashboard + open
- `routes/stealth/gateway.js` — lease validate + usage consume
- `cron/stealthScheduler.js` — optional in-process daily reset
- `scripts/stealth-reset.js` — cron entrypoint
- `db/mysqlAdapter.js` — **edited**: 4 new table names registered
- `server-crm.js` — **edited**: 3 route mounts + scheduler start

**Standalone gateway (`/stealth-gateway`)** — deploy on `stealth1.genzdigitalstore.com`
- `server.js`, `public/overlay.js`, `public/overlay.css`, `package.json`, `.env.example`

**Frontend (`/frontend/src`)**
- `services/stealthService.js`
- `pages/admin/AdminStealthWriter.js` (route `/admin/stealthwriter`)
- `pages/client/ClientStealthWriter.js` (route `/client/stealthwriter`)
- `App.js`, `components/AdminLayoutEnhanced.js`, `components/ClientLayoutEnhanced.js` — **edited**: nav + route

---

## 3. Environment variables

**Backend `.env`** (additive — nothing existing changes):
```
# Optional. If unset, an isolated key is derived from JWT_SECRET via HMAC.
# If you run the standalone gateway, SET THIS and use the SAME value there.
STEALTH_LEASE_SECRET=<random 32+ char string>

# Where "Open StealthWriter" sends clients (default shown):
STEALTH_GATEWAY_URL=https://stealth1.genzdigitalstore.com/gateway

# Optional: run the daily reset inside the API process (default off → use system cron)
STEALTH_INTERNAL_CRON=false

# Account Vault (multi-account):
# Shared key for the gateway-only /session endpoint (returns the decrypted account
# session). MUST match the gateway's STEALTH_GATEWAY_KEY. If unset, account-session
# injection is disabled and the gateway proxies without logging in as a vault account.
STEALTH_GATEWAY_KEY=<random 32+ char string>
# AES-256 key (64 hex chars) for encrypting account sessions at rest. If unset, an
# isolated key is derived from JWT_SECRET; set explicitly in production so rotating
# JWT_SECRET never strands vault data.
STEALTH_VAULT_KEY=<64 hex chars>

# Account verification (Verify button). The backend makes ONE server-side request
# with the account cookies and stores only a safe result + masked id.
STEALTH_TARGET_ORIGIN=https://stealthwriter.ai
STEALTH_VERIFY_PATH=/dashboard
# Optional regex overrides if StealthWriter's logged-in/limit/blocked markers differ:
#   STEALTH_VERIFY_LOGIN_RE / STEALTH_VERIFY_LIMIT_RE / STEALTH_VERIFY_BLOCK_RE
```
Add the gateway origin to the existing `ALLOWED_ORIGINS` so the overlay's
cross-origin calls are permitted:
```
ALLOWED_ORIGINS=...,https://stealth1.genzdigitalstore.com
```

**Gateway `.env`** — see `stealth-gateway/.env.example`
(`STEALTH_TARGET_ORIGIN`, `STEALTH_API_BASE`, `GATEWAY_PUBLIC_ORIGIN`, `STEALTH_LEASE_SECRET`).

---

## 4. Cron (daily reset at 5:00 AM PKT)

On a UTC server (Hostinger default), 05:00 PKT == 00:00 UTC:
```
0 0 * * *  cd /home/USER/backend && node scripts/stealth-reset.js >> logs/stealth-reset.log 2>&1
```
If the server clock is already Asia/Karachi, use `0 5 * * *`.
Lazy reset is the safety net, so the exact cron time is not critical.

---

## 5. Security notes

### Account/identity hiding — defence in depth (server-side first)

Account, profile, billing, subscription, pricing, logout and user-info are hidden
**at the proxy/gateway**, not only in the browser. The overlay's MutationObserver
is now just a cosmetic *backup* for SPA soft-navigations.

Layers, in order:
1. **Route blocking** (`stealth-gateway/server.js`, real client leases only):
   - **Logout / sign-out** is never proxied (it would destroy the shared vault
     session) — page loads bounce to the editor, API calls get a no-op `{}`.
   - **Account / billing / subscription / pricing / settings / profile / affiliate**
     page navigations are 302-redirected to the humanizer editor (`BLOCK_NAV_RE`).
   - **Billing / invoice / payment / checkout / portal / pricing / plan** API calls
     are answered with an empty `{}` stub, never proxied (`STUB_API_RE`).
2. **Response sanitizing** (`IDENTITY_ROUTE_RE`): JSON bodies on
   session/user/me/account/profile/customer/subscription routes are deep-redacted —
   `name`→“Gen Z Digital Store”, `email`→`member@genzdigitalstore.com`,
   avatar/image/phone→null, and billing detail (price, card, invoice, customerId,
   nextBillingDate…) neutralized. **Auth structure and `plan.tier/status` are kept**
   so the app stays logged in and the Humanizer/AI-Detector gating still works.
   HTML/SSR payloads have email addresses stripped. Humanizer/AI-Detector and any
   non-identity/streaming responses are **never buffered or altered**, so usage
   counting, cookie injection and the lease flow are untouched.
3. **Critical hide CSS in `<head>`** (`buildCriticalCss` in `server.js`): the static
   account / billing / pricing / plan / support / logout hiding rules ship in the
   initial HTML `<head>` (href + aria-label/data-testid selectors, plus any operator
   `STEALTH_HIDE_SELECTORS`), so the browser never paints them — **this kills the
   1–2 s flash of hidden UI on load.**
4. **Browser overlay** (`overlay.js`): inlined in `<head>` so its `MutationObserver`
   starts hiding text-matched nodes before `<body>` paints, then stays as a backup for
   SPA re-renders. The top account/branding bar and bottom sidebar account area are
   hidden **completely** (no longer re-branded) — the “Gen Z Digital Store” label
   appears only in the bottom-right floating widget; the sidebar keeps just
   Dashboard / Humanizer / AI Detector and the editor/buttons/result area are untouched.

Sanitization **fails safe**: any JSON that doesn't parse is passed through
unchanged, so a non-identity payload can never be corrupted. No new layer logs
cookies, tokens, sessions, passwords, authorization headers or secrets — the
block/sanitize logs carry only `request_path` + a `kind` flag.

- Backend re-validates client status, plan expiry and limits on **every** action
  (`/validate` and `/consume`) — independent of the lease timer and the overlay.
- Disabling the fixed lease (admin setting) only removes the countdown; status,
  expiry and usage limits are still enforced server-side.
- Leases are JWTs signed with a **dedicated** secret; only the SHA-256 **hash** is
  stored in the DB, so a DB leak cannot reconstruct a usable lease.
- Usage metering overrides `fetch`/`XMLHttpRequest` and fails **closed** if the
  backend can't be reached.
- No cookies, sessions, tokens, passwords, authorization headers or secrets are
  logged anywhere in this module (gateway logs only method/path/status).
- The overlay's humanize/detector URL patterns are configurable
  (`window.__GENZ_GATEWAY__.humanizePattern` / `detectPattern`) — tune them to the
  real StealthWriter API once the endpoints are known.

---

## 6. Testing checklist

**Backend / data**
- [ ] Server boots; `stealth_clients`, `stealth_leases`, `stealth_usage_logs`, `stealth_settings` tables are created.
- [ ] `GET /api/crm/admin/stealth/settings` returns defaults (30 min, fixed lease on).
- [ ] Existing routes (auth, tools, clients, assignments, extension) are unaffected.

**Admin panel** (`/admin/stealthwriter`)
- [ ] Create a StealthWriter client linked to an existing CRM client.
- [ ] Edit plan name, humanizer/detector limits (incl. `-1` = unlimited), expiry, status.
- [ ] Reset usage sets counters to 0.
- [ ] Usage logs and leases show in the detail view; revoke a single lease and all leases.
- [ ] Update lease duration / toggle fixed lease; changes persist.

**Client dashboard** (`/client/stealthwriter`)
- [ ] Shows plan, status, expiry, used/remaining for both meters, and "5:00 AM Pakistan Time" reset note.
- [ ] "Open StealthWriter" opens `https://stealth1.../gateway?lease=…` in a new tab.
- [ ] Disabled/expired client cannot open (clear message).

**Gateway + overlay** (deployed on stealth1)
- [ ] Opening with a valid lease loads the proxied app with the overlay bar (countdown + remaining).
- [ ] Tampered/expired/revoked lease → block page (no app access).
- [ ] Performing a humanize action decrements the humanizer count; AI-detector decrements its count.
- [ ] When a meter hits 0 → action blocked with "limit reached" message; the other meter still works.
- [ ] At lease expiry the page is blocked.
- [ ] Pricing / billing / upgrade / account UI is hidden; core editor remains usable.

**Reset**
- [ ] `node scripts/stealth-reset.js` zeroes all clients' usage.
- [ ] First action after 05:00 PKT triggers a lazy reset even without cron.

**Security**
- [ ] Editing localStorage / overlay state does not raise limits (backend rejects).
- [ ] Logs contain no cookies, tokens, passwords, or auth headers.

---

## 7. Multi-account Account Vault

Admin → StealthWriter → **Account Vault** manages the operator's *own* authorized
StealthWriter accounts. This never bypasses StealthWriter's official limits, credits,
login, captcha or payment — it only chooses which of your accounts a lease proxies
through and injects that account's session server-side.

- **Model:** `StealthAccount` (`stealth_accounts`). Session bundles are encrypted at
  rest with AES-256-GCM (`utils/stealth/vaultCrypto`, key `STEALTH_VAULT_KEY`). Only
  `sessionMeta` (cookie count, hasLocalStorage, origin) is ever shown — never the secret.
- **Statuses:** `active`, `standby`, `limit_reached`, `session_expired`, `blocked`.
- **Buttons:** Refresh Session, Set as Primary, Mark Limit Reached, Mark Active,
  Revoke Active Leases (+ Delete). Selection mode (settings): Manual Primary,
  Auto Failover (default = Manual Primary + Auto Failover), Round Robin, Least Used.
- **Selection at lease creation:** `utils/stealth/accountSelect` picks an `active`
  account and stores `accountId` + `accountLabel` on the lease (and `acid` in the JWT).
  Only active accounts are eligible; existing leases keep their account until expiry
  or admin revocation.
- **Gateway session injection:** the gateway calls the gateway-only
  `POST /api/crm/stealth/gateway/session` (header `X-Gateway-Key: STEALTH_GATEWAY_KEY`),
  receives the decrypted bundle server-side, injects cookies into the upstream `Cookie`
  header and localStorage/sessionStorage via an early bootstrap script. The browser
  never sees account details; `/validate` and `/consume` never return account info.
  `blocked` accounts hard-stop the session; admin "Revoke Active Leases" cuts sessions.
- **Admin logs:** lease + usage views show the internal account label used — no secrets.

**Bundle format** (pasted when adding/refreshing an account):
```json
{ "cookies": [{ "name": "session", "value": "..." }], "localStorage": { "token": "..." } }
```
`cookies` may also be a raw `"name=value; ..."` header string.

### Multi-account testing checklist
- [ ] Add 2+ accounts; mark one primary. Auto Failover uses primary; Mark Limit Reached → new leases use the next active account.
- [ ] Open StealthWriter → gateway loads the bound account's session (logged in as that account).
- [ ] Round Robin / Least Used rotate across active accounts on new leases.
- [ ] Mark an account `blocked` → its sessions stop; Revoke Active Leases cuts them immediately.
- [ ] Refresh Session clears `session_expired`; admin UI shows only cookie counts, never raw values.
- [ ] Lease/usage logs show the account label; no secrets anywhere.

---

## Session validation: terminal vs. retryable (2026-07-21)

StealthWriter shares the proxy-tools validation contract. Full rationale and the shared
design are in **PROXY_TOOLS_MODULE.md → "Session validation: terminal vs. retryable"**;
this section records only what is StealthWriter-specific.

### What changed here
`backend/routes/stealth/gateway.js` `POST /validate` now returns the shared structured body
via `utils/proxy/validationResponse.js`:

```
{ valid, terminal, retryable, code, secondsRemaining, expiresAt, serverTime, correlationId,
  fixedLease, plan:{planName,limits,used,remaining,expiryDate}, resetLabel, nextResetAt }
```

The plan/usage payload is **unchanged** — daily Humanizer/Detector limits, `resetLabel`,
`nextResetAt`, the 5:00 AM PKT reset and all intent-driven metering behave exactly as before.
`/consume` is untouched, including its deliberate `200 + allowed:false` on `limit_reached`.
`limit_humanizer` / `limit_detector` remain client-side message keys, never wire codes.

`stealth-gateway/public/overlay.js` keeps calling `updateUsage(r.body.plan)` on every
successful validation, so the widget's Humanizer / AI Detector counters refresh as before.

### Codes
Terminal (block, unchanged): `lease_missing`, `lease_invalid`, `lease_revoked`,
`lease_expired`, `client_not_found`, `client_disabled`, `plan_expired`.
Retryable (retry, previously fatal): `server_error`, 429, 5xx, network/timeout, malformed body.

### CORS — action required if `STEALTH_GATEWAY_URL` is unset
`server-crm.js` previously added the stealth gateway origin to the CORS allowlist **only**
when `STEALTH_GATEWAY_URL` was set, while `utils/stealth/lease.js` already fell back to
`https://stealth1.genzdigitalstore.com`. With the env unset the backend minted leases for an
origin its own CORS then rejected, so the overlay's `/validate` preflight failed and the
session died — while every proxy-tool gateway (auto-derived from `utils/proxy/tools.js`) kept
working. `server-crm.js` now uses the same fallback, so the two can no longer disagree.
Setting `STEALTH_GATEWAY_URL` explicitly in production is still recommended.

### Deploy
`routes/stealth/gateway.js`, `middleware/rateLimiter.js`, `server-crm.js` and the **new**
`utils/proxy/validationResponse.js` → `nodejs/...`, then `tmp/restart.txt`.
Gateway: `stealth-gateway/server.js` + `public/overlay.{js,css}`, then its own restart.
The stealth gateway requires `utils/proxy/validationResponse.js` on the backend — ship it
with the routes or `/validate` will throw on boot of the first request.

---

## Usage is charged only after a verified result (2026-08-31)

### The defect

Clicking **Humanize** decremented the Gen Z Humanizer count *before* StealthWriter had
produced anything. When StealthWriter answered

> The service is temporarily unavailable due to high demand. Please try again in a moment.

the member still lost a credit. Same for a network drop, a timeout, an abort or an empty
result.

**Root cause (code, not inference).** `public/overlay.js` wrapped `fetch`/`XMLHttpRequest`
and, on the first mutating request after a recognised main-button click, did:

```js
return consume(action).then(ok => ok ? origFetch(input, init) : reject())
```

so `POST /consume` — and therefore `access.consume()`, which does
`client.usage.humanizerUsed += 1; await client.save()` — ran **before** the upstream request
was even dispatched. The upstream outcome was never fed back to anything. Charging was a
function of the *click*, not of the *result*.

### The lifecycle

```
RESERVE ──────────► (upstream request) ──────────► COMMIT     (verified result)
   │                                          └──► CANCEL     (any failure)
   └──────────────────────────────────────────────► EXPIRED   (nothing settled it)
```

| Step | Who | What it does to the count |
|---|---|---|
| `POST /__genz/usage/reserve` | overlay → gateway → backend | **nothing** — holds capacity, mints an operation id |
| the tagged upstream request | overlay → gateway → StealthWriter | nothing |
| `POST …/usage/commit` | **gateway only**, from the real response | `+1`, exactly once |
| `POST …/usage/cancel` | gateway, or the overlay on a client-side failure | nothing |

The credit moves at **commit and nowhere else**. Not on the click, not on request creation,
not on dispatch, not on connection, not on job acceptance, not on a loading state.

### The gateway decides, never the browser

`/__genz/usage/commit` answers **403 `gateway_decides_outcome`** to any browser caller, and
the backend's `/usage/commit` additionally requires `X-Gateway-Key`, which no browser holds.
The overlay's only powers are *reserve*, *tag* and *release*.

The overlay tags exactly the request it reserved for with `X-Genz-Op` (the operation id) and
`X-Genz-Action`. `proxy()` **strips every `X-Genz-*` request header before forwarding**, on
every request, so nothing of ours ever reaches StealthWriter. The operation is bound at the
backend to the client resolved *from the lease*, so a tagged request can never touch another
client's operation.

### Success classification (default-deny)

Evidence from StealthWriter's own public bundle (landing scanner):

* failures are a **non-2xx status with a plain `{"error": "…"}` body`** —
  `if (!res.ok) toast.error(json.error ?? "Scan failed.")`;
* successful payloads come back as an **obfuscated envelope `{"d":"<base64>","s":"<salt>"}`**
  and are decoded client-side.

So a non-empty `d` + `s` envelope on a 2xx **is** proof that a payload was produced — and it
is proof the gateway can read *without ever decoding the member's text*. That is the primary
success signal. `classifyUpstreamOutcome()` in `stealth-gateway/server.js`:

| Observation | Outcome |
|---|---|
| non-2xx (429 / 503 / 4xx / 5xx / 502-504) | **cancel** |
| transport error, DNS/TLS failure, socket destroyed | **cancel** |
| client aborted / tab closed | **cancel** |
| 2xx, zero bytes | **cancel** |
| 2xx JSON with `error` / `errors` / `detail` / `success:false` | **cancel** |
| 2xx JSON, unparsable or no result field | **cancel** (ambiguous) |
| 2xx `application/json` with non-empty `{d,s}` envelope | **commit** |
| 2xx JSON with a non-empty known result field | **commit** |
| `text/event-stream` that carried data and ended cleanly with no error frame | **commit** |
| `text/x-component` (Next.js Server Action / RSC) | **ambiguous → cancel** unless `STEALTH_RSC_SUCCESS=1` |
| any other content type | **ambiguous → cancel** |

Ambiguous outcomes emit a `usage_outcome_ambiguous` warning carrying only the **shape** —
status, content type, byte count and top-level JSON **key names** — never a value. That log
is what turns one live QA humanization into the evidence needed to tighten the classifier.

The body is **not buffered**: the observer tees at most 64 KB while the response streams to
the browser untouched and undelayed.

### Durability and concurrency

`stealth_usage_operations` (new, StealthWriter-only, additive; registered in
`db/mysqlAdapter.js` and created idempotently by `ensureTables()`) holds two row kinds:

* **reservation** — `_id = 'r' + sha256(clientId|action)[0..30]`. The key is *deterministic
  per client and action*, so the primary key itself allows at most one active reservation per
  (client, action). Two racing reserves leave exactly one surviving operation id, and only
  that one can be committed. `'r'` is not a hex digit, so it can never collide with an
  operation id.
* **outcome** — `_id = operationId` (128 random bits). The idempotency ledger: a duplicate
  commit returns the recorded result, a commit after a cancel is refused, a cancel after a
  commit reports the commit and reverses nothing.

The claim is a **DELETE by primary key**, exactly as `utils/launchStore.js` does for one-time
launch codes and for the same reason — `db/mysqlAdapter.js` implements `findOneAndUpdate` as
read → merge in JS → write, which is *not* safe against concurrent callers. InnoDB serializes
the row delete and mysql2 reports `affectedRows` exactly, so `deletedCount === 1` is the
database's own answer to "did I win". No in-memory lock is involved, so this is correct
across Passenger workers, page reloads and gateway restarts.

Rows carry ids, the action, a status, a short outcome code, an upstream status and
timestamps. Never text, output, cookies, tokens, headers or request bodies.

### Recovery rules

| Situation | Behaviour |
|---|---|
| limit reached at reserve | no upstream request, friendly limit message, count unchanged |
| backend unreachable at reserve | **fail closed** — request not sent, retryable connection toast, count unchanged |
| upstream fails | gateway cancels; the genuine StealthWriter error is still shown to the member |
| commit does not reach the backend | same operation id retried 5× over ~16 s with jittered backoff, then a `usage_settle_unconfirmed` warning; the reservation expires and nothing is charged |
| cancel does not reach the backend | reservation expires on its own — an undelivered cancel can never become a charge |
| gateway restarts mid-operation | nothing commits; the reservation expires; count unchanged |
| another lease already has one in flight | `operation_in_flight`, no upstream request |
| the *same* lease reserves again (reload, re-click) | supersedes its own reservation; the superseded id can never charge |

Reservation TTL: `STEALTH_USAGE_OP_TTL_SEC`, default **180 s** (StealthWriter advertises a
result in under 10 s). Outcome retention: `STEALTH_USAGE_OP_RETENTION_SEC`, default 24 h,
swept lazily.

### Unchanged on purpose

* `/consume` and `access.consume()` are **untouched**, so an overlay cached from before this
  deploy keeps metering exactly as it did during the rollout.
* Result-area actions (Humanize More, Rehumanize, Re-humanize Output, Copy, Compare, Deep
  Scan, Retry, Download, Export) still never meter — which matches StealthWriter's own FAQ:
  *"Only the initial Humanize action uses your daily humanization."*
* Daily 5:00 AM PKT reset, lease/countdown, vault sessions, account selection, the visual
  editor and model/level/output settings are all untouched.

### New environment variables (all optional, all StealthWriter-only)

```bash
# Gateway (stealth1 .htaccess SetEnv)
STEALTH_METERED_PATHS=          # regex; when set, a mutating request to a metered path
                                # WITHOUT a reservation is refused (409) instead of being
                                # proxied for free. Leave UNSET until the live audit confirms
                                # the exact Humanizer/Detector paths.
STEALTH_RSC_SUCCESS=0           # 1 only after a live audit proves a clean text/x-component
                                # response means a produced result
STEALTH_SUCCESS_JSON_KEYS=      # extra comma-separated result keys for the classifier
STEALTH_OP_SAFETY_TIMEOUT_MS=120000

# Backend
STEALTH_USAGE_OP_TTL_SEC=180
STEALTH_USAGE_OP_RETENTION_SEC=86400
```

### Tests

```bash
cd stealth-gateway && npm test    # launchBootstrap + usageLifecycle + usageBackstop
cd backend        && npm test     # includes tests/stealthUsageOperations.test.js
```

### Deploy

Backend: `routes/stealth/gateway.js`, `utils/stealth/access.js`, `db/mysqlAdapter.js` and the
**new** `models/stealth/StealthUsageOperation.js` → `nodejs/…`, then `tmp/restart.txt`. The
new model is in `deploy-hostinger.sh`'s upload list — `tests/deployCleanRoom.test.js` fails
the build if it ever is not, because a missing module boots Passenger into
"Cannot find module" and takes the whole API down.

Gateway: `bash deploy-stealth-gateway.sh` (ships `server.js` + `public/overlay.{js,css}`
together — they must not be split; the overlay calls `/__genz/usage/*`, which only the new
`server.js` serves).

`ensureTables()` creates `stealth_usage_operations` on boot: additive, idempotent, and it
touches no existing table.
