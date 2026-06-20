# Gen Z Grok Gateway (grok.com)

A standalone, **dependency-free** Node.js (core `http`) reverse proxy for **Grok**,
deployed on its own subdomain with its own `.env`. It is the **same generic engine**
as `proxy-gateway/server.js` (kept byte-identical so fixes apply everywhere); Grok
lives in its own folder so its logic stays **fully isolated** from
StealthWriter / HIX / BypassGPT / WriteHuman / ChatGPT and from the extension/cookie
tools.

| Tool | Subdomain | TARGET_ORIGIN | DEFAULT_PATH |
|------|-----------|---------------|--------------|
| Grok | `grok1.genzdigitalstore.com` | `https://grok.com` | `/chat` |

Grok keeps its **own encrypted cookie vault** (the backend scopes `ProxyAccount`
rows by `tool=grok`), its **own lease cookie**, and its **own client grants**.

## What it does
1. Accepts a signed lease at `/gateway?lease=TOKEN`, stores a host-scoped cookie, and
   redirects to `DEFAULT_PATH`.
2. Validates the lease on **every** request — locally (JWT signature + expiry) and, on
   HTML page loads, via the backend `/api/crm/proxy/gateway/validate` (authority for
   revocation/expiry/access).
3. Reverse-proxies to `grok.com`, **attaching the selected vault account's cookies
   server-side** (never exposed to the browser). On a real sign-in redirect it flags
   the account `session_expired` (skipped for new leases).
4. **Hides account / email / plan / pricing / billing / subscription / upgrade /
   logout / API-keys / profile** at the server + overlay, and shows a small
   bottom-right widget: *Gen Z Digital Store*, the tool name, the session countdown,
   and a support button. **No usage metering, no daily limits.**
5. **Cloudflare-aware:** pins a fixed browser UA + client-hints so a captured
   `cf_clearance` stays valid, and renders the **real** Turnstile/Cloudflare challenge
   for the user to solve manually. It never bypasses or auto-solves a challenge,
   login, captcha, payment or rate limit.
6. **Graceful, never blank:** friendly retry/notice page on upstream errors,
   reload-loop breaker, and a lease-free health route at `/__genz/health`.

## Session length (countdown) is customizable
The countdown the client sees is the **backend lease length**, set:
- **per client** in Admin → Proxy Tools → Grok → Client Access (Session length field), or
- globally via backend env `GROK_LEASE_MINUTES` / `PROXY_LEASE_MINUTES` (default 30).

The gateway needs no config for this — it just honors the lease's expiry.

## Run
```bash
cp .env.example .env     # fill secrets (LEASE_SECRET / GATEWAY_KEY must equal backend)
npm start                # = node server.js → listens on PORT (default 3000)
```
No dependencies — `npm install` is a no-op.

## Hostinger Node.js app setup
1. Create the subdomain `grok1.genzdigitalstore.com` (hPanel — DNS + vhost; SFTP
   cannot create a subdomain).
2. Upload this folder to `/home/u171982351/grok-gateway` (server.js, public/,
   package.json, tmp/).
3. Wire Passenger via the subdomain's `public_html/.htaccess` (LiteSpeed picks it up):
   ```apache
   PassengerAppRoot /home/u171982351/grok-gateway
   PassengerAppType node
   PassengerNodejs /opt/alt/alt-nodejs22/root/bin/node
   PassengerStartupFile server.js
   PassengerBaseURI /
   PassengerRestartDir /home/u171982351/grok-gateway/tmp

   SetEnv TOOL_KEY grok
   SetEnv TOOL_NAME Grok
   SetEnv TARGET_ORIGIN https://grok.com
   SetEnv DEFAULT_PATH /chat
   SetEnv SIGNIN_PATH /
   SetEnv GATEWAY_PUBLIC_ORIGIN https://grok1.genzdigitalstore.com
   SetEnv API_BASE https://api.genzdigitalstore.com/api/crm/proxy/gateway
   SetEnv LEASE_SECRET <SAME AS BACKEND PROXY_LEASE_SECRET>
   SetEnv GATEWAY_KEY <SAME AS BACKEND PROXY_GATEWAY_KEY>
   ```
   (Copy the `LEASE_SECRET` / `GATEWAY_KEY` SetEnv lines verbatim from any existing
   `*1` gateway's `.htaccess` — all proxy tools share ONE secret pair.) Delete any
   Hostinger `default.php` from the docroot.
4. Restart: write `tmp/restart.txt`. Verify:
   - `curl -s https://grok1.genzdigitalstore.com/__genz/health` → `{"ok":true,...}`
   - `curl -o/dev/null -w '%{http_code}' https://grok1.genzdigitalstore.com/` → **403**
     (block page = up, lease required; 502 = app not booting).

## Backend (already done in this repo)
- `grok` is registered in `backend/utils/proxy/tools.js` (registry-driven → it appears
  automatically in Admin Proxy Tools, the vault, client access, CORS, verify, capture,
  and the client Dashboard / My Tools).
- No new backend file — all edits are to files the deploy script already ships.

See `../STEALTHWRITER_MODULE.md` / `../PROXY_TOOLS_MODULE.md` for the shared design.
