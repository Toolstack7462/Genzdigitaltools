# ARCHITECTURE — Gen Z Digital Store (As-Built)

> **Purpose.** This is a strictly *as-built* architecture derived from the current
> repository code and configuration. It exists so that a future fix can change **only**
> the relevant component and leave every unrelated working flow untouched.
>
> **Verification.** Every statement below was checked against source files, imports,
> routes, middleware, env-var usage, package manifests, deploy scripts and `.htaccess`.
> Statements that cannot be verified from the repository are marked
> **Not verified from code**. No application code, configuration, dependency, deployment
> file, DNS, TLS, CORS, auth, database or infrastructure was modified to produce this doc.
>
> **Overall status: PARTIALLY VERIFIED.** All application code paths are verified from
> source. Runtime deployment details that live only on the Hostinger host (`.env`
> contents, hPanel `SetEnv` values, subdomain DNS/TLS, Passenger config) are known only
> from committed deploy scripts and READMEs — those are flagged as **Not verified from code**.

---

## 1. System overview

A multi-tenant "tool access" platform. An operator (admin) owns paid third-party AI-tool
accounts; clients (members) get time-boxed access to those tools **without ever seeing the
underlying credentials**. Access is delivered three ways:

1. **CRM assignments** — a client is assigned a `Tool` for a date range; the browser
   extension injects the operator's stored session into the real tool site.
2. **Proxy gateways** — for tools that must be brokered server-side (HIX, BypassGPT,
   StealthWriter, Grok, Claude, WriteHuman V2), a per-tool Node reverse proxy injects the
   operator's cookies server-side and shields identity/billing UI.
3. **Chrome extension** — an MV3 extension that authenticates with an extension token and
   performs credential/session injection + a UI "shield" on supported tool hosts.

### Top-level layout

| Path | Role |
|---|---|
| `frontend/` | React 19 SPA (CRA + CRACO). Public marketing site + admin panel + client portal. |
| `backend/` | Node/Express 5 API (`server-crm.js`). MySQL/MariaDB via a Mongoose-emulating adapter. |
| `proxy-gateway/` | Generic native-Node reverse-proxy engine (HIX / BypassGPT template). |
| `hix-gateway/`, `bypassgpt-gateway/` | Slimmer per-tool proxies derived from the engine. |
| `stealth-gateway/` | StealthWriter proxy (adds usage metering overlay). |
| `grok-gateway/`, `claude-gateway/` | Byte-identical copies of the generic engine, per tool. |
| `writehuman-v2/` | Standalone experimental WriteHuman clone (own JSON API + proxy + cookie-sync agent). |
| `chrome-extension/` | MV3 extension (background SW, content bridge, shield, login strategies). |
| `scripts/` | Build/util scripts (e.g. `build-extension.mjs`). |
| `deploy-*.sh`, `.github/workflows/` | Deployment automation (SFTP to Hostinger). |
| `docs/architecture/` | This documentation set. |

> **Deprecated/dead entries (verified):** `backend/server-crm-enhanced.js` is a 2-line
> shim (`module.exports = require('./server-crm')`). `backend/server.py`,
> `backend/Dockerfile*`, `backend/requirements.txt` are **not** part of the running Node
> service (the Passenger app runs `server-crm.js`). In the frontend, `*Enhanced` pages are
> the live ones; several non-enhanced siblings (e.g. `AdminLoginEnhanced` vs `AdminLogin`)
> exist — the routes in `App.js` are the source of truth for which render.

---

## 2. Frontend architecture (`frontend/`)

- **Stack:** React `^19`, `react-router-dom` `^7`, `axios`, Tailwind + Radix UI + shadcn-style
  components, built with **CRA `react-scripts` 5** wrapped by **CRACO** (`craco.config.js`).
  Package manager: yarn (`yarn.lock`) — CI uses `npm install --legacy-peer-deps`.
- **Entry:** `src/index.js` → `src/App.js`. Routing is all in `App.js` with `React.lazy`
  code-splitting; layout/guards/providers are eager.
- **Routing guard (client-side):** an IIFE `domainGuard()` at the top of `App.js:11` splits
  traffic by hostname — the **main domain** (`genzdigitalstore.com`, `www.`) serves the
  marketing site and bounces app paths to `app.genzdigitalstore.com`; the **app subdomain**
  serves the portal and bounces marketing paths to `/client/login`. It never touches
  `/api/`, static assets, or file paths, and guards against redirect loops.
- **Route guards (server-verified):**
  - `components/AdminRoute.js` — calls `GET /auth/admin/me`; requires role in
    `{ADMIN, SUPER_ADMIN, SUPPORT}`; renders "Access Denied" on wrong role, redirects to
    `/admin/login` when unauthenticated.
  - `components/ClientRoute.js` — calls `authService.verifyClientSession()`
    (`GET /auth/client/me`); redirects to `/client/login` when unauthenticated.
  - Guards render a spinner while checking; `localStorage` is display-only, **not** the
    security boundary (the cookie + server check is).
- **API layer:** `src/services/api.js` — one axios instance.
  - `getApiBaseUrl()` returns `${REACT_APP_BACKEND_URL}/api/crm` when that env points at a
    different, non-localhost origin, else same-origin `/api/crm`.
  - `withCredentials: true` (cookies ride every call).
  - **Response interceptor** does role-aware silent refresh on `401` (admin vs client vs
    generic), with per-role in-flight queues; on refresh failure it clears the role's
    localStorage key and hard-redirects to the correct login.
  - Safe failure logging only (method + path + status/`code`; never bodies/headers/tokens).
- **Service modules** (`src/services/`): `authService.js` (login/logout/session verify,
  device id/fingerprint), `authServiceEnhanced.js` (shim), `authDiagnostics.js` (the
  centralized error sanitizer — see §6), `assignmentsService.js`, `toolsService.js`,
  `stealthService.js`, `proxyToolsService.js`, `writeHumanV2Service.js`, `apiCache.js`,
  `apiEnhanced.js`.
- **Pages:** public (`src/pages/*` + `src/pages/public/*`), admin (`src/pages/admin/*`),
  client (`src/pages/client/*`). See §8 for panel responsibilities.
- **Cross-cutting:** `ErrorBoundary.js` wraps guarded routes; `observability.js` records
  the last 25 uncaught errors into `window.__APP_ERRORS__` (no network calls);
  `RouteSeo.js` + `seoConfig.js` manage per-route SEO; `ScrollToTop`, `ToastProvider`,
  `RefreshProvider` are eager providers.
- **Env:** the only runtime env var is `REACT_APP_BACKEND_URL` (from `frontend/.env.production`,
  inlined at build time by CRA). `NODE_ENV` is inlined by CRA and gates dev-only diagnostics.

---

## 3. Backend architecture (`backend/`)

- **Stack (pinned, no `^`):** Express `5.2.1`, `mysql2` `3.15.3`, `jsonwebtoken`, `bcryptjs`,
  `cookie-parser`, `cors`, `helmet`, `joi`, `express-rate-limit`, `dotenv`. Node.
- **Entry:** `server-crm.js` (Passenger startup file). Boot sequence:
  1. Load `.env`; **hard-fail** (`process.exit(1)`) if any of `JWT_SECRET`,
     `JWT_REFRESH_SECRET`, `COOKIES_ENCRYPTION_KEY` (64 hex), `DATABASE_URL`,
     `INITIAL_ADMIN_EMAIL`, `INITIAL_ADMIN_PASSWORD` is missing/too weak (`server-crm.js:16-48`).
  2. `app.set('trust proxy', 1)` (Hostinger reverse proxy).
  3. CORS (see §12), `helmet({ contentSecurityPolicy: false })`, `express.json({limit:'100kb'})`
     (raised per-route to `10mb` for tool/proxy cookie-bundle uploads), `cookieParser`,
     correlation-id middleware (`X-Request-Id`).
  4. Connect MySQL, `ensureTables()`, `bootstrapAdmin()` (creates the initial SUPER_ADMIN if
     none exist), start `stealthScheduler` + `proxyVerifyScheduler` (both no-ops unless enabled).
  5. `app.listen(PORT || CRM_PORT || 8002)`.
- **Route mounts** (`server-crm.js:271-354`) — all under `/api/crm`:
  - Auth: `/auth` (`authEnhanced.js` + `authEmail.js`).
  - Public: `/public`.
  - Extension: `/extension`.
  - Admin: `/admin/tools` (10mb), `/admin/clients`, `/admin/assignments`, `/admin/activity`,
    `/admin/analytics`, `/admin/activity-monitor`, `/admin/blog`, `/admin/contacts`,
    `/admin/reminders`, `/admin/announcements`, `/admin/renewals`, `/admin/offers`,
    `/admin/security-alerts`, `/admin/extension`, `/admin/stealth`, `/admin/proxy-tools`
    (10mb), `/admin/writehuman-v2` (256kb).
  - Client: `/client/tools`, `/client/assignments`, `/client/notifications`,
    `/client/extension`, `/client/presence` (mounted **before** the broad `/client` router),
    `/client/stealth`, `/client/proxy-tools`, `/client` (profile).
  - Gateways-facing: `/stealth/gateway`, `/proxy/gateway`, `/proxy/agent`.
  - Health: `/api/crm/health` (deep DB ping), `/health` + `/api/health` (liveness, no DB).
- **Global handlers (tail of `server-crm.js`):** the error handler never leaks stacks
  (generic message in production); the 404 handler logs only method+path.
- **Modules are isolated by design:** the StealthWriter, Proxy-Tools (HIX/BypassGPT),
  WriteHuman-V2, and Extension features are self-contained route+model+util trees, mounted
  additively. Each is **dormant** until its env vars are set (mounting changes nothing).

---

## 4. Database & data-access layer

- **Engine:** MySQL/MariaDB via `mysql2/promise` (connection pool).
- **Adapter:** `backend/db/mysqlAdapter.js` — a **Mongoose-emulating document store**. There
  is no ORM/schema in the SQL sense; every model is one table:
  `id VARCHAR(32) PK, data LONGTEXT (JSON), createdAt/updatedAt DATETIME(3)`
  (`mysqlAdapter.js:199-214`). Model→table names in `tableNames` (`mysqlAdapter.js:21-57`).
- **Query engine:** `matchesQuery` / `matchesOperator` implement a Mongo-like operator set
  (`$in,$nin,$ne,$exists,$gt,$gte,$lt,$lte,$regex,$options,$or,$and`). **Unknown operators
  fail closed.** SQL pushdown is limited to PK (`_id`) equality/`$in` and one indexed string
  field; results are always re-filtered in JS, so pushdown only narrows (never changes
  semantics).
- **Indexing:** hot string fields get a **VIRTUAL generated column** `gc_<field>`
  (`JSON_EXTRACT`) + index, added idempotently and non-fatally
  (`INDEXED_FIELDS`, `mysqlAdapter.js:64`). If unsupported, it silently falls back to a JSON
  scan.
- **Model API:** `createModel(name, {preSave, methods, statics})` returns a class exposing
  `find/findOne/findById` (chainable `Query` with `.sort/.skip/.limit/.select/.populate/.lean`),
  `create`, `countDocuments`, `distinct`, `findOneAndUpdate`, `updateMany`, `deleteMany`,
  `aggregate`. `Document` has `save()/toJSON()`. `_id` and Mongo-style ObjectId-length ids
  are emulated (`newId()` = 12 random bytes hex).
- **Connection resilience:** `runQuery` retries once on dead-connection errors; a 4-minute
  keep-alive ping runs; `ping()` executes a real `SELECT 1` (so `/api/crm/health` cannot
  report "connected" while queries fail).
- **Models (`backend/models/`):** see `docs/architecture/component-ownership.md` for the full
  table. Core: `User`, `Tool`, `ToolAssignment`, `RefreshToken`, `DeviceBinding`,
  `DeviceProfile`, `ActivityLog`, `SecurityAlert`, `ExtensionToken`, `ExtensionRelease`,
  `ExtensionScan`, `Blog`, `Contact`, `Announcement`, `Offer`, `Reminder`,
  `Renewal*`, `ClientPresence`, `EmailVerification`, `ActivationToken`, `OpenIntent`. Isolated
  modules: `models/proxy/{ProxyClient,ProxyAccount,ProxyLease}`,
  `models/stealth/{StealthClient,StealthAccount,StealthLease,StealthSettings,StealthUsageLog}`.
- **Encryption note (verified):** `backend/utils/encryption.js` is a **passthrough** — the
  `*Encrypted` fields for the CRM `Tool` session bundles store plain JSON now. Separate
  AES-256-GCM vault crypto is used by the isolated modules
  (`utils/proxy/vaultCrypto.js`, `utils/stealth/vaultCrypto.js`, keyed by `PROXY_VAULT_KEY`
  / `STEALTH_VAULT_KEY`). `COOKIES_ENCRYPTION_KEY` is still **hard-required at boot** even
  though `encryption.js` no longer uses it.

---

## 5. Authentication & authorization

- **Model:** stateless JWT **access** token (15m, `JWT_SECRET`) in an httpOnly cookie +
  opaque random **refresh** token (SHA-256 hash stored in `refresh_tokens`) in an httpOnly
  cookie. Passwords: bcrypt cost 12.
- **Role isolation via distinct cookies:** admin uses `adminAccessToken` /
  `adminRefreshToken`; client uses `clientAccessToken` / `clientRefreshToken`. Middleware is
  path-aware (`/api/crm/admin/*` reads the admin cookie, `/api/crm/client/*` the client
  cookie). The extension uses a Bearer header instead. This lets an admin and a client be
  logged in simultaneously in one browser without contamination.
- **Cookie flags** (`authEnhanced.js:25`): `httpOnly:true`, `path:'/'`, and in production
  `secure:true` + `sameSite:'none'` (cross-site: app on `app.` subdomain, API on `api.`
  subdomain). In development: `secure:false`, `sameSite:'lax'`.
- **Refresh rotation** (`authEnhanced.js:326`): the presented refresh token is looked up by
  hash; a new pair is issued; the old row is marked revoked + `replacedByToken`. A revoked
  token can't be replayed (`isActive` false).
- **Session invalidation:** every access token carries `tokenVersion`; the middleware rejects
  it (`401 TOKEN_VERSION_MISMATCH`) if it differs from the user's current `tokenVersion`.
  `User.forceLogout()` bumps `tokenVersion` (used by password reset).
- **Device binding** (client only, when `devicePolicy.enabled`): `DeviceProfile.resolve`
  groups browsers by physical machine (fingerprint hash of OS+screen+tz+cores). First device
  auto-approves; a new physical device is held `pending` (403 `DEVICE_PENDING`) and raises a
  `SecurityAlert`; a `blocked` device is 403 `DEVICE_BLOCKED`. **Fails open** on a resolve
  error (credentials already proved valid). Legacy `DeviceBinding` rows are kept in sync but
  are no longer the gate.
- **Roles:** `SUPER_ADMIN`, `ADMIN`, `SUPPORT` (admin panel), `CLIENT` (portal).
  `requireAdminAuth` allows the three admin roles; `requireClientAuth` requires exactly
  `CLIENT`. `User.isAdmin()` = `{SUPER_ADMIN, ADMIN}`.
- **Rate limiting:** `authLimiter` (15m/30, skips successful), `registerLimiter` (1h/3),
  keyed on the first `X-Forwarded-For` hop to avoid Hostinger shared-IP lockouts.

> **Verified discrepancies (documented, not fixed):**
> - The refresh token is an opaque random string, **not** a JWT; `generateRefreshToken`
>   (a JWT signer) is exported but unused, so `JWT_REFRESH_TOKEN_EXPIRY` is not applied.
> - The DB `expiresAt` for a refresh token is hardcoded to **now + 7 days**
>   (`authEnhanced.js:89`), independent of the cookie lifetime `REFRESH_MAX`
>   (`DASHBOARD_SESSION_DAYS||30` days) — a longer cookie can outlive its DB row.
> These are recorded so a future maintainer does not "discover" them as new bugs; changing
> them is out of scope for this as-built doc.

---

## 6. Centralized error-handling & sanitization flow

- **Frontend (member-facing):** `src/services/authDiagnostics.js` is **the single sanitizer**
  for every API/auth/network/timeout failure surfaced to a member.
  - `SAFE_GENERIC_MESSAGE` is the only string a production member ever sees for a
    transport/unknown failure — it carries no API host, no `[CODE]`, no stack, no body.
  - `sanitizeError(error, ctx)` returns `{ userMessage, devMessage, code, connection, detail }`.
    `userMessage` is always safe; `code`/`detail` are for the dev console + server-correlated
    logs only.
  - `diagnosticsVisible()` is `true` only in a **development** build (CRA inlines
    `NODE_ENV`), so the production bundle can never render internals on screen — even with
    `?debug=1`.
  - `classifyTransport` distinguishes offline / timeout / unreachable; `pingHealth()` probes
    `/api/crm/health` → `/api/health` → `/health` via raw `fetch` (no cookies, bypasses the
    interceptor).
  - `newRequestId()` creates the `X-Request-Id` correlation id shown to the user as "Error ID".
- **Backend:** the global error handler (`server-crm.js:396`) logs the full stack server-side
  and returns a generic `Internal server error` in production; the 404 handler logs only
  method+path. Auth routes log structured, **secret-free**, email-masked lines
  (`[auth:*]`, `[login-diag]`) gated by `DEBUG_LOGIN_DIAGNOSTICS`.
- **No shared backend error module:** handlers return `res.status(N).json({ error, code? })`
  ad-hoc; the sanitizer on the frontend is the contract that keeps members safe.

---

## 7. API request flow (summary)

`SPA page → services/*Service.js → axios (services/api.js) → https://api.genzdigitalstore.com/api/crm/... →
Express router → requireAuth/requireAdminAuth/requireClientAuth → handler → mysqlAdapter (models) → JSON`.
On `401`, the axios interceptor silently refreshes and replays. Full step-by-step traces
(login, refresh, logout, failures) are in `docs/architecture/request-flow.md`.

---

## 8. Admin, client & member panel responsibilities

- **Admin panel** (`/admin/*`, guarded by `AdminRoute`; API `/api/crm/admin/*` guarded by
  `requireAdminAuth`): tools CRUD + credential/session bundles (`AdminToolsEnhanced`,
  `AdminToolForm`), clients CRUD + device approval (`AdminClientsEnhanced`, `AdminClientForm`),
  assignments (`AdminAssignments`, `AdminBulkAssign`), renewals (`AdminRenewals`), marketing/
  offers/announcements/blog/contacts, analytics + activity monitor, security alerts, and the
  isolated tool consoles: `AdminStealthWriter`, `AdminProxyTools`, `AdminWriteHuman`,
  `AdminClaude`, plus extension release management (`AdminExtension`).
- **Client / member portal** (`/client/*`, guarded by `ClientRoute`; API `/api/crm/client/*`
  guarded by `requireClientAuth`): dashboard (`ClientDashboardEnhanced`), assigned tools
  (`ClientToolsEnhanced`, `ClientToolDetail`), StealthWriter (`ClientStealthWriter`), profile,
  activity, extension install guide. A member never receives raw tool credentials — access is
  brokered by the extension or a gateway.
- **Public site** (main domain): marketing pages, pricing, blog, contact, `login`/`join`
  (which bounce to the app subdomain), and the member-only `/extension` + `/chrome-extension`
  pages (hard-gated behind `ClientRoute`).

The "Enhanced" suffix marks the live implementation; `App.js` route table is authoritative.

---

## 9. Gateways & external integrations

All gateways are **dependency-free native-Node reverse proxies** (`http`/`https`/`crypto`),
one process per tool per subdomain, run under Passenger. Shared pattern: an HS256 **lease**
in a host-scoped cookie → local verify + backend `/validate` on HTML navigations → the
backend returns the operator's account cookie bundle → the gateway injects it **server-side**
(never to the browser) → an identity/billing **shield** redacts account UI → a Gen Z overlay
is injected.

| Gateway | Proxies | Backend base | Lease cookie / key envs | Status |
|---|---|---|---|---|
| `proxy-gateway/` | Generic engine (HIX/BypassGPT template) | `/proxy/gateway` | `pg_lease`; `LEASE_SECRET`=`PROXY_LEASE_SECRET`, `GATEWAY_KEY`=`PROXY_GATEWAY_KEY` | Engine/reference |
| `hix-gateway/` | `hix.ai` | `/proxy/gateway` | `pg_lease`; same | Live |
| `bypassgpt-gateway/` | `www.bypassgpt.ai` | `/proxy/gateway` | `pg_lease`; same | Live |
| `stealth-gateway/` | StealthWriter (`STEALTH_TARGET_ORIGIN`) | `/stealth/gateway` | `sw_lease`; `STEALTH_LEASE_SECRET`, `STEALTH_GATEWAY_KEY` | Live (usage-metered) |
| `grok-gateway/` | `grok.com` | `/proxy/gateway` (`tool=grok`) | `pg_lease` | **Unsupported** (CF datacenter-IP challenge) per README |
| `claude-gateway/` | `claude.ai` | `/proxy/gateway` (`tool=claude`) | `pg_lease` | Supported (verify-on-deploy) per README |
| `writehuman-v2/` | `writehuman.ai` | own `/v2/*` API | `pg_lease`; `WRITEHUMAN_V2_*` keys | Standalone experimental clone |

- **Backend↔gateway contract:** gateway → backend calls carry `x-gateway-key`; the gateway
  validates leases against `${API_BASE}/validate`. The backend endpoints live in
  `routes/proxy/gateway.js`, `routes/stealth/gateway.js`, `routes/proxy/agentSync.js`.
- **Proxy-tools registry:** `backend/utils/proxy/tools.js` is the single source of truth for
  which tools exist and each gateway's public origin (also read by the server's CORS
  allowlist, `server-crm.js:84`).
- **WriteHuman V2** additionally runs a live-browser **Cookie Sync Agent**
  (`writehuman-v2/agent/`) posting fresh cookies to `/v2/cookies/ingest`, and a Supabase
  refresh-token verifier. It is isolated from production and admin-gated (503 until
  `WRITEHUMAN_V2_ADMIN_KEY` is set).
- **Resend email** (`utils/email.js`) is the only outbound integration in the core backend;
  disabled gracefully when `RESEND_API_KEY`/`EMAIL_FROM` are unset.

---

## 10. Chrome extension flow (`chrome-extension/`)

- **Manifest:** MV3, name "Gen Z Digital Store Access", version **3.9.13**, pinned `key`
  (stable id). Permissions: `storage, alarms, cookies, tabs, scripting, notifications,
  management`; `host_permissions` include the three first-party origins, `hix.ai`, and broad
  `http/https://*/*`.
- **Dashboard bridge:** `js/bridge.js` (content script, ISOLATED world) runs only on the
  first-party origins; a postMessage bridge with an origin+type allowlist. It **strips every
  secret** (`credentials`, `sessionBundle`, `cookies`, `token`, `extensionToken`,
  refresh/access tokens) from any message returned to the page, and sets `data-genz-extension-*`
  DOM markers.
- **Backend auth:** `js/background.js` (service worker) calls
  `${base}/api/crm/extension/<endpoint>` with `Authorization: ExtToken <extensionToken>`,
  `X-Extension-Version`, `X-Device-Id-Hash`. Activation via
  `POST /extension/auth/activate` (activation token) or `/extension/auth` (email+password).
- **Endpoints used:** `/tools`, `/tools/:id/credentials`, `/tools/:id/opened`,
  `/tools/versions`, `/cleanup-manifest`, `/security-scan`, `/domains`, `/profile`
  (all under `/api/crm/extension`, guarded by `verifyExtensionToken` on the backend).
- **Injection & shield:** `js/shield.js` is injected into the real tool tab via
  `chrome.scripting.executeScript`; it hides account/logout/billing UI and blocks restricted
  URLs with a "managed account" popup on `SHIELD_HOSTS` (chatgpt.com, grok.com, hix.ai,
  bypassgpt.ai, ryne.ai, writehuman.ai). It never touches inputs/editor/captcha.
- **Session/idle:** 15-minute idle timeout on `IDLE_TIMEOUT_HOSTS` ends the shared session
  (clears cookies+storage, routes tabs to `expired.html`). Alarms drive a 15-minute sync
  heartbeat with backoff retry.
- **Login strategies:** `js/core/LoginOrchestrator.js` + `js/strategies/*`
  (Cookie/Form/Headers/OAuth/SSO/Token) perform the actual session injection per
  `js/config/toolConfigs.js`.
- **Release/update:** the `/tools` heartbeat returns `extensionUpdate` (installed/latest/
  minVersion/updateAvailable/updateRequired/downloadPath); the extension self-hosts its zip
  (rebuilt by `scripts/build-extension.mjs` into `frontend/{public,build}/downloads/...zip`
  during deploy). Backend models `ExtensionRelease` + utils `zipManifest`/`extensionDownloads`
  /`semver`. Signing key committed at repo root (`genz-extension-signing-key.pem`).

---

## 11. Production & development configuration

- **Production frontend** is served statically from Hostinger:
  - Main root `.../genzdigitalstore.com/public_html` (marketing) and app root
    `.../public_html/app` (portal). `.htaccess` differs per root (see §13).
  - API base baked from `frontend/.env.production` → `REACT_APP_BACKEND_URL`
    (`https://api.genzdigitalstore.com`).
- **Production backend** runs `server-crm.js` under Passenger at `api.genzdigitalstore.com`;
  config comes from a server-side `.env` (**Not verified from code** — value contents live on
  the host). `NODE_ENV=production` switches cookies to `secure`+`sameSite:none` and hides
  error internals.
- **Gateways** each run under Passenger on `*1.genzdigitalstore.com` with per-tool `SetEnv`
  in their `.htaccess` (**Not verified from code** — hPanel-managed).
- **Development:** `frontend` `craco start` (CRACO dev server has a health-endpoint plugin);
  `backend` `npm run dev` (nodemon `server-crm.js`) against a local/remote MySQL. In dev,
  cookies are `lax`/non-secure and error messages are verbose.

---

## 12. Security boundaries

- **CORS** (`server-crm.js:66-141`): explicit allowlist. Allowed = `ALLOWED_ORIGINS` env
  (comma list) **plus** three hard-coded first-party web origins (`genzdigitalstore.com`,
  `www.`, `app.`), plus the StealthWriter gateway origin (derived from `STEALTH_GATEWAY_URL`),
  plus the proxy-tools gateway origins (derived from `utils/proxy/tools.js`), plus any
  `chrome-extension://` origin, plus no-Origin server-to-server calls. Anything else is
  logged and rejected. `credentials: true`.
- **Auth cookies** are httpOnly (JS can't read them), `secure`+`sameSite:none` in production.
- **Token/secret hygiene:** refresh tokens stored only as SHA-256 hashes; extension tokens,
  activation tokens, open-intent tokens, device ids all stored hashed; leases are HS256 and
  short-lived (default 30 min). Vault cookie bundles for proxy/stealth are AES-256-GCM at rest.
- **Rate limiting** on auth/register endpoints (see §5).
- **Body limits:** global 100kb; only tool/proxy admin upload routes are raised to 10mb.
- **Startup guards:** the server refuses to boot with missing/weak security env vars.
- **Extension boundary:** the extension token in the `Authorization` header is the real
  auth boundary for `chrome-extension://` origins (which CORS allows); the bridge never
  exposes secrets to the page.
- **Error sanitization** (see §6) prevents leaking the API host, internal codes, or stacks to
  members.

---

## 13. Deployment & reverse-proxy structure

- **Host:** Hostinger shared host `147.79.103.253`, SFTP port `65002`, user `u171982351`.
  Node apps under Passenger/LiteSpeed, restarted by touching `tmp/restart.txt`.
- **Scripts:**
  - `deploy-hostinger.sh` — full three-phase deploy (backend file list → restart; rebuild
    extension zip; frontend build → both web roots; verify).
  - `deploy-backend.sh` + `deploy-lib.sh` — targeted, **SHA-256-verified** per-file backend
    uploads (`put_verified`) + restart + boot wait.
  - `deploy-frontend-only.sh` — frontend to both roots (main root gets `.htaccess`, app root
    never), with a live-bundle-hash verify.
  - `deploy-claude-gateway.sh` (and per-gateway equivalents) — upload `server.js` +
    `package.json` + `public/overlay.*` only, restart, verify `/__genz/health`.
  - Numerous `deploy-writehuman-*.sh` for the V2 module.
- **CI:** `.github/workflows/deploy-frontend.yml` — on push to `main` touching `frontend/**`:
  build, SFTP-mirror `frontend/build/` to both roots (single serial lftp connection, excludes
  `*.map`; app root also excludes `.htaccess`), then verify both live domains serve the built
  `main.<hash>.js`. Secret: `SFTP_PASSWORD`. **No workflow deploys the backend or gateways** —
  those are manual script runs.
- **Reverse proxy / `.htaccess`:**
  - Main root: serve files; redirect `/login`, `/client/*`, `/admin/*` to the app subdomain;
    SPA fallback to `/index.html`; `.html` no-cache.
  - App root (`frontend/app.htaccess`): portal only; `^api(/|$)` left to Passenger;
    `client|admin|reset-password|forgot-password` → `/index.html`; everything else → 302
    `/client/login`. Deploys never overwrite the app root's `.htaccess`.
- **Not verified from code:** DNS records, TLS certificate issuance, Passenger app config,
  hPanel `SetEnv` secret values, and server-side `.env` contents.

---

## 14. Dependency relationships & shared modules

**Highest-risk shared files (a change here can affect many flows — regression-test broadly):**

| File | Shared by | Why high-risk |
|---|---|---|
| `backend/server-crm.js` | Every backend route, CORS, health, error handling | Central wiring; a mistake breaks all APIs. |
| `backend/db/mysqlAdapter.js` | Every model & query in the backend | The entire data layer. |
| `backend/middleware/authEnhanced.js` | Every authenticated route + refresh | Token issue/verify, role gates. |
| `backend/routes/authEnhanced.js` | Admin+client login/refresh/logout/register | All session lifecycle. |
| `backend/models/User.js` | Auth, admin, client, extension, all modules | Central identity + roles. |
| `backend/middleware/{validation,normalize,rateLimiter}.js` | Auth + admin CRUD | Input contract + abuse protection. |
| `backend/utils/proxy/tools.js` | Proxy gateways + server CORS | Registry + allowlist derivation. |
| `frontend/src/services/api.js` | Every FE API call | Base URL, refresh, failure logging. |
| `frontend/src/services/authService.js` | All login/logout/session checks | Session lifecycle on the client. |
| `frontend/src/services/authDiagnostics.js` | Every member-facing error string | The sanitizer — leak risk if wrong. |
| `frontend/src/App.js` | All routing + domain guard | Route table + host redirects. |
| `frontend/src/components/{AdminRoute,ClientRoute}.js` | All guarded pages | Access gating. |
| Gateway `server.js` (per tool) | That tool's entire proxy flow | Injection, shield, lease. |
| `chrome-extension/js/background.js` | Whole extension runtime | 3.4k-line service worker. |

Full per-component dependency and blast-radius detail:
- `docs/architecture/component-ownership.md`
- `docs/architecture/blast-radius-map.md`
- `docs/architecture/change-boundaries.md`
- `docs/architecture/request-flow.md`
- `docs/architecture/system-diagram.md`
- `docs/architecture/protected-invariants.md`
- `docs/architecture/targeted-fix-protocol.md`
- `docs/architecture/architecture-index.md`

---

## 15. Verification status

- **Frontend, backend, auth, data layer, extension, gateways (code):** **Verified from code.**
- **Deployment mechanics (scripts, CI, `.htaccess`):** **Verified from code** (the committed
  scripts/workflow/htaccess).
- **Live runtime infra** (DNS, TLS, `.env`/`SetEnv` values, Passenger config, subdomain
  wiring, RDP/`windows-service` runtime for the V2 sync agent): **Not verified from code.**

**No source file was modified in producing this documentation.**

---

## Business CRM (additive module)

The Business CRM is documented separately and in full: **[`docs/business-crm/README.md`](docs/business-crm/README.md)**.

Summary of how it fits this architecture:

- **One login.** It is a workspace inside this admin application at `/admin/business/*`, reusing
  `AdminRoute`, `AdminLayoutEnhanced`, the shared axios client and the existing `requireAdminAuth`
  middleware. No second login, cookie, token system or user table.
- **One API mount.** `/api/crm/admin/business/*`, added with a single `require` and a single `app.use`
  in `backend/server-crm.js`.
- **Its own tables only.** 21 `biz_crm_*` tables, plus its own `mysql2` pool over the same
  `DATABASE_URL`. It writes nothing else.
- **Two sources of truth.** The existing website access system owns operational access; the CRM owns
  financial data. The CRM mirrors access **read-only** and never writes a website table, and no
  financial field appears on Give Access or any assignment screen.
- **Failure isolation.** No existing website route calls the CRM, so a CRM fault cannot affect
  assignment creation or client access.

Key documents: [`architecture`](docs/business-crm/architecture.md) ·
[`data-model`](docs/business-crm/data-model.md) ·
[`api-reference`](docs/business-crm/api-reference.md) ·
[`rbac-matrix`](docs/business-crm/rbac-matrix.md) ·
[`website-access-bridge`](docs/business-crm/website-access-bridge.md) ·
[`troubleshooting`](docs/business-crm/troubleshooting.md) ·
[`operations-runbook`](docs/business-crm/operations-runbook.md) ·
[`known-issues`](docs/business-crm/known-issues.md)

**No source file was modified in producing that documentation either.**
