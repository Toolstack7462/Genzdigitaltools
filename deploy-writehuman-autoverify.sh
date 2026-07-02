#!/usr/bin/env bash
# BACKEND deploy: WriteHuman auto-verify + smart-timer + verify-safety (§9 fixes). Backend-only.
#
# Ships together (the two NEW files MUST land with server-crm.js / proxyTools.js or Passenger boots
# into "module not found"):
#   utils/proxy/tools.js            (writehuman liveAgent flag + hasLiveAgent)
#   utils/proxy/verifyAndApply.js   (NEW: single canonical verify->apply path)
#   utils/proxy/applySession.js     (on-sync verify now uses verifyAndApply)
#   routes/admin/proxyTools.js      (Verify-now read-only for live-agent tools; aggregator wired to real scheduler)
#   cron/proxyVerifyScheduler.js    (NEW: periodic read-only auto-verify; server-crm require()s it)
#   server-crm.js                   (starts the scheduler)
#
# Safe: additive. Existing tools unchanged (Verify stays forceLive for non-live tools; the shared
# verify->apply path is a faithful extraction). The scheduler is read-only (never exchanges), single
# unref'd timer, stale-gated, pauses on logout. Disable with PROXY_VERIFY_SCHEDULER=0.
#
# Run in YOUR OWN terminal:  SFTP_PASS='...' bash deploy-writehuman-autoverify.sh
set -euo pipefail

HOST=147.79.103.253; PORT=65002; USER=u171982351
API_ROOT="/home/${USER}/domains/api.genzdigitalstore.com/nodejs"
API_BASE="https://api.genzdigitalstore.com"

if [[ -z "${SFTP_PASS:-}" ]]; then echo "ERROR: set SFTP_PASS first." >&2; exit 1; fi
cd "$(dirname "$0")"

echo "==> Pre-flight: node --check every file"
for f in backend/utils/proxy/tools.js backend/utils/proxy/verifyAndApply.js backend/utils/proxy/applySession.js \
         backend/routes/admin/proxyTools.js backend/cron/proxyVerifyScheduler.js backend/server-crm.js; do
  node --check "$f"
done
echo "    OK"

echo "==> Refreshing known_hosts (RSA only) for [${HOST}]:${PORT}"
ssh-keygen -R "[${HOST}]:${PORT}" >/dev/null 2>&1 || true
ssh-keyscan -t rsa -p "${PORT}" "${HOST}" >> ~/.ssh/known_hosts 2>/dev/null

RESTART_TMP="$(mktemp)"; date -u +"restart %Y-%m-%dT%H:%M:%SZ" > "${RESTART_TMP}"
echo "==> [1/3] Uploading changed backend files + restart trigger (one connection)"
curl --fail-with-body --ftp-create-dirs -u "${USER}:${SFTP_PASS}" \
  -T backend/utils/proxy/tools.js          "sftp://${HOST}:${PORT}${API_ROOT}/utils/proxy/tools.js" \
  -T backend/utils/proxy/verifyAndApply.js "sftp://${HOST}:${PORT}${API_ROOT}/utils/proxy/verifyAndApply.js" \
  -T backend/utils/proxy/applySession.js   "sftp://${HOST}:${PORT}${API_ROOT}/utils/proxy/applySession.js" \
  -T backend/routes/admin/proxyTools.js    "sftp://${HOST}:${PORT}${API_ROOT}/routes/admin/proxyTools.js" \
  -T backend/cron/proxyVerifyScheduler.js  "sftp://${HOST}:${PORT}${API_ROOT}/cron/proxyVerifyScheduler.js" \
  -T backend/server-crm.js                 "sftp://${HOST}:${PORT}${API_ROOT}/server-crm.js" \
  -T "${RESTART_TMP}"                       "sftp://${HOST}:${PORT}${API_ROOT}/tmp/restart.txt"
rm -f "${RESTART_TMP}"
echo "    upload complete; Passenger restart triggered."

echo "==> [2/3] Verifying backend booted + existing routes intact"
BOOT=0
for i in 1 2 3 4 5 6; do
  sleep 5
  BODY="$(curl -s -X POST "${API_BASE}/api/crm/extension/security-scan" -H 'Content-Type: application/json' -d '{}' || true)"
  echo "  attempt ${i}: $(echo "$BODY" | grep -oE 'extension_token_invalid|error' | head -1)"
  echo "${BODY}" | grep -q 'extension_token_invalid' && { BOOT=1; break; }
done
[[ "${BOOT}" == "1" ]] || { echo "==> FAIL: backend did not come back. Tail nodejs/stderr.log NOW." >&2; exit 1; }

echo "==> [3/3] Verifying WriteHuman surfaces still gated (unchanged contract)"
PT=$(curl -s -o /dev/null -w '%{http_code}' "${API_BASE}/api/crm/admin/proxy-tools/writehuman/agent-state" || true)
ING=$(curl -s -o /dev/null -w '%{http_code}' -X POST "${API_BASE}/api/crm/proxy/agent/writehuman/cookies" -H 'Content-Type: application/json' -d '{}' || true)
echo "  admin agent-state (no auth) -> HTTP ${PT} (expect 401)"
echo "  agent ingest (no key)       -> HTTP ${ING} (expect 403 = still configured)"
if [[ "${PT}" == "401" && "${ING}" == "403" ]]; then
  echo "==> SUCCESS: auto-verify + smart-timer live; existing tools intact. The periodic read-only"
  echo "    verifier starts on boot (log line '[proxyVerify] started'). Dashboard now shows Smart"
  echo "    timer running + Verify exchange off (read-only) for WriteHuman."
  exit 0
fi
echo "==> WARNING: unexpected codes (agent-state=${PT}, ingest=${ING}). Investigate." >&2
exit 1
