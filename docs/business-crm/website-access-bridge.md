# Business CRM — Website Access Bridge

| Field | Value |
|---|---|
| **Purpose** | Document how website-granted access reaches the CRM, and the rules that keep the two systems separate. |
| **Scope** | `services/websiteAccessService.js`, `routes/accessLinks.js`, `biz_crm_access_links`, `pages/LinkedAccess.jsx`. |
| **Status** | As-built. |
| **Last verified commit** | `8b76b617f67928e6454226d1861f9d35913a3981` |
| **Last verified date** | 2026-08-10 |
| **Source files inspected** | `backend/modules/business-crm/services/websiteAccessService.js`, `backend/modules/business-crm/routes/accessLinks.js`, `backend/modules/business-crm/schema.sql`, `backend/models/ToolAssignment.js`, `backend/utils/proxyAssignments.js`, `backend/routes/admin/assignments.js` (read only, for status semantics), `frontend/src/features/business-crm/pages/LinkedAccess.jsx`, `backend/tests/businessCrmIsolation.test.js`. |
| **Related documents** | [`data-model.md`](data-model.md), [`architecture.md`](architecture.md), [`adr/002-pull-only-access-reconciliation.md`](adr/002-pull-only-access-reconciliation.md), [`adr/003-no-financial-fields-in-give-access.md`](adr/003-no-financial-fields-in-give-access.md) |
| **Owner / maintainer** | Repository owner (`Toolstack7462`). |
| **What this document does not verify** | Reconciliation behaviour against a large production dataset, or ambiguous-client resolution with real duplicate emails. Correctness is argued from code and covered by structural tests only. |

## The rule

```
Existing website access system  =  operational source of truth
Business CRM                   =  financial source of truth
```

The CRM **pulls** from the website system. Nothing in the website system knows the CRM exists.
**VERIFIED FROM CODE**, and enforced by `backend/tests/businessCrmIsolation.test.js`, which fails the
build if any CRM file except `websiteAccessService.js` imports a website access model, or if that
file gains a write call. **VERIFIED FROM TEST.**

`backend/routes/admin/assignments.js` was **not modified** to support this. Give Access carries no
financial field. See [`adr/003-no-financial-fields-in-give-access.md`](adr/003-no-financial-fields-in-give-access.md).

## Sources and external keys

Three sources feed one mirror table. Keys are stable across runs, which is what makes reconciliation
idempotent. **VERIFIED FROM CODE.**

| `source_type` | Read from | `external_key` |
|---|---|---|
| `CORE_ASSIGNMENT` | `ToolAssignment.find({})` with `toolId` / `clientId` populated | `core:<assignmentId>` |
| `PROXY` | `buildProxyAssignmentDTOs()` | `proxy:<tool>:<userId>` |
| `STEALTH` | `buildProxyAssignmentDTOs()` | `stealth:<userId>` |
| `MANUAL` | not a website record at all | no link row; an ordinary CRM sale |

The proxy and stealth keys are the DTO's own `_id` **verbatim** — `buildProxyAssignmentDTOs` already
emits `proxy:<tool>:<userId>` and `stealth:<userId>`, so there is no translation layer to drift.

`biz_crm_access_links.external_key` is `UNIQUE`. That single constraint is why re-running
reconciliation cannot create duplicates.

## Dates and status come from the website system

The bridge does not reimplement expiry logic. It reuses:

- `ToolAssignment.effectiveEndBoundary()` and `ToolAssignment.isAssignmentExpired()` — so the CRM
  applies the **same inclusive end-of-day rule** the client dashboard and the extension enforce.
- `statusFor()` and `EXPIRING_SOON_DAYS` from `backend/utils/proxyAssignments.js` for proxy/stealth.

Derived status vocabulary:

| `access_status` | When |
|---|---|
| `ACTIVE` | valid and not near expiry |
| `EXPIRING` | within `EXPIRING_SOON_DAYS` of the boundary |
| `EXPIRED` | past the inclusive end-of-day boundary, or status `expired` |
| `REVOKED` | assignment status `revoked`, or a disabled proxy/stealth row |
| `SOURCE_MISSING` | the website record was not seen in a complete sweep |

`access_mode` mirrors the admin assignments DTO rule: `direct` when the tool's
`extensionSettings.directOpenEnabled === true` **and** `requirePermission === false`, otherwise
`extension`; proxy/stealth rows report `proxy`. The derivation is replicated in the service with a
pointer comment rather than refactoring the stable assignments route.

## Financial status

| `financial_status` | Meaning |
|---|---|
| `NEEDS_FINANCIAL_DETAILS` | Discovered, no money attached yet. The default |
| `LINKED_TO_SALE` | A CRM sale item carries its financials |
| `NON_BILLABLE` | Deliberately excluded from billing, with an audit entry |
| `IGNORED` | Reserved; set through the same status helper |

No zero-price invoice is ever created just because access exists. **VERIFIED FROM CODE.**

## Client auto-linking

For each website record, in order. Only `biz_crm_clients` is written; the existing `users` row is
never modified. **VERIFIED FROM CODE.**

1. An existing CRM client already carrying that `website_user_id` → `client_link_state = MATCHED`.
2. Exactly **one** non-deleted CRM client with the same normalised email → `MATCHED`, and the
   `website_user_id` is adopted onto that client so later runs take the fast path.
3. **More than one** email match → `AMBIGUOUS`. Nothing is merged. A human decides.
4. No match → a CRM client is created from name / email / phone / website id → `CREATED`.

## Reconciliation guarantees

From `reconcile()`. **VERIFIED FROM CODE.**

- **Idempotent.** Upsert by `external_key`; a second run with unchanged website state creates nothing.
- **Per-row isolation.** Each upsert is its own transaction; one bad row does not abort the sweep.
- **Per-source isolation.** Core and proxy/stealth are fetched in separate `try/catch` blocks. A
  proxy outage still lets core assignments reconcile.
- **Conservative sweep.** Rows not seen this run are marked `SOURCE_MISSING` **only if every source
  reported success**. If anything errored the sweep is skipped and `sweepSkipped: true` is returned —
  so a transient outage cannot flip healthy links to missing.
- **Financial history is preserved.** The upsert refreshes operational fields and `last_seen_at`
  only. `crm_sale_id`, `crm_sale_item_id` and `financial_status` are never overwritten, and a
  vanished record is never deleted. An invoice therefore outlives the access it was raised for.
- **Reopen on return.** If a previously missing record reappears, `source_missing_at` is cleared.
- **Safe snapshots.** `source_snapshot_json` stores identity, tool label, dates and status only.
  A test asserts credentials, passwords, cookies and vault data are excluded. **VERIFIED FROM TEST.**

## Completing financial details

`POST /access-links/:id/create-financial-record` requires **both**
`website-access.financial-link` and `sales.create`.

The client and the operational dates are taken **from the link**, never from the request body, so the
CRM cannot disagree with the website about who has access to what and until when. Only money is
accepted from the operator: sale price, currency, purchase cost, vendor, amount received, vendor paid
and notes. The sale is created through the ordinary `salesService.createSale` pipeline, so invoice
numbering, currency rules, permissions, payments and audit behave exactly as for a manual sale.
**VERIFIED FROM CODE.**

### The `linked: false` case — read this before retrying

The sale is committed **before** the link is attached. If attaching fails, the endpoint still returns
**201** with `linked: false` and a `linkError`, deliberately, so nobody is invited to create the
invoice a second time. The correct recovery is to retry the attach or re-run reconciliation — never
to submit the form again. **VERIFIED FROM CODE.**

## UI contract

`pages/LinkedAccess.jsx`. **VERIFIED FROM CODE.**

- On load: fetch links → attempt reconcile → refresh. A reconcile failure raises a **non-blocking**
  warning; the stored rows still render and the rest of the CRM keeps working.
- A partial sweep names the failing sources in the warning rather than pretending it completed.
- Filters: Needs Financial Details · Linked to Sale · Non-Billable · Ignored · Active · Expiring ·
  Expired · Revoked · Source Missing · All.
- Operational columns are **read-only** for website-linked rows: client identity, tool, source,
  access mode, start, duration, expiry, access status.
- Actions: *Complete Financial Details* (opens the money-only form) and *Mark Non-Billable* (audited).
  *Complete Financial Details* is disabled when no CRM client is resolved.

## Things that must stay true

If you change this area, keep all of these. Several are test-enforced.

1. No CRM file writes any website table.
2. `external_key` stays `UNIQUE` and its format stays stable.
3. A missing source is marked, never deleted.
4. Financial linkage survives every reconciliation.
5. The sweep is skipped when any source errors.
6. Give Access gains no financial field.
7. Snapshots never carry credentials or gateway internals.
8. Expiry logic keeps reusing the `ToolAssignment` helpers rather than duplicating the rule.
