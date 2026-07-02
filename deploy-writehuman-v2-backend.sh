#!/usr/bin/env bash
# BACKEND-ONLY, DORMANT-FIRST deploy of the WriteHuman V2 Admin Dashboard integration.
#
# Ships ONLY the two backend files the integration adds/edits, plus the Passenger
# restart trigger — nothing else on the server changes:
#   - routes/admin/writehumanV2.js   (NEW isolated admin route; server-crm now require()s it)
#   - server-crm.js                  (one require + one app.use mount)
#
# WHY a dedicated script: server-crm.js require()s the new route file, so the file MUST
# land in the SAME upload as server-crm.js or Passenger boots into "module not found" and
# takes the whole CRM API down. This script guarantees they ship together.
#
# WHY dormant-first: with WRITEHUMAN_V2_ADMIN_KEY unset on the server, every new route
# returns 503 (v2_not_configured). So this deploy is a no-op for every existing tool — it
# only proves the backend still boots cleanly with the new code mounted. You flip the
# feature on later by setting the env vars (see the end of this script).
#
# Run it in YOUR OWN terminal so the password never lands in a shared transcript:
#   SFTP_PASS='your-sftp-password' bash deploy-writehuman-v2-backend.sh
set -euo pipefail

HOST=147.79.103.253
PORT=65002
USER=u171982351
API_ROOT="/home/${USER}/domains/api.genzdigitalstore.com/nodejs"
API_BASE="https://api.genzdigitalstore.com"

if [[ -z "${SFTP_PASS:-}" ]]; then
  echo "ERROR: set SFTP_PASS first, e.g.  SFTP_PASS='...' bash deploy-writehuman-v2-backend.sh" >&2
  exit 1
fi
cd "$(dirname "$0")"

# Pre-flight: both files must parse locally before we ship them (catches a bad edit).
if command -v node >/dev/null 2>&1; then
  echo "==> Pre-flight: node --check both files"
  node --check backend/routes/admin/writehumanV2.js
  node --check backend/server-crm.js
  echo "    OK"
fi

# known_hosts: libssh2 (curl) can only use an RSA host key.
echo "==> Refreshing known_hosts (RSA only) for [${HOST}]:${PORT}"
ssh-keygen -R "[${HOST}]:${PORT}" >/dev/null 2>&1 || true
ssh-keyscan -t rsa -p "${PORT}" "${HOST}" >> ~/.ssh/known_hosts 2>/dev/null

# Upload the new route FIRST, server-crm SECOND, restart trigger LAST — one curl call so
# they are atomic from Passenger's perspective (it only reloads on the next request after
# restart.txt's mtime bumps).
RESTART_TMP="$(mktemp)"
date -u +"restart %Y-%m-%dT%H:%M:%SZ" > "${RESTART_TMP}"

echo "==> [1/3] Uploading writehumanV2.js + server-crm.js + restart trigger"
curl --fail-with-body --ftp-create-dirs \
  -u "${USER}:${SFTP_PASS}" \
  -T backend/routes/admin/writehumanV2.js "sftp://${HOST}:${PORT}${API_ROOT}/routes/admin/writehumanV2.js" \
  -T backend/server-crm.js                "sftp://${HOST}:${PORT}${API_ROOT}/server-crm.js" \
  -T "${RESTART_TMP}"                      "sftp://${HOST}:${PORT}${API_ROOT}/tmp/restart.txt"
rm -f "${RESTART_TMP}"
echo "    upload complete; Passenger restart triggered."

# [2/3] Confirm the backend BOOTED with the new code (existing tools intact). An
# authenticated extension route with no token returns extension_token_invalid; 000 = mid
# restart, retry.
echo "==> [2/3] Verifying backend booted (existing routes intact)..."
BOOT_OK=0
for i in 1 2 3 4 5 6; do
  sleep 5
  BODY="$(curl -s -X POST "${API_BASE}/api/crm/extension/security-scan" \
    -H 'Content-Type: application/json' -d '{}' || true)"
  echo "  attempt ${i}: ${BODY}"
  if echo "${BODY}" | grep -q 'extension_token_invalid'; then BOOT_OK=1; break; fi
done
if [[ "${BOOT_OK}" != "1" ]]; then
  echo "==> FAIL: backend did not come back with the expected response. Tail nodejs/stderr.log NOW." >&2
  echo "    (Existing server-crm.js was overwritten — if this persists, re-upload the previous server-crm.js.)" >&2
  exit 1
fi
echo "    backend is live and serving existing routes."

# [3/3] Confirm the new route is MOUNTED and SAFELY DORMANT. Unauthenticated (no admin
# cookie) it must be rejected by requireAuth — proving the auth gate is active, not open.
# It must NOT 404 (that would mean the mount/route file failed to load).
echo "==> [3/3] Verifying the new /writehuman-v2 route is mounted + auth-gated..."
CODE="$(curl -s -o /dev/null -w '%{http_code}' "${API_BASE}/api/crm/admin/writehuman-v2/state" || true)"
echo "  GET /api/crm/admin/writehuman-v2/state (no auth) -> HTTP ${CODE}"
case "${CODE}" in
  401|403)
    echo "==> SUCCESS: route mounted, auth gate active, feature dormant (needs admin login + env key)."
    echo ""
    echo "    Existing tools: UNCHANGED. Nothing is live for WriteHuman V2 yet."
    echo ""
    echo "    NEXT — activate when ready (turns the dashboard section on):"
    echo "      1) In the api Node app env (hPanel > Node.js app, or ${API_ROOT}/.env), set:"
    echo "           WRITEHUMAN_V2_ADMIN_KEY=<the SAME key writehuman2's service uses>"
    echo "           WRITEHUMAN_V2_URL=https://writehuman2.genzdigitalstore.com   (optional; this is the default)"
    echo "      2) Restart the app (bump ${API_ROOT}/tmp/restart.txt or use hPanel Restart)."
    echo "      3) Then deploy the frontend:  SFTP_PASS='...' bash deploy-frontend-only.sh"
    exit 0
    ;;
  404)
    echo "==> FAIL: route 404 — the mount or route file did not load. Check server-crm.js + writehumanV2.js on the server." >&2
    exit 1
    ;;
  *)
    echo "==> WARNING: unexpected HTTP ${CODE}. If the env key is already set this may be 200/503; otherwise investigate." >&2
    exit 1
    ;;
esac
