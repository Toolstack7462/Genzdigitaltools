# Deployment path and rollback — candidate 3.5.15

**Nothing in this branch has been deployed or published.** This records what the existing authorized
process does, what it would change, and how to undo it.

## 1. What a merge actually does

`.github/workflows/deploy-frontend.yml` triggers on **push to `main`** limited to
`paths: frontend/**` and the workflow file itself. This branch changes `frontend/**`, so **merging
PR #14 publishes the frontend to both live web roots** over SFTP:

- `genzdigitalstore.com/public_html`
- `app.genzdigitalstore.com/public_html` (serves `/login`, `/client/*`, `/admin/*`)

A merge is therefore a deployment, not a staging step.

**Gate added in this branch.** That workflow previously ran no test suite: `ci-tests.yml` covers
pull requests and non-`main` branches, so a merge went to production ungated — including past
`frontendBuildFreshness` (is the committed bundle the one this source builds?) and
`deployCleanRoom` (would the deployed tree resolve every module?). A `gate` job now runs the
backend `test:ci`, the backend syntax check and the frontend tests, and `build-and-deploy` carries
`needs: gate`.

**The backend is NOT auto-deployed.** Every `deploy-*.sh` is manual and SFTP-based. The agent
installer is likewise published by a separate manual step.

## 2. What this deploy would change

| | repository `main` @ `42a3aab` | candidate |
|---|---|---|
| `sourceFingerprint` | `8a39ce486943e3ca…` | `6d4edc1c9324edd7…` |
| source files | 252 | 293 |
| main bundle | `main.020d28e1.js` | `main.baa88c00.js` |

The left column is **what the repository holds on `main`**, not a verified reading of the live
roots. No live hash was read in this session (§5), so "currently served" is unconfirmed.

## 3. Rollback

### 3.0 Two different operations — do not confuse them

| | restores | rebuilds? | keeps the gate? |
|---|---|---|---|
| `deploy-frontend.yml` (workflow, SFTP, verifies live hash on both domains) | the **source** at the chosen ref | **YES** — runs `npm run build` and uploads what it produces | only if the ref carries the gate |
| `deploy-frontend-only.sh` (manual) | the **committed `frontend/build/` artifact byte for byte** | no | n/a — no CI gate at all |

The workflow is a **rebuild from source**, not an artifact restore. An earlier revision of this file
said "no rebuild needed" of the workflow route; that was wrong. Only the shell script ships the
committed bytes untouched.

### 3.1 The rollback candidate is a candidate, not a verified baseline

`main` @ `42a3aab` carries bundle `main.020d28e1.js` (252 inputs). **That is what the repository
holds, not confirmed evidence of what the live roots serve.** Nothing in this session reached either
domain (see §5), so no live hash was read. Treat `42a3aab` as the **rollback candidate**; it is
promoted to "verified live baseline" only once a deploy run's own *"Verify live bundle on both
domains"* step has reported a matching hash, or an operator reads the live
`build-source.json`/bundle name directly.

### 3.2 `workflow_dispatch` will not take a raw commit SHA

Its `ref` must be a **branch or tag name**; a bare SHA is rejected. So a pinned rollback needs a tag
first:

```
git tag -a rollback/frontend-pre-3.5.15 42a3aab -m "frontend state before the 3.5.15 candidate"
git push origin rollback/frontend-pre-3.5.15
```

### 3.3 …and dispatching at that tag would run the OLD workflow, without the gate

A `workflow_dispatch` run executes the workflow file **as it exists at the chosen ref**. `42a3aab`
predates the `gate` job, so dispatching there deploys with **no test gate** — the reviewed safety
checks would be silently absent from the very run you are relying on under pressure.

### 3.4 Supported, pinned procedure: roll back the CONTENT, keep the WORKFLOW

Restore only `frontend/` from the candidate onto current `main`, so the gate and every other
reviewed check still apply:

```
git fetch origin main && git switch -c rollback/frontend-restore origin/main
git checkout rollback/frontend-pre-3.5.15 -- frontend/      # content only; .github/ untouched
git commit -m "rollback: restore frontend to rollback/frontend-pre-3.5.15 (pre-3.5.15 candidate)"
git push -u origin rollback/frontend-restore
```

Then either open a PR and merge it to `main` (the path filter re-triggers the deploy, through the
gate), or dispatch the workflow at `rollback/frontend-restore` — a **branch** name, which
`workflow_dispatch` accepts — passing `baseline_ref` = the ref being rolled back **from** (the
`main` SHA then live), because `HEAD~1` of the restore commit is not the state being replaced.

Note the asymmetry: the **dispatch `ref` must be a branch or tag**, but **`baseline_ref` is resolved
with `git rev-parse`, so a raw SHA is fine there** — and is usually the precise thing to pass.

Confirm afterwards from the run's own *"Verify live bundle on both domains"* and *"assets are
actually FETCHABLE"* steps. Expect `main.020d28e1.js` **or** a rebuild of that same source: the
workflow rebuilds, so `stampedAt` moves even when the fingerprint does not.

### 3.5 Reverting the whole merge would also remove the gate — dry-run confirmed

`git revert -m 1 <merge sha>` reverts **every** file in the merge, `.github/workflows/` included.
**This was tested, not assumed**, in a throwaway clone: the candidate was merged into a simulated
`main`, then fully reverted.

| after `git revert -m 1` | |
|---|---|
| `gate:` job in `deploy-frontend.yml` | **gone** |
| "Resolve deploy baseline" in `ci-tests.yml` | **gone** |
| `poolLimits` in `deploy-writehuman-ops.sh` | **gone** (the API-down fix) |
| frontend bundle | rolled back to `main.020d28e1.js` ✓ |

So a full revert does restore the frontend *and* silently removes the gate, the baseline handling
and the five module fixes. **The gate does not survive a full revert.**

By contrast §3.4, dry-run the same way, retained all three (`gate` present, baseline step present,
`poolLimits` present) while rolling the bundle back to 252 inputs / `main.020d28e1.js`, touching
**only** `frontend/` — zero `backend/` or `.github/` files changed. No production rollback was
executed; the clone was discarded. If a full revert
is ever the right call, re-apply the workflow and deploy-script commits on top of it before pushing
to `main`, or use §3.4 instead, which never touches them.

### 3.6 If only the committed artifact is wanted, with no rebuild

`deploy-frontend-only.sh` from a tree checked out at the rollback tag uploads the committed
`frontend/build/` unchanged. Note what that trades away: **no CI gate runs at all** on that path,
and the script's own sentinel check is the only pre-flight. Prefer §3.4 unless a byte-identical
restore of the previously shipped artifact is specifically required.

### 3.7 Backend rollback is separate and manual

Each `deploy-*.sh` uploads an explicit file list, and the backend is **never** auto-deployed. The
clean-room fix in this branch matters here: five scripts (`alerts`, `lasterror`, `ops`,
`status-fix`, `versionflag`) ship `routes/admin/proxyTools.js` and previously omitted
`db/poolLimits.js`, which it requires at module load. **Rolling the backend to a commit before that
fix, while this `proxyTools.js` is live, boots Passenger into "Cannot find module".** Roll the whole
file set together, never one script's worth. CI cannot verify this: no CI run knows which commit is
live on the API host, which is why the frontend and backend baselines are kept apart (§3 of
`.github/workflows/deploy-frontend.yml`'s baseline step).

## 4. Artifact correspondence — verified locally

| Check | Result |
|---|---|
| `AGENT_VERSION` in `cookie-sync-agent.js` | `3.5.15` |
| `latest.json` `version` | `3.5.15` — matches |
| `latest.json` `sha256` | `14015d575b25a538269521d2d1b4d9f4c43f309d89f0bd4d8dd451b9a5c654d3` |
| measured EXE sha256 | identical |
| `latest.json` `size` / measured | `91807232` / `91807232` |
| embedded agent source vs this tree | **byte-identical** (`npm run test:release-gate`, 5/5, opens the PE) |

## 5. Remaining prerequisites — each tracked separately

**Network access is not the only blocker.** Restoring it unblocks exactly one row below; the rest
are independent and several need a Windows host, an authorized client account or hosting metrics
that no network allowance provides.

### 5.1 Distribution readiness — **UNVERIFIED (nothing observed)**

One bounded run from the repository root, full body, no `--skip-body`:

```
node backend/scripts/verify-agent-distribution.cjs \
  --base https://api.genzdigitalstore.com --version 3.5.15 \
  --sha256 14015d575b25a538269521d2d1b4d9f4c43f309d89f0bd4d8dd451b9a5c654d3
```

→ **exit 3, `UNVERIFIED`**, one `[TRANSPORT]` problem:
`getaddrinfo ENOTFOUND api.genzdigitalstore.com`.

**This is not a report that production serves an older installer.** The host was never reached, so
the run observed nothing about what is published. The verifier now separates the four classes and
exits `3` for transport versus `1` for an observed readiness failure (HTTP / metadata / version /
byte-hash), precisely so the two can never again be read as the same result. Both are non-zero, so
`deploy-hostinger.sh` (`set -euo pipefail`) still aborts on either.

Two independent reasons it cannot run here, and both must be cleared:

1. **Network policy.** Through the egress proxy, `api.genzdigitalstore.com` and
   `genzdigitalstore.com` both answer `CONNECT tunnel failed, response 403` — a gateway policy
   denial (`connect_rejected`), not a server fault.
2. **The script does not use that proxy.** Node's built-in `fetch` ignores `HTTPS_PROXY` by default,
   which is why the direct attempt reports `ENOTFOUND` rather than the 403. In a proxied
   environment the run needs `NODE_USE_ENV_PROXY=1` (Node ≥ 24) and
   `NODE_EXTRA_CA_CERTS=<proxy CA bundle>`. **No change was made to the script's default**: a normal
   operator or deploy host has no proxy, and adding one would be a behaviour change for the
   environment that matters. With the proxy enabled here the request is still cancelled by the same
   policy denial, so (1) remains the gating item.

The honest statement either way: **whether production currently advertises a version its download
actually serves is UNKNOWN.** Nothing was published or overwritten to change that.

### 5.2 Native Windows acceptance — **UNRUN** (no Windows host)

Install, first start, restart persistence and authorized recovery. The package's own manifest
reports `nativeWindowsBuilt`, `windowsInstallationVerified`, `liveRecoveryVerified` and
`authenticodeSigned` all **false**. The installer is **unsigned**, so SmartScreen/Defender will flag
it. Matrix A–B in `ACCEPTANCE-CHECKS.md`. Source-pattern guards in the test suite prove a step is
*present*, never that it works on Windows.

### 5.3 Original "Mark as Active" diagnosis — **UNKNOWN, not blocked by network**

Independent of everything else here. The only evidence is the reported sentence *"new source →
Mark as Active fails"*; no status, code, screenshot, `/activation` read or log line exists, and the
repository holds no prior sanitized capture. `MARK-ACTIVE-INCIDENT.md` records every field as
UNKNOWN with the eleven-row differential and the code that narrows each.

**No new live attempt is to be made for diagnosis.** Pressing the button is state-changing even
once. Existing sanitized evidence is to be used first: an activity-log entry, a `/activation` read,
a screenshot or copied error text, or a server log line — any one `code` collapses rows 1–9 to a
shortlist. See `MARK-ACTIVE-EVIDENCE-CAPTURE.md` for the seven exportable fields and what must
never be exported.

### 5.4 Authenticated frontend behaviour — **UNRUN** (no authorized non-production client account)

Zee's runtime client-only checks C4–C7, and admin/client routing behind a real session. Zee's
Chromium results are **fixture-based** and stay labelled as such; they are not a substitute. Needs
a staging deploy or an authorized non-production account, not network access to production.

### 5.5 Hostinger resource measurements — **UNRUN** (D1–D5)

Entry processes, CPU, RAM, request rates, MySQL `Threads_connected` / `Max_used_connections`,
`503 DB_BUSY` counts, restart/OOM events. These need the hosting control panel, access logs and DB
status — **not** reachable by allowing a domain. **No resource improvement is claimed; nothing has
been measured.** `queueLimit = 20` is not claimed optimal. No pool counters were added to public
`/health`.

### 5.6 Post-deploy smoke tests — **not applicable yet** (nothing deployed)

Live site load on both roots, login, client and admin routing, and the existing working tools
unaffected. Possible only after an authorized deploy; the deploy workflow's own live-hash and
asset-fetchability steps are the first part of this, not the whole of it.

---

**Deployed components: none. Version deployed: none. Smoke tests: not run.** The candidate stays
`3.5.15`; PR #14 stays Draft.
