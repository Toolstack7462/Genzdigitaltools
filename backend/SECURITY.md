# Security notes — backend

Short, factual notes on deliberate security trade-offs so they aren't mistaken for
bugs or accidental regressions. Keep this current when the posture changes.

## Credential / cookie storage at rest

There are **two different storage paths**, and they do NOT have the same protection:

| Path | Module | At rest |
|------|--------|---------|
| Extension direct-injection tool credentials & cookies | `utils/encryption.js` | **Plaintext JSON** |
| Proxy vault (HIX / BypassGPT / WriteHuman) | `utils/proxy/vaultCrypto.js` | **AES-256-GCM** |
| Stealth vault (StealthWriter) | `utils/stealth/vaultCrypto.js` | **AES-256-GCM** |

### The `*Encrypted` field names are historical

`utils/encryption.js` `encrypt`/`decrypt`/`encryptCookies`/`decryptCookies` are
intentional **pass-through no-ops** (the encryption layer was removed by request).
The DB columns are still named `cookiesEncrypted`, `payloadEncrypted`,
`sessionBundle.cookiesEncrypted`, etc. **for backward compatibility** — the name says
"Encrypted" but the extension-tool path stores plaintext JSON there.

Do not assume those fields are encrypted just because of the name. If you ever add a
new consumer, treat that data as plaintext-at-rest.

Consumers of the plaintext path: `routes/extension/index.js`,
`routes/admin/tools.js`, `routes/admin/toolsEnhanced.js`, `models/Tool.js`.

### Practical risk

Anyone with read access to the MySQL database can read extension-tool credentials
directly. This is acceptable only under the assumption that DB access already implies
full application compromise. The proxy/stealth vaults (the shared "crown-jewel"
accounts) are NOT in this bucket — they use real AES-256-GCM via `vaultCrypto`.

If you want defense-in-depth for the extension path, reinstate encryption **only**
inside `utils/encryption.js` (the seam is already there — the pass-through functions
are the only place to change), and provide a one-time migration for existing rows.
Legacy rows previously stored as `iv:tag:ciphertext` already fail `JSON.parse` on read
and are reported by `/api/crm/extension/tools/:toolId/_diagnose`
(cause = `json_parse_failed`).

## Proxy lease secret

`utils/proxy/lease.js` signs short-lived (30 min) gateway leases with a **dedicated**
`PROXY_LEASE_SECRET`. If that env var is missing or shorter than 32 chars, the key is
derived from `JWT_SECRET` via HMAC under a distinct namespace — which means a
`JWT_SECRET` leak would also expose the lease key.

**Set a dedicated `PROXY_LEASE_SECRET` (>=32 chars).** The code warns once at boot when
the fallback is used. Rotating the secret invalidates every live lease (drops active
tool sessions), so rotate during a maintenance window, not mid-day.

## Extension host permissions

`chrome-extension/manifest.json` requests `http://*/*` and `https://*/*` host
permissions (broad) because the set of proxied tool origins varies. Content scripts and
`externally_connectable` ARE correctly pinned to the dashboard origins only. The
extension is self-distributed (has a `key`), so this is a trust/attack-surface
consideration, not a Web-Store review blocker. Narrow to explicit tool origins if/when
the tool list stabilizes.
