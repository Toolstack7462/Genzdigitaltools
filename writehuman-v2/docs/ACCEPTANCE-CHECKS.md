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

## C. Zee — client-only UI — **PARTIALLY RUN (fixture-based)**

| # | Check | Status |
|---|---|---|
| C1 | Mounted only by `ClientLayoutEnhanced`; absent from `App.js`, admin layouts, login pages | **RUN** — `renderScope.test.js`, source-level |
| C2 | Logic, intents, diagnostics, support handoff, avatar states | **RUN** — 175/175 frontend, incl. 56 Zee tests |
| C3 | Focus returns to the launcher on close | **RUN** — real `document.activeElement` via `createRoot` + `act` |
| C4 | **Runtime** client-only scope: renders on `/client/*`, absent for a signed-out visitor and on admin | **UNRUN** — needs an authenticated non-production client account on a staging deploy |
| C5 | 390 px layout, no horizontal scroll, launcher clear of nav | **RUN (fixture-based)** — see below |
| C6 | Screen-reader announcement | **UNRUN** — no assistive technology driven; only the attributes one would read are asserted present |
| C7 | Reduced motion, support-link safety | **RUN (fixture-based)** — see below |

### C5/C7 — fixture-based Chromium evidence, **15/15 passed**

`src/features/clientAssistant/__tests__/zeeFixture.test.js` server-renders the **real** launcher and
panel components against a synthetic client state and inlines the **real** `clientAssistant.css` and
`genzAvatar.css`. `scripts/zee-browser-acceptance.cjs` then measures that fixture in a real Chromium
(Playwright 1.56.1, `/opt/pw-browsers/chromium`):

```
PASS  390x844: no horizontal page scroll          scrollWidth 390 vs clientWidth 390
PASS  390x844: panel within the viewport          x=12 w=367 vp=390
PASS  390x844: launcher inside the viewport       x=318 y=772
PASS  390x844: launcher does not cover nav        no overlap
PASS  1280x800: no horizontal page scroll         scrollWidth 1280 vs clientWidth 1280
PASS  1280x800: panel within the viewport         x=898 w=363 vp=1280
PASS  1280x800: launcher inside the viewport      x=1204 y=724
PASS  1280x800: launcher does not cover nav       no overlap
PASS  dialog role and label present               role=dialog
PASS  panel is non-modal                          aria-modal=false
PASS  launcher labelled, announces a dialog       aria-haspopup=dialog
PASS  guidance region is a polite live region     aria-live=polite
PASS  prefers-reduced-motion: animations disabled animation-name=none
PASS  no-preference: animations active            animation-name=genz-avatar-breathe
PASS  support handoff is wa.me, no credentials    https://wa.me/… (no token material)
```

**What this is not.** No authenticated session, no router, no API — so it **cannot** show what a
signed-out visitor sees, which is exactly what C4 is for. No assistive technology is driven, so it is
**not** C6. C1 proves no code path mounts the assistant outside the client layout; only C4 proves
runtime behaviour. The reduced-motion result is worth one note: the rule is **conditional**, not
blanket — animations are active under `no-preference` and `none` under `reduce`, which is the
correct shape and would not be caught by asserting only the `reduce` case.

Reproduce:

```
cd frontend && CI=true npx craco test --watchAll=false --testPathPattern=zeeFixture
PLAYWRIGHT_BROWSERS_PATH=/opt/pw-browsers node frontend/scripts/zee-browser-acceptance.cjs
```

Deliberately **not** added to PR CI: the GitHub runner has no Chromium, and installing a browser
driver there would be a new CI dependency for a check that is explicitly fixture-based.

## D. Hostinger resource measurements — **UNRUN, and no reachable endpoint can supply them**

This was investigated rather than assumed. `GET /api/crm/health` (`server-crm.js:415`) is the only
read-only operational endpoint, and reading its implementation shows what it carries:

- `status`, and `mysql.state` as **`connected` | `unreachable`** — from a real `ping()`, not a
  "pool exists" check
- `mysql.host`, `mysql.database`, `environment`
- launch-flow feature flags and effective email configuration (booleans/numbers only)

**It exposes no capacity data at all** — no pool size, no queue depth, no `Threads_connected`, no
entry-process count, no CPU or RAM. So the questions below cannot be answered from anything this
session can reach, and **production was not contacted**, because a single health GET would have
added no capacity evidence while still touching production.

| # | Measure | Needs |
|---|---|---|
| D1 | Entry processes, CPU, RAM against the plan's limits | Hostinger control panel |
| D2 | Request rate on `/client/announcements`, `/client/extension-notice`, `/extension/version-info`, `/client/presence/ping`, before vs after the visibility-gated polling change | access logs |
| D3 | MySQL `Threads_connected`, `Max_used_connections`, `Aborted_connects`, slow-query log | DB `SHOW STATUS` / log retention |
| D4 | Count of `503 DB_BUSY` responses since the shedding change | access logs |
| D5 | Node restart / OOM events correlated with D1 | host process metrics |

### What is and is not claimed

- D2's arithmetic — three requests per 45 s per parked dashboard tab, browser-throttled to roughly
  one tick a minute when hidden — is checkable from the source today. **The resource saving is not
  measured.**
- **`queueLimit = 20` is not claimed to be optimal.** It is a bound chosen as twice the pool width
  (`connectionLimit` 10) to replace an unbounded queue; D1/D3 are what would size it properly.
  `MYSQL_QUEUE_LIMIT=0` restores the previous behaviour with no code change.
- **No claim is made that the downtime is resolved.** Unbounded queueing is a *credible* mechanism
  for the 502/503 pattern; D5 correlated with D1 is what would confirm or refute it.

The smallest change that would make D1/D3/D4 answerable without new infrastructure: extend
`/api/crm/health` with the pool's `connectionLimit`, `queueLimit`, and mysql2's
`pool.pool._allConnections.length` / `_freeConnections.length`, plus a counter of `DB_BUSY`
responses. All non-secret, all server-authoritative. **Not done here** — it adds an endpoint field
and needs approval.

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
