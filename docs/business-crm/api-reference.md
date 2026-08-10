# Business CRM — API Reference

| Field | Value |
|---|---|
| **Purpose** | List every Business CRM endpoint with its method, path, required permission and notes. |
| **Scope** | Everything mounted under `/api/crm/admin/business`. No other API is documented here. |
| **Status** | As-built, extracted from the routers. |
| **Last verified commit** | `8b76b617f67928e6454226d1861f9d35913a3981` |
| **Last verified date** | 2026-08-10 |
| **Source files inspected** | `backend/modules/business-crm/index.js` and all 12 files in `backend/modules/business-crm/routes/`, plus `permissions.js`, `csrf.js`, `validation.js`, `http.js`. |
| **Related documents** | [`rbac-matrix.md`](rbac-matrix.md), [`data-model.md`](data-model.md), [`website-access-bridge.md`](website-access-bridge.md), [`security.md`](security.md) |
| **Owner / maintainer** | Repository owner (`Toolstack7462`). |
| **What this document does not verify** | Response body shapes field-by-field, and runtime behaviour of endpoints not exercised in production (only `/dashboard` and `/reports/summary` were called live). |

Everything below is **VERIFIED FROM CODE**.

## Common contract

All paths are relative to `/api/crm/admin/business`.

- **Authentication:** the existing `requireAdminAuth`. Missing or invalid session → **401**.
- **Business access:** a caller whose business role is `DISABLED` → **403** `BUSINESS_ACCESS_DISABLED`.
- **Authorisation:** `requirePermission(key)` → **403** `BUSINESS_PERMISSION_DENIED` with the
  offending `permission` echoed back.
- **CSRF:** every route except `GET /bootstrap` sits behind `csrf.requireToken`. Send the token from
  `bootstrap` in the `x-business-csrf-token` header.
- **Rate limit:** 240 requests/minute keyed by user id, applied after `/bootstrap`.
  `POST /access-links/reconcile` additionally allows only 6/minute.
- **Caching:** every response carries `Cache-Control: private, no-store` and
  `X-Business-CRM-Version: 2.0.0`.
- **Errors:** a thrown error with a 4xx/5xx `status` returns its own message and `code`. Anything
  else becomes a generic **500** `BUSINESS_INTERNAL_ERROR` with the message
  `Business CRM request failed`; the stack is logged server-side only. `ER_DUP_ENTRY` → **409**.
  Unmatched path → **404** `BUSINESS_ROUTE_NOT_FOUND`.
- **Paging:** `?page` (1…100000) and `?pageSize` (1…500, default 25) where a list is returned.
- **Currency:** `?currency` must be `PKR`, `INR` or `NGN`, else **400** `UNSUPPORTED_CURRENCY`.

## Bootstrap

| Method | Path | Permission | Notes |
|---|---|---|---|
| GET | `/bootstrap` | *(auth only)* | Returns version, user, resolved `access.permissions`, permission catalogue, currencies, settings and a fresh `csrfToken`. The only endpoint before the CSRF gate. |

## Dashboard

| Method | Path | Permission | Notes |
|---|---|---|---|
| GET | `/dashboard` | `dashboard.view` | `?currency`, `?date`, `?month`. Month scoping uses half-open DATE bounds. Profit, vendor, expense and audit blocks are omitted unless the caller holds the matching permission. **VERIFIED IN PRODUCTION: 200 for PKR/INR/NGN.** |

## Sales

| Method | Path | Permission | Notes |
|---|---|---|---|
| GET | `/sales` | `sales.view` | Filterable list |
| POST | `/sales` | `sales.create` | Joi `saleCreate`; 1–20 items; optional `idempotencyKey`; SERIALIZABLE transaction; reserves the invoice number |
| GET | `/sales/:id` | `sales.view` | `?credentials=1` decrypts only with `credentials.view` |
| PUT | `/sales/:id` | `sales.edit` | Joi `saleUpdate`; requires matching `version` → **409** `VERSION_CONFLICT` |
| PATCH | `/sales/:id/status` | `sales.cancel` | Status transition |
| DELETE | `/sales/:id` | `sales.delete` | Soft delete |
| GET | `/sales/:id/invoice.pdf` | `invoice.view` | Branded PDF: Gen Z logo, navy/cyan header, `BUSINESS INVOICE` title, and a Paid / Partially Paid / Pending / Cancelled status derived from the ledger. Credentials embedded only when the settings switch **and** `invoice.credentials` **and** `credentials.view` all allow it. Purchase cost and profit are never in the PDF. `Cache-Control: private, no-store` |

## Contacts (clients and vendors)

`:kind` is `clients` or `vendors`. Permissions resolve per kind (`clients.*` / `vendors.*`), so the
required permission is chosen at request time rather than declared statically.

| Method | Path | Permission | Notes |
|---|---|---|---|
| GET | `/contacts/:kind` | `<kind>.view` | Paged, `?search` |
| POST | `/contacts/:kind` | `<kind>.create` | Optional `idempotencyKey` |
| GET | `/contacts/:kind/:id` | `<kind>.view` | Includes related sales/payment history |
| PUT | `/contacts/:kind/:id` | `<kind>.edit` | Optimistic `version` |
| DELETE | `/contacts/:kind/:id` | `<kind>.delete` | Soft delete |

## Products (pricing catalogue)

| Method | Path | Permission |
|---|---|---|
| GET | `/products` | `products.view` |
| POST | `/products` | `products.manage` |
| PUT | `/products/:id` | `products.manage` |
| DELETE | `/products/:id` | `products.manage` |

## Payments

| Method | Path | Permission | Notes |
|---|---|---|---|
| GET | `/payments` | `sales.view` | Ledger |
| GET | `/payments/client-pending` | `clients.view` | Receivables |
| GET | `/payments/vendor-dues` | `vendors.view` | Payables |
| POST | `/payments/sales/:saleId` | `payments.client.record` or `payments.vendor.record` depending on `partyType` | Rejects an amount over the remaining balance with **409** `PAYMENT_EXCEEDS_BALANCE` |
| POST | `/payments/:id/reverse` | `payments.reverse` | Inserts a reversing row; the original is preserved |

## Expenses

| Method | Path | Permission |
|---|---|---|
| GET | `/expenses` | `expenses.view` |
| POST | `/expenses` | `expenses.manage` |
| PUT | `/expenses/:id` | `expenses.manage` |
| DELETE | `/expenses/:id` | `expenses.manage` |

## Reports

| Method | Path | Permission | Notes |
|---|---|---|---|
| GET | `/reports/summary` | `reports.view` | `?from`, `?to`, `?currency`. `average_invoice` is `ROUND(AVG(...),2)` — required, since raw `AVG()` returns six decimals which `money.js` rejects. Cost/profit only with `profit.view`. **VERIFIED IN PRODUCTION: 200 for PKR/INR/NGN.** |
| GET | `/reports/cashbook` | `cashbook.view` | Date-ranged cash movements |
| GET | `/reports/expiries` | `expiries.view` | `?from`, `?days` |

## Operations

| Method | Path | Permission |
|---|---|---|
| GET | `/operations/tasks` | `tasks.view` |
| POST | `/operations/tasks` | `tasks.manage` |
| PUT | `/operations/tasks/:id` | `tasks.manage` |
| DELETE | `/operations/tasks/:id` | `tasks.manage` |
| GET | `/operations/activities` | `activities.view` |
| POST | `/operations/activities` | `activities.manage` |
| POST | `/operations/reminders/prepare` | `reminders.prepare` |
| POST | `/operations/reminders/:id/opened` | `reminders.prepare` |
| GET | `/operations/saved-views` | `sales.view` |
| POST | `/operations/saved-views` | `sales.view` |
| DELETE | `/operations/saved-views/:id` | `sales.view` |

Reminders **prepare a draft** (a click-to-chat URL and stored message). The CRM does not send
WhatsApp messages itself.

`prepare` returns the composed message and a `wa.me` deep link. The wording is **English only** and
comes from [`reminderTemplates.js`](../../backend/modules/business-crm/reminderTemplates.js) — payment,
renewal, expiring-soon, expired and vendor-due variants. The renewal variant is chosen from the expiry
date, so the wording cannot contradict the date it prints. No template carries credentials, purchase
cost, profit or vendor pricing: a sent message cannot be recalled. The UI shows the draft for review
and only opens WhatsApp from a button press, so the tab is not blocked as an unsolicited popup.

## Website access links

Full behaviour: [`website-access-bridge.md`](website-access-bridge.md).

| Method | Path | Permission | Notes |
|---|---|---|---|
| GET | `/access-links` | `website-access.view` | Filters: `financialStatus`, `accessStatus`, `sourceType`, `search`. Returns rows plus a summary |
| POST | `/access-links/reconcile` | `website-access.reconcile` | Rate-limited to 6/min. Returns **200** even when partial, with `partial: true` and per-source `errors` |
| GET | `/access-links/:id` | `website-access.view` | Single link |
| POST | `/access-links/:id/create-financial-record` | `website-access.financial-link` **and** `sales.create` | Two permission gates. Client and operational dates are forced from the link, never taken from the body. On success returns `{ sale, link, linked, linkError }`; `linked:false` means the sale was created but attaching it failed — retry the attach, do **not** create a second invoice |
| PATCH | `/access-links/:id/non-billable` | `website-access.financial-link` | Refuses if already `LINKED_TO_SALE` |
| PATCH | `/access-links/:id/reopen` | `website-access.financial-link` | Back to `NEEDS_FINANCIAL_DETAILS` |

## Search

| Method | Path | Permission |
|---|---|---|
| GET | `/search` | `dashboard.view` |

## Offline sync

| Method | Path | Permission | Notes |
|---|---|---|---|
| POST | `/sync/batch` | `offline.sync` | Deduplicated by `idempotency_key` in `biz_crm_sync_operations`; a replay returns the stored result |
| GET | `/sync/status` | `offline.sync` | Last 100 operations for the calling user |

## Admin (settings, access, audit, import/export)

| Method | Path | Permission | Notes |
|---|---|---|---|
| GET | `/admin/settings` | `dashboard.view` | |
| PUT | `/admin/settings` | `settings.manage` | |
| GET | `/admin/access` | `access.manage` | Lists existing SUPER_ADMIN/ADMIN/SUPPORT users with their business role and overrides |
| POST | `/admin/access/users` | `access.manage` | **Disabled — returns 405** `CRM_USER_WRITE_DISABLED`. The CRM must not create accounts in the shared `users` table |
| PUT | `/admin/access/:userId` | `access.manage` | Sets business role, active flag and overrides. Owner accounts are protected; self-demotion and self-disable are refused |
| POST | `/admin/access/:userId/reset-password` | `access.manage` | **Disabled — returns 405** `CRM_USER_WRITE_DISABLED`. A reset would bump `tokenVersion` and silently drop a live admin session |
| GET | `/admin/audit` | `audit.view` | Filter by `action` and `actor` |
| POST | `/admin/imports/:kind` | `imports.manage` | `clients`, `vendors` or `products`. Body is raw CSV (`text/csv`, 2 MB, ≤2000 rows) parsed by its own `express.text` parser, so the global 100 KB JSON limit does not apply |
| GET | `/admin/exports/sales.csv` | `exports.download` | Values are neutralised against CSV formula injection |
| GET | `/admin/backup.json` | `backup.download` | Credentials stay AES-GCM ciphertext in the export |
