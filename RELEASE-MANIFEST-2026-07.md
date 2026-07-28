# Release Manifest — stabilisation, July 2026

Recorded for the `stable-production-2026-07` stabilisation release. **Not yet tagged** — the
tag is only created once the mandatory tests pass and the 24–48 h soak is clean.

Every claim below is either verified by hash or by a live probe. Anything unverified is marked
as such rather than assumed. **No secret values appear here — environment variables are listed
by NAME only.**

---

## 1. Deployed revisions per surface

| Surface | Deploy mechanism | Revision | Verification |
|---|---|---|---|
| **backend** (`api.genzdigitalstore.com`) | git auto-deploy on push to `main` | `33ae0df` (behaviourally `090192e`) | 14/14 backend files hash-matched at `97eb3e6`; later commits confirmed by live markers, below |
| **frontend** (`genzdigitalstore.com`, `app.…`) | GH Action / `deploy-frontend-only.sh` | **`main.956f376c.js` — STALE** | repo build is `main.01cfccd0.js` |
| **claude-gateway** (`claude1`) | `deploy-claude-gateway.sh` | `918c798` | `server.js` hash-matched that commit exactly |
| **stealth-gateway** (`stealth1`) | `deploy-stealth-gateway.sh` | **matches no commit** | hash `9ac9db2acd2b` ≠ HEAD ≠ `918c798` |
| **chatgpt-gateway** (`chatgpt1`) | none (manual SFTP) | imported as `5488071`; overlay fix `33ae0df` **NOT deployed** | imported bytes hash-verified against production |
| hix / bypassgpt / grok / ryne / writehuman gateways | per-gateway scripts | **not verified** | SFTP rate-limiting blocked the check |
| **chrome-extension** | zip in frontend build | MV3, v3.9.14 | manifest parsed |

### Live markers confirming the backend revision

| Marker | Result | Implies |
|---|---|---|
| `POST /api/crm/auth/register` | `410` | ≥ `97eb3e6` |
| `health.launch` present | true | ≥ `75df929` |
| `health.email` present | true | ≥ `094c02a` |
| verification + renewal mail sending | `msgId 456107c8…`, `0e0a7ab8…` | ≥ `090192e` |

---

## 2. Runtime configuration (live, from `/api/crm/health`)

```json
"email":  { "enabled": true, "effectiveTimeoutMs": 2500, "envTimeoutMs": null,
            "ceilingMs": 3000, "clamped": false }
"launch": { "flow": "url", "postTools": ["claude"], "stealthPost": false,
            "csrfEnforced": false, "codeTtlSeconds": 45 }
```

**The one-time POST launch bootstrap is DARK.** `flow: url` and `csrfEnforced: false` mean
production runs the original launch behaviour. Do not change either until the frontend ships —
see §5.

---

## 3. Environment variable NAMES (values never recorded)

**Backend** — `api.genzdigitalstore.com/public_html/.htaccess`:

```
BYPASSGPT_DEFAULT_PATH  BYPASSGPT_GATEWAY_URL  BYPASSGPT_TARGET_ORIGIN
HIX_DEFAULT_PATH  HIX_GATEWAY_URL  HIX_TARGET_ORIGIN
LSNODE_CONSOLE_LOG  NODE_OPTIONS
PROXY_GATEWAY_KEY  PROXY_LEASE_SECRET  PROXY_VAULT_KEY
STEALTH_GATEWAY_KEY  STEALTH_GATEWAY_URL  STEALTH_INTERNAL_CRON
STEALTH_LEASE_SECRET  STEALTH_TARGET_ORIGIN  STEALTH_VAULT_KEY
```

Passenger: `PassengerAppRoot`, `PassengerAppType node`,
`PassengerNodejs /opt/alt/alt-nodejs22/root/bin/node`, `PassengerStartupFile server-crm.js`,
`PassengerBaseURI /`, `PassengerRestartDir …/nodejs/tmp`.
**No `PassengerMaxPoolSize` / `PassengerMinInstances`** — platform defaults, so multiple
concurrent processes are possible (see §5, scheduler finding).

Not set anywhere in production: `LAUNCH_FLOW`, `LAUNCH_FLOW_TOOLS`, `STEALTH_LAUNCH_FLOW`,
`LAUNCH_CSRF_ENFORCE`, `EMAIL_TIMEOUT_MS` — all at code defaults, which is why the launch
bootstrap is dark and the email cap is the built-in 2500 ms.

**claude1**: `TOOL_KEY TOOL_NAME TARGET_ORIGIN DEFAULT_PATH SIGNIN_PATH GATEWAY_PUBLIC_ORIGIN
API_BASE LEASE_SECRET GATEWAY_KEY CF_CHALLENGE_MODE CF_CHALLENGE_PASSTHROUGH
RESET_STORAGE_ON_NEW_LEASE PROXY_LOG_ALL LSNODE_CONSOLE_LOG`

**stealth1**: `STEALTH_TARGET_ORIGIN STEALTH_API_BASE STEALTH_LEASE_SECRET STEALTH_GATEWAY_KEY
STEALTH_DEFAULT_PATH STEALTH_HUMANIZER_PATH STEALTH_DETECTOR_PATH GATEWAY_PUBLIC_ORIGIN
LSNODE_CONSOLE_LOG` (plus a server-side `.env` with the same names and `PORT`)

**chatgpt1** (read from `server.js`, not from its `.env`): `TOOL_KEY TOOL_NAME TARGET_ORIGIN
DEFAULT_PATH SIGNIN_PATH GATEWAY_PUBLIC_ORIGIN API_BASE LEASE_SECRET GATEWAY_KEY
CF_CHALLENGE_MODE CF_CHALLENGE_PASSTHROUGH CAPTCHA_ORIGINS ASSET_ORIGINS ACCOUNT_SHIELD
IDENTITY_SHIELD HIDE_SELECTORS NAV_BLOCK_EXTRA NAV_BLOCK_EXCLUDE DETECT_LOGGED_OUT
RESET_STORAGE_ON_NEW_LEASE UPSTREAM_TIMEOUT_MS PROXY_LOG_ALL PORT`

---

## 4. Backups taken (2026-07-28)

`prod-backup-2026-07-28/` — the material that exists **only** on the server:

```
htaccess/api.htaccess        2734 B
htaccess/claude1.htaccess     908 B
htaccess/stealth1.htaccess    872 B
gateways/stealth.env          493 B
chatgpt-gateway/server.js   86261 B   (also committed as 5488071)
chatgpt-gateway/public/overlay.js     (also committed as 5488071)
```

**Database backup: NOT TAKEN.** No shell is available (curl SFTP is file transfer only;
`sshpass` absent), so `mysqldump` cannot be run. Must be done via hPanel → phpMyAdmin → Export,
or Hostinger's automatic backups, before the stabilisation tag.

---

## 5. Known findings carried into the release

| # | Severity | Finding |
|---|---|---|
| C-2 | Medium | `stealth-gateway` production matches no commit. Resolves when it is deployed from HEAD. |
| C-3 | Low/Med | Schedulers start **once per Passenger process** — guards are in-process only. Log shows 3 boots / 3 scheduler starts. `resetAllUsage()` is idempotent; `proxyVerify` duplicates outbound calls. |
| C-4 | Medium (environmental) | Outbound HTTPS is LVE-limited: workers making outbound calls are killed at ~2 s (measured 1.99–8.1 s, one 504 at 55 s) while DB/light routes stay ~0.5 s. `.cagefs` confirms CloudLinux. Not fixable in application code. |
| — | Low | CSRF protection is **built but not active**. Every deployed caller omits the header (`main.956f376c.js`: 0 occurrences of `X-CSRF-Token`), so `[csrf] would-block … csrf_header_missing` is logged for legitimate traffic and nothing is blocked. |
| — | Info | Verifiers await outbound calls with 10–12 s timeouts inside the request, which can never fire under the ~2 s kill — so "Verify" fails whenever the host is busy. |

---

## 6. Rollback

| Surface | Procedure |
|---|---|
| backend | `git revert <sha> && git push` — auto-deploys in ~50 s (measured). |
| chatgpt-gateway | Re-upload `public/overlay.js` + `overlay.css` from commit `5488071` (exact pre-fix production bytes), or from the server-side `overlay.js.bak-*`. |
| claude / stealth gateways | Re-run their deploy scripts from any prior commit. Local pre-deploy copies of every file that would be overwritten are held. |
| frontend | Re-deploy `frontend/build/` from a prior commit (the build directory is tracked). |
| config | Restore from `prod-backup-2026-07-28/htaccess/`. |

Rolling the backend back alone is safe: the gateways accept both launch entry points while
`ALLOW_URL_LEASE` is `1` (its default).

---

## 7. Order of remaining work

1. Database backup (operator — no shell available to me).
2. Deploy `chatgpt-gateway/public/overlay.{js,css}` — blocked on SFTP rate-limiting.
3. Deploy the frontend (`main.01cfccd0.js`) — stops the CSRF would-block noise.
4. Deploy `stealth-gateway` from HEAD — closes C-2.
5. Operator tests: completed signup from a real inbox, admin + client login, Claude launch
   (multi-client, desktop/mobile/incognito, expiry + relaunch, quota recording).
6. Only then: `SetEnv LAUNCH_CSRF_ENFORCE 1`, then `LAUNCH_FLOW post`, then
   `ALLOW_URL_LEASE 0` — each verified via `/api/crm/health` before the next.
7. Tag `stable-production-2026-07`, soak 24–48 h, declare freeze.
