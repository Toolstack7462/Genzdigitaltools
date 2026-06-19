#!/usr/bin/env bash
# Deploy Gen Z Digital Store to Hostinger in three phases over SFTP:
#   1) BACKEND  → Passenger Node app (api.genzdigitalstore.com/nodejs) + restart
#   2) FRONTEND → the React build to BOTH website roots (main + app subdomain).
#                 This also carries the Chrome EXTENSION zip (build/downloads/…).
#   3) VERIFY   → confirm the backend booted with the new code.
#
# The SFTP password is read from $SFTP_PASS so the secret never has to be typed
# onto a shared command line. Run it in YOUR OWN terminal:
#
#   SFTP_PASS='your-sftp-password' bash deploy-hostinger.sh
#
set -euo pipefail

HOST=147.79.103.253
PORT=65002
USER=u171982351
API_ROOT="/home/${USER}/domains/api.genzdigitalstore.com/nodejs"
MAIN_WEB="/home/${USER}/domains/genzdigitalstore.com/public_html"
APP_WEB="/home/${USER}/domains/genzdigitalstore.com/public_html/app"
BUILD_DIR="frontend/build"

if [[ -z "${SFTP_PASS:-}" ]]; then
  echo "ERROR: set SFTP_PASS first, e.g.  SFTP_PASS='...' bash deploy-hostinger.sh" >&2
  exit 1
fi

cd "$(dirname "$0")"

# Sanity: the React build must exist (run 'cd frontend && npm run build' first).
if [[ ! -f "${BUILD_DIR}/index.html" ]]; then
  echo "ERROR: ${BUILD_DIR}/index.html not found — run 'cd frontend && npm run build' first." >&2
  exit 1
fi

# ── 0) known_hosts: libssh2 (curl) can only use an RSA host key — purge any
#       ed25519/ecdsa entry for this host and pin ONLY the RSA key. ───────────
echo "==> Refreshing known_hosts (RSA only) for [${HOST}]:${PORT}"
ssh-keygen -R "[${HOST}]:${PORT}" >/dev/null 2>&1 || true
ssh-keyscan -t rsa -p "${PORT}" "${HOST}" >> ~/.ssh/known_hosts 2>/dev/null

# ── 1) BACKEND: the shared access helper MUST ship alongside the two routes
#       that now require('../../utils/getClientAccessibleTool') — otherwise
#       Passenger boots into "module not found". admin/toolsEnhanced.js keeps
#       admin tool-save in sync. Restart trigger goes LAST. One curl call. ─────
RESTART_TMP="$(mktemp)"
date -u +"restart %Y-%m-%dT%H:%M:%SZ" > "${RESTART_TMP}"

echo "==> [1/3] Uploading backend files + restart trigger"
curl --fail-with-body --ftp-create-dirs \
  -u "${USER}:${SFTP_PASS}" \
  -T backend/utils/getClientAccessibleTool.js "sftp://${HOST}:${PORT}${API_ROOT}/utils/getClientAccessibleTool.js" \
  -T backend/utils/toolCleanupConfig.js       "sftp://${HOST}:${PORT}${API_ROOT}/utils/toolCleanupConfig.js" \
  -T backend/routes/extension/index.js        "sftp://${HOST}:${PORT}${API_ROOT}/routes/extension/index.js" \
  -T backend/routes/client/tools.js           "sftp://${HOST}:${PORT}${API_ROOT}/routes/client/tools.js" \
  -T backend/routes/admin/toolsEnhanced.js    "sftp://${HOST}:${PORT}${API_ROOT}/routes/admin/toolsEnhanced.js" \
  -T backend/routes/admin/securityAlerts.js   "sftp://${HOST}:${PORT}${API_ROOT}/routes/admin/securityAlerts.js" \
  -T backend/routes/authEnhanced.js           "sftp://${HOST}:${PORT}${API_ROOT}/routes/authEnhanced.js" \
  -T backend/middleware/validation.js         "sftp://${HOST}:${PORT}${API_ROOT}/middleware/validation.js" \
  -T backend/routes/admin/clientsEnhanced.js  "sftp://${HOST}:${PORT}${API_ROOT}/routes/admin/clientsEnhanced.js" \
  -T backend/routes/admin/assignments.js      "sftp://${HOST}:${PORT}${API_ROOT}/routes/admin/assignments.js" \
  -T backend/routes/admin/activity.js         "sftp://${HOST}:${PORT}${API_ROOT}/routes/admin/activity.js" \
  -T backend/routes/admin/analytics.js        "sftp://${HOST}:${PORT}${API_ROOT}/routes/admin/analytics.js" \
  -T backend/models/ActivityLog.js            "sftp://${HOST}:${PORT}${API_ROOT}/models/ActivityLog.js" \
  -T backend/utils/proxyAssignments.js        "sftp://${HOST}:${PORT}${API_ROOT}/utils/proxyAssignments.js" \
  -T backend/models/ExtensionScan.js          "sftp://${HOST}:${PORT}${API_ROOT}/models/ExtensionScan.js" \
  -T backend/models/DeviceProfile.js          "sftp://${HOST}:${PORT}${API_ROOT}/models/DeviceProfile.js" \
  -T backend/db/mysqlAdapter.js               "sftp://${HOST}:${PORT}${API_ROOT}/db/mysqlAdapter.js" \
  -T backend/utils/email.js                   "sftp://${HOST}:${PORT}${API_ROOT}/utils/email.js" \
  -T backend/models/EmailVerification.js      "sftp://${HOST}:${PORT}${API_ROOT}/models/EmailVerification.js" \
  -T backend/routes/authEmail.js              "sftp://${HOST}:${PORT}${API_ROOT}/routes/authEmail.js" \
  -T backend/routes/public.js                 "sftp://${HOST}:${PORT}${API_ROOT}/routes/public.js" \
  -T backend/models/stealth/StealthClient.js     "sftp://${HOST}:${PORT}${API_ROOT}/models/stealth/StealthClient.js" \
  -T backend/models/stealth/StealthLease.js      "sftp://${HOST}:${PORT}${API_ROOT}/models/stealth/StealthLease.js" \
  -T backend/models/stealth/StealthUsageLog.js   "sftp://${HOST}:${PORT}${API_ROOT}/models/stealth/StealthUsageLog.js" \
  -T backend/models/stealth/StealthSettings.js   "sftp://${HOST}:${PORT}${API_ROOT}/models/stealth/StealthSettings.js" \
  -T backend/models/stealth/StealthAccount.js    "sftp://${HOST}:${PORT}${API_ROOT}/models/stealth/StealthAccount.js" \
  -T backend/utils/stealth/vaultCrypto.js        "sftp://${HOST}:${PORT}${API_ROOT}/utils/stealth/vaultCrypto.js" \
  -T backend/utils/stealth/accountSelect.js      "sftp://${HOST}:${PORT}${API_ROOT}/utils/stealth/accountSelect.js" \
  -T backend/utils/stealth/verify.js             "sftp://${HOST}:${PORT}${API_ROOT}/utils/stealth/verify.js" \
  -T backend/utils/stealth/cookies.js            "sftp://${HOST}:${PORT}${API_ROOT}/utils/stealth/cookies.js" \
  -T backend/utils/stealth/time.js               "sftp://${HOST}:${PORT}${API_ROOT}/utils/stealth/time.js" \
  -T backend/utils/stealth/config.js             "sftp://${HOST}:${PORT}${API_ROOT}/utils/stealth/config.js" \
  -T backend/utils/stealth/lease.js              "sftp://${HOST}:${PORT}${API_ROOT}/utils/stealth/lease.js" \
  -T backend/utils/stealth/access.js             "sftp://${HOST}:${PORT}${API_ROOT}/utils/stealth/access.js" \
  -T backend/utils/stealth/resetAll.js           "sftp://${HOST}:${PORT}${API_ROOT}/utils/stealth/resetAll.js" \
  -T backend/routes/admin/stealth.js             "sftp://${HOST}:${PORT}${API_ROOT}/routes/admin/stealth.js" \
  -T backend/routes/client/stealth.js            "sftp://${HOST}:${PORT}${API_ROOT}/routes/client/stealth.js" \
  -T backend/routes/stealth/gateway.js           "sftp://${HOST}:${PORT}${API_ROOT}/routes/stealth/gateway.js" \
  -T backend/cron/stealthScheduler.js            "sftp://${HOST}:${PORT}${API_ROOT}/cron/stealthScheduler.js" \
  -T backend/scripts/stealth-reset.js            "sftp://${HOST}:${PORT}${API_ROOT}/scripts/stealth-reset.js" \
  -T backend/utils/proxy/tools.js                "sftp://${HOST}:${PORT}${API_ROOT}/utils/proxy/tools.js" \
  -T backend/utils/proxy/vaultCrypto.js          "sftp://${HOST}:${PORT}${API_ROOT}/utils/proxy/vaultCrypto.js" \
  -T backend/utils/proxy/lease.js                "sftp://${HOST}:${PORT}${API_ROOT}/utils/proxy/lease.js" \
  -T backend/utils/proxy/accountSelect.js        "sftp://${HOST}:${PORT}${API_ROOT}/utils/proxy/accountSelect.js" \
  -T backend/utils/proxy/cookies.js              "sftp://${HOST}:${PORT}${API_ROOT}/utils/proxy/cookies.js" \
  -T backend/utils/proxy/verify.js               "sftp://${HOST}:${PORT}${API_ROOT}/utils/proxy/verify.js" \
  -T backend/models/proxy/ProxyClient.js         "sftp://${HOST}:${PORT}${API_ROOT}/models/proxy/ProxyClient.js" \
  -T backend/models/proxy/ProxyLease.js          "sftp://${HOST}:${PORT}${API_ROOT}/models/proxy/ProxyLease.js" \
  -T backend/models/proxy/ProxyAccount.js        "sftp://${HOST}:${PORT}${API_ROOT}/models/proxy/ProxyAccount.js" \
  -T backend/routes/admin/proxyTools.js          "sftp://${HOST}:${PORT}${API_ROOT}/routes/admin/proxyTools.js" \
  -T backend/routes/client/proxyTools.js         "sftp://${HOST}:${PORT}${API_ROOT}/routes/client/proxyTools.js" \
  -T backend/routes/proxy/gateway.js             "sftp://${HOST}:${PORT}${API_ROOT}/routes/proxy/gateway.js" \
  -T backend/server-crm.js                    "sftp://${HOST}:${PORT}${API_ROOT}/server-crm.js" \
  -T "${RESTART_TMP}"                          "sftp://${HOST}:${PORT}${API_ROOT}/tmp/restart.txt"

rm -f "${RESTART_TMP}"
echo "    backend upload complete; Passenger restart triggered."

# ── 2) FRONTEND: upload the build/ tree (minus *.map source maps, which we do
#       not publish publicly) to BOTH website roots in ONE curl call.
#       CRITICAL .htaccess handling:
#         - MAIN root: include build/.htaccess (it IS the redirect version that
#           sends /login, /client/*, /admin/* to the app subdomain).
#         - APP  root: NEVER overwrite .htaccess — the app subdomain keeps its
#           own no-redirect SPA rule, or /client/* redirects loop forever.
#       The build also contains downloads/genz-digital-store-extension.zip, so
#       this step publishes the latest extension zip too. ─────────────────────
# Build a curl config file (-K) of upload-file/url pairs instead of one giant
# argv. Code-splitting produces ~100 hashed chunk files; passing them all inline
# overflows the OS command-line limit ("Argument list too long"). The credential
# stays on the command line (-u), never written to the config file.
FRONT_CFG="$(mktemp)"
while IFS= read -r rel; do
  rel="${rel#./}"
  printf 'upload-file = "%s"\nurl = "sftp://%s:%s%s/%s"\n' "${BUILD_DIR}/${rel}" "${HOST}" "${PORT}" "${MAIN_WEB}" "${rel}" >> "${FRONT_CFG}"
  if [[ "${rel}" != ".htaccess" ]]; then
    printf 'upload-file = "%s"\nurl = "sftp://%s:%s%s/%s"\n' "${BUILD_DIR}/${rel}" "${HOST}" "${PORT}" "${APP_WEB}" "${rel}" >> "${FRONT_CFG}"
  fi
done < <(cd "${BUILD_DIR}" && find . -type f ! -name '*.map')

echo "==> [2/3] Uploading frontend build to main + app roots ($(grep -c upload-file "${FRONT_CFG}") transfers)"
curl --fail-with-body --ftp-create-dirs \
  -u "${USER}:${SFTP_PASS}" \
  -K "${FRONT_CFG}"
rm -f "${FRONT_CFG}"
echo "    frontend upload complete (extension zip included)."

# ── 3) VERIFY backend is live: an authenticated extension route with NO token
#       returns the exact code field (extension_token_invalid). 000 = mid-restart,
#       retry. (Uses /security-scan — /verify-intent was removed in the OceanHub
#       direct-open refactor.) ─────────────────────────────────────────────────
echo "==> [3/3] Verifying backend (waiting for Passenger restart)..."
for i in 1 2 3 4 5 6; do
  sleep 5
  BODY="$(curl -s -X POST https://api.genzdigitalstore.com/api/crm/extension/security-scan \
    -H 'Content-Type: application/json' -d '{}' || true)"
  echo "  attempt ${i}: ${BODY}"
  if echo "${BODY}" | grep -q 'extension_token_invalid'; then
    echo "==> SUCCESS: backend live, frontend + extension published."
    echo "    Site:      https://genzdigitalstore.com  /  https://app.genzdigitalstore.com"
    echo "    Extension: https://genzdigitalstore.com/downloads/genz-digital-store-extension.zip (v3.9.0)"
    echo "    Reminder:  installed users must RELOAD the extension to pick up popup/background changes."
    exit 0
  fi
done
echo "==> WARNING: backend did not return the new 'code' field yet. Tail nodejs/stderr.log." >&2
echo "    (Frontend + extension uploads above still completed.)" >&2
exit 1
