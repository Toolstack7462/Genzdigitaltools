# ADR 005 — Browser storage and service-worker boundaries

| Field | Value |
|---|---|
| **Purpose** | Record what the CRM is allowed to store in the browser, and the limits placed on its service worker. |
| **Scope** | `localStorage`, `sessionStorage`, IndexedDB, Cache Storage, service-worker scope and strategy. |
| **Status** | Accepted and implemented. |
| **Last verified commit** | `8b76b617f67928e6454226d1861f9d35913a3981` |
| **Last verified date** | 2026-08-10 |
| **Source files inspected** | `frontend/public/admin/business/sw.js`, `frontend/src/features/business-crm/offline/{db,queue,register}.js`, `BusinessCrmContext.jsx`, `backend/modules/business-crm/index.js`, `backend/modules/business-crm/routes/sync.js`, `backend/modules/business-crm/schema.sql`. |
| **Related documents** | [`../offline-sync.md`](../offline-sync.md), [`../security.md`](../security.md), [`001-same-admin-workspace.md`](001-same-admin-workspace.md) |
| **Owner / maintainer** | Repository owner (`Toolstack7462`). |
| **What this document does not verify** | Behaviour of a browser extension or another script on the same origin that might read `localStorage`. |

## Context

The CRM needed offline tolerance for field use on unreliable connections. That means browser storage
and a service worker — both of which can leak sensitive data if scoped carelessly. The CRM handles
invoices, payments, client contact details and optionally encrypted account credentials.

## Decision

Four hard boundaries.

### 1. No authentication material in browser storage

The session lives **only** in `HttpOnly` cookies. The CRM never writes a token, password, refresh token
or cookie value to `localStorage`, `sessionStorage`, IndexedDB or Cache Storage. `document.cookie`
cannot read the admin cookies.

Permitted in `localStorage`: `genz_admin_user` (non-sensitive profile display data, written by the
existing `AdminRoute`) and `genz_business_currency` (the selected reporting currency).

### 2. The service worker is scoped to `/admin/business/` only

Registered with an explicit `{ scope: '/admin/business/' }`, and only in production builds. It can
therefore never intercept a request for another admin page, the client portal or the public site.

### 3. The service worker never caches `/api/*`

The fetch handler returns early for any `/api/` pathname, for any cross-origin request, and for any
non-GET method. Only `script`, `style`, `image` and `font` responses are cached, plus four precached
shell paths. Combined with `Cache-Control: private, no-store` on every CRM response, no invoice,
report, payment, export or credential can enter Cache Storage.

### 4. Network-first, never cache-first

The worker always attempts the network and falls back to cache only in `.catch()`. It calls
`skipWaiting()` and `clients.claim()`, and on activate deletes every cache except the current one.

## Why

- **Scope containment.** A widened scope would let a CRM caching bug affect unrelated admin pages. The
  narrow scope makes that structurally impossible.
- **No API caching.** Cached financial responses would persist on a shared or lost device beyond the
  session. `no-store` plus the `/api/` skip means there is nothing to find.
- **Network-first.** Cache-first would serve a stale bundle after a deploy and invite
  "clear your cache" support requests. Network-first plus content-hashed filenames makes a stale CRM
  bundle impossible while online.
- **Cookies over storage.** An `HttpOnly` cookie is not reachable from JavaScript; a token in
  `localStorage` is readable by any script on the origin.

## Consequences

Good:

- Offline reads work for shell and assets; queued creates survive a disconnection.
- No sensitive data is recoverable from browser storage.
- Deploys take effect on reload without user action.

Costs, accepted:

- **Offline coverage is shallow.** Because `/api/` is never cached, no CRM *data* is available offline —
  only the shell. The offline queue covers safe **creates**, not reads, edits, deletes or reversals.
  Accepted: an offline financial read is more dangerous than an absent one.
- The queue needs its own idempotency ledger (`biz_crm_sync_operations`, keyed by
  `idempotency_key`) so replay cannot double-write.

## Verification

Measured in a fresh authenticated production session on 2026-08-10. **VERIFIED IN PRODUCTION.**

| Check | Result |
|---|---|
| Service-worker scope | `https://app.genzdigitalstore.com/admin/business/`, activated |
| Cache Storage | one cache, `genz-business-crm-shell-v2`, **0 `/api/` entries** |
| `localStorage` | one CRM-relevant key, `genz_admin_user`; no token or password pattern |
| `sessionStorage` | empty |
| IndexedDB | `genz-business-crm-v2` (the offline queue) |
| `document.cookie` | empty — admin cookies unreadable from JS |
| CRM API cache headers | `private, no-store` on all endpoints exercised |
| Production bundle secret scan | no vault key, DB URL, JWT secret or token |

Strategy, scope, `/api/` skip and cache cleanup are all **VERIFIED FROM CODE** in `sw.js`.

**NOT VERIFIED:** logout-state clearing and browser-Back-after-logout — testing those would have ended
the audit session.

## Rules to keep

1. Scope stays `/admin/business/`. Never `/admin/` or `/`.
2. `/api/` is never cached.
3. Never switch to cache-first for HTML or assets.
4. Never write a token, password or cookie value to any browser store.
5. `biz_crm_sync_operations` keeps `idempotency_key` as its primary key — never clear it to unstick a
   queue.
6. If the offline feature ever caches CRM *data*, this ADR must be revisited first, with an explicit
   decision about device loss.
