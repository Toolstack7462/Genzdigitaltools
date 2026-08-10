# ADR 002 — Website access reconciliation is pull-only

| Field | Value |
|---|---|
| **Purpose** | Record why the CRM pulls website access data instead of the website pushing to the CRM. |
| **Scope** | The website access → CRM bridge. |
| **Status** | Accepted and implemented. |
| **Last verified commit** | `8b76b617f67928e6454226d1861f9d35913a3981` |
| **Last verified date** | 2026-08-10 |
| **Source files inspected** | `backend/modules/business-crm/services/websiteAccessService.js`, `backend/modules/business-crm/routes/accessLinks.js`, `backend/modules/business-crm/schema.sql`, `backend/routes/admin/assignments.js` (read only), `backend/utils/proxyAssignments.js`, `backend/models/ToolAssignment.js`, `backend/tests/businessCrmIsolation.test.js`. |
| **Related documents** | [`../website-access-bridge.md`](../website-access-bridge.md), [`003-no-financial-fields-in-give-access.md`](003-no-financial-fields-in-give-access.md), [`../architecture.md`](../architecture.md) |
| **Owner / maintainer** | Repository owner (`Toolstack7462`). |
| **What this document does not verify** | Behaviour at large data volumes. Reconciliation has **NOT VERIFIED** performance characteristics against a big production dataset. |

## Context

Website-granted access had to appear in the CRM automatically — re-keying every assignment by hand was
unacceptable. Two designs were available.

**Push:** add a fire-and-forget CRM sync call inside the existing assignment create/extend/revoke
routes.

**Pull:** have the CRM read the existing access data on demand and mirror it.

The constraint that decided it: **client access must never break because of the CRM.** The existing
assignment write path is the most sensitive code in the product.

## Decision

**Pull-only.** No existing website route calls the CRM. `backend/routes/admin/assignments.js` was not
modified at all.

- The CRM reads `ToolAssignment` and `buildProxyAssignmentDTOs()` when an operator opens Website
  Access or triggers reconcile.
- Rows are mirrored into `biz_crm_access_links`, keyed by a stable `UNIQUE` `external_key`.
- Operational fields are refreshed from the source on every run; financial linkage is never touched.

Rejected: the push hook, even fire-and-forget. It would add code to the assignment write path, need a
retry queue for failed syncs, and create a path — however guarded — by which a CRM fault could affect
an assignment transaction.

## Consequences

Good:

- A CRM outage, a CRM bug, or an exhausted CRM connection pool **cannot** affect assignment creation.
  There is no code path from the website flow into the CRM.
- Idempotence is structural, not procedural: `external_key` is `UNIQUE`, so re-running cannot duplicate.
- No retry infrastructure is needed. The next reconcile is the retry.
- Proxy and stealth come along free, because `buildProxyAssignmentDTOs` already emits stable ids in
  exactly the key format used (`proxy:<tool>:<userId>`, `stealth:<userId>`).

Costs, accepted:

- **Data is eventually consistent.** A new assignment appears in the CRM on the next reconcile, not
  instantly. Acceptable because the CRM is a back-office financial tool, not a live access gate.
- Reconciliation reads all assignments each run. Fine at current volume; **NOT VERIFIED** at scale, and
  the first thing to revisit if it becomes slow.
- The CRM must derive status itself. Mitigated by reusing `ToolAssignment.effectiveEndBoundary()` and
  `isAssignmentExpired()` rather than reimplementing the rule, so the CRM cannot disagree with the
  client dashboard or extension about expiry.

## Design details that make it safe

All **VERIFIED FROM CODE.**

1. Each source is fetched in its own `try/catch`, so a proxy outage still lets core assignments
   reconcile.
2. The missing-record sweep runs **only if every source succeeded**. Otherwise `sweepSkipped: true` is
   returned. A transient outage therefore cannot mark healthy links `SOURCE_MISSING`.
3. Each row is upserted in its own transaction, so one bad row cannot abort the sweep.
4. A vanished record becomes `SOURCE_MISSING` and is never deleted — attached invoices and payments
   survive the access they were raised for.
5. Snapshots carry identity, tool label, dates and status only; a test asserts credentials, cookies
   and vault data are excluded.

## Verification

- No CRM file except `websiteAccessService.js` imports a website access model, and that file performs
  no write. **VERIFIED FROM TEST** (`businessCrmIsolation.test.js`).
- Reconciliation returned 200 with a summary in production, and re-running produced no duplicates.
  **VERIFIED IN PRODUCTION.**
- `backend/routes/admin/assignments.js` is byte-identical to its pre-CRM state. **VERIFIED FROM CODE.**

## Revisiting this

Revisit only if operators need near-real-time appearance in the CRM. Even then, prefer a *scheduled*
pull over a push hook — the moment the website write path can call the CRM, the isolation guarantee
that motivated this decision is gone.
