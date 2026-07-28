# ChatGPT Gateway (`chatgpt1.genzdigitalstore.com`)

> **This directory was imported FROM PRODUCTION on 2026-07-28, byte-for-byte.**
> It is not a fresh copy of `proxy-gateway/`. Read the provenance section before changing it.

Serves ChatGPT (`chatgpt.com`) as an isolated Passenger app at
`/home/u171982351/chatgpt-gateway`, using the generic reverse-proxy engine.

---

## Provenance — why this exists and why it is not `proxy-gateway/`

Until this import, the running ChatGPT gateway had **no source in the repository at all**:

* the repo had no `chatgpt-gateway/` directory and no chatgpt deploy script;
* the deployed `server.js` matched **no commit** of `proxy-gateway/server.js`;
* the server carried hand-edit backups — `server.js.bak-http2fix`,
  `server.js.bak-precompress`, and three `server.js.bak-20260721-*`.

So the only copy of this code was on the server, and any routine
"deploy `proxy-gateway/` to all tools" would have silently destroyed it.

Measured against its closest ancestor (`ab5e372`), the deployed engine is **227 lines ahead
and 8 behind** — a divergent, newer build. What it uniquely carries includes the pieces of the
ChatGPT HTTP/2 work described in `CHANGELOG`/notes:

* hop-by-hop request-header stripping (`connection`, `keep-alive`, `upgrade`, `te`, `trailer`)
  with the WebSocket upgrade handler re-adding its own;
* `maybeDecompress()` — br/gzip/deflate handling for the branches that must read or rewrite a
  body, while binary/asset bodies pass through compressed;
* a swept `sessionCache` (`_sessionCacheGc`, `.unref()`d) fixing the RSS climb where entries
  keyed by lease jti were only expired on read.

**Therefore: never `cp proxy-gateway/server.js` over this file.** Port changes INTO it
deliberately, one at a time, and diff before and after.

The initial import commit contains the production bytes with **no modifications whatsoever**,
so this directory can always be diffed against what was actually running.

---

## Files

| File | Notes |
|---|---|
| `server.js` | The divergent engine described above. Hand-maintained on the server until this import. |
| `public/overlay.js` | Injected client overlay. |
| `public/overlay.css` | Overlay styles. |
| `package.json` | Still self-describes as `genz-proxy-gateway` — it was copied from the generic engine. Left as-is in the import commit rather than "tidied", so the snapshot stays faithful. |

Not imported (and correctly so): `.env` (secrets), `console.log`/`stderr.log`, `tmp/`,
and the `server.js.bak-*` files, which stay on the server as its local history.

---

## Environment

Configured server-side (Passenger `.htaccess` `SetEnv` and/or the app's own `.env`) — this repo
never carries values. Names read by `server.js`:

```
TOOL_KEY  TOOL_NAME  TARGET_ORIGIN  DEFAULT_PATH  SIGNIN_PATH
GATEWAY_PUBLIC_ORIGIN  API_BASE  LEASE_SECRET  GATEWAY_KEY
CF_CHALLENGE_MODE  CF_CHALLENGE_PASSTHROUGH  CAPTCHA_ORIGINS  ASSET_ORIGINS
ACCOUNT_SHIELD  IDENTITY_SHIELD  HIDE_SELECTORS  NAV_BLOCK_EXTRA  NAV_BLOCK_EXCLUDE
DETECT_LOGGED_OUT  RESET_STORAGE_ON_NEW_LEASE  UPSTREAM_TIMEOUT_MS  PROXY_LOG_ALL  PORT
```

`LEASE_SECRET` / `GATEWAY_KEY` must match the backend's `PROXY_LEASE_SECRET` /
`PROXY_GATEWAY_KEY`.

---

## Deploying

There is still no deploy script for this gateway. Upload `server.js`, `package.json` and
`public/*` to `/home/u171982351/chatgpt-gateway/` over SFTP, then bump
`tmp/restart.txt` to restart Passenger.

**Take a dated `server.js.bak-*` on the server first** — that is the existing convention here,
and it is the only reason the pre-import history survived.

Verify after deploying: `https://chatgpt1.genzdigitalstore.com/__genz/health` → `200` with
`missingEnv: []`, and `/` → `403` (lease-gated).
