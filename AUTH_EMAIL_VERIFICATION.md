# Authentication e-mail & registration verification

Scope: public signup, the e-mail verification OTP, password reset, and the admin
renewal-reminder e-mail. Nothing else in the platform sends mail.

## Transport

There is **no SMTP anywhere in this codebase**. `backend/utils/email.js` is the
single mailer and it POSTs to the **Resend HTTP API**
(`https://api.resend.com/emails`). There is no Nodemailer, no transporter and no
connection pool, so SMTP host/port/TLS questions do not apply.

Two keys named `smtpConfigured` in `routes/admin/proxyTools.js` are historical
misnomers — they only call `isEmailEnabled()`.

| Variable | Meaning |
| --- | --- |
| `RESEND_API_KEY` | Resend secret. Never logged, never returned in a response. |
| `EMAIL_FROM` | Verified sender, e.g. `Gen Z Digital Store <noreply@genzdigitalstore.com>` |
| `FRONTEND_URL` | Base for links in reset e-mails |

`GET /api/crm/auth/email-status` reports `{ emailEnabled }` without exposing any
value. If either variable is missing, sends are skipped — and signup now **fails
loudly** rather than creating an unverified account.

### Sending-domain DNS (verified 2026-07-27)

| Record | Value | Purpose |
| --- | --- | --- |
| `send.genzdigitalstore.com` TXT | `v=spf1 include:amazonses.com ~all` | Resend/SES MAIL FROM |
| `resend._domainkey.genzdigitalstore.com` TXT | `p=MIGf…` | DKIM |
| `genzdigitalstore.com` TXT | `v=spf1 include:_spf.mail.hostinger.com ~all` | mailbox provider (unrelated to Resend) |
| `_dmarc.genzdigitalstore.com` TXT | `v=DMARC1; p=none` | monitoring only |

DMARC is intentionally permissive. It has **no `rua=`**, so alignment failures
are invisible; adding a reporting address is the recommended next hardening step.

## Registration flow

The account is created **only after** a correct code is presented. This is the
core invariant — earlier versions created the account first and e-mailed
afterwards "best effort", which left active unverified accounts behind whenever
delivery failed and then blocked the retry with *"Email already exists"*.

```
POST /api/crm/public/register
  normalize e-mail (trim + lowercase)
  ├─ verified account exists    → 409 ACCOUNT_EXISTS      (record untouched)
  ├─ unverified account exists  → re-issue OTP, send      → 200 VERIFICATION_RESUMED
  │                               (password NOT overwritten — takeover guard)
  └─ no account
       bcrypt the password
       write PENDING registration (hashed OTP)
       SEND the e-mail
         ├─ provider refused    → 502 <structured code>, NO account exists
         └─ accepted            → 202 VERIFICATION_SENT

POST /api/crm/auth/verify-email
  pending registration?  → consume OTP, THEN create the verified account
  legacy unverified user? → flag emailVerified (unchanged behaviour)
```

### Pending registrations

Stored in the existing `email_verifications` table as `type: 'signup'` — no new
table and no schema migration. The row id is
`'pr' + sha256(normalized email).slice(0,24)`, so the table's **PRIMARY KEY
enforces exactly one pending registration per address**: a repeat signup is an
idempotent in-place refresh, which is what turns *"Email already exists"* into
*"here is a fresh code"*.

Stored: `fullName`, bcrypt `passwordHash`, `codeHash` (SHA-256), `expiresAt`,
`attempts`, `sendCount`, `lastSentAt`, `status`. **The raw code is never stored
or logged.**

| Control | Value | Where |
| --- | --- | --- |
| Code TTL | 10 min | `utils/signupPolicy.js` `OTP_TTL_MS` |
| Max wrong attempts | 5, then `locked` | `MAX_ATTEMPTS` |
| Resend cooldown | 60 s | `RESEND_COOLDOWN_MS` |
| Max sends / window | 5 per hour | `MAX_SENDS`, `SEND_WINDOW_MS` |
| One-time use | `status: 'consumed'` before account creation | `EmailVerification.verifySignupOtp` |

`sendCount`/`lastSentAt` advance **only after the provider accepts** (via
`markSignupSent`), so a provider outage can never burn the resend budget or lock
a user out.

### Atomicity

`utils/completeSignup.js` consumes the OTP first, then creates the account inside
a per-e-mail lock (`utils/keyedLock.js`) that re-checks for an existing user, so
concurrent verifications produce one account and every caller sees success. A
replayed code returns the true state without creating anything.

**Known limit, stated honestly:** the lock is in-process. `db/mysqlAdapter.js`
offers no transactions and `users` has **no unique index on e-mail**, so a
cross-process race is not provably impossible. Closing it fully needs a
`UNIQUE` index on the existing `users.gc_email` generated column — run
`scripts/reconcile-registrations.js` first to confirm zero duplicates.

## E-mail normalization

`utils/signupPolicy.js` `normalizeEmail()` trims (including NBSP/zero-width) and
lowercases. Lookups use `emailMatch()`, an anchored case-insensitive regex,
because the MySQL adapter's string equality is **case-sensitive** — a bare
`findOne({ email })` misses legacy rows and is how duplicates were created.

Gmail dots and `+tags` are deliberately **not** collapsed: they are different
mailboxes for many providers. The reconciliation script reports such collisions
instead of merging them.

## Structured e-mail failure codes

`utils/email.js` returns `{ code, adminMessage, messageId }`. Provider wording
stays in the server log; the caller shows the safe sentence.

| Code | Trigger |
| --- | --- |
| `SMTP_AUTH_FAILED` | 401, or 403 for an unverified sending domain |
| `SMTP_CONNECTION_FAILED` | network failure or provider 5xx |
| `EMAIL_REJECTED` | 400/422, or a 403 that is not a domain problem |
| `EMAIL_RATE_LIMITED` | 429 |
| `EMAIL_TIMEOUT` | 8 s cap reached |
| `EMAIL_INVALID_RECIPIENT` | recipient fails validation before any provider call |
| `TEMPLATE_ERROR` | missing subject or body |
| `EMAIL_NOT_CONFIGURED` | `RESEND_API_KEY`/`EMAIL_FROM` unset |

## Renewal reminder e-mail

`POST /api/crm/admin/renewals/:clientId/remind` (admin only).

- Recipient and template data are validated **before** the provider is called.
- Sends are serialised per client, and a second e-mail to the same client inside
  `RENEWAL_EMAIL_DEDUPE_MS` (default 60 s) is a no-op (`deduped: true`) — this is
  the double-click guard.
- **"Reminder sent" is recorded only after the provider accepts.**
  `RenewalReminderLog` stores recipient, template, status, the provider
  `messageId` and a `correlationId`.
- A provider failure returns **502** with a structured code; the UI shows the
  admin-safe sentence plus the correlation reference.
- Stage logs — `[renewal-email] stage=start|accepted|recorded|failed|exception
  cid=…` — make it possible to see exactly how far a request got.

### Diagnosing "Could not send the email."

That string is a **frontend fallback shown only when the API returned no usable
response body**. It does *not* mean the provider rejected the message — a real
provider failure now shows its own message. If it appears:

1. Check the browser Network tab for the actual status. A **503 with no
   `Access-Control-Allow-Origin`** is a LiteSpeed/Passenger error page produced
   *instead of* the app — Express never ran, so no CORS header is attached and
   the browser reports it as a CORS error. That is a **server fault, not a CORS
   misconfiguration** (a 401 on the same URL returns correct CORS headers).
2. Then read `nodejs/console.log` / `stderr.log` for the `[renewal-email]
   stage=` line. The last stage reached identifies where the worker died.

## Never logged

Passwords, password hashes, OTP codes, reset tokens, the Resend API key, e-mail
bodies, cookies and session tokens. E-mail addresses are masked (`a***@x.com`)
in signup logs. The `SECURITY` case in `tests/renewalReminderSend.test.js`
asserts no failure path returns the API key or the message body.

## Tests

```
cd backend && npm test          # 226 assertions
node --test tests/signupFlow.test.js           # 12 — registration invariants
node --test tests/renewalReminderSend.test.js  # 14 — transport + failure codes
```

`signupFlow.test.js` runs the real models against an in-memory pool injected via
`mysqlAdapter.__test.setPool` — no database and no network.

## Legacy data

`node scripts/reconcile-registrations.js [--detail|--csv]` — **read-only**,
deletes nothing. Classifies every account as `verified`, `unverified`,
`no_verification_record`, plus pending registrations without an account,
duplicate normalized e-mails, gmail alias collisions and data anomalies
(non-normalized e-mail, whitespace, non-bcrypt password).

Remedy for an affected user: sign up again with the same address. The new flow
detects the unverified account, e-mails a fresh code, and **preserves their
existing password**.
