# Security Notes — Gen Z Digital Store

## Authentication Model

- JWT access tokens are stored exclusively in httpOnly, Secure, SameSite=None cookies. They are never exposed to JavaScript.
- Refresh tokens follow the same cookie policy with a 30-day (configurable) lifetime.
- The extension uses a separate token stored in `chrome.storage.local` (not accessible to web pages).

## Authorized Session Bundles

- Admin-provided session credentials (cookies, localStorage, sessionStorage) are stored encrypted in the database using AES-256 (`COOKIES_ENCRYPTION_KEY`).
- Credentials are decrypted only at the moment of injection into a tool tab and only for assignments that are currently active and assigned to the requesting client.
- Credentials are never sent to the frontend React app. The extension background service worker fetches and injects them directly.
- This system uses only admin-provided credentials. It does not copy cookies from other browser tabs, does not intercept other extensions, and does not perform any unauthorized credential harvesting.

## Extension Security

- The `management` permission has been removed. It was used for a passive extension scanner that is not required for core functionality.
- `externally_connectable` is restricted to `genzdigitalstore.com`, `app.genzdigitalstore.com`, and `localhost:3000`.
- Chrome extension origins (`chrome-extension://`) are allowed in CORS because extension service-worker requests carry this origin. The actual auth boundary is the extension token in the `Authorization` header, which is hashed and stored in the database.
- The bridge content script strips all credential fields (`credentials`, `sessionBundle`, `cookies`, `token`, `extensionToken`, etc.) from messages forwarded to the page.
- Open intents are single-use with a 2-minute TTL. Replaying a consumed intent is rejected.
- Activation tokens are single-use with a 2-minute TTL.

## Session Clearing

- On every Access button click: target domain cookies are cleared via `chrome.cookies.remove`, and `localStorage`/`sessionStorage` are cleared via scripting injection before the authorized session bundle is applied. This prevents stale session data from a previous session interfering.

## CORS

- Allowed origins are controlled by the `ALLOWED_ORIGINS` environment variable — not hardcoded.
- Chrome extension origins are additionally allowed because they cannot be spoofed by web pages.

## Rate Limiting and Input Validation

- Global body limit is 100 KB. Admin session-bundle upload endpoints use a higher 10 MB limit applied per-route.
- `app.set('trust proxy', 1)` is set so rate limiters read the real client IP from `X-Forwarded-For` behind Hostinger's reverse proxy.

## What This System Does NOT Do

- Does not steal cookies from unrelated sites.
- Does not copy data from other browser extensions.
- Does not block DevTools.
- Does not include anti-detection or fingerprinting evasion logic.
- Does not expose JWT secrets, refresh tokens, or encryption keys to the frontend or extension.

## Reference Extension Analysis

Two commercial Chrome extensions (OceanHub v1.3.1 and Ghost SEO Tools) were audited for safe architecture patterns.

**Applied (safe patterns):**
- `__Host-` cookie skip: cookies with this prefix enforce strict origin binding and cannot be set externally; they are now skipped in `injectCookies()` to avoid misleading error counts.
- sameSite `unspecified` normalization: treated the same as `no_restriction` to avoid cookie rejection on SameSite=None tools.
- `isToolOpening` flag: prevents overlapping `handleOpenTool` invocations.

**Explicitly avoided (invasive/malicious patterns from reference extensions):**
- `management` API to disable other extensions
- `browsingData.remove` with global scope (all-domains cookie wipe)
- Fingerprint spoofing (`navigator.userAgent`, `screen.width/height` override)
- DevTools keyboard shortcut blocking
- `document.cookie` getter/setter override to hide cookies from other extensions
- `removeSelf()` / self-destruct on other extension detection
- `reloadAllTabs()` (reloads all browser tabs)

Full analysis: `REFERENCE_EXTENSION_ANALYSIS.md`

## Secrets Rotation

To rotate `COOKIES_ENCRYPTION_KEY`: update the environment variable and re-save all existing session bundles in the admin tool editor (they will be re-encrypted with the new key on save).

To rotate `JWT_SECRET` / `JWT_REFRESH_SECRET`: all active sessions will be invalidated; users will need to log in again.

## Business CRM

Full record of what was and was not tested:
[`docs/business-crm/security.md`](docs/business-crm/security.md).

- **No new authentication.** The CRM reuses `requireAdminAuth` and the existing admin cookies. No CRM
  login, no second cookie, no second token system, no second user store.
- **The CRM never writes the shared `users` table.** Account creation and password reset are disabled
  and return HTTP 405 `CRM_USER_WRITE_DISABLED` — a reset would bump `tokenVersion` and silently drop a
  live admin session.
- **Authorisation is server-enforced.** 44 permission keys across 5 roles; cost, profit, vendor data
  and credentials are removed server-side, not merely hidden in the UI. See
  [`docs/business-crm/rbac-matrix.md`](docs/business-crm/rbac-matrix.md).
- **CSRF:** double-submit token issued by `/bootstrap`, required on every other CRM endpoint.
- **Credentials at rest:** AES-256-GCM with a random IV and AAD bound to `"<saleId>:<itemId>:field"`.
  The key (`BUSINESS_CRM_VAULT_KEY`, 64 hex) is read lazily, so a missing key yields HTTP 503 on
  credential paths only and never blocks boot. Its production presence is **UNKNOWN**.
- **Private data is never cached.** Every CRM response sets `Cache-Control: private, no-store`, and the
  CRM service worker is scoped to `/admin/business/`, is network-first, and never caches `/api/*`.
- **Nothing sensitive in browser storage.** The session lives only in `HttpOnly` cookies; measured
  storage contained no token, password or cookie value.
- **Audit redaction:** before/after payloads have any `password|credential|cipher|token|secret|cookie`
  key replaced with `[REDACTED]`.
- **Known, unchanged:** a request from a **non-approved** origin returns 500 rather than 403, because
  the CORS origin callback in `backend/server-crm.js` rejects with an `Error`. The approved app origin
  correctly receives 401/403. Shared global middleware, left alone. Recorded as
  *NON-BLOCKING PLATFORM CORS WARNING — NOT CHANGED*.

**Not assessed:** penetration testing, dependency CVE status, MANAGER/STAFF/VIEWER runtime
enforcement, logout-state clearing. No claim of "secure" is made.
