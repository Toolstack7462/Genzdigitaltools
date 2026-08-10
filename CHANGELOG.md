# Changelog

## [Unreleased] — Business CRM runtime defect fixes

CRM-only. No change to admin/client authentication, Give Access, assignment routes, extension,
proxy, StealthWriter, Claude gateway, the public site, or any non-`biz_crm_*` table. No schema
migration.

- **Dashboard 500 fixed (collation).** Every `GET /api/crm/admin/business/dashboard` failed with
  *"Illegal mix of collations (utf8mb4_unicode_ci,COERCIBLE) and (utf8mb4_general_ci,COERCIBLE) for
  operation '='"*. `DATE_FORMAT(col,'%Y-%m') = :month` compares two COERCIBLE operands: the
  `'%Y-%m'` literal carries the client character set's default collation (`utf8mb4_general_ci`)
  while the bound parameter is coerced to the session/database collation (`utf8mb4_unicode_ci`).
  Neither outranks the other, so MariaDB refuses; `currency_code=:currency` survived only because a
  column outranks a literal. All four month-scoped queries now use half-open DATE bounds
  (`col >= :monthStart AND col < :nextMonthStart`) — collation-free and sargable. Reproduced and
  confirmed by executing both forms against the production database through the app's own driver.
- **Reports 400 fixed (decimal precision).** `GET /reports/summary` returned `INVALID_MONEY`
  whenever the range contained a sale: `AVG()` widens `DECIMAL(18,2)` to `DECIMAL(22,6)` and, with
  `decimalNumbers:false`, it arrived as e.g. `"1250.000000"`, which `money.toMinor` rejects by
  design. Now `COALESCE(ROUND(AVG(subtotal_sale),2),0)`. Monetary validation was **not** loosened —
  it still refuses more than two decimals.
- **Touch targets.** Every interactive CRM control is at least 44x44 on touch widths: menu, toolbar
  icon and back buttons, drawer close, sidebar back control, drawer navigation links (the base
  stylesheet's 820px rule shrank them to 36px), buttons, inputs, the reporting-currency select and
  the connection pill. Verified by measuring 715 rendered controls at 320/360/390/412/768px.
- **320px toolbar overlap fixed.** Below 420px the trailing controls overlapped the menu button,
  making the CRM menu unclickable. The workspace title is dropped at that width (it is repeated in
  the drawer header) and the remaining controls shrink instead of colliding.
- Regression tests — `backend/tests/businessCrmRuntimeDefects.test.js`: no collation-fragile
  comparison may return, every named placeholder must have a matching parameter, every `AVG()` must
  be rounded, `money.js` must stay strict, month bounds including the December rollover, and
  permission gating is unchanged.
- Known and deliberately unchanged: a request from a **non-approved** origin returns 500 rather
  than 403, because the CORS origin callback in `backend/server-crm.js` rejects with an `Error`. The
  approved app origin correctly receives 401/403 with `access-control-allow-origin`, so the CRM
  itself is unaffected. That is shared global middleware, outside CRM scope.

## [Unreleased] — Claude Usage-Management Dashboard

Claude-only, additive. StealthWriter was used as a read-only architectural reference; no
StealthWriter (or any other tool), auth, payment, Personal/Team, session, account-widget, gateway
behaviour, or unrelated file was changed. All figures labelled **"Estimated local token usage"**
(not Anthropic's official counts).

- **Admin usage dashboard** (Admin → Claude → **Usage**): every Claude client's name/status,
  assigned account, five-hour + weekly limit/used/remaining, five-hour + weekly reset times,
  Custom/Default indicator, limit-reached + account-at-capacity status, and expandable recent
  usage history (input / context / output / total estimated tokens + timestamps).
- **Editable global limits**: five-hour + weekly per-client defaults, per-account base capacities
  and the safety reserve are admin-editable (new single-row `ClaudeSettings`; env is the fallback)
  and apply process-wide immediately. Priority unchanged: client → account → **global** → fallback.
- **Accurate accounting**: each settled request is recorded once with its input/context/output
  breakdown on the append-only ledger; a per-request **idempotency key** prevents duplicate
  charging. All counters + enforcement remain server-side and race-safe.
- New: `models/proxy/ClaudeSettings.js`, `utils/proxy/claudeSettings.js`; admin routes
  `usage-dashboard`, `clients/:id/usage-history`, `global-config` (GET/PUT); component
  `ClaudeUsageDashboard.js`. Tests: `claudeUsageMgmt.test.js` (breakdown, idempotency, global
  override priority, history).

## [Unreleased] — Claude Weekly Limit + Per-Client Override Fix

Claude-only, additive. No other proxy tool, auth, payment, database, Personal/Team logic,
session behaviour, or unrelated file changed.

**Weekly token limit** (parallel to the existing five-hour limit):
- Default **150,000 estimated tokens/week** per client (system fallback 200,000), configurable.
- Priority **client override → Claude-account default → global default → fallback**, for BOTH
  the five-hour and weekly limits (the five-hour limit gained an account-default tier so both
  match). Five-hour and weekly overrides are stored separately.
- Shared per-account **weekly capacity** is enforced (plan-scaled, with the 20% reserve).
- The client widget shows both cycles (used, remaining, thin bar, **exact** weekly reset time)
  and **"Not synced"** when usage/reset data is unavailable — never a fabricated value. All token
  figures labelled **"Estimated usage."**
- Weekly usage buckets on the shared append-only ledger → rolls over atomically at the official
  weekly reset and cannot be bypassed by concurrent requests.

**Bug fix — per-client token-limit override not applied on edit.** Root cause: the admin
Proxy-Tools page `saveClient()` sent only `planName/expiryDate/status/leaseMinutes` when EDITING
a client, silently dropping `tokenLimit`, `weeklyTokenLimit` and `pinnedAccountId` that the form
collected — so changing a client's limit never reached the backend and the client kept the
default. Fixed by forwarding those fields on update (undefined for non-Claude tools → omitted).
Added an end-to-end test (`claudeLimitOverride.test.js`) driving the real model + adapter:
increase/decrease, `0` hard-stop, override removal, numeric-string coercion, separate storage,
persistence/restart, and the priority tiers.

## [Unreleased] — Claude Token Quota (Estimated Local Usage)

Isolated, additive, **Claude-only** token-quota metering. No other proxy tool and no
authentication, payment, database, or unrelated UI was changed. All figures are labeled
**"Estimated local token usage"** — a proxy-side estimate from character counts, not
Anthropic's official metering — and no Claude credential/cookie/session is ever exposed.
See `CLAUDE_TOKEN_QUOTA.md` for the full design, env knobs, and operator checklist.

- **Plan detection & selection:** Pro / Max 5× / Max 20× auto-detected on *Verify* from
  claude.ai's authenticated API when reliable; manual admin override always wins.
- **Allowances:** default **20,000 estimated tokens per official 5-hour cycle**, configurable
  globally (`CLAUDE_DEFAULT_CLIENT_TOKENS`) and per client (custom limit; `0` = hard-stop).
- **Account assignment:** each client can be **pinned** to a specific Claude account or left on
  **automatic** selection; all clients on one account share that account's 5-hour and weekly
  reset times (admin-editable official reset timestamps; UTC/epoch math, timezone-safe).
- **Capacity scaling + reserve:** shared per-account capacity = `base × plan-multiplier ×
  (1 − reserve)`; Pro 1× / Max 5× / Max 20×; configurable **20% safety reserve**.
- **Two-sided check:** both the client allowance and the shared account capacity are checked
  before a request; input + output + system + context + attachment tokens are all counted.
- **Enforcement mode `CLAUDE_QUOTA_MODE`:** `off` / `count` *(default, safe — never inspects
  message bodies, cannot break a chat)* / `enforce` (per-message gate at the gateway, fail-open).
- **New:** `backend/utils/proxy/claudeQuota.js`, `claudeUsage.js`,
  `models/proxy/ClaudeUsage.js` (append-only, race-safe ledger; `claude_usage` table),
  `claude-gateway/lib/quotaTap.js`, and admin/client/gateway route + UI additions
  (all claude-gated). Tests: `claudeQuota`, `claudeUsage`, `claudePlanDetect`,
  `claudeUsagePipeline` (backend) + `quotaTap` (gateway).

## [Unreleased] — Client Dashboard UI Polish

Safe, presentation-only refinements to the live client dashboard. No backend,
API, route, auth, subscription, extension-flow, or data logic was changed.

### Client Dashboard (`frontend/src/pages/client/ClientDashboardEnhanced.js`)

- **Tool-count consistency:** the "All Your Tools" heading badge now uses a new
  `totalAssignedTools` count (regular `tools` + `proxyTools` + StealthWriter plan)
  instead of `tools.length`. It previously omitted the proxy/StealthWriter cards
  that render in the same grid, so the badge could read e.g. "7" while the "Active
  Tools" stat read "10". Both numbers now derive from the same data sources and are
  consistent (the stat stays "active only"; the badge is the "all assigned" total).
- **Top-section declutter:** removed the redundant "Website" button and "Profile"
  icon button from the welcome banner — both actions already exist in the sidebar
  and the topbar. Removed the now-unused `User` lucide import.
- **Accessibility:** added `aria-label` to the expiry-warning dismiss button and
  `aria-pressed` to the category filter buttons.

### Expired tool cards — professional disabled state (shared)

- Replaced the heavy `opacity-80 + red-50` overlay with a new shared
  `.tool-card-expired` surface (neutral desaturated glass, crisp hairline, no
  blanket opacity so the status pill and Renew CTA stay legible; the tool logo is
  grayscaled via `.tool-card-logo`). Applied identically in `ClientDashboardEnhanced.js`
  (`ToolCard`), `components/ProxyToolCard.js`, and `components/StealthWriterCard.js`.
  Hover-lift is now limited to active cards (disabled cards no longer animate).

### Styles

- **styles/dashboard.css:** added the `.tool-card-expired` / `.tool-card-logo`
  rules (theme-integrated: dark text + muted logo on the navy canvas).

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
