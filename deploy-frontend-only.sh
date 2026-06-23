#!/usr/bin/env bash
# FRONTEND-ONLY deploy for Gen Z Digital Store.
# Uploads frontend/build/ to BOTH website roots over SFTP. Does NOT touch the
# backend Node app and does NOT restart Passenger — safe for a pure frontend fix
# (e.g. the storage-blocked login fix).
#
# Run it in YOUR OWN terminal so the password never lands in a shared transcript:
#   SFTP_PASS='your-sftp-password' bash deploy-frontend-only.sh
#
set -euo pipefail

HOST=147.79.103.253
PORT=65002
USER=u171982351
MAIN_WEB="/home/${USER}/domains/genzdigitalstore.com/public_html"
APP_WEB="/home/${USER}/domains/genzdigitalstore.com/public_html/app"
BUILD_DIR="frontend/build"

if [[ -z "${SFTP_PASS:-}" ]]; then
  echo "ERROR: set SFTP_PASS first, e.g.  SFTP_PASS='...' bash deploy-frontend-only.sh" >&2
  exit 1
fi

cd "$(dirname "$0")"

if [[ ! -f "${BUILD_DIR}/index.html" ]]; then
  echo "ERROR: ${BUILD_DIR}/index.html not found — run 'cd frontend && npm run build' first." >&2
  exit 1
fi

# Sanity: the fix must actually be in this build before we publish it.
if ! grep -rqs "STORAGE_BLOCKED" "${BUILD_DIR}/static/js"; then
  echo "ERROR: STORAGE_BLOCKED not found in build — this build predates the fix. Rebuild first." >&2
  exit 1
fi

# known_hosts: libssh2 (curl) can only use an RSA host key.
echo "==> Refreshing known_hosts (RSA only) for [${HOST}]:${PORT}"
ssh-keygen -R "[${HOST}]:${PORT}" >/dev/null 2>&1 || true
ssh-keyscan -t rsa -p "${PORT}" "${HOST}" >> ~/.ssh/known_hosts 2>/dev/null

# Build a curl -K config of upload pairs (avoids "Argument list too long" on ~100 chunks).
#   MAIN root: include build/.htaccess (the redirect version).
#   APP  root: NEVER overwrite .htaccess (keeps its no-redirect SPA rule).
FRONT_CFG="$(mktemp)"
while IFS= read -r rel; do
  rel="${rel#./}"
  printf 'upload-file = "%s"\nurl = "sftp://%s:%s%s/%s"\n' "${BUILD_DIR}/${rel}" "${HOST}" "${PORT}" "${MAIN_WEB}" "${rel}" >> "${FRONT_CFG}"
  if [[ "${rel}" != ".htaccess" ]]; then
    printf 'upload-file = "%s"\nurl = "sftp://%s:%s%s/%s"\n' "${BUILD_DIR}/${rel}" "${HOST}" "${PORT}" "${APP_WEB}" "${rel}" >> "${FRONT_CFG}"
  fi
done < <(cd "${BUILD_DIR}" && find . -type f ! -name '*.map')

echo "==> Uploading frontend build to main + app roots ($(grep -c upload-file "${FRONT_CFG}") transfers)"
curl --silent --show-error --fail-with-body --ftp-create-dirs \
  -u "${USER}:${SFTP_PASS}" \
  -K "${FRONT_CFG}"
rm -f "${FRONT_CFG}"

LOCAL_MAIN="$(grep -o 'main\.[a-z0-9]*\.js' "${BUILD_DIR}/index.html" | head -1)"
echo "==> DONE. Frontend published to both roots (backend untouched, no restart)."
echo "    Verify: curl -s https://app.genzdigitalstore.com/ | grep -o 'main\\.[a-z0-9]*\\.js'  (expect ${LOCAL_MAIN})"
