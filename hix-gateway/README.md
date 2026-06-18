# HIX AI Gateway — `hix1.genzdigitalstore.com`

Standalone, **dependency-free** Node.js reverse proxy for HIX AI. Self-contained and
**separate** from StealthWriter and from BypassGPT (each tool has its own gateway
folder, subdomain, target origin and encrypted cookie vault).

> Hostinger GitHub deploy: set **Root / Application directory** to `hix-gateway`
> (NOT `backend`). Startup file `server.js`. Node 18+.

## What it does
1. Accepts a signed **30-minute** lease at `/gateway?lease=TOKEN`, stores a
   host-scoped cookie, redirects to `HIX_DEFAULT_PATH`.
2. Validates the lease on every request (local JWT + backend `/validate` on HTML).
3. Reverse-proxies to `https://hix.ai`, attaching the selected vault account's
   cookies **server-side** (never to the browser), hiding account/email/plan/
   pricing/billing/subscription/upgrade/logout/API-keys/profile, and injecting a
   small widget (Gen Z Digital Store · HIX AI · session time · support).
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
| `TOOL_KEY` | `hix` (lease `tool` must match) |
| `TOOL_NAME` | `HIX AI` |
| `HIX_TARGET_ORIGIN` | `https://hix.ai` |
| `HIX_DEFAULT_PATH` | `/app/bypass-ai-detection/dashboard` |
| `SIGNIN_PATH` | `/login` |
| `GATEWAY_PUBLIC_ORIGIN` | `https://hix1.genzdigitalstore.com` |
| `API_BASE` | `https://api.genzdigitalstore.com/api/crm/proxy/gateway` |
| `LEASE_SECRET` | **required** — must equal backend `PROXY_LEASE_SECRET` |
| `GATEWAY_KEY` | **required** — must equal backend `PROXY_GATEWAY_KEY` |

Never commit the real `.env`. Never logs cookies/tokens/secrets.
