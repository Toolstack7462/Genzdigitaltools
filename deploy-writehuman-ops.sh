#!/usr/bin/env bash
# BACKEND deploy: WriteHuman ops pack (health alerts + token-age/health rollup + scheduler cadence
# fix + JWT-helper exports). Backend-only. The frontend (health chip + token age) and the RDP agent
# (timeout bump) deploy separately.
#
# Ships together (healthAlerts.js is NEW and is require()d by verifyAndApply + the scheduler, so it
# MUST land with them or Passenger boots into "module not found"):
#   utils/proxy/verify.js          (export jwtExp + extractSupabaseSession for token-age)
#   utils/proxy/verifyAndApply.js  (fire health-alert on transitions)
#   utils/proxy/healthAlerts.js    (NEW: email alerts, debounced)
#   routes/admin/proxyTools.js     (aggregator: health rollup + accessTokenExpiresInSec)
#   cron/proxyVerifyScheduler.js   (stale-gate cadence fix + agent-stale alert)
#
# Safe/additive. Alerts are OFF unless PROXY_ALERT_EMAIL is set. Token exp is decoded server-side
# only (never returned). Other tools unchanged.
#
# Run in YOUR OWN terminal:  SFTP_PASS='...' bash deploy-writehuman-ops.sh
set -euo pipefail

HOST=147.79.103.253; PORT=65002; USER=u171982351
API_ROOT="/home/${USER}/domains/api.genzdigitalstore.com/nodejs"
API_BASE="https://api.genzdigitalstore.com"

if [[ -z "${SFTP_PASS:-}" ]]; then echo "ERROR: set SFTP_PASS first." >&2; exit 1; fi
cd "$(dirname "$0")"

echo "==> Pre-flight: node --check"
for f in backend/utils/proxy/verify.js backend/utils/proxy/verifyAndApply.js backend/utils/proxy/healthAlerts.js \
         backend/routes/admin/proxyTools.js backend/cron/proxyVerifyScheduler.js; do node --check "$f"; done
echo "    OK"

echo "==> Refreshing known_hosts (RSA only) for [${HOST}]:${PORT}"
ssh-keygen -R "[${HOST}]:${PORT}" >/dev/null 2>&1 || true
ssh-keyscan -t rsa -p "${PORT}" "${HOST}" >> ~/.ssh/known_hosts 2>/dev/null

RESTART_TMP="$(mktemp)"; date -u +"restart %Y-%m-%dT%H:%M:%SZ" > "${RESTART_TMP}"
echo "==> [1/2] Uploading + restart"
curl --fail-with-body --ftp-create-dirs -u "${USER}:${SFTP_PASS}" \
  -T backend/utils/proxy/verify.js         "sftp://${HOST}:${PORT}${API_ROOT}/utils/proxy/verify.js" \
  -T backend/utils/proxy/verifyAndApply.js "sftp://${HOST}:${PORT}${API_ROOT}/utils/proxy/verifyAndApply.js" \
  -T backend/utils/proxy/healthAlerts.js   "sftp://${HOST}:${PORT}${API_ROOT}/utils/proxy/healthAlerts.js" \
  -T backend/routes/admin/proxyTools.js    "sftp://${HOST}:${PORT}${API_ROOT}/routes/admin/proxyTools.js" \
  -T backend/cron/proxyVerifyScheduler.js  "sftp://${HOST}:${PORT}${API_ROOT}/cron/proxyVerifyScheduler.js" \
  -T "${RESTART_TMP}"                        "sftp://${HOST}:${PORT}${API_ROOT}/tmp/restart.txt"
rm -f "${RESTART_TMP}"
echo "    upload complete; restart triggered."

echo "==> [2/2] Verify boot + gated surfaces"
BOOT=0
for i in 1 2 3 4 5 6; do
  sleep 5
  B="$(curl -s -X POST "${API_BASE}/api/crm/extension/security-scan" -H 'Content-Type: application/json' -d '{}' || true)"
  echo "  attempt ${i}: $(echo "$B" | grep -oE 'extension_token_invalid|error' | head -1)"
  echo "$B" | grep -q extension_token_invalid && { BOOT=1; break; }
done
[[ "${BOOT}" == "1" ]] || { echo "==> FAIL: backend did not come back. Tail nodejs/stderr.log NOW." >&2; exit 1; }
PT=$(curl -s -o /dev/null -w '%{http_code}' "${API_BASE}/api/crm/admin/proxy-tools/writehuman/agent-state" || true)
ING=$(curl -s -o /dev/null -w '%{http_code}' -X POST "${API_BASE}/api/crm/proxy/agent/writehuman/cookies" -H 'Content-Type: application/json' -d '{}' || true)
echo "  agent-state (no auth) -> ${PT} (expect 401) | agent ingest (no key) -> ${ING} (expect 403)"
[[ "${PT}" == "401" && "${ING}" == "403" ]] && { echo "==> SUCCESS: ops pack live; existing tools intact."; exit 0; }
echo "==> WARNING: unexpected codes." >&2; exit 1
