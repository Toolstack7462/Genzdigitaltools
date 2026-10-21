#!/bin/sh
# Validate-then-promote for a hand-deployed backend patch set.  EMERGENCY USE ONLY.
#
# PREFER THE ESTABLISHED RELEASE PATH. Pushing to `main` makes Hostinger clone the repo, run
# `npm install`, copy the tree into a NEW version directory and switch the `current` symlink to
# it. That swap is a single rename: either the whole release is live or none of it is, and the
# previous version directory stays on disk. Proven on 2026-10-21 (build 01a16024 from main
# ac29e45: "Mode: publish ... Switching current to the new version", 8.9s, no mixed state).
# This script replaces files IN PLACE inside the live version directory and cannot offer that.
# Use it only when the git path is unavailable, and prefer a single file when you do.
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
# only then back up and promote; and if any promotion fails, put the already-promoted files back
# from their backups and re-stage them, leaving the tree as it was found.
#
# WHAT THIS DOES NOT GUARANTEE. It is NOT crash-atomic. A SIGKILL, a host reboot or a dropped
# connection between two renames leaves a mixed set that no code here can undo, because the
# process that would roll it back is gone. The leftover lock directory is the detection signal:
# if `<app-root>/.crm-promote.lock` exists and holds a `promoted` journal, a run died mid-flight
# and that journal lists exactly which files were already replaced. Restore those by hand from
# the backup directory, and activate nothing until the tree is consistent again.
#
# Node is resolved from PassengerNodejs in the serving .htaccess - the interpreter the app
# actually runs - never a guessed path. Override with CRM_DEPLOY_NODE when testing.
#
#   Usage:  crm-deploy-promote.sh <app-root> <backup-dir> <relative-file> [more files...]
#   Each <relative-file> must already exist as <app-root>/<relative-file>.new
#
# Exit: 0 all promoted - 2 no usable node - 3 a staged file is missing - 4 a syntax check failed
#       5 another promotion holds the lock - 6 promotion failed, fully rolled back
#       7 promotion failed AND rollback was incomplete: MIXED STATE, manual recovery required.

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

# ---- 0. one promotion at a time ------------------------------------------------------------
# `mkdir` is the atomic test-and-set: two releases cannot both believe they hold it, so a second
# run cannot interleave its renames with this one's on the same files. A leftover lock is NOT
# cleared automatically - it is the evidence that a previous run died mid-flight.
LOCK="$APP_ROOT/.crm-promote.lock"
if ! mkdir "$LOCK" 2>/dev/null; then
  echo "REFUSING TO PROMOTE: another promotion holds $LOCK" >&2
  [ -f "$LOCK/owner" ] && sed 's/^/      held by: /' "$LOCK/owner" >&2
  if [ -s "$LOCK/promoted" ]; then
    echo "      that run left a promotion journal - the tree may be MIXED. Already replaced:" >&2
    sed 's/^/        /' "$LOCK/promoted" >&2
    echo "      Restore those from the backup directory by hand before promoting again." >&2
  fi
  exit 5
fi
trap 'rm -rf "$LOCK"' EXIT
trap 'rm -rf "$LOCK"; exit 1' INT TERM HUP
printf 'pid %s at %s\n' "$$" "$(date -u +%Y-%m-%dT%H:%M:%SZ)" > "$LOCK/owner"
JOURNAL="$LOCK/promoted"
: > "$JOURNAL"

# ---- 1. every staged file must exist -------------------------------------------------------
for rel in "$@"; do
  [ -f "$rel.new" ] || { echo "REFUSING TO PROMOTE: staged file missing: $rel.new" >&2; exit 3; }
done

# ---- 2. syntax-check them all BEFORE anything is replaced ----------------------------------
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

# ---- 3. back up, preserving the originals' mode and timestamps ------------------------------
for rel in "$@"; do
  if [ -f "$rel" ]; then
    mkdir -p "$BACKUP_DIR/$(dirname "$rel")"
    cp -p "$rel" "$BACKUP_DIR/$rel"
  fi
done

# ---- 4. promote; on any failure, undo what was already promoted ----------------------------
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
      echo "MIXED STATE: rollback did not complete. These files are NOT the originals:" >&2
      for m in $mixed; do echo "      $m" >&2; done
      echo "      Restore them from $BACKUP_DIR by hand. DO NOT touch tmp/restart.txt:" >&2
      echo "      an un-activated mixed set is still recoverable; an activated one is an outage." >&2
      exit 7
    fi
    echo "Rolled back: every file is the original again, and the new content is staged as <file>.new." >&2
    echo "Nothing was activated - DO NOT touch tmp/restart.txt. Fix the cause and re-run." >&2
    exit 6
  fi
done

echo "backup: $BACKUP_DIR"
echo "NOTE: activation is separate - touch <app-root>/tmp/restart.txt and confirm new worker start"
echo "      times with ps. A health 200 does not prove the new code is loaded."
