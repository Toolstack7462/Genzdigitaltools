# Request-Flow Traces (As-Built)

> Verified against the current code. Each step cites the exact file and function.
> Anything not confirmable from the repository is marked **Not verified from code**.
> Do not treat these traces as a redesign — they document what the code does today.

Legend: FE = frontend (`frontend/src`), BE = backend (`backend`).

---

## 1. Client login

1. **FE** `pages/client/ClientLogin.js` (also `ClientLoginEnhanced.js`) submit handler builds a request id via `newRequestId()` and gathers device data from `authService.getOrCreateDeviceId()` / `getDeviceFingerprint()` / `getDeviceInfo()` — `services/authService.js:190,234,252`.
2. **FE** `authService.clientLogin(email, password, deviceId, extra, requestId)` — `services/authService.js:57`. Calls `postWithRetry('/auth/client/login', …, { timeout: 30000, headers: { 'X-Request-Id' } })` — `authService.js:14,62`. Retries only on no-response / 502-503-504, never on a real 401 or a timeout.
3. **FE** axios instance `services/api.js:17` — `baseURL` from `getApiBaseUrl()` (`REACT_APP_BACKEND_URL` + `/api/crm`, else same-origin `/api/crm`), `withCredentials: true`.
4. **BE** `POST /api/crm/auth/client/login` — mounted `server-crm.js:313`, handler `routes/authEnhanced.js:166`. Middleware order: `authLimiter` → `normalizeAuthInputs` → `validate(schemas.clientLogin)`.
5. **BE** `User.find({ email: emailMatch(email), role: /^CLIENT$/i })` — `authEnhanced.js:187`. `emailMatch` (`authEnhanced.js:52`) is anchored, case-insensitive, whitespace-tolerant so migrated/mixed-case rows resolve. All duplicate candidates are returned.
6. **BE** Loop candidates, `c.comparePassword(password)` (bcrypt) — `authEnhanced.js:203`. First match wins → `401 Invalid credentials` if none match; `403` if `status==='disabled'`.
7. **BE** If `client.devicePolicy.enabled`: `DeviceProfile.resolve(...)` — `authEnhanced.js:230`. `blocked`→`403 DEVICE_BLOCKED`; `pending`→`403 DEVICE_PENDING` + `SecurityAlert.raise('NEW_DEVICE')`; approved → upsert legacy `DeviceBinding`. On resolve error it **fails open** (allows login).
8. **BE** `generateTokenPair(client, ip)` — `middleware/authEnhanced.js:84`. Access = JWT (`JWT_SECRET`, 15m). Refresh = opaque `crypto.randomBytes(64)` hex; only its SHA-256 hash is stored in `RefreshToken` (`authEnhanced.js:92-99`). Token errors return `500 TOKEN_ERROR` (`authEnhanced.js:295`).
9. **BE** Set cookies `clientAccessToken` (`ACCESS_MAX` 15m) + `clientRefreshToken` (`REFRESH_MAX` = `DASHBOARD_SESSION_DAYS||30` days) with `COOKIE_OPTS` (`httpOnly`, `secure`+`sameSite:'none'` in production) — `authEnhanced.js:300`. Respond `{ success:true, user }`. Presence + last-login writes run **after** the response (fire-and-forget).
10. **FE** On `data.success`, cache display-only user in `localStorage['genz_client_user']` — `authService.js:63`. Navigate to `/client/dashboard`.

## 2. Admin login

1. **FE** `pages/admin/AdminLogin.js` / `AdminLoginEnhanced.js` → `authService.adminLogin(email, password, requestId)` — `authService.js:40`. `postWithRetry('/auth/admin/login', …, { timeout: 30000 })`.
2. **BE** `POST /api/crm/auth/admin/login` — `authEnhanced.js:114`. `authLimiter` → `normalizeAuthInputs` → `validate(schemas.adminLogin)`.
3. **BE** `User.findOne({ email: emailMatch(email), role: {$in:['SUPER_ADMIN','ADMIN','SUPPORT']} })` — `authEnhanced.js:123`. `401` if none, `403` if disabled, `comparePassword` → `401` if invalid.
4. **BE** `generateTokenPair(admin, ip)` → set `adminAccessToken` + `adminRefreshToken` cookies — `authEnhanced.js:152`. No device-policy check on the admin path.
5. **FE** cache `localStorage['genz_admin_user']` (`authService.js:50`), navigate to `/admin/dashboard`.

Admin and client use **separate cookie names and separate localStorage keys**, so both sessions can coexist in one browser without contamination.

## 3. Registration / Join flow

1. **FE** `pages/Join.js` (routes `/join`, `/client/signup`, `/client/register` — `App.js:175,178,179`) collects name/email/password and posts through the auth service.
2. **BE** `POST /api/crm/auth/register` — `authEnhanced.js:455`. `registerLimiter` (1 hr / 3) → `validate(schemas.register)` (password ≥ 8, upper+lower+digit).
3. **BE** `User.findOne({ email })` → `400` if exists. `User.create({ ..., role:'CLIENT', status:'active', devicePolicy:{ enabled:true, maxDevices:1 } })` — `authEnhanced.js:463`. Password hashed by the `User` pre-save hook (bcrypt cost 12).
4. **BE** `ActivityLog.log('SYSTEM', null, 'CLIENT_REGISTERED', …)` → `201 { success:true }`.
5. **Email verification (additive)**: `routes/authEmail.js` — `POST /verify-email`, `/resend-verification`. Emails are only sent when Resend is configured (`RESEND_API_KEY` + `EMAIL_FROM`); otherwise silently skipped (`utils/email.js` `isEmailEnabled()`).

## 4. Member (client) panel loading

1. **FE** Route `/client/dashboard` is wrapped `<ErrorBoundary><ClientRoute><ClientDashboardEnhanced/></ClientRoute></ErrorBoundary>` — `App.js:219`.
2. **FE** `components/ClientRoute.js:19` calls `authService.verifyClientSession()` → `GET /auth/client/me`.
3. **BE** `GET /api/crm/auth/client/me` — `authEnhanced.js:437`, guarded by `requireClientAuth` (reads `clientAccessToken` cookie only, requires `role==='CLIENT'`, checks `tokenVersion`).
4. **FE** On success → render children. On failure → `<Navigate to="/client/login">`. While checking, a spinner renders (`ClientRoute.js:34`).
5. **FE** `ClientDashboardEnhanced.js` then loads data via the service layer (`assignmentsService.js`, `toolsService.js`, `stealthService.js`, `proxyToolsService.js`) — each hitting `/api/crm/client/*`. The domain guard in `App.js:11` keeps the portal on `app.genzdigitalstore.com`.

## 5. Authenticated API request (steady state)

1. **FE** Any page calls `api.get/post('/client/…' | '/admin/…')` — `services/api.js`. Cookies ride automatically (`withCredentials`).
2. **BE** The route's router applies `requireAuth` / `requireAdminAuth` / `requireClientAuth` (`middleware/authEnhanced.js`). Path-aware cookie selection: `/api/crm/admin/*`→`adminAccessToken`, `/api/crm/client/*`→`clientAccessToken`, else Bearer header (extension) or legacy `accessToken`.
3. **BE** `verifyAccessToken` → `User.findById(decoded.userId).select('-passwordHash')` → `403` if disabled → `401 TOKEN_VERSION_MISMATCH` if `decoded.tokenVersion !== user.tokenVersion` → attach `req.user`/`req.userId`/`req.userRole`.
4. **BE** Handler runs, returns `{...}` JSON or `res.status(N).json({ error, code? })`.

## 6. Token refresh (silent, on 401)

1. **FE** Response interceptor `services/api.js:50`. On a `401` that is not a login/refresh endpoint and not already `_retry`, it routes by path:
   - Admin path (`isAdminPath`) → `POST /auth/admin/refresh`, replay original request; concurrent 401s queue on `adminFailedQueue` (`api.js:91-111`).
   - Client path (`isClientPath`) → `POST /auth/client/refresh`, replay; queue `clientFailedQueue` (`api.js:114-134`).
   - Generic fallback → `POST /auth/refresh` (`api.js:139`).
2. **BE** `handleRefresh(...)` — `authEnhanced.js:326`. Reads the refresh cookie → `hashToken` → `RefreshToken.findOne({ token: hash })` → `401` if missing/inactive. Issues a new pair and **rotates**: old row gets `revokedAt`/`revokedByIp`/`replacedByToken` (`authEnhanced.js:342-345`). New cookies set.
3. **FE** On refresh success the original request is retried transparently. On refresh failure: clear the relevant localStorage key and `window.location.href = '/admin/login' | '/client/login'` (`api.js:105-107,128-130`).

## 7. Logout

1. **FE** `authService.adminLogout()` / `clientLogout()` — `authService.js:71,82`. `POST /auth/admin/logout` | `/auth/client/logout`; the `finally` block always removes the localStorage user key even if the network call fails.
2. **BE** `handleLogout(...)` — `authEnhanced.js:382`. `RefreshToken.revokeToken(hashToken(token), ip)`, `ActivityLog.log(... 'LOGOUT')`, client presence → `logout`, then `res.clearCookie` for both access + refresh cookies (`CLEAR_OPTS`). Guarded by `requireAdminAuth` / `requireClientAuth`.

## 8. API connection failure (no HTTP response)

1. **FE** axios rejects with `error.request` set and no `error.response` (network/DNS/CORS/TLS/offline/timeout).
2. **FE** `services/api.js:69` logs a safe one-liner (`METHOD path → no response (network/CORS/server down)`) — no bodies/headers/tokens.
3. **FE** The login/signup caller passes the error to `sanitizeError(error, ctx)` — `services/authDiagnostics.js:174`. `classifyTransport` (`authDiagnostics.js:102`) returns `API_CONNECTION_FAILED` (offline/unreachable) or `TIMEOUT`. The **user sees `SAFE_GENERIC_MESSAGE`** (`authDiagnostics.js:9`) — never a host, `[CODE]`, or troubleshooting steps in production.
4. **FE** The login screens may run `pingHealth()` (`authDiagnostics.js:56`) against `/api/crm/health`, `/api/health`, `/health` via raw `fetch` (no cookies, bypasses the interceptor) to distinguish "API unreachable from this device" from a transient blip.

## 9. Raw server error (unhandled exception in a route)

1. **BE** An unhandled throw reaches the global error handler `server-crm.js:396`. It `console.error('Unhandled error', err)` (full stack server-side), maps `ValidationError`→`400`, Mongo/adapter/`ECONNREFUSED`→`500 { error:'Database error' }`, else `res.status(err.status||500)`.
2. **BE** The client-facing `error` string is the real message **only when `NODE_ENV !== 'production'`**; in production it is the fixed `'Internal server error'` (`server-crm.js:407-409`). No stack is ever sent to the client.
3. **BE** A missing route hits the 404 handler `server-crm.js:418`: logs `[404] Route not found: METHOD path` (path only, no query/body/headers) and returns `{ error:'Route not found', method, path }`.

## 10. Sanitized production error (member-facing)

1. **BE** produces a generic `{ error }` (± machine `code`) — see traces 8/9. Business codes that are safe to surface: `DEVICE_PENDING`, `DEVICE_BLOCKED`, `DEVICE_MISMATCH`, plus HTTP `401/409/429`.
2. **FE** `sanitizeError` (`authDiagnostics.js:174`) maps them to human strings:
   - transport → `SAFE_GENERIC_MESSAGE`
   - `DEVICE_PENDING` → "New device detected…"
   - `DEVICE_BLOCKED`/`DEVICE_MISMATCH` → "This device is not approved…"
   - `401` → "Incorrect email or password."
   - `409` → "An account with this email already exists."
   - `429` → "Too many attempts…"
   - everything else (400/403/404/5xx) → `SAFE_GENERIC_MESSAGE`
3. **FE** `diagnosticsVisible()` (`authDiagnostics.js:151`) is `true` **only** for a development build (`NODE_ENV==='development'`, inlined by CRA at build time). Production members always see the safe string on screen; rich (still secret-free) detail stays in the dev console / `collectClientDiag` and correlates to backend logs via the shared `X-Request-Id` / Error ID.

## Business CRM request flow

Diagrams: [`../business-crm/system-diagrams.md`](../business-crm/system-diagrams.md).

**Workspace load**

1. `/admin/business` → `AdminRoute` calls `GET /api/crm/auth/admin/me` (existing endpoint, admin
   cookies attached by the browser). Role must be `ADMIN`, `SUPER_ADMIN` or `SUPPORT`.
2. `AdminBusinessCrm` renders inside `AdminLayoutEnhanced`; `BusinessCrmProvider` calls
   `GET /api/crm/admin/business/bootstrap`.
3. That request passes `requireAdminAuth`, then `ensureSchema()`, then `resolveAccess()` which maps the
   auth role to a business role and applies `biz_crm_user_access` plus overrides.
4. The response carries the resolved permission list, the currency list, settings and a **CSRF token**.
5. Every later CRM request sends `x-business-csrf-token` and is rate-limited to 240/min per user.

**Website access reconciliation** — CRM-initiated only. `POST /access-links/reconcile` reads
`ToolAssignment` and `buildProxyAssignmentDTOs()`, upserts `biz_crm_access_links` by `external_key`,
and returns 200 even when partial. No existing website route ever calls the CRM.

**Failure shape:** a CRM 5xx returns a generic `Business CRM request failed` with a request id; the
stack is logged server-side only. Read the log at
`~/domains/api.genzdigitalstore.com/hbuilds/current/nodejs/console.log`.
