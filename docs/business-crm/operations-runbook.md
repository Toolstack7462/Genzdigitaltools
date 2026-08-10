# Business CRM — Operations Runbook

| Field | Value |
|---|---|
| **Purpose** | Deploy, verify and roll back CRM changes safely. |
| **Scope** | Release procedure for CRM changes only. |
| **Status** | As-built. Deployment behaviour reflects what was observed on 2026-08-10. |
| **Last verified commit** | `8b76b617f67928e6454226d1861f9d35913a3981` |
| **Last verified date** | 2026-08-10 |
| **Source files inspected** | `.github/workflows/deploy-frontend.yml`, `deploy-backend.sh`, `deploy-lib.sh`, `backend/scripts/business-crm-migrate.js`, `backend/scripts/business-crm-key.js`, `backend/modules/business-crm/db.js`. |
| **Related documents** | [`testing.md`](testing.md), [`troubleshooting.md`](troubleshooting.md), [`../../DEPLOYMENT_CHECKLIST.md`](../../DEPLOYMENT_CHECKLIST.md) |
| **Owner / maintainer** | Repository owner (`Toolstack7462`). |
| **What this document does not verify** | Hosting internals. The backend rebuild described below is **VERIFIED IN PRODUCTION** by observation, **NOT** by vendor documentation. Treat it as observed behaviour that could change. |

## How a CRM release reaches production

Two independent pipelines, triggered by the same merge to `main`.

| Pipeline | Trigger | What it does |
|---|---|---|
| **Frontend** | GitHub Action `Deploy frontend to Hostinger`, `on: push: branches: [main]` **with `paths: ['frontend/**', '.github/workflows/deploy-frontend.yml']`** | `npm install --legacy-peer-deps`, build with `CI=false` and `GENERATE_SOURCEMAP=false`, SFTP to **both** web roots, then verify the live bundle hash |
| **Backend** | Hostinger rebuild | Produces a new `hbuilds/versions/<uuid>` and repoints `hbuilds/current`; Passenger serves it |

### The trap

**A backend-only commit does not trigger the frontend Action, and that is correct.** The `paths`
filter exists precisely so a backend change does not rebuild the frontend. Do **not** conclude
"nothing deployed" from an absent Action run — verify the running code instead (below).

Equally: **never claim a deployment succeeded because a push or merge succeeded.** Verify.

### Important: where the live backend actually is

The live backend runs from `~/domains/api.genzdigitalstore.com/hbuilds/current/nodejs`, a symlink to a
versioned build. The older `~/domains/api.genzdigitalstore.com/nodejs` directory is a **stale copy**
and does not contain the CRM module. Reading logs or code from the wrong directory will mislead you.
**VERIFIED IN PRODUCTION.**

## Pre-release checklist

1. Branch from the latest `origin/main` in a clean worktree.
2. Confirm the change stays inside the CRM boundaries in
   [`architecture.md#change-boundaries`](architecture.md#change-boundaries).
3. Run every gate in [`testing.md`](testing.md).
4. **If `schema.sql` changed:** take a database backup first. `ensureSchema()` applies the change on
   the first CRM request after deploy — there is no separate migration gate to catch a mistake.
5. Secret-scan the diff. Nothing in the forbidden list may be committed.
6. Stage explicit paths. Never `git add .`.
7. Record the rollback point: the current `origin/main` hash.

## Verifying a release

Run these **after** both pipelines have had a chance to complete.

### Frontend

```bash
# 1. Did the Action run, and on which commit?
#    Compare its head SHA with the merge commit. If the commit was backend-only, expect NO run.

# 2. Which bundle is actually served?
curl -s https://app.genzdigitalstore.com/admin/business | grep -oE '/static/js/main\.[a-z0-9]+\.js'

# 3. Does the served CRM chunk contain the change?
#    Find the chunk via /asset-manifest.json, fetch it, and grep for a string unique to your change.
```

A useful trick: build locally with the same flags (`CI=false GENERATE_SOURCEMAP=false npm run build`).
If your local CRM chunk filename and hash match the served one, the deployed code is byte-identical to
your commit.

### Backend

```bash
# Which build is live, and does it contain the change?
readlink ~/domains/api.genzdigitalstore.com/hbuilds/current
grep -c '<a string unique to your change>' \
  ~/domains/api.genzdigitalstore.com/hbuilds/current/nodejs/modules/business-crm/routes/<file>.js

# Any CRM errors since the rebuild?
grep -c '\[Business CRM' ~/domains/api.genzdigitalstore.com/hbuilds/current/nodejs/console.log
```

Zero errors is necessary but **not** sufficient — it may simply mean nobody exercised the CRM yet.
Confirm with a real request.

### Authenticated smoke test

In a fresh private window at `https://app.genzdigitalstore.com/admin/login`, then:

| Check | Expected |
|---|---|
| `/admin/business` | Dashboard renders with content, no blank panel |
| `GET /dashboard?currency=PKR` and `INR`, `NGN` | 200 |
| `GET /reports/summary?currency=PKR` and `INR`, `NGN` | 200, `averageInvoice` with two decimals |
| 20 sequential sidebar clicks | clean sibling URLs, no accumulation |
| `/admin/business/definitely-not-a-real-page` | visible not-found state |
| Deep link + refresh | same page renders |
| 390 px width | drawer opens/closes, no control under 44 px, no horizontal scroll |
| `/admin/dashboard`, `/admin/tools`, `/admin/assignments` | full 224 px sidebar returns; **no** CRM financial field |
| DevTools Console | no CRM errors, no failed CRM chunk |
| Response headers | `Cache-Control: private, no-store` |

Do not create real financial records to test. If a write test is unavoidable, take a backup first, use
one clearly labelled QA record, and reverse it through the supported audited operations.

## Rollback

Non-destructive and does not touch the database, because CRM releases so far change no schema.

```bash
# For a normal (non-merge) commit on main:
git revert <release-commit>
git push origin main            # never --force

# For a merge commit:
git revert -m 1 <merge-commit>
git push origin main
```

Then let both pipelines redeploy, and re-run the smoke test above plus the non-CRM admin checks.

Rollback record to keep for every release:

| Field | Example from the 2026-08-10 series |
|---|---|
| Previous production commit | `6ebb564` |
| Release commits | `dfce275`, then `8b76b61` |
| Frontend Action | run #111 on `dfce275`; correctly skipped for `8b76b61` |
| Backend builds | `019fec3a` (15:11 UTC), `019fec46` (15:24 UTC) |
| Schema change | none — no migration, no backup required |

If a critical regression appears: stop testing, preserve logs and screenshots, revert **only** the
new release commit, redeploy, re-verify existing admin/client flows, and report the exact failure.
Do not attempt improvised production fixes, and do not revert the original CRM integration unless the
regression genuinely requires it.

## Environment

| Variable | Purpose | Notes |
|---|---|---|
| `DATABASE_URL` (or `MYSQL_URL`) | The CRM opens its own pool over the same database | Never print or commit |
| `BUSINESS_CRM_VAULT_KEY` | 64 hex chars; AES-256-GCM key for item credentials | Generate with `node backend/scripts/business-crm-key.js`. Absent → HTTP 503 on credential paths only. **PRODUCTION STATUS UNKNOWN** |
| `BUSINESS_CRM_DB_POOL_SIZE` | Default 6, clamped 2–30 | Optional |
| `BUSINESS_CRM_DB_MAX_IDLE` | Default 4 | Optional |

Note: an example file, `backend/.env.business-crm.example`, is written locally by the CRM installer but
is **not** in the repository — the project `.gitignore` excludes `**/.env.*`. Do not expect to find it
in a fresh clone; the table above is the reference.

## Scripts

| Script | Purpose |
|---|---|
| `backend/scripts/business-crm-key.js` | Print a fresh 64-hex vault key. Never commit the output |
| `backend/scripts/business-crm-migrate.js` | Apply `schema.sql` explicitly; idempotent, safe to run twice |
| `backend/scripts/business-crm-import.js` | One-time legacy import. Not used in this deployment |

## Do not, during a CRM release

- Run the broad `deploy-hostinger.sh` — it uploads unrelated modules and republishes the extension.
- Run a database migration when no schema change exists.
- Restart the application outside the documented method.
- Widen the CORS allowlist or touch shared authentication.
- Update dependencies or lockfiles.
