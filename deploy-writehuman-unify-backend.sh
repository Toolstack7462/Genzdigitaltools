#!/usr/bin/env bash
# BACKEND deploy for the WriteHuman -> MySQL vault unification (Phase 1), dormant-first.
#
# Ships the changed proxy backend files together (the two NEW files MUST land with server-crm.js
# or Passenger boots into "module not found"):
#   utils/proxy/cookies.js      (auth-cookie helpers)
#   utils/proxy/verify.js       (opt-in readOnly mode)
#   utils/proxy/applySession.js (NEW shared vault-write path)
#   routes/admin/proxyTools.js  (shared helper + dashboard aggregator)
#   routes/proxy/agentSync.js   (NEW agent ingest; server-crm require()s it)
#   server-crm.js               (mounts /api/crm/proxy/agent)
#
# DORMANT: the agent ingest returns 503 until PROXY_AGENT_SYNC_KEY is set on the server, so this
# deploy is a no-op for every existing tool. The admin session-refresh path is a verbatim
# extraction (unchanged behavior). Old /api/crm/admin/writehuman-v2 routes stay in place, so the
# currently-live dashboard keeps working until the new frontend ships.
#
# Run in YOUR OWN terminal:  SFTP_PASS='...' bash deploy-writehuman-unify-backend.sh
set -euo pipefail

HOST=147.79.103.253; PORT=65002; USER=u171982351
API_ROOT="/home/${USER}/domains/api.genzdigitalstore.com/nodejs"
API_BASE="https://api.genzdigitalstore.com"

if [[ -z "${SFTP_PASS:-}" ]]; then echo "ERROR: set SFTP_PASS first." >&2; exit 1; fi
cd "$(dirname "$0")"

echo "==> Pre-flight: node --check every file"
for f in backend/utils/proxy/cookies.js backend/utils/proxy/verify.js backend/utils/proxy/applySession.js \
         backend/routes/admin/proxyTools.js backend/routes/proxy/agentSync.js backend/server-crm.js; do
  node --check "$f"
done
echo "    OK"

echo "==> Refreshing known_hosts (RSA only) for [${HOST}]:${PORT}"
ssh-keygen -R "[${HOST}]:${PORT}" >/dev/null 2>&1 || true
ssh-keyscan -t rsa -p "${PORT}" "${HOST}" >> ~/.ssh/known_hosts 2>/dev/null

RESTART_TMP="$(mktemp)"; date -u +"restart %Y-%m-%dT%H:%M:%SZ" > "${RESTART_TMP}"
echo "==> [1/3] Uploading changed backend files + restart trigger (one connection)"
curl --fail-with-body --ftp-create-dirs -u "${USER}:${SFTP_PASS}" \
  -T backend/utils/proxy/cookies.js      "sftp://${HOST}:${PORT}${API_ROOT}/utils/proxy/cookies.js" \
  -T backend/utils/proxy/verify.js       "sftp://${HOST}:${PORT}${API_ROOT}/utils/proxy/verify.js" \
  -T backend/utils/proxy/applySession.js "sftp://${HOST}:${PORT}${API_ROOT}/utils/proxy/applySession.js" \
  -T backend/routes/admin/proxyTools.js  "sftp://${HOST}:${PORT}${API_ROOT}/routes/admin/proxyTools.js" \
  -T backend/routes/proxy/agentSync.js   "sftp://${HOST}:${PORT}${API_ROOT}/routes/proxy/agentSync.js" \
  `# Both routes above require these at module load; shipping the routes without them boots` \
  `# Passenger into "Cannot find module" and takes the whole API down.` \
  -T backend/utils/proxy/deviceSync.js    "sftp://${HOST}:${PORT}${API_ROOT}/utils/proxy/deviceSync.js" \
  -T backend/utils/proxy/candidateSync.js "sftp://${HOST}:${PORT}${API_ROOT}/utils/proxy/candidateSync.js" \
  -T backend/utils/proxy/agentEnroll.js    "sftp://${HOST}:${PORT}${API_ROOT}/utils/proxy/agentEnroll.js" \
  -T backend/routes/proxy/agentDownload.js "sftp://${HOST}:${PORT}${API_ROOT}/routes/proxy/agentDownload.js" \
  -T backend/server-crm.js               "sftp://${HOST}:${PORT}${API_ROOT}/server-crm.js" \
  -T "${RESTART_TMP}"                     "sftp://${HOST}:${PORT}${API_ROOT}/tmp/restart.txt"
rm -f "${RESTART_TMP}"
echo "    upload complete; Passenger restart triggered."

echo "==> [2/3] Verifying backend booted + existing routes intact"
BOOT=0
for i in 1 2 3 4 5 6; do
  sleep 5
  BODY="$(curl -s -X POST "${API_BASE}/api/crm/extension/security-scan" -H 'Content-Type: application/json' -d '{}' || true)"
  echo "  attempt ${i}: ${BODY}"
  echo "${BODY}" | grep -q 'extension_token_invalid' && { BOOT=1; break; }
done
[[ "${BOOT}" == "1" ]] || { echo "==> FAIL: backend did not come back. Tail nodejs/stderr.log NOW." >&2; exit 1; }
PT=$(curl -s -o /dev/null -w '%{http_code}' "${API_BASE}/api/crm/admin/proxy-tools/writehuman/agent-state" || true)
echo "  admin proxy-tools writehuman/agent-state (no auth) -> HTTP ${PT} (expect 401)"

echo "==> [3/3] Verifying the agent ingest is MOUNTED and DORMANT (503 until key set)"
DORMANT=$(curl -s -o /dev/null -w '%{http_code}' -X POST "${API_BASE}/api/crm/proxy/agent/writehuman/cookies" -H 'Content-Type: application/json' -d '{}' || true)
UNKNOWN=$(curl -s -o /dev/null -w '%{http_code}' -X POST "${API_BASE}/api/crm/proxy/agent/__nope__/cookies" -H 'Content-Type: application/json' -d '{}' || true)
echo "  POST /proxy/agent/writehuman/cookies (no key) -> HTTP ${DORMANT} (expect 503 = mounted+dormant)"
echo "  POST /proxy/agent/__nope__/cookies           -> HTTP ${UNKNOWN} (expect 404 = tool-scoped)"
if [[ "${DORMANT}" == "503" && "${PT}" == "401" ]]; then
  echo "==> SUCCESS: unify backend live. Agent ingest dormant, admin aggregator gated, existing tools intact."
  echo "    Activate (Phase 2) when ready: set PROXY_AGENT_SYNC_KEY on the api app + repoint the RDP agent."
  exit 0
fi
echo "==> WARNING: unexpected codes (agent=${DORMANT}, proxy-tools=${PT}). Investigate before activating." >&2
exit 1
