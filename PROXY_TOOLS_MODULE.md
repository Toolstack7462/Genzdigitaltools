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

---

## Grok (added) — `grok1.genzdigitalstore.com`
Grok is added as a normal, **isolated** proxy tool — NOT an API integration. It reuses
the exact same backend cookie/session vault + reverse-proxy/lease architecture as the
other proxy tools and is **registry-driven**, so it appears automatically in Admin
Proxy Tools, Assignments, the Client Dashboard and My Tools once registered + granted.

- **Registry:** one entry `grok` in `backend/utils/proxy/tools.js`
  (`TARGET_ORIGIN=https://grok.com`, gateway `grok1.genzdigitalstore.com`,
  `DEFAULT_PATH=/chat`). grok.com is the standalone cookie-session web app (not
  `x.com/i/grok`). No mixing with StealthWriter/HIX/BypassGPT/WriteHuman/ChatGPT logic.
- **Vault / admin:** the existing `/admin/proxy-tools/:tool/...` routes already serve
  Grok — add multiple accounts, cookies encrypted at rest (AES-256-GCM, never returned
  after save), verify against a logged-in page, statuses
  active/standby/session_expired/blocked/limit_reached, refresh + capture-via-proxy.
- **Gateway:** dedicated **`grok-gateway/`** folder (a copy of the generic, hardened
  `proxy-gateway/server.js`, byte-identical so fixes apply everywhere). Cookies are
  attached **server-side**; never set in the browser. Cloudflare/Turnstile-aware
  (pinned UA/client-hints, renders the REAL challenge for the user to solve). Health
  route `GET /__genz/health`, friendly notice/block pages (never blank), reload-loop
  breaker. Safe logs only (route/target/status/account_id/lease/error) — never cookies,
  tokens, sessions or secrets. Deploy steps + the `public_html/.htaccess` SetEnv block
  are in `grok-gateway/README.md` and `grok-gateway/.env.example`.
- **Unsupported fallback:** if Grok blocks reverse-proxy use or needs an unsupported
  browser-security flow, the gateway shows a clear notice/block page and the account
  verifies as `session_expired`/`unknown` — mark it blocked/session_expired in the
  vault. Nothing else breaks.

### Customizable countdown (session length)
The client-facing countdown = the backend lease length, now **configurable** instead of
a fixed 30 min (the overlay countdown is driven by the lease's expiry, so changing the
length changes the countdown):
- **Per-client:** `ProxyClient.leaseMinutes` (1–1440), editable in Admin → Proxy Tools →
  *(tool)* → Client Access → *Session length*.
- **Per-tool / global default** (used when a client has no override): env
  `GROK_LEASE_MINUTES` (or `<TOOL>_LEASE_MINUTES`) → `PROXY_LEASE_MINUTES` → 30.
- Resolved in `routes/client/proxyTools.js` via `tools.defaultLeaseMinutes()`; the
  effective value is returned to the client card and the admin table.

### Deploy notes
- **No `deploy-hostinger.sh` change needed** — every edited backend file
  (`utils/proxy/tools.js`, `models/proxy/ProxyClient.js`, `routes/admin/proxyTools.js`,
  `routes/client/proxyTools.js`) is already in the curl list. CORS auto-derives the
  `grok1` origin from `TOOL_KEYS`. `leaseMinutes` is a JSON field — no migration.
- **Frontend** changes (`ProxyToolCard.js`, `AdminProxyTools.js`) require
  `cd frontend && npm run build` before `deploy-hostinger.sh`.
- **Gateway** is deployed manually (like the others): create the `grok1` subdomain in
  hPanel, upload `grok-gateway/` to `~/grok-gateway`, write the subdomain `.htaccess`
  (see README), delete `default.php`, write `tmp/restart.txt`. Verify `/__genz/health`.
