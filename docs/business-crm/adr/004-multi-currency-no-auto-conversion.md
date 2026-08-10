# ADR 004 — Three separate ledgers, no automatic currency conversion

| Field | Value |
|---|---|
| **Purpose** | Record why PKR, INR and NGN are kept strictly separate and never converted. |
| **Scope** | Money representation, currency scoping, reporting. |
| **Status** | Accepted and implemented. |
| **Last verified commit** | `8b76b617f67928e6454226d1861f9d35913a3981` |
| **Last verified date** | 2026-08-10 |
| **Source files inspected** | `backend/modules/business-crm/money.js`, `validation.js`, `routes/{dashboard,reports,payments,expenses,sales}.js`, `services/{salesService,paymentService}.js`, `schema.sql`, `frontend/src/features/business-crm/constants.js`, `BusinessCrmContext.jsx`, `backend/tests/businessCrmRuntimeDefects.test.js`. |
| **Related documents** | [`../data-model.md`](../data-model.md), [`../api-reference.md`](../api-reference.md), [`../troubleshooting.md`](../troubleshooting.md) |
| **Owner / maintainer** | Repository owner (`Toolstack7462`). |
| **What this document does not verify** | Accounting or tax correctness in any jurisdiction. |

## Context

The business sells in Pakistani Rupees, Indian Rupees and Nigerian Naira. A CRM could either normalise
everything to a base currency using exchange rates, or keep three independent ledgers.

## Decision

**Three independent ledgers. No conversion anywhere in the module.**

- `currency_code CHAR(3)`, restricted to `PKR`, `INR`, `NGN` by `money.assertCurrency`. Anything else
  is rejected with HTTP 400 `UNSUPPORTED_CURRENCY`.
- Every financial query filters on `currency_code`.
- Reports, dashboard and cashbook take a `?currency` parameter and answer for that currency only.
- Totals from different currencies are **never** summed.
- No exchange-rate table, no rate provider, no conversion helper exists.

## Why

1. **A converted total is a lie with a timestamp.** Its value depends on the rate used and when. For a
   back-office ledger that is worse than three honest numbers.
2. **No rate source of truth.** Introducing one means choosing a provider, storing historical rates,
   deciding whether to revalue past invoices, and handling provider outages. All of that for a figure
   nobody needs to operate the business.
3. **Auditability.** Every stored amount is exactly what was charged or paid, in the currency it was
   charged in. Nothing is derived.
4. **Simplicity beats a feature nobody asked for.** The operator switches currency in the toolbar and
   reads that ledger.

## Money representation

`money.js` is deliberately strict. **VERIFIED FROM CODE.**

- All arithmetic in **integer minor units** via `BigInt`. No float ever touches a monetary value.
- `toMinor()` accepts only `^-?\d+(\.\d{1,2})?$` — at most two decimals. Anything else throws HTTP 400
  `INVALID_MONEY`.
- Storage is `DECIMAL(18,2)` with `decimalNumbers: false`, so values arrive as strings and are parsed
  by `money.js`, not by JavaScript's number type.
- Helpers: `normalize`, `sum`, `subtract`, `compare`, `nonNegative`.

### The consequence that bit us in production

Strictness is correct, but it means **any SQL that widens the scale must be rounded at the boundary**.
`AVG()` widens `DECIMAL(18,2)` to `DECIMAL(22,6)`, so `AVG(subtotal_sale)` arrived as
`"1250.000000"` and `money.toMinor` rejected it — the Reports endpoint returned 400 for every range
containing a sale.

The fix was `COALESCE(ROUND(AVG(subtotal_sale),2),0)`, **not** loosening the regex. A test now asserts
both that `money.normalize('1250.000000')` still throws and that every `AVG()` in the module is
wrapped in `ROUND(...,2)`. **VERIFIED FROM TEST.**

That is the rule to remember: **round in SQL, never relax `money.js`.**

## Consequences

Good:

- Every stored amount is exact and unconverted.
- A currency bug is easy to spot: a figure that should change when you switch currency but does not.
- No rate provider to depend on or pay for.

Costs, accepted:

- There is **no combined "total business revenue"** figure across currencies. By design. If one is ever
  needed for a report, compute it outside the CRM with an explicit, stated rate and date.
- Operators must switch the reporting currency to see each ledger.
- Adding a fourth currency requires code changes in
  `backend/modules/business-crm/money.js`, `backend/modules/business-crm/validation.js` and
  `frontend/src/features/business-crm/constants.js` — a deliberate speed bump.

## Verification

- `CURRENCIES` is frozen to exactly `['PKR','INR','NGN']`. **VERIFIED FROM CODE.**
- No conversion or exchange-rate logic exists anywhere in the module. **VERIFIED FROM CODE.**
- Dashboard and reports return independent figures per currency in production, and `averageInvoice`
  carries exactly two decimals. **VERIFIED IN PRODUCTION** for all three currencies.
- `money.js` rejects >2 decimals; PKR/INR/NGN accepted, `USD` and empty rejected.
  **VERIFIED FROM TEST.**

## Revisiting this

Only if the business genuinely needs consolidated multi-currency reporting. Then add an explicit,
auditable conversion **layer on top** — a report that states its rate and date — and leave the stored
ledgers untouched. Never convert on write.
