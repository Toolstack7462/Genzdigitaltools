#!/bin/sh
# Validate-then-promote for a hand-deployed backend patch set.  EMERGENCY USE ONLY.
#
# PREFER THE ESTABLISHED RELEASE PATH. Pushing to `main` makes Hostinger clone the repo, run
# `npm install`, copy the tree into a NEW version directory and switch the `current` symlink to it.
#
# OBSERVED PUBLICATION MECHANISM - 2026-10-21, from the platform's own deploy log:
#   build 01a16024 from main ac29e455, "Mode: publish ... Switching current to the new version",
#   the publish step self-reported 8.9s. One reference change swaps the whole directory, so a
#   half-written tree is never published, and the files under the new reference were byte-verified
#   afterwards (4/4 reviewed files; 286/286 tree-wide against main).
#   Also observed: the publish PRUNED the previous version directory - only 01a16024 remained. A
#   backup stored INSIDE the old version directory was destroyed with it. Keep recovery material
#   outside the version directories.
#
# RUNTIME VERIFICATION IS A SEPARATE QUESTION, and the reference switch does not answer it:
#   * It is NOT proof that all serving workers changed together. Each hostname has its own
#     LiteSpeed external-application instance, and each keeps serving the tree it resolved when it
#     started. On 2026-10-21 FOUR hostnames were bound to this one app, and one of them was still
#     serving the previous build ~24h after that build had been superseded. The check actually
#     used, per hostname: match the worker's socket (/proc/<pid>/fd -> socket:[inode] -> the
#     extapp-sock/<hostname> entry in /proc/net/unix), read /proc/<pid>/cwd for the version
#     directory it resolved, `ps -o lstart` for its start time, then one read-only request to that
#     hostname. A worker adopts a new build only on its own next start.
#   * It is NOT a zero-downtime claim. 8.9s is the platform timing its own publish step; it is not
#     a measured request-loss figure, and no downtime measurement was taken.
#   * It says NOTHING about the database. Schema and data migrations are not part of that rename
#     and are not atomic with it: during a changeover, old and new code can both be live against
#     the one database.
#
# This script replaces files IN PLACE inside the live version directory and guarantees strictly
# less than the publish path. Use it only when the git path is unavailable.
#
# WHY IT EXISTS. The 2026-10-21 CRM backend deploy ran, per uploaded file:
#
#     base64 -d > "$f.new" && mv "$f.new" "$f" && node -c "$f" && echo ok
#
# Two separate defects, and only the first was fixed at the time:
#
#   1. ORDER. The promotion (`mv`) happened BEFORE the check, so a file was already live when its
#      check ran - and `node` is absent from the remote non-interactive PATH, so every check
#      reported "node: command not found" against files that had already replaced the originals.
#      (The later `node --check "$f.new"` form has a different trap: `--check` rejects an unknown
#      extension outright, so it fails on the NAME before it ever parses the contents. That is a
#      check that cannot pass, not a check that lets bad code through - the defect was still the
#      ORDER. This script checks a copy carrying the real extension.)
#
#   2. PARTIAL FAILURE. Validation stops nothing once promotion starts. With two files, the first
#      `mv` succeeding and the second failing left one new file and one old file - a MIXED patch
#      set - and the script merely exited non-zero. Nothing undid the first promotion.
#
# So: resolve a usable node from the APPLICATION'S configuration; syntax-check every staged file;
# verify a restorable backup exists BEFORE promoting anything; and if a promotion fails, put the
# already-promoted files back and re-stage them, or say explicitly that it could not.
#
# MULTIPLE FILES ARE REFUSED BY DEFAULT. A set of two or more files has a window between renames
# that this script cannot close (see below), so the safe default is one file per run. If a
# multi-file emergency patch is genuinely unavoidable, re-run with CRM_DEPLOY_ALLOW_MULTI=1 to
# acknowledge that window: the recovery below is tested, the window is not removable.
#
# WHAT THIS DOES NOT GUARANTEE. It is NOT crash-atomic, and no shell trap can make it so - a
# SIGKILL, a host reboot or a lost power rail runs no handler at all, and the process that would
# roll the set back is simply gone. The detection signal is the lock directory: when a run cannot
# leave the tree consistent it RETAINS <app-root>/.crm-promote.lock, whose `promoted` journal
# lists exactly which files were already replaced and whose `UNRESOLVED` file states what is
# wrong. The retained lock also makes the next run refuse (exit 5) rather than promote over a
# mixed tree. Restore the journalled files from the backup directory by hand, remove the lock, and
# activate nothing until the tree is consistent again.
#
# Node is resolved from PassengerNodejs in the serving .htaccess - the interpreter the app
# actually runs - never a guessed path. Override with CRM_DEPLOY_NODE when testing.
#
#   Usage:  crm-deploy-promote.sh <app-root> <backup-dir> <relative-file> [more files...]
#   Each <relative-file> must already exist as <app-root>/<relative-file>.new
#
# Exit: 0 all promoted - 2 no usable node - 3 a staged file is missing - 4 a syntax check failed
#       5 another promotion holds the lock - 6 promotion failed, fully rolled back
#       7 promotion failed or was interrupted AND the tree is UNRESOLVED: manual recovery required
#       8 a restorable backup could not be made - nothing was replaced
#       9 several files without CRM_DEPLOY_ALLOW_MULTI=1 - nothing was replaced

set -eu

APP_ROOT="${1:?app root required}"; shift
BACKUP_DIR="${1:?backup dir required}"; shift
[ "$#" -gt 0 ] || { echo "no files given" >&2; exit 3; }

HTACCESS="${CRM_DEPLOY_HTACCESS:-/home/u171982351/domains/api.genzdigitalstore.com/public_html/.htaccess}"

# The file-moving commands are indirected ONLY so the guard tests can inject a failure at an
# exact step without this script carrying fault-injection logic of its own. Unset in production,
# these are plain `mv` and `cp`.
MV="${CRM_DEPLOY_MV:-mv}"
CP="${CRM_DEPLOY_CP:-cp}"
ROLLBACK_CP="${CRM_DEPLOY_ROLLBACK_CP:-$CP}"

# ---- 0. a multi-file set is opt-in, because its window cannot be closed ----------------------
if [ "$#" -gt 1 ] && [ "${CRM_DEPLOY_ALLOW_MULTI:-0}" != "1" ]; then
  echo "REFUSING TO PROMOTE: $# files in one run." >&2
  echo "      Between two renames there is a window this script cannot make atomic." >&2
  echo "      Use the established release path instead: push to main, let the platform publish a" >&2
  echo "      new version directory, and switch the reference." >&2
  echo "      If that is genuinely unavailable, acknowledge the window: CRM_DEPLOY_ALLOW_MULTI=1" >&2
  exit 9
fi

resolve_node() {
  # 1. whatever the caller pinned (tests)
  if [ -n "${CRM_DEPLOY_NODE:-}" ] && [ -x "${CRM_DEPLOY_NODE}" ]; then printf '%s' "$CRM_DEPLOY_NODE"; return 0; fi
  # 2. the interpreter Passenger is configured to run this app with
  if [ -r "$HTACCESS" ]; then
    candidate=$(sed -n 's/^[[:space:]]*PassengerNodejs[[:space:]]\{1,\}//p' "$HTACCESS" | tr -d '\r' | head -1)
    if [ -n "$candidate" ] && [ -x "$candidate" ]; then printf '%s' "$candidate"; return 0; fi
    # the configured path and the real binary differ on this host (root/bin vs root/usr/bin)
    alt=$(printf '%s' "$candidate" | sed 's#/root/bin/node#/root/usr/bin/node#')
    if [ -n "$alt" ] && [ -x "$alt" ]; then printf '%s' "$alt"; return 0; fi
  fi
  # 3. PATH, last - it is empty in a non-interactive shell on this host
  if command -v node >/dev/null 2>&1; then command -v node; return 0; fi
  return 1
}

NODE=$(resolve_node) || {
  echo "REFUSING TO PROMOTE: no usable node found (checked CRM_DEPLOY_NODE, PassengerNodejs in $HTACCESS, PATH)." >&2
  exit 2
}
echo "node: $NODE"

mkdir -p "$BACKUP_DIR"
BACKUP_DIR=$(cd "$BACKUP_DIR" && pwd)
cd "$APP_ROOT" || { echo "app root not readable: $APP_ROOT" >&2; exit 3; }
APP_ROOT=$(pwd)

# ---- 1. one promotion at a time --------------------------------------------------------------
# `mkdir` is the atomic test-and-set: two releases cannot both believe they hold it, so a second
# run cannot interleave its renames with this one's on the same files. A leftover lock is NOT
# cleared automatically - it is the evidence that a previous run left the tree unresolved.
LOCK="$APP_ROOT/.crm-promote.lock"
if ! mkdir "$LOCK" 2>/dev/null; then
  echo "REFUSING TO PROMOTE: another promotion holds $LOCK" >&2
  [ -f "$LOCK/owner" ] && sed 's/^/      held by: /' "$LOCK/owner" >&2
  [ -f "$LOCK/UNRESOLVED" ] && sed 's/^/      /' "$LOCK/UNRESOLVED" >&2
  if [ -s "$LOCK/promoted" ]; then
    echo "      that run left a promotion journal - the tree may be MIXED. Already replaced:" >&2
    sed 's/^/        /' "$LOCK/promoted" >&2
    echo "      Restore those from the backup directory by hand before promoting again." >&2
  fi
  exit 5
fi

# The lock is released on a clean outcome and DELIBERATELY RETAINED on an unresolved one. That is
# bookkeeping, not atomicity: a killed process runs neither branch, which is exactly why a
# surviving lock must be read as "a run died mid-flight", not as "a run is in progress".
KEEP_LOCK=0
JOURNAL="$LOCK/promoted"
release_lock() { [ "$KEEP_LOCK" -eq 1 ] || rm -rf "$LOCK"; }
on_signal() {
  if [ -s "$JOURNAL" ]; then
    KEEP_LOCK=1
    { echo "INTERRUPTED by a signal after files were already replaced."
      echo "already replaced (restore from $BACKUP_DIR):"
      sed 's/^/  /' "$JOURNAL"; } > "$LOCK/UNRESOLVED"
    echo "INTERRUPTED: a signal arrived after files were already replaced - the set is UNRESOLVED." >&2
    sed 's/^/      /' "$LOCK/UNRESOLVED" >&2
    echo "      This is not a completed deployment. Lock RETAINED at $LOCK so the next run refuses." >&2
    echo "      DO NOT touch tmp/restart.txt until the tree is consistent again." >&2
    exit 7
  fi
  exit 1
}
trap release_lock EXIT
trap on_signal INT TERM HUP
printf 'pid %s at %s\n' "$$" "$(date -u +%Y-%m-%dT%H:%M:%SZ)" > "$LOCK/owner"
: > "$JOURNAL"

# ---- 2. every staged file must exist ---------------------------------------------------------
for rel in "$@"; do
  [ -f "$rel.new" ] || { echo "REFUSING TO PROMOTE: staged file missing: $rel.new" >&2; exit 3; }
done

# ---- 3. syntax-check them all BEFORE anything is replaced ------------------------------------
failed=0
for rel in "$@"; do
  # `node --check` refuses an unknown extension outright (ERR_UNKNOWN_FILE_EXTENSION), so a
  # "<file>.new" is rejected for its NAME before its contents are ever parsed. Check a copy that
  # keeps the real extension instead, or the check can only ever fail.
  probe="$(dirname "$rel")/.crmcheck.$$.$(basename "$rel")"
  cp "$rel.new" "$probe"
  if "$NODE" --check "$probe" 2>/tmp/crm-deploy-check.$$; then
    echo "  check OK   $rel"
  else
    echo "  check FAIL $rel" >&2
    sed 's/^/      /' /tmp/crm-deploy-check.$$ >&2 || true
    failed=1
  fi
  rm -f "$probe"
done
rm -f /tmp/crm-deploy-check.$$
if [ "$failed" -ne 0 ]; then
  echo "REFUSING TO PROMOTE: at least one staged file failed its syntax check. Nothing was replaced." >&2
  exit 4
fi

# ---- 4. back up, preserving mode and timestamps, and VERIFY the backup is restorable ---------
# An unverified backup is not a recovery plan. If recovery would be impossible, refuse before the
# first rename instead of discovering it during a rollback.
for rel in "$@"; do
  if [ -f "$rel" ]; then
    mkdir -p "$BACKUP_DIR/$(dirname "$rel")"
    if ! $CP -p "$rel" "$BACKUP_DIR/$rel" 2>/dev/null; then
      echo "REFUSING TO PROMOTE: could not back up $rel - nothing was replaced." >&2
      exit 8
    fi
    if ! cmp -s "$rel" "$BACKUP_DIR/$rel"; then
      echo "REFUSING TO PROMOTE: the backup of $rel does not match the live file - nothing was replaced." >&2
      exit 8
    fi
  fi
done

# ---- 5. promote; on any failure, undo what was already promoted ------------------------------
rollback() {
  mixed=''
  while IFS= read -r done_rel; do
    [ -n "$done_rel" ] || continue
    # re-stage the new content so the release can simply be retried...
    if [ -f "$done_rel" ] && ! $ROLLBACK_CP -p "$done_rel" "$done_rel.new" 2>/dev/null; then
      mixed="$mixed $done_rel"; continue
    fi
    # ...then put the original back, or remove the file if there was no original
    if [ -f "$BACKUP_DIR/$done_rel" ]; then
      if ! $ROLLBACK_CP -p "$BACKUP_DIR/$done_rel" "$done_rel" 2>/dev/null; then
        mixed="$mixed $done_rel"
      fi
    else
      rm -f "$done_rel" || mixed="$mixed $done_rel"
    fi
  done < "$JOURNAL"
  printf '%s' "$mixed"
}

for rel in "$@"; do
  # The replacement arrives from base64/sftp with whatever mode that produced, so carry the live
  # file's own mode over rather than letting a release silently change it.
  mode=''
  if [ -f "$rel" ]; then mode=$(stat -c '%a' "$rel" 2>/dev/null || true); fi
  if [ -n "$mode" ]; then chmod "$mode" "$rel.new" 2>/dev/null || true; fi
  if $MV "$rel.new" "$rel"; then
    printf '%s\n' "$rel" >> "$JOURNAL"
    echo "  promoted   $rel"
  else
    echo "PROMOTION FAILED on $rel - undoing the files already replaced." >&2
    mixed=$(rollback)
    if [ -n "$mixed" ]; then
      KEEP_LOCK=1
      { echo "MIXED STATE: a promotion failed and the rollback did not complete."
        echo "not the originals (restore from $BACKUP_DIR):"
        for m in $mixed; do echo "  $m"; done; } > "$LOCK/UNRESOLVED"
      echo "MIXED STATE: rollback did not complete. These files are NOT the originals:" >&2
      for m in $mixed; do echo "      $m" >&2; done
      echo "      Restore them from $BACKUP_DIR by hand. Lock RETAINED at $LOCK, so the next run" >&2
      echo "      refuses instead of promoting over a mixed tree." >&2
      echo "      DO NOT touch tmp/restart.txt:" >&2
      echo "      an un-activated mixed set is still recoverable; an activated one is an outage." >&2
      exit 7
    fi
    echo "RECOVERED, NOT DEPLOYED: promotion failed on $rel and was undone. Every file is the" >&2
    echo "      original again, the new content is staged as <file>.new, and the backups are kept." >&2
    echo "      Nothing was activated - DO NOT touch tmp/restart.txt. Fix the cause and re-run." >&2
    exit 6
  fi
done

echo "backup: $BACKUP_DIR"
echo "NOTE: activation is separate - touch <app-root>/tmp/restart.txt and confirm new worker start"
echo "      times with ps. A health 200 does not prove the new code is loaded, and one worker"
echo "      restarting does not mean every hostname's worker did."
