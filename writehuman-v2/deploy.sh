#!/usr/bin/env bash
# Deploy WriteHuman V2 to its OWN Hostinger Passenger app (a NEW subdomain — never the
# production WriteHuman gateway). Isolated by design: this script only ever writes under the
# V2 server dir and never touches proxy-gateway / backend / any production app.
#
# PREREQUISITES (one-time, done in hPanel — this script cannot do them):
#   1. Create a subdomain, e.g.  writehuman2.genzdigitalstore.com
#   2. Create a Node.js app for it (Passenger). Set the app root to the V2 server dir below
#      and the startup file to app.js (or server.js). Node >= 18.
#   3. On the server, create the app's .env from .env.example with REAL V2 secrets
#      (WRITEHUMAN_V2_SECRET / _LEASE_SECRET / _VAULT_KEY / _GATEWAY_KEY / _ADMIN_KEY /
#       _AGENT_KEY) and WRITEHUMAN_V2_PUBLIC_ORIGIN=https://<the subdomain>.
#      Do NOT commit or upload .env — this script never uploads it.
#
# USAGE:  SFTP_PASS='…' bash writehuman-v2/deploy.sh
#   Overridable: SERVER_DIR, VHOST, SFTP_HOST, SFTP_PORT, SFTP_USER
#
# Safe to re-run. Never prints the password. Uploads code only; the server keeps its own .env.
set -uo pipefail

SFTP_HOST="${SFTP_HOST:-147.79.103.253}"
SFTP_PORT="${SFTP_PORT:-65002}"
SFTP_USER="${SFTP_USER:-u171982351}"
SERVER_DIR="${SERVER_DIR:-/home/${SFTP_USER}/writehuman-v2}"
VHOST="${VHOST:-writehuman2.genzdigitalstore.com}"
: "${SFTP_PASS:?Set SFTP_PASS env (Hostinger SFTP password)}"

# Run from the writehuman-v2 directory regardless of CWD.
cd "$(dirname "$0")"

# Runtime files only — NOT .env, node_modules, store/data, tests, or docs.
FILES=(
  app.js server.js package.json
  gateway/proxy.js
  public/overlay.js public/overlay.css
  lib/config.js lib/log.js lib/cookies.js lib/vaultCrypto.js lib/lease.js lib/verify.js lib/supabase.js
  store/accountStore.js store/schema.sql
  session/sessionManager.js session/cookieManager.js session/scheduler.js session/syncIngest.js
  agent/cookie-sync-agent.js
)

echo "==> Deploying WriteHuman V2  ->  ${SFTP_USER}@${SFTP_HOST}:${SERVER_DIR}  (vhost ${VHOST})"

# Build one curl invocation with many -T pairs so a single SFTP connection is reused
# (per-file curl invocations get throttled/timed out by this server).
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

# Restart Passenger by touching tmp/restart.txt (mtime change triggers a reload).
TMP="$(mktemp)"; date > "$TMP"
curl -sS --ftp-create-dirs -u "${SFTP_USER}:${SFTP_PASS}" -T "$TMP" "sftp://${SFTP_HOST}:${SFTP_PORT}${SERVER_DIR}/tmp/restart.txt" >/dev/null 2>&1 || true
rm -f "$TMP"
echo "   ✓ restart triggered (tmp/restart.txt)"

# Verify. /v2/health should return 200 JSON {ok:true}. (000 = mid-restart; retry.)
sleep 4
CODE="$(curl -s -o /dev/null -w '%{http_code}' "https://${VHOST}/v2/health" || echo 000)"
case "$CODE" in
  200) echo "   ✓ https://${VHOST}/v2/health -> 200 (V2 live)";;
  000) echo "   ~ no response yet (Passenger may still be restarting) — retry /v2/health shortly";;
  *)   echo "   ~ /v2/health returned HTTP ${CODE} — check the app .env / Passenger logs";;
esac
echo "==> Done. Next: create the app .env with real secrets if you haven't, then seed the"
echo "    account (/v2/admin/seed) and run the Cookie Sync Agent on the RDP (agent/README.md)."
