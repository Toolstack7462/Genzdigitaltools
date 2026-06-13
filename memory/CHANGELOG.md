
## 2026-02 — Extension cookie debug logging
- Added INFO-level structured logs in `chrome-extension/js/background.js`:
  - `[extension/api] fetch`: per-request HTTP status, ok, success, response code; for `/tools/:id/credentials` also includes login_type (= credentials.type), cookies count, localStorage/sessionStorage key count, final toolUrl, domain, credentialVersion, bundleVersion. NEVER logs cookie values.
  - `[extension/cookies] inject failures`: per-domain rejection histogram (set/failed/reasonCounts).
- Improved `injectCookies()` failure classification with stable reason codes:
  - Pre-flight: `host_prefix_unsettable`, `missing_name`, `missing_value`, `samesite_none_requires_secure`, `secure_prefix_requires_secure`, `already_expired`, `domain_mismatch`.
  - chrome.runtime.lastError captured post-set: `samesite_invalid`, `secure_required`, `invalid_domain`, `invalid_path`, `invalid_expiry`, `invalid_url`, `set_returned_null`, `unknown`.
- Verified:
  - No `oceanhubtool.com` references anywhere in repo (already cleaned).
  - Backend CORS already allows `chrome-extension://*` origin (server-crm.js:84).
  - Manifest host_permissions already wildcard (`http://*/*`, `https://*/*`).
  - Backend `/credentials` response shape: `{ success, tool: { targetUrl, domain, ... }, sessionBundle: { cookies, localStorage, sessionStorage }, credentials: { type, payload, ... } }` — extension reads correctly.
