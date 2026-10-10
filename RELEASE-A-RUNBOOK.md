# Release A — backend credential containment + logout diagnostics

**Status: prepared, NOT deployed. Requires operator approval.**
Source of truth: this worktree (clean integration of `origin/main` + the change set). Suite: **769/769**.

---

## 0. Prerequisite — Phase 1 compatibility audit (BLOCKING)

Run this against production FIRST. Release A must not ship until it says COMPATIBLE.

**Why it is safe to run on production** (all test-locked, `tests/auditFormComboTools.test.js` 26/26):

- Loads **no** adapter and **no** model, so `ensureTables()` / `CREATE TABLE` / `ALTER` cannot fire.
- Issues `START TRANSACTION READ ONLY` first, so the **server** rejects any write for the session.
- Issues exactly **five** statements, all allowlisted: the read-only BEGIN, a `SELECT DATABASE()/VERSION()`,
  a counts probe, two narrow JSON projections, and `ROLLBACK`.
- **No credential value is ever selected.** `formConfig.password` and `credentials.payloadEncrypted`
  are reduced to `CHAR_LENGTH(...)` inside SQL; the username is masked in SQL (first char +
  domain only). No plaintext password, payload, cookie or token reaches the process.
- **Fails closed**: a query error, a non-array result, a missing projected column, or a row-count
  mismatch aborts with exit 2, prints `AUDIT FAILED (no verdict produced)`, and tells you to treat
  it as NOT COMPATIBLE.
- Prints the database **name** only — never the URL, host, user or password.
- Counts active customers with the app's real rule (`status=active`, tool active, `startDate<=now`,
  and the **inclusive** date-only expiry from `ToolAssignment.effectiveEndBoundary`), so an
  assignment ending *today* still counts.

**Staging — private app directory, never a web root.**

```bash
# 1. In hPanel -> File Manager, upload audit-form-combo-tools.js to this PRIVATE dir
#    (it is NOT under public_html, so it is not web-reachable):
~/domains/api.genzdigitalstore.com/.builds/current/nodejs/scripts/

# 2. In hPanel -> Terminal:
cd ~/domains/api.genzdigitalstore.com/.builds/current/nodejs
sha256sum scripts/audit-form-combo-tools.js
#   MUST print: 27b86a12a76ec142178386a10b69045fc50acd50e670ad75773c60d49ee42a2b

# 3. Run it ONCE (read-only):
AUDIT_FORM_COMBO=1 AUDIT_ENV_FILE=$HOME/domains/api.genzdigitalstore.com/.builds/hbuilds/config/.env   node scripts/audit-form-combo-tools.js | tee ~/audit-$(date -u +%Y%m%d).txt

# 4. Remove it afterwards:
rm -f scripts/audit-form-combo-tools.js
```

Schema/env it expects (already verified against this codebase): tables `tools` and
`tool_assignments`, each `id VARCHAR(32)` + `data LONGTEXT` holding the whole JSON document;
`DATABASE_URL` read from `hbuilds/config/.env`; engine MariaDB 11.8.9 (supports
`START TRANSACTION READ ONLY` and the `JSON_*` functions used). `mysql2` is already present in the
app's `node_modules`.

**How to read the verdict — the last lines of the output:**

| Verdict | Meaning | Action |
|---|---|---|
| `RESULT: COMPATIBLE` | no tool depends on client-typed credentials | **Release A may proceed** |
| `RESULT: COMPATIBLE (dormant config only)` | credentials exist but no currently-valid assignment uses them | **Release A may proceed**; clear the dormant config |
| `RESULT: NOT COMPATIBLE - STOP` | live customers log in by typing the shared password | **STOP** — migrate those tools first |
| `AUDIT FAILED (no verdict produced)` | fail-closed abort | **STOP** — treat as NOT COMPATIBLE, re-run |

Either way, note the **`tools holding a typed master credential`** list — those provider passwords
are the ones to rotate in step 6.

---

## 1. Scope — exactly five files

| SHA-256 | path |
|---|---|
| `d0b8c07bcb0eea5d635827f0e5ad8d717d4cd263e2a51026aa2995e9d5c9e515` | `backend/utils/clientCredentialSafety.js` *(new)* |
| `5d9733eb9598a708782b095f98bcd64f70cbcd49523053f0e4b4010a3627c80a` | `backend/routes/extension/index.js` |
| `43eef78b050c5eb18e122dbda2b4ddc5f97a917023081092ee759a4da3cef47b` | `backend/routes/client/tools.js` |
| `74083e4bb74b75e84baea936ec753bb876f51fbddaed9ad44148130325757969` | `backend/utils/proxy/verify.js` |
| `1af8b0f34765ebf61dc5dcfc2a9f90a7c308f355258c0eab76d01d46d986e4a3` | `backend/utils/proxy/verifyAndApply.js` |

Verify locally before sending:

```bash
cd <this worktree>
sha256sum backend/utils/clientCredentialSafety.js backend/routes/extension/index.js \
  backend/routes/client/tools.js backend/utils/proxy/verify.js backend/utils/proxy/verifyAndApply.js
```

**NOT in Release A:** `backend/routes/admin/proxyTools.js` (the `EXPECTED_AGENT_VERSION` bump
belongs to Release B), the agent, `deploy-hostinger.sh`, `backend/package.json`, the test files.

**Never run `deploy-hostinger.sh`** for this. It ships a fixed list of many files; from the old
stale branch that would have overwritten 47 newer production files. Targeted upload only.

---

## 2. Back up the four files being replaced

`clientCredentialSafety.js` is new, so only four have a predecessor.

```bash
API=~/domains/api.genzdigitalstore.com/.builds/current/nodejs
BK=~/release-a-backup-$(date -u +%Y%m%d-%H%M%S); mkdir -p "$BK"/{routes/extension,routes/client,utils/proxy}
cp "$API/routes/extension/index.js"     "$BK/routes/extension/index.js"
cp "$API/routes/client/tools.js"        "$BK/routes/client/tools.js"
cp "$API/utils/proxy/verify.js"         "$BK/utils/proxy/verify.js"
cp "$API/utils/proxy/verifyAndApply.js" "$BK/utils/proxy/verifyAndApply.js"
sha256sum $(find "$BK" -type f) | tee "$BK/SHA256SUMS.before"
echo "$BK"
```

---

## 3. Deploy

`deploy-backend.sh` syntax-checks each file, uploads one at a time, SHA-256-verifies each on the
server, restarts Passenger only after **all** land, then waits for boot.

```bash
cd <this worktree>
bash deploy-backend.sh \
  backend/utils/clientCredentialSafety.js \
  backend/routes/extension/index.js \
  backend/routes/client/tools.js \
  backend/utils/proxy/verify.js \
  backend/utils/proxy/verifyAndApply.js
```

> **Auth note.** `origin/main`'s `deploy-lib.sh` still uses `curl -u "user:pass"` (password visible
> in `ps`) and blind-trusts the host key via `ssh-keyscan >> known_hosts` each run (TOFU,
> MITM-exposed). Both are pre-existing and **out of Release A's scope** — I did not change them.
> For a credential-security deployment, prefer the **passwordless key-based scp** path used for the
> extcredsync rollout, or harden `deploy-lib.sh` as a separate reviewed change first.
>
> Upload `backend/scripts/audit-form-combo-tools.js` too if you want to run the audit server-side.

---

## 4. Verify

**Health + gating** (no credentials needed):

```bash
curl -s https://api.genzdigitalstore.com/api/crm/health          # {"status":"ok", mysql.state:"connected"}
for p in admin/tools client/tools extension/tools; do
  curl -s -o /dev/null -w "$p %{http_code}\n" "https://api.genzdigitalstore.com/api/crm/$p"
done                                                              # all 401
```

**Real client-response security check** — the one that actually proves the fix. Use a genuine
client session and a genuine extension token, and grep the *serialized* bodies:

```bash
# A) client dashboard (client JWT)
curl -s -H "Authorization: Bearer <CLIENT_JWT>" \
  https://api.genzdigitalstore.com/api/crm/client/tools > /tmp/a.json
grep -c '"comboAuth"' /tmp/a.json        # EXPECT 0
grep -ci 'password'   /tmp/a.json        # EXPECT 0

# B) extension credentials (extension token)
curl -s -H "X-Extension-Token: <EXT_TOKEN>" \
  "https://api.genzdigitalstore.com/api/crm/extension/tools/<TOOL_ID>/credentials" > /tmp/b.json
python3 -c "import json;d=json.load(open('/tmp/b.json'));fc=d['tool']['comboAuth'].get('formConfig',{});print('username' in fc, 'password' in fc)"
# EXPECT: False False
grep -c '"cookies"' /tmp/b.json          # EXPECT >0  (session material still delivered)
```

**Functional smoke:** open one WriteHuman tool from a client dashboard — exactly one tab, tool
loads signed in. Then one non-WriteHuman cookies tool. Diagnostics are passive: at the next genuine
expiry, `verification.providerErrorCode` appears on the WriteHuman ProxyAccount in the admin view.

---

## 5. Rollback

File-level and immediate. No schema change, no policy change, no extension release.

```bash
API=~/domains/api.genzdigitalstore.com/.builds/current/nodejs
BK=<the backup dir printed in step 2>
cp "$BK/routes/extension/index.js"     "$API/routes/extension/index.js"
cp "$BK/routes/client/tools.js"        "$API/routes/client/tools.js"
cp "$BK/utils/proxy/verify.js"         "$API/utils/proxy/verify.js"
cp "$BK/utils/proxy/verifyAndApply.js" "$API/utils/proxy/verifyAndApply.js"
rm -f "$API/utils/clientCredentialSafety.js"
touch "$API/tmp/restart.txt"
curl -s https://api.genzdigitalstore.com/api/crm/health
```

Rolling back **restores the credential exposure**, so treat it as a short-term measure only.

---

## 6. After deploy — rotate

The exposure was live: any client holding an assignment to a Form/Combo tool could read that
tool's provider master password from their own extension token or client JWT. Rotate the provider
password for **WriteHuman and every tool the Phase 1 audit lists as holding a typed master
credential.** Rotation is what actually ends the exposure; the patch stops it recurring.
