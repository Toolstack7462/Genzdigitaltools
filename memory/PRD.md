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
- Jest/supertest unit tests for `getClientAccessibleTool` covering:
  - duplicate active+expired rows → latest valid wins
  - date-only endDate same day → valid through 23:59:59
  - `assignment_not_found` vs `assignment_expired` distinction

### Client Dashboard — Premium Compact UI (Feb 2026)
**Goal:** Make `/client/dashboard` look compact, premium, "world-class SaaS"
without breaking any logic.

**Done:**
- Slim welcome/membership banner: navy→teal gradient + radial glow accents,
  one-row layout (greeting + tools badge + Plan + Website + Profile), inline date.
- Stat cards: compact glass cards (px-3.5 py-3) with left color rail, soft
  inset, color-tinted icon container, fixed contrast (forced `#071B33` / `#5B6B7C`
  inline so `.app-main .text-genz-navy { color:#eaf2fb !important }` doesn't
  wash them out on the dark canvas), tabular-nums big number, bold label,
  muted sub-text. Hover: -translate-y-0.5 + color glow shadow.
- Expiry warning: slim dark amber glass strip (was light amber card).
- Chrome Extension banner: slim dark glass strip with cyan glow + "Install"
  pill button (was full-height light card).
- Section headings (Featured Tools, All Your Tools) switched to `text-white`
  + cyan accent count badge for readability on navy canvas.
- Search input + category filter pills: dark glass with white text and
  cyan-gradient active pill (was white inputs).
- Reduced vertical spacing throughout (`space-y-3`, gap-3, smaller paddings)
  so more content appears above the fold.

**Files touched:**
- `frontend/src/pages/client/ClientDashboardEnhanced.js` — entire dashboard
  surface restyled; logic, routes, data fetching, openTool flow untouched.

**Verification:** Visual screenshot with mocked tools/expiring data on
`/client/dashboard` confirmed: stat-card text now crisp, banners slim,
sections compact, theme cohesive with dark navy app canvas.


- Further UI compaction of admin members/assignments tables (cosmetic).

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

---

## Public Site Premium UI/UX Redesign (Feb 2026 — current session)

**Original ask:** Redesign homepage and improve all public/client-facing pages so the whole website looks premium, classy, modern, smooth, and professionally aligned. Navy/teal/white gradients, subtle 3D effects, glassmorphism, glow effects, floating elements, premium cards, soft shadows, smooth hover animations. **Strict constraint:** Do NOT change backend APIs, auth, routing, dashboard logic, tool access logic, payment logic, or data fetching. Frontend UI/UX only.

### What was delivered
- **New design tokens & utilities** added to `frontend/src/styles/premium.css`:
  - `.page-hero` — premium aurora hero background pattern reusable across inner pages
  - `.brand-blob` (`brand-blob-a/b/c`) — animated decorative brand-color blobs
  - `.gz-eyebrow-grad` — premium gradient-bordered eyebrow chip
  - `.text-grad-brand`, `.text-grad-cyan-teal` — gradient headline word variants
  - `.gz-card-soft`, `.gz-tint-card`, `.pricing-glow` — softer premium card styles
  - `.brand-hairline`, `.brand-divider` — subtle brand-accent dividers
  - `.hover-glow`, `.ring-grad`, `.heading-underline`, `.gz-section-tinted` helpers
- **New component:** `frontend/src/components/public/PageHero.js` — reusable premium hero (aurora + animated brand blobs + dot grid + gradient eyebrow + animated headline).
- **Pages overhauled with premium hero + polished sections:**
  - `pages/Home.js` — fixed clipping of hub mockup (floating chips repositioned so the "DIGITAL SERVICE HUB" header is visible)
  - `pages/About.js` — Mission/Vision use new `gz-tint-card`, Six core service lines section, redesigned values grid
  - `pages/Pricing.js` — premium hero, polished plan grid with glowing highlighted card, individual service add-ons grid with hover glow
  - `pages/Contact.js` — two-column premium layout: glass-bordered form on the left, WhatsApp + Response Time + Privacy info cards on the right
  - `pages/public/Services.js` — gz-card-accent + sheen + bullets per service, badges
  - `pages/public/Portfolio.js` — premium hero, gradient-active filter pills, premium commission CTA card with grad border
  - All 7 service sub-pages (`ServiceDigitalTools / ServiceBranding / ServiceAppDev / ServiceSEO / ServiceSocialMedia / ServiceWebDesign / ServiceWriting`) — heroes upgraded to use the new `.page-hero` pattern with animated brand blobs (keeping per-service color tints intact)
- **Components polished:**
  - `components/public/PricingCard.js` — new highlighted state with brand hairline top, gradient "Most Popular" badge, soft glow ring (`pricing-glow`), refined checkmark chips
  - `components/public/PublicFooter.js` — brand-gradient hairline accent line at top edge
- **Responsiveness verified** on desktop (1920×900) and mobile (390×844) for hero, navbar, pricing, and home — premium look retained on all breakpoints.

### What was NOT touched (per constraint)
- Backend APIs, routing, auth, dashboard, payment, data fetching, Chrome extension logic, admin pages, client dashboard pages.

### Files of reference (this session)
- `frontend/src/styles/premium.css` (added ~150 lines of premium utility classes)
- `frontend/src/components/public/PageHero.js` (NEW)
- `frontend/src/components/public/PricingCard.js` (rewritten)
- `frontend/src/components/public/PublicFooter.js` (hairline accent added)
- `frontend/src/pages/{Home,About,Pricing,Contact}.js`
- `frontend/src/pages/public/{Services,Portfolio,Service*.js}`

### Verification
- Self-tested via screenshots (`/tmp/h1.png`, `/tmp/pricing_new.png`, `/tmp/contact_form.png`, `/tmp/about_new.png`, `/tmp/portfolio_new.png`, `/tmp/sdt.png`, `/tmp/sbd.png`, `/tmp/home_mobile.png`, `/tmp/pricing_mobile.png`).
- ESLint clean on all touched files (pre-existing warnings in untouched Blog/Admin/NotFound files left as-is).
- All public pages render without console errors; layouts responsive at 1920px and 390px viewports.

---

## Premium Portfolio Showcase (Feb 2026 — same session)

**Ask:** Make the portfolio feel premium / trustworthy / world-class with high-fidelity SaaS-style mockups (not colored placeholders) for 8 specific case studies.

### What was delivered
- **New showcase system** under `frontend/src/components/public/showcase/`:
  - `ShowcaseMocks.js` — 8 high-fidelity, brand-aligned SaaS mockup components built entirely with CSS / lucide-react:
    1. `DashboardMock` (browser + navy sidebar + KPI cards + chart + tool tiles)
    2. `SaaSLandingMock` (browser + nav + eyebrow + headline + CTA buttons + feature cards + glow blob)
    3. `ToolsPlatformMock` (dark navy 4×2 glassy tool grid + "Extension live" badge)
    4. `BrandKitMock` (realistic phone with branded gradient feed + colour swatches + type pair)
    5. `ExtensionMock` (browser background + floating navy popup with connected status + tool rows)
    6. `PricingMock` (browser + 3 plan cards, middle highlighted with shadow + "POP" badge)
    7. `AdminPanelMock` (sidebar + KPI strip + recent activity table with status pills)
    8. `WhatsAppPortalMock` (phone with WhatsApp UI + bubbles + side process cards)
  - `ShowcaseCard.js` — premium wrapper card with gradient hairline, category chip, glass-blur, subtle 3D mock perspective, hover lift + glow + scale, gradient CTA button.
  - `showcaseItems.js` — single canonical data source (id, title, tag, description, accent, tags, Mock, ctaLabel).
- **`styles/showcase.css`** — dedicated stylesheet with CSS `color-mix` for per-accent themes, hairline, glow, grid texture mask, 3D mock tilt, edge-glow on hover, mobile-safe flatten at <1024 px.
- **Wired into pages**:
  - `pages/public/Portfolio.js` — full 8-card showcase grid with filter pills derived from the data; new commission CTA card.
  - `pages/Home.js` — "Featured Work" preview block showing the first 4 showcase items in a 2-col grid, with "View full showcase" inline link and "Explore Full Portfolio" gradient button below.
- **Mobile verified** at 390×844 — cards stack with mockups scaling gracefully; phone mockups stay readable; chips and CTAs remain touch-friendly.

### Files of reference (this iteration)
- `frontend/src/components/public/showcase/ShowcaseMocks.js` (NEW)
- `frontend/src/components/public/showcase/ShowcaseCard.js` (NEW)
- `frontend/src/components/public/showcase/showcaseItems.js` (NEW)
- `frontend/src/styles/showcase.css` (NEW)
- `frontend/src/index.css` (import added)
- `frontend/src/pages/Home.js` (Featured Work section)
- `frontend/src/pages/public/Portfolio.js` (full showcase grid)
