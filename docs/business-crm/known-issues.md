# Business CRM — Known Issues

| Field | Value |
|---|---|
| **Purpose** | List what is currently open, what was fixed, and what is unverified — so nobody re-diagnoses a solved problem or assumes an unverified item is fine. |
| **Scope** | The CRM module, plus adjacent findings that affect it. |
| **Status** | As-built. |
| **Last verified commit** | `8b76b617f67928e6454226d1861f9d35913a3981` |
| **Last verified date** | 2026-08-10 |
| **Source files inspected** | `backend/modules/business-crm/**`, `frontend/src/features/business-crm/**`, `backend/server-crm.js` (CORS, read only), `frontend/package.json`, `.github/workflows/deploy-frontend.yml`, `CHANGELOG.md`. |
| **Related documents** | [`troubleshooting.md`](troubleshooting.md), [`current-state.md`](current-state.md), [`testing.md`](testing.md) |
| **Owner / maintainer** | Repository owner (`Toolstack7462`). |
| **What this document does not verify** | That the open items below have no further consequences beyond those described. |

## Open — CRM

### 1. Duplicate `today` key in the dashboard response

`routes/dashboard.js` sets `today` twice in the response object literal: first the date string, then
an object. The second wins, so the date string never reaches the client. Harmless today; nothing
depends on it. Left alone because changing it alters the API response shape.
**VERIFIED FROM CODE.** Severity: cosmetic.

### 2. `POST /access-links/:id/create-financial-record` can return `linked: false`

The sale is committed before the access link is attached. If the attach fails the endpoint returns
**201** with `linked: false` and a `linkError` — deliberately, so nobody is invited to create the
invoice twice. The operator must retry the attach or re-run reconciliation, **not** resubmit the form.
There is currently no automatic repair. **VERIFIED FROM CODE.** Severity: low, needs operator
awareness. See [`website-access-bridge.md`](website-access-bridge.md).

### 3. Schema changes apply without a gate

`ensureSchema()` runs on every CRM request (memoised per process), so a `schema.sql` edit reaches
production on the first authenticated CRM request after deploy. Convenient, but there is no migration
step where a bad statement could be caught, and no automatic backup. Always back up before releasing
a schema change. **VERIFIED FROM CODE.** Severity: process risk.

## Open — outside CRM scope, affects CRM behaviour

### 4. Non-approved origin receives 500 instead of 403

Tested live 2026-08-10. **VERIFIED IN PRODUCTION.**

| Request | Result |
|---|---|
| Approved app origin, unauthenticated | **401** with correct `access-control-allow-origin` |
| No `Origin` header | **401** |
| Non-approved origin | **500**, no `access-control-allow-origin` |

The application itself is unaffected — it receives proper 401/403. The blemish is that a *disallowed*
origin gets 500 rather than 403, because the CORS origin callback in `backend/server-crm.js` rejects
with an `Error` that reaches the generic error handler. A browser then reports an opaque CORS failure
rather than a clean status, which makes debugging from a blank-origin context confusing.

**Deliberately not changed.** `server-crm.js` CORS is shared global middleware, outside CRM scope.
Recorded as: **NON-BLOCKING PLATFORM CORS WARNING — NOT CHANGED.** Do not widen the allowlist and do
not use a wildcard with credentials.

### 5. `react-router-dom@7.16.0` has a broken `main` field

The package declares `main: "./dist/main.js"` but ships only `dist/index.js` and `dist/index.mjs`. CRA
5's jest resolver follows `main` and fails, so CRM DOM-render tests cannot import the router. The fix
is a `moduleNameMapper` in `craco.config.js` — a shared build file outside CRM scope, so it was left
alone. Coverage is provided by a source scan instead. **VERIFIED FROM CODE.** Severity: limits test
strategy only; runtime is unaffected.

### 6. Pre-existing `react-hooks/exhaustive-deps` warnings

Around ten unrelated admin and client pages emit these. With `CI=true` they fail the build. The deploy
workflow uses `CI: 'false'`, so production is unaffected. No CRM file emits one.
**VERIFIED FROM CODE.** Severity: none for CRM; use `CI=false` when building.

### 7. `frontend/build/` is committed but CI rebuilds it

The repository tracks build output while the workflow regenerates it on every deploy, so the tracked
copy is permanently stale. Practical consequence: **never commit local build output** — restore
`frontend/build` before staging, or the diff fills with artifacts. **VERIFIED FROM CODE.**
Severity: process hazard.

### 8. `npm install` rewrites `frontend/yarn.lock`

Running `npm install` rewrites registry URLs in `yarn.lock`, producing thousands of unrelated diff
lines. Restore it before staging. **VERIFIED FROM CODE.** Severity: process hazard.

### 9. GitHub Action Node-runtime deprecation warning

The frontend workflow emits a Node-runtime deprecation warning. Unrelated to the CRM and untouched, as
CI configuration is out of scope. **NOT VERIFIED FROM CODE** in detail — recorded from the Action log.
Severity: none today.

## Fixed — do not reopen

All resolved. Listed with their guards so nobody re-diagnoses them.

| # | Defect | Root cause | Fixed in | Guard |
|---|---|---|---|---|
| F1 | CRM sidebar appended route segments | Relative `<NavLink to={path}>` inside a descendant `<Routes>` under a splat route resolves against the active branch | `dea93fe` | `crmPath()` + source-scanning test |
| F2 | Blank white content panel | `path="*"` used `<Navigate to=".">`; `"."` resolves to the current path, so it redirected to itself and rendered nothing | `dea93fe` | Visible `NotFound.jsx` + test |
| F3 | Two full text sidebars, squeezed content, double padding | Global admin sidebar rendered alongside the CRM sidebar at every width ≥1024 px | `dea93fe` | Route-scoped workspace mode |
| F4 | 19-item horizontally scrolling mobile nav | Base stylesheet's 820 px rule | `dea93fe` | Focus-trapped drawer + 4-item quick-nav |
| F5 | **Dashboard 500 on every request** | `DATE_FORMAT(col,'%Y-%m') = :month` made both operands COERCIBLE with different collations (`general_ci` from the literal vs `unicode_ci` from the bound parameter); MariaDB refused. Four queries affected | `dfce275` | Half-open DATE bounds + test |
| F6 | **Reports 400 `INVALID_MONEY`** | `AVG()` widens `DECIMAL(18,2)` to `DECIMAL(22,6)`, so the value arrived with six decimals and `money.toMinor` rejected it by design | `dfce275` | `ROUND(AVG(...),2)` + test asserting `money.js` stays strict |
| F7 | **Reports 500 `Bind parameters must not contain undefined`** | The fix for F6 explained itself in a SQL comment *inside* the query string; `mysql2`'s tokenizer does not skip comments, so `decimalNumbers:false` became a phantom placeholder | `8b76b61` | Colon-in-comment test, verified to fail when reintroduced |
| F8 | Interactive controls under 44 px | Base stylesheet shrank drawer nav links to 36 px; toolbar buttons were 40 px; the connection pill collapsed to 30 px wide | `8b76b61` | Rendered-size measurement, 715 controls |
| F9 | **CRM menu unclickable below 420 px** | Trailing toolbar controls overlapped the menu button | `8b76b61` | Same measurement harness (Playwright could not click the button) |

Two of these are worth remembering as lessons rather than entries: F5 and F7 were both invisible to
code reading and needed the **server log**; F8 and F9 were invisible to CSS reading and needed
**rendered measurement**.

## Unverified — treat as unknown, not as working

| Item | Status |
|---|---|
| `BUSINESS_CRM_VAULT_KEY` in production | **PRODUCTION STATUS UNKNOWN.** Absent from the deploy-time env file inspected; may come from the process environment. If absent, credential paths return 503 and nothing else is affected |
| Production schema drift beyond table count and version | **PRODUCTION STATUS UNKNOWN** |
| Financial write workflows end-to-end | **NOT VERIFIED** — no database-backed test, no staging |
| MANAGER / STAFF / VIEWER runtime enforcement | **NOT VERIFIED** — only a SUPER_ADMIN session was available |
| CSV import, JSON backup, offline drain with real data | **NOT VERIFIED** |
| Reconciliation at scale / ambiguous-client resolution | **NOT VERIFIED** |
| Logout state clearing and Back-after-logout | **NOT VERIFIED** — testing it would have ended the audit session |
| Screen-reader behaviour with assistive technology | **NOT VERIFIED** |

## Adding to this file

New entries need: symptom, root cause **or** an explicit statement that it is unknown, the affected
files, severity, and either a fix commit or why it was left. If it is fixed, move it to the table
above with its guard — an entry with no guard invites a repeat.
