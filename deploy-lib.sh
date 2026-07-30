#!/usr/bin/env bash
# Reusable Hostinger SFTP deploy helpers — reliable, VERIFIED transfers.
#
# WHY THIS EXISTS: a single `curl -T f1 url1 -T f2 url2` multi-file transfer over SFTP was found to
# SILENTLY DROP a file while still succeeding overall (exit 0) — deploys reported SUCCESS but the
# server kept running old code. These helpers upload ONE file per curl and then download it back and
# compare SHA-256, so a dropped/partial upload fails LOUDLY instead of a false success.
#
# Usage:  source deploy-lib.sh ;  requires SFTP_PASS in the environment.
set -uo pipefail

HOST="${DEPLOY_HOST:-147.79.103.253}"
PORT="${DEPLOY_PORT:-65002}"
SUSER="${DEPLOY_USER:-u171982351}"
# Passenger serves `.builds/current/nodejs` (see PassengerAppRoot in the live
# public_html/.htaccess). `nodejs/` is a stale copy nothing reads — uploading there is a
# silent no-op that looks like a successful deploy. Verified 2026-07-30.
API_ROOT="${DEPLOY_API_ROOT:-/home/${SUSER}/domains/api.genzdigitalstore.com/.builds/current/nodejs}"
API_BASE="${DEPLOY_API_BASE:-https://api.genzdigitalstore.com}"

[[ -z "${SFTP_PASS:-}" ]] && { echo "FATAL: SFTP_PASS is not set"; return 1 2>/dev/null || exit 1; }

_curl(){ curl -sS --connect-timeout 25 --max-time 120 --fail-with-body -u "${SUSER}:${SFTP_PASS}" "$@"; }

sftp_prep(){
  ssh-keygen -R "[${HOST}]:${PORT}" >/dev/null 2>&1 || true
  ssh-keyscan -t rsa -p "${PORT}" "${HOST}" >> ~/.ssh/known_hosts 2>/dev/null || true
}

# put_verified <local-file> <remote-absolute-path>
# Uploads ONE file, downloads it back, compares SHA-256. Returns non-zero (loudly) on any mismatch.
put_verified(){
  local local_f="$1" remote="$2"
  [[ -f "$local_f" ]] || { echo "FATAL: local file missing: $local_f"; return 3; }
  local url="sftp://${HOST}:${PORT}${remote}"
  if ! _curl -T "$local_f" "$url"; then echo "FATAL: upload failed: $local_f -> $remote"; return 3; fi
  local tmp; tmp="$(mktemp)"
  if ! _curl "$url" -o "$tmp"; then echo "FATAL: verify-download failed: $remote"; rm -f "$tmp"; return 3; fi
  local a b; a="$(sha256sum < "$local_f" | cut -d' ' -f1)"; b="$(sha256sum < "$tmp" | cut -d' ' -f1)"
  rm -f "$tmp"
  if [[ "$a" != "$b" ]]; then echo "FATAL: VERIFY MISMATCH for $remote"; echo "  local  sha256=$a"; echo "  server sha256=$b"; return 4; fi
  echo "  ✓ landed + verified: $(basename "$local_f") ($(wc -c < "$local_f") bytes)"
}

# bump_restart — writes a fresh Passenger restart trigger (itself verified).
bump_restart(){
  local t; t="$(mktemp)"; date -u +"restart %Y-%m-%dT%H:%M:%SZ" > "$t"
  if put_verified "$t" "${API_ROOT}/tmp/restart.txt" >/dev/null; then echo "  ✓ restart triggered"; rm -f "$t"; return 0
  else echo "FATAL: could not write restart trigger"; rm -f "$t"; return 3; fi
}

# wait_boot — poll until the API answers (unauth extension-scan returns a known code when up).
wait_boot(){
  local i b
  for i in $(seq 1 10); do
    sleep 5
    b="$(curl -s -m 10 -X POST "${API_BASE}/api/crm/extension/security-scan" -H 'Content-Type: application/json' -d '{}' || true)"
    echo "$b" | grep -q extension_token_invalid && { echo "  ✓ boot OK (~$((i*5))s)"; return 0; }
  done
  echo "FATAL: app did not come back up"; return 5
}
