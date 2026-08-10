# Business CRM — Security Notes

| Field | Value |
|---|---|
| **Purpose** | Record the CRM's security boundaries, what was tested, and what was not. |
| **Scope** | CRM authentication reuse, authorisation, CSRF, browser storage, encryption, caching, audit redaction, injection surfaces. |
| **Status** | As-built. This is a record of tested boundaries, **not** a security certification. |
| **Last verified commit** | `8b76b617f67928e6454226d1861f9d35913a3981` |
| **Last verified date** | 2026-08-10 |
| **Source files inspected** | `backend/modules/business-crm/{index,permissions,csrf,encryption,audit,csv,money,validation,invoicePdf,invoiceLogo,reminderTemplates,http,db}.js`, `routes/*.js`, `frontend/src/features/business-crm/{api.js,BusinessCrmContext.jsx,offline/*}`, `frontend/public/admin/business/sw.js`, `backend/middleware/authEnhanced.js`, `backend/server-crm.js` (CORS, read only). |
| **Related documents** | [`rbac-matrix.md`](rbac-matrix.md), [`offline-sync.md`](offline-sync.md), [`known-issues.md`](known-issues.md), [`../../SECURITY_NOTES.md`](../../SECURITY_NOTES.md) |
| **Owner / maintainer** | Repository owner (`Toolstack7462`). |
| **What this document does not verify** | Penetration testing, dependency CVE status, MANAGER/STAFF/VIEWER runtime enforcement, and the production vault key. **No claim of "secure" or "fully tested" is made.** |

## Authentication — reused, not reimplemented

The CRM defines no authentication. It sits behind `requireAdminAuth` from
`backend/middleware/authEnhanced.js` and reuses the existing admin cookies. There is no CRM login, no
second cookie, no second token system, no second user store. **VERIFIED FROM CODE.**

Observed in production on 2026-08-10. **VERIFIED IN PRODUCTION.**

| Cookie | `HttpOnly` | `Secure` | `SameSite` | Readable by JS |
|---|---|---|---|---|
| `adminAccessToken` | yes | yes | `None` | **no** — `document.cookie` was empty |
| `adminRefreshToken` | yes | yes | `None` | **no** |

`SameSite=None` is required because the app and API are different subdomains. It is paired with
`Secure` and an origin allowlist rather than a wildcard.

## Authorisation

44 permission keys, 5 roles, server-enforced by `requirePermission`. Sensitive fields are **removed
server-side**, not merely hidden in the UI: without `profit.view` no cost or profit is serialised;
without `vendors.view` no vendor field or vendor payment row; without `credentials.view` only boolean
presence flags. Full matrix: [`rbac-matrix.md`](rbac-matrix.md). **VERIFIED FROM CODE.**

Two write paths into the shared `users` table are deliberately **disabled** and return HTTP 405
`CRM_USER_WRITE_DISABLED`: creating an account, and resetting a password. A reset would increment
`tokenVersion` and silently invalidate a live admin session, so the CRM must not own it.
**VERIFIED FROM CODE.**

## CSRF

Double-submit token. `GET /bootstrap` issues it; `csrf.requireToken` guards everything mounted after,
and the frontend attaches it as `x-business-csrf-token` via `features/business-crm/api.js`.
`/bootstrap` is mounted before the gate and is therefore the only endpoint reachable without a token.
**VERIFIED FROM CODE.**

## Rate limiting

240 requests/minute per user id across the CRM router, plus 6/minute on
`POST /access-links/reconcile`, which is the most expensive endpoint. **VERIFIED FROM CODE.**

## Browser storage — what is actually stored

Measured in a fresh authenticated production session on 2026-08-10. **VERIFIED IN PRODUCTION.**

| Store | Contents |
|---|---|
| `localStorage` | one CRM-relevant key, `genz_admin_user` (non-sensitive profile display data), plus `genz_business_currency` for the selected reporting currency |
| `sessionStorage` | empty |
| IndexedDB | `genz-business-crm-v2` — the offline queue |
| Cache Storage | one cache, `genz-business-crm-shell-v2`, containing **4 shell HTML paths and no `/api/` entries** |

No password, session token, refresh token or cookie value was found in any store. The CRM never
writes a token to storage — the session lives only in `HttpOnly` cookies.

**Not tested:** logout-state clearing and browser-Back-after-logout. Doing so would have ended the
audit session. Recorded as **NOT VERIFIED**.

## Credential encryption

Optional per-item credentials use **AES-256-GCM** (`encryption.js`). **VERIFIED FROM CODE.**

- Key: `BUSINESS_CRM_VAULT_KEY`, required to be exactly 64 hexadecimal characters.
- Random 12-byte IV per encryption; the auth tag is stored.
- **AAD binding** to `"<saleId>:<itemId>:email"` / `":password"`, so ciphertext cannot be moved
  between records and still decrypt.
- Payload format `gds-v1.<iv>.<tag>.<ciphertext>`, base64url.
- The key is read **lazily**. A missing or malformed key throws HTTP 503 `VAULT_NOT_CONFIGURED` at use
  time and never at import time, so it cannot prevent the server from booting.
- Backups keep credentials as ciphertext.

Production key status: **PRODUCTION STATUS UNKNOWN** — see
[`current-state.md`](current-state.md#explicitly-unknown).

## Audit redaction

`audit.clean()` walks the before/after payloads recursively and replaces any key matching
`password|credential|cipher|token|secret|cookie` with `[REDACTED]`. IP and user agent are truncated.
**VERIFIED FROM CODE.**

## Caching of private data

Every CRM response sets `Cache-Control: private, no-store`, confirmed on all 19 endpoints exercised
in production. The service worker skips `/api/` entirely and skips cross-origin requests, so no API
response can enter Cache Storage. **VERIFIED FROM CODE and VERIFIED IN PRODUCTION.**

## Injection surfaces

| Surface | Control | Basis |
|---|---|---|
| SQL | Parameterised queries throughout; `safeLike()` escapes `\`, `%`, `_` for search | VERIFIED FROM CODE |
| Table names in dynamic SQL | Chosen from fixed allowlists (`CONFIG` maps, `COUNT_TABLES`), never from user input | VERIFIED FROM CODE |
| CSV export | Values neutralised against formula injection | VERIFIED FROM CODE + package test |
| Input validation | Joi schemas; currency restricted to PKR/INR/NGN; money must be `^\d+(\.\d{1,2})?$` | VERIFIED FROM CODE |
| Money arithmetic | Integer minor units via `BigInt`; no float parsing | VERIFIED FROM CODE |
| Idempotency | Unique keys on clients, vendors, sales, payments, expenses and the sync ledger | VERIFIED FROM CODE |
| Optimistic concurrency | `version` columns → HTTP 409 `VERSION_CONFLICT` | VERIFIED FROM CODE |
| Payment integrity | Overpayment refused (409); reversals additive, originals preserved | VERIFIED FROM CODE |
| PDF string syntax | `pdfEscape()` escapes `\`, `(`, `)`, flattens newlines, and emits every non-ASCII character as a WinAnsi octal escape — operator text cannot terminate a PDF string or inject a content-stream operator | VERIFIED FROM CODE + test |
| Invoice logo path | Fixed constant from `__dirname`. `settings.logo_url` is **never** used as a filesystem path or fetched: doing so would turn invoice rendering into an arbitrary file read / SSRF that anyone who can edit settings could trigger | VERIFIED FROM CODE + test |
| Outbound customer messages | `reminderTemplates.js` interpolates only client/vendor name, product, invoice number, currency, amounts, dates and a MASKED account email — never a password, cookie, token, session value, provider credential, cost, profit or vendor pricing. Whitespace in operator-entered values is collapsed, so a crafted client name or product name cannot forge extra message lines | VERIFIED FROM CODE + test |
| Account email in messages | Masked unconditionally (`aam***@gmail.com`); there is no setting that unmasks it. The ciphertext is decrypted ONLY to be masked, the password ciphertext is never even selected, and a missing vault key omits the field instead of failing the reminder | VERIFIED FROM CODE + test |
| Reminding a settled invoice | Refused server-side with 409 `REMINDER_NOT_PAYABLE` for a paid or cancelled invoice. A false demand sent to a customer cannot be recalled, so this is not left to the UI | VERIFIED FROM CODE + test |
| New browser tabs | Every `window.open` in the CRM passes `noopener,noreferrer`, so an opened tab holds no `window.opener` handle back to the admin session | VERIFIED FROM CODE + test |

## Error disclosure

A 5xx returns a generic `Business CRM request failed` with a request id; the stack is logged
server-side only. Unknown CRM paths return a structured 404 with no stack. The frontend renders a
visible not-found or error state and never prints internals. **VERIFIED FROM CODE.**

## Known CORS behaviour — not changed

Tested live on 2026-08-10. **VERIFIED IN PRODUCTION.**

| Request | Result |
|---|---|
| Approved app origin, unauthenticated | **401** with correct `access-control-allow-origin` |
| No `Origin` header | **401** |
| Non-approved origin | **500**, no `access-control-allow-origin` |

The application therefore receives proper 401/403. The blemish is that a *disallowed* origin gets 500
instead of 403, because the origin callback in `backend/server-crm.js` rejects with an `Error`. That
is shared global middleware, outside CRM scope, and was deliberately left alone. Recorded in
[`known-issues.md`](known-issues.md). The allowlist was **not** widened and no wildcard is used with
credentials.

## Secret hygiene

- No secret is committed anywhere in the CRM module; scans of the release diffs found no
  `DATABASE_URL`, `MYSQL_URL`, vault key, JWT secret, SFTP credential, SSH host/user/password or
  private key. **VERIFIED FROM CODE.**
- The production JS/CSS bundles were scanned for secrets — none found. **VERIFIED IN PRODUCTION.**
- No `.env` file of any kind is committed. The installer writes
  `backend/.env.business-crm.example` locally with placeholder values only, and the project
  `.gitignore` rule `**/.env.*` keeps it — and every real `.env` — out of the repository. It is
  therefore absent from a fresh clone by design.

## Explicitly not assessed

No penetration test. No dependency vulnerability scan. No MANAGER/STAFF/VIEWER runtime verification.
No load or DoS testing. No review of the shared authentication implementation itself. Treat this
document as a boundary map, not an assurance.
