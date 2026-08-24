#!/usr/bin/env bash
# ATOMIC WriteHuman backend rollout — ships the COMPLETE require() closure, not a hand-picked subset.
#
# WHY THIS EXISTS INSTEAD OF ANOTHER ONE-OFF SCRIPT.
# Every per-feature script in this repo carries a hand-written file list, and the audit that
# preceded this rollout found EIGHT of them that would ship a route without a module it requires —
# booting Passenger into "Cannot find module" and taking the whole API down, login and every tool
# with it. The incremental model also assumes the server already holds a known-good tree. For this
# rollout that assumption cannot be checked: the production file inventory was not available, so
# "what the server already has" is a guess, and an incremental deploy on a guess is how the last
# outage happened.
#
# So this ships the transitive closure of `require()` from server-crm.js, COMPUTED FROM THE CODE at
# run time (backend/scripts/backend-closure.js). Nothing to maintain, nothing to forget: add a
# require and the file it points at is shipped by construction. The result does not depend on the
# server's prior state, which is what makes it safe to run against an unknown baseline.
#
# Excluded: node_modules (installed server-side, never shipped), tests, and .env — see the guards.
#
# Run in YOUR OWN terminal:  SFTP_PASS='...' bash deploy-writehuman-full.sh
# Dry run (no upload):       DRY_RUN=1 bash deploy-writehuman-full.sh
set -euo pipefail

HOST=147.79.103.253; PORT=65002; USER=u171982351
# EMERGENCY PATH ONLY - READ THIS BEFORE USING.
#
# Passenger does NOT serve `domains/api.genzdigitalstore.com/nodejs`. Verified on the server
# 2026-08-24: the app root holds a `DO_NOT_UPLOAD_HERE` marker, and the running worker is
#   lsnode:/home/u171982351/domains/api.genzdigitalstore.com/hbuilds/current/...
# where `hbuilds/current` is a symlink to `versions/<build-uuid>/`. Uploading to `nodejs/` is a
# SILENT NO-OP: the transfer succeeds, the restart succeeds, and nothing changes. This script
# originally targeted exactly that dead path.
#
# The REAL deploy is Hostinger's build pipeline, which rebuilds `versions/<uuid>` from source and
# re-points the symlink. Production was byte-identical to origin/main across all 213 backend files
# when checked, so the pipeline is the source of truth and the normal way to ship is to merge to
# main and let it deploy.
#
# Writing into the live version directory (what this script now does) takes effect immediately but
# is TRANSIENT: the next pipeline run replaces that directory and silently reverts it, leaving
# production and git disagreeing. Use this only to restore service in an emergency, and follow it
# with a proper deploy through the pipeline.
API_ROOT="/home/${USER}/domains/api.genzdigitalstore.com/hbuilds/current/nodejs"
API_BASE="https://api.genzdigitalstore.com"
DRY_RUN="${DRY_RUN:-0}"

cd "$(dirname "$0")"
[[ "${DRY_RUN}" == "1" || -n "${SFTP_PASS:-}" ]] || { echo "ERROR: set SFTP_PASS first (or DRY_RUN=1)." >&2; exit 1; }

echo "==> [1/6] Computing the backend require() closure"
mapfile -t FILES < <(node backend/scripts/backend-closure.js)
COUNT="${#FILES[@]}"
[[ "${COUNT}" -ge 50 ]] || { echo "ERROR: closure looks wrong (${COUNT} files). Refusing to deploy." >&2; exit 1; }
echo "    ${COUNT} files"

echo "==> [2/6] Guards: nothing dangerous may be in the manifest"
for f in "${FILES[@]}"; do
  case "$f" in
    *.test.js)  echo "ERROR: a test file is in the closure: $f" >&2; exit 1 ;;
    .env|*/.env|*/.env.*) echo "ERROR: an env file is in the closure: $f" >&2; exit 1 ;;
    node_modules/*) echo "ERROR: node_modules in the closure: $f" >&2; exit 1 ;;
  esac
  [[ -f "backend/$f" ]] || { echo "ERROR: missing file in closure: backend/$f" >&2; exit 1; }
done
echo "    OK"

echo "==> [3/6] Pre-flight: node --check + clean-tree check"
for f in "${FILES[@]}"; do node --check "backend/$f" >/dev/null; done
echo "    OK (${COUNT} files parse)"

# A full-closure deploy uploads the WORKING TREE, not the commit. This repo's tree routinely carries
# unrelated in-progress edits from other work (mysqlAdapter.js did during this very rollout), and an
# atomic deploy would push them to production silently, under a WriteHuman change's name. Refuse.
DIRTY=""
for f in "${FILES[@]}"; do
  if ! git diff --quiet HEAD -- "backend/$f" 2>/dev/null; then DIRTY="${DIRTY}  backend/${f}"$'\n'; fi
done
if [[ -n "${DIRTY}" ]]; then
  echo "ERROR: these files in the deploy closure differ from HEAD:" >&2
  printf '%s' "${DIRTY}" >&2
  echo "Commit them, stash them, or check them out. An atomic deploy must ship a reviewed commit," >&2
  echo "not whatever happens to be in the working tree. Override with ALLOW_DIRTY=1 only if you are" >&2
  echo "certain every change above is intended for production." >&2
  [[ "${ALLOW_DIRTY:-0}" == "1" ]] || exit 1
  echo "    ALLOW_DIRTY=1 set — continuing anyway." >&2
fi
echo "    tree matches HEAD ($(git rev-parse --short HEAD))"

if [[ "${DRY_RUN}" == "1" ]]; then
  echo "==> DRY RUN: would upload ${COUNT} files to ${API_ROOT}"
  printf '    %s\n' "${FILES[@]}" | head -20
  echo "    ... ($((COUNT - 20)) more)"
  exit 0
fi

echo "==> [4/6] Refreshing known_hosts (RSA only) for [${HOST}]:${PORT}"
# This curl/libssh2 build cannot use ed25519 or ecdsa host keys — RSA only.
ssh-keygen -R "[${HOST}]:${PORT}" >/dev/null 2>&1 || true
ssh-keyscan -t rsa -p "${PORT}" "${HOST}" >> ~/.ssh/known_hosts 2>/dev/null

RESTART_TMP="$(mktemp)"; date -u +"restart %Y-%m-%dT%H:%M:%SZ" > "${RESTART_TMP}"

echo "==> [5/6] Uploading ${COUNT} files + restart trigger in ONE connection"
# One curl invocation with many -T pairs: per-file invocations get throttled/timed out by this host.
ARGS=()
for f in "${FILES[@]}"; do
  ARGS+=(-T "backend/${f}" "sftp://${HOST}:${PORT}${API_ROOT}/${f}")
done
ARGS+=(-T "${RESTART_TMP}" "sftp://${HOST}:${PORT}${API_ROOT}/tmp/restart.txt")
curl --fail-with-body --ftp-create-dirs -u "${USER}:${SFTP_PASS}" "${ARGS[@]}"
rm -f "${RESTART_TMP}"
echo "    upload complete; Passenger restart triggered."

echo "==> [6/6] Verifying boot, existing tools, and WriteHuman ingest state"
BOOT=0
for i in 1 2 3 4 5 6 7 8; do
  sleep 5
  CODE="$(curl -s -o /dev/null -w '%{http_code}' "${API_BASE}/api/crm/health" || true)"
  echo "  attempt ${i}: /api/crm/health -> ${CODE}"
  [[ "${CODE}" == "200" ]] && { BOOT=1; break; }
done
[[ "${BOOT}" == "1" ]] || { echo "==> FAIL: backend did not come back. Tail nodejs/stderr.log NOW." >&2; exit 1; }

PT=$(curl -s -o /dev/null -w '%{http_code}' "${API_BASE}/api/crm/admin/proxy-tools/writehuman/agent-state" || true)
ING=$(curl -s -o /dev/null -w '%{http_code}' -X POST "${API_BASE}/api/crm/proxy/agent/writehuman/cookies" -H 'Content-Type: application/json' -d '{}' || true)
UNK=$(curl -s -o /dev/null -w '%{http_code}' -X POST "${API_BASE}/api/crm/proxy/agent/__nope__/cookies" -H 'Content-Type: application/json' -d '{}' || true)
# Existing tools must be untouched by a WriteHuman rollout.
STE=$(curl -s -o /dev/null -w '%{http_code}' "${API_BASE}/api/crm/admin/stealth/accounts" || true)
HIX=$(curl -s -o /dev/null -w '%{http_code}' "${API_BASE}/api/crm/admin/proxy-tools/hix/agent-state" || true)

echo "  admin writehuman/agent-state (no auth) -> ${PT}   (expect 401)"
echo "  POST writehuman/cookies (no device)    -> ${ING}  (expect 503 unpaired, or 403 once paired)"
echo "  POST __nope__/cookies                  -> ${UNK}  (expect 404, tool-scoped)"
echo "  admin stealth/accounts (no auth)       -> ${STE}  (expect 401, unaffected)"
echo "  admin hix/agent-state  (no auth)       -> ${HIX}  (expect 401, unaffected)"

if [[ "${PT}" == "401" && ( "${ING}" == "503" || "${ING}" == "403" ) && "${UNK}" == "404" && "${STE}" == "401" && "${HIX}" == "401" ]]; then
  echo "==> SUCCESS: WriteHuman backend live, ingest fails closed, other tools intact."
  exit 0
fi
echo "==> WARNING: unexpected codes. Investigate BEFORE pairing any device." >&2
exit 1
