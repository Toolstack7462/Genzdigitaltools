# CRM Release 1 — 2026-10-21

Owner-approved, released. This file records what is **actually running**, how it was verified, and
how to recover it. Figures here were measured after deployment, not predicted from a build.

---

## 1. Backend — base + patch set (NOT a whole-tree deploy)

The backend is **`origin/main` @ `4847063` plus the four files below**. It is not the full
`fix/crm-audit-response` tree: only these source files were promoted.

| SHA-256 | File |
|---|---|
| `ca7f8c1cd022cfb072abc8fe2590c2cfcb6bd1ce29e3ef09d69863b96b64157d` | `modules/business-crm/validation.js` |
| `8a8bc8941f379273e23b5b1b1dc952498da8135818759ae97fd5f11062462c30` | `modules/business-crm/routes/admin.js` |
| `163c329bef8ddeb2199888a9c245a0ef6637e9ba4b78045eb034e00b6b857322` | `modules/business-crm/routes/contacts.js` |
| `b5803640c95ee988d528d41687ced9901c530030d22fd8750cadc01877f49155` | `modules/business-crm/services/paymentService.js` |

* Effective application root: `.builds` → `hbuilds`, `current` →
  `hbuilds/versions/01a15b33-6ca3-72d9-8d4d-7540447485f0/nodejs`
* Promoted 2026-10-21 **17:28:00–17:28:07Z**; `tmp/restart.txt` touched **17:28:09Z**
* Interpreter: `PassengerNodejs /opt/alt/alt-nodejs22/root/bin/node`
  (the running worker's `exe` resolves to `/opt/alt/alt-nodejs22/root/usr/bin/node`)
* Source of truth going forward: **PR #26** (see §5)

### Whole-tree reconciliation (not a sample)

All 271 `.js`/`.json`/`.sql` files under the live app root (excluding `node_modules`, logs, tmp,
backups) were hashed and compared with `origin/main`:

* **exactly the four files above differ**
* **zero live-only files**, zero files missing

So the live tree is `main` + this patch set and nothing else. This measurement supersedes the
earlier precaution about a main merge wiping hand-deployed code — there is none here.

---

## 2. Activation — established from process evidence, not a health 200

`ps` start times, which is what actually shows whether the new code was loaded:

| PID | Started | Meaning |
|---|---|---|
| 2217127 | 2026-10-21 17:28:15Z | started 6 s after the restart marker — **post-patch** |
| 3342222 | 2026-10-21 17:56:31Z | the `www.api` LiteSpeed instance, restarted by a read-only GET — **post-patch** |
| 1857045 | 2026-10-20 21:26:37Z | **pre-patch**, still resident |

`api.genzdigitalstore.com` and `www.api.genzdigitalstore.com` are **separate LiteSpeed instances
sharing one app root**; each honours `restart.txt` on its own next request, which is why the second
worker only appeared after a request was made to the `www` host.

PID 1857045 consumed **0 CPU ticks across an 8-second window**, i.e. it is idle/draining. It is the
known never-reaped worker. It was **not** killed: that is a production action for the owner to
decide. Whether it can still receive a request is **not established**.

---

## 3. Frontend — artefacts actually served

Entry bundle `main.7989084c.js`, identical on both roots:

```
45aed1c9952a1666f4d585bdcdf5ca633a2f6ca9e7c140017c53c63766413858   main.7989084c.js
812e677fb13845e70f62a5e6ac20b210…                                  7791.bdcbf78a.chunk.js   (CRM)
fc733d153637b893255b93f719d6658f…                                  4134.a9a78f76.chunk.js   (Zee)
5a1ac88919beffd1e6c467620908bd24…                                  7791.eed7fcdd.chunk.css  (CRM)
```

Build stamp: `sourceFingerprint 164ae42b0a939744dbcc35962c663c75f83ae646d389bb4a861cbdd8363f94a9`,
322 source files, stamped `2026-10-21T17:24:49Z`. Source: `feat/crm-release1-ui` @ `bff7b58`.

The **served** bytes were hashed and match the reviewed build. A local filename is not evidence.

Extension release untouched: **3.9.39**, 274,560 B — the deploy guard kept the live release over
the older repo zip.

---

## 4. Rollback — component-specific, never blanket

**A whole-backend revert is unsafe.** It removes the `idempotencyKey` declaration on the contact
create schemas; because `validate()` runs `stripUnknown: true`, the frontend's retry protection then
disappears **silently** and a retry after a lost response creates a second contact. Any permitted
recovery configuration must keep **both**:

* the audit-response allow-list (no `SELECT *`, no `before_json`/`after_json`), and
* contact-create idempotency-key acceptance.

Reverting the ordering change alone is fine. **Rolling back the frontend alone is safe** — the new
backend serves the old frontend correctly, pinned by `businessCrmReleaseCompatibility.test.js`.

Never restore an old database over newer legitimate transactions.

### Backups (preserved, do not purge)

| What | Location | Exposure |
|---|---|---|
| Backend (4 files) | `<app-root>/.crm-backup-20261021T172757Z` | outside any docroot — HTTP **404** |
| Frontend (apex) | `…/genzdigitalstore.com/public_html/.deploy-backup-20261021T172855Z` | **publicly readable (200)** |
| Frontend (app) | `…/app.genzdigitalstore.com/public_html/.deploy-backup-20261021T172855Z` | **publicly readable (200)** |

The frontend backups sit inside a docroot and are reachable. They contain only `index.html`,
`asset-manifest.json` and `build-source.json` — artefacts that were public while live, so **no
secret is exposed** — but they do reveal a previous build's manifest. Relocating them outside the
docroot is an owner decision; they were **not** deleted.

---

## 5. Deployment-source reconciliation

`origin/main` is still `4847063` and still contains the old `SELECT *` and no key declaration.
**PR #26** (`fix/crm-audit-response` → `main`) carries the four deployed files plus their tests.

Trigger check performed before opening it: the branch touches `backend/` and `.github/` only, so
`deploy-frontend.yml` (paths `frontend/**`) does **not** fire — the merge cannot publish an older
frontend or an older extension. A main push does make Hostinger rebuild the backend from git; after
the merge that rebuild produces exactly what is already running.

**Owner action required:** approve/merge PR #26. Until then the live fixes exist only as a hand
copy and the next main-triggered rebuild would remove them.

---

## 6. Verification performed

| Layer | Result |
|---|---|
| Published files | 4/4 SHA-256 match the reviewed candidate; full 271-file tree diff clean |
| Activated backend | post-patch workers on both instances; one idle pre-patch worker remains |
| Live contracts (file-level) | `SELECT *` on audit = 0; `AUDIT_COLUMNS` present; `clientCreate` accepts the key; both tie-breakers present |
| Unauthenticated API | `/api/crm/extension/version-info` 200; audit route 401 |
| Real database | 36/36 on MariaDB 11.8.9 (production's engine version) |
| Frontend suites | 431/431, 42 suites |
| Backend CRM suites | 81/81 |
| Browser regression | 10/10 Chromium modal-isolation checks incl. a deliberate-save control |
| Non-interference | Zee + Access 142/142; protected sources byte-identical to `da2842f` |

### Not performed

* **Authenticated audit-response verification.** A 401 proves neither the corrected payload nor
  which handler version answered. This needs an existing admin browser session; no credentials were
  requested or used.
* **Restricted `audit.view` / no `profit.view` role check** against production.
* **Production write-path verification** of contact-create key acceptance — deliberately not done
  with a fake contact. Covered on a disposable database instead.
* **Normal-browser operator acceptance** (client lookup → summary → auto-fill → quick-create
  cancel → pagination → audit → Zee → Tool Access).
