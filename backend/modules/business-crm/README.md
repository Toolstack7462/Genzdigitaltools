# Business CRM — backend module map

| Field | Value |
|---|---|
| **Purpose** | Local map of this directory, so you can find the right file fast. |
| **Scope** | `backend/modules/business-crm/` only. |
| **Status** | As-built. |
| **Last verified commit** | `8b76b617f67928e6454226d1861f9d35913a3981` |
| **Last verified date** | 2026-08-10 |
| **Source files inspected** | Every file in this directory. |
| **Related documents** | Full set: [`../../../docs/business-crm/README.md`](../../../docs/business-crm/README.md) · [`architecture`](../../../docs/business-crm/architecture.md) · [`api-reference`](../../../docs/business-crm/api-reference.md) · [`data-model`](../../../docs/business-crm/data-model.md) · [`troubleshooting`](../../../docs/business-crm/troubleshooting.md) |
| **Owner / maintainer** | Repository owner (`Toolstack7462`). |
| **What this document does not verify** | Runtime or production behaviour. This is a directory map. |

Mounted once, at `/api/crm/admin/business`, from `backend/server-crm.js`. This module writes **only**
`biz_crm_*` tables.

## Files

| File | Responsibility |
|---|---|
| `index.js` | Router assembly and middleware order; `/bootstrap`; rate limit; central error handler |
| `db.js` | Its own `mysql2` pool; `query`, `withTransaction`, `ensureSchema`, idempotent compatibility `ALTER`s |
| `schema.sql` | All 21 tables, every one `CREATE TABLE IF NOT EXISTS` |
| `permissions.js` | 44 permission keys, 5 role sets, `resolveAccess`, `requirePermission` |
| `csrf.js` | Double-submit CSRF token |
| `money.js` | Integer minor-unit money; refuses more than two decimals |
| `encryption.js` | AES-256-GCM for item credentials; lazy 503 if the vault key is missing |
| `audit.js` | Audit writes with recursive secret redaction |
| `validation.js` | Joi schemas; currency limited to PKR/INR/NGN |
| `invoicePdf.js` | Branded invoice PDF (logo, brand palette, payment status); never includes purchase cost or profit |
| `invoiceLogo.js` | Decodes `assets/invoice-logo.png` for PDF embedding. **Fixed path only** — never `settings.logo_url`, never a URL. Returns `null` on failure so an invoice still renders |
| `reminderTemplates.js` | English customer message wording — seven templates. Pure and unit-tested. Masks account emails; never a password, cost or profit. Exports `formatDate`, `formatAmount`, `maskEmail`, `itemList` |
| `csv.js` | CSV parse/serialise with formula-injection neutralisation |
| `http.js` | `asyncHandler`, `pageParams`, `safeLike`, `sendCsv` |

### `routes/`

| File | Mounted at |
|---|---|
| `dashboard.js` | `/dashboard` |
| `sales.js` | `/sales` (includes `/:id/invoice.pdf`) |
| `contacts.js` | `/contacts/:kind` — `clients` or `vendors` |
| `products.js` | `/products` |
| `payments.js` | `/payments` |
| `expenses.js` | `/expenses` |
| `reports.js` | `/reports` — `summary`, `cashbook`, `expiries` |
| `operations.js` | `/operations` — tasks, activities, reminders, saved views |
| `accessLinks.js` | `/access-links` — the website access bridge |
| `search.js` | `/search` |
| `sync.js` | `/sync` — offline queue |
| `admin.js` | `/admin` — settings, access, audit, imports, exports, backup |

### `services/`

| File | Responsibility |
|---|---|
| `salesService.js` | Sale creation/update, invoice numbering, item protection, opening payments |
| `paymentService.js` | Receipts, vendor payments, reversals, balance guards |
| `contactService.js` | Client/vendor creation shared by both kinds |
| `expenseService.js` | Expense writes |
| `reminderService.js` | Prepares WhatsApp/email reminder drafts |
| `websiteAccessService.js` | **The only file allowed to read website access models.** Read-only |

## Rules for this directory

1. Write only `biz_crm_*` tables.
2. Only `websiteAccessService.js` may import `ToolAssignment`, `ProxyClient` or `StealthClient`, and it
   must never write them.
3. Schema changes are additive: `CREATE TABLE IF NOT EXISTS`, or a defaulted column in
   `ensureCompatibilityColumns()`. Never `DROP`, `TRUNCATE` or `RENAME`.
4. Never compare a string-returning SQL function to a bound parameter — collation mismatch. Use
   half-open date ranges.
5. Never put a colon inside a SQL comment in a `db.query` template literal — `mysql2` reads it as a
   placeholder. Put the explanation in a JS comment instead.
6. Wrap every `AVG()` in `ROUND(...,2)`. Do not loosen `money.js`.
7. Never write the shared `users` table.

Rules 1, 2, 3 and 7 are enforced by `backend/tests/businessCrmIsolation.test.js`; rules 4, 5 and 6 by
`backend/tests/businessCrmRuntimeDefects.test.js`. Both run in `npm test`.

## Before committing

```bash
cd backend && npm test
cd backend && node --check modules/business-crm/routes/<changed>.js
```
