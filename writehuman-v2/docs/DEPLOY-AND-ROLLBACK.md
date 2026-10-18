# Deployment path and rollback — candidate 3.5.15

## Release record (corrected against the run logs)

I could not read the job logs from this environment — GitHub serves them from an Azure blob host the
network policy denies — so the bundle identities below are **operator-supplied from the run log**,
not read by me. An earlier revision of this file stated `main.ce190adc.js`; that was **derived from
a local build and was wrong**. Corrected without redeploying merely to change a filename.

| run | source SHA | live bundle after | bundle before | backup |
|---|---|---|---|---|
| [39127844059](https://github.com/Toolstack7462/Genzdigitaltools/actions/runs/39127844059) | `5c3bd00` | **`main.e75a918d.js`** | `main.7b35b271.js` (both roots) | `~/deploy-backups/frontend-20261018T123718Z/` |
| [39130872984](https://github.com/Toolstack7462/Genzdigitaltools/actions/runs/39130872984) | `c775b1a` | the bundle that run built (see its log) | `main.e75a918d.js` | `~/deploy-backups/frontend-20261018T132033Z/` |

Source fingerprint for `5c3bd00`: `15eb6d3ecfcc…`.

### The committed bundle is NOT the deployed bundle

`deploy-frontend.yml` runs `npm run build` on the runner and uploads **that**. The committed
`frontend/build/` is a different build of the same source — webpack content hashes depend on the
resolved dependency tree, and the runner's `npm install` need not match a local one. Evidence: this
tree's committed stamp for `5c3bd00` was `main.ce190adc.js` while the runner published
`main.e75a918d.js` from the same commit.

Consequences: never identify a live bundle from the committed stamp (that is the mistake above);
only `deploy-frontend-only.sh` ships the committed bytes; and `frontendBuildFreshness` proves the
committed build matches the committed SOURCE, which is a staleness check, not a statement about
production.

### What the deploy verified, and what it did not

| check | run 39127844059 | what it proves |
|---|---|---|
| `index.html` references the expected bundle on both roots | **PASS**, first attempt | the right build landed |
| every JS/CSS asset returns 200 with a real JS/CSS content type | **PASS** | no SPA-fallback HTML served as JavaScript |
| **byte integrity of uploaded files** | **NOT CHECKED** | a content-type check is not a hash comparison; a corrupted-but-servable file would pass |
| **backup readability / restore viability** | **NOT CHECKED** | the step confirmed `tar czf` exited and listed the archive; it did not `tar -tzf` it, verify required members or test an extraction. An archive listing is not a usable restore |
| **authenticated behaviour** (admin menu, Support Contact values, Zee, routing) | **NOT CHECKED** | the runner cannot sign in |

## Component status — tracked separately

| component | state | evidence |
|---|---|---|
| **Frontend** (both roots) | **VERIFIED LIVE at `c775b1a`** | run 39130872984, all stages pass |
| **Running backend** (API host) | **UNVERIFIED** — not deployed by this or any run here. Build unknown; last changed by a manual `deploy-*.sh` at an unknown commit | no read access from this environment |
| **Installed Windows Agent** (RDP) | **UNTOUCHED**, not reinstalled | no action taken |
| **Published installer** | **NOT PUBLISHED** for 3.5.15; distribution check UNVERIFIED | `verify-agent-distribution.cjs` exit 3 |

**A frontend deploy does not deploy backend fixes.** Everything under `backend/` on this branch —
the `getAdminView` `storedAvailable` flag, the pool-saturation shedding, the five deploy-script
module fixes — is **tested but not deployed**.

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
| `deploy-frontend.yml` (workflow, SFTP, verifies live hash on both domains) | the **source** at the chosen ref | **YES** — runs `npm run build` and uploads what it produces, so the shipped bundle filename can differ from the committed one (§3.4a) | only if the ref carries the gate |
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

### 3.4 Supported, pinned procedure: restore the CONTENT, keep the WORKFLOW

Restore only `frontend/` from the candidate onto current `main`, so the gate and every other
reviewed check still apply.

> **`git checkout <ref> -- frontend/` DOES NOT WORK HERE, and an earlier revision of this file was
> wrong to prescribe it.** That form is an **overlay**: it writes the files the ref has and *leaves
> every tracked file the ref does not have*. Reproduced in a throwaway clone with a tracked
> candidate-only frontend file added, it left the marker **and 181 other candidate-only files** in
> place — new hashed bundle chunks among them — so the "rolled back" docroot is a **mixture of two
> builds**, and `mirror -R` uploads both sets. 182 files still differed from the target.
>
> `git restore --source=… --staged --worktree` is **non-overlay**: files absent from the source are
> removed from the index and the working tree, so the result equals the source exactly. Same
> reproduction: marker removed, **0 files differing**, index matching, `backend/` and `.github/`
> untouched. Pinned by `backend/tests/rollbackRestoreSemantics.test.js`.

**Step 1 — restore the source exactly.**

```
git fetch origin main && git switch -c rollback/frontend-restore origin/main
git restore --source=rollback/frontend-pre-3.5.15 --staged --worktree -- frontend/
```

**Step 2 — assert it, before building anything.** A restore that silently retained files is the
failure this whole subsection exists to prevent, so verify rather than assume:

```
# the tracked frontend tree must equal the target, INCLUDING deletions
git diff --quiet rollback/frontend-pre-3.5.15 -- frontend/         || { echo "worktree differs"; exit 1; }
git diff --cached --quiet rollback/frontend-pre-3.5.15 -- frontend/ || { echo "index differs";    exit 1; }

# and nothing outside frontend/ moved — the gate and the deploy-script fixes must survive
git diff --quiet origin/main -- backend/ .github/                  || { echo "safety files changed"; exit 1; }
```

Both `--quiet` checks are required: `--staged` is what makes the *commit* correct, and a worktree
match with a stale index would commit the wrong tree.

**Do not run a blanket `git clean`.** The restore does not need one, and it would destroy
uncommitted work. Untracked files survive the restore and do not make the tracked tree differ from
the target — asserted by the regression.

**Step 3 — rebuild, then commit.** See §3.4a: the target's committed bundle is stale, so it cannot
be shipped as-is.

```
cd frontend && npm run build && cd ..      # regenerates build/ and re-stamps build-source.json
git add -A frontend/ && git commit -m "rollback: restore frontend to the pre-3.5.15 source"
git push -u origin rollback/frontend-restore
```

**Step 4 — deploy through the gate.** Either open a PR and merge to `main` (the path filter
re-triggers the deploy, through the gate), or dispatch the workflow at `rollback/frontend-restore` —
a **branch** name, which `workflow_dispatch` accepts — passing `baseline_ref` = the ref being rolled
back **from** (the `main` SHA then live), because `HEAD~1` of the restore commit is not the state
being replaced.

Note the asymmetry: the **dispatch `ref` must be a branch or tag**, but **`baseline_ref` is resolved
with `git rev-parse`, so a raw SHA is fine there** — and is usually the precise thing to pass.

### 3.4a The rollback target's committed bundle is STALE — measured

Running `frontendBuildFreshness` against `42a3aab`'s own tree **fails**: the stamp records source
fingerprint `8a39ce486943…` while that same tree's 252 source files actually hash to
`8eaddcc58c56…`. This is a pre-existing condition on `main`, not something the rollback introduces.

Two consequences, both load-bearing:

1. **A content-only rollback that commits the target's bundle as-is would fail the new `gate` job**,
   because the gate runs `test:ci`, which includes that freshness check. Hence step 3: restore the
   **source** exactly, then **rebuild**. After rebuilding the restored source the check passes 5/5.
2. **A matching bundle filename proves nothing about source restoration — in either direction.**
   - The *overlay* (wrong) restore reported `"mainBundle": "main.020d28e1.js"` — the correct old
     filename — while 182 files still differed from the target.
   - The *correct* restore plus rebuild produces **`main.93571142.js`**, a filename that matches
     neither the candidate nor the committed old bundle, because the committed one is stale.

   So never accept `main.020d28e1.js` appearing in `build-source.json` as evidence of a good
   rollback. The evidence is the two `git diff --quiet` assertions in step 2, plus the freshness
   check after the rebuild. Expect the rebuilt filename to differ from the historical one and verify
   the live hash against **what this rollback build produced**, not against `main.020d28e1.js`.

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

## 6. Deployment access — exactly what is still needed

Add these to **Settings → Environments → `production`** (the job declares
`environment: production`, so GitHub creates it on first reference if it did not already exist).
Do not paste either value into chat.

| secret | required | what it is |
|---|---|---|
| `HOSTINGER_SSH_PRIVATE_KEY` | **yes** | the dedicated deploy private key, stored whole including its `-----BEGIN/END ... PRIVATE KEY-----` lines |
| `HOSTINGER_SSH_KNOWN_HOSTS` | **yes** | the server's host key as a `known_hosts` line for `[147.79.103.253]:65002`, taken from **Hostinger hPanel → SSH access** (a trusted channel) |
| `HOSTINGER_SSH_PASSPHRASE` | only if the key is encrypted | leave unset for an unencrypted key; the workflow then skips the unlock step |

**Why the third one is not optional.** `ssh-keyscan` against the host you are about to trust
authenticates nothing — a man in the middle answers the scan too — so the pin has to come from
somewhere other than the connection being secured. The workflow therefore refuses to run without
it rather than falling back to `StrictHostKeyChecking=no` or lftp's `auto-confirm`. It also checks
with `ssh-keygen -F` that the supplied line actually covers `[host]:port` before connecting. The
`known_hosts` line format is `[147.79.103.253]:65002 ssh-ed25519 AAAA…`.

**One more thing worth setting.** Run 39121274719 reached the credential step without pausing, so
the `production` environment currently has **no required reviewers**. For a protected production
environment, add at least one reviewer (and optionally restrict it to the deploying branch) —
otherwise "protected" only scopes the secrets, it does not gate the run.

**To deploy once the secrets are in place:** re-dispatch the same workflow at the reviewed ref —
one controlled run, `main` untouched, so there is no risk of a manual upload racing a
merge-triggered deploy.

```
gh workflow run deploy-frontend.yml --ref candidate/writehuman-3.5.15-integration
```

## 7. Component status

| component | status |
|---|---|
| **Frontend** (both roots, incl. Zee) | **READY, not deployed** — gate and build passed on the runner at `982b696`; blocked only on the two secrets. Verified to add **no new API endpoints** vs `main`, so it is compatible with the API now running. |
| **Backend** | **BLOCKED**, two independent reasons. (a) There is no key-authenticated backend deploy path in CI — every `deploy-*.sh` is a manual password SFTP, and this session has no credentials and no route to the host. (b) `deploy-hostinger.sh` runs `verify-agent-distribution.cjs` unconditionally before its first network command, and that check is **UNVERIFIED/NOT READY** for 3.5.15. No gate was weakened and no installer was published to clear it. |
| **Windows Agent** | **NOT TOUCHED and not authorized.** No reinstall, no publication, no live source switch. `AGENT_VERSION` stays `3.5.15`, unaccepted. |
