#!/bin/sh
# Validate-then-promote for a hand-deployed backend patch set.
#
# WHY THIS EXISTS. The 2026-10-21 CRM backend deploy ran, per uploaded file:
#
#     base64 -d > "$f.new" && mv "$f.new" "$f" && node -c "$f" && echo ok
#
# The promotion (`mv`) happened BEFORE the syntax check, and `node` is not on the remote
# non-interactive PATH, so every check failed with "node: command not found" while the files were
# already live. A broken file would have been promoted and the failure only reported afterwards.
#
# This script inverts that order and makes a missing runtime fatal:
#   1. refuse to start unless a usable node is resolved from the APPLICATION'S configuration;
#   2. syntax-check every staged "<file>.new";
#   3. only if ALL checks pass, back up and promote them;
#   4. exit non-zero on any failure, having promoted nothing.
#
# Node is resolved from PassengerNodejs in the serving .htaccess - the interpreter the app actually
# runs - never a guessed path. Override with CRM_DEPLOY_NODE when testing.
#
#   Usage:  crm-deploy-promote.sh <app-root> <backup-dir> <relative-file> [more files...]
#   Each <relative-file> must already exist as <app-root>/<relative-file>.new
#
# Exit: 0 all promoted · 2 no usable node · 3 a staged file is missing · 4 a syntax check failed.

set -eu

APP_ROOT="${1:?app root required}"; shift
BACKUP_DIR="${1:?backup dir required}"; shift
[ "$#" -gt 0 ] || { echo "no files given" >&2; exit 3; }

HTACCESS="${CRM_DEPLOY_HTACCESS:-/home/u171982351/domains/api.genzdigitalstore.com/public_html/.htaccess}"

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

# ---- 1. every staged file must exist -------------------------------------------------------
for rel in "$@"; do
  [ -f "$rel.new" ] || { echo "REFUSING TO PROMOTE: staged file missing: $rel.new" >&2; exit 3; }
done

# ---- 2. syntax-check them all BEFORE anything is replaced ----------------------------------
failed=0
for rel in "$@"; do
  # `node --check` refuses an unknown extension outright (ERR_UNKNOWN_FILE_EXTENSION), so a
  # "<file>.new" is rejected for its NAME before its syntax is ever parsed - which would make
  # every check "fail" and, worse, make a check that merely looks at exit status meaningless.
  # Check a copy that keeps the real extension instead.
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

# ---- 3. back up, then promote ---------------------------------------------------------------
for rel in "$@"; do
  if [ -f "$rel" ]; then
    mkdir -p "$BACKUP_DIR/$(dirname "$rel")"
    cp -p "$rel" "$BACKUP_DIR/$rel"
  fi
done
for rel in "$@"; do
  mv "$rel.new" "$rel"
  echo "  promoted   $rel"
done

echo "backup: $BACKUP_DIR"
echo "NOTE: activation is separate - touch <app-root>/tmp/restart.txt and confirm new worker start"
echo "      times with ps. A health 200 does not prove the new code is loaded."
