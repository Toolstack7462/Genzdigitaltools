# WriteHuman — Disaster Recovery & Operations Runbook

The WriteHuman session that clients use is served from the **MySQL `ProxyAccount` vault** (tool
`writehuman`, `sessionEncrypted`), kept fresh by a **Cookie Sync Agent** running next to a logged-in
Chrome on the **RDP box**. Everything below is about keeping that loop alive.

## Architecture (what runs where)
- **RDP (Windows)** — Chrome (`C:\wh-profile`, logged into WriteHuman, `--remote-debugging-port=9222`)
  + Cookie Sync Agent (`C:\Projects\writehuman-v2\agent\cookie-sync-agent.js`, task `WriteHumanV2Agent`)
  + watchdog (`WriteHumanWatchdog`, 5-min) + autologon.
- **api backend** — `POST /api/crm/proxy/agent/writehuman/cookies` (key-gated) → writes the MySQL vault;
  periodic read-only auto-verify (`cron/proxyVerifyScheduler.js`); dashboard `/admin/writehuman`.
- **client gateway** — `writehuman1.genzdigitalstore.com` serves the MySQL vault to clients.

## The only 3 things you must protect / back up
1. **`PROXY_AGENT_SYNC_KEY`** — must be IDENTICAL in the api app `.env` and the RDP `run-agent.cmd`.
2. **The WriteHuman account login** (credentials) — needed to log Chrome back in. Store in your
   password manager / secret vault. This is the one thing automation can't recreate.
3. **RDP provisioning params** — `bootstrap.ps1 -AgentKey <key> -AdminPassword <pw>`.

> The encrypted cookie vault itself is **self-healing** — you do NOT need to back it up. If MySQL is
> restored empty, the agent re-syncs fresh cookies from the live browser within one poll. The vault is
> a cache of the browser session, not the source of truth.

## Health at a glance
Open `/admin/writehuman`. The header chip shows **healthy / degraded / down**. Email alerts fire on
session down/recovered and agent-stale (set `PROXY_ALERT_EMAIL`). Key signals: Session status,
Sync agent (live/stale), Chrome/CDP, Access-token-valid ETA, Last sync.

## Recovery scenarios

### 1. Agent down (Sync agent = stale, no reports)
The watchdog restarts it within 5 min. Manual:
```
ssh tinyrdp "powershell -NoProfile -Command \"Start-ScheduledTask -TaskName WriteHumanV2Agent\""
```
Confirm a fresh `starting` line + `cookie_synchronized`/`heartbeat` in `C:\Projects\writehuman-v2\agent.log`.
(Gotcha: `run-agent.cmd` MUST be PowerShell-generated ASCII — a node/scp-written `.cmd` makes cmd
exit 0x1 and never launch node. Regenerate via `bootstrap.ps1` if in doubt.)

### 2. Session needs_login (dashboard = down, `needs_login`)
The browser logged out; only a human with the credentials can fix it.
1. RDP in (autologon session) and open the debug Chrome (or run `chrome-debug.cmd`).
2. Log into WriteHuman with the operator account.
3. Within one agent poll the vault refreshes and the dashboard returns to healthy.

### 3. CDP down but a session is present
Watchdog triggers `WriteHumanChromeDebug` (needs an interactive session). Manual: run
`C:\Projects\writehuman-v2\chrome-debug.cmd` in the logged-on session (it kills stray Chrome first).

### 4. RDP box is dead → provision a replacement
On the new Windows box (Chrome installed):
```
# copy the writehuman-v2/ tree to C:\Projects\writehuman-v2 (scp/git), then:
powershell -File C:\Projects\writehuman-v2\rdp\bootstrap.ps1 -AgentKey <PROXY_AGENT_SYNC_KEY> -AdminPassword <pw>
```
Then log into WriteHuman once in the Chrome it opens. `bootstrap.ps1` is idempotent: Node 22, agent,
launchers, the 3 tasks, autologon. No api-side change is needed (same key). If the new box has a
different egress IP, update `PROXY_AGENT_SYNC_ALLOW_IPS` on the api `.env`.

### 5. Suspected agent-key compromise → rotate
1. Pick a new 64-hex key.
2. Set it on the RDP: re-run `bootstrap.ps1 -AgentKey <new>` (regenerates `run-agent.cmd`) or edit +
   restart the task.
3. Set the same value as `PROXY_AGENT_SYNC_KEY` in the api `.env` and restart the app.
   (Order doesn't matter — the agent retries; a brief mismatch just delays sync.)
Also rotate the SFTP password if it may have leaked.

## Post-recovery verification
- `agent.log` shows `cookie_synchronized {result:"working"}` (or steady `heartbeat`).
- `/admin/writehuman` chip = healthy; Access-token-valid shows a positive ETA; Last sync is recent.
- A client "Open" serves a logged-in WriteHuman session (or use the vault's active-account probe).

## Useful env (api app)
`PROXY_AGENT_SYNC_KEY` (required to activate ingest) · `PROXY_AGENT_SYNC_ALLOW_IPS` (pin to the RDP
egress IP) · `PROXY_ALERT_EMAIL` (alerts) · `PROXY_VERIFY_SCHEDULER=0` (disable auto-verify) ·
`PROXY_VERIFY_INTERVAL_MS` / `PROXY_VERIFY_STALE_MS` (cadence).
