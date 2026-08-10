# ADR 001 — The CRM lives inside the existing admin application

| Field | Value |
|---|---|
| **Purpose** | Record the decision to build the CRM as a workspace inside the existing admin app rather than as a separate application. |
| **Scope** | Application boundary, authentication, navigation. |
| **Status** | Accepted and implemented. |
| **Last verified commit** | `8b76b617f67928e6454226d1861f9d35913a3981` |
| **Last verified date** | 2026-08-10 |
| **Source files inspected** | `frontend/src/App.js`, `frontend/src/components/{AdminRoute.js,AdminLayoutEnhanced.js}`, `frontend/src/pages/admin/AdminBusinessCrm.js`, `backend/server-crm.js`, `backend/middleware/authEnhanced.js`, `backend/modules/business-crm/index.js`. |
| **Related documents** | [`../architecture.md`](../architecture.md), [`../ui-design-system.md`](../ui-design-system.md), [`005-browser-storage-service-worker-boundaries.md`](005-browser-storage-service-worker-boundaries.md) |
| **Owner / maintainer** | Repository owner (`Toolstack7462`). |
| **What this document does not verify** | Whether an alternative would have performed better. This records the decision and its observable consequences. |

## Context

The store already had a working admin panel with server-verified authentication, `HttpOnly` admin
cookies, a role model, and an established design system. A financial CRM was needed for the same
operators.

## Decision

Build the CRM as a **route inside the existing admin application**:

- One route, `/admin/business/*`, in `frontend/src/App.js`.
- One API mount, `/api/crm/admin/business`, in `backend/server-crm.js`.
- Reuse `AdminRoute`, `AdminLayoutEnhanced`, the existing axios client, and the existing
  `requireAdminAuth` middleware.
- Reuse the existing `users` table for identity; store only *business* roles in `biz_crm_*`.

Explicitly rejected: a separate CRM login, a second cookie or JWT system, a second user database, a
CRM subdomain application, and a second admin shell.

## Consequences

Good:

- Operators log in once, at `/admin/login`. The server derives their role.
- No second session, cookie or token surface to secure — the CRM adds **no** authentication code.
- The CRM inherits cookie hardening (`HttpOnly`, `Secure`, `SameSite=None`) and CSRF posture already
  in place.
- Visual consistency comes for free: `--bcrm-*` tokens inherit the existing brand variables.

Costs, accepted knowingly:

- The CRM touches four shared files (`App.js`, `AdminLayoutEnhanced.js`, `services/api.js`,
  `server-crm.js`). Each footprint is deliberately one or two lines, and each is listed in
  [`../architecture.md#change-boundaries`](../architecture.md#change-boundaries) as requiring broader
  regression testing.
- Two full sidebars competed for width once the CRM added its own. Resolved by route-scoped workspace
  mode rather than by moving the CRM out — see [`../ui-design-system.md`](../ui-design-system.md).
- A CRM frontend bug renders inside the admin shell, so the blast radius is visually shared even
  though the code is isolated. Mitigated by an `ErrorBoundary` around the route and by keeping every
  `AdminLayoutEnhanced` change gated on the pathname.

## Verification

- One `lazy()` import and one `<Route path="/admin/business/*">` in `App.js`. **VERIFIED FROM CODE.**
- `requireAdminAuth` is the module's only authentication middleware. **VERIFIED FROM CODE.**
- The CRM never writes the `users` table; the two write endpoints return 405
  `CRM_USER_WRITE_DISABLED`. **VERIFIED FROM CODE.**
- Admin cookies are `HttpOnly`, `Secure`, `SameSite=None` and unreadable from JS.
  **VERIFIED IN PRODUCTION.**
- Non-CRM admin pages restore the full 224 px sidebar. **VERIFIED IN PRODUCTION.**

## Revisiting this

Reconsider only if the CRM needs users who must **not** hold an existing admin role. That would
require a genuine second identity source, and this decision would no longer hold.
