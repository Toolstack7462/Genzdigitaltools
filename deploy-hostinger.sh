#!/usr/bin/env bash
# Deploy the Gen Z Digital Store BACKEND (Hostinger Passenger Node app) AND the
# Chrome EXTENSION zip (served from the website downloads folder) in a single
# SFTP connection, then restart Passenger and verify.
#
# The SFTP password is read from $SFTP_PASS so the secret never has to be typed
# onto a shared command line. Run it in YOUR OWN terminal:
#
#   SFTP_PASS='your-sftp-password' bash deploy-hostinger.sh
#
# (Backend code surface and the two website roots are SEPARATE deploy targets;
#  this script touches only the files that changed + the extension zip.)
set -euo pipefail

HOST=147.79.103.253
PORT=65002
USER=u171982351
API_ROOT="/home/${USER}/domains/api.genzdigitalstore.com/nodejs"
WEB_ROOT="/home/${USER}/domains/genzdigitalstore.com/public_html"
EXT_ZIP="frontend/build/downloads/genz-digital-store-extension.zip"

if [[ -z "${SFTP_PASS:-}" ]]; then
  echo "ERROR: set SFTP_PASS first, e.g.  SFTP_PASS='...' bash deploy-hostinger.sh" >&2
  exit 1
fi

cd "$(dirname "$0")"

# Sanity: the extension zip must exist and carry manifest.json at its ROOT.
if [[ ! -f "${EXT_ZIP}" ]]; then
  echo "ERROR: ${EXT_ZIP} not found — run 'cd frontend && npm run build' and repackage first." >&2
  exit 1
fi

# 1) libssh2 (curl) can only use an RSA host key — purge any ed25519/ecdsa entry
#    for this host and pin ONLY the RSA key, or the SFTP handshake fails.
echo "==> Refreshing known_hosts (RSA only) for [${HOST}]:${PORT}"
ssh-keygen -R "[${HOST}]:${PORT}" >/dev/null 2>&1 || true
ssh-keyscan -t rsa -p "${PORT}" "${HOST}" >> ~/.ssh/known_hosts 2>/dev/null

# 2) Restart trigger — Passenger restarts when nodejs/tmp/restart.txt mtime changes.
RESTART_TMP="$(mktemp)"
date -u +"restart %Y-%m-%dT%H:%M:%SZ" > "${RESTART_TMP}"

# 3) ONE curl call (single SSH connection — per-file invocations get throttled).
#    BACKEND: the shared access helper MUST ship alongside the two routes that
#    now require('../../utils/getClientAccessibleTool') — otherwise Passenger
#    boots into "module not found". admin/toolsEnhanced.js keeps admin tool-save
#    in sync. EXTENSION: the new zip to BOTH website roots (main + app subdomain).
echo "==> Uploading backend files, extension zip (main + app), and restart trigger"
curl --fail-with-body --ftp-create-dirs \
  -u "${USER}:${SFTP_PASS}" \
  -T backend/utils/getClientAccessibleTool.js "sftp://${HOST}:${PORT}${API_ROOT}/utils/getClientAccessibleTool.js" \
  -T backend/routes/extension/index.js        "sftp://${HOST}:${PORT}${API_ROOT}/routes/extension/index.js" \
  -T backend/routes/client/tools.js           "sftp://${HOST}:${PORT}${API_ROOT}/routes/client/tools.js" \
  -T backend/routes/admin/toolsEnhanced.js    "sftp://${HOST}:${PORT}${API_ROOT}/routes/admin/toolsEnhanced.js" \
  -T "${EXT_ZIP}"                             "sftp://${HOST}:${PORT}${WEB_ROOT}/downloads/genz-digital-store-extension.zip" \
  -T "${EXT_ZIP}"                             "sftp://${HOST}:${PORT}${WEB_ROOT}/app/downloads/genz-digital-store-extension.zip" \
  -T "${RESTART_TMP}"                          "sftp://${HOST}:${PORT}${API_ROOT}/tmp/restart.txt"

rm -f "${RESTART_TMP}"
echo "==> Upload complete; Passenger restart triggered."

# 4) Verify the backend is live: verify-intent with no token returns the exact
#    code field. 000 = mid-restart, retry. (Extension zip is static — no restart.)
echo "==> Verifying backend (waiting for Passenger restart)..."
for i in 1 2 3 4 5 6; do
  sleep 5
  BODY="$(curl -s -X POST https://api.genzdigitalstore.com/api/crm/extension/verify-intent \
    -H 'Content-Type: application/json' -d '{"intentToken":"x","toolId":"x"}' || true)"
  echo "  attempt ${i}: ${BODY}"
  if echo "${BODY}" | grep -q 'extension_token_invalid'; then
    echo "==> SUCCESS: backend deployed (exact 'code' field present)."
    echo "==> Extension zip live at https://genzdigitalstore.com/downloads/genz-digital-store-extension.zip (v3.8.6)"
    echo "    Reminder: installed users must RELOAD the extension to pick up popup/background changes."
    exit 0
  fi
done
echo "==> WARNING: backend did not return the new 'code' field yet. Tail nodejs/stderr.log." >&2
exit 1
