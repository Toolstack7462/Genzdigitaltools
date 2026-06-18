# BypassGPT Gateway — `bypassgpt1.genzdigitalstore.com`

Standalone, **dependency-free** Node.js reverse proxy for BypassGPT. Self-contained
and **separate** from StealthWriter and from HIX AI (each tool has its own gateway
folder, subdomain, target origin and encrypted cookie vault).

> Hostinger GitHub deploy: set **Root / Application directory** to `bypassgpt-gateway`
> (NOT `backend`). Startup file `server.js`. Node 18+.

## What it does
1. Accepts a signed **30-minute** lease at `/gateway?lease=TOKEN`, stores a
   host-scoped cookie, redirects to `BYPASSGPT_DEFAULT_PATH`.
2. Validates the lease on every request (local JWT + backend `/validate` on HTML).
3. Reverse-proxies to `https://www.bypassgpt.ai`, attaching the selected vault
   account's cookies **server-side** (never to the browser), hiding account/email/
   plan/pricing/billing/subscription/upgrade/logout/API-keys/profile, and injecting
   a small widget (Gen Z Digital Store · BypassGPT · session time · support).
   **No usage metering, no daily limits.**

## Run
```bash
cp .env.example .env   # fill LEASE_SECRET + GATEWAY_KEY
npm start              # = node server.js → listens on process.env.PORT || 3000
```
No dependencies — `npm install` is a no-op.

## Config (defaults baked in; override via env)
| Var | Default |
|-----|---------|
| `PORT` | `3000` (Passenger injects it) |
| `TOOL_KEY` | `bypassgpt` (lease `tool` must match) |
| `TOOL_NAME` | `BypassGPT` |
| `BYPASSGPT_TARGET_ORIGIN` | `https://www.bypassgpt.ai` |
| `BYPASSGPT_DEFAULT_PATH` | `/ai-humanizer` |
| `SIGNIN_PATH` | `/sign-in` |
| `GATEWAY_PUBLIC_ORIGIN` | `https://bypassgpt1.genzdigitalstore.com` |
| `API_BASE` | `https://api.genzdigitalstore.com/api/crm/proxy/gateway` |
| `LEASE_SECRET` | **required** — must equal backend `PROXY_LEASE_SECRET` |
| `GATEWAY_KEY` | **required** — must equal backend `PROXY_GATEWAY_KEY` |

Never commit the real `.env`. Never logs cookies/tokens/secrets.
