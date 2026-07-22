# Gen Z Claude Gateway (claude.ai)

A standalone, **dependency-free** Node.js (core `http`) reverse proxy for **Claude**,
deployed on its own subdomain with its own `.env`. It is the **same generic engine** as
`proxy-gateway/server.js` (kept byte-identical so fixes apply everywhere); Claude lives
in its own folder so its logic stays **fully isolated** from
StealthWriter / HIX / BypassGPT / WriteHuman / ChatGPT / Ryne / Grok and from the
extension/cookie tools.

| Tool | Subdomain | TARGET_ORIGIN | DEFAULT_PATH |
|------|-----------|---------------|--------------|
| Claude | `claude1.genzdigitalstore.com` | `https://claude.ai` | `/new` |

Claude keeps its **own encrypted cookie vault** (the backend scopes `ProxyAccount`
rows by `tool=claude`), its **own lease cookie**, and its **own client grants**.

> **Status: SUPPORTED (verify on deploy).** claude.ai authenticates with an httpOnly
> `sessionKey` cookie the server reads on every request — a server-rendered cookie session
> like HIX/Grok, attached server-side. It sits behind Cloudflare; the gateway pins a fixed
> UA + client-hints so a captured `cf_clearance` stays valid and renders the REAL challenge
> for the user to solve (never bypassed). If claude.ai ever gates normal browsing behind an
> interactive iframe challenge a datacenter IP can't pass, flip `CF_CHALLENGE_MODE` to
> `unsupported` — **env only, no code change**.

## What it does
1. Accepts a signed lease at `/gateway?lease=TOKEN`, stores a host-scoped cookie, and
   redirects to `DEFAULT_PATH`.
2. Validates the lease on **every** request — locally (JWT signature + expiry) and, on
   HTML page loads, via the backend `/api/crm/proxy/gateway/validate` (authority for
   revocation/expiry/access).
3. Reverse-proxies to `claude.ai`, **attaching the selected vault account's cookies
   server-side** (never exposed to the browser). On a real sign-in redirect (`/login`) it
   flags the account `session_expired` (skipped for new leases).
4. **Hides account / email / plan / pricing / billing / subscription / upgrade /
   logout / API-keys / profile** at the server + overlay, and shows a small
   bottom-right widget: *Gen Z Digital Store*, the tool name, the session countdown,
   and a support button. **No usage metering, no daily limits.**
5. **Cloudflare-aware:** pins a fixed browser UA + client-hints so a captured
   `cf_clearance` stays valid, and renders the **real** Cloudflare challenge for the
   user to solve manually. It never bypasses or auto-solves a challenge, login,
   captcha, payment or rate limit.
6. **Graceful, never blank:** friendly retry/notice page on upstream errors,
   reload-loop breaker, and a lease-free health route at `/__genz/health`.

## Session length (countdown) is customizable
The countdown the client sees is the **backend lease length**, set:
- **per client** in Admin → Proxy Tools → Claude → Client Access (Session length field), or
- globally via backend env `CLAUDE_LEASE_MINUTES` / `PROXY_LEASE_MINUTES` (default 30).

The gateway needs no config for this — it just honors the lease's expiry.

## Run
```bash
cp .env.claude.example .env   # fill secrets (LEASE_SECRET / GATEWAY_KEY must equal backend)
npm start                     # = node server.js → listens on PORT (default 3000)
```
No dependencies — `npm install` is a no-op.

## Hostinger Node.js app setup
1. Create the subdomain `claude1.genzdigitalstore.com` (hPanel — DNS + vhost; SFTP
   cannot create a subdomain).
2. Upload this folder to `/home/u171982351/claude-gateway` (server.js, public/,
   package.json, tmp/).
3. Wire Passenger via the subdomain's `public_html/.htaccess` (LiteSpeed picks it up):
   ```apache
   PassengerAppRoot /home/u171982351/claude-gateway
   PassengerAppType node
   PassengerNodejs /opt/alt/alt-nodejs22/root/bin/node
   PassengerStartupFile server.js
   PassengerBaseURI /
   PassengerRestartDir /home/u171982351/claude-gateway/tmp

   SetEnv TOOL_KEY claude
   SetEnv TOOL_NAME Claude
   SetEnv TARGET_ORIGIN https://claude.ai
   SetEnv DEFAULT_PATH /new
   SetEnv SIGNIN_PATH /login
   SetEnv GATEWAY_PUBLIC_ORIGIN https://claude1.genzdigitalstore.com
   SetEnv API_BASE https://api.genzdigitalstore.com/api/crm/proxy/gateway
   SetEnv CF_CHALLENGE_MODE passthrough
   SetEnv CF_CHALLENGE_PASSTHROUGH 1
   SetEnv RESET_STORAGE_ON_NEW_LEASE 1
   # SetEnv HIDE_SELECTORS <fill from the live logged-in DOM — see "Before go-live" below>
   SetEnv LEASE_SECRET <SAME AS BACKEND PROXY_LEASE_SECRET>
   SetEnv GATEWAY_KEY <SAME AS BACKEND PROXY_GATEWAY_KEY>
   ```
   (Copy the `LEASE_SECRET` / `GATEWAY_KEY` SetEnv lines verbatim from any existing
   `*1` gateway's `.htaccess` — all proxy tools share ONE secret pair.) Delete any
   Hostinger `default.php` from the docroot.
4. Restart: write `tmp/restart.txt`. Verify:
   - `curl -s https://claude1.genzdigitalstore.com/__genz/health` → `{"ok":true,...}`
   - `curl -o/dev/null -w '%{http_code}' https://claude1.genzdigitalstore.com/` → **403**
     (block page = up, lease required; 502 = app not booting).

Or use the repo's `deploy-claude-gateway.sh` (uploads the folder over SFTP + restarts +
verifies health) once the subdomain + `.htaccess` exist. See its header for usage.

## Before go-live (audit findings — do these first)
Two items make the tool unsafe/broken for clients until verified against the LIVE app:

1. **Identity shield (BLOCKER).** The shared ACCOUNT_SHIELD blocks account/settings/billing
   *navigation* and stubs billing APIs, but does NOT guarantee claude.ai's bottom-left
   **sidebar account control** (name/initials → on click: email, "Upgrade", org/workspace
   switcher, "Max"/"Team" plan badge) is visually hidden — claude.ai uses obfuscated class
   names the generic heuristics can miss (HIX/Ryne needed tool-specific selectors). Open the
   live logged-in app through the gateway, inspect that control + its popover, and set exact
   `HIDE_SELECTORS`. Do a client's-eye pass before granting any client.
2. **Verification is ADVISORY, not authoritative (measured 2026-07-10).** Logged-out
   `GET /new` returns **HTTP 200** (a JS shell — it does NOT redirect to `/login`), and
   `/api/*` is Cloudflare-challenged (403) from a datacenter IP. So the server-side verifier
   cannot reliably tell logged-in from logged-out: a dead session can read `working`. Keep the
   vault account logged in and refresh it with **Capture via proxy** (captures the httpOnly
   `sessionKey` in-context), not a cookie paste. A truly robust health signal would need the
   WriteHuman-style live-browser + cookie-sync agent — intentionally out of scope here.

Also confirm on first deploy: `CF_CHALLENGE_PASSTHROUGH=1` is set (else a Cloudflare challenge
loops), `RESET_STORAGE_ON_NEW_LEASE=1` is set (clean account switching), and no core Claude API
path collides with the billing-stub word-list (chat/completion endpoints don't — low risk).

## Backend (already done in this repo)
- `claude` is registered in `backend/utils/proxy/tools.js` (registry-driven → it appears
  automatically in Admin Proxy Tools, the vault, client access, CORS, verify, capture,
  and the client Dashboard / My Tools).
- A dedicated admin page lives at `/admin/claude` (sidebar → Claude); it embeds the
  generic Proxy-Tools management UI locked to `claude`.
- No new backend file — all edits are to files the deploy script already ships.

See `../STEALTHWRITER_MODULE.md` / `../PROXY_TOOLS_MODULE.md` for the shared design.

## Token quota (estimated local usage) — claude-only

This gateway carries an isolated, claude-only token-quota tap (`lib/quotaTap.js`, gated on
`TOOL_KEY==='claude'`) that estimates local token usage from the CHARACTER LENGTH of each Claude
completion request/response and enforces per-client + shared-account allowances. It forwards
only integer character COUNTS to the backend — never prompt text, cookies or sessions.

Set `CLAUDE_QUOTA_MODE` in this gateway's env (and the backend's):
- `off` — disabled.
- `count` *(default, safe)* — measures + reports usage; never blocks a message.
- `enforce` — additionally blocks an over-quota message before forwarding (fail-open on any
  error). Enable only after confirming the estimates against a real logged-in account.

Full details, all env knobs, capacity/plan scaling and the operator checklist are in
`../CLAUDE_TOKEN_QUOTA.md`.

## Default effort preference (claude-only)

On a **fresh Claude session / new conversation** the overlay auto-selects a default **effort**
level. It is purely a UI convenience — it never touches the selected **model**, the Personal/Team
**workspace**, authentication, account assignment or token limits.

Behaviour (see `lib/effortPrefs.js` for the unit-tested policy):

- Runs **only after the composer is ready**, detects the **current** effort first, and clicks
  **only if it differs** from the target — never when it already matches.
- Applies **once per conversation**; a later **manual** change by the user is **never** overridden.
- The `/new → /chat/<id>` first-message navigation is treated as the **same** conversation (no
  re-apply); starting a **New chat**, refreshing, or switching Personal/Team (a reload) counts as a
  fresh conversation and re-applies the default.
- If the effort control can't be found or Claude changed its UI, it **logs one safe console warning
  and continues** — it never loops, never re-opens menus, and never breaks Claude.

Admin-configurable via this gateway's env (SetEnv), like the other overlay prefs:

```
SetEnv CLAUDE_DEFAULT_EFFORT medium      # low | medium | high | extra | max  (default & fallback: medium)
SetEnv CLAUDE_THINKING_DEFAULT 0         # extended-thinking default: OFF by default (lower usage); 1/on auto-enables it
# Optional: pin the exact effort control if the heuristic can't find it on the live DOM
# SetEnv CLAUDE_EFFORT_TRIGGER_SEL <CSS selector for the effort button>
```

The `Thinking default` is a **separate** setting kept **off by default** for lower usage; when off
the overlay never touches the thinking control, so users can still enable it manually. Set it to
`1`/`on` to auto-enable extended thinking once per fresh conversation. If your live DOM doesn't
expose an `aria-label` containing "effort", set `CLAUDE_EFFORT_TRIGGER_SEL` to the control's
selector so detection is reliable (the heuristic requires an effort-labelled control to avoid
mis-clicking).

## Mobile Cloudflare identity — REGRESSION-SENSITIVE (claude-only, fixed 2026-07-22)

**Design.** The gateway's egress is a datacenter IP, and the only Cloudflare `cf_clearance` that
is valid for it is the vault's — minted (via *Capture through the gateway*) with the **pinned
desktop User-Agent**. A `cf_clearance` is bound to *both* the egress IP and the exact UA that
minted it. So **every client — desktop and mobile — must present that same pinned desktop identity
upstream** to reuse the working clearance. A mobile phone stays a real phone in the browser; only
the *upstream* HTTP identity is the desktop vault's. This is not a bypass: it reuses a
legitimately-solved clearance, exactly as desktop does, and a valid clearance means Cloudflare
never shows a challenge, so its in-browser fingerprint is never cross-checked.

- Default: `CLAUDE_MOBILE_UPSTREAM=vault` (mobile rides the vault clearance + desktop identity).
- Kill-switch: `CLAUDE_MOBILE_UPSTREAM=own` restores the older per-device path (real mobile UA +
  the device solving its own clearance). Live logs proved a phone **cannot** solve its own
  challenge through the proxy (`/api/challenge_redirect` loops 100%), so `own` is for A/B only.
- `/__genz/health.claudeMobile.mobileRidesVaultClearance` reports the effective mode; a boot
  warning fires if it (or CF passthrough) is misconfigured.

**⚠ The regression-sensitive boundary.** In `server.js`, `buildUpstreamHeaders` builds upstream
headers in **two** branches — `minimal` (top-level HTML navigation) and non-minimal (XHR / API /
assets). **In BOTH branches the upstream User-Agent and the `sec-ch-ua*` client-hints MUST agree.**
If the UA is the pinned desktop one but the hints are the phone's (`sec-ch-ua-mobile: ?1`,
`sec-ch-ua-model: "Pixel 8"`, …), Cloudflare's fingerprint cross-check fails and challenges the
request — and because Claude's app funnels a challenged call through `/api/challenge_redirect`
(which cannot complete same-origin through a proxy), the mobile verification loop returns.

Commit `75341b4` fixed the minimal branch (via `upstreamIdentity` → `...id.ch`) but left the
non-minimal branch keeping the phone's own hints beside the now-desktop UA, so **HTML pages loaded
but every `/api/*` call was challenged**. The fix pins the desktop hints (and purges leftover
mobile high-entropy hints) for vault-mode mobile in the non-minimal branch too. Desktop is
untouched. Guarded by `test/mobileIdentity.test.js` — the `REGRESSION:` XHR tests fail if the two
branches ever disagree again. Do not "simplify" either branch without keeping UA ⇄ hints consistent.

**⚠ The THIRD point of the same boundary — the clearance itself (fixed 2026-07-22).** Presenting
the desktop identity is only half of "mobile rides the vault clearance"; the vault's clearance also
has to *survive the cookie merge*. `mergeCookieHeaders` is **b-wins**, and the Cloudflare
pass-through called `merge(vaultCookies, browserCfCookies)` — so **any `cf_clearance` the phone
happened to hold on this origin silently replaced the vault's on the upstream leg**. A phone's
clearance is solved by a *mobile* browser, so Cloudflare bound it to a mobile fingerprint: it is
invalid for the desktop-UA request the gateway now sends. The result was the exact reported
symptom — Claude opens and works, then a few reloads later lands on the Cloudflare verification
page — and it is "delayed" because a fresh phone holds no CF cookie until a challenge response
deposits one, after which every request is poisoned and it never self-heals.

In vault mode a **mobile** client now merges the other way round (`merge(browserCf, vaultCookies)`),
so the vault's Cloudflare cookies win a name clash. Nothing is deleted: a browser CF cookie the
vault does not have is still forwarded. **Desktop and `own` mode keep the original b-wins order
byte for byte** — a desktop device's clearance was minted through this same gateway under the same
pinned UA, so it was never the problem.

Two supporting guards landed with it, both mobile-only:

- The pinned hints are now overwritten **in place** instead of `delete`d and re-assigned. A
  delete-then-reassign appends them at the *end* of the header list, giving mobile a header
  **order** no real Chrome produces — header order is itself part of Cloudflare's fingerprint.
- A detected Cloudflare challenge on a mobile top-level navigation is answered with **one
  recoverable notice page** (manual "Try again") instead of the real challenge document. In vault
  mode that challenge provably cannot clear — the in-browser fingerprint and the upstream identity
  can never agree — and the challenge page refreshes itself, which *is* the "reloads three or four
  times" the client sees. Nothing is bypassed, weakened or auto-solved; we just stop replaying a
  verification the proxy has no legitimate way to satisfy. **Desktop still receives the real
  challenge, unmodified**, because desktop can actually solve it.

Guarded by the `REGRESSION:` cookie-precedence, header-order and challenge-notice tests in
`test/mobileIdentity.test.js`, each of which fails if the corresponding change is reverted.

### ⚠ READ THIS FIRST: the challenge is TRANSIENT and NOT device-specific (2026-07-22)

Once `device` became legible in the live log, the picture changed and several earlier conclusions
in this file turned out to be wrong about the *cause*:

```
NAV /new -> 200  cf=false dev=desktop ck=21
NAV /new -> 200  cf=false dev=desktop ck=21
NAV /new -> 403  cf=TRUE  dev=desktop ck=21   <- same cookies, same identity, minutes later
NAV /new -> 403  cf=TRUE  dev=desktop ck=21
NAV /new -> 200  cf=false dev=desktop ck=21   <- recovers on its own
NAV /new -> 403  cf=TRUE  dev=desktop ck=21
```

**Nothing about the request differs between a success and a challenge** — same 21 vault cookies,
same pinned identity, same device. So the challenge is *not* caused by a clearance, User-Agent or
client-hint mismatch. It is Cloudflare intermittently challenging this gateway's **shared
datacenter egress IP**, and it clears by itself on a later attempt.

Two consequences that matter more than any of the identity work above:

1. **Every request classified as `desktop`, including while the fault was being reported.** Any fix
   gated on `isMobileClient()` therefore never executed for the affected client. *Do not gate a
   Cloudflare fix by device.* If you think you have a mobile-only bug, confirm it in the log first.
2. **Never hand Cloudflare's challenge document to the browser on a navigation.** It refreshes
   *itself*, so the client sees the page reload three or four times and settle on the verification
   screen — the exact reported symptom. It can never clear, because the browser solving it is not
   the party making the upstream request: the proxy is, from a different IP with a different TLS
   fingerprint.

**The fix.** A challenged *navigation* is treated as a transient upstream condition:

- **Retry it upstream** — `CLAUDE_CF_NAV_RETRIES` (default 2, max 4, `0` disables) with a
  `CLAUDE_CF_NAV_RETRY_DELAY_MS` (default 700ms) linear backoff. Navigations only, never assets or
  XHR, and bounded, so we never hammer an IP that is already being rate-limited. This is an
  ordinary retry of *our own* request — it does not solve, bypass, automate or weaken the
  challenge.
- **If the retries are spent, serve one recoverable notice** with a manual "Try again", not the
  self-reloading challenge. `CLAUDE_CF_NAV_NOTICE=0` restores the raw passthrough.
- The proxy log now records `cf_vault_clearance` / `cf_browser_clearance` (booleans, never values),
  which distinguishes "the vault clearance was challenged" — an egress-IP problem with nothing in
  the request to fix — from "the browser's stale clearance displaced the vault's".

**If challenges become constant rather than intermittent**, that is a different problem: the
vault's `cf_clearance` has aged out. Re-add the Claude account with **Capture via proxy**, which
mints a fresh clearance from the server's own egress. No gateway change can substitute for that.

## Mobile session renewal (claude-only, fixed 2026-07-21)

**Symptom.** On a phone, once the 30-minute session expired, reopening Claude from the
dashboard kept showing "Session complete/expired" — through refreshes, new tabs and even a
browser restart. Desktop was always fine.

**Why desktop was fine and mobile was not.** Desktop `window.open(url, '_blank')` really does
build a fresh document, so the widget's state started clean every launch. A phone instead
resurfaces the *existing* tab out of bfcache / the frozen-tab store, and mobile browsers
retain service workers and Cache Storage far more aggressively. Three separate things kept
the dead session alive there:

1. **A service worker on the gateway origin replayed the cached "session ended" page.** A
   worker registered by the proxied app is scoped to this origin and serves navigations from
   its own Cache Storage — including the `/gateway?lease=<NEW>` launch itself. The request
   never reached the server, so the fresh session cookie was never set, and no server-side
   change could dislodge it. Cache Storage also survives clearing cookies, which is why a
   cookie reset and a restart did not recover it.
2. **`POST /__genz/validate` fell through to the HTML block page when the session was gone.**
   `fetch(...).json()` cannot parse that, so the overlay classified a *finished* session as a
   transient network fault and sat on "Connection interrupted — retrying…" forever.
3. **A restored tab kept `state.terminal = true` in memory.** Both `validate()` and `tick()`
   early-return on terminal, and timers do not fire while a tab is frozen — so the expired
   widget was replayed even after a fresh lease had been issued and its cookie installed.

**The fix (all claude-only).**

- `server.js` refuses service-worker scripts on this origin — by path (`/sw.js`,
  `/service-worker.js`, `/workbox-*.js`, …) and by intent (`Sec-Fetch-Dest: serviceworker`,
  `Service-Worker: script`). A new registration can never install, and an existing one's
  update check gets a 404, which makes the browser drop the registration on its own. The
  overlay already unregisters workers for Claude; refusing the script closes the loop.
- `server.js` answers `/__genz/validate` and `/__genz/usage` with JSON even when there is no
  session (`{valid:false, terminal:true, code:'lease_missing'}`), and expires the dead opaque
  cookie on the way out — so the widget states plainly that the session ended.
- `server.js` relays `expiresAt` + `serverTime` on a valid validate, so a resumed tab
  re-anchors its countdown to the **new server-issued** deadline rather than a stale local
  counter. These are timestamps, not credentials — no token or claim is exposed.
- `sendBlockPage` now dismantles the replay machinery on a `lease_*` denial: unregisters
  workers, empties Cache Storage, clears local/sessionStorage, plus
  `Clear-Site-Data: "cache", "storage"` for browsers that honour it. It deliberately does
  **not** clear cookies — that would drop this device's Cloudflare clearance and force a
  re-challenge on every expiry.
- `public/overlay.js` re-checks with the server on the mobile resume events (`pageshow`
  incl. bfcache, `visibilitychange`, `focus`, `online`, throttled to one call per 3s). If the
  server answers `valid:true`, `adoptRenewedSession()` discards the terminal state, the old
  expiry, the countdown and the backoff timer, and re-anchors to the new expiry.

**Security.** None of this grants access. The resume path only *asks the server again*; it
bypasses the terminal short-circuit and nothing else. Renewal happens exclusively when the
backend answers `valid:true`, which requires the fresh lease cookie that an authorized
dashboard launch installed — so a refresh, a restored page or a replayed screen with no new
lease still gets a terminal verdict and stays denied. JWT signature + expiry checks, the
terminal-code revocation list, and "failures are never cached" are all unchanged.

**Tests.** `test/mobileRelaunch.test.js` (11 tests) boots a real gateway against a stub
backend that answers from the lease's own `exp`, and drives the full journey — expire →
refresh (must not renew) → dashboard relaunch → new tab → restart — separately for Android
Chrome, iPhone Safari and Desktop, asserting desktop behaviour is unchanged.
`backend/tests/overlayValidation.test.js` §13 (6 tests) loads the shipped `overlay.js` into a
virtual-clock sandbox and fires the real resume events; §13e/§13f assert that **only** the
Claude overlay registers them and every other gateway is untouched.

### Follow-up hardening (2026-07-22) — renewal must never turn into a reload loop

- **The block-page recovery is scoped to `lease_*` codes only.** It exists to notice that an
  authorized dashboard relaunch happened, which is meaningful only when the session actually
  ended. On a *transient* block (`unavailable`, `session_expired`, account/plan codes) the lease
  is still valid, so `/__genz/validate` answers `valid:true` and the page would `location.replace`
  straight back into a screen that is still failing — a reload-on-temporary-error loop, one
  bounce per app-switch. Temporary trouble stays on the notice page, with a **manual** retry.
- **A frozen tab no longer stalls validation forever.** A tab frozen mid-`/__genz/validate` can
  leave a fetch that never settles; `state.inFlight` then blocked every later validation for the
  life of the page, so the resumed tab kept replaying stale state and never learned about the
  fresh lease. On a resume event only, a request outstanding for more than 15s is abandoned and
  a clean one is issued.
- **A stale response can never overwrite a newly issued session.** `state.gen` is bumped whenever
  a session is replaced or a request is abandoned, and a response whose generation no longer
  matches is dropped — so the dead session's verdict or expiry cannot land on top of a live
  30-minute lease. Enforcement is unchanged: a denial for the *current* session is still terminal
  immediately. Covered by `test/overlayStaleResponse.test.js` (4 tests).
- **Diagnostics.** The proxy log record carries `cid` + `instance` + `latency_ms` (already), plus
  `redirect_to` (redirect chain, **path only** — the query is dropped because a redirect target
  can carry a one-time token) and `cf_challenge`. An unsolvable mobile challenge logs
  `cf_challenge_unsolvable` with `reload_reason`. The redaction list no longer blanks the bare
  `device` key — its only value anywhere is the literal `mobile`/`desktop` **class**, which is the
  one field that makes a mobile-only regression legible in the live log; every *identifier*
  (`device_id`, cookies, tokens, leases, sessions, orgs, accounts, emails) is still redacted, and
  that split is asserted by a test in `test/mobileConfigGuard.test.js`.

## File downloads (claude-only, fixed 2026-07-21)

**Symptom.** Files generated or attached in Claude were visible, but the download control was
hidden or downloading did not work. Desktop and mobile alike.

**Root cause — two independent defects.**

1. **The download button was hidden by a regex typo** (`public/overlay.js`). `CLAUDE_HIDE_RE`
   contained `download( apps?| for .+)?`. That trailing `?` makes the suffix *optional*, so a
   bare **"Download"** matched a rule intended only for the account menu's app promos
   ("Download apps", "Download for Mac"). A text match calls `hide(nearestControl(n))`, which
   walks up to **4 ancestors** — so the file card's Download button / menu item was removed
   from view. The request path was never blocked and auth was never involved; the control was
   simply hidden. That is exactly why the file stayed visible while the download disappeared.

2. **Downloads were treated as pages** (`server.js`). The proxy chose how to handle a response
   from its content-type alone:
   - `text/html` → took the HTML branch, so the overlay, the critical hide CSS and URL
     rewriting were injected **into the saved file**;
   - `text/plain`, `application/json`, `application/xml` → had upstream-URL rewriting applied
     to their bytes, silently editing the user's file.

   Binary formats (PDF, DOCX, XLSX, PPTX, images, ZIP) were already safe — they fall through
   to the untouched pipe — which is why only some formats looked broken.

**The fix.**

- `public/overlay.js` — the suffix is now **required**: `download( apps?| for .+)`. Bare
  "Download" is kept; "Download apps" / "Download for Mac" are still hidden. Regex-only, no
  DOM behaviour change.
- `server.js` — `Content-Disposition: attachment` is now treated as "this is a file":
  no HTML injection, no URL rewriting, no JSON sanitising, no buffering — the response is
  streamed through with its own headers intact. `content-length` is also preserved for
  attachments (it is otherwise stripped because injection changes body length), so downloads
  report a real size: without it large files stream chunked with unknown length, which costs
  the progress bar and is markedly less reliable on iOS Safari. If such a response ends up
  compressed, `pipeMaybeCompressed` drops the header again, as before.

**Deliberately unchanged.** Inline/preview responses, artifacts, uploads, the app's own JSON
(still rewritten so the upstream host never leaks), SSE streaming, the quota tap, and
Personal/Team workspace logic. `content-disposition`, `content-type`, `accept-ranges` and
`content-range` were already preserved by the header filter and still are.

**Security.** No route, allowlist or auth path was touched — `proxy()` has a single call site,
after both the session gate and the backend validation, so downloads inherit access control
unchanged. Header stripping still applies to attachments (only `content-length` is exempted),
`Set-Cookie` is still rewritten, and vault account cookies remain server-side only. Verified
by test: an unauthenticated download returns 403 and never emits file bytes.

**Working-area audit.** Every label in `HIDE_RE` / `CLAUDE_HIDE_RE` was swept against the real
Claude control set (Copy, Retry, Edit, Share, Preview, Save, Export, Send, Stop, Attach,
Upload, Artifacts, Code, Run, Publish, Search, New chat, Rename, Delete, Continue,
Regenerate, Expand, Collapse, Extended thinking, Projects, …). **"Download" was the only false
positive**; everything else is either unmatched or explicitly protected by `KEEP_RE` /
`WS_KEEP_RE`. This is asserted by a regression test so a future rule addition cannot quietly
hide a working-area control again. The server-side critical hide CSS is href/aria/testid based
and contains no download selector, so it was never implicated.

**Tests.** `test/fileDownload.test.js` (24 tests) boots a real gateway and downloads PDF,
DOCX (with spaces in the filename), XLSX, PPTX, PNG, ZIP, TXT, JSON, HTML and a 3 MB binary,
asserting each arrives **byte-identical** with its filename, extension and content-type
intact — plus mobile UA runs, inline-preview preservation, Range support, and the two
security assertions above. Verified meaningful: with both defects re-introduced, **10 of the
24 fail**.

## Model allowlist — Fable 5 disabled (claude-only, 2026-07-21)

**Requirement.** Fable 5 must not be usable by proxy clients, and the block must survive a
modified request, cached state, a direct endpoint call or browser devtools — not just a hidden
menu entry.

### Admin setting

```apache
# claude1.genzdigitalstore.com/public_html/.htaccess
SetEnv CLAUDE_ALLOW_FABLE5 1      # On  — original behaviour, nothing filtered
# (line absent, or 0/false/off)   # Off — Fable 5 blocked   <-- DEFAULT
```

**Off by default**: the value must be explicitly `1/true/on/yes` to allow, so an unset, empty
or garbled value blocks rather than silently permitting. Reversible with a one-line `.htaccess`
change and no deploy. When On, every code path short-circuits and the proxy behaves exactly as
it did before this feature existed (asserted by test).

Optional: `SetEnv CLAUDE_FALLBACK_MODEL claude-sonnet-5` overrides the fallback. A fallback
that itself names Fable 5 is refused and falls back to Opus 4.8.

**Fallback profile** — Model `claude-opus-4-8`, Effort **Medium**, Thinking **Off**. Effort and
thinking are *not* new settings: `CLAUDE_DEFAULT_EFFORT` already defaults to `medium` and
`CLAUDE_THINKING_DEFAULT` already defaults to off, which is exactly the required profile. They
stay independently configurable.

### How the block works — three layers, only one of which is a security control

| Layer | File | Purpose |
|---|---|---|
| **Request rewrite (authoritative)** | `server.js`, before `runDispatch` | Rewrites any blocked model id in the outgoing JSON body to the fallback. This is the only layer that cannot be bypassed from a browser, and it is what "safely switch an existing conversation on its next request" means. |
| **Response filter** | `server.js`, JSON-rewrite branch | Drops blocked entries from the model list, so Fable 5 is **absent from the client-facing picker** without patching claude.ai's bundle. Any lingering scalar naming it renders as the fallback. |
| **Overlay hide + message** | `public/overlay.js` | Cosmetic only. Hides a menu-sized label naming the blocked model and shows *"Fable 5 is disabled by your administrator."* once per page. If this never runs, the model is still blocked upstream. |

`lib/modelPolicy.js` holds the decision logic as a pure, I/O-free module so it is unit-testable
without a browser or a live proxy.

### Design notes

- **Denylist by shape, not by exact id.** claude.ai model ids carry build/date suffixes that
  change without notice, so an exact-match list would silently stop matching after a rename. The
  matcher is `/fable/i`, which **fails closed** — an unrecognised Fable variant is still blocked.
- **Every other model is untouched.** This is deliberately a denylist of one family, not an
  allowlist of known-good ids, because an allowlist would break every future Claude model on the
  day Anthropic ships it.
- **Never silently back to Fable.** Rewrites only ever go blocked → fallback. No code path can
  emit a Fable id, and a misconfigured fallback pointing at Fable 5 is refused (both asserted).
- **Automatic model switching is forced off** where the body carries such a flag, so the
  connected account cannot move a conversation onto Fable 5 behind the client's back.
- **Fails open.** A malformed or non-JSON body is forwarded untouched rather than breaking the
  request; any exception in the policy is swallowed and the proxy continues.
- **Cost.** A byte scan for `fable` on request bodies only; `JSON.parse` happens solely on the
  rare body that actually contains it, so ordinary traffic pays a memchr and nothing more.
  Attachments never reach the response filter, so a downloaded file mentioning the word is never
  altered.

### Deploy

`lib/modelPolicy.js` is in the `deploy-claude-gateway.sh` `FILES` list. **It must ship** — a
missing `lib/*.js` makes the gateway boot into `Cannot find module`.

### Tests

- `lib/modelPolicy.test.js` (17) — id spellings, other models unaffected, nested/aliased keys,
  reversibility, fail-open, the "can never emit a Fable id" invariant, and the byte pre-filter.
- `test/modelBlock.test.js` (6) — end-to-end through a real gateway process against an upstream
  stub that records what it actually received: straight request, handcrafted request that never
  touched the UI, and an existing conversation replaying its pinned model — on desktop **and**
  mobile UAs; picker payload; other models pass through in order; setting On restores everything;
  and overlay/downloads/lease-gating unregressed.

One real bug surfaced by the end-to-end test: when a client sends the body **chunked** there is
no `content-length` to correct, and adding one while `transfer-encoding: chunked` is still
present is a framing conflict that upstream answers with 400. The header is now dropped whenever
an explicit length is set.
