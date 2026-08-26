# WriteHuman session sync — how it works and how to run it

One central server-side agent keeps the WriteHuman session fresh. A thin connector on a Windows PC
or RDP is the only thing that touches a browser; all verification and promotion stays on the server.

```
Dedicated "WriteHuman Chrome" (localhost CDP)
      │  connector reads ONLY the allowlisted WriteHuman auth cookies
      ▼
POST /api/crm/proxy/agent/writehuman/cookies   (per-agent credential)
      ▼
candidate → verify expected account → real WriteHuman check → atomic promote → MySQL vault
      ▼
writehuman1 gateway serves the vault to clients
```

## The daily experience

After a one-time install + browser authorization, **normal days need no action**:

- Windows starts → the connector auto-starts (Startup shortcut) → dedicated WriteHuman Chrome stays
  signed in → routine cookie/token rotations sync automatically.
- As long as WriteHuman's refresh session is valid, you stay logged in. No Make Active, no Sync Now,
  no re-authorization.

You are asked to act **only** when the session genuinely fails (see LOGIN_REQUIRED below).

## Install once, per machine

1. Admin → WriteHuman → **Download Windows Agent** → double-click `WriteHuman-Agent-Setup-x64.exe`.
2. A browser page opens → **Authorize This Device** (once).
3. The installer creates the dedicated **WriteHuman Chrome** (Desktop + Start-Menu shortcut) and opens it.
4. **Log in to WriteHuman in that window** (or import valid cookies). Sync then runs on its own.

No Node/Git/PowerShell, no sync key, no pairing code, no admin rights.

### What you see while it installs

The installer is a single self-contained `.exe` (Node SEA — no console script that flashes and
vanishes). It shows a native Windows dialog with a clear result, and prints staged progress to the
console when run from a terminal:

```
Verifying installer… → Installing… → Registering auto-start… → Opening WriteHuman Chrome… → Starting Agent…
```

On success:

```
WriteHuman Agent installed successfully.
Agent status: Running        (or "Starting…" if it is still coming up)
WriteHuman Chrome: Ready
[ Yes → Open WriteHuman Chrome ]   [ No → Close ]
```

On failure the window stays open with the failed stage, an error code, and the log path — it never
just disappears. Standardized exit codes:

| Code | Meaning |
|---|---|
| 0  | Installed |
| 10 | Already installed and healthy (no change) |
| 11 | Repair / update completed |
| 20 | Package validation failed |
| 21 | File installation failed |
| 22 | Auto-start registration failed |
| 23 | Agent start failed |
| 24 | Installed, browser authorization still pending |
| 25 | Dedicated-Chrome setup failed |

### Re-running the installer is safe

- **Already installed & running** → "already installed" dialog with *Open WriteHuman Chrome /
  Repair / Close*. No duplicate agent, no duplicate server device.
- **Damaged or older build** → in-place **repair/update**: it stops the running agent (a running
  `.exe` is locked on Windows), replaces only the program file (copy-with-retry), keeps `config.json`,
  the DPAPI/device credential and the dedicated Chrome login, restores auto-start, and starts exactly
  one agent under the **same** device identity.
- Reinstalling on a machine that already has a device does **not** mint a second device; a stale
  duplicate (e.g. an older reinstall) is auto-**superseded** and hidden from the admin device list.

`WHV2_SILENT=1` runs the installer unattended (no dialog) for scripted/mass deployment.

## The five health signals (admin page)

`backend/utils/proxy/sessionHealth.js` publishes **five independent signals**, not one label. They
are allowed to disagree, because in reality they do.

| Signal | States | Derived from |
|---|---|---|
| **Session health** | HEALTHY · REFRESHING · LOGIN_REQUIRED · ERROR | the stored bundle + server-side verification, *and nothing else* |
| **Verification freshness** | recent · due · failed | when the session was last *proven*, and whether that proof failed |
| **Agent health** | ONLINE · RECONNECTING · OFFLINE · UNKNOWN | heartbeat only |
| **Chrome / CDP** | CONNECTED · DISCONNECTED · UNKNOWN | the active source's last report |
| **Cookie sync** | FRESH · BEHIND · NEVER_SYNCED · FAILED | age of the stored bundle + the last push result |

This is a valid, non-alarming state, and the page says so in as many words:

```
Session      HEALTHY
Agent        OFFLINE
Cookie sync  BEHIND
             using the last verified bundle
```

**LOGIN_REQUIRED fires only on proof** — WriteHuman signed the account out, the session/refresh
token expired or was revoked, the required cookie is missing, a real server-side check failed to
authenticate, or a *fresh* report shows the dedicated Chrome holding zero auth cookies. It never
fires for a late heartbeat, an offline PC, a closed Chrome, an ordinary token rotation, or one
timed-out verify. A stale or offline agent can never change session health.

Wording matters here: the page says **Verification due**, **Agent telemetry stale** or **Cookie
sync behind**. It never says the account or session expired unless it did.

### The one-hour false stale (fixed 2026-08-26)

WriteHuman's Supabase access token lives ~1 hour. The dedicated Chrome is the rotator and it
rotated **late** — measured from a real agent log on the source machine, rotations landed **63, 67,
68 and 86 minutes apart on a 60-minute token**, because Chrome heavily throttles timers in a
backgrounded window. So for 3–26 minutes of *every* hour the stored access token was expired while
the refresh session was perfectly alive and the product kept working.

The old classifier required `!tokenExpired` to say HEALTHY. That single condition made the page
report `degraded` / "working · unverified", turned four cards amber at once, and flipped the
verification result to `unknown` — hourly, on a healthy account. The only cure anyone had was to go
and refresh the RDP browser by hand, which forces an immediate rotation.

Three changes, in order of how much work each does:

1. **An aged access token is verification freshness, not session health.** Session stays HEALTHY;
   `verification` moves to `due`. Nothing else changes. This alone removes the false alarm.
2. **The browser rotates on time.** The server tells the *active source only* how long the token
   has left (`rotateTokenIn`, default nudge at 10 minutes out); the agent then reloads the
   WriteHuman tab over the CDP connection it already holds. The browser stays the sole rotator, so
   Supabase reuse-detection is never in play — it just stops being late. **No hourly RDP refresh.**
3. **A real, non-rotating capability check.** `verify.js` `supabaseUserCheck()` calls GoTrue
   `/auth/v1/user` with the stored access token: a 200 is genuine proof the session is alive, a
   401/403 genuine proof it is dead. Decoding the JWT locally could not tell those apart — a
   stateless JWT reads "valid" for its full hour even after the session is revoked.

**Server-side refresh is a break-glass, OFF by default.** Rotating the refresh token server-side
would revoke the browser's copy, so it needs *both* a caller asking for it *and*
`WRITEHUMAN_SERVER_REFRESH=1`. The scheduler only asks when the source genuinely cannot rotate
(offline, or Chrome unreachable). When it does fire, the new bundle is persisted atomically, the
previous one is kept as rollback, and the verification timestamps are updated.

## Two actions, and only one of them opens a browser

| Action | What it does | Opens Chrome? | Needs the source online? |
|---|---|---|---|
| **Verify Session** | reads the active stored bundle, checks its cookies, proves it with one real authenticated call | **no, never, anywhere** | **no** — works with the RDP switched off |
| **Open WriteHuman Chrome on Active Source** | queues an addressed launch for `activeSourceId` | yes, on that one machine | yes |
| **Re-sync** / **Rotate token** | asks the active source to re-read cookies / rotate the token | no | yes |

`POST /admin/proxy-tools/writehuman/verify-session` never selects a device, never messages an
agent, and never alters the active source. Its response carries `chromeLaunched: false` explicitly.

## Command routing — addressed, single-use, expiring

Every source command is minted by `backend/utils/proxy/agentCommands.js` and carries: **command
id · type · tool scope · target `activeSourceId` · expected device-credential fingerprint ·
creation time · expiry · one-time nonce**.

Before dispatch the server checks the target **exists · is the current active source · is not
revoked · is not superseded · is not inactive · has a valid per-agent credential · is online within
the heartbeat window · runs an agent new enough to validate addressing** (≥ 3.4.0). The agent then
re-checks the address against its own device id and refuses anything else. Two independent locks,
because the failure mode is a Chrome window opening on the wrong desk.

**There is no fallback device.** Not latest-heartbeat-wins, not first-online, not newest-version,
not hostname matching, not the admin's own browser. If the active source is offline you get:

> Active source is offline. WriteHuman continues using the last verified session. Reconnect that
> source before opening Chrome.

and, when a login is genuinely needed:

> Login required, but the active source is currently offline.

Revoking a device **purges its queued commands in the same operation** and clears the active-source
pointer if it named that device.

### What this replaced

One string on the account, read and consumed by whichever agent POSTed first:

```js
account.pendingCommand = 'relaunch-chrome';   // no target, no id, no expiry, no nonce
const pending = account.pendingCommand;        // any device, any request — heartbeat included
clearPending();                                // and spent by whoever got there first
```

Compounding it, the agent auto-relaunched its own dedicated Chrome after 3 CDP failures **on every
machine that had it installed**, including one the server had already revoked — observed in a
production log relaunching Chrome every 2–13 minutes for hours after its heartbeats started
returning 403. From 3.4.0 the agent only auto-relaunches when it **is** the active source, and a
403 carrying `standDown` stops it touching the browser at all until it is re-enrolled.

## Session safety

The working bundle is never replaced by unverified cookies:

```
current verified bundle stays active
  → candidate received → required cookies present? → expected account matches?
  → real minimal WriteHuman request succeeds? → yes: atomic promote (previous kept for rollback)
                                              → no:  reject, keep the current bundle
post-promotion check fails → automatically restore the previous bundle
```

Supabase/JWT refresh alone is never accepted as proof.

## Anti-ping-pong (multiple machines)

Any authorized machine can supply the session. To avoid two machines fighting over "active source":
promotion uses the signed `session_id` + a one-time activation claim, per-device sequence numbers,
idempotency, replay protection and one account-level promotion lock — never "latest upload wins".
A newly installed source's first verified sync claims the source once; routine rotations from a
standby do not switch it.

## Agent reliability

- exactly one connector process (PID + heartbeat lock file, `agent.lock`);
- auto-start at logon (Startup shortcut — works with no admin, even where Task Scheduler is locked);
- capped exponential backoff on failure; reconnects when Chrome reopens;
- one managed Chrome (idempotent launcher; no-op if CDP already up; kills only *our* stray Chrome,
  never the everyday browser);
- CDP bound to `127.0.0.1` only — never exposed to the LAN;
- cookie poll ~45s (loopback, free); server heartbeat every ~3 min with jitter; reconciliation ~5 min;
  no per-second polling, no process per heartbeat, no continuous verify loop.

## Alerts

Email alerts fire on meaningful transitions only (session down / recovered / agent stale), deduped
per state with a cooldown on the account row — the same alert is never sent repeatedly. Configure
the recipient on the admin **Health alerts** panel.

## Security

Per-agent credential stored with Windows DPAPI (CurrentUser). Only the exact WriteHuman auth cookies
are read; nothing else, no unrelated domains. Cookie values and tokens never appear in logs, the
admin UI, API responses, or git. CDP is loopback-only. Wrong-account candidates are rejected.

## Files

- Connector: `writehuman-v2/agent/cookie-sync-agent.js` (+ SEA wrapper `wh-agent-sea.js`, build
  `build-installer.mjs`, installer `install-universal-agent.ps1`).
- Server: `routes/proxy/agentSync.js` (ingest/enrol/directives), `utils/proxy/candidateSync.js`
  (candidate→verify→promote→rollback), `utils/proxy/applySession.js` (vault write),
  `utils/proxy/sessionHealth.js` (the five health signals),
  `utils/proxy/agentCommands.js` (addressed command router),
  `utils/proxy/verify.js` (`supabaseUserCheck` — the real non-rotating capability check),
  `cron/proxyVerifyScheduler.js` (periodic read-only re-verify + canary),
  `routes/admin/proxyTools.js` (dashboard, `verify-session`, `open-chrome`, devices).
- Capture harness for the 70–90 minute test: `scripts/writehuman-health-capture.mjs` and the
  copy-paste console version in `scripts/writehuman-capture-console.md`.
- Download: `routes/proxy/agentDownload.js` → `/api/crm/downloads/writehuman-agent/windows/latest`.

## Rollback

- Installer: run it with `--uninstall` (keeps the dedicated profile + your login).
- Server: `git revert <commit>` or redeploy `main` — the modules are additive.
- Session: each promotion keeps the previous bundle; post-promotion failure auto-restores it. A
  server-side refresh (when enabled) also pushes the outgoing bundle onto `rollbackBundles` first.
- Emergency stop with no deploy: revoke the device in the admin panel.
- Turn the token nudge off with no deploy: `PROXY_TOKEN_NUDGE_SEC=0` (the agent then never reloads
  the tab and the browser goes back to rotating on its own schedule).
- Server-side refresh is off unless `WRITEHUMAN_SERVER_REFRESH=1`; unsetting it is the rollback.

## Deploy note

`utils/proxy/agentCommands.js` is a NEW module required by `routes/admin/proxyTools.js` and
`routes/proxy/agentSync.js`. Both deploy paths ship EXPLICIT file lists, so it has been added to
every script that ships either route (`deploy-hostinger.sh` and the eight `deploy-writehuman-*.sh`
variants). `backend/tests/deployManifest.test.js` enforces this — it caught exactly this omission
during development. Do not deploy those routes without it: Passenger boots the whole API into
"Cannot find module".

Order: **backend first, then frontend.** The new page reads `healthSignals`, which only the new
backend returns; the reverse order would leave the page briefly reading `undefined`. Agents
update independently — a 3.3.0 agent simply receives no commands until it is updated to 3.4.0,
which is the safe failure mode.
