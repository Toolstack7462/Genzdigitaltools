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

| | live now (`main` @ `42a3aab`) | candidate |
|---|---|---|
| `sourceFingerprint` | `8a39ce486943e3ca…` | `6d4edc1c9324edd7…` |
| source files | 252 | 293 |
| main bundle | `main.020d28e1.js` | `main.baa88c00.js` |

## 3. Rollback

The frontend bundle is **committed** (`frontend/build/` is tracked), so a rollback needs no rebuild
and no artifact store.

**Rollback target: `42a3aab51cb72d1d4ec6074a96ce2d7d861a9adb`** — `main` as it stood before this
candidate, carrying bundle `main.020d28e1.js`. Recorded here so the target does not have to be
reconstructed under pressure.

Two routes, in order of preference:

1. **Re-run the deploy at the old ref.** `deploy-frontend.yml` declares `workflow_dispatch: {}`, so
   run it manually against `42a3aab`. It rebuilds from that commit's source and re-uploads, then
   its own *"Verify live bundle on both domains"* and *"assets are actually FETCHABLE"* steps
   confirm the revert landed. Nothing on `main` is rewritten.
2. **Revert the merge on `main`** (`git revert -m 1 <merge sha>`) and push. The `paths` filter
   matches, so the deploy re-triggers automatically with the previous bundle, now through the new
   gate.

Route 1 is preferred: it restores the live site without changing history, and route 2 remains
available if the revert should also be the recorded state of `main`.

**Backend rollback** is a re-run of the relevant `deploy-*.sh` from the previous commit, since each
uploads an explicit file list. Note the clean-room fix in this branch: five scripts
(`alerts`, `lasterror`, `ops`, `status-fix`, `versionflag`) ship `routes/admin/proxyTools.js` and
previously omitted `db/poolLimits.js`, which it requires at module load. **Rolling the backend to a
commit before that fix, while `proxyTools.js` from this branch is live, would boot Passenger into
"Cannot find module".** Roll the whole file set together, never one script's worth.

## 4. Artifact correspondence — verified locally

| Check | Result |
|---|---|
| `AGENT_VERSION` in `cookie-sync-agent.js` | `3.5.15` |
| `latest.json` `version` | `3.5.15` — matches |
| `latest.json` `sha256` | `14015d575b25a538269521d2d1b4d9f4c43f309d89f0bd4d8dd451b9a5c654d3` |
| measured EXE sha256 | identical |
| `latest.json` `size` / measured | `91807232` / `91807232` |
| embedded agent source vs this tree | **byte-identical** (`npm run test:release-gate`, 5/5, opens the PE) |

## 5. Blocked prerequisites

**Distribution readiness is UNVERIFIED and cannot be checked from here.**
`backend/scripts/verify-agent-distribution.cjs --base https://api.genzdigitalstore.com --version
3.5.15 --sha256 14015d57…` exits **1** with `latest.json could not be fetched: fetch failed`. The
cause is the environment's network policy, not the server: `api.genzdigitalstore.com` and
`genzdigitalstore.com` both return `CONNECT tunnel failed, response 403` from this container.

So the following remain **UNRUN**, and fixture or CI results must not be offered in their place:

- whether production currently advertises a version its download actually serves;
- Windows installation, start, restart and authorized recovery (no Windows host);
- authenticated routing and live-provider checks against the running API;
- post-deploy smoke tests of the live site and user flows;
- Hostinger resource measurement — **no improvement is claimed; nothing has been measured.**

Zee's Chromium results are **fixture-based** and stay labelled as such; they are not a substitute
for any of the above.

**The deploy pre-flight already blocks on this.** `deploy-hostinger.sh` runs
`verify-agent-distribution.cjs` unconditionally before its first network command, so a deploy that
would advertise an unpublished version fails rather than lying — which is why the blocked check is
a blocker and not merely a gap in evidence.
