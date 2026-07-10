# Gen Z Claude Gateway (claude.ai)

A standalone, **dependency-free** Node.js (core `http`) reverse proxy for **Claude**,
deployed on its own subdomain with its own `.env`. It is the **same generic engine** as
`proxy-gateway/server.js` (kept byte-identical so fixes apply everywhere); Claude lives
in its own folder so its logic stays **fully isolated** from
StealthWriter / HIX / BypassGPT / WriteHuman / ChatGPT / Ryne / Grok and from the
extension/cookie tools.

| Tool | Subdomain | TARGET_ORIGIN | DEFAULT_PATH |
|------|-----------|---------------|--------------|
| Claude | `claude1.genzdigitalstore.com` | `https://claude.ai` | `/new` |

Claude keeps its **own encrypted cookie vault** (the backend scopes `ProxyAccount`
rows by `tool=claude`), its **own lease cookie**, and its **own client grants**.

> **Status: SUPPORTED (verify on deploy).** claude.ai authenticates with an httpOnly
> `sessionKey` cookie the server reads on every request — a server-rendered cookie session
> like HIX/Grok, attached server-side. It sits behind Cloudflare; the gateway pins a fixed
> UA + client-hints so a captured `cf_clearance` stays valid and renders the REAL challenge
> for the user to solve (never bypassed). If claude.ai ever gates normal browsing behind an
> interactive iframe challenge a datacenter IP can't pass, flip `CF_CHALLENGE_MODE` to
> `unsupported` — **env only, no code change**.

## What it does
1. Accepts a signed lease at `/gateway?lease=TOKEN`, stores a host-scoped cookie, and
   redirects to `DEFAULT_PATH`.
2. Validates the lease on **every** request — locally (JWT signature + expiry) and, on
   HTML page loads, via the backend `/api/crm/proxy/gateway/validate` (authority for
   revocation/expiry/access).
3. Reverse-proxies to `claude.ai`, **attaching the selected vault account's cookies
   server-side** (never exposed to the browser). On a real sign-in redirect (`/login`) it
   flags the account `session_expired` (skipped for new leases).
4. **Hides account / email / plan / pricing / billing / subscription / upgrade /
   logout / API-keys / profile** at the server + overlay, and shows a small
   bottom-right widget: *Gen Z Digital Store*, the tool name, the session countdown,
   and a support button. **No usage metering, no daily limits.**
5. **Cloudflare-aware:** pins a fixed browser UA + client-hints so a captured
   `cf_clearance` stays valid, and renders the **real** Cloudflare challenge for the
   user to solve manually. It never bypasses or auto-solves a challenge, login,
   captcha, payment or rate limit.
6. **Graceful, never blank:** friendly retry/notice page on upstream errors,
   reload-loop breaker, and a lease-free health route at `/__genz/health`.

## Session length (countdown) is customizable
The countdown the client sees is the **backend lease length**, set:
- **per client** in Admin → Proxy Tools → Claude → Client Access (Session length field), or
- globally via backend env `CLAUDE_LEASE_MINUTES` / `PROXY_LEASE_MINUTES` (default 30).

The gateway needs no config for this — it just honors the lease's expiry.

## Run
```bash
cp .env.claude.example .env   # fill secrets (LEASE_SECRET / GATEWAY_KEY must equal backend)
npm start                     # = node server.js → listens on PORT (default 3000)
```
No dependencies — `npm install` is a no-op.

## Hostinger Node.js app setup
1. Create the subdomain `claude1.genzdigitalstore.com` (hPanel — DNS + vhost; SFTP
   cannot create a subdomain).
2. Upload this folder to `/home/u171982351/claude-gateway` (server.js, public/,
   package.json, tmp/).
3. Wire Passenger via the subdomain's `public_html/.htaccess` (LiteSpeed picks it up):
   ```apache
   PassengerAppRoot /home/u171982351/claude-gateway
   PassengerAppType node
   PassengerNodejs /opt/alt/alt-nodejs22/root/bin/node
   PassengerStartupFile server.js
   PassengerBaseURI /
   PassengerRestartDir /home/u171982351/claude-gateway/tmp

   SetEnv TOOL_KEY claude
   SetEnv TOOL_NAME Claude
   SetEnv TARGET_ORIGIN https://claude.ai
   SetEnv DEFAULT_PATH /new
   SetEnv SIGNIN_PATH /login
   SetEnv GATEWAY_PUBLIC_ORIGIN https://claude1.genzdigitalstore.com
   SetEnv API_BASE https://api.genzdigitalstore.com/api/crm/proxy/gateway
   SetEnv CF_CHALLENGE_MODE passthrough
   SetEnv CF_CHALLENGE_PASSTHROUGH 1
   SetEnv RESET_STORAGE_ON_NEW_LEASE 1
   # SetEnv HIDE_SELECTORS <fill from the live logged-in DOM — see "Before go-live" below>
   SetEnv LEASE_SECRET <SAME AS BACKEND PROXY_LEASE_SECRET>
   SetEnv GATEWAY_KEY <SAME AS BACKEND PROXY_GATEWAY_KEY>
   ```
   (Copy the `LEASE_SECRET` / `GATEWAY_KEY` SetEnv lines verbatim from any existing
   `*1` gateway's `.htaccess` — all proxy tools share ONE secret pair.) Delete any
   Hostinger `default.php` from the docroot.
4. Restart: write `tmp/restart.txt`. Verify:
   - `curl -s https://claude1.genzdigitalstore.com/__genz/health` → `{"ok":true,...}`
   - `curl -o/dev/null -w '%{http_code}' https://claude1.genzdigitalstore.com/` → **403**
     (block page = up, lease required; 502 = app not booting).

Or use the repo's `deploy-claude-gateway.sh` (uploads the folder over SFTP + restarts +
verifies health) once the subdomain + `.htaccess` exist. See its header for usage.

## Before go-live (audit findings — do these first)
Two items make the tool unsafe/broken for clients until verified against the LIVE app:

1. **Identity shield (BLOCKER).** The shared ACCOUNT_SHIELD blocks account/settings/billing
   *navigation* and stubs billing APIs, but does NOT guarantee claude.ai's bottom-left
   **sidebar account control** (name/initials → on click: email, "Upgrade", org/workspace
   switcher, "Max"/"Team" plan badge) is visually hidden — claude.ai uses obfuscated class
   names the generic heuristics can miss (HIX/Ryne needed tool-specific selectors). Open the
   live logged-in app through the gateway, inspect that control + its popover, and set exact
   `HIDE_SELECTORS`. Do a client's-eye pass before granting any client.
2. **Verification is ADVISORY, not authoritative (measured 2026-07-10).** Logged-out
   `GET /new` returns **HTTP 200** (a JS shell — it does NOT redirect to `/login`), and
   `/api/*` is Cloudflare-challenged (403) from a datacenter IP. So the server-side verifier
   cannot reliably tell logged-in from logged-out: a dead session can read `working`. Keep the
   vault account logged in and refresh it with **Capture via proxy** (captures the httpOnly
   `sessionKey` in-context), not a cookie paste. A truly robust health signal would need the
   WriteHuman-style live-browser + cookie-sync agent — intentionally out of scope here.

Also confirm on first deploy: `CF_CHALLENGE_PASSTHROUGH=1` is set (else a Cloudflare challenge
loops), `RESET_STORAGE_ON_NEW_LEASE=1` is set (clean account switching), and no core Claude API
path collides with the billing-stub word-list (chat/completion endpoints don't — low risk).

## Backend (already done in this repo)
- `claude` is registered in `backend/utils/proxy/tools.js` (registry-driven → it appears
  automatically in Admin Proxy Tools, the vault, client access, CORS, verify, capture,
  and the client Dashboard / My Tools).
- A dedicated admin page lives at `/admin/claude` (sidebar → Claude); it embeds the
  generic Proxy-Tools management UI locked to `claude`.
- No new backend file — all edits are to files the deploy script already ships.

See `../STEALTHWRITER_MODULE.md` / `../PROXY_TOOLS_MODULE.md` for the shared design.
