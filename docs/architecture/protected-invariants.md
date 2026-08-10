# Protected Invariants (As-Built)

> Behaviour that **every** future fix must preserve. Each invariant cites the code that
> establishes it today. If a fix must change one of these, that is a deliberate, isolated
> change with its own review — never a side effect of an unrelated bug fix.

---

## TLS / HTTPS
- Production cookies are set `secure: true` (HTTPS-only) — `routes/authEnhanced.js:29`.
- The app is served on HTTPS subdomains; the frontend never hard-codes `http://` for the API
  (base URL from `REACT_APP_BACKEND_URL`, `services/api.js:3`).
- The frontend health probe treats a wrong device clock / invalid TLS cert as a device-side
  connection failure and shows the safe message — `services/authDiagnostics.js:127`.
- **Preserve:** never downgrade a production cookie to non-secure; never introduce a plain-HTTP
  API base.

## CORS allowlist behaviour
- Allowed origins = `ALLOWED_ORIGINS` env **plus** the three hard-coded first-party web origins
  (`genzdigitalstore.com`, `www.`, `app.`) **plus** the StealthWriter gateway origin (from
  `STEALTH_GATEWAY_URL`) **plus** proxy-tools gateway origins (from `utils/proxy/tools.js`)
  **plus** any `chrome-extension://` origin **plus** no-Origin server-to-server calls.
  Everything else is logged and rejected — `server-crm.js:66-141`.
- `credentials: true` is required for the cookie-based auth to work.
- **Preserve:** the three first-party origins must stay allowed **in code** (a missing env entry
  must never CORS-block the site — this is exactly the `www.` regression that was fixed).
  `chrome-extension://` must stay allowed. Do not widen to `*` (incompatible with credentials).

## Cookie security
- Auth cookies are `httpOnly` (JS cannot read them), `path:'/'`, and in production
  `secure` + `sameSite:'none'` (cross-site app↔api) — `routes/authEnhanced.js:25-37`.
- Admin and client use **distinct cookie names** (`adminAccessToken`/`adminRefreshToken` vs
  `clientAccessToken`/`clientRefreshToken`) so both sessions coexist without contamination.
- **Preserve:** never make an auth cookie readable by JS; never merge the admin/client cookie
  namespaces; keep `sameSite:'none'`+`secure` in production (cross-subdomain requirement).

## Token validation & refresh behaviour
- Access token = JWT (`type:'access'`, 15m, `JWT_SECRET`), verified with a `type` check —
  `middleware/authEnhanced.js:37,110`.
- Refresh token = opaque random string; **only its SHA-256 hash** is stored in `refresh_tokens`
  — `middleware/authEnhanced.js:77,92`.
- Refresh is **rotating**: on use, the old row is revoked and `replacedByToken` set; a revoked
  token cannot be replayed (`isActive` false) — `routes/authEnhanced.js:342`.
- `tokenVersion` mismatch invalidates any access token (`TOKEN_VERSION_MISMATCH`) —
  `middleware/authEnhanced.js:184`; `User.forceLogout()` bumps it (used by password reset).
- The frontend silently refreshes on 401 with per-role in-flight queues and never retries
  login/refresh endpoints — `services/api.js:50`.
- **Preserve:** never store raw refresh tokens; keep rotation + revocation; keep the
  `tokenVersion` gate; keep login/refresh endpoints excluded from auto-retry.
- **Documented, do not "fix" incidentally:** the refresh token is intentionally not a JWT
  (`generateRefreshToken` is unused), and the DB `expiresAt` is hardcoded to now+7 days
  independent of the cookie lifetime (`routes/authEnhanced.js:89`). These are recorded facts —
  changing them is a separate decision, not a drive-by edit.

## Device binding
- Enforced only when `client.devicePolicy.enabled`. `DeviceProfile.resolve` groups browsers by
  physical machine; first device auto-approves; a new physical device is `pending`
  (`403 DEVICE_PENDING` + `SecurityAlert`); `blocked` → `403 DEVICE_BLOCKED` —
  `routes/authEnhanced.js:223-267`.
- On a device-resolve error the flow **fails open** (login allowed, logged loudly) because
  credentials already passed — `routes/authEnhanced.js:238-247`.
- The exact `code` values (`DEVICE_PENDING`, `DEVICE_BLOCKED`) are the contract the frontend
  sanitizer maps to human messages — `services/authDiagnostics.js:189-195`.
- **Preserve:** keep the fail-open-on-error behaviour; keep the exact codes; don't lock the
  admin path with device policy (admins have no device gate).

## Role-based access
- Admin routes require role ∈ `{ADMIN, SUPER_ADMIN, SUPPORT}` (`requireAdminAuth`,
  `middleware/authEnhanced.js:223`); client routes require exactly `CLIENT`
  (`requireClientAuth`, `:255`).
- Frontend `AdminRoute` re-checks role ∈ `{ADMIN, SUPER_ADMIN, SUPPORT}` and shows "Access
  Denied" otherwise — `components/AdminRoute.js:11`.
- Admin cookie ≠ client cookie ≠ endpoint, so a client session in the same browser cannot reach
  admin routes.
- **Preserve:** the two role sets and the cookie/endpoint isolation. `localStorage` user objects
  are display-only and must never become the access decision.

## Database integrity
- Every model is a JSON document in a table keyed by `id VARCHAR(32)`; queries always re-filter
  in JS after any SQL pushdown, and unknown operators fail closed —
  `db/mysqlAdapter.js` (`matchesQuery`, `_candidateRows`).
- Sensitive values are stored **hashed** (refresh tokens, extension/activation/open-intent
  tokens, device ids) or **AES-256-GCM encrypted** (proxy/stealth vault session bundles).
- Table/generated-column creation is idempotent and non-fatal — `ensureTables` /
  `ensureGeneratedColumns`.
- **Preserve:** never weaken the JS re-filter to trust raw SQL pushdown; never store a
  secret in plaintext where it is hashed/encrypted today; keep schema-ensure idempotent.

## API response contracts
- Success: `{ success: true, ... }` for auth; feature routes return their data JSON.
- Error: `res.status(N).json({ error, code? })`. Stable status semantics: `400` validation,
  `401` auth/credentials, `403` blocked/role, `409` exists, `429` rate-limited, `5xx` server.
- Validation errors: `{ error, message, details:[{field,message}] }` — `middleware/validation.js`.
- Health: `/api/crm/health` (deep DB ping, 200/503), `/health` + `/api/health` (liveness, 200,
  `no-store`).
- **Preserve:** the `{ error, code? }` shape and status semantics — the frontend sanitizer maps
  specific codes/statuses. Do not repurpose a status code or drop a `code` a screen depends on.

## Secure production error sanitization
- Members only ever see safe strings for API/auth/network failures — the single sanitizer
  `services/authDiagnostics.js` (`SAFE_GENERIC_MESSAGE`, `sanitizeError`). No API host,
  `[CODE]`, stack, or response body reaches the UI in production.
- Backend never returns a stack; production error message is the fixed `Internal server error`
  — `server-crm.js:407-409`. Auth logs are secret-free and email-masked.
- **Preserve:** all new member-facing error rendering must go through `sanitizeError`; never add
  a code path that prints the API host or an internal code to the screen.

## Development-only diagnostics
- `diagnosticsVisible()` is `true` only in a development build (`NODE_ENV==='development'`,
  inlined by CRA) — `services/authDiagnostics.js:151`. Production shows internals **never**,
  even with `?debug=1`.
- Verbose client logging is opt-in per device (`?debug=1` / `localStorage.genz_login_debug`) and
  goes to the console only. Backend verbose login diagnostics are gated by
  `DEBUG_LOGIN_DIAGNOSTICS`.
- The `X-Request-Id` / "Error ID" correlates a client report to secret-free server logs.
- **Preserve:** keep the production/development split; keep opt-in verbosity console-only;
  never surface diagnostics on screen in production.

## Existing working user flows (must keep working)
- Public marketing site on the main domain; portal on the app subdomain; the `domainGuard()`
  redirects and the two `.htaccess` files keep these separated without redirect loops.
- Emailed `reset-password` / `forgot-password` links open the SPA page (not bounced to login) —
  `App.js:32`, `frontend/app.htaccess`.
- Member-only `/extension` + `/chrome-extension` pages stay hard-gated behind `ClientRoute`.
- Admin and client can be logged in simultaneously in one browser.
- Silent token refresh keeps a member signed in across access-token expiry.
- Each gateway tool opens via a fresh lease; the identity/billing shield stays effective.
- The extension activates with a token, heartbeats `/tools`, shields supported hosts, and ends
  the shared session after 15 minutes idle.
- **Preserve:** any fix must leave all of the above working. Regression-test the ones adjacent
  to the change per `blast-radius-map.md`.

## Business CRM

Full set: [`../business-crm/README.md`](../business-crm/README.md). These are the CRM invariants;
most are test-enforced.

- **Two sources of truth, never blurred.** The existing website access system owns operational access
  (who has a tool, start, expiry, revoked/expired, access mode). The CRM owns financial data. The CRM
  mirrors access read-only and never writes a website table.
- **No financial field on any access screen.** No "Add to Business CRM" checkbox, no Sale Price,
  Currency, Purchase Cost, Vendor, Amount Received or Profit on Give Access, Assign Tool, Bulk Assign,
  proxy, StealthWriter or renewals.
- **A manual CRM sale grants nothing.** It creates no `ToolAssignment`, proxy client, stealth client,
  extension entitlement, gateway entitlement or portal access.
- **The CRM never writes the shared `users` table.** Account creation and password reset return
  HTTP 405 `CRM_USER_WRITE_DISABLED`.
- **Reconciliation is pull-only and idempotent.** `biz_crm_access_links.external_key` stays `UNIQUE`;
  a vanished source is marked `SOURCE_MISSING`, never deleted; financial linkage survives every run;
  the missing-record sweep is skipped if any source errored.
- **Schema changes are additive.** `CREATE TABLE IF NOT EXISTS` only; no `DROP`, `TRUNCATE` or
  `RENAME`; every `ALTER` targets `biz_crm_*`.
- **Money stays exact.** Integer minor units, at most two decimals, no float, and **no currency
  conversion** — PKR, INR and NGN totals are never summed. Round in SQL rather than loosening
  `money.js`.
- **Every CRM navigation target is absolute**, via `crmPath()`. The `path="*"` route renders a visible
  not-found page, never `<Navigate to=".">`.
- **One full text sidebar at any width.** Workspace mode stays gated on
  `location.pathname.startsWith('/admin/business')` so unrelated admin pages are untouched.
- **Service-worker scope stays `/admin/business/`, network-first, and never caches `/api/*`.** Every
  CRM response keeps `Cache-Control: private, no-store`.
- **No authentication material in browser storage.** The session lives only in `HttpOnly` cookies.
- **Preserve:** any CRM fix must leave all of the above true. `businessCrmIsolation.test.js`,
  `businessCrmRuntimeDefects.test.js` and `crmRouting.test.js` enforce most of them.
