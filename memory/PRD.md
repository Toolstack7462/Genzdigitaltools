# Gen Z Digital Store — PRD

## Original Problem Statement
Repo: https://github.com/Toolstack7462/Genzdigitaltools (Node/Express + React + Chrome MV3 + MySQL)

Main issue: Client dashboard shows assigned tools, but Access button says
expired / 403 / "could not prepare secure access". Goal — make Access reliable
using a SharePass-style extension-controlled flow (extension fetches latest
session, injects cookies, opens tool). The frontend must never receive the
session bundle.

### Required Flow
Client clicks Access → frontend sends toolId to extension → extension asks
backend for latest allowed session → backend uses SAME access logic as the
client dashboard → backend returns tool URL + session bundle ONLY to extension
→ frontend NEVER receives it → extension clears target cookies/storage →
extension injects session → extension opens/reloads tool in separate tab.

### Bugs Addressed
- no tool_access_expired if dashboard still shows the tool
- no old expired duplicate assignment overriding new active assignment
- always pick the latest active assignment for (clientId, toolId)
- date-only endDate must be valid until 23:59:59
- admin assignment updates take effect immediately
- extension must not use stale cached assignment
- no reused consumed open-intent token
- normalize toolId as string everywhere
- support `openIntentToken || intentToken`
- retry only token errors, not business errors

### Other Requested Changes
- Public CTA "Get Started" must open client signup, not Contact Us.
- Create `/client/signup` and/or `/client/register`.
- Admin/Client "View Website" opens https://genzdigitalstore.com in new tab.
- Tool Access opens/reuses a separate tab, never replaces the dashboard tab.
- Internal links stay in same tab. Logout redirects same tab.
- UI quick polish only: compact dashboard cards, larger aligned logo.
- Safe debug logs (clientId, toolId, assignmentId, endDate, serverTime,
  hasSessionBundle, cookieSetCount, failedCount, stage, reason).

---

## Implemented (Feb 2026 fork session)

### P0.5 — Extension auto-connect resilience (Feb 2026)
**Broken:** Dashboard's "Auto connecting…" gave up silently after 8 × 1.5s = 12s
with no visible reason, no retry button. Popup showed "Disconnected" even when
the dashboard tab was open — no way to trigger reconnect from the popup. Access
button could not open tools because the underlying extension session was never
established.

**Fixed:**
- `useExtension.js`: exponential backoff retry (1.5s → cap 30s) that runs as
  long as the dashboard tab is open. Auto-escalates to `forceReauth:true` after
  3 consecutive failures. Exposes `reason`, `attemptCount`, `lastError`, and
  a `reconnect()` callback. Listens for `GENZ_FORCE_RECONNECT` push.
- `ClientDashboardEnhanced.js`: after the 1st failure the banner shows the
  reason + a "Retry connection" button wired to `reconnect()`.
- `popup.html` / `popup.js`: added **Reconnect Now** button in the disconnected
  section that focuses the dashboard tab and sends `GENZ_FORCE_RECONNECT` (or
  opens the dashboard if none).
- `bridge.js`: `GENZ_FORCE_RECONNECT` added to SAFE_PUSH_TYPES so the SW can
  route it into the dashboard page.
- `background.js`: `GENZ_CONNECT_EXTENSION` clears stale extension storage on
  401/403/invalid-token rejections and returns status+code so the UI displays
  precise reasons.
- Manifest bumped 3.8.4 → 3.8.5; extension zip rebuilt.

### P0 — Shared `getClientAccessibleTool` helper
- **New: `backend/utils/getClientAccessibleTool.js`** — single source of truth:
  - `getClientAccessibleTool(clientId, toolId)` → `{ ok, tool, assignment, candidates, code }`
  - `listClientAccessibleTools(clientId)` → `[{ tool, assignment }, ...]`
- Routes now consult ONE helper:
  - `routes/client/tools.js` — `GET /` (list), `GET /:toolId` (detail), `POST /:toolId/open-intent`
  - `routes/extension/index.js` — `GET /tools/:toolId/credentials`, `POST /verify-intent`
- Behaviour preserved from prior fixes: inclusive end-of-day expiry via
  `ToolAssignment.effectiveEndBoundary`, latest assignment wins, string-
  normalised toolId, exact access codes (`assignment_not_found`,
  `assignment_expired`, `session_bundle_missing`, `tool_domain_invalid`),
  one-time open-intent only consumed after assignment validates.
- Extension `background.js` clears target cookies, re-fetches credentials
  per click, injects pre-navigation, opens in a separate tab, never persists
  decrypted credentials in cache (only safe metadata).
- `useExtension.openTool` enforces BUSINESS_RESULT_STAGES → no retry;
  token errors trigger ONE retry with FRESH activation + FRESH intent token.

### P1 — Signup CTA
- Added routes: `/client/signup`, `/client/register` (alias `Join.js`).
- `PublicNavbar` Get Started CTA (desktop + mobile) → `/client/signup`.

### P2 — Navigation / UI
- Existing target="_blank" "View Website" verified (Admin + Client layouts).
- Tool Access opens via `chrome.tabs.create()` → separate tab (verified).
- Public navbar logo enlarged (`size="md"` → `size="lg"`).

### Verification
- `node --check` ✅ on `getClientAccessibleTool.js`, `routes/client/tools.js`, `routes/extension/index.js`
- `yarn install --legacy-peer-deps` ✅
- `yarn build` ✅ (CI=false; pre-existing eslint warnings unchanged)
- Commit `565204a` staged locally — push requires user to use **Save to GitHub**.

---

## Backlog
- E2E manual validation in a real Chrome browser with the unpacked extension.

## Implemented (Jan 2026 follow-up session)

### P2 — Further compaction of admin members/assignments tables (cosmetic)
**What changed**
- `frontend/src/styles/dashboard.css` — added `.ds-table-compact` modifier on
  top of `.ds-table`: smaller header (10.5px) and cell (12.5px) typography,
  tighter padding (7×12 / 8×12), zebra rows, and a sticky header inside the
  scroll container.
- `frontend/src/pages/admin/AdminClientsEnhanced.js` — applied
  `ds-table ds-table-compact` to the desktop clients table, shrank the avatar
  (9→7), shrank row action buttons (h-8→h-7, icon 14→13, radius lg→md),
  reduced inline font sizes for name/email/last-login, and capped the table
  body height with `max-h-[calc(100vh-280px)]` so the sticky header keeps
  long lists scannable. Added `data-testid="admin-clients-table"` for
  regression hooks.
- `frontend/src/pages/admin/AdminBulkAssign.js` — tightened the Step 1 (tool
  picker) and Step 2 (client picker) grids: gap 2→1.5, max-h 56→48, smaller
  buttons (px-3/py-2.5 → px-2.5/py-1.5), smaller text (sm → 12.5px), 7×7
  client avatar → 6×6. Same data attributes preserved.

### P2 — Automated regression test suite for the access flow
**What changed**
- `backend/package.json` — added `jest` devDep and `test:access` script.
- `backend/db/mysqlAdapter.js` — made `Object.defineProperty`-installed
  statics + instance methods `writable: true, configurable: true` so they
  can be stubbed by Jest spies. This is the standard Mongoose contract and
  has no runtime effect on production calls.
- `backend/tests/access-flow.test.js` — **26 passing tests** locking the
  access-flow contract, with `ToolAssignment.find().populate()` stubbed (no
  MySQL needed):
  - `effectiveEndBoundary`: null/empty → null; date-only string → 23:59:59.999 UTC;
    midnight-form string → 23:59:59.999; ISO with time preserved; Date at UTC
    midnight bumped; invalid → null.
  - `isAssignmentExpired`: no endDate → never; past → expired; today date-only
    NOT expired at noon, IS expired at 24:00:00.001.
  - `findActiveForClientTool`: zero-match → null + empty candidates; all-expired →
    null + candidates populated; duplicate active+expired → latest valid wins;
    two valid → later endDate wins; tool-id string/number normalisation;
    future startDate filtered out; tool.status=inactive filtered out.
  - `getClientAccessibleTool`: missing args → `assignment_not_found`;
    `assignment_not_found` vs `assignment_expired` distinction;
    ok-path returns tool+assignment; valid coexisting with expired → ok;
    toolId normalisation.
  - `listClientAccessibleTools`: missing clientId → []; one entry per tool,
    latest boundary wins; inactive tool rows dropped; **dashboard list and
    per-tool getter MUST agree** (no divergence — the invariant the entire
    P0 fix is built around).
- Run with `cd /app/backend && yarn test:access` (or `yarn test`).

### Verification
- `node --check` ✅ on touched backend files.
- `yarn test:access` ✅ 26/26.
- `CI=false yarn build` ✅ in `frontend/` (pre-existing eslint warnings
  unchanged, identical bundle size to prior session ±1 KB).

---

## Files of Reference
- `backend/utils/getClientAccessibleTool.js` — shared helper (NEW)
- `backend/models/ToolAssignment.js` — `effectiveEndBoundary`, `findActiveForClientTool`
- `backend/routes/client/tools.js` — dashboard list, single tool, open-intent
- `backend/routes/extension/index.js` — credentials, open-intent, verify-intent
- `chrome-extension/js/background.js` — `handleOpenTool`, cookie clear/inject
- `frontend/src/hooks/useExtension.js` — business-vs-token retry policy
- `frontend/src/App.js` — `/client/signup`, `/client/register` routes
- `frontend/src/components/public/PublicNavbar.js` — Get Started CTA
- `frontend/src/pages/Join.js` — signup page (aliased by /client/signup)

## Access Codes (single vocabulary across the codebase)
- `assignment_not_found` — no assignment row exists for (clientId, toolId)
- `assignment_expired`   — row(s) exist but all are expired/inactive/not-started
- `session_bundle_missing` — assignment valid but admin hasn't saved usable session
- `tool_domain_invalid`  — tool has no targetUrl/domain
- `extension_token_invalid` — extension token bad/missing/expired
- `intent_invalid`       — open-intent token bad/expired/consumed
- `device_blocked`       — device-binding mismatch in hard mode

## Test Credentials
See `/app/memory/test_credentials.md` (no auth credentials created in this session).
