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

## The five lifecycle states (admin page)

Derived from separate signals in `backend/utils/proxy/sessionHealth.js`:

| State | Meaning | Action |
|---|---|---|
| **HEALTHY** | signed in, token valid, agent fresh | none |
| **RECONNECTING** | transient: Chrome briefly unreachable, token aging, sync a little behind | none — self-recovers |
| **OFFLINE** | the source machine isn't reporting | none — the last verified session keeps working |
| **LOGIN_REQUIRED** | a *proven* auth failure | click **Open WriteHuman Chrome**, log in once |
| **ERROR** | no session saved | install + log in |

**LOGIN_REQUIRED fires only for a real failure** — WriteHuman signed the account out, the session/
refresh token expired or was revoked, the required cookie is missing, or the dedicated Chrome is
genuinely signed out. It never fires for a late heartbeat, an offline PC, a closed Chrome, an
ordinary token rotation, or one timed-out verify.

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
- Server: `routes/proxy/agentSync.js` (ingest/enrol), `utils/proxy/candidateSync.js`
  (candidate→verify→promote→rollback), `utils/proxy/applySession.js` (vault write),
  `utils/proxy/sessionHealth.js` (lifecycle state), `cron/proxyVerifyScheduler.js` (periodic
  read-only re-verify), `routes/admin/proxyTools.js` (dashboard + enrol/authorize/devices).
- Download: `routes/proxy/agentDownload.js` → `/api/crm/downloads/writehuman-agent/windows/latest`.

## Rollback

- Installer: run it with `--uninstall` (keeps the dedicated profile + your login).
- Server: `git revert <commit>` or redeploy `main` — the modules are additive.
- Session: each promotion keeps the previous bundle; post-promotion failure auto-restores it.
- Emergency stop with no deploy: revoke the device in the admin panel.
