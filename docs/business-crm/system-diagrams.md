# Business CRM — System Diagrams

| Field | Value |
|---|---|
| **Purpose** | Show the CRM's structure and flows as diagrams. |
| **Scope** | System context, auth flow, reconciliation, manual sale, payment, offline queue, deployment. |
| **Status** | As-built. |
| **Last verified commit** | `8b76b617f67928e6454226d1861f9d35913a3981` |
| **Last verified date** | 2026-08-10 |
| **Source files inspected** | `backend/modules/business-crm/index.js`, `routes/{dashboard,sales,payments,accessLinks,sync}.js`, `services/{salesService,paymentService,websiteAccessService}.js`, `frontend/src/features/business-crm/{BusinessCrmApp.jsx,BusinessCrmContext.jsx,offline/queue.js}`, `frontend/src/components/AdminRoute.js`, `backend/middleware/authEnhanced.js`, `.github/workflows/deploy-frontend.yml`. |
| **Related documents** | [`architecture.md`](architecture.md), [`website-access-bridge.md`](website-access-bridge.md), [`offline-sync.md`](offline-sync.md), [`operations-runbook.md`](operations-runbook.md) |
| **Owner / maintainer** | Repository owner (`Toolstack7462`). |
| **What this document does not verify** | Runtime timing, retry counts under load, or hosting internals. The deployment diagram reflects observed behaviour on 2026-08-10, not a documented vendor contract. |

All diagrams are **VERIFIED FROM CODE** except the deployment diagram, which is
**VERIFIED IN PRODUCTION** by observation.

## System context

```mermaid
flowchart TB
  subgraph Browser
    Admin["Admin user"]
    SW["Service worker<br/>scope /admin/business/"]
    IDB[("IndexedDB<br/>offline queue")]
  end

  subgraph App["React app (app.genzdigitalstore.com)"]
    Login["/admin/login<br/>existing, unchanged"]
    Shell["AdminLayoutEnhanced<br/>existing shell"]
    CRM["/admin/business/*<br/>BusinessCrmApp"]
    Other["Other admin pages<br/>tools, members, assignments"]
  end

  subgraph API["Express (api.genzdigitalstore.com)"]
    Auth["requireAdminAuth<br/>existing middleware"]
    CRMAPI["/api/crm/admin/business/*"]
    WebAPI["Existing APIs<br/>assignments, proxy, stealth"]
  end

  subgraph DB[("MySQL / MariaDB")]
    Biz[("biz_crm_* — 21 tables<br/>CRM owns")]
    Core[("users, tools,<br/>tool_assignments — CRM reads only")]
  end

  Admin --> Login --> Shell
  Shell --> CRM
  Shell --> Other
  CRM -.registers.-> SW
  CRM -.queues creates.-> IDB
  CRM --> Auth --> CRMAPI --> Biz
  CRMAPI -. "read only" .-> Core
  Other --> Auth --> WebAPI --> Core
```

## Admin authentication flow

The CRM adds nothing to this. It reuses it end to end.

```mermaid
sequenceDiagram
  autonumber
  participant B as Browser
  participant R as AdminRoute
  participant A as Express auth
  participant C as CRM router

  B->>A: POST /api/crm/auth/admin/login (existing)
  A-->>B: Set-Cookie adminAccessToken + adminRefreshToken<br/>HttpOnly, Secure, SameSite=None
  B->>R: navigate /admin/business
  R->>A: GET /api/crm/auth/admin/me (cookies attached by browser)
  A-->>R: { success, user.role }
  Note over R: role must be ADMIN, SUPER_ADMIN or SUPPORT
  R-->>B: render AdminBusinessCrm
  B->>C: GET /api/crm/admin/business/bootstrap
  C->>A: requireAdminAuth
  A-->>C: req.user, req.userId, req.userRole
  Note over C: resolveAccess maps the auth role to a business role<br/>SUPER_ADMIN→OWNER, ADMIN→ADMIN, SUPPORT→STAFF<br/>then applies biz_crm_user_access + overrides
  C-->>B: access.permissions, currencies, settings, csrfToken
  Note over B,C: every later mutation must send the CSRF header
```

## Website access → CRM reconciliation (pull-only)

```mermaid
sequenceDiagram
  autonumber
  participant U as Admin
  participant P as LinkedAccess page
  participant R as routes/accessLinks.js
  participant S as websiteAccessService
  participant W as Website models (read only)
  participant D as biz_crm_access_links

  U->>P: open /admin/business/website-access
  P->>R: GET /access-links
  R->>D: SELECT
  D-->>P: stored links + summary
  P->>R: POST /access-links/reconcile
  R->>S: reconcile(req)
  S->>W: ToolAssignment.find({}) + populate
  S->>W: buildProxyAssignmentDTOs()
  Note over S,W: reads only — no write to any website table
  S->>D: upsert by external_key (one transaction per row)
  Note over S: sweep for vanished rows ONLY if every source succeeded
  S-->>R: { scanned, created, updated, markedMissing, errors, partial }
  R-->>P: 200 even when partial
  P->>P: non-blocking warning if partial, then refresh the list
```

Failure isolation, drawn explicitly:

```mermaid
flowchart LR
  A["Website assignment created<br/>by the existing flow"] --> B["Succeeds"]
  B --> C{"CRM reconciliation<br/>runs later, pull-only"}
  C -->|"succeeds"| D["Link row created<br/>NEEDS_FINANCIAL_DETAILS"]
  C -->|"fails"| E["Website access still intact<br/>CRM shows a retry warning"]
  E -.->|"never"| F["Roll back client access"]
```

## Manual sale flow

```mermaid
sequenceDiagram
  autonumber
  participant U as Admin
  participant F as SaleForm.jsx
  participant R as routes/sales.js
  participant S as salesService
  participant D as Database

  U->>F: fill client, currency, up to 20 items, prices
  F->>R: POST /sales (CSRF header + optional idempotencyKey)
  R->>R: requirePermission('sales.create') then Joi validate('saleCreate')
  R->>S: createSale(req, payload)
  S->>D: BEGIN (SERIALIZABLE)
  S->>D: assert client (and vendor if the caller may see vendors)
  Note over S: STAFF without profit.view cannot set a custom purchase cost
  S->>D: reserve invoice number from biz_crm_invoice_sequences
  S->>D: INSERT biz_crm_sales
  S->>D: INSERT biz_crm_sale_items (credentials AES-256-GCM encrypted)
  S->>D: optional opening client / vendor payment
  S->>D: audit.write('sale.create')
  S->>D: COMMIT
  S-->>U: sale, redacted for the caller's permissions
  Note over S,D: creates NO ToolAssignment, proxy, stealth or gateway entitlement
```

## Client / vendor payment and reversal

```mermaid
sequenceDiagram
  autonumber
  participant U as Admin
  participant R as routes/payments.js
  participant S as paymentService
  participant D as Database

  U->>R: POST /payments/sales/:saleId { partyType, amount }
  R->>S: record payment
  S->>D: BEGIN, lock the sale row
  S->>S: reject if the amount exceeds the remaining balance (PAYMENT_EXCEEDS_BALANCE)
  S->>D: INSERT biz_crm_payments (status 'posted')
  S->>D: UPDATE client_paid / vendor_paid on the sale
  S->>D: audit.write
  S->>D: COMMIT

  U->>R: POST /payments/:id/reverse
  R->>R: requirePermission('payments.reverse')
  S->>D: INSERT a REVERSING row referencing reverses_payment_id
  Note over S,D: the original row is preserved — reversal is additive, never a delete
  S->>D: recompute paid totals
```

## Offline queue

```mermaid
flowchart TB
  A["Admin submits a safe create<br/>while offline"] --> B[("IndexedDB queue<br/>offline/db.js")]
  B --> C{"navigator.onLine<br/>or Sync now"}
  C -->|"offline"| B
  C -->|"online"| D["POST /sync/batch<br/>requires offline.sync"]
  D --> E{"idempotency_key already<br/>in biz_crm_sync_operations?"}
  E -->|"yes"| F["Return the stored result<br/>no duplicate write"]
  E -->|"no"| G["Apply, then record the operation"]
  F --> H["Queue entry cleared"]
  G --> H
  H --> I["Connection pill shows<br/>Online / N pending syncs"]
```

## Deployment

Observed on 2026-08-10. **VERIFIED IN PRODUCTION**, not a vendor-documented contract.

```mermaid
flowchart TB
  A["Merge to main"] --> B{"Which paths changed?"}
  B -->|"frontend/**"| C["GitHub Action<br/>Deploy frontend to Hostinger"]
  B -->|"backend only"| D["Action correctly skipped<br/>paths filter is frontend/**"]
  C --> E["npm install --legacy-peer-deps<br/>CI=false, GENERATE_SOURCEMAP=false"]
  E --> F["npm run build"]
  F --> G["SFTP to BOTH web roots<br/>then verify the live bundle hash"]
  A --> H["Hostinger rebuilds the backend<br/>hbuilds/current → versions/UUID"]
  H --> I["Passenger serves the new build"]
  G --> J["Verify /admin/business in a fresh session"]
  I --> J
  J --> K{"Regression?"}
  K -->|"no"| L["Done"]
  K -->|"yes"| M["git revert the release commit<br/>push, let both pipelines redeploy"]
```

Note the asymmetry, because it causes confusion: a backend-only commit does **not** trigger the
frontend Action, and that is correct. The backend still redeploys through Hostinger's own build.
Never infer "nothing deployed" from an absent Action run — verify the running code instead. See
[`operations-runbook.md`](operations-runbook.md).
