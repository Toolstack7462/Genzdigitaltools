# Component Ownership (As-Built)

> One row per major component. "Security-sensitive" = touches auth, tokens, cookies, CORS,
> secrets, or access control. "Multi-flow" = a change here can affect more than one user flow.
> Verified from code; infra-only facts are marked **Not verified from code**.

---

## Backend — core

### `server-crm.js` (production entry)
- **Responsibility:** boot validation, CORS, security headers, body limits, correlation id,
  DB connect + table ensure + admin bootstrap, route mounting, health endpoints, global error
  + 404 handlers, graceful shutdown.
- **Source:** `backend/server-crm.js` (`server-crm-enhanced.js` is a shim to it).
- **Depends on:** `db/mysqlAdapter`, all route modules, `models/User`, `cron/*`,
  `utils/proxy/tools`, `helmet/cors/cookie-parser`.
- **Depended on by:** the entire backend (it is the app).
- **Reads/writes:** starts DB; bootstraps `users`.
- **Security-sensitive:** **Yes** (CORS, helmet, boot secret validation). **Multi-flow:** Yes.

### `db/mysqlAdapter.js` (data-access layer)
- **Responsibility:** Mongoose-emulating document store over MySQL; connection pool; table +
  generated-column ensure; query engine; `createModel`.
- **Source:** `backend/db/mysqlAdapter.js`.
- **Depends on:** `mysql2/promise`, `DATABASE_URL`/`MYSQL_URL`.
- **Depended on by:** every model.
- **Reads/writes:** all tables.
- **Security-sensitive:** Yes (query correctness = access correctness). **Multi-flow:** Yes.

### `middleware/authEnhanced.js`
- **Responsibility:** JWT access-token sign/verify, opaque refresh-token generation +
  hashing + DB persistence (`generateTokenPair`), `requireAuth` / `requireAdminAuth` /
  `requireClientAuth` / `requireRole` / `requireAdmin`, `getClientIp`.
- **Source:** `backend/middleware/authEnhanced.js`.
- **Depends on:** `jsonwebtoken`, `models/User`, `models/RefreshToken`, env `JWT_SECRET`,
  `JWT_REFRESH_SECRET`, `COOKIES_ENCRYPTION_KEY`, `JWT_ACCESS_TOKEN_EXPIRY`.
- **Depended on by:** every authenticated route (auth, admin/*, client/*, extension, gateways).
- **Reads/writes:** `refresh_tokens` (create); `users` (read).
- **Security-sensitive:** **Yes.** **Multi-flow:** Yes (all authed flows).

### `routes/authEnhanced.js`
- **Responsibility:** admin+client login, refresh (rotation), logout (revoke), `*/me`,
  register; cookie set/clear; case-insensitive email match; device-policy enforcement;
  structured secret-free auth logging.
- **Source:** `backend/routes/authEnhanced.js` (mounted `/api/crm/auth`).
- **Depends on:** `middleware/authEnhanced`, `middleware/{validation,normalize,rateLimiter}`,
  `models/{User,RefreshToken,DeviceBinding,DeviceProfile,SecurityAlert,ActivityLog}`,
  `utils/presence`.
- **Depended on by:** frontend `authService.js`, `AdminRoute`, `ClientRoute`, axios refresh.
- **Reads/writes:** `users`, `refresh_tokens`, `device_bindings`, `device_profiles`,
  `security_alerts`, `activity_logs`, `client_presence`.
- **Security-sensitive:** **Yes.** **Multi-flow:** Yes.

### `routes/authEmail.js`
- **Responsibility:** email verification OTP, resend, forgot-password, reset-password (with
  `forceLogout`), `email-status`. Resend-backed, no-enumeration responses.
- **Source:** `backend/routes/authEmail.js` (also mounted `/api/crm/auth`).
- **Depends on:** `models/{User,EmailVerification}`, `utils/email`, `middleware/*`.
- **Reads/writes:** `users`, `email_verifications`.
- **Security-sensitive:** **Yes** (password reset, session invalidation). **Multi-flow:** Yes.

### `middleware/validation.js` / `normalize.js` / `rateLimiter.js`
- **Responsibility:** Joi input validation (`validate(schema)`), input normalization
  (trim/lowercase email), express-rate-limit limiters.
- **Source:** `backend/middleware/{validation,normalize,rateLimiter}.js`.
- **Depended on by:** auth routes + admin CRUD routes.
- **Reads/writes:** none.
- **Security-sensitive:** Yes (input contract + abuse). **Multi-flow:** Yes (shared schemas).

### `middleware/riskEngine.js`
- **Responsibility:** server-side extension risk checks (multiple sessions, access frequency,
  repeated auth failures, new device, expired access) raising `SecurityAlert`; non-blocking
  `riskMiddleware` on authenticated extension requests.
- **Source:** `backend/middleware/riskEngine.js`.
- **Depends on:** `models/{SecurityAlert,ExtensionToken,ActivityLog,...}`.
- **Reads/writes:** `security_alerts` (write), extension/activity data (read).
- **Security-sensitive:** Yes. **Multi-flow:** No (extension only).

### `cron/stealthScheduler.js` / `cron/proxyVerifyScheduler.js`
- **Responsibility:** in-process schedulers. Stealth: daily 05:00-PKT usage reset (gated by
  `STEALTH_INTERNAL_CRON`). Proxy verify: periodic read-only WriteHuman auto-verify.
- **Source:** `backend/cron/*`.
- **Depends on:** `utils/stealth/resetAll`, `utils/proxy/verifyAndApply`, models.
- **Reads/writes:** stealth/proxy tables.
- **Security-sensitive:** No. **Multi-flow:** No (module-local).

---

## Backend — models (`backend/models/`)

| Model | Table | Represents / key fields | Sec? |
|---|---|---|---|
| `User` | `users` | Identity: fullName, email(lowercased), passwordHash(bcrypt12), role, status, tokenVersion, devicePolicy, expirySettings. Methods: comparePassword, forceLogout, isAdmin, toJSON. | **Yes** |
| `Tool` | `tools` | Managed tool: targetUrl, loginUrl, domain, category, credentialType, credential/session bundle, credentialVersion, extensionSettings, comboAuth. | **Yes** |
| `ToolAssignment` | `tool_assignments` | Client↔Tool grant: clientId, toolId, status, startDate, endDate; expiry statics. | Yes |
| `RefreshToken` | `refresh_tokens` | userId, token(sha256), expiresAt, revoked*, replacedByToken; `isActive`; revokeToken. | **Yes** |
| `DeviceBinding` | `device_bindings` | clientId, deviceIdHash(sha256), userAgent, lastSeenAt; hashDeviceId, verifyDevice. | **Yes** |
| `DeviceProfile` | `device_profiles` | Physical-machine grouping: deviceGroupId, fingerprint hash, browserInstanceIds[], status; static resolve. | **Yes** |
| `ActivityLog` | `activity_logs` | Audit: actorRole, actorId, action, meta; log, purgeOld. | Yes |
| `CredentialAccessLog` | `credential_access_logs` | Credential/login access + timing; getToolLoginStats. | Yes |
| `SecurityAlert` | `security_alerts` | clientId, riskType, riskLevel, status, context; raise (dedup). | Yes |
| `ExtensionToken` | `extension_tokens` | clientId, tokenHash(sha256), name, expiresAt, deviceInfo; createForClient. | **Yes** |
| `ExtensionScan` | `extension_scans` | Per-client browser-extension scan report (no secrets). | Yes |
| `ExtensionRelease` | `extension_releases` | version, minVersion, filename, size, sha256, manifest; getLatest, publish. | Yes |
| `ActivationToken` | `activation_tokens` | Short-TTL extension activation: tokenHash, deviceIdHash, ip; issue. | **Yes** |
| `OpenIntent` | `open_intents` | Short-TTL tool-open intent: tokenHash, deviceIdHash; issue. | Yes |
| `EmailVerification` | `email_verifications` | verify OTP / reset token (hashed, one-time, expiring). | **Yes** |
| `Blog` | `blogs` | title, slug, status, publishedAt. | No |
| `Contact` | `contacts` | contact form submissions. | No |
| `Announcement` | `announcements` | title, body, level, active, createdBy. | No |
| `Offer` | `offers` | marketing offers (combo/renewal/upgrade/recovery). | No |
| `Reminder` | `reminders` | clientId, title, dueDate, status. | No |
| `RenewalFollowup` | `renewal_followups` | per-client renewal status, snooze, offer. | No |
| `RenewalReminderLog` | `renewal_reminder_logs` | sent renewal reminders (email/whatsapp). | No |
| `ClientPresence` | `client_presence` | live "online now" snapshot per client. | No |
| `NotificationState` | `notification_states` | per-client notification state. | No |
| `ExpiryDismissal` | `expiry_dismissals` | client dismissed expiry warnings. | No |
| `proxy/ProxyClient` | `proxy_clients` | per-(userId, tool) proxy grant: status, planName, expiryDate, leaseMinutes. | Yes |
| `proxy/ProxyAccount` | `proxy_accounts` | operator account per tool: status, session_status, sessionEncrypted(AES-256-GCM). | **Yes** |
| `proxy/ProxyLease` | `proxy_leases` | short-lived signed lease: tokenHash, revoked, ip. | **Yes** |
| `stealth/StealthClient` | `stealth_clients` | per-CLIENT stealth grant: limits, usage, account pinning. | Yes |
| `stealth/StealthAccount` | `stealth_accounts` | operator StealthWriter account: sessionEncrypted(AES-256-GCM). | **Yes** |
| `stealth/StealthLease` | `stealth_leases` | short-lived signed lease. | **Yes** |
| `stealth/StealthSettings` | `stealth_settings` | singleton: lease duration, fixed-lease flag. | No |
| `stealth/StealthUsageLog` | `stealth_usage_logs` | append-only usage ledger. | No |

---

## Backend — utils (`backend/utils/`)

| Util | Responsibility | Sec? |
|---|---|---|
| `email.js` | Resend email helper (verification/reset/renewal/offer); no-op when unconfigured. | Yes |
| `encryption.js` | **Passthrough** (no-op) cookie "encryption" + `validateCookiesJson`. | Yes* |
| `getClientAccessibleTool.js` | Single source of truth for client tool access (assignment/expiry). | Yes |
| `proxyAssignments.js` | Presents proxy/stealth tools as assignment-style DTOs for admin views. | No |
| `renewalWindow.js` | Pure date-window/sort logic for renewals. | No |
| `semver.js` | MAJOR.MINOR.PATCH comparison. | No |
| `phone.js` | WhatsApp/phone normalization. | No |
| `presence.js` | Client presence recorder. | No |
| `extensionDownloads.js` | Writes uploaded extension zip into static download dirs. | No |
| `toolCleanupConfig.js` | Derives extension session-cleanup scope from a Tool's domain. | No |
| `zipManifest.js` | Extracts `manifest.json` from a zip buffer (zlib only). | No |
| `proxy/vaultCrypto.js`, `stealth/vaultCrypto.js` | AES-256-GCM vault crypto (`PROXY_VAULT_KEY`/`STEALTH_VAULT_KEY`). | **Yes** |
| `proxy/lease.js`, `stealth/lease.js` | HS256 lease signing (`*_LEASE_SECRET`, falls back to JWT_SECRET HMAC). | **Yes** |
| `proxy/tools.js` | Proxy-tools registry (also feeds server CORS allowlist). | **Yes** |
| `proxy/{verify,verifyAndApply,applySession,accountSelect,cookies,healthAlerts,chatgptVerify,claudeVerify}.js` | Proxy verify/apply/select/cookies/alerts pipeline. | Yes |
| `stealth/{access,accountSelect,config,cookies,resetAll,time,verify}.js` | Stealth access engine + support. | Yes |

`*` `encryption.js` is security-adjacent by name but currently a no-op; `COOKIES_ENCRYPTION_KEY`
is still required at boot by the auth middleware.

---

## Frontend

### `src/App.js`
- **Responsibility:** route table (public/admin/client), lazy code-splitting, `domainGuard()`
  host redirects, guard/provider wiring.
- **Depends on:** all pages, `AdminRoute`, `ClientRoute`, `ErrorBoundary`, providers.
- **Depended on by:** the entire SPA.
- **Security-sensitive:** Yes (which routes are guarded). **Multi-flow:** Yes.

### `src/services/api.js`
- **Responsibility:** axios instance, base-URL resolution, cookie credentials, role-aware
  401 refresh + replay, safe failure logging.
- **Depends on:** `REACT_APP_BACKEND_URL`, backend `/auth/*/refresh`.
- **Depended on by:** every service module and page.
- **Reads/writes:** `localStorage` (removes user keys on refresh failure).
- **Security-sensitive:** **Yes.** **Multi-flow:** Yes.

### `src/services/authService.js`
- **Responsibility:** admin/client login (with transient-retry), logout, session verify,
  device id/fingerprint/info, storage-availability probe.
- **Depends on:** `services/api.js`.
- **Depended on by:** login pages, `ClientRoute`.
- **Reads/writes:** `localStorage['genz_admin_user'|'genz_client_user'|'device_id']`.
- **Security-sensitive:** Yes. **Multi-flow:** Yes.

### `src/services/authDiagnostics.js` (the sanitizer)
- **Responsibility:** the single sanitizer for member-facing API/auth/network errors;
  `SAFE_GENERIC_MESSAGE`, `sanitizeError`, `classifyTransport`, `pingHealth`,
  `diagnosticsVisible`, `newRequestId`, `collectClientDiag`.
- **Depends on:** `services/api.js` (for base URL only), `NODE_ENV`.
- **Depended on by:** `Login`, `ClientLogin`, `AdminLogin`, `Join`, `ClientDashboardEnhanced`.
- **Reads/writes:** none (reads `navigator`/`window` facts).
- **Security-sensitive:** **Yes** (leak prevention). **Multi-flow:** Yes (all auth screens).

### `src/components/AdminRoute.js` / `ClientRoute.js`
- **Responsibility:** server-verified route gating (`/auth/admin/me`, `/auth/client/me`) +
  role check (admin).
- **Depended on by:** every guarded admin/client page in `App.js`.
- **Security-sensitive:** **Yes.** **Multi-flow:** Yes.

### `src/services/{assignmentsService,toolsService,stealthService,proxyToolsService,writeHumanV2Service}.js`
- **Responsibility:** typed wrappers over `/api/crm/{client,admin}/*` endpoints per feature.
- **Depends on:** `services/api.js`.
- **Depended on by:** the matching pages/hooks.
- **Security-sensitive:** No (auth handled by api.js + backend). **Multi-flow:** feature-local.

### Pages
- **Admin** (`src/pages/admin/*`) — guarded by `AdminRoute`; own the admin flows in §8 of
  ARCHITECTURE.md. **Client** (`src/pages/client/*`) — guarded by `ClientRoute`. **Public**
  (`src/pages/*`, `src/pages/public/*`) — marketing + auth screens.
- **Security-sensitive:** login/join pages are (they render sanitized errors). **Multi-flow:**
  a single page is normally single-flow; shared **layouts** (`AdminLayoutEnhanced.js`,
  `ClientLayoutEnhanced.js`) and shared **components** are multi-flow.

---

## Gateways (per tool, `*/server.js`)

- **Responsibility:** native-Node reverse proxy for one external tool: lease verify (local +
  backend `/validate`), server-side account-cookie injection, identity/billing shield, Gen Z
  overlay, response-header stripping (CSP/XFO/HSTS), Set-Cookie domain rewrite.
- **Source:** `proxy-gateway/server.js` (engine), `hix-gateway/server.js`,
  `bypassgpt-gateway/server.js`, `stealth-gateway/server.js`, `grok-gateway/server.js`,
  `claude-gateway/server.js`, `writehuman-v2/*`.
- **Depends on:** backend endpoints `/proxy/gateway/*` or `/stealth/gateway/*` (via
  `x-gateway-key`), env `*_LEASE_SECRET` + `*_GATEWAY_KEY` matching the backend.
- **Depended on by:** client access to that specific tool (portal "Open" → lease → gateway).
- **Reads/writes:** none directly (backend owns the vault); handles cookies in-flight.
- **Security-sensitive:** **Yes** (session injection, shield, secret keys). **Multi-flow:** No
  (each gateway affects only its own tool).

---

## Chrome extension (`chrome-extension/`)

- **`js/background.js`** — service worker: extension-token auth, `/api/crm/extension/*` calls,
  update checks, alarms/idle, shield injection orchestration. **Sec: Yes. Multi-flow:** whole
  extension.
- **`js/bridge.js`** — dashboard content script; postMessage bridge; secret stripping. **Sec: Yes.**
- **`js/shield.js`** — injected UI shield on tool hosts. **Sec: Yes** (identity hiding).
- **`js/core/*`, `js/strategies/*`, `js/config/toolConfigs.js`** — login orchestration +
  per-tool strategies. **Sec: Yes** (session injection). **Multi-flow:** per-tool.
- **`js/api.js`, `js/popup.js`, `js/expired.js`** — API mirror, popup UI, expired page.

---

## Deployment components

- **`deploy-hostinger.sh`, `deploy-backend.sh`, `deploy-lib.sh`, `deploy-frontend-only.sh`,
  `deploy-claude-gateway.sh`, `deploy-writehuman-*.sh`** — SFTP deploy automation.
  **Sec: Yes** (credentials handled via env; never upload `.env`). **Multi-flow:** Yes (a
  wrong target can stale a whole surface).
- **`.github/workflows/deploy-frontend.yml`** — CI frontend deploy to both web roots.
- **`frontend/app.htaccess`, `frontend/public/.htaccess`** — reverse-proxy/SPA routing per
  root. **Sec: partial** (route exposure). **Multi-flow:** Yes.
- **`scripts/build-extension.mjs`** — builds the extension zip into the frontend download dirs.
