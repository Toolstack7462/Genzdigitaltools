# WriteHuman V2 (experimental — Step 1: isolated standalone clone)

A **standalone, fully isolated** clone of the production WriteHuman proxy. It must **not**
touch — and does not depend on — the production proxy, backend, or database.

> Step 1 (this) = a runnable clone at parity, with clean seams for the new session
> architecture. Step 2 = cookie-hash change detection, the CDP Cookie Sync Agent, the
> smart-timer verify loop, and 24h/rotation/restart tests. See the plan and `agent/README.md`.

## What's isolated

- **Own process & port** (`WRITEHUMAN_V2_PORT`), own subdomain in production.
- **Own secrets** (`WRITEHUMAN_V2_*`) — a V2 lease/vault blob is never valid in production.
- **Own data store** — SQLite (`better-sqlite3`, optional) or a JSON file under `store/data/`.
  Never reads the production MySQL.
- **No shared runtime** with the production WriteHuman code path. The reverse proxy
  (`gateway/proxy.js`) is a clone of `proxy-gateway/server.js`; its only changes are: the
  backend calls go **in-process** to the V2 session manager, the overlay path, and it exports
  a handler instead of self-listening. WriteHuman behaviour (`DETECT_LOGGED_OUT=0`,
  `RESET_STORAGE_ON_NEW_LEASE=1`, `SUPABASE_BROWSER_SESSION=1`, hide selectors, nav blocks) is
  baked as defaults by `lib/config.js`.

## Layout

```
server.js              entry: one HTTP server → /v2/* API + the gateway
lib/      config, log, cookies, vaultCrypto, lease, verify (supabase_refresh), supabase
store/    accountStore (single-account encrypted vault) + schema.sql
session/  sessionManager (in-process backend) · cookieManager (hash + replace-not-merge)
          scheduler (Step-2 seam, inert) · syncIngest (Step-2 seam, guarded stub)
gateway/  proxy.js  (cloned WriteHuman reverse proxy)
agent/    Cookie Sync Agent — Step-2 placeholder (CDP)
test/     harness.js  (fake upstream + Supabase stub, end-to-end)
```

## Run locally

```bash
cd writehuman-v2
cp .env.example .env          # set WRITEHUMAN_V2_SECRET (and ideally the explicit secrets)
node server.js                # boots on WRITEHUMAN_V2_PORT (default 3100)
```

Health: `GET /v2/health` → JSON readiness (booleans/counts only, no secrets).

### Seed the single account & open it (admin-key guarded)

```bash
# 1. Import the account's cookie bundle (same format the prod admin pastes / captures):
curl -s -XPOST localhost:3100/v2/admin/seed -H "x-admin-key: $KEY" \
  -H 'content-type: application/json' \
  -d '{"label":"Primary","cookies":[{"name":"sb-<ref>-auth-token","value":"base64-..."}]}'

# 2. Mint a test lease (replaces the dashboard open-flow, which we do NOT wire yet):
curl -s -XPOST localhost:3100/v2/admin/lease -H "x-admin-key: $KEY" -d '{}'
#    → { token, url }  ; open `url` in a browser to use WriteHuman through V2.

# 3. Force a verify now (Supabase refresh):
curl -s -XPOST localhost:3100/v2/admin/verify -H "x-admin-key: $KEY"
```

## /v2 API

| Endpoint | Auth | Purpose |
|---|---|---|
| `GET  /v2/health` | none | readiness (no secrets) |
| `POST /v2/validate` | Bearer lease | is the lease usable? |
| `POST /v2/session` | `x-gateway-key` | decrypted cookie bundle (gateway-only) |
| `POST /v2/account-expired` | `x-gateway-key` | verify-gated expiry (supabase_refresh) |
| `POST /v2/cookies/ingest` | `x-admin-key` | **Step-2 stub** (CDP sync agent target) → 501 |
| `POST /v2/admin/seed` | `x-admin-key` | import the account cookie bundle |
| `POST /v2/admin/lease` | `x-admin-key` | mint a test lease |
| `POST /v2/admin/verify` | `x-admin-key` | run a verify now |

## Test

```bash
node test/harness.js     # spins a fake upstream + Supabase stub; 34 assertions; exit 0 = pass
```

The harness asserts: boot, seed/encrypt, lease validate, gateway-key session fetch,
verify-gated account-expired (live fast-path stays active; expired → flagged), refresh
exchange + rotation persistence, server-side cookie injection through the gateway, the
ingest stub auth, cookie-hash semantics (auth-only; replace-not-merge), and that **no cookie
value or refresh token ever appears in the logs**.

## Deploy (Hostinger Passenger — its OWN subdomain, never production)

V2 deploys as a **separate** Passenger app on a **new** subdomain. It never replaces or
touches the production WriteHuman gateway.

One-time (hPanel, manual — the script can't do these):
1. Create a subdomain, e.g. `writehuman2.genzdigitalstore.com`.
2. Create a Node.js (Passenger) app for it; app root = the V2 server dir
   (`/home/<user>/writehuman-v2`), startup file `app.js`, Node ≥ 18.
3. On the server create `.env` from `.env.example` with **real** V2 secrets and
   `WRITEHUMAN_V2_PUBLIC_ORIGIN=https://writehuman2.genzdigitalstore.com`.
   (The store falls back to a JSON file, so `better-sqlite3` is optional.)

Then deploy the code (uploads runtime files only — never `.env`):

```bash
SFTP_PASS='<hostinger sftp password>' bash writehuman-v2/deploy.sh
# verifies https://writehuman2.genzdigitalstore.com/v2/health → 200
```

Finally: seed the account (`/v2/admin/seed`) and run the Cookie Sync Agent on the RDP
(see `agent/README.md`). The production dashboard is **not** wired to V2 until it's proven.

## Managing V2 like your other tools (assignment + cutover)

WriteHuman is **already** a registered proxy tool, so it's assigned like any other:
**Admin → Proxy Tools → WriteHuman → Client Access** (grant + session length); the client
sees the WriteHuman card and clicks **Open**. Today that points at the production gateway
`writehuman1`. You don't build a new management UI for V2 — you point that existing tool at V2.

**Two-part switch (do the cutover only after the soak tests):**

1. **On V2 (no production change):** enable production-backed validate so V2 accepts the
   production-minted client leases and honours revocation/plan expiry, while still serving its
   own fresh session. In the V2 `.env`:
   ```
   WRITEHUMAN_V2_PROD_LEASE_SECRET=<the production PROXY_LEASE_SECRET>
   WRITEHUMAN_V2_PROD_API_BASE=https://api.genzdigitalstore.com/api/crm/proxy/gateway
   ```
   `/v2/health` then shows `"mode":"production-backed"`. (Leave blank = standalone; default.)

2. **Cutover (one production env change, on your go):** set
   `WRITEHUMAN_GATEWAY_URL=https://writehuman2.genzdigitalstore.com` in the production API app's
   env and restart it. From then on, every client assigned "WriteHuman" transparently uses V2 —
   managed exactly like HIX/BypassGPT. The Cookie Sync Agent keeps the session live. To roll
   back, point `WRITEHUMAN_GATEWAY_URL` back at `writehuman1`.

Until step 2, production WriteHuman keeps running on `writehuman1`, untouched.

## Security notes

- Cookie bundle encrypted at rest (AES-256-GCM, `lib/vaultCrypto`, V2 vault key).
- Logs are counts/ids/status only — never cookie values or tokens.
- The Supabase anon key is **public** (shipped to every browser); not a secret.
- Gateway-key and admin-key comparisons are constant-time (`crypto.timingSafeEqual`).
- Step 1 has **no background loops** (scheduler is inert) — lightweight by construction.
