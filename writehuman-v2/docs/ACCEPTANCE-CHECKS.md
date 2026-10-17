# 3.5.15 acceptance checks — prepared, and what is actually unrun

Everything below is **prepared but NOT executed**. Each item names the environment it needs and why
this session could not provide it. Nothing here was simulated, and no result is inferred.

**Source-pattern guards are not Windows behaviour.** Several suites in `backend/tests/` read the
agent source to prove a step is *present* (`doUninstall` removes the credential, the stand-down
check precedes the CDP read, auto-relaunch is gated on being the active source). Those are
structural guards, chosen because a Windows SEA executable cannot be exercised in CI. They are
weaker than running it and must never be reported as acceptance.

---

## A. Windows installation / start / restart — **UNRUN**

Needs an isolated, authorized Windows x64 host. No Windows host exists in this environment.

| # | Check | Expected |
|---|---|---|
| A1 | Install `WriteHuman-Agent-Setup-x64.exe` (sha256 `14015d57…`) on a clean VM | installs; Add/Remove Programs entry present |
| A2 | First start | enrols, reports `3.5.15` / `3.5.15-retry-rc1`, appears as a device |
| A3 | Restart the service / sign out and in | resumes with the same device identity, does **not** re-enrol |
| A4 | Reboot | auto-starts once, one process, no duplicate device row |
| A5 | `--uninstall` | removes creds, stand-down, recovery, vault, lock, config, installed marker; reports to the server **before** destroying the credential; **keeps** the Chrome profile unless asked |
| A6 | Reinstall after uninstall | fresh authorization; the retired credential is **not** reused |

The installer is **unsigned** (`authenticodeSigned: false`). SmartScreen/Defender will flag it;
that is expected and is a release decision, not a defect.

## B. Authorized recovery — **UNRUN**

Needs an approved WriteHuman test account on that host. Must not touch live client sessions.

| # | Check | Expected |
|---|---|---|
| B1 | Sign out in the browser, let the agent notice | recovery attempts once, logs truthfully |
| B2 | Three attempts within an hour | the 4th is refused: `budget_exhausted`, honouring the 20-minute gap (0/20/40) |
| B3 | Restart mid-cooldown | the budget **survives** the restart; it does not reset |
| B4 | Present a CAPTCHA / MFA challenge | **persistent halt**, no bypass, operator required |
| B5 | Wrong-account session | `ACCOUNT_MISMATCH`, previous source retained, nothing promoted |
| B6 | Uncertain submission outcome | no automatic re-submit |
| B7 | Populated editor open | no reload of unsaved work |

Recovery is opt-in (`WHV2_RELOGIN=1`) and off by default; B1–B7 require enabling it on the test host
only.

## C. Zee — authenticated client-only UI — **PARTIALLY RUN**

| # | Check | Status |
|---|---|---|
| C1 | Mounted only by `ClientLayoutEnhanced`; absent from `App.js`, admin layouts, login pages | **RUN** — `renderScope.test.js`, source-level |
| C2 | Logic, intents, diagnostics, support handoff, avatar states | **RUN** — 174/174 frontend, incl. 56 Zee tests |
| C3 | Focus returns to the launcher on close | **RUN** — real `document.activeElement` via `createRoot` + `act` |
| C4 | Live browser: renders on `/client/*`, absent on public/login/admin **at runtime** | **UNRUN** — needs an authenticated non-production client account on a staging deploy |
| C5 | 390 px layout, no horizontal scroll, launcher clear of nav | **UNRUN** — needs a real viewport |
| C6 | Screen-reader announcement and reduced-motion behaviour | **UNRUN** — needs assistive tech |
| C7 | WhatsApp handoff opens with the sanitized prefill | **UNRUN** — needs a browser |

C1 is a source guard. It proves no code path mounts the assistant outside the client layout; it does
not prove what a signed-out visitor sees. C4 is the check that does.

## D. Hostinger resource measurements — **UNRUN**

Needs the hosting control panel, live process metrics and log retention. None are reachable here, so
no before/after figures exist and none are claimed.

| # | Measure | Why |
|---|---|---|
| D1 | Entry processes, CPU and RAM against the plan's limits | establishes whether a limit is actually being reached |
| D2 | Request rate on `/client/announcements`, `/client/extension-notice`, `/extension/version-info`, `/client/presence/ping`, before vs after the visibility-gated polling change | the saving is arithmetic from the source today, not measured |
| D3 | MySQL `Threads_connected`, `Max_used_connections`, `Aborted_connects`; slow-query log | sizes the bounded pool queue against reality |
| D4 | Count of `503 DB_BUSY` responses after the shedding change | distinguishes genuine saturation from the 500s it replaced |
| D5 | Node restart / OOM events correlated with D1 | tests whether unbounded queueing was the 502/503 mechanism |

D2's arithmetic (three requests per 45 s per parked dashboard tab, browser-throttled to roughly one
tick a minute when hidden) is checkable from the source. **The resource saving is not measured, and
no claim is made that the downtime is resolved.**

## E. Release prerequisites that remain

1. A–B unrun: no Windows host.
2. C4–C7 unrun: no staging deploy, no authorized non-production client account.
3. D unrun: no hosting metrics.
4. The installer is unsigned.
5. Publication is a separate approved step. `scripts/verify-agent-distribution.cjs` will block any
   deploy that advertises a version the download does not serve.
6. Node's `SHASUMS256.txt.asc` signature is unverified — the signing key could not be fetched
   (keyservers unreachable, proxy 403 on `keys.openpgp.org`). The checksums themselves came over
   TLS from nodejs.org and match the build manifest's `toolchain.windowsNode`.
