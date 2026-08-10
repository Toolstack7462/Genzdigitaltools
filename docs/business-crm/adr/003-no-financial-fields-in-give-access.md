# ADR 003 — No financial fields in Give Access or assignment screens

| Field | Value |
|---|---|
| **Purpose** | Record the decision that financial data is entered only inside the CRM, never on an access screen. |
| **Scope** | Give Access, Assign Tool, Bulk Assign, proxy and StealthWriter admin screens, renewals, and their APIs. |
| **Status** | Accepted, implemented, and test-enforced. |
| **Last verified commit** | `8b76b617f67928e6454226d1861f9d35913a3981` |
| **Last verified date** | 2026-08-10 |
| **Source files inspected** | `backend/routes/admin/assignments.js`, `frontend/src/pages/admin/{AdminAssignments.js,AdminBulkAssign.js,AdminProxyTools.js,AdminStealthWriter.js,AdminRenewals.js}` (read only), `backend/tests/businessCrmIsolation.test.js`, `backend/modules/business-crm/routes/accessLinks.js`. |
| **Related documents** | [`002-pull-only-access-reconciliation.md`](002-pull-only-access-reconciliation.md), [`../website-access-bridge.md`](../website-access-bridge.md), [`../rbac-matrix.md`](../rbac-matrix.md) |
| **Owner / maintainer** | Repository owner (`Toolstack7462`). |
| **What this document does not verify** | Operator preference. This is a product decision, recorded with its enforcement. |

## Context

The obvious way to capture a sale price at the moment access is granted is to add fields to the Give
Access form — a checkbox such as "Add to Business CRM", plus sale price, currency, purchase cost,
vendor and amount received.

That was **explicitly rejected**.

## Decision

The existing access screens and APIs stay financially empty. Specifically, none of the following may
appear on Give Access, Assign Tool, Bulk Assign, proxy tools, StealthWriter or renewals:

- an "Add to Business CRM" checkbox
- Sale Price · Currency · Purchase Cost · Vendor · Amount Received · Profit
- any CRM payment field or invoice control

Financial information is entered **only** inside `/admin/business`, through
`POST /access-links/:id/create-financial-record` (for website-linked access) or an ordinary CRM sale
(for manual items).

## Why

1. **Separation of concerns.** Granting access is an operational act; pricing is a financial one. They
   have different authorisation needs — a STAFF operator may legitimately grant access without ever
   seeing purchase cost or profit.
2. **Permission granularity.** CRM permissions (`profit.view`, `vendors.view`, `credentials.view`)
   redact data server-side. Putting cost on the access form would expose it to anyone who can grant
   access, bypassing that model entirely.
3. **Blast radius.** The assignment write path is the most sensitive code in the product. Adding form
   fields means changing its validation, its DTO and its route — for a purely financial reason.
4. **Failure isolation.** If the access form collected money, a CRM validation error could block a
   legitimate access grant. Keeping them apart makes that impossible.
5. **No duplicate mandatory entry.** The stated goal — not re-keying assignments — is met by
   reconciliation, not by widening the access form.

## Consequences

Good:

- Access screens keep working exactly as before; the CRM cannot break them.
- Financial fields are governed by CRM RBAC, so cost and profit stay hidden from roles that must not
  see them.
- The access APIs stay unchanged, so the extension, gateways and client portal are unaffected.

Costs, accepted:

- **Two steps instead of one.** An operator grants access, then completes financial details in the CRM.
  Mitigated by the Website Access inbox, which lists everything awaiting money with a one-click action
  and pre-filled operational fields.
- Financial capture can lag access. Acceptable: the inbox makes the backlog visible, and
  `NEEDS_FINANCIAL_DETAILS` is the default state so nothing is silently lost.

## Enforcement

This is not a convention — it is checked. **VERIFIED FROM TEST.**

`backend/tests/businessCrmIsolation.test.js` scans these files:

```
frontend/src/pages/admin/AdminAssignments.js
frontend/src/pages/admin/AdminBulkAssign.js
frontend/src/pages/admin/AdminProxyTools.js
frontend/src/pages/admin/AdminStealthWriter.js
frontend/src/pages/admin/AdminRenewals.js
backend/routes/admin/assignments.js
```

and fails the build if any contains `Add to Business CRM`, `Sale Price`, `Purchase Cost`,
`Amount Received`, `businessCrm` or `biz_crm_`.

Confirmed live on 2026-08-10: `/admin/assignments` contained none of those strings.
**VERIFIED IN PRODUCTION.**

## Revisiting this

Do not. If an operator asks for pricing on the Give Access form, the answer is to improve the Website
Access inbox — not to move financial fields into the access flow. Reversing this decision would
require re-litigating ADR 002 as well, because it would reintroduce a coupling from the access path to
the CRM.
