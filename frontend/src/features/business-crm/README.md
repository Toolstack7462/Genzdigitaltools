# Business CRM — frontend feature map

| Field | Value |
|---|---|
| **Purpose** | Local map of this directory, so you can find the right file fast. |
| **Scope** | `frontend/src/features/business-crm/` only. |
| **Status** | As-built. |
| **Last verified commit** | `8b76b617f67928e6454226d1861f9d35913a3981` |
| **Last verified date** | 2026-08-10 |
| **Source files inspected** | Every file in this directory. |
| **Related documents** | Full set: [`../../../../docs/business-crm/README.md`](../../../../docs/business-crm/README.md) · [`ui-design-system`](../../../../docs/business-crm/ui-design-system.md) · [`architecture`](../../../../docs/business-crm/architecture.md) · [`troubleshooting`](../../../../docs/business-crm/troubleshooting.md) |
| **Owner / maintainer** | Repository owner (`Toolstack7462`). |
| **What this document does not verify** | Runtime or production behaviour. This is a directory map. |

Rendered by `frontend/src/pages/admin/AdminBusinessCrm.js`, which wraps this feature in the existing
`AdminLayoutEnhanced`. Mounted once, at `/admin/business/*`, from `frontend/src/App.js`.

## Files

| File | Responsibility |
|---|---|
| `BusinessCrmApp.jsx` | Descendant `<Routes>`; per-route permission `Gate`; `path="*"` → visible `NotFound`; imports both stylesheets |
| `BusinessCrmLayout.jsx` | Sidebar, toolbar, mobile drawer, quick-nav, `body.crm-workspace` |
| `BusinessCrmContext.jsx` | Bootstrap fetch, CSRF token, currency, online/queue state, `has(permission)` |
| `constants.js` | `BASE`, **`crmPath()`**, grouped `NAV`, `MOBILE_QUICK_NAV`, `formatMoney`, `formatDate` |
| `api.js` | Wraps the shared `services/api.js`; attaches `x-business-csrf-token` |
| `hooks.js` | `useResource`, `useFormState` |
| `components/ui.jsx` | Shared primitives. `Table` emits `td[data-label]` — the mobile card layout depends on it |
| `business-crm.css` | Base design system, `--bcrm-*` tokens inheriting the brand variables |
| `business-crm-responsive.css` | Loaded **second**; supersedes the base file's narrow-screen rules |
| `offline/db.js` | IndexedDB wrapper |
| `offline/queue.js` | Enqueue, count, drain |
| `offline/register.js` | Service-worker registration — production only, scoped to `/admin/business/` |
| `__tests__/crmRouting.test.js` | 18 routing tests, including a source scan |

### `pages/`

| Page | Route |
|---|---|
| `Dashboard.jsx` | index |
| `Sales.jsx` · `SaleForm.jsx` · `SaleDetail.jsx` | `sales`, `sales/new`, `sales/:id`, `sales/:id/edit` |
| `Contacts.jsx` · `ContactDetail.jsx` | `clients`, `vendors` and their detail routes |
| `Products.jsx` | `products` |
| `Payments.jsx` | `client-pending`, `vendor-dues` |
| `LinkedAccess.jsx` | `website-access` |
| `Expiries.jsx` | `expiries` |
| `Expenses.jsx` | `expenses` |
| `Reports.jsx` | `reports` |
| `Cashbook.jsx` | `cashbook` |
| `Tasks.jsx` | `tasks` |
| `SearchPage.jsx` | `search` |
| `OfflineQueue.jsx` | `offline-queue` |
| `ImportsPage.jsx` | `imports` |
| `AccessPage.jsx` | `access` — Team & Permissions |
| `AuditPage.jsx` | `audit` |
| `SettingsPage.jsx` | `settings` |
| `Forbidden.jsx` | `forbidden` |
| `NotFound.jsx` | `*` |

## Rules for this directory

1. **Every navigation target goes through `crmPath()`.** Never a bare relative `to=` or
   `navigate('segment')`. Relative targets resolve against the active route branch and append segments,
   which produced accumulating URLs and a blank content panel.
2. The `path="*"` route renders `NotFound`. Never `<Navigate to=".">` — it self-redirects.
3. Keep the stylesheet import order: base first, responsive second.
4. New tables go through `components/ui.jsx`'s `Table`, or the mobile card layout will not apply.
5. Interactive controls stay ≥44 px on touch widths. **Measure** rendered sizes; do not read CSS.
6. No blanket `overflow-x: hidden` — fix the overflow source.
7. Every page provides loading, empty and error states. Never leave a blank panel.
8. Permissions come from the server via `/bootstrap`; never compute them client-side.

Rules 1, 2 and 8 are partly enforced by `__tests__/crmRouting.test.js`, whose source scan fails the
build if a relative navigation target reappears.

## Before committing

```bash
cd frontend && CI=true npx craco test --watchAll=false
cd frontend && CI=false GENERATE_SOURCEMAP=false npm run build
```

Use `CI=false` for the build — `CI=true` fails on pre-existing warnings in unrelated pages, and the
deploy workflow uses `CI: 'false'`. Restore `frontend/build` and `frontend/yarn.lock` before staging;
both are tracked and get dirtied by a local build or install.
