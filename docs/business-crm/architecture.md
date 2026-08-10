# Business CRM — Architecture

| Field | Value |
|---|---|
| **Purpose** | Explain how the Business CRM is built, which system owns which data, and where the change boundaries are. |
| **Scope** | Frontend structure, backend structure, authentication reuse, data ownership, failure isolation, change boundaries. |
| **Status** | As-built. |
| **Last verified commit** | `8b76b617f67928e6454226d1861f9d35913a3981` |
| **Last verified date** | 2026-08-10 |
| **Source files inspected** | `backend/modules/business-crm/{index,db,permissions,csrf,http,money,audit,encryption,csv,invoicePdf,validation}.js`, `backend/modules/business-crm/routes/*.js`, `backend/modules/business-crm/services/*.js`, `frontend/src/features/business-crm/**`, `frontend/src/pages/admin/AdminBusinessCrm.js`, `frontend/src/App.js`, `frontend/src/components/AdminLayoutEnhanced.js`, `backend/server-crm.js`, `backend/middleware/authEnhanced.js`. |
| **Related documents** | [`system-diagrams.md`](system-diagrams.md), [`data-model.md`](data-model.md), [`website-access-bridge.md`](website-access-bridge.md), [`security.md`](security.md), [`adr/`](adr/) |
| **Owner / maintainer** | Repository owner (`Toolstack7462`). |
| **What this document does not verify** | Runtime behaviour, production configuration, or database contents. |

## One application, one login

The CRM is a workspace **inside** the existing admin application. There is no second login, no second
cookie, no second user table, no CRM subdomain. **VERIFIED FROM CODE.**

```
/admin/login  (existing, unchanged)
      │  sets adminAccessToken + adminRefreshToken (HttpOnly, Secure)
      ▼
AdminRoute  →  server-verified via GET /api/crm/auth/admin/me
      ▼
AdminLayoutEnhanced  (existing shell)
      └── /admin/business/*  →  AdminBusinessCrm → BusinessCrmApp
                                      │ reuses frontend/src/services/api.js
                                      ▼
                            /api/crm/admin/business/*
                                      │ requireAdminAuth (existing middleware)
                                      ▼
                            MySQL/MariaDB — biz_crm_* tables only
```

The API router's first three middlewares, in order (`backend/modules/business-crm/index.js`):

1. Sets `Cache-Control: private, no-store` and `X-Business-CRM-Version: 2.0.0` on every response.
2. `requireAdminAuth` — the **existing** admin middleware from `backend/middleware/authEnhanced.js`.
   The CRM defines no authentication of its own.
3. Ensures the schema, resolves the caller's business role into `req.businessAccess`, and returns
   HTTP 403 `BUSINESS_ACCESS_DISABLED` if that role is `DISABLED`.

Then `GET /bootstrap` (which issues the CSRF token), then a 240-requests-per-minute rate limit keyed
by user id, then `csrf.requireToken`, then the sub-routers. Because `/bootstrap` is mounted *before*
the CSRF check, it is the only endpoint reachable without a CRM CSRF token. **VERIFIED FROM CODE.**

## Who owns which data

This is the single most important rule in the module.

| Data | Owner | The other side |
|---|---|---|
| Who has access to a tool, start date, expiry, revoked/expired status, access mode | **Existing website access system** (`ToolAssignment`, proxy/stealth leases) | The CRM mirrors it read-only and must never write it |
| Sale price, purchase cost, currency, vendor, payments, invoices, profit, expenses | **Business CRM** (`biz_crm_*`) | Never appears on Give Access or assignment screens |
| Admin identity, roles, sessions, cookies | **Existing auth system** (`users` table) | The CRM reads it; the create-user and reset-password endpoints are disabled and return HTTP 405 |
| Business role and permission overrides | **Business CRM** (`biz_crm_user_access`, `biz_crm_user_permissions`) | Does not affect login or the authentication role |

Consequences that follow directly:

- A manual CRM sale creates **no** `ToolAssignment`, proxy client, stealth client, extension
  entitlement, gateway entitlement or portal access. Enforced by
  `backend/tests/businessCrmIsolation.test.js`. **VERIFIED FROM TEST.**
- For a website-linked record the CRM stores financial figures only; operational fields are
  presented read-only and refreshed from the source on each reconciliation.
- The CRM writes only `biz_crm_*` tables — plus `biz_crm_clients.website_user_id` as a nullable
  reference. Enforced by test. **VERIFIED FROM TEST.**

## Backend structure

`backend/modules/business-crm/`

| File | Responsibility |
|---|---|
| `index.js` | Router assembly, middleware order, `/bootstrap`, rate limit, error handler |
| `db.js` | Its **own** `mysql2` pool over the same `DATABASE_URL`; `query`, `withTransaction`, `ensureSchema`, idempotent compatibility `ALTER`s |
| `schema.sql` | All 21 tables, every one `CREATE TABLE IF NOT EXISTS` |
| `permissions.js` | 44 permission keys, 5 role sets, `resolveAccess`, `requirePermission` |
| `csrf.js` | Double-submit CSRF token for CRM mutations |
| `money.js` | Integer-minor-unit money. Rejects anything that is not at most two decimals |
| `encryption.js` | AES-256-GCM for optional credentials; throws HTTP 503 if the vault key is absent or malformed |
| `audit.js` | Audit writes with recursive redaction of password/token/cookie/cipher keys |
| `validation.js` | Joi schemas; currency restricted to PKR/INR/NGN |
| `invoicePdf.js` | PDF generation; excludes purchase cost and profit |
| `csv.js` | CSV parse/serialise with formula-injection neutralisation |
| `http.js` | `asyncHandler`, `pageParams`, `safeLike`, `sendCsv` |
| `routes/*.js` | 12 routers — see [`api-reference.md`](api-reference.md) |
| `services/*.js` | `salesService`, `paymentService`, `contactService`, `expenseService`, `reminderService`, `websiteAccessService` |

Error handling is centralised in `index.js`: an error with a `status` in the 4xx/5xx range is
returned with its own message; anything else becomes a generic 500 with the message
`Business CRM request failed`, and the stack is logged server-side only. `ER_DUP_ENTRY` maps to 409.
**VERIFIED FROM CODE.** That is why a 500 in this module tells you nothing from the response body —
you must read the server log. See [`troubleshooting.md`](troubleshooting.md).

## Frontend structure

`frontend/src/features/business-crm/`

| File | Responsibility |
|---|---|
| `BusinessCrmApp.jsx` | Descendant `<Routes>`; per-route permission `Gate`; `path="*"` → visible `NotFound` |
| `BusinessCrmLayout.jsx` | Sidebar, toolbar, mobile drawer, quick-nav, workspace body class |
| `BusinessCrmContext.jsx` | Bootstrap fetch, CSRF token, currency, online/queue state, `has(permission)` |
| `constants.js` | `BASE`, **`crmPath()`**, grouped `NAV`, `MOBILE_QUICK_NAV`, money/date formatters |
| `api.js` | Thin wrapper over the shared `services/api.js`; attaches the CRM CSRF header |
| `hooks.js` | `useResource`, `useFormState` |
| `components/ui.jsx` | Shared primitives — `Table` emits `td[data-label]`, which the mobile card layout depends on |
| `offline/{db,queue,register}.js` | IndexedDB queue, drain logic, service-worker registration |
| `pages/*.jsx` | 22 pages |
| `business-crm.css` | Base design system |
| `business-crm-responsive.css` | Loaded **second**; supersedes the base file's narrow-screen rules |

### Routing invariant

Every in-CRM navigation target must go through **`crmPath()`**. It is idempotent, normalises leading
slashes, preserves query/hash, and refuses external or pseudo-protocol targets.

This is not stylistic. The CRM renders a descendant `<Routes>` under a splat route, so a *relative*
target resolves against the active route branch and appends a segment instead of replacing it. That
produced dead URLs such as `/admin/business/sales/sales/offline-queue/settings`, and the old
`path="*"` fallback of `<Navigate to=".">` resolved to the current path, redirected to itself and
rendered nothing — the blank-panel symptom. Both are fixed and guarded by
`frontend/src/features/business-crm/__tests__/crmRouting.test.js`. **VERIFIED FROM TEST.**

## Route-scoped workspace mode

`AdminLayoutEnhanced.js` computes `crmWorkspace = location.pathname.startsWith('/admin/business')`
and uses it in exactly three places: the desktop sidebar wrapper class, the `compact` prop on
`SidebarContent`, and the `<main>` padding plus the 1200 px wrapper. Every other admin page is
unaffected. **VERIFIED FROM CODE.**

| Width | Global admin nav | CRM sidebar |
|---|---|---|
| ≥ 1280 px | 72 px icon rail with tooltips | 236 px |
| 1024–1279 px | hidden (Tailwind `xl:`) | 212 px, plus a "Admin Console" button in the CRM toolbar |
| < 1024 px | none | none permanent; focus-trapped drawer + 4-item quick-nav |

Details and the accessibility contract: [`ui-design-system.md`](ui-design-system.md).

## Currency handling

Three ledgers — PKR, INR, NGN — kept strictly separate. Every financial query filters on
`currency_code`, and there is **no conversion anywhere in the module**. Totals from different
currencies are never summed. `money.js` works in integer minor units via `BigInt` and refuses any
value that is not at most two decimal places. See
[`adr/004-multi-currency-no-auto-conversion.md`](adr/004-multi-currency-no-auto-conversion.md).
**VERIFIED FROM CODE.**

Two consequences worth knowing before touching SQL:

- `AVG()` widens `DECIMAL(18,2)` to `DECIMAL(22,6)`, so it **must** be wrapped in `ROUND(...,2)` or
  `money.toMinor` rejects the result with HTTP 400 `INVALID_MONEY`.
- Never write a SQL comment containing a colon inside a `db.query` template literal —
  `mysql2`'s named-placeholder tokenizer does not skip comments, so `name:value` becomes a phantom
  placeholder. Both hazards are covered by `backend/tests/businessCrmRuntimeDefects.test.js`.

## Failure isolation

The CRM is designed so that its failure cannot damage anything else. **VERIFIED FROM CODE.**

- No existing website API calls into the CRM. Reconciliation is pull-only and initiated by the CRM.
- The CRM's `db.js` owns a separate connection pool. Exhausting it does not starve the main adapter.
- `encryption.js` throws a 503 lazily on use, never at import time, so a missing vault key cannot
  prevent the server from booting.
- `websiteAccessService` fetches each source in its own `try/catch`, and skips the
  missing-record sweep entirely if any source errored — so a transient proxy outage cannot mark
  healthy links `SOURCE_MISSING`.
- A vanished website record becomes `SOURCE_MISSING`; it is never deleted, and attached invoices and
  payments survive.

## Change boundaries

### Normally safe (CRM-owned)

```
frontend/src/features/business-crm/**
frontend/src/pages/admin/AdminBusinessCrm.js
frontend/public/admin/business/sw.js
backend/modules/business-crm/**
backend/scripts/business-crm-*.js
```

Run the CRM tests plus the full backend suite and a production build. See [`testing.md`](testing.md).

### Shared — broader regression testing required

| File | CRM footprint |
|---|---|
| `frontend/src/App.js` | one `lazy()` import (line 104) + one `<Route path="/admin/business/*">` (line 193) |
| `frontend/src/components/AdminLayoutEnhanced.js` | one `NAV_ITEMS` entry (line 15) + the `crmWorkspace` branches |
| `frontend/src/services/api.js` | the shared axios client the CRM reuses |
| `backend/server-crm.js` | one `require` (line 337) + one `app.use` (line 388) |

A change here affects every admin and client page. Re-test the non-CRM admin pages, client login and
the public site.

### Protected — do not change while fixing a CRM problem

AdminLogin · client login and portal · Give Access · Assignments · Bulk Assign · Renewals ·
extension · proxy tools · StealthWriter · Claude gateway · device binding · public website ·
every non-`biz_crm_*` table · deployment workflows · dependencies and lockfiles.

If evidence genuinely points at one of these, stop and report it rather than editing it as part of a
CRM fix. No troubleshooting entry in this set recommends touching a protected system.

## Known architectural wart

`routes/dashboard.js` builds its response object with the key `today` twice — first the date string,
then an object. The second wins, so the date string never reaches the client. Harmless today, and
left alone because changing it alters the API response shape. **VERIFIED FROM CODE.** Recorded in
[`known-issues.md`](known-issues.md).
