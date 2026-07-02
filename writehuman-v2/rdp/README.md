# WriteHuman V2 — RDP runtime (provisioning + self-healing)

One-command, idempotent, portable setup for running the Cookie Sync Agent 24/7 on a Windows
RDP/VPS. Migrating to a new box is: **clone → `bootstrap.ps1` → log into WriteHuman once.**

## Architecture & decisions

| Decision | Why |
|---|---|
| **Scheduled Tasks** (not NSSM/service) | Built into Windows, zero extra deps, survive reboot, easy to reason about. |
| **Agent = SYSTEM / ONSTART** | Always-on, starts at boot before anyone logs in; SYSTEM can reach the user-session Chrome on `127.0.0.1:9222` (localhost isn't session-isolated). |
| **Chrome = user / ONLOGON** | Chrome needs an interactive GUI session to render + hold the login; runs as the logged-on admin. |
| **Watchdog = SYSTEM / every 5 min** | Self-healing: restarts a dead agent, re-triggers Chrome if the debug port drops, rotates the log. |
| **Autologon via Sysinternals** | Stores the password **LSA-encrypted**, not plaintext in the registry. |
| **Dedicated Chrome profile** `C:\wh-profile` | Isolated, persists the WriteHuman login across reboots, and avoids Chrome swallowing the debug flags (the launcher kills stray Chrome first). |
| **Read-only verify + heartbeat** (server side) | The browser is the sole refresh-token rotator; the agent heartbeats so liveness is accurate. |
| **Secrets as parameters** | Agent key + admin password are passed to `bootstrap.ps1`, never committed or logged. |

### Boot chain (fully unattended)
`reboot → autologon (console) → ChromeDebug task opens Chrome (saved login) → agent (already running as SYSTEM) reads cookies → V2 stays active/working`, with the watchdog covering drift.

## Files
- `bootstrap.ps1` — idempotent provisioner (install Node, deploy agent, launchers, tasks, autologon).
- `watchdog.ps1` — self-healing (run every 5 min by the Watchdog task).
- `status.ps1` — one-shot health report (tasks, CDP, autologon, V2 health, log tail).
- `uninstall.ps1` — teardown (`-DisableAutologon`, `-Purge`).
- `config.json` — generated per-machine (non-secret paths/URLs) for watchdog/status.

## Provision a NEW RDP (migration)
1. Install Chrome. Have the admin password ready.
2. Get the code (git, or download the branch zip):
   ```
   git clone -b writehuman-v2-clone https://github.com/Toolstack7462/Genzdigitaltools.git
   cd Genzdigitaltools\writehuman-v2\rdp
   ```
3. Run the provisioner (elevated), passing the agent key + admin password:
   ```powershell
   powershell -ExecutionPolicy Bypass -File bootstrap.ps1 -AgentKey <WRITEHUMAN_V2_AGENT_KEY> -AdminPassword <ADMIN_PW>
   ```
4. Run `chrome-debug.cmd` and **log into WriteHuman once** in the window that opens (the profile
   then persists the login). Done — reboots are now unattended.

Verify any time: `powershell -File C:\Projects\writehuman-v2\rdp\status.ps1`

## Notes
- Re-running `bootstrap.ps1` is safe (idempotent) — use it to update the agent or repair tasks.
- Rotate the agent key by re-running `bootstrap.ps1 -AgentKey <new>` (and updating it on the V2 server).
- Autologon means console access lands on a logged-in admin desktop — acceptable for a dedicated box.
