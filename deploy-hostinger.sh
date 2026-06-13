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
  -T backend/routes/extension/index.js        "sftp://${HOST}:${PORT}${API_ROOT}/routes/extension/index.js" \
  -T backend/routes/client/tools.js           "sftp://${HOST}:${PORT}${API_ROOT}/routes/client/tools.js" \
  -T backend/routes/admin/toolsEnhanced.js    "sftp://${HOST}:${PORT}${API_ROOT}/routes/admin/toolsEnhanced.js" \
  -T "${RESTART_TMP}"                          "sftp://${HOST}:${PORT}${API_ROOT}/tmp/restart.txt"

rm -f "${RESTART_TMP}"
echo "    backend upload complete; Passenger restart triggered."

# ── 2) FRONTEND: upload the whole build/ tree to BOTH website roots in ONE
#       curl call. CRITICAL .htaccess handling:
#         - MAIN root: include build/.htaccess (it IS the redirect version that
#           sends /login, /client/*, /admin/* to the app subdomain).
#         - APP  root: NEVER overwrite .htaccess — the app subdomain keeps its
#           own no-redirect SPA rule, or /client/* redirects loop forever.
#       The build also contains downloads/genz-digital-store-extension.zip, so
#       this step publishes the latest extension zip too. ─────────────────────
FRONT_ARGS=()
while IFS= read -r rel; do
  rel="${rel#./}"
  FRONT_ARGS+=( -T "${BUILD_DIR}/${rel}" "sftp://${HOST}:${PORT}${MAIN_WEB}/${rel}" )
  if [[ "${rel}" != ".htaccess" ]]; then
    FRONT_ARGS+=( -T "${BUILD_DIR}/${rel}" "sftp://${HOST}:${PORT}${APP_WEB}/${rel}" )
  fi
done < <(cd "${BUILD_DIR}" && find . -type f)

echo "==> [2/3] Uploading frontend build to main + app roots"
curl --fail-with-body --ftp-create-dirs \
  -u "${USER}:${SFTP_PASS}" \
  "${FRONT_ARGS[@]}"
echo "    frontend upload complete (extension zip included)."

# ── 3) VERIFY backend is live: verify-intent with no token returns the exact
#       code field. 000 = mid-restart, retry. ─────────────────────────────────
echo "==> [3/3] Verifying backend (waiting for Passenger restart)..."
for i in 1 2 3 4 5 6; do
  sleep 5
  BODY="$(curl -s -X POST https://api.genzdigitalstore.com/api/crm/extension/verify-intent \
    -H 'Content-Type: application/json' -d '{"intentToken":"x","toolId":"x"}' || true)"
  echo "  attempt ${i}: ${BODY}"
  if echo "${BODY}" | grep -q 'extension_token_invalid'; then
    echo "==> SUCCESS: backend live, frontend + extension published."
    echo "    Site:      https://genzdigitalstore.com  /  https://app.genzdigitalstore.com"
    echo "    Extension: https://genzdigitalstore.com/downloads/genz-digital-store-extension.zip (v3.8.7)"
    echo "    Reminder:  installed users must RELOAD the extension to pick up popup/background changes."
    exit 0
  fi
done
echo "==> WARNING: backend did not return the new 'code' field yet. Tail nodejs/stderr.log." >&2
echo "    (Frontend + extension uploads above still completed.)" >&2
exit 1
