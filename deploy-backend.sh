#!/usr/bin/env bash
# Reliable backend deploy: VERIFIED per-file uploads + restart + boot check.
# Replaces the ad-hoc per-feature scripts that used flaky multi-file curl transfers.
#
# Usage:  SFTP_PASS=... bash deploy-backend.sh backend/utils/email.js [backend/routes/admin/renewals.js ...]
#   - Each arg is a repo-relative path under backend/. It maps to <API_ROOT>/<path-without-backend/>.
#   - Every .js is syntax-checked, uploaded ONE at a time, and SHA-256 verified on the server.
#   - Only after ALL files land is the app restarted; then we wait for it to boot.
#   - Any failure aborts LOUDLY (no false success, and no restart on a partial upload).
set -euo pipefail
cd "$(dirname "$0")"
source ./deploy-lib.sh

[[ $# -ge 1 ]] || { echo "usage: deploy-backend.sh <backend/rel/path.js> [more...]"; exit 1; }

sftp_prep
echo "== syntax check =="
for f in "$@"; do
  [[ -f "$f" ]] || { echo "FATAL: not found: $f"; exit 1; }
  case "$f" in backend/*) : ;; *) echo "FATAL: expected a path under backend/: $f"; exit 1;; esac
  if [[ "$f" == *.js ]]; then node --check "$f" && echo "  ✓ $f"; fi
done

echo "== upload (one file per transfer, verified) =="
for f in "$@"; do
  remote="${API_ROOT}/${f#backend/}"
  put_verified "$f" "$remote"
done

echo "== restart + boot =="
bump_restart
wait_boot
echo "SUCCESS: ${#} file(s) deployed + verified + app booted."
