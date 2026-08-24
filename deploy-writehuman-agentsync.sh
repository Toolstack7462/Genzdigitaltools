#!/usr/bin/env bash
# BACKEND deploy: agentSync.js (honor the reverify `force` flag so "Re-sync" truly re-verifies;
# surface lastCommand/lastCommandAt in the agent telemetry). Backend-only, single file, additive.
# The file already exists on the server (server-crm require()s it) — this just updates it.
#
# Run in YOUR OWN terminal:  SFTP_PASS='...' bash deploy-writehuman-agentsync.sh
set -euo pipefail
HOST=147.79.103.253; PORT=65002; USER=u171982351
API_ROOT="/home/${USER}/domains/api.genzdigitalstore.com/nodejs"
API_BASE="https://api.genzdigitalstore.com"
if [[ -z "${SFTP_PASS:-}" ]]; then echo "ERROR: set SFTP_PASS first." >&2; exit 1; fi
cd "$(dirname "$0")"
node --check backend/routes/proxy/agentSync.js && echo "pre-flight node --check OK"
ssh-keygen -R "[${HOST}]:${PORT}" >/dev/null 2>&1 || true
ssh-keyscan -t rsa -p "${PORT}" "${HOST}" >> ~/.ssh/known_hosts 2>/dev/null
T="$(mktemp)"; date -u +"restart %Y-%m-%dT%H:%M:%SZ" > "$T"
echo "==> Uploading agentSync.js (+ its multi-device modules) + restart"
# agentSync.js require()s deviceSync.js and candidateSync.js at module load. Shipping the route
# WITHOUT them boots Passenger into "Cannot find module" and takes the whole API down, so they
# travel together — re-uploading a module the server already has is a harmless no-op.
curl --fail-with-body --ftp-create-dirs -u "${USER}:${SFTP_PASS}" \
  -T backend/routes/proxy/agentSync.js "sftp://${HOST}:${PORT}${API_ROOT}/routes/proxy/agentSync.js" \
  -T backend/utils/proxy/deviceSync.js "sftp://${HOST}:${PORT}${API_ROOT}/utils/proxy/deviceSync.js" \
  -T backend/utils/proxy/candidateSync.js "sftp://${HOST}:${PORT}${API_ROOT}/utils/proxy/candidateSync.js" \
  -T "$T" "sftp://${HOST}:${PORT}${API_ROOT}/tmp/restart.txt"
rm -f "$T"; echo "    done."
echo "==> Verify boot + ingest still gated"
BOOT=0
for i in 1 2 3 4 5 6; do sleep 5
  B="$(curl -s -X POST "${API_BASE}/api/crm/extension/security-scan" -H 'Content-Type: application/json' -d '{}' || true)"
  echo "  attempt ${i}: $(echo "$B" | grep -oE 'extension_token_invalid|error' | head -1)"
  echo "$B" | grep -q extension_token_invalid && { BOOT=1; break; }
done
[[ "${BOOT}" == "1" ]] || { echo "==> FAIL: backend did not come back." >&2; exit 1; }
ING=$(curl -s -o /dev/null -w '%{http_code}' -X POST "${API_BASE}/api/crm/proxy/agent/writehuman/cookies" -H 'Content-Type: application/json' -d '{}' || true)
echo "  agent ingest (no key) -> ${ING} (expect 403)"
[[ "${ING}" == "403" ]] && echo "==> SUCCESS: agentSync live; ingest gated; existing tools intact." || { echo "==> WARNING: unexpected ${ING}." >&2; exit 1; }
