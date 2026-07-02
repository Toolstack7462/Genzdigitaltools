# Running the Cookie Sync Agent as a Windows service (on the RDP)

Keeps `cookie-sync-agent.js` running 24/7 next to the always-on Chrome, auto-starting at boot
and restarting if it ever exits. **Node ≥ 22** is required on the RDP (the agent uses the
global `WebSocket`). Chrome must be launched with remote debugging:

```
chrome.exe --user-data-dir="C:\wh-profile" --remote-debugging-port=9222
```

Pick ONE of the two options below.

## Option A — NSSM service (recommended)

A true Windows service with auto-restart on crash. Download `nssm.exe`
(https://nssm.cc/download) and put it in PATH or in this folder, then in an **elevated**
PowerShell:

```powershell
powershell -ExecutionPolicy Bypass -File install-service.ps1 -AgentKey "<WRITEHUMAN_V2_AGENT_KEY>"
```

Manage it: `nssm restart WriteHumanV2Agent` · `nssm stop …` · `nssm remove … confirm`.
Logs rotate into `agent.out.log` / `agent.err.log` beside the scripts.

## Option B — Scheduled Task (no extra software)

1. Edit `run-agent.cmd` and set `WHV2_AGENT_KEY` (and the ingest URL if different).
2. In an **elevated** PowerShell:
   ```powershell
   powershell -ExecutionPolicy Bypass -File register-task.ps1
   ```
Runs at logon, restarts on failure every minute. Manage with
`Start-ScheduledTask WriteHumanV2Agent` / `Stop-ScheduledTask …` / `Unregister-ScheduledTask …`.

## Verify it's working

- Agent logs show `cookie_synchronized` after the first push (or `cookie_unchanged`).
- The V2 admin panel (`https://writehuman2.genzdigitalstore.com/v2/admin`) shows
  **Account status → active**, **Has cookies → yes** shortly after the agent starts.

## Notes

- Order of startup doesn't matter: if Chrome's debug port isn't up yet, the agent logs
  `cdp_read_failed` and retries on the next poll — it won't crash.
- The agent only ever sends the **auth** cookies (never analytics), and never logs values.
- One poll every `WHV2_POLL_MS` (default 2 min); change cookies in the browser and the next
  poll syncs them.
