# CRM Release 1 — 2026-10-21

Owner-approved, released, and now **reconciled into `main`**. This file records what is actually
running, how it was verified, and how to recover it. Figures were measured, not predicted.

Three claims in the first version of this record were wrong. They are corrected in place and
called out, because a release record that quietly rewrites itself is not evidence:

* **worker evidence** — "0 CPU ticks over 8 seconds" was treated as proof that an old worker was
  draining. It proves nothing of the sort. See §2.
* **frontend deploy trigger** — the merge was said to be safe because `deploy-frontend.yml`
  filters on `paths: frontend/**`. It has **no push trigger at all**. See §5.
* **rollback material** — the backend `.crm-backup-…` directory no longer exists. See §4.

---

## 1. Deployment source — reconciled, no longer a hand patch

| | |
|---|---|
| `main` | **`ac29e45`** (merge of PR #26, `fix/crm-audit-response`) |
| Hostinger build | **`01a16024-3f16-73f1-a4d2-eaf29b752f3c`**, mode `publish`, from `ac29e45` |
| Effective app root | `.builds` → `hbuilds`, `current` → `versions/01a16024-…/nodejs` |
| Published | 2026-10-21 20:26 UTC, "Switching current to the new version", 8.9 s |
| Interpreter | `PassengerNodejs /opt/alt/alt-nodejs22/root/bin/node` (worker `exe` resolves to `…/root/usr/bin/node`) |

The four reviewed files, hashed **in the published version directory**:

| SHA-256 | File |
|---|---|
| `ca7f8c1cd022cfb072abc8fe2590c2cfcb6bd1ce29e3ef09d69863b96b64157d` | `modules/business-crm/validation.js` |
| `8a8bc8941f379273e23b5b1b1dc952498da8135818759ae97fd5f11062462c30` | `modules/business-crm/routes/admin.js` |
| `163c329bef8ddeb2199888a9c245a0ef6637e9ba4b78045eb034e00b6b857322` | `modules/business-crm/routes/contacts.js` |
| `b5803640c95ee988d528d41687ced9901c530030d22fd8750cadc01877f49155` | `modules/business-crm/services/paymentService.js` |

Identical before and after the merge: the hand patch and the git release are the same bytes.

### Whole-tree reconciliation — every file type, not a sample

The earlier comparison covered `.js`/`.json`/`.sql` only. Redone over **every** file under the live
app root (excluding `node_modules`, logs, tmp, uploads), hashing git **blob** bytes rather than a
Windows working copy — a CRLF checkout makes 280 of 281 files look different and means nothing.

| When | Files | Live-only | Main-only | Different |
|---|---|---|---|---|
| Before the merge (vs `main` `4847063`) | 281 | 0 | 0 | **4** (the patch set) |
| After the merge (vs `main` `ac29e45`) | 286 | **0** | **0** | **0** |

So the live tree now equals `main` exactly. Nothing was hand-deployed-and-uncommitted, which also
settles the standing worry that a main-push rebuild would wipe live-only code: there was none.

### Other deployment inputs (outside the app root)

* `hbuilds/config/package-lock.json` — byte-identical to the app root's copy
* `hbuilds/config/.env` — present, mode `0600`, 16 keys. Not read; **names only** were listed
* `hbuilds/config/preload-timestamp.js` — Hostinger's own stdout/stderr JSON log shim, platform-owned
* `public_html/.htaccess` — `PassengerAppRoot …/hbuilds/current/nodejs`, `PassengerAppType node`,
  `PassengerStartupFile server-crm.js`, `PassengerBaseURI /`, plus the SPA rewrite and the
  `/client/*`, `/admin/*`, `/login` redirects to `app.genzdigitalstore.com`. Untouched by this release.

---

## 2. Which app instance serves which hostname — corrected

**The earlier claim was wrong.** PID 1857045 was described as "idle/draining" because it consumed
no CPU across an 8-second window. Zero CPU over 8 seconds says only that nothing asked it to do
anything in those 8 seconds. It is not evidence of being unrouted, drained or incapable.

What it actually was, from its own listening socket:

```
/proc/1857045/fd → socket:[1275049511]
/proc/net/unix   → /usr/local/lsws/extapp-sock/wheat-bat-642462.hostingersite.com:_.sock
/proc/1857045/cwd → …/hbuilds/versions/01a15b33-…/nodejs
```

It was the LiteSpeed external-app instance for **`wheat-bat-642462.hostingersite.com`** — a live,
publicly reachable hostname bound to the same API app. Started 2026-10-20 21:26, i.e. **before** the
17:28 patch, so it still held the pre-patch module graph in memory. It was not draining; it was a
third route that simply had received no traffic since the patch. A read-only
`GET /api/crm/extension/version-info` to that hostname returned a normal API response — proving
routability — and the LiteSpeed instance honoured the **existing** `restart.txt` marker on that
first request, replacing 1857045 with a fresh worker. No process was killed, no global restart was
issued, no other application was touched, and the marker's mtime (17:28:09.591Z) never changed.

Four hostnames were found bound to this one app, each with its own socket and worker:

| Hostname | Version dir after the release |
|---|---|
| `api.genzdigitalstore.com` | `01a16024` ✔ |
| `www.api.genzdigitalstore.com` | `01a16024` ✔ |
| `wheat-bat-642462.hostingersite.com` | `01a16024` ✔ |
| `tan-emu-780421.hostingersite.com` | no longer serving the app — see below |

`tan-emu-780421.hostingersite.com` was a **preview** attachment. Two Hostinger preview builds ran
at 18:03 and 18:07 (triggered by the PR pushes, "Built (not published)") and version `01a15fa5`
was attached to that hostname. It was publicly reachable and loaded the same `.env`, i.e. the
**production database**. Its CRM files happened to carry the same four hashes, so no unpatched code
was exposed. The `publish` at 20:26 released the preview and pruned the old version directories;
that hostname now returns the parked static page. **Worth the owner's attention as a standing
platform behaviour**, not something changed here.

Method note for next time: hostname→worker binding comes from `/proc/<pid>/fd` → `/proc/net/unix`
→ `extapp-sock/<hostname>:_.sock`, cross-checked with `/proc/<pid>/cwd` and `ps -o lstart`. CPU
counters are not routing evidence.

---

## 3. Frontend — unchanged by this release

Served entry bundle, identical on both roots and identical to the reviewed build:

```
main.7989084c.js   sha256 45aed1c9952a1666f4d585bdcdf5ca633a2f6ca9e7c140017c53c63766413858
```

`asset-manifest.json` on both roots still points at `/static/js/main.7989084c.js`. Build stamp
`sourceFingerprint 164ae42b…`, 322 source files, from `feat/crm-release1-ui` @ `bff7b58`.

Extension release untouched: **3.9.39**, 274,560 B, `sha256 56c78023…` as served by
`/api/crm/extension/version-info`.

---

## 4. Rollback — component-specific, never blanket

**Git is now the backend rollback source.** `main` `ac29e45` is exactly what is running, so a
revert of that merge plus the automatic rebuild is a complete, reviewable rollback. That is
strictly better than the hand backup, which is just as well, because:

> **Correction.** The backend backup `…/01a15b33-…/nodejs/.crm-backup-20261021T172757Z` **no longer
> exists.** It lived *inside* the version directory, and Hostinger's `publish` prunes old version
> directories — so the whole of `01a15b33` went with it. Only `01a16024` remains on disk. Never
> again put recovery material inside a version directory.

**A whole-backend revert of the four files is still unsafe.** It removes the `idempotencyKey`
declaration from the contact-create schemas, and because `validate()` runs `stripUnknown: true`,
the frontend's retry protection then disappears **silently** — a retry after a lost response
creates a second contact. Any permitted recovery must keep **both**:

* the audit-response allow-list (no `SELECT *`, no `before_json`/`after_json`), and
* contact-create idempotency-key acceptance.

Reverting the ordering change alone is fine. **Rolling back the frontend alone is safe** — the new
backend serves the old frontend correctly, pinned by `businessCrmReleaseCompatibility.test.js`.

Never restore an old database over newer legitimate transactions.

### Frontend rollback material — moved out of the public roots

Ten `.deploy-backup-<UTC>` directories (five per web root) were sitting inside the live document
roots. Exposure was confirmed by **bytes, not status codes**: each file was fetched and its hash
matched the file on disk (e.g. `index.html` → `dac92163a8fc482b…`).

All ten were copied to **`~/rollback/frontend-public-backups-20261021/`** (`0700`, files `0600`,
outside every document root), with `MANIFEST.sha256` over all 28 files — `sha256sum -c` passes,
0 failures — and a `RESTORE.md` holding the exact restore commands and the one real precondition
(the hashed bundle that `index.html` references must still exist under `static/js/`). Original
mtimes preserved; modes deliberately tightened.

Only then were the two **identified** public copies removed:

```
~/domains/genzdigitalstore.com/public_html/.deploy-backup-20261021T172855Z      (3 files)
~/domains/app.genzdigitalstore.com/public_html/.deploy-backup-20261021T172855Z  (3 files)
```

After removal, all six old URLs still return **HTTP 200** — but the body is the live SPA
`index.html` (`9cbcda415b592801…`, `text/html`), not the backup bytes. The 200 is the SPA fallback;
the backup content is gone. *An SPA 200 is not evidence either way — only the bytes are.*

**Still exposed, owner's call:** the other four timestamps (`20261020T211534Z`, `20261021T051216Z`,
`20261021T055318Z`, `20261021T072326Z`) remain publicly readable on both roots and still return
real manifests (`application/json`). Copies are already preserved in the restricted store, so
removal is a one-liner per root:

```sh
rm -rf ~/domains/genzdigitalstore.com/public_html/.deploy-backup-2026102{0T211534Z,1T051216Z,1T055318Z,1T072326Z}
rm -rf ~/domains/app.genzdigitalstore.com/public_html/.deploy-backup-2026102{0T211534Z,1T051216Z,1T055318Z,1T072326Z}
```

They contain no secret — only a previous build's `index.html`, `asset-manifest.json` and
`build-source.json`, all of which were public while live — but they do disclose previous build
manifests at guessable paths.

---

## 5. Release triggers — corrected

**The earlier claim was wrong.** The merge was said to be safe because `deploy-frontend.yml`
filters on `paths: frontend/**`. It does not filter on paths; it has **no `push` trigger at all**:

```yaml
on:
  # NO push trigger. … main's committed build is OLDER (main.020d28e1.js) …
  workflow_dispatch: {}
```

and that is enforced by `backend/tests/frontendDeployTriggerGuard.test.js`, after a 2026-10-20
near-miss where a merge touching `frontend/**` fired the job and was stopped only by an unrelated
guard failing first. The conclusion held; the reason given for it was wrong.

Triggers on the merged refs, and what actually happened:

| Workflow | `on:` | Fired by the merge? |
|---|---|---|
| `ci-tests.yml` | `pull_request: [main]`, `push: branches-ignore: [main]` | no |
| `deploy-frontend.yml` | `workflow_dispatch` only | no |
| `extsync-db-selftest.yml` | `workflow_dispatch`, `pull_request` | no |
| `hostinger-diagnostics.yml` | `workflow_dispatch` only | no |
| `crm-db-selftest.yml` (added by PR #26) | `workflow_dispatch`, `pull_request` | no |

Verified after the fact: the newest Actions run is 18:06 UTC, from before the merge. **No workflow
ran.** No frontend dispatch, no extension or Agent publish. The only consequence of the merge was
Hostinger's own rebuild — the controlled release in §1 — and no second deployment was triggered.

---

## 6. Verification performed

| Layer | Result |
|---|---|
| Published files | 4/4 SHA-256 match the reviewed candidate, in the published version dir |
| Deployment source | live tree = `main` `ac29e45`, **286/286 files, 0 differences** |
| Activated / routed workers | every hostname's worker runs from `01a16024`, verified by socket + cwd + start time |
| Live contracts (file level, on the served tree) | `SELECT *` on audit = 0; `AUDIT_COLUMNS` is an explicit 10-column list; the query interpolates only it; the response maps only those rows plus `action_label`/`actor_name`; `before_json`/`after_json` appear **only in comments**; `clientCreate` and `vendorCreate` accept the key |
| Unauthenticated API | `/api/crm/extension/version-info` 200 on all three serving hostnames |
| Real database | 36/36 on MariaDB 11.8.9 (production's engine version), plus 10.11 |
| Backend suite | **917/917** (was 853 — see below) |
| Frontend suites | 431/431, 42 suites |
| Browser regression | 10/10 Chromium modal-isolation checks incl. a deliberate-save control |
| Deploy-helper guard | 13/13, and **6 of them fail against the shipped helper** (blob `54df6590`) |
| Frontend artefacts | served bundle byte-identical before and after the release |

### The tests shipped with this release were not running in CI

`npm test` is an explicit file list. Three files added by this release — `businessCrmAuditResponse`
(the audit fix's own test), `businessCrmReleaseCompatibility`, `crmDeployPromoteGuard` — were never
added to it, and four older files had drifted out the same way. PR #26's green "Backend tests" check
had therefore **never executed any of them**. All seven are now listed (853 → 917 tests, all green)
and `tests/testManifestComplete.test.js` fails if it happens again.

### Not performed — these need the owner

* **Authenticated read-only audit verification on the intended origin.** A 401 proves nothing about
  the payload, and a generic 200 proves nothing about the handler. What is proven above is
  file-level, on the served tree. The exact endpoint — the module mounts at
  `/api/crm/admin/business`, and its admin router adds `/admin` — is:

  ```
  GET https://api.genzdigitalstore.com/api/crm/admin/business/admin/audit?page=1&pageSize=20
  ```

  Unauthenticated it answers `401 {"error":"Admin authentication required"}`, which confirms the
  route loads under the new build and nothing more. What remains to be seen, once, from a signed-in
  admin tab: the response rows carry `id, created_at, action_key, entity_type, entity_id,
  actor_user_id, actor_role, ip_address, user_agent, request_id` plus `action_label` and
  `actor_name`, and **no** `before_json`/`after_json`; and the restricted-role check — a role with
  `audit.view` but **without** `profit.view` must see no costs. No credential was requested, minted
  or read to get this far.
* **Normal-browser operator acceptance**: client search → details/balance → product auto-fill →
  quick-create open/cancel with the draft preserved → pagination → audit → Zee → an existing Tool
  Access. No production write was performed for a test, by design.
