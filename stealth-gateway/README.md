# StealthWriter Proxy Gateway

A standalone, **dependency-free** Node.js (Express-style, core `http`) reverse proxy
for `stealth1.genzdigitalstore.com`. It is fully isolated from the main Gen Z
backend/admin/client/extension code — deploy it as its **own** Node.js app.

> Deploying from Hostinger's GitHub import: set **Root / Application directory** to
> `stealth-gateway` (NOT `backend`). This folder is a self-contained app with its
> own `package.json` and `npm start`.

## What it does

1. Accepts a signed lease at `/gateway?lease=TOKEN`, stores it in a host-scoped
   cookie, and redirects to the app root.
2. Validates the lease on **every** request — locally (JWT signature + expiry) and,
   for HTML page loads, authoritatively via the Gen Z backend
   (`/api/crm/stealth/gateway/validate`), which is the single source of truth for
   revocation, client status, plan expiry and usage limits.
3. Reverse-proxies everything else to the real StealthWriter origin, injecting a
   small usage overlay (30-minute countdown + remaining limits), metering
   humanize / AI-detector calls, hiding pricing/billing UI, and stripping
   frame-blocking headers. Serves a block page once the lease is invalid/expired.

## Run

```bash
cp .env.example .env   # fill in values (see below)
npm start              # = node server.js  →  listens on PORT (default 3000)
```

There are **no dependencies** — `npm install` is a no-op. `npm start` runs
`node server.js`, which listens on `process.env.PORT || 3000`.

## Environment (`.env`)

| Var | Purpose |
|-----|---------|
| `PORT` | Listen port. Hostinger/Passenger injects this; defaults to `3000`. |
| `STEALTH_TARGET_ORIGIN` | Real StealthWriter origin to proxy, e.g. `https://stealthwriter.ai`. |
| `STEALTH_API_BASE` | Gen Z backend gateway API, e.g. `https://api.genzdigitalstore.com/api/crm/stealth/gateway`. |
| `GATEWAY_PUBLIC_ORIGIN` | This gateway's public origin, e.g. `https://stealth1.genzdigitalstore.com`. |
| `STEALTH_LEASE_SECRET` | Must match the backend's `STEALTH_LEASE_SECRET` so leases verify locally (min 32 chars). |

Never commit the real `.env` — it is git-ignored. Only `.env.example` is tracked.

## Files

```
stealth-gateway/
├── server.js            # the proxy/gateway (core http, no deps)
├── package.json         # npm start → node server.js
├── .env.example         # template; copy to .env (ignored)
├── README.md
└── public/
    ├── overlay.js       # injected usage overlay (countdown, limits, metering)
    └── overlay.css
```

`server.js` reads `public/overlay.js` and `public/overlay.css` at startup, so the
`public/` folder must be deployed alongside it.

## Hostinger Node.js app setup

1. Create subdomain `stealth1.genzdigitalstore.com`.
2. Setup Node.js App → Application root: `stealth-gateway`, URL: the subdomain,
   Startup file: `server.js`, Node 18/20, mode Production.
3. Set the `.env` values above (lease secret must equal the backend's), then Start.

See `../STEALTHWRITER_MODULE.md` for the full module architecture and testing checklist.
