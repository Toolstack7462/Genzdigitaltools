# Changelog

## [3.9.0] — Safe Reference-Extension Patterns

### Chrome Extension

- **js/background.js**: Added `isToolOpening` module-level flag (OceanHub pattern) — wraps `handleOpenTool` to prevent overlapping invocations while a tool open is in progress.
- **js/background.js**: Added `__Host-` cookie name skip in `injectCookies()` (OceanHub pattern) — cookies with this prefix enforce strict origin binding and are silently rejected by Chrome when set externally; skipping them prevents misleading failure counts.
- **js/background.js**: Fixed sameSite normalization in `injectCookies()` — `unspecified` now maps to `no_restriction` (was falling through to `lax`, which caused rejected cookies for SameSite=None tools).

### Documentation

- **REFERENCE_EXTENSION_ANALYSIS.md**: Full analysis of OceanHub v1.3.1 and Ghost SEO Tools Extension across 15 areas. Documents safe patterns applied, risky patterns explicitly avoided, and the security guarantees preserved.
- **SECURITY_NOTES.md**: Added reference extension analysis section.
- **EXTENSION_INSTALL_GUIDE.md**: Added session management note.

---

## [3.8.0] — Full Stabilization Audit

### Backend

- **server-crm.js**: Added `chrome-extension://` origin allowance in CORS config so extension service-worker fetch calls are not blocked. The extension token in the `Authorization` header remains the actual auth boundary.
- **routes/client/extension.js**: Extended activation token TTL from 60 s to 2 min (`TOKEN_TTL_MS = 2 * 60 * 1000`).
- **routes/extension/index.js**: Extended open-intent TTL on legacy extension-authenticated route from 60 s to 2 min.
- **models/OpenIntent.js**: Changed default `ttlMs` to 2 min so all callers that omit the param get the extended window.

### Chrome Extension

- **manifest.json**: Removed `management` permission. The permission was used for a passive installed-extension scanner; `background.js` already guards the call with `chrome.management?.getAll` and skips gracefully when absent.
- **js/bridge.js**: Fixed `ReferenceError` in the duplicate-detection branch. In strict mode, function declarations inside blocks are block-scoped; `safeVersion` was defined in the `else` block but referenced in the `if` block. Replaced with an inline IIFE so the duplicate-ready `postMessage` always fires.

### Frontend

- **src/services/api.js**: Strip trailing slash from `REACT_APP_BACKEND_URL` before appending `/api/crm`, preventing double-slash URLs (`https://api.genzdigitalstore.com//api/crm`).
- **src/hooks/useExtension.js**: Reset `autoConnectAttemptsRef.current = 0` at the start of the auto-connect effect whenever `bridgeReady` becomes `true`. Previously, 8 failed attempts during early page load permanently blocked auto-connect even after the extension loaded.
- **src/pages/admin/AdminDashboardEnhanced.js**: Added optional chaining on `c?.assignmentCount` in `clients.reduce(...)` to prevent crash when a client object is `null`.
- **src/pages/client/ClientDashboardEnhanced.js**:
  - Fixed extension-status banner state: changed `extStatus === null` → `extConnStatus?.checking` (state object never equals `null`).
  - Fixed install-button visibility condition: `extStatus !== null` → `!extConnStatus?.checking`.
  - Auto-hide extension banner once `bridgeReady && extConnStatus?.connected` is true.
- **js/background.js**: After `getToolCredentials` returns `null`, check whether `extensionToken` was cleared from storage. If so, return an explicit auth error (`needsReauth: true`) instead of silently claiming `success: true` with no session.
- **js/background.js**: Added `tokenExpiresAt` and `expiresInDays` to `GENZ_GET_EXTENSION_STATUS` response so the popup can display expiry warnings.
- **js/background.js**: Removed credential-type whitelist from `forceFreshSession` block. All credential types now trigger full cookie + localStorage + sessionStorage clear before injecting the authorized session bundle.

---

## [3.7.x] — Previous releases

See git log for earlier history.
