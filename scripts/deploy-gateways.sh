#!/usr/bin/env bash
# Deploy the standalone proxy/stealth gateway apps (NOT covered by deploy-hostinger.sh).
#
# deploy-hostinger.sh ships the backend + frontend + extension zip only. The reverse-proxy
# gateways are separate Passenger apps in their own home-dir folders, each on its own
# subdomain, deployed by SFTP-uploading the changed files and writing tmp/restart.txt.
#
#   Source (repo)        -> Server app dir (/home/<USER>/<dir>)  -> subdomain
#   proxy-gateway/       -> hix-gateway, bypassgpt-gateway,          hix1, bypassgpt1,
#                           chatgpt-gateway, ryne-gateway,           chatgpt1, ryne1,
#                           writehuman-gateway                       writehuman1
#   grok-gateway/        -> grok-gateway                            grok1
#   stealth-gateway/     -> stealth-gateway                         stealth1
#
# Usage:  SFTP_PASS='…' bash scripts/deploy-gateways.sh [tool ...]
#         (no args = all gateways).  e.g.  SFTP_PASS='…' bash scripts/deploy-gateways.sh writehuman ryne
#
# Safe to re-run. Never prints the password. A live gateway returns HTTP 403 (lease
# required) on '/', which the verify step treats as success.
set -uo pipefail

HOST="147.79.103.253"; PORT="65002"; USER="u171982351"
: "${SFTP_PASS:?Set SFTP_PASS env (your Hostinger SFTP password)}"

# tool -> "repoSrcDir|serverHomeDir|verifyHost"
declare -A MAP=(
  [hix]="proxy-gateway|hix-gateway|hix1.genzdigitalstore.com"
  [bypassgpt]="proxy-gateway|bypassgpt-gateway|bypassgpt1.genzdigitalstore.com"
  [chatgpt]="proxy-gateway|chatgpt-gateway|chatgpt1.genzdigitalstore.com"
  [ryne]="proxy-gateway|ryne-gateway|ryne1.genzdigitalstore.com"
  [writehuman]="proxy-gateway|writehuman-gateway|writehuman1.genzdigitalstore.com"
  [grok]="grok-gateway|grok-gateway|grok1.genzdigitalstore.com"
  [stealth]="stealth-gateway|stealth-gateway|stealth1.genzdigitalstore.com"
)

TOOLS=("$@"); [ ${#TOOLS[@]} -eq 0 ] && TOOLS=(hix bypassgpt chatgpt ryne writehuman grok stealth)

up() { # localfile remotepath
  curl -sS --fail-with-body --ftp-create-dirs -u "${USER}:${SFTP_PASS}" \
    -T "$1" "sftp://${HOST}:${PORT}$2"
}

for t in "${TOOLS[@]}"; do
  spec="${MAP[$t]:-}"; [ -z "$spec" ] && { echo "!! unknown gateway '$t' (skipped)"; continue; }
  IFS='|' read -r SRC DIR VHOST <<<"$spec"
  APP="/home/${USER}/${DIR}"
  echo "==> Deploying ${t}  (${SRC} -> ${APP})"
  if ! up "${SRC}/server.js" "${APP}/server.js"; then echo "   !! server.js upload failed for ${t}"; continue; fi
  if [ -f "${SRC}/public/overlay.js" ]; then up "${SRC}/public/overlay.js" "${APP}/public/overlay.js" || echo "   ~ overlay.js upload skipped/failed"; fi
  # restart Passenger
  TMP="$(mktemp)"; date > "$TMP"; up "$TMP" "${APP}/tmp/restart.txt" >/dev/null 2>&1 || true; rm -f "$TMP"
  sleep 3
  CODE="$(curl -s -o /dev/null -w '%{http_code}' "https://${VHOST}/" || echo 000)"
  if [ "$CODE" = "403" ]; then echo "   ✓ ${VHOST} live (403 block page = lease required)";
  elif [ "$CODE" = "000" ]; then echo "   ~ ${VHOST} no response (subdomain may not exist yet) — skip if unused";
  else echo "   ~ ${VHOST} returned HTTP ${CODE} (check .htaccess SetEnv / Passenger)"; fi
done
echo "==> Gateway deploy pass complete."
echo "    Reminder: set DETECT_LOGGED_OUT=1 in the writehuman1 + ryne1 public_html/.htaccess SetEnv block."
