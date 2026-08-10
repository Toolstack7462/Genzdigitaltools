# Business CRM — UI and Design System

| Field | Value |
|---|---|
| **Purpose** | Document the CRM's layout contract, navigation, responsive rules and accessibility behaviour. |
| **Scope** | CRM frontend presentation only. |
| **Status** | As-built. |
| **Last verified commit** | `8b76b617f67928e6454226d1861f9d35913a3981` |
| **Last verified date** | 2026-08-10 |
| **Source files inspected** | `frontend/src/features/business-crm/{BusinessCrmLayout.jsx,BusinessCrmApp.jsx,constants.js,components/ui.jsx,business-crm.css,business-crm-responsive.css}`, `frontend/src/components/AdminLayoutEnhanced.js`, `frontend/src/pages/admin/AdminBusinessCrm.js`. |
| **Related documents** | [`architecture.md`](architecture.md), [`troubleshooting.md`](troubleshooting.md), [`adr/001-same-admin-workspace.md`](adr/001-same-admin-workspace.md) |
| **Owner / maintainer** | Repository owner (`Toolstack7462`). |
| **What this document does not verify** | Visual design quality, cross-browser rendering beyond Chromium, or screen-reader testing with an actual assistive technology. |

## Design tokens

`business-crm.css` defines `--bcrm-*` variables that **inherit from the existing Gen Z brand
variables** (`--brand-navy`, `--brand-blue`, `--brand-cyan`, `--gradient-brand`, …) with hard-coded
fallbacks. The CRM therefore follows the existing design system rather than introducing a second one.
Every class is namespaced `bcrm-`, so CRM styles cannot leak into other admin pages.
**VERIFIED FROM CODE.**

Two stylesheets, load order matters:

1. `business-crm.css` — base design system.
2. `business-crm-responsive.css` — imported **second** in `BusinessCrmApp.jsx`, deliberately
   superseding the base file's `max-width: 1100px / 820px / 560px` rules. The base file still contains
   the old narrow-screen behaviour (a horizontally scrolling nav strip, 620–680 px minimum-width
   tables); the responsive file overrides it. **Do not reorder these imports.**

## Layout contract

Exactly **one full text sidebar** may be visible at any width. `AdminLayoutEnhanced.js` computes
`crmWorkspace` from the pathname and collapses the global admin nav only inside `/admin/business/*`.
**VERIFIED FROM CODE**; measured at all ten viewports **VERIFIED IN PRODUCTION**.

| Width | Global admin nav | CRM sidebar | Extras |
|---|---|---|---|
| ≥ 1280 px | 72 px icon rail, `title` + `aria-label` per item | 236 px | content up to 1360 px |
| 1024–1279 px | hidden (Tailwind `xl:`) | 212 px | "Admin Console" button in the CRM toolbar |
| < 1024 px | none | none permanent | menu button, drawer, 4-item quick-nav |

Inside the CRM the outer `<main>` drops its own padding and the 1200 px wrapper, so
`.bcrm-main` is the single source of content spacing — 22 px desktop, 20 px laptop, 14 px mobile.
That is what prevents the double-padding the module originally had.

## Navigation

17 sidebar entries in five groups, defined in `constants.js`. Route paths were **not** renamed when
labels changed, so old deep links still work. **VERIFIED FROM CODE.**

| Group | Entries |
|---|---|
| Overview | Dashboard, Website Access |
| Sales & Customers | Sales, Billing Clients, Pricing Catalogue, Expiries |
| Finance | Vendors, Client Pending, Vendor Dues, Expenses, Cashbook, Reports |
| Operations | Tasks |
| Administration | Imports, Team & Permissions, Audit, Settings |

Label-only renames: Clients → **Billing Clients** (`/clients`), Products → **Pricing Catalogue**
(`/products`), Access → **Team & Permissions** (`/access`).

Deliberately **not** in the sidebar, but still routed and reachable:

- **Search** — promoted to a toolbar icon button; `/search` still exists.
- **Offline Queue** — reached by clicking the connection status pill; `/offline-queue` still exists.

Every entry carries a permission, so the navigation is filtered by role.

### The routing invariant

All navigation goes through `crmPath()` from `constants.js`. Never use a bare relative target inside
this feature — see [`architecture.md`](architecture.md) and
[`troubleshooting.md`](troubleshooting.md) for why (it produced accumulating URLs and a blank panel).
`crmRouting.test.js` scans the source and fails the build if a relative target reappears.
**VERIFIED FROM TEST.**

## Mobile drawer

`BusinessCrmLayout.jsx`. Full modal-surface behaviour, all **VERIFIED FROM CODE** and measured
working in production:

- Opens from the menu button; renders the same five grouped sections.
- **Escape** closes it; the backdrop closes it; navigating closes it.
- **Focus is trapped** inside while open (Tab and Shift+Tab cycle), and focus **returns to the menu
  button** on close.
- Body scroll is locked **only** while open, and the previous `overflow` value is restored.
- Auto-closes if the viewport grows past 1024 px.
- `role="dialog"`, `aria-modal="true"`, `aria-label`, and `aria-expanded` / `aria-controls` on the
  trigger.

## Mobile quick navigation

Four items only — Dashboard, Sales, Access, **More** — fixed to the bottom, respecting
`env(safe-area-inset-bottom)`. "More" opens the grouped drawer. All 17 routes are deliberately **not**
duplicated here. `.bcrm-main` reserves bottom padding so the bar never covers content.
**VERIFIED FROM CODE.**

## Tables → cards

`components/ui.jsx`'s `Table` emits `<td data-label="…">` on every cell. Below 768 px the responsive
stylesheet turns each row into a card and renders the label from `attr(data-label)`. **No data is
dropped** — it is reflowed. Row action buttons get a full-width row so 44 px targets fit.
**VERIFIED FROM CODE.**

If you add a table, go through the shared `Table` component or the mobile card layout will not apply.

## Forms and modals

Below 768 px: single-column grids, 44 px minimum control height, a sticky action footer with
safe-area padding, and centred dialogs become **bottom sheets** using `max-height: 92dvh` with a
sticky header and footer and a scrollable body. **VERIFIED FROM CODE.**

## Touch targets

Every interactive CRM control is at least 44 px on touch widths: menu button, toolbar icon button,
back button, drawer close, sidebar back control, drawer navigation links, buttons, inputs, the
reporting-currency select and the connection pill.

Measured, not assumed: **715 rendered controls across 320/360/390/412/768 px, none under 44 px.**
**VERIFIED FROM TEST** (a Playwright measurement harness) and re-confirmed live.

Two of these were real defects found only by measuring:

- Drawer navigation links inherited a 36 px height from the base stylesheet's 820 px rule — the
  primary mobile navigation was below the minimum.
- Below 420 px the trailing toolbar controls **overlapped the menu button**, making the CRM menu
  unclickable. The workspace title is now dropped at that width (it is repeated in the drawer header)
  and the remaining controls shrink instead of colliding.

## Overflow policy

There is **no blanket `overflow-x: hidden`**. Overflow is fixed at source with `overflow-wrap: anywhere`
on the CRM root, table cells, key-value blocks, banners and page headings. A low-priority technical
table may scroll inside its own card, but the page body must never scroll horizontally. Measured 0
body overflow at all ten viewports. **VERIFIED IN PRODUCTION.**

## States every page provides

`components/ui.jsx` supplies `Loading`, `ErrorState` (with retry), `Empty`, and `Status`.
`pages/Forbidden.jsx` handles a permission denial; `pages/NotFound.jsx` handles an unknown CRM path.
A route or API error must never leave a blank white panel, and no state exposes a stack trace, SQL
error or internal path. **VERIFIED FROM CODE.**

## Reduced motion

`business-crm.css` honours `@media (prefers-reduced-motion: reduce)` by neutralising animation and
transition durations inside `.bcrm-root`. **VERIFIED FROM CODE.**

## When changing layout

1. Keep the one-sidebar rule at every width.
2. Keep every change to `AdminLayoutEnhanced.js` gated on `crmWorkspace`, and verify a **non-CRM**
   admin page still renders the full 224 px sidebar.
3. Re-measure touch targets and body overflow at 320/360/390/412/768 px — do not eyeball it.
4. Keep the two-stylesheet load order.
5. Run the frontend suite and a production build.
