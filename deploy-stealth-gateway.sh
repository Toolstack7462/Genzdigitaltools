#!/usr/bin/env bash
# Deploy the StealthWriter reverse-proxy gateway to its OWN Hostinger Passenger app on
# stealth1.genzdigitalstore.com. Isolated by design: this script only ever writes under the
# StealthWriter gateway server dir and NEVER touches claude-gateway / proxy-gateway /
# grok-gateway / hix-gateway / the api backend / any other app.
#
# WHY THIS SCRIPT EXISTS: the repo previously had no StealthWriter gateway deploy path (only
# deploy-claude-gateway.sh), so a change to stealth-gateway/ had to be uploaded by hand — easy
# to half-do, and a half-done gateway is a broken tool. The one-time POST launch bootstrap
# changes BOTH server.js and public/overlay.js, and they must ship together: the overlay now
# calls the gateway's same-origin /__genz/validate + /__genz/consume, which only exist in the
# new server.js. Shipping the overlay alone would 404 every validate call; shipping the server
# alone would leave a cached overlay reaching for a cookie that is now HttpOnly.
#
# PREREQUISITES (one-time, done in hPanel — this script cannot do them):
#   1. The stealth1.genzdigitalstore.com subdomain + its Passenger .htaccess.
#   2. STEALTH_LEASE_SECRET / STEALTH_GATEWAY_KEY set there, matching the backend.
#   Secrets live ONLY in that server-side .htaccess (or the app .env) — this script never
#   uploads secrets and never prints the password.
#
# ROLLOUT NOTE: ship with the default ALLOW_URL_LEASE=1 so the legacy /gateway?lease= entry
# point still answers during the rollout (that is the no-redeploy rollback path). Once the POST
# flow is verified in production, add `SetEnv ALLOW_URL_LEASE 0` to the .htaccess and restart —
# that is the moment the lease genuinely stops being URL-reachable.
#
# USAGE:  SFTP_PASS='…' bash deploy-stealth-gateway.sh
#   Overridable env: SERVER_DIR, VHOST, SFTP_HOST, SFTP_PORT, SFTP_USER
#
# Safe to re-run. Uploads code only; the server keeps its own .htaccess / .env, and
# tmp/sessions/ (the encrypted opaque-session store) is never touched.
set -uo pipefail

SFTP_HOST="${SFTP_HOST:-147.79.103.253}"
SFTP_PORT="${SFTP_PORT:-65002}"
SFTP_USER="${SFTP_USER:-u171982351}"
SERVER_DIR="${SERVER_DIR:-/home/${SFTP_USER}/stealth-gateway}"
VHOST="${VHOST:-stealth1.genzdigitalstore.com}"
: "${SFTP_PASS:?Set SFTP_PASS env (Hostinger SFTP password)}"

cd "$(dirname "$0")/stealth-gateway"

# libssh2 needs the RSA host key present (it cannot use ed25519/ecdsa on this build).
ssh-keygen -R "[${SFTP_HOST}]:${SFTP_PORT}" >/dev/null 2>&1 || true
ssh-keyscan -t rsa -p "${SFTP_PORT}" "${SFTP_HOST}" >> ~/.ssh/known_hosts 2>/dev/null || true

# Runtime files only — NOT .env, node_modules, docs, tests or the .example template.
FILES=(
  server.js package.json
  public/overlay.js public/overlay.css
)

echo "==> Deploying StealthWriter gateway  ->  ${SFTP_USER}@${SFTP_HOST}:${SERVER_DIR}  (vhost ${VHOST})"

# One curl invocation, many -T pairs → a single SFTP connection is reused (per-file curl
# invocations get throttled/timed out by this server).
args=()
for f in "${FILES[@]}"; do
  [ -f "$f" ] || { echo "   !! missing local file: $f"; exit 1; }
  args+=( --ftp-create-dirs -T "$f" "sftp://${SFTP_HOST}:${SFTP_PORT}${SERVER_DIR}/${f}" )
done

if ! curl -sS --fail-with-body -u "${SFTP_USER}:${SFTP_PASS}" "${args[@]}"; then
  echo "   !! upload failed (host-key? libssh2 needs the RSA key in known_hosts:"
  echo "      ssh-keygen -R \"[${SFTP_HOST}]:${SFTP_PORT}\"; ssh-keyscan -t rsa -p ${SFTP_PORT} ${SFTP_HOST} >> ~/.ssh/known_hosts )"
  exit 1
fi
echo "   ✓ ${#FILES[@]} files uploaded"

# The durable opaque-session store lives here. Passenger runs several workers and recycles idle
# ones, so a session that exists only in one process's memory turns into a mid-session block
# page on the next request. Make sure the directory exists (contents are runtime-only and are
# never uploaded).
TMP="$(mktemp)"; : > "$TMP"
curl -sS --ftp-create-dirs -u "${SFTP_USER}:${SFTP_PASS}" -T "$TMP" "sftp://${SFTP_HOST}:${SFTP_PORT}${SERVER_DIR}/tmp/sessions/.gitkeep" >/dev/null 2>&1 || true

# Restart Passenger by touching tmp/restart.txt (mtime change triggers a reload). Passenger
# only acts on the NEXT request after the bump, so poke the app afterwards.
date +%s%N > "$TMP" 2>/dev/null || date > "$TMP"
curl -sS --ftp-create-dirs -u "${SFTP_USER}:${SFTP_PASS}" -T "$TMP" "sftp://${SFTP_HOST}:${SFTP_PORT}${SERVER_DIR}/tmp/restart.txt" >/dev/null 2>&1 || true
rm -f "$TMP"
echo "   ✓ restart triggered (tmp/restart.txt)"

# Verify: an unauthenticated request must be lease-gated (403 block page), and a GET on the
# POST-only launch endpoint must be refused (405). Neither reveals anything.
echo "==> Verifying https://${VHOST}"
for i in 1 2 3 4 5; do
  ROOT="$(curl -s -o /dev/null -w '%{http_code}' "https://${VHOST}/" || echo 000)"
  [ "$ROOT" != "000" ] && break
  sleep 2
done
LAUNCH_GET="$(curl -s -o /dev/null -w '%{http_code}' "https://${VHOST}/launch" || echo 000)"
echo "   /        -> ${ROOT}      (expect 403 — lease-gated)"
echo "   /launch  -> ${LAUNCH_GET}      (expect 405 — POST only)"
if [ "$ROOT" = "403" ] && [ "$LAUNCH_GET" = "405" ]; then
  echo "   ✓ gateway is live with the POST launch bootstrap"
else
  echo "   !! unexpected status — check the Passenger log and the .htaccess SetEnv block"
fi
