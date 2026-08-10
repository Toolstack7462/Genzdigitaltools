# Business CRM — Troubleshooting

| Field | Value |
|---|---|
| **Purpose** | Diagnose Business CRM problems safely, without touching systems that are not at fault. |
| **Scope** | CRM symptoms only. Nothing here recommends editing a protected system. |
| **Status** | As-built. Entries marked **RESOLVED** describe fixed defects and their guards, not open bugs. |
| **Last verified commit** | `8b76b617f67928e6454226d1861f9d35913a3981` |
| **Last verified date** | 2026-08-10 |
| **Source files inspected** | `backend/modules/business-crm/**`, `frontend/src/features/business-crm/**`, `frontend/public/admin/business/sw.js`, `backend/tests/businessCrm{Isolation,RuntimeDefects}.test.js`, `frontend/src/features/business-crm/__tests__/crmRouting.test.js`. |
| **Related documents** | [`operations-runbook.md`](operations-runbook.md), [`testing.md`](testing.md), [`known-issues.md`](known-issues.md), [`architecture.md#change-boundaries`](architecture.md#change-boundaries) |
| **Owner / maintainer** | Repository owner (`Toolstack7462`). |
| **What this document does not verify** | That each listed cause is the cause in your specific incident. Reproduce first. |

## Read before changing anything

1. **A CRM 500 tells you nothing from the response body.** `index.js` deliberately returns a generic
   `Business CRM request failed`. The real error is in the server log only. Get the log first.
2. **Never change a protected system to fix a CRM symptom.** AdminLogin, client portal, Give Access,
   Assignments, Bulk Assign, Renewals, extension, proxy, StealthWriter, Claude gateway, device
   binding, public website. If evidence genuinely points there, stop and report it.
3. **Reproduce before fixing.** Two production defects in this module were misdiagnosed by reading
   code alone; both needed the log or a rendered measurement.

## Where the log is

The live backend runs from Hostinger's versioned build, **not** the older `nodejs/` directory, which
is a stale copy. Read the log belonging to the current build:

```
~/domains/api.genzdigitalstore.com/hbuilds/current/nodejs/console.log
```

Filter for `[Business CRM` — every 5xx is logged with a request id and stack. Do not paste raw log
output into tickets; it contains client identifiers. **VERIFIED IN PRODUCTION.**

---

## CRM blank white panel

**Symptom** — CRM shell and sidebar visible, content area empty white.

**Likely causes** — (a) navigation landed on a path matching no route; (b) a page threw during
render; (c) the bootstrap request failed so the layout is stuck.

**How to reproduce** — open `/admin/business/definitely-not-a-real-page`. Correct behaviour is the
visible "That Business CRM page does not exist" state, **not** a blank panel.

**First safe checks** — read the URL for repeated segments; open DevTools Console for a React error;
check Network for `/bootstrap` status.

**Exact likely files** — `frontend/src/features/business-crm/BusinessCrmApp.jsx` (the `path="*"`
route), `pages/NotFound.jsx`, `BusinessCrmLayout.jsx`, the specific page component.

**Must remain untouched** — `App.js` beyond the single existing CRM route; `AdminRoute.js`;
authentication.

**Safe correction** — ensure the wildcard route renders `NotFound`, never `<Navigate to=".">`.

**Required tests** — `crmRouting.test.js`, full frontend suite, production build.

**Deployment impact** — frontend only; the GitHub Action deploys on `frontend/**` changes.

**Rollback** — `git revert` the release commit; the Action redeploys.

> **RESOLVED (`dea93fe`).** The historical cause was `<Navigate to="." replace />` on `path="*"`:
> `"."` resolves to the current path, so it redirected to itself and rendered nothing. Now a visible
> `NotFound` page. Protected invariant — do not reintroduce a relative fallback.

---

## Accumulated route segments

**Symptom** — URLs grow: `/admin/business/sales/sales/offline-queue/settings`.

**Likely causes** — a **relative** navigation target somewhere in the CRM.

**How to reproduce** — click a sidebar item, then another, and watch the URL.

**First safe checks** — search the feature for a `to=` or `navigate(` argument that is not
`crmPath(...)`, not an absolute `/admin/...` literal, and not a numeric history delta.

**Exact likely files** — `BusinessCrmLayout.jsx`, `constants.js` (`crmPath`), any
`pages/*.jsx` that navigates.

**Must remain untouched** — `App.js` route definition; `AdminLayoutEnhanced.js` navigation.

**Safe correction** — route every CRM target through `crmPath()`. It is idempotent, so passing an
already-absolute CRM path back through it cannot duplicate the base.

**Required tests** — `crmRouting.test.js` (its source scan fails on any relative target).

**Deployment impact / rollback** — frontend only; revert the commit.

> **RESOLVED (`dea93fe`).** Cause: `<NavLink to={path}>` with a bare segment inside a descendant
> `<Routes>` under a splat route. `crmPath()` and the source-scanning test are protected invariants.

---

## Deep-link refresh fails

**Symptom** — `/admin/business/reports` works by clicking but 404s on refresh.

**Likely causes** — the static host is not rewriting unknown paths to `index.html`.

**First safe checks** — `curl -s -o /dev/null -w "%{http_code}" https://app.genzdigitalstore.com/admin/business/reports`
should be **200** and serve the app shell. Verified working on 2026-08-10.

**Exact likely files** — the deployed `.htaccess` in the frontend web root. **Not** a CRM file.

**Must remain untouched** — CRM code. This is hosting configuration; do not "fix" it in React.

**Safe correction** — none inside the CRM. Report it as a hosting/rewrite issue.

**Required tests** — after any hosting change, re-check every deep link in
[`operations-runbook.md`](operations-runbook.md).

---

## 401 on CRM requests

**Symptom** — CRM calls return 401; the workspace bounces to login.

**Likely causes** — expired session; cookies not sent (third-party cookie blocking, since the API is
a different subdomain and cookies are `SameSite=None`); clock skew.

**First safe checks** — call `GET /api/crm/auth/admin/me` from the app origin; confirm both admin
cookies exist with `HttpOnly`, `Secure`, `SameSite=None`; try a fresh private window.

**Exact likely files** — none in the CRM. The CRM adds no authentication.

**Must remain untouched** — `backend/middleware/authEnhanced.js`, auth routes, cookie settings,
`AdminRoute.js`. Do **not** change shared auth to fix a CRM symptom.

**Safe correction** — none inside the CRM; escalate as an authentication issue with evidence.

**Required tests** — full backend suite if auth is ever touched, plus admin **and** client login.

---

## 403 on CRM requests

**Symptom** — `BUSINESS_PERMISSION_DENIED`, or `BUSINESS_ACCESS_DISABLED`.

**Likely causes** — the role genuinely lacks the permission; a `deny` override; the CRM access row
has `active = 0`.

**First safe checks** — `GET /bootstrap` and read `access.role` and `access.permissions`; compare
against [`rbac-matrix.md`](rbac-matrix.md); check `biz_crm_user_access` / `biz_crm_user_permissions`.

**Exact likely files** — `permissions.js` (only if a role definition is genuinely wrong),
`routes/admin.js` (`PUT /admin/access/:userId`) to change a user's role properly.

**Must remain untouched** — the shared `users` table. Note `POST /admin/access/users` and the
password-reset endpoint intentionally return **405**; that is not a bug.

**Safe correction** — grant via the Team & Permissions page. Widening a role in `permissions.js`
is a security change: justify it, and update [`rbac-matrix.md`](rbac-matrix.md).

**Required tests** — backend suite; verify 403 still holds for roles that should not have the key.

---

## `VAULT_NOT_CONFIGURED` (HTTP 503)

**Symptom** — 503 with code `VAULT_NOT_CONFIGURED` when saving or reading item credentials.
Everything else works.

**Likely causes** — `BUSINESS_CRM_VAULT_KEY` missing, or not exactly 64 hexadecimal characters.

**First safe checks** — confirm whether the running process has the variable. **Never print it.**
Check only presence and whether it matches `^[0-9a-fA-F]{64}$`.

**Exact likely files** — `backend/modules/business-crm/encryption.js` (read it to confirm the
contract; do not weaken it). Generate a key with `node backend/scripts/business-crm-key.js`.

**Must remain untouched** — do not disable encryption, shorten the key check, or store credentials in
plaintext. Do not commit the key.

**Safe correction** — set the variable in the hosting environment and restart. This is configuration,
not code.

**Required tests** — after configuring, save and read back a credential on a **test** record only.

**Deployment impact** — environment change plus restart; no code release.

**Rollback** — remove the variable; the module returns to 503 for credentials only.

> Current status: **PRODUCTION STATUS UNKNOWN.** Not present in the deploy-time env file inspected on
> 2026-08-10; it may come from the process environment.

---

## Missing or incomplete `biz_crm_*` schema

**Symptom** — 500s mentioning an unknown table or column.

**Likely causes** — `ensureSchema()` never ran successfully; the DB user lacks `CREATE`; a partial
earlier failure.

**First safe checks** — count tables:
`SELECT COUNT(*) FROM information_schema.TABLES WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME LIKE 'biz_crm_%'`
— expect **21**. Read `biz_crm_schema_migrations` — expect `2.0.0`. Both were observed correct in
production on 2026-08-10.

**Exact likely files** — `backend/modules/business-crm/schema.sql`, `db.js`
(`ensureSchema`, `ensureCompatibilityColumns`), `backend/scripts/business-crm-migrate.js`.

**Must remain untouched** — every non-`biz_crm_*` table. Never `DROP`, `TRUNCATE` or `RENAME`.

**Safe correction** — add the missing object as `CREATE TABLE IF NOT EXISTS`, or a defaulted column
via `ensureCompatibilityColumns`. Take a backup first.

**Required tests** — `businessCrmIsolation.test.js` (schema additivity), then the migration script
twice to prove idempotency.

**Deployment impact** — schema changes apply on the first CRM request after deploy. **Back up first.**

**Rollback** — additive objects can be left in place; they are inert once the route is unmounted.

---

## Website Access record missing

**Symptom** — an assignment exists on the website but no row appears in Website Access.

**Likely causes** — reconciliation has not run; the source errored so the row was never upserted;
the record is filtered out by the active filter; permission missing.

**First safe checks** — press **Reconcile now** and read the response: `scanned`, `created`,
`updated`, `partial`, `errors`, `sweepSkipped`. Set the filter to **All**. Confirm the caller holds
`website-access.view` (and `.reconcile` to trigger it).

**Exact likely files** — `services/websiteAccessService.js` (collectors), `routes/accessLinks.js`,
`pages/LinkedAccess.jsx`.

**Must remain untouched** — `backend/routes/admin/assignments.js`, `backend/utils/proxyAssignments.js`,
`backend/models/ToolAssignment.js`. The bridge reads them; it must not change them.

**Safe correction** — fix the collector or the filter. If a source is erroring, the response's
`errors[].source` names it.

**Required tests** — `businessCrmIsolation.test.js` (no write to website models), backend suite.

---

## Duplicate reconciliation concern

**Symptom** — worry that repeated reconciliation double-creates rows or invoices.

**Why it cannot** — `biz_crm_access_links.external_key` is `UNIQUE` and every upsert keys on it, so a
second run updates rather than inserts. Financial linkage is never overwritten.
**VERIFIED FROM CODE.**

**First safe checks** — run reconcile twice and compare `created` (expect 0 the second time) and the
row count.

**Exact likely files** — `services/websiteAccessService.js` (`upsertRecord`).

**Must remain untouched** — the `UNIQUE` constraint. Removing it would break the guarantee.

**One genuine duplicate risk** — an operator submitting *Complete Financial Details* twice after a
`linked: false` response. The endpoint returns 201 with `linked: false` precisely so this is visible;
retry the attach, do not resubmit the form.

---

## Wrong expiry or status on a linked record

**Symptom** — CRM shows a different expiry or status than the website admin pages.

**Likely causes** — reconciliation has not run since the change; someone duplicated expiry logic
instead of reusing the model helpers.

**First safe checks** — reconcile, then compare with `/admin/assignments`. Remember the inclusive
end-of-day rule: a date-only expiry stays valid for the whole calendar day.

**Exact likely files** — `services/websiteAccessService.js` (`coreAccessStatus`, `proxyAccessStatus`).

**Must remain untouched** — `backend/models/ToolAssignment.js`. The bridge must keep calling
`effectiveEndBoundary()` / `isAssignmentExpired()` rather than reimplementing them.

**Safe correction** — restore delegation to the model helpers.

**Required tests** — backend suite; verify the CRM and the assignments page agree.

---

## Invoice PDF failure

**Symptom** — the invoice endpoint errors or returns something unopenable.

**Likely causes** — the sale is missing or soft-deleted; a permission gate; a vault error when
credentials were requested.

**First safe checks** — confirm `invoice.view`; fetch the sale JSON first; retry **without**
`?credentials=1` — if that succeeds, the fault is the vault, not the PDF.

**Exact likely files** — `invoicePdf.js`, `routes/sales.js`.

**Must remain untouched** — the rule that purchase cost and profit never appear in a PDF.

**Required tests** — backend suite (the package's core tests assert the PDF excludes cost/profit and
that credentials appear only when explicitly requested).

---

## Payment balance mismatch

**Symptom** — `client_paid` / `vendor_paid` disagree with the payment rows.

**Likely causes** — a write path that inserted a payment without updating the sale totals; reversal
rows not accounted for in a query.

**First safe checks** — sum `biz_crm_payments` for the sale by `party_type`, **including** reversal
rows, and compare with the sale's stored totals.

**Exact likely files** — `services/paymentService.js`, `services/salesService.js` (opening payments).

**Must remain untouched** — the additive reversal model. Never delete or mutate an original payment.

**Safe correction** — route every payment write through `paymentService` so totals stay maintained.

**Required tests** — backend suite; verify the overpayment guard still returns 409
`PAYMENT_EXCEEDS_BALANCE`.

---

## Currency totals appear mixed

**Symptom** — a figure looks like PKR and INR added together.

**Likely causes** — a query missing its `currency_code` filter, or a client-side sum across rows of
different currencies.

**First safe checks** — switch the reporting currency and confirm each figure changes independently.

**Exact likely files** — `routes/reports.js`, `routes/dashboard.js`, `services/*`, and any page that
aggregates client-side.

**Must remain untouched** — the no-conversion rule. Do **not** add exchange rates to "fix" this. See
[`adr/004-multi-currency-no-auto-conversion.md`](adr/004-multi-currency-no-auto-conversion.md).

**Safe correction** — add the missing `currency_code` predicate.

**Required tests** — backend suite; check the same range in all three currencies.

---

## Offline queue stuck

**Symptom** — the connection pill shows pending syncs that never clear.

**Likely causes** — genuinely offline; the caller lacks `offline.sync`; a queued operation fails
server-side every attempt.

**First safe checks** — open Offline Queue; call `GET /sync/status` for the last 100 operations and
their stored results; confirm `offline.sync`.

**Exact likely files** — `frontend/src/features/business-crm/offline/{queue,db}.js`,
`backend/modules/business-crm/routes/sync.js`.

**Must remain untouched** — the idempotency ledger (`biz_crm_sync_operations`). Clearing it invites
duplicate financial writes.

**Safe correction** — surface the failing operation's error. Retries must stay finite and idempotent.

**Required tests** — backend suite; replay the same batch twice and confirm no duplicate write.

---

## Service worker serving a stale asset

**Symptom** — suspicion that an old CRM bundle is being served after a deploy.

**Why it is unlikely** — `sw.js` is **network-first**: it always `fetch()`es and only falls back to
cache on network failure. It skips `/api/` entirely and skips cross-origin. It calls `skipWaiting()`
and `clients.claim()`, and on activate deletes every cache except the current one.
**VERIFIED FROM CODE and VERIFIED IN PRODUCTION** (Cache Storage held one cache with **no** `/api/`
entries). Hashed filenames also make stale-hash collisions impossible.

**First safe checks** — compare the `main.*.js` filename in the served HTML with the built asset
manifest; DevTools → Application → Service Workers; then Empty Cache and Hard Reload.

**Exact likely files** — `frontend/public/admin/business/sw.js`, `offline/register.js`.

**Must remain untouched** — the scope. It must stay `/admin/business/` so it can never affect other
admin pages. Never cache `/api/` responses.

---

## Mobile horizontal overflow

**Symptom** — the page scrolls sideways on a phone.

**Likely causes** — a fixed-width table or an unbroken long identifier.

**First safe checks** — compare `documentElement.scrollWidth` with `clientWidth` at 320/360/390/412 px.
Measured 0 overflow at all four on 2026-08-10.

**Exact likely files** — `business-crm-responsive.css`, `components/ui.jsx`.

**Must remain untouched** — do **not** add a blanket `overflow-x: hidden`; that hides the symptom.
Fix the source, as the existing `overflow-wrap` rules do.

**Required tests** — measure rendered widths at all four viewports.

---

## Two full text sidebars / squeezed content

**Symptom** — the admin sidebar and the CRM sidebar both show full labels.

**Likely causes** — the `crmWorkspace` branch in `AdminLayoutEnhanced.js` is not applying.

**First safe checks** — at ≥1280 px the admin rail should measure ~72 px and the CRM sidebar ~236 px;
between 1024–1279 px the admin rail should be hidden and a "Admin Console" button visible.

**Exact likely files** — `frontend/src/components/AdminLayoutEnhanced.js` (route-scoped branches),
`business-crm-responsive.css`.

**Must remain untouched** — non-CRM admin layout. The change must stay gated on
`location.pathname.startsWith('/admin/business')`; verify another admin page still renders the full
224 px sidebar.

**Required tests** — frontend suite; measure both a CRM page and a non-CRM admin page.

> **RESOLVED (`dea93fe`).** Route-scoped workspace mode.

---

## Infinite loading or request loop

**Symptom** — a spinner that never resolves, or repeating identical requests.

**Likely causes** — a `useEffect` dependency that changes every render; a retry without a ceiling; a
failing bootstrap leaving the layout in its loading branch.

**First safe checks** — count requests per page load in DevTools. Measured maximum on 2026-08-10 was
**22** per page over a 1.2 s dwell, with none above 40.

**Exact likely files** — `BusinessCrmContext.jsx`, `hooks.js` (`useResource` dependencies), the page
component, `pages/LinkedAccess.jsx` (it reconciles on mount).

**Must remain untouched** — authentication refresh logic.

**Safe correction** — stabilise the dependency array; keep retries finite.

**Required tests** — frontend suite; re-count requests per page.

---

## Issue map

| Symptom | Component | Likely files | Do not touch | Tests | Rollback |
|---|---|---|---|---|---|
| Blank panel | CRM routing | `BusinessCrmApp.jsx`, `NotFound.jsx` | `App.js` route, auth | `crmRouting.test.js` | revert commit |
| URL accumulation | CRM routing | `constants.js`, `BusinessCrmLayout.jsx` | `App.js`, admin nav | `crmRouting.test.js` | revert commit |
| Deep-link refresh | Hosting rewrite | deployed `.htaccess` | all CRM code | deep-link sweep | hosting config |
| 401 | Shared auth | none in CRM | `authEnhanced.js`, cookies | full backend | n/a |
| 403 | CRM RBAC | `permissions.js`, `routes/admin.js` | `users` table | backend suite | revert commit |
| 503 vault | Encryption config | env only | `encryption.js` contract | credential round-trip | unset variable |
| Schema gaps | CRM schema | `schema.sql`, `db.js` | non-CRM tables | isolation test | additive, inert |
| Missing link row | Access bridge | `websiteAccessService.js` | `assignments.js`, `proxyAssignments.js` | isolation test | revert commit |
| Duplicate concern | Access bridge | `upsertRecord` | the `UNIQUE` key | run reconcile twice | n/a |
| Wrong expiry | Access bridge | `coreAccessStatus` | `ToolAssignment.js` | backend suite | revert commit |
| PDF failure | Invoice | `invoicePdf.js` | cost/profit exclusion | backend suite | revert commit |
| Balance mismatch | Payments | `paymentService.js` | reversal model | backend suite | revert commit |
| Mixed currency | Reports | `reports.js`, `dashboard.js` | no-conversion rule | 3-currency check | revert commit |
| Queue stuck | Offline sync | `offline/queue.js`, `routes/sync.js` | idempotency ledger | replay batch | revert commit |
| Stale asset | Service worker | `sw.js` | scope, `/api/` skip | bundle compare | revert commit |
| Mobile overflow | Responsive CSS | `business-crm-responsive.css` | blanket `overflow-x` | width measurement | revert commit |
| Double sidebar | Workspace mode | `AdminLayoutEnhanced.js` | non-CRM layout | frontend suite | revert commit |
| Request loop | Context/hooks | `BusinessCrmContext.jsx`, `hooks.js` | auth refresh | request count | revert commit |
