# Business CRM — Testing

| Field | Value |
|---|---|
| **Purpose** | State which tests exist, which to run for a given change, and what is genuinely untested. |
| **Scope** | CRM tests and the gates a CRM change must pass. |
| **Status** | As-built. |
| **Last verified commit** | `8b76b617f67928e6454226d1861f9d35913a3981` |
| **Last verified date** | 2026-08-10 |
| **Source files inspected** | `backend/tests/businessCrmIsolation.test.js`, `backend/tests/businessCrmRuntimeDefects.test.js`, `backend/package.json`, `frontend/src/features/business-crm/__tests__/crmRouting.test.js`, `frontend/package.json`, `.github/workflows/deploy-frontend.yml`. |
| **Related documents** | [`operations-runbook.md`](operations-runbook.md), [`troubleshooting.md`](troubleshooting.md), [`known-issues.md`](known-issues.md) |
| **Owner / maintainer** | Repository owner (`Toolstack7462`). |
| **What this document does not verify** | Database-backed behaviour. No test in this repository connects to MySQL, so no financial workflow is covered end-to-end. |

## Commands

```bash
# Backend — full suite (includes the CRM tests)
cd backend && npm test                     # 365 tests

# Backend — CRM only
cd backend && node --test tests/businessCrmIsolation.test.js
cd backend && node --test tests/businessCrmRuntimeDefects.test.js
cd backend && node --test tests/businessCrmSearch.test.js
cd backend && node --test tests/businessCrmInvoiceReminders.test.js

# Backend — syntax
cd backend && node --check modules/business-crm/routes/<file>.js

# Frontend — full suite (includes the CRM routing tests)
cd frontend && CI=true npx craco test --watchAll=false     # 77 tests

# Frontend — CRM only
cd frontend && CI=true npx craco test --testPathPattern="crmRouting|crmSearch|crmInvoiceReminders" --watchAll=false

# Frontend — production build, exactly as CI builds it
cd frontend && CI=false GENERATE_SOURCEMAP=false npm run build
```

**Use `CI=false` for the build.** With `CI=true`, CRA treats warnings as errors and the build fails on
**pre-existing** `react-hooks/exhaustive-deps` warnings in about ten unrelated admin and client pages.
The deploy workflow sets `CI: 'false'`, so that is the honest gate. **VERIFIED FROM CODE.**

Counts at the verified commit: **333 backend, 41 frontend, 0 failures.** **VERIFIED FROM TEST.**

## The CRM test suites

### `backend/tests/businessCrmIsolation.test.js` — 9 tests

Structural guards on the module's boundaries. These are the tests that stop the CRM from quietly
becoming something that writes the website access system.

| Guarantee |
|---|
| Only `websiteAccessService.js` may import a website access model |
| That service performs no write call against a website model |
| The bridge writes only `biz_crm_*` tables |
| `schema.sql` has no `DROP` / `TRUNCATE` / `RENAME`, every `CREATE TABLE` is `IF NOT EXISTS`, every `ALTER` targets `biz_crm_*`, and `biz_crm_access_links` exists |
| `db.js` compatibility `ALTER`s touch only `biz_crm_*` |
| The existing access screens contain no CRM financial control and no "Add to Business CRM" string |
| Snapshots carry no credential, password, cookie or vault field |
| Access-status derivation matches the website inclusive end-of-day rule |
| `salesService` creates no website entitlement |

### `backend/tests/businessCrmRuntimeDefects.test.js` — 10 tests

Regression guards for the two production faults and their near neighbours.

| Guarantee |
|---|
| No CRM query compares a formatted date string to a bound parameter (the collation trap) |
| The dashboard scopes months with half-open DATE bounds, and never `DATE_FORMAT` |
| Every named placeholder in `dashboard.js` has a matching parameter |
| **No `db.query` template literal contains a colon-bearing SQL comment** |
| `money.toMinor` still refuses more than two decimals — the fix must not have loosened validation |
| Every `AVG()` in the module is wrapped in `ROUND(...,2)` |
| A MySQL-style six-decimal average is rejected, and the rounded form accepted |
| PKR/INR/NGN accepted, others rejected |
| Month bounds are correct, including the December rollover |
| Dashboard permission gating (`profitVisible`, `vendorVisible`, `expenseVisible`, audit) is intact |

The colon-in-comment test deserves a note: `mysql2`'s named-placeholder tokenizer does not skip SQL
comments, so a comment containing `name:value` becomes a phantom placeholder and the driver rejects
the call. That caused a production 500. Both this test and the placeholder test were verified to
**fail** when the mistake is reintroduced.

### `frontend/src/features/business-crm/__tests__/crmRouting.test.js` — 18 tests

`crmPath()` behaviour plus a source scan.

| Guarantee |
|---|
| `crmPath()` base, empty, null and `undefined` handling |
| Bare segment, leading slash, nested segments |
| **Idempotent** — re-applying 20 times still yields one base |
| An already-accumulated path collapses back to a single base |
| Query strings and hashes preserved |
| `"."` and `"./"` collapse to the base, not the current route |
| External and pseudo-protocol targets refused |
| Every `NAV` entry resolves to one clean absolute path, paths unique, metadata well-formed |
| No `<Navigate to=".">` anywhere |
| Every `Link` / `NavLink` target is absolute or `crmPath()`-derived |
| Every `navigate()` call is absolute, `crmPath()`-derived, or a numeric delta |
| No parent-relative `../` navigation |
| The wildcard route renders a visible `NotFound` |
| No hardcoded base string is malformed or doubled |

Note the scanners strip comments before matching. Without that they match their own documentation —
which happened, and is why `code()` exists in that file.

## Which tests for which change

| Change | Run |
|---|---|
| CRM SQL or route | backend CRM tests → full backend suite → `node --check` |
| `money.js`, `permissions.js`, `encryption.js` | full backend suite; re-read [`rbac-matrix.md`](rbac-matrix.md) if permissions moved |
| `schema.sql` or `db.js` | isolation test → migration script twice → **backup first** |
| Reconciliation | isolation test → full backend suite → reconcile twice and compare `created` |
| CRM navigation or `constants.js` | `crmRouting.test.js` → full frontend suite → production build |
| `invoicePdf.js`, `invoiceLogo.js` or the logo asset | `businessCrmInvoiceReminders.test.js` → **render a real PDF and look at it**; confirm the logo decodes, the invoice number is legible on the navy band, no content crosses the 42/553 pt margins, and no purchase cost or profit appears |
| `reminderTemplates.js` | `businessCrmInvoiceReminders.test.js` → print every variant and read it; a customer-facing message cannot be recalled once sent |
| Reminder UI or `MessagePreview` | `crmInvoiceReminders.test.js` → full frontend suite → confirm no popup opens before the review dialog and that `window.open` still carries `noopener` |
| CRM CSS or layout | production build → **measure** rendered touch targets and body overflow at 320/360/390/412/768 px |
| `AdminLayoutEnhanced.js` or `App.js` | full frontend suite → production build → manually re-check non-CRM admin pages, client login, public site |
| Service worker | production build → verify scope and that no `/api/` entry is cached |

## Genuinely untested

Be honest about these when reviewing a change.

| Area | Status |
|---|---|
| Any database-backed behaviour | **NOT VERIFIED.** No test connects to MySQL |
| Create sale, record payment, reverse payment, invoice PDF, expense, cashbook end-to-end | **NOT VERIFIED** |
| CSV import, JSON backup, offline drain | **NOT VERIFIED** |
| MANAGER / STAFF / VIEWER runtime 401/403 | **NOT VERIFIED.** Definitions are VERIFIED FROM CODE; runtime is not |
| Reconciliation at scale, ambiguous-client resolution with real duplicates | **NOT VERIFIED** |
| DOM click-through (browser back/forward, refresh) as an automated test | **NOT VERIFIED.** `react-router-dom@7.16.0` declares `main: "./dist/main.js"` but ships no such file, so CRA 5's jest resolver cannot import it. Fixing that needs a `moduleNameMapper` in `craco.config.js`, which is outside CRM scope. The source scan covers the defect class instead; back/forward was verified manually |
| Screen-reader testing with assistive technology | **NOT VERIFIED.** ARIA attributes and focus behaviour are VERIFIED FROM CODE |

## If you add a database test

There is no MySQL in the development environment and no staging database. To add real coverage you
need a throwaway local MariaDB, `schema.sql` applied by `business-crm-migrate.js`, and synthetic rows
only. Never point a test at production. Two things worth covering first, because they are the
highest-value gaps: a payment/reversal balance assertion, and an offline batch replayed twice
asserting exactly one write.
