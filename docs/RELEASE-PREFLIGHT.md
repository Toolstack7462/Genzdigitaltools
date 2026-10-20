# Release preflight — identifying the RUNNING backend revision

A push to `main` is what Hostinger's auto-deploy watches, but **`main`'s SHA does not tell you
what is running**: this project has a history of code hand-deployed over SFTP and never committed
(the Extension Credential Auto-Sync bridge itself was built that way on 2026-10-08/09). So the
running revision has to be *identified from the server*, not inferred from git.

## Run it WITHOUT merging anything

`hostinger-diagnostics.yml` is `workflow_dispatch` only and already exists on `main`, so it can be
dispatched **against a branch ref** — the branch's own copy of the workflow is the one that runs.
Do **not** merge a diagnostics change into `main` just to run it: a push to `main` rebuilds the
backend, which would deploy before the inspection it was supposed to inform.

    Actions -> "Hostinger diagnostics" -> Run workflow -> Use workflow from: <branch>

It needs `HOSTINGER_SSH_PRIVATE_KEY` and `HOSTINGER_SSH_KNOWN_HOSTS` (and
`HOSTINGER_SSH_PASSPHRASE` if the key is encrypted). Host-key checking stays strict and pinned;
`ssh-keyscan` is deliberately not used and password authentication is never a fallback. If the
environment restricts which refs may use those secrets, that restriction is respected — the run
fails and the owner decides, rather than anything being worked around.

## What the preflight will and will not claim

| Printed | Means |
|---|---|
| `root source: ACTIVE-DIRECTIVE (authoritative)` | the path came from a live, uncommented `PassengerAppRoot` |
| `root source: FALLBACK-GUESS (NOT authoritative)` | no active directive was readable — **the revision below is UNCONFIRMED** |
| `commented-out PassengerAppRoot directives: N>0` | sleep/wake parks an app by commenting these out, so a commented match is *not* a live root |
| `MISSING` / `UNREADABLE` / `EMPTY` / `present` | decided by `[ -e ]`, `[ -r ]`, `[ -s ]` — **never** by recognising a hash |
| `engine facts: UNKNOWN` | the query could not run. This is *not* "lenient", "strict", or any value |
| `ext_autosync_policies: UNKNOWN` | the read failed. This is *not* "no policy" |
| `ext_autosync_policies: ABSENT from the selected schema` | the table does not exist in the schema `DATABASE()` returned — a finding |

File hashes are **partial evidence**. A revision claim correlates three things: the resolved
application root (and whether it was authoritative), the deployment metadata (`.builds` listing and
what `current` resolves to), and the dependency manifest (`package.json` / `package-lock.json`
hashes plus the `node_modules` entry count). The newest-12-`.js`-by-mtime listing exists for the
same reason: an mtime later than the last `main` deploy is hand-deploy evidence.

Nothing in the diagnostic writes. It creates no file on the server (the application root is a shell
variable inside one subshell, not a dropped state file), imports no application code — so no model
loads and `ensureTables()` cannot create the very table being checked for — issues no SQL beyond
`SELECT`/`SHOW`, and triggers no restart.

## Fingerprints (sha256, first 16 hex of the file content)

`main` is `ff54ebc` (PR #18 merged the scoped rollback on 2026-10-20 03:55:12 UTC) and was
auto-deployed by that push. The corrective candidate restores the feature.

| backend file | deployed main `ff54ebc` | corrective candidate `573aa5e` |
|---|---|---|
| `server-crm.js` | `189f7b3b13626070` | `189f7b3b13626070` |
| `db/mysqlAdapter.js` | `37df87df04e6737e` | `37df87df04e6737e` |
| `models/Tool.js` | `9f0297040261a166` | `9f0297040261a166` |
| `utils/proxy/verify.js` | `fdb93aa2d319d723` | `fdb93aa2d319d723` |
| `routes/admin/proxyTools.js` | `63367081ebd47d43` | `4c5eff86daa6d917` |
| `routes/admin/toolsEnhanced.js` | `2d065f66e152e381` | `8cc7aa812b2026d6` |
| `routes/proxy/agentSync.js` | `a7efcc13e696fff0` | `7d7b585806365669` |
| `utils/proxy/extensionCredentialSync.js` | *absent* | `23a6ef5ceb9ab44d` |
| `models/proxy/ExtAutoSyncPolicy.js` | `17e6b8097db1bd4e` | `17e6b8097db1bd4e` |
| `scripts/extcredsync-db-selftest.js` | `6d31f6eab17bc246` | `6d31f6eab17bc246` |

Earlier reference points: old main `92e4302` had `mysqlAdapter.js` `41051a85bee49cb1`,
`verify.js` `96212561ff74246d`, and all three new files absent. The reviewed release `62aa419`
has a tree **identical** to `573aa5e`.

Regenerate with:

    for f in server-crm.js db/mysqlAdapter.js models/Tool.js utils/proxy/verify.js \
             routes/admin/proxyTools.js routes/admin/toolsEnhanced.js routes/proxy/agentSync.js \
             utils/proxy/extensionCredentialSync.js models/proxy/ExtAutoSyncPolicy.js \
             scripts/extcredsync-db-selftest.js; do
      if git cat-file -e "<ref>:backend/$f" 2>/dev/null; then
        printf '%-42s %s\n' "$f" "$(git show "<ref>:backend/$f" | sha256sum | cut -c1-16)"
      else printf '%-42s %s\n' "$f" "absent at this ref"; fi
    done

Note the `git cat-file -e` guard. Without it, `git show` on a missing path emits nothing and
`sha256sum` hashes **empty input**, producing `e3b0c44298fc1c14…` — which looks like a real hash
and is not. The server-side diagnostic does not have this problem because it reports file state
from `[ -e ]` / `[ -r ]` / `[ -s ]`, not from hashing.

## How to read the result

| `utils/proxy/extensionCredentialSync.js` on the server | Conclusion |
|---|---|
| `MISSING` | the bridge is not deployed — manual source updates cannot reach `Tool.sessionBundle` |
| `present`, `23a6ef5ceb9ab44d` | the restored bridge is running |
| `present`, any other hash | a **hand-deployed variant** is running; capture it before any deploy overwrites it |
| `UNREADABLE` | state UNKNOWN — do not conclude either way |

Only trust any of those rows if `root source` said `ACTIVE-DIRECTIVE`.

## Why a disabled policy is NOT the same as "behaviour-neutral"

The release ships the policy disabled with no approved account, so the **Auto-Sync feature** does
nothing until an admin enables it and approves an observed identity. That is not the same claim as
the deploy being inert, and two retained changes are already live on `main`:

- `db/mysqlAdapter.js` changes the single `DATETIME` binding site in `_upsertRaw`, which every one
  of the **17 models with a `preSave` hook** writes through — not just the Auto-Sync model.
- `utils/proxy/verify.js` changes what counts as authentication proof on the **shared canary path**
  used by every proxy tool, not only WriteHuman.

Both were covered by the real-engine DB job (green on mysql:8.0.46 and mariadb:10.11.19) and by the
shared-consumer suites (204/204 on the corrective candidate), but they are genuinely global, and
production strictness has still never been observed from here — which is exactly why the preflight
prints `DATABASE()`, `@@version`, `@@sql_mode` and both time zones instead of anyone assuming them.
