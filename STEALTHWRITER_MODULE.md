# StealthWriter Proxy Gateway — Module Guide

An **isolated** add-on module. It does not modify existing auth, the admin panel,
the client dashboard, existing API routes, the database schema of other tables,
the Chrome extension flow, or existing tools (HIX, Paperpal, SciSpace, Jenni).
Everything lives behind its own routes, tables, models and a standalone gateway.

The backend (MySQL) is the **single source of truth** for status, expiry and
usage limits. The frontend / overlay / localStorage is never trusted.

---

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
