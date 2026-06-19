# Proxy-Tools Module — HIX AI & BypassGPT

Two **separate** proxy tools built on the StealthWriter pattern, fully isolated from
StealthWriter, auth, the admin panel, the client dashboard, the extension flow, the
old cookie system, and the existing tools (HIX existing logic, Paperpal, SciSpace,
Jenni). HIX AI and BypassGPT are independent: separate gateway subdomains, separate
target origins, **separate encrypted cookie vaults** (accounts are tagged by `tool`),
separate client grants, separate leases. Nothing is shared except a reusable code
template.

Key differences from StealthWriter (by request):
- **No humanization limit, no AI-detector limit, no usage metering** (no `/consume`).
- 30-minute access lease, exactly like StealthWriter.

## Flow
```
Client dashboard → "Open HIX AI"/"Open BypassGPT" (assigned-tool card)
  POST /api/crm/client/proxy-tools/:tool/open   ← validates grant (status/expiry)
     mints a signed 30-min lease (JWT), picks an account from that tool's vault
  → https://hix1… / https://bypassgpt1….  /gateway?lease=TOKEN
     • host-scoped lease cookie, validates lease every request (+ backend /validate on HTML)
     • attaches the account's cookies SERVER-SIDE (Cookie header) — never to the browser
     • hides account/email/plan/pricing/billing/subscription/upgrade/logout/API-keys/profile
     • injects a small widget: Gen Z Digital Store · <tool> · session time · support
  → real tool (hix.ai / www.bypassgpt.ai), proxied
```

## Backend (all additive)
- `models/proxy/ProxyAccount.js` — vault account, tagged by `tool` (`proxy_accounts`)
- `models/proxy/ProxyLease.js` — 30-min lease, hash only (`proxy_leases`)
- `models/proxy/ProxyClient.js` — per-(user,tool) access grant (`proxy_clients`)
- `utils/proxy/tools.js` — tool registry + per-tool env (target/gateway/path)
- `utils/proxy/vaultCrypto.js` — AES-256-GCM, key `PROXY_VAULT_KEY` (own namespace)
- `utils/proxy/lease.js` — JWT, secret `PROXY_LEASE_SECRET` (own namespace)
- `utils/proxy/accountSelect.js`, `cookies.js`, `verify.js` — isolated copies
- `routes/admin/proxyTools.js`  → `/api/crm/admin/proxy-tools/:tool/...`
- `routes/client/proxyTools.js` → `/api/crm/client/proxy-tools`
- `routes/proxy/gateway.js`     → `/api/crm/proxy/gateway` (validate/session/account-expired/capture-session)
- `db/mysqlAdapter.js` — 3 new table names registered
- `server-crm.js` — 3 mounts + 2 gateway origins added to CORS

## Standalone gateway — `proxy-gateway/`
ONE codebase, deployed twice (one per subdomain) with its own `.env`
(`.env.hix.example`, `.env.bypassgpt.example`). No metering. Identity shield + brand
widget. Never logs cookies/tokens/secrets.

## Backend env (additive — nothing existing changes)
```
PROXY_LEASE_SECRET=<random 32+ chars>     # must match BOTH gateways' LEASE_SECRET
PROXY_GATEWAY_KEY=<random 32+ chars>      # must match BOTH gateways' GATEWAY_KEY
PROXY_VAULT_KEY=<64 hex chars>            # optional; else derived from JWT_SECRET
# Optional overrides (defaults shown):
HIX_GATEWAY_URL=https://hix1.genzdigitalstore.com
HIX_TARGET_ORIGIN=https://hix.ai
HIX_DEFAULT_PATH=/app/bypass-ai-detection/dashboard
BYPASSGPT_GATEWAY_URL=https://bypassgpt1.genzdigitalstore.com
BYPASSGPT_TARGET_ORIGIN=https://www.bypassgpt.ai
BYPASSGPT_DEFAULT_PATH=/ai-humanizer
PROXY_ACCOUNT_SELECTION_MODE=auto_failover
```

## Admin
`/admin/proxy-tools` → tab per tool (HIX AI / BypassGPT). Per tool: Account Vault
(add/update cookies, verify, set primary, mark active/standby/limit_reached/
session_expired/blocked, capture-via-proxy, revoke sessions, delete) and Client
Access (grant/edit/remove, set expiry, revoke sessions).

## Client
HIX AI and BypassGPT appear as normal assigned-tool cards on the Dashboard and My
Tools (not sidebar items). "Open" mints a 30-min lease and opens the gateway tab.

## Safety
For the operator's OWN authorized accounts and client access control only. Does NOT
bypass, modify, reset, increase or interfere with the tools' official usage,
subscription, captcha, login, payment or account limits. Never logs cookies, tokens,
sessions, passwords, authorization headers or secrets.
