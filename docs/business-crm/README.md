# Business CRM — As-Built Documentation

| Field | Value |
|---|---|
| **Purpose** | Entry point and index for the as-built Business CRM documentation set. |
| **Scope** | The Business CRM module only: `/admin/business/*`, `/api/crm/admin/business/*`, and the `biz_crm_*` tables. |
| **Status** | As-built. Describes what the code does today, not a plan. |
| **Last verified commit** | `8b76b617f67928e6454226d1861f9d35913a3981` |
| **Last verified date** | 2026-08-10 |
| **Source files inspected** | `backend/modules/business-crm/**`, `backend/scripts/business-crm-*.js`, `frontend/src/features/business-crm/**`, `frontend/src/pages/admin/AdminBusinessCrm.js`, `frontend/public/admin/business/sw.js`, and the CRM mount lines in `frontend/src/App.js`, `frontend/src/components/AdminLayoutEnhanced.js`, `backend/server-crm.js`. |
| **Related documents** | [`../architecture/architecture-index.md`](../architecture/architecture-index.md), [`../../ARCHITECTURE.md`](../../ARCHITECTURE.md), [`../../DEPLOYMENT_CHECKLIST.md`](../../DEPLOYMENT_CHECKLIST.md), [`../../SECURITY_NOTES.md`](../../SECURITY_NOTES.md) |
| **Owner / maintainer** | Repository owner (`Toolstack7462`). No separate CRM team exists. |
| **What this document does not verify** | Production database contents, production environment variables, hosting configuration, or anything about the running server. See [`current-state.md`](current-state.md) for what is and is not verified. |

## Read this first

Two rules govern every change in this module. Everything else follows from them.

1. **The existing website access system owns operational access.** Who has a tool, when it starts,
   when it expires, whether it was revoked — the CRM only mirrors those facts and never writes them.
2. **The Business CRM owns financial information.** Prices, costs, payments, invoices, profit. None
   of it appears on the existing Give Access or assignment screens.

If a change would blur those two lines, it is the wrong change. See
[`adr/002-pull-only-access-reconciliation.md`](adr/002-pull-only-access-reconciliation.md) and
[`adr/003-no-financial-fields-in-give-access.md`](adr/003-no-financial-fields-in-give-access.md).

## Document map

| Document | Read it when you need to |
|---|---|
| [`current-state.md`](current-state.md) | Know what exists right now, and what is unverified |
| [`architecture.md`](architecture.md) | Understand how the pieces fit together |
| [`system-diagrams.md`](system-diagrams.md) | See the flows as diagrams |
| [`data-model.md`](data-model.md) | Work with any `biz_crm_*` table |
| [`api-reference.md`](api-reference.md) | Call or change an endpoint |
| [`rbac-matrix.md`](rbac-matrix.md) | Reason about roles and permissions |
| [`website-access-bridge.md`](website-access-bridge.md) | Touch reconciliation or website-linked records |
| [`ui-design-system.md`](ui-design-system.md) | Change CRM layout, navigation or responsive behaviour |
| [`security.md`](security.md) | Review auth, storage, encryption or caching boundaries |
| [`offline-sync.md`](offline-sync.md) | Work on the offline queue or the service worker |
| [`operations-runbook.md`](operations-runbook.md) | Deploy, verify or roll back |
| [`troubleshooting.md`](troubleshooting.md) | Diagnose a reported problem |
| [`testing.md`](testing.md) | Know which tests to run for a change |
| [`known-issues.md`](known-issues.md) | Check whether something is already known |
| [`README_URDU.md`](README_URDU.md) | Owner/operator guide in Roman Urdu |

Decision records: [`adr/`](adr/) — five decisions that constrain this module.

Local module maps:
[`backend/modules/business-crm/README.md`](../../backend/modules/business-crm/README.md) ·
[`frontend/src/features/business-crm/README.md`](../../frontend/src/features/business-crm/README.md)

## Change boundaries at a glance

**Normally safe to change** (CRM-owned):

```
frontend/src/features/business-crm/**
frontend/src/pages/admin/AdminBusinessCrm.js
frontend/public/admin/business/sw.js
backend/modules/business-crm/**
backend/scripts/business-crm-*.js
```

**Shared — a change here needs full regression testing:**

```
frontend/src/App.js                            (one lazy import + one route)
frontend/src/components/AdminLayoutEnhanced.js (one nav item + route-scoped workspace mode)
frontend/src/services/api.js                   (the axios client the CRM reuses)
backend/server-crm.js                          (one require + one app.use)
```

**Protected — do not change while fixing a CRM problem:** AdminLogin, client portal, Give Access,
Assignments, Bulk Assign, Renewals, extension, proxy tools, StealthWriter, Claude gateway, device
binding, public website, and every non-`biz_crm_*` table.

Full detail and the reasoning: [`architecture.md#change-boundaries`](architecture.md#change-boundaries).

## Verification labels used throughout

| Label | Means |
|---|---|
| **VERIFIED FROM CODE** | Read directly from source at the commit above |
| **VERIFIED FROM TEST** | Asserted by a test in this repository |
| **VERIFIED IN PRODUCTION** | Observed against the live system on 2026-08-10 |
| **NOT VERIFIED FROM CODE** | Stated for context; not confirmed by reading source |
| **PRODUCTION STATUS UNKNOWN** | Depends on runtime state this documentation did not inspect |
