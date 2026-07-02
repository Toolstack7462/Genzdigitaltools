# Cookie Sync Agent (Step 2 — implemented)

`cookie-sync-agent.js` runs on the dedicated RDP next to the 24/7 logged-in Chrome profile.
It keeps the V2 service's stored auth cookies in sync with the live browser session, so the
session stays valid for days without manual cookie updates.

## How it works

1. Connects to the always-on Chrome over the **Chrome DevTools Protocol** and reads all
   browser cookies (`Storage.getCookies` on the browser target). No cookie-DB decryption, no
   DPAPI.
2. Keeps **only** the WriteHuman auth cookies — `sb-<ref>-auth-token` (and `.0`/`.1` chunks)
   and `sb-session-token`. Analytics/tracking cookies are ignored.
3. Hashes them (same algorithm as the server's `session/cookieManager.cookieHash`). If the
   hash is unchanged → does nothing. If it changed → `POST /v2/cookies/ingest`.
4. The server replaces (never merges) the stored auth cookies, auto-verifies, and resets the
   smart timer.

Dependency-free: Node's global `fetch` (>=18) and global `WebSocket` (>=22). Never logs cookie
values (counts + 8-char hash prefix only). One infrequent poll, one short-lived CDP connection
per poll; errors are caught and retried on the next tick (no tight loop, no crash).

## Run

```bash
# 1. Launch the 24/7 Chrome with remote debugging on the single WriteHuman profile:
chrome.exe --user-data-dir="C:\wh-profile" --remote-debugging-port=9222

# 2. Run the agent (point it at the V2 service + give it the agent key):
WHV2_INGEST_URL=https://writehuman2.genzdigitalstore.com/v2/cookies/ingest \
WHV2_AGENT_KEY=<WRITEHUMAN_V2_AGENT_KEY> \
WHV2_CDP_URL=http://127.0.0.1:9222 \
WHV2_POLL_MS=120000 \
node agent/cookie-sync-agent.js
```

On Windows, run it as a background service (e.g. NSSM or a Scheduled Task at logon) so it
restarts with the machine.

## Env

| Var | Default | Purpose |
|---|---|---|
| `WHV2_INGEST_URL` | `http://127.0.0.1:3100/v2/cookies/ingest` | V2 ingest endpoint |
| `WHV2_AGENT_KEY` | — (required) | matches `WRITEHUMAN_V2_AGENT_KEY` (or `_ADMIN_KEY`) |
| `WHV2_CDP_URL` | `http://127.0.0.1:9222` | Chrome remote-debugging base |
| `WHV2_TARGET_DOMAIN` | `writehuman.ai` | which cookies to keep |
| `WHV2_SUPABASE_REF` | `hicfsbrfkzsxbwayibfm` | auth-token cookie ref |
| `WHV2_POLL_MS` | `120000` | poll interval (min 15s) |
