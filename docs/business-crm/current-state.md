# Business CRM — Current State

| Field | Value |
|---|---|
| **Purpose** | State exactly what the Business CRM is today, and separate verified facts from unverified ones. |
| **Scope** | Module inventory, feature status, verification status. |
| **Status** | As-built snapshot. |
| **Last verified commit** | `8b76b617f67928e6454226d1861f9d35913a3981` |
| **Last verified date** | 2026-08-10 |
| **Source files inspected** | `backend/modules/business-crm/**` (all 22 JS files + `schema.sql`), `frontend/src/features/business-crm/**` (35 files), `backend/scripts/business-crm-{key,migrate,import}.js`, `frontend/public/admin/business/sw.js`, CRM mount lines in `App.js` / `AdminLayoutEnhanced.js` / `server-crm.js`. |
| **Related documents** | [`architecture.md`](architecture.md), [`known-issues.md`](known-issues.md), [`operations-runbook.md`](operations-runbook.md) |
| **Owner / maintainer** | Repository owner (`Toolstack7462`). |
| **What this document does not verify** | Production database row counts beyond the aggregate figures noted below, the runtime value or presence of `BUSINESS_CRM_VAULT_KEY`, hosting configuration, and any financial write workflow. |

## What the module is

An **additive** admin module inside the existing React + Express application. It adds a financial CRM
workspace and does not replace anything. **VERIFIED FROM CODE.**

| Surface | Location |
|---|---|
| Frontend route | `/admin/business/*` — one route in `frontend/src/App.js:193` |
| Frontend code | `frontend/src/features/business-crm/**` (35 files) |
| Backend API | `/api/crm/admin/business/*` — one mount in `backend/server-crm.js:388` |
| Backend code | `backend/modules/business-crm/**` (22 JS files + `schema.sql`) |
| Database | 21 `biz_crm_*` tables |
| Service worker | `frontend/public/admin/business/sw.js`, scoped to `/admin/business/` |

## Feature inventory

All **VERIFIED FROM CODE** unless marked otherwise.

| Feature | Where |
|---|---|
| Dashboard (today/month totals, outstanding, tasks, recent sales, top products) | `routes/dashboard.js`, `pages/Dashboard.jsx` |
| Sales with up to 20 line items, editable invoices | `services/salesService.js`, `pages/SaleForm.jsx` |
| Clients ("Billing Clients") and vendors | `services/contactService.js`, `routes/contacts.js`, `pages/Contacts.jsx` |
| Product / pricing catalogue | `routes/products.js`, `pages/Products.jsx` |
| Client receipts, vendor payments, reversals | `services/paymentService.js`, `routes/payments.js` |
| Expenses and cashbook | `services/expenseService.js`, `routes/expenses.js`, `routes/reports.js` |
| Reports (revenue, collections, profit, expiries) | `routes/reports.js`, `pages/Reports.jsx` |
| PDF invoices, branded | `invoicePdf.js`, `invoiceLogo.js`, `assets/invoice-logo.png`, `routes/sales.js` (`GET /sales/:id/invoice.pdf`) |
| Tasks, activities, WhatsApp reminder drafts | `routes/operations.js`, `services/reminderService.js` |
| Customer message wording, English only | `reminderTemplates.js` (pure, unit-tested; pending payment · overdue payment · expiring soon · renewal due today · expired · invoice sharing · vendor due). Masked account emails, `10 August 2026` dates, `PKR 2,500.00` amounts, numbered multi-item lists |
| PKR / INR / NGN ledgers, never combined | `money.js`, every currency-scoped query |
| Encrypted optional credentials on sale items | `encryption.js` (AES-256-GCM) |
| Website access reconciliation | `services/websiteAccessService.js`, `routes/accessLinks.js`, `pages/LinkedAccess.jsx` |
| Team roles and permission overrides | `permissions.js`, `routes/admin.js`, `pages/AccessPage.jsx` |
| Audit log | `audit.js`, `routes/admin.js` (`GET /audit`) |
| CSV import / export, JSON backup | `csv.js`, `routes/admin.js` |
| Offline queue for safe creates | `offline/{db,queue,register}.js`, `routes/sync.js` |
| Global search | `routes/search.js`, `pages/SearchPage.jsx` |

## Counts

| Thing | Count | Basis |
|---|---|---|
| `biz_crm_*` tables in `schema.sql` | **21** | VERIFIED FROM CODE |
| Foreign keys declared | 9 | VERIFIED FROM CODE |
| Permission keys | **44** | VERIFIED FROM CODE |
| Business roles | 5 (OWNER, ADMIN, MANAGER, STAFF, VIEWER) | VERIFIED FROM CODE |
| API endpoints | 60 | VERIFIED FROM CODE — see [`api-reference.md`](api-reference.md) |
| Frontend CRM files | 35 | VERIFIED FROM CODE |
| CRM sidebar entries | 17, in 5 groups | VERIFIED FROM CODE (`constants.js`) |
| Backend tests passing | 333 | VERIFIED FROM TEST |
| Frontend tests passing | 41 | VERIFIED FROM TEST |

## Verified in production on 2026-08-10

Observed against the live system. **VERIFIED IN PRODUCTION.**

- `GET /dashboard` returns **200** for PKR, INR and NGN; the page renders with content.
- `GET /reports/summary` returns **200** for PKR, INR and NGN; `averageInvoice` has two decimals.
- Every CRM API response carries `Cache-Control: private, no-store` and `X-Business-CRM-Version: 2.0.0`.
- Admin cookies `adminAccessToken` / `adminRefreshToken` are `HttpOnly`, `Secure`, `SameSite=None`;
  `document.cookie` cannot read them.
- `localStorage` holds one CRM-relevant key, `genz_admin_user`. `sessionStorage` is empty.
- Cache Storage holds one cache (`genz-business-crm-shell-v2`) with **no** `/api/` entries.
- The service worker's scope is exactly `https://app.genzdigitalstore.com/admin/business/`.
- 20 sequential sidebar clicks produce clean sibling URLs; no segment accumulation.
- At 320–768 px no interactive CRM control is under 44 px and the page does not scroll horizontally.
- Non-CRM admin pages restore the full 224 px sidebar; no CRM financial field appears on
  `/admin/assignments`.
- Aggregate table counts at that moment: 21 `biz_crm_*` tables present, `biz_crm_schema_migrations`
  reporting version `2.0.0`, and non-zero rows in `biz_crm_clients` and `biz_crm_access_links`.
  Exact figures are deliberately omitted here because they change constantly.

## Explicitly UNKNOWN

Do not treat any of these as settled.

| Item | Status |
|---|---|
| `BUSINESS_CRM_VAULT_KEY` runtime value / presence | **PRODUCTION STATUS UNKNOWN.** It was not found in the deploy-time env file that was inspected; it may be supplied by the process environment instead. If it is absent or not 64 hex characters, credential encrypt/decrypt returns HTTP 503 `VAULT_NOT_CONFIGURED` and everything else keeps working. |
| Live schema drift vs `schema.sql` | **PRODUCTION STATUS UNKNOWN** beyond the table count and migration version above. No column-by-column production comparison is recorded here. |
| Financial write workflows end-to-end | **NOT VERIFIED.** Creating a sale, recording payments, reversing a payment and generating an invoice PDF have not been exercised against a database. No staging environment exists. |
| MANAGER / STAFF / VIEWER enforcement at runtime | **NOT VERIFIED.** Only a SUPER_ADMIN session was available. Role definitions are VERIFIED FROM CODE; runtime 403 behaviour for the lower roles is not. |
| CSV import, JSON backup, offline queue drain | **NOT VERIFIED** against real data. |
| Reconciliation against a large dataset | **NOT VERIFIED.** Correctness properties are argued from code and covered by structural tests only. |

## Recently fixed — do not reopen

These were real defects and are **resolved**. Listed so nobody re-diagnoses them.

| Defect | Fixed in | Guard |
|---|---|---|
| CRM sidebar appended route segments (`/sales/sales/...`) | `dea93fe` | `crmPath()` + source-scanning test |
| `<Navigate to=".">` self-redirect producing a blank panel | `dea93fe` | Visible `NotFound.jsx` + test |
| Two full text sidebars, squeezed content | `dea93fe` | Route-scoped workspace mode |
| Dashboard 500 — collation mismatch on `DATE_FORMAT(...)=:month` | `dfce275` | Half-open DATE bounds + test |
| Reports 400 — six-decimal `AVG()` rejected by `money.toMinor` | `dfce275` | `ROUND(AVG(...),2)` + test |
| Reports 500 — colon in a SQL comment became a phantom placeholder | `8b76b61` | Colon-in-comment test |
| Interactive controls under 44 px; toolbar overlap below 420 px | `8b76b61` | Rendered-size measurement |

Detail: [`known-issues.md`](known-issues.md), [`troubleshooting.md`](troubleshooting.md).
