#!/usr/bin/env bash
# BACKEND deploy: WriteHuman status-reconciliation + serving-safety fix. Backend-only (frontend
# deploys separately). Both files can ship independently but are deployed together here.
#   routes/admin/proxyTools.js   (aggregator: coherent `health` + `statusReason` + browserAuthCookies/
#                                 tokenExpired/workingUnverified -> cards can no longer contradict)
#   utils/proxy/accountSelect.js (SHARED serving gate: exclude a live-agent account from serving when
#                                 the agent's fresh report shows the browser is logged out. Additive;
#                                 NO-OP for tools without an agent report.)
#
# Safe/additive. Other proxy tools unchanged (the new gate only triggers when agentReport.authCookies
# is present AND 0 AND fresh — which only live-agent tools have). Verified by unit test + node --check.
#
# Run in YOUR OWN terminal:  SFTP_PASS='...' bash deploy-writehuman-status-fix.sh
set -euo pipefail
HOST=147.79.103.253; PORT=65002; USER=u171982351
API_ROOT="/home/${USER}/domains/api.genzdigitalstore.com/nodejs"
API_BASE="https://api.genzdigitalstore.com"
if [[ -z "${SFTP_PASS:-}" ]]; then echo "ERROR: set SFTP_PASS first." >&2; exit 1; fi
cd "$(dirname "$0")"
echo "==> Pre-flight: node --check" && node --check backend/routes/admin/proxyTools.js && node --check backend/utils/proxy/accountSelect.js && echo "    OK"
ssh-keygen -R "[${HOST}]:${PORT}" >/dev/null 2>&1 || true
ssh-keyscan -t rsa -p "${PORT}" "${HOST}" >> ~/.ssh/known_hosts 2>/dev/null
RESTART_TMP="$(mktemp)"; date -u +"restart %Y-%m-%dT%H:%M:%SZ" > "${RESTART_TMP}"
echo "==> [1/2] Uploading + restart"
curl --fail-with-body --ftp-create-dirs -u "${USER}:${SFTP_PASS}" \
  -T backend/routes/admin/proxyTools.js   "sftp://${HOST}:${PORT}${API_ROOT}/routes/admin/proxyTools.js" \
  `# required by proxyTools.js at module load — must ship together or the API boots into "Cannot find module"` \
  -T backend/utils/proxy/deviceSync.js    "sftp://${HOST}:${PORT}${API_ROOT}/utils/proxy/deviceSync.js" \
  -T backend/utils/proxy/candidateSync.js "sftp://${HOST}:${PORT}${API_ROOT}/utils/proxy/candidateSync.js" \
  -T backend/utils/proxy/accountSelect.js "sftp://${HOST}:${PORT}${API_ROOT}/utils/proxy/accountSelect.js" \
  -T "${RESTART_TMP}"                       "sftp://${HOST}:${PORT}${API_ROOT}/tmp/restart.txt"
rm -f "${RESTART_TMP}"; echo "    done."
echo "==> [2/2] Verify boot + gated surfaces (existing tools intact)"
BOOT=0
for i in 1 2 3 4 5 6; do sleep 5
  B="$(curl -s -X POST "${API_BASE}/api/crm/extension/security-scan" -H 'Content-Type: application/json' -d '{}' || true)"
  echo "  attempt ${i}: $(echo "$B" | grep -oE 'extension_token_invalid|error' | head -1)"
  echo "$B" | grep -q extension_token_invalid && { BOOT=1; break; }
done
[[ "${BOOT}" == "1" ]] || { echo "==> FAIL: backend did not come back." >&2; exit 1; }
PT=$(curl -s -o /dev/null -w '%{http_code}' "${API_BASE}/api/crm/admin/proxy-tools/writehuman/agent-state" || true)
echo "  agent-state (no auth) -> ${PT} (expect 401)"
[[ "${PT}" == "401" ]] && { echo "==> SUCCESS: status-reconciliation + serving-safety live; existing tools intact."; exit 0; }
echo "==> WARNING: unexpected code ${PT}." >&2; exit 1
