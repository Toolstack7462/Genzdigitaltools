# Business CRM — RBAC Matrix

| Field | Value |
|---|---|
| **Purpose** | Define the CRM's roles, the 44 permission keys, and exactly what each role can and cannot do. |
| **Scope** | CRM authorisation only. Login and authentication roles are out of scope. |
| **Status** | As-built, computed from `permissions.js`. |
| **Last verified commit** | `8b76b617f67928e6454226d1861f9d35913a3981` |
| **Last verified date** | 2026-08-10 |
| **Source files inspected** | `backend/modules/business-crm/permissions.js`, `routes/admin.js`, `services/salesService.js`, `invoicePdf.js`, `frontend/src/features/business-crm/{BusinessCrmContext.jsx,BusinessCrmApp.jsx,pages/AccessPage.jsx}`. |
| **Related documents** | [`api-reference.md`](api-reference.md), [`security.md`](security.md), [`architecture.md`](architecture.md) |
| **Owner / maintainer** | Repository owner (`Toolstack7462`). |
| **What this document does not verify** | Runtime enforcement for MANAGER, STAFF and VIEWER. Only a SUPER_ADMIN → OWNER session was exercised in production, so lower-role 401/403 behaviour is **NOT VERIFIED** at runtime although it is VERIFIED FROM CODE. |

## How a role is decided

`resolveAccess(user)` in `permissions.js`, in this order. **VERIFIED FROM CODE.**

1. Read `biz_crm_user_access` for the user id.
2. If that row exists and `active = 0` → role `DISABLED`, permission set empty, and the router
   returns **403** `BUSINESS_ACCESS_DISABLED`.
3. Otherwise use the stored `business_role`, or fall back from the **authentication** role:
   `SUPER_ADMIN → OWNER`, `ADMIN → ADMIN`, anything else (including `SUPPORT`) `→ STAFF`.
4. Start from that role's permission set, then apply `biz_crm_user_permissions` overrides —
   `allow` adds a key, `deny` removes it. Unknown keys are ignored.

So a user with no CRM row still gets a sensible default from their existing admin role. Business
roles never affect login.

## Role sizes

| Role | Permissions | Meaning |
|---|---|---|
| OWNER | **44 / 44** | Everything |
| ADMIN | **44 / 44** | Everything (same set as OWNER; they differ only in owner-account protection, below) |
| MANAGER | **39 / 44** | Operations and finance, no destructive or administrative control |
| STAFF | **19 / 44** | Day-to-day sales entry; no cost, profit, credentials or vendor data |
| VIEWER | **13 / 44** | Read-only |

OWNER and ADMIN hold identical permission sets. The distinction is enforced separately in
`routes/admin.js`: only a caller whose business role is `OWNER` may manage an account that is (or is
becoming) `OWNER`, and an active owner cannot demote themselves. **VERIFIED FROM CODE.**

## What MANAGER cannot do

Exactly five keys are withheld:

```
sales.delete   credentials.manage   settings.manage   access.manage   backup.download
```

A MANAGER can therefore record and reverse payments, see cost and profit, run reports and reconcile
website access — but cannot delete a sale, manage stored credentials, change store settings, manage
team access, or download a full backup.

## What STAFF cannot do

25 keys are withheld. This is the security-relevant list:

```
sales.cancel            sales.delete           credentials.view      invoice.credentials
clients.delete          vendors.view           vendors.create        vendors.edit
vendors.delete          products.manage        payments.vendor.record
payments.reverse        expenses.view          expenses.manage       reports.view
profit.view             cashbook.view          imports.manage        exports.download
settings.manage         access.manage          audit.view            backup.download
website-access.reconcile   website-access.financial-link
```

STAFF therefore **cannot** see purchase cost or profit, cannot see or manage credentials, cannot
reverse a payment, cannot see any vendor data, cannot read reports/cashbook/audit, cannot manage
users, and cannot attach money to a website access record or trigger reconciliation. They can view
website access records.

There is an additional guard beyond the permission list: in `salesService.protectedItems`, a caller
without `profit.view` may only add catalogue products and cannot supply a custom `purchaseCost` —
attempting it returns **403** `CUSTOM_COST_REQUIRES_MANAGER`. **VERIFIED FROM CODE.**

## What VIEWER can do

Exactly 13 read-only keys:

```
dashboard.view   sales.view      invoice.view    clients.view    vendors.view
products.view    expiries.view   expenses.view   reports.view    cashbook.view
tasks.view       activities.view website-access.view
```

VIEWER holds `reports.view` but **not** `profit.view`, so reports render revenue and collections with
cost and profit omitted server-side. VIEWER has no write permission of any kind, cannot reconcile,
cannot see credentials, and cannot read the audit log.

## Full permission catalogue

44 keys, grouped by area.

| Area | Keys |
|---|---|
| Dashboard | `dashboard.view` |
| Sales | `sales.view`, `sales.create`, `sales.edit`, `sales.cancel`, `sales.delete` |
| Credentials | `credentials.view`, `credentials.manage` |
| Invoice | `invoice.view`, `invoice.credentials` |
| Clients | `clients.view`, `clients.create`, `clients.edit`, `clients.delete` |
| Vendors | `vendors.view`, `vendors.create`, `vendors.edit`, `vendors.delete` |
| Products | `products.view`, `products.manage` |
| Payments | `payments.client.record`, `payments.vendor.record`, `payments.reverse` |
| Reminders / expiry | `reminders.prepare`, `expiries.view` |
| Expenses / reporting | `expenses.view`, `expenses.manage`, `reports.view`, `profit.view`, `cashbook.view` |
| Tasks / activities | `tasks.view`, `tasks.manage`, `activities.view`, `activities.manage` |
| Import / export | `imports.manage`, `exports.download`, `backup.download` |
| Administration | `settings.manage`, `access.manage`, `audit.view` |
| Offline | `offline.sync` |
| Website access | `website-access.view`, `website-access.reconcile`, `website-access.financial-link` |

## Server-side redaction, not just hidden buttons

The frontend hides controls the caller cannot use, but the **server** removes the data. Do not treat
UI hiding as the control. **VERIFIED FROM CODE.**

| Without | The server omits |
|---|---|
| `profit.view` | `subtotal_cost`, `gross_profit`, `net_profit`, and `purchase_cost` on every item |
| `vendors.view` | every `vendor_*` field, `vendor_paid`, `vendor_due`, and all vendor payment rows |
| `credentials.view` | decrypted credentials; only `has_credential_email` / `has_credential_password` booleans remain |
| `audit.view` | the dashboard `activities` array (returned as `[]`) |
| `expenses.view` | the month expense figure on the dashboard |

The invoice PDF never contains purchase cost or profit for any role.
**VERIFIED FROM TEST** (`tests/core.test.js` in the source package asserts this).

## Frontend gating

`BusinessCrmApp.jsx` wraps each route in a `Gate` that redirects to `/admin/business/forbidden` when
`crm.has(permission)` is false. `constants.js` gives every sidebar entry a permission, so the
navigation itself is filtered. `BusinessCrmContext.has()` reads the permission list the server
returned from `/bootstrap` — the client never computes its own permissions.
**VERIFIED FROM CODE.**

## Testing roles properly

Test the API directly, not the UI. A hidden button proves nothing.

```
# expect 403 for a role lacking the permission
GET /api/crm/admin/business/reports/summary      # STAFF should be refused
GET /api/crm/admin/business/admin/audit          # STAFF and VIEWER should be refused
POST /api/crm/admin/business/access-links/reconcile   # STAFF and VIEWER should be refused
```

Unauthenticated requests must return **401**. Note that a request from a **non-approved browser
origin** currently returns 500 rather than 403 because the global CORS callback rejects with an
`Error` — see [`known-issues.md`](known-issues.md). The approved application origin correctly
receives 401/403. **VERIFIED IN PRODUCTION.**
