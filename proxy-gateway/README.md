# Gen Z Proxy-Tool Gateway (HIX AI / BypassGPT / ChatGPT / Ryne AI / WriteHuman)

A standalone, **dependency-free** Node.js (core `http`) reverse proxy. The SAME code
is deployed **once per tool**, each on its own subdomain with its own `.env`:

| Tool | Subdomain | TARGET_ORIGIN | DEFAULT_PATH |
|------|-----------|---------------|--------------|
| HIX AI | `hix1.genzdigitalstore.com` | `https://hix.ai` | `/app/bypass-ai-detection/dashboard` |
| BypassGPT | `bypassgpt1.genzdigitalstore.com` | `https://www.bypassgpt.ai` | `/ai-humanizer` |
| ChatGPT | `chatgpt1.genzdigitalstore.com` | `https://chatgpt.com` | `/` |
| Ryne AI | `ryne1.genzdigitalstore.com` | `https://ryne.ai` | `/` |
| WriteHuman | `writehuman1.genzdigitalstore.com` | `https://writehuman.ai` | `/` |

Each deployment is **fully independent**: separate origins, separate cookie
vaults (the backend scopes accounts by the lease's `tool`), separate lease cookies.
This is isolated from StealthWriter and from the existing extension/cookie tools.

## What it does
1. Accepts a signed **30-minute** lease at `/gateway?lease=TOKEN`, stores a
   host-scoped cookie, redirects to the tool's `DEFAULT_PATH`.
2. Validates the lease on **every** request — locally (JWT signature + expiry) and,
   on HTML page loads, via the Gen Z backend `/api/crm/proxy/gateway/validate`
   (authority for revocation/expiry/access).
3. Reverse-proxies to the real tool, **attaching the selected vault account's
   cookies server-side** (never exposed to the browser). On a real `/sign-in`
   redirect it flags the account `session_expired` (skipped for new leases).
4. **Hides account / email / plan / pricing / billing / subscription / upgrade /
   logout / API-keys / profile** at the server (block or sanitize) and shows only a
   small bottom-right widget: *Gen Z Digital Store*, the tool name, session time
   left, and a support button. **No usage metering, no daily limits.**

## Run
```bash
cp .env.hix.example .env        # or .env.bypassgpt.example
npm start                       # = node server.js → listens on PORT (default 3000)
```
No dependencies — `npm install` is a no-op.

## Environment (`.env`)
| Var | Purpose |
|-----|---------|
| `PORT` | Listen port (Passenger injects it; default 3000). |
| `TOOL_KEY` | `hix`, `bypassgpt`, `chatgpt`, `ryne` or `writehuman` — the lease's `tool` must match. |
| `TOOL_NAME` | Display name in the widget / block pages. |
| `TARGET_ORIGIN` | Real tool origin to proxy. |
| `DEFAULT_PATH` | Where a client lease lands after the cookie is set. |
| `SIGNIN_PATH` | Where an admin **capture** lease lands to log in fresh. |
| `GATEWAY_PUBLIC_ORIGIN` | This gateway's public origin. |
| `API_BASE` | Backend gateway API, `https://api.genzdigitalstore.com/api/crm/proxy/gateway`. |
| `LEASE_SECRET` | MUST equal the backend `PROXY_LEASE_SECRET` (min 32 chars). |
| `GATEWAY_KEY` | MUST equal the backend `PROXY_GATEWAY_KEY` (enables account-session injection). |

Never commit the real `.env` — only the `*.example` files are tracked.

## Hostinger Node.js app setup (per tool)
1. Create the subdomain (`hix1` / `bypassgpt1` / `chatgpt1`).
2. Setup Node.js App → Application root: the tool's gateway folder (e.g.
   `chatgpt-gateway`, a copy of `proxy-gateway`), URL: the subdomain,
   Startup file: `server.js`, Node 18+, Production.
3. Set the `.env` values above (lease secret + gateway key must equal the backend's),
   then Start.

### Adding ChatGPT (or any new tool)
1. Register the tool in `backend/utils/proxy/tools.js` (key, name, target origin,
   gateway URL) and deploy that file to the API app.
2. Create the subdomain + Node app as above; on the server, copy `proxy-gateway/`
   to `~/<tool>-gateway/` and drop in `.env` (from `.env.<tool>.example`).
3. In Admin → Proxy Tools, pick the new tool, add an account to its vault (paste or
   "Refresh Through Proxy"), then grant client access. No frontend change is needed —
   the tool list is registry-driven.

ChatGPT specifics live in `.env.chatgpt.example` (streaming, Cloudflare/cf_clearance,
assets, why `IDENTITY_SHIELD` stays off).

See `../STEALTHWRITER_MODULE.md` for the shared design rationale.
