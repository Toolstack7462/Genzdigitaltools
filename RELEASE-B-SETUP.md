# Release B — Agent 3.5.3 setup, verification and auto re-login activation

Companion to `RELEASE-A-RUNBOOK.md`. Release A (backend credential containment + logout
diagnostics) is **already live and verified**; nothing here touches it.

**State at the time of writing (verified live):** health `ok`, published agent **3.5.2**,
extension **3.9.33**, all authenticated endpoints `401`, app login `200`.

---

## 0. What is where

| Artifact | SHA-256 | Location |
|---|---|---|
| Agent **3.5.3** installer (91,700,224 B) | `08d3cf7cf85fe667ec9f07fb951c1ecc11601b832b0c5acf0d5a8311675732a6` | server `~/agent-353-staging/` (staged, verified) |
| Agent **3.5.2** rollback (91,672,064 B) | `d27e6b5b335b8c8234182c6b25d16dba54d5e501f6e82e2be83eff59728ed14d` | server `~/agent-352-backup-20261010-183837/` |
| Enrollment script | `5eaa7d6aa522eb2465df2c6c6b11b799e0ef79f94ead50d5012e545f2f70f842` | repo `writehuman-v2/agent/Enroll-SourceCredential.ps1` |
| Published dir (what clients download) | — | server `~/writehuman-agent/` (`WH_AGENT_DIST_DIR`) |

The installer is **not** in Git — `writehuman-v2/agent/dist/` is gitignored, correct for a 92 MB
binary. No git push can ever publish an agent.

---

## STEP 1 — Publish 3.5.3 (server, hPanel Terminal)

Temp-then-rename, so a download is either the complete old 3.5.2 or the complete new 3.5.3, never
a partial file. The manifest is copied **last** so it never advertises a version the exe is not yet at.

```bash
D=~/writehuman-agent; S=~/agent-353-staging
cp "$S/WriteHuman-Agent-Setup-x64.exe" "$D/.incoming-353.exe"
[ "$(sha256sum "$S/WriteHuman-Agent-Setup-x64.exe" | cut -d' ' -f1)" = "$(sha256sum "$D/.incoming-353.exe" | cut -d' ' -f1)" ] \
  && mv -f "$D/.incoming-353.exe" "$D/WriteHuman-Agent-Setup-x64.exe" \
  && cp "$S/latest.json" "$D/latest.json" && echo PUBLISHED \
  || { rm -f "$D/.incoming-353.exe"; echo "ABORTED - copy mismatch"; }
```

Verify from anywhere:

```bash
curl -s https://api.genzdigitalstore.com/api/crm/downloads/writehuman-agent/windows/latest.json
```
Expect `"version":"3.5.3"`, `"size":91700224`, `"sha256":"08d3cf7c…"`.

**Side effect:** the admin dashboard will now flag any agent still on 3.5.2 as outdated. No backend
change is needed — `latestAgentVersion()` reads this manifest directly. (The repo also carries a
`proxyTools.js` `EXPECTED_AGENT_VERSION` 3.5.2→3.5.3 bump; **do not deploy it** — production's
`proxyTools.js` has ~380 lines of uncommitted work, and that constant is only a fallback the
manifest overrides.)

**Rollback:** `cp ~/agent-352-backup-20261010-183837/* ~/writehuman-agent/`

---

## STEP 2 — Install on the MAIN source PC

Do this **only** on the authorized Windows PC that runs the MAIN WriteHuman Chrome session.
Never on a client machine.

### 2a. Record the current state first

```powershell
schtasks /query /tn WriteHumanCookieSync /fo list | findstr /i "TaskName Run Status"
# note the "Run As User" - everything below must be done as THAT user
```

Back up the agent's identity and config (no secrets are exported — the device key stays
DPAPI-encrypted, and this copies the encrypted blob as-is):

```powershell
$dir = "$env:LOCALAPPDATA\GenZ\WriteHumanAgent"      # adjust if your install dir differs
$bk  = "$env:USERPROFILE\agent-backup-$(Get-Date -UFormat %Y%m%d-%H%M%S)"
New-Item -ItemType Directory -Force -Path $bk | Out-Null
Copy-Item "$dir\config.json","$dir\agent-device.json","$dir\agent.key.dpapi","$dir\run-agent.cmd" $bk -ErrorAction SilentlyContinue
Get-ChildItem $bk | Select-Object Name,Length
```

`agent-device.json` holds the device enrollment and active-source designation — preserving it is
what stops the agent re-enrolling as a new device.

### 2b. Install

Download `WriteHuman-Agent-Setup-x64.exe` from the dashboard (or the URL above) and run it.
Verify the download before running:

```powershell
(Get-FileHash .\WriteHuman-Agent-Setup-x64.exe -Algorithm SHA256).Hash.ToLower()
# must equal 08d3cf7cf85fe667ec9f07fb951c1ecc11601b832b0c5acf0d5a8311675732a6
```

### 2c. Confirm the install took, and nothing else moved

```powershell
schtasks /query /tn WriteHumanCookieSync /fo list | findstr /i "TaskName Run Status"
# run-as user must be UNCHANGED from 2a
Get-Content "$env:LOCALAPPDATA\GenZ\WriteHumanAgent\agent.log" -Tail 20
```

In the log you want a `starting` line showing `version: 3.5.3`, then normal
`cookie_synchronized` / `heartbeat` lines. On the **admin WriteHuman page**, the device should now
report agent **3.5.3**, still as the active source.

**At this point auto re-login is still OFF** (`WHV2_RELOGIN` unset). The agent behaves exactly as
3.5.2 did. Let it run a full normal cycle before going further.

---

## STEP 3 — Enroll the credential (source PC, same Windows user)

```powershell
cd <repo>\writehuman-v2\agent
.\Enroll-SourceCredential.ps1
# prompts for email, then password twice, as hidden SecureString input
.\Enroll-SourceCredential.ps1 -Verify
```

`-Verify` should print a **masked** account (`r****@gmail.com`) and
`password : present (N characters, not shown)`.

What this does: writes `source-credential.dpapi`, encrypted with **DPAPI CurrentUser** — unreadable
by any other account on the machine and useless if copied elsewhere — with an ACL granting only
your user (R,W,D). The password is read interactively, so it never lands in argv, shell history or
a transcript. It is never sent to the backend, never written to Git, never in the installer, never
logged. Only a masked form appears in `source-credential.meta.json`.

This works because the agent runs as a **per-user logon task as your own user**
(`install-universal-agent.ps1:186` — "deliberately not SYSTEM"), so it can decrypt what you enrolled.

Remove or rotate any time: `.\Enroll-SourceCredential.ps1 -Remove` (then re-run to re-enroll).

---

## STEP 4 — Activate auto re-login (source PC)

Only after Step 2c looked healthy and Step 3's `-Verify` passed.

```powershell
$cmd = "$env:LOCALAPPDATA\GenZ\WriteHumanAgent\run-agent.cmd"
Copy-Item $cmd "$cmd.bak"
# add this line immediately after the existing "set WHV2_CONFIG=..." line:
#     set WHV2_RELOGIN=1
notepad $cmd
schtasks /end /tn WriteHumanCookieSync; schtasks /run /tn WriteHumanCookieSync
Get-Content "$env:LOCALAPPDATA\GenZ\WriteHumanAgent\agent.log" -Tail 10
```

Confirm the agent's report now shows `relogin.enabled = true` and `hasCredential = true` on the
admin page. Without Step 3 it logs `relogin_no_vault` and does nothing.

**Deactivate instantly:** remove the `set WHV2_RELOGIN=1` line (or `Copy-Item "$cmd.bak" $cmd`) and
restart the task. The recovery code goes dormant; nothing else changes.

---

## STEP 5 — One supervised test, without touching customers

Recovery has **never run against a real browser** — every test so far uses a simulated CDP. Do one
controlled run before trusting it unattended.

**Do NOT use the Sign out button.** Clients are injected the *same*
`sb-hicfsbrfkzsxbwayibfm-auth-token` family; `signOut()` defaults to global scope and would revoke
every client's session at once.

**Safe trigger** — delete only the local auth cookie in the dedicated Chrome, which produces the
real `auth_cookie_absent` path with **no server-side revocation**:

1. Pick a low-traffic window; check `/admin/activity-monitor` for who is online.
2. In the dedicated WriteHuman Chrome: DevTools → Application → Cookies → `https://writehuman.ai`
   → delete `sb-hicfsbrfkzsxbwayibfm-auth-token` **and** any `.0` / `.1` chunks. Change nothing else.
3. Watch the log (the agent polls every ~45 s; the logout is debounced over 2 polls):

```powershell
Get-Content "$env:LOCALAPPDATA\GenZ\WriteHumanAgent\agent.log" -Wait -Tail 5
```

**Expected sequence:**

```
logout_signaled                                 confirmed logout (debounced)
relogin_start           reason=auth_cookie_absent, attempt 1 of 3
relogin_reusing_tab     reused=true             ← proves NO duplicate tab
relogin_submitted                               one submit only
browser_authenticated_pending_verification      browser in; account NOT yet trusted
relogin_confirmed                               ← backend verified the account
cookie_synchronized                             normal sync resumed
```

**Pass criteria:** exactly one visible WriteHuman tab throughout; one `relogin_submitted`;
`relogin_confirmed` present; the dashboard shows the session healthy; clients can still open the
tool.

**Abort and investigate** on any of: `relogin_halted`, `mfa_required`, `captcha_required`,
`wrong_credentials`, `rate_limited`, `account_restricted`, `relogin_rejected_by_server`
(= backend `ACCOUNT_MISMATCH` → wrong account; the agent halts rather than claiming success).
Each writes a **persistent halt** that survives restart — clear it deliberately:

```powershell
Remove-Item "$env:LOCALAPPDATA\GenZ\WriteHumanAgent\agent-relogin.json"
```

Budget if you need to retry: **3 attempts per 6-hour window, 30-minute cooldown** between them.

---

## Guarantees built into the feature

| Protection | How |
|---|---|
| Only genuine logout triggers it | debounced absent auth cookie, **or** a provider-confirmed `SESSION_EXPIRED` verdict |
| Inconclusive never triggers it | CDP-down / network errors return before the hook; `VERIFICATION_INCONCLUSIVE`, `STALE_BUNDLE`, `REPLAY_REJECTED` are not triggers |
| Token rotation never triggers it | the rotation path contains no recovery call |
| No duplicate tab | reuses the open tab; opens one only if none exists |
| One submit | single click/`requestSubmit`, then wait |
| No overlapping runs | in-process single-flight flag |
| No loops | 3 attempts / 6 h, 30-min cooldown, attempt counted *before* the risky work |
| Human gates respected | probes for CAPTCHA/MFA **before typing**, halts |
| Wrong account cannot be promoted | the agent never self-certifies; only the backend's accept sets `confirmed`, `ACCOUNT_MISMATCH` halts |
| Browser stays sole token rotator | the agent never calls the token endpoint — no `grant_type=refresh_token` anywhere in it |
| Password never leaves the machine | DPAPI CurrentUser; typed via `Input.insertText`, so never inside evaluated JavaScript; never logged |
| Only the authorized source recovers | active-source check + stand-down check (a revoked install never logs in) |

**Observe/Enforce is untouched.** Under the current Observe policy a recovered source session
updates the **Proxy** immediately (the gateway reads `ProxyAccount`); the extension-managed Tool
updates only under `enforce`. Nothing here changes that.

---

## Rollback summary

| Scope | Action |
|---|---|
| Auto re-login only | remove `set WHV2_RELOGIN=1`, restart task (code dormant) |
| Credential | `.\Enroll-SourceCredential.ps1 -Remove` |
| Agent binary on the PC | reinstall 3.5.2 from `~/agent-352-backup-20261010-183837/` |
| Published download | `cp ~/agent-352-backup-20261010-183837/* ~/writehuman-agent/` |
| Release A (backend) | `RELEASE-A-RUNBOOK.md` §5 — backups at `~/release-a-backup-20261010-183837/` |

---

## Housekeeping still outstanding

1. **Rotate the hosting/SSH password** — it was pasted into a chat transcript twice.
2. **Remove the temporary SSH key** in hPanel (`SHA256:voLUH47Y26gwdwIZ16YcVdgYXibA4piWQ7Iw3a78Gq4`).
3. **Commit production's two uncommitted files** — `utils/proxy/verify.js` (the `accountKey` work)
   and `routes/admin/proxyTools.js` (~380 lines). Any future redeploy from `main` destroys them.
4. **Never run `deploy-hostinger.sh`** as-is: the live frontend (`main.7b35b271.js`) is newer than
   the committed build (`main.020d28e1.js`), so it would downgrade the frontend, and it ships a
   fixed list of backend files.
