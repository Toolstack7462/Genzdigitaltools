# Blast-Radius Map (As-Built)

> For each important shared module: what a change can break, and what to test afterward.
> Verified from code. Use together with `change-boundaries.md`.

---

## `backend/db/mysqlAdapter.js` — the data layer
- **Affected screens:** every admin and client page that loads data (all of them).
- **Affected API routes:** every `/api/crm/**` route (all read/write go through it).
- **Affected auth flows:** all — user lookup, refresh-token store, device profiles.
- **Affected roles:** SUPER_ADMIN, ADMIN, SUPPORT, CLIENT, extension.
- **Affected prod config:** `DATABASE_URL`/`MYSQL_URL`, `MYSQL_CONNECTION_LIMIT`.
- **Regression risks:** query-operator semantics (fail-closed on unknown ops), SQL pushdown
  narrowing vs JS re-filter, generated-column indexing, connection-retry, date hydration,
  `_id`/ObjectId emulation.
- **Mandatory tests:** `cd backend && npm test` (adapter populate/pushdown/index-count +
  semver + renewalWindow suites); then smoke: admin login, client login, load
  clients/tools/assignments, one `create` and one `findOneAndUpdate`.

## `backend/middleware/authEnhanced.js` — token/cookie/role core
- **Affected screens:** every guarded page (login state, refresh, redirect-to-login).
- **Affected API routes:** every authenticated route (admin/*, client/*, extension, gateways).
- **Affected auth flows:** access-token verify, refresh issuance, role gating,
  `TOKEN_VERSION_MISMATCH`, device-id hashing use.
- **Affected roles:** all.
- **Affected prod config:** `JWT_SECRET`, `JWT_REFRESH_SECRET`, `JWT_ACCESS_TOKEN_EXPIRY`,
  `COOKIES_ENCRYPTION_KEY`.
- **Regression risks:** path-aware cookie selection (admin vs client), Bearer fallback for the
  extension, `secure`/`sameSite` behavior, refresh-hash storage, silent session invalidation.
- **Mandatory tests:** admin+client login, `/auth/*/me`, silent refresh (expire access, verify
  replay), logout revoke, disabled-account 403, wrong-role 403, extension Bearer call.

## `backend/routes/authEnhanced.js` — session lifecycle
- **Affected screens:** all login screens, dashboards on first load, silent-refresh recovery.
- **Affected API routes:** `/auth/admin/*`, `/auth/client/*`, `/auth/refresh`, `/auth/logout`,
  `/auth/register`, `/auth/*/me`.
- **Affected auth flows:** email matching (case/whitespace tolerance), duplicate-row handling,
  device-policy enforcement, cookie set/clear, refresh rotation.
- **Affected roles:** admin roles + CLIENT.
- **Affected prod config:** `DASHBOARD_SESSION_DAYS`, `DEBUG_LOGIN_DIAGNOSTICS`.
- **Regression risks:** a valid client with a legacy/mixed-case or duplicate row must still log
  in; device-pending/blocked must return the exact `code` the sanitizer maps; fire-and-forget
  post-login writes must not block the response.
- **Mandatory tests:** login with lowercase + mixed-case email; device-enabled client new
  device → `DEVICE_PENDING`; refresh rotation revokes old token; logout clears both cookies.

## `backend/models/User.js` — identity + roles
- **Affected screens:** everything requiring a user (all authed pages, admin client mgmt).
- **Affected API routes:** auth, `/admin/clients*`, extension activation.
- **Affected auth flows:** password hashing (bcrypt 12), `comparePassword`, `forceLogout`
  (tokenVersion bump), `isAdmin`, `toJSON` (strips secrets).
- **Affected roles:** all.
- **Regression risks:** email lowercasing pre-save; `toJSON` must never expose `passwordHash`/
  `tokenVersion`; `forceLogout` must invalidate existing sessions.
- **Mandatory tests:** register → login; password reset → old session rejected; admin list
  never returns password hashes.

## `backend/middleware/{validation,normalize,rateLimiter}.js` — input/abuse contract
- **Affected screens:** login/register forms; admin create/update forms (tools, clients,
  assignments).
- **Affected API routes:** auth + admin CRUD that use `validate(schemas.*)`.
- **Affected auth flows:** login normalization (email trim/lowercase before validation);
  auth/register rate limits.
- **Affected prod config:** `RATE_LIMIT_WINDOW_MS`, `RATE_LIMIT_MAX_REQUESTS`.
- **Regression risks:** `normalizeAuthInputs` must run **before** `validate`; a stricter schema
  can reject previously-valid payloads; rate-limit key uses first `X-Forwarded-For` hop
  (Hostinger shared-IP fix) — changing it can lock out or under-protect.
- **Mandatory tests:** valid + invalid login/register payloads; 30 rapid logins → 429; a
  shared-CDN-IP scenario still lets distinct users in.

## `backend/utils/proxy/tools.js` — proxy registry + CORS source
- **Affected screens:** admin proxy consoles, client tool-open for HIX/BypassGPT/Grok/Claude.
- **Affected API routes:** `/api/crm/proxy/gateway/*`; also the server CORS allowlist derives
  gateway origins from here (`server-crm.js:84`).
- **Affected auth flows:** none directly, but a wrong origin here breaks gateway CORS.
- **Regression risks:** removing/renaming a tool key drops it from CORS and the console.
- **Mandatory tests:** CORS preflight from each gateway origin; open each proxy tool.

## `backend/server-crm.js` — app wiring
- **Affected screens/routes:** all (CORS, mounts, health, error boundary).
- **Affected auth flows:** all (CORS credentials, cookie parsing).
- **Affected prod config:** `ALLOWED_ORIGINS`, `NODE_ENV`, `PORT`/`CRM_PORT`, all boot-required
  secrets.
- **Regression risks:** mount-order dependency (`/client/presence` before `/client`); per-route
  body limits (10mb tool/proxy uploads); first-party origin list.
- **Mandatory tests:** health (`/api/crm/health` 200, `/health` 200), one call per mounted
  router, a blocked-origin preflight is rejected, an allowed-origin preflight passes.

## `frontend/src/services/api.js` — axios core
- **Affected screens:** every page that calls the API.
- **Affected API routes:** all (base URL + interceptor).
- **Affected auth flows:** silent 401 refresh + replay; redirect-to-login on refresh failure.
- **Affected prod config:** `REACT_APP_BACKEND_URL`.
- **Regression risks:** admin vs client refresh routing; the in-flight queue must not
  double-refresh; login/refresh endpoints must be excluded from retry; `withCredentials` must
  stay true or cookies stop flowing.
- **Mandatory tests:** load an authed page after access-token expiry (auto-refresh works);
  invalid refresh → correct login redirect; a non-401 error surfaces normally.

## `frontend/src/services/authDiagnostics.js` — the sanitizer
- **Affected screens:** `Login`, `ClientLogin`, `AdminLogin`, `Join`, `ClientDashboardEnhanced`.
- **Affected auth flows:** every member-facing auth error.
- **Affected prod config:** `NODE_ENV` (gates `diagnosticsVisible`).
- **Regression risks:** a change that lets a host/`[CODE]`/stack/body reach `userMessage`; a
  production build must never render internals even with `?debug=1`.
- **Mandatory tests:** offline login (see `SAFE_GENERIC_MESSAGE`, no host/code on screen); 401
  → "Incorrect email or password"; 429 → "Too many attempts"; `DEVICE_PENDING` → device
  message; production build shows only safe strings.

## `frontend/src/App.js` + `AdminRoute.js` / `ClientRoute.js` — routing & guards
- **Affected screens:** all routes; host redirects.
- **Affected auth flows:** guard checks (`/auth/*/me`), unauthorized redirects, "Access Denied".
- **Affected roles:** admin (role set) + client.
- **Regression risks:** `domainGuard()` redirect loops; a guarded route accidentally made
  public (or vice versa); email-link pages (`reset-password`/`forgot-password`) must not be
  bounced.
- **Mandatory tests:** anonymous hits `/client/dashboard` → `/client/login`; wrong-role hits
  `/admin/*` → Access Denied; `reset-password?token=` opens on the app subdomain; main-domain
  `/login` bounces to `app.` `/client/login`.

## Gateway `server.js` (per tool) — one tool's proxy
- **Affected screens:** only that tool's open/use in the client portal + its admin console.
- **Affected API routes:** `/proxy/gateway/*` or `/stealth/gateway/*` for that tool.
- **Affected auth flows:** lease verify + `x-gateway-key`; no CRM session impact.
- **Affected roles:** clients granted that tool; operator (vault).
- **Affected prod config:** that gateway's `*_LEASE_SECRET` + `*_GATEWAY_KEY` (must match the
  backend), `*_TARGET_ORIGIN`, `*_DEFAULT_PATH`, `HIDE_SELECTORS`, CF challenge flags.
- **Regression risks:** shield selectors drifting (identity leak), header stripping breaking
  the tool, lease/key mismatch → all opens 403; a change to the generic engine affects every
  byte-identical copy if propagated.
- **Mandatory tests:** open the tool with a fresh lease (loads), verify `/__genz/health` 200
  and `/` 403 without a lease, confirm account/billing UI stays hidden, confirm the tool's core
  function still works.

## `chrome-extension/js/background.js` (+ `bridge.js`, `shield.js`)
- **Affected screens:** the dashboard extension banner/status; every shielded tool tab.
- **Affected API routes:** `/api/crm/extension/*`.
- **Affected auth flows:** extension-token activation + `ExtToken` Bearer auth; idle session end.
- **Affected roles:** clients using the extension.
- **Affected prod config:** `EXTENSION_TOKEN_DAYS`, `EXTENSION_DOWNLOAD_DIRS`,
  `ENABLE_EXTENSION_DEBUG_LOGS`; manifest version + pinned `key`.
- **Regression risks:** secret-stripping in the bridge, shield host list, 15-min idle logic,
  update-required gating, MV3 service-worker lifecycle.
- **Mandatory tests:** activate → `/tools` heartbeat; open a shielded tool (account UI hidden,
  editor/captcha untouched); idle 15 min → expired page; update-info reflected on the dashboard.

## Deployment (`deploy-*.sh`, `.github/workflows/deploy-frontend.yml`, `.htaccess`)
- **Affected screens:** all (a bad deploy can stale a whole surface).
- **Affected API routes:** all (backend restart) or none (frontend-only).
- **Regression risks:** uploading to the wrong root (app vs main), overwriting the app root
  `.htaccess`, partial multi-file transfer (why `deploy-backend.sh` verifies SHA-256), not
  restarting Passenger.
- **Mandatory tests:** post-deploy live-bundle-hash check on both domains (the workflow already
  does this); `/api/crm/health` 200 after a backend deploy; a gateway `/__genz/health` 200
  after a gateway deploy.
