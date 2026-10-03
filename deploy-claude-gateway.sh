#!/usr/bin/env bash
# Deploy the Claude reverse-proxy gateway to its OWN Hostinger Passenger app on the
# subdomain claude1.genzdigitalstore.com. Isolated by design: this script only ever writes
# under the Claude gateway server dir and NEVER touches proxy-gateway / grok-gateway /
# hix-gateway / stealth-gateway / the api backend / any other app.
#
# PREREQUISITES (one-time, done in hPanel — this script cannot do them):
#   1. Create the subdomain  claude1.genzdigitalstore.com  (DNS + vhost).
#   2. Write the subdomain's public_html/.htaccess Passenger block + SetEnv config
#      (see claude-gateway/README.md — LEASE_SECRET / GATEWAY_KEY must match the backend
#      PROXY_LEASE_SECRET / PROXY_GATEWAY_KEY, copied verbatim from any existing *1 gateway).
#      Delete any Hostinger default.php from the docroot.
#   Secrets live ONLY in that server-side .htaccess (or the app .env) — this script never
#   uploads secrets and never prints the password.
#
# USAGE:  SFTP_PASS='…' bash deploy-claude-gateway.sh
#   Overridable env: SERVER_DIR, VHOST, SFTP_HOST, SFTP_PORT, SFTP_USER
#
# Safe to re-run. Uploads code only; the server keeps its own .htaccess / .env.
set -uo pipefail

SFTP_HOST="${SFTP_HOST:-147.79.103.253}"
SFTP_PORT="${SFTP_PORT:-65002}"
SFTP_USER="${SFTP_USER:-u171982351}"
SERVER_DIR="${SERVER_DIR:-/home/${SFTP_USER}/claude-gateway}"
VHOST="${VHOST:-claude1.genzdigitalstore.com}"
: "${SFTP_PASS:?Set SFTP_PASS env (Hostinger SFTP password)}"

# Run from the repo root regardless of CWD, then into the gateway folder.
cd "$(dirname "$0")/claude-gateway"

# libssh2 needs the RSA host key present (it cannot use ed25519/ecdsa on this build).
ssh-keygen -R "[${SFTP_HOST}]:${SFTP_PORT}" >/dev/null 2>&1 || true
ssh-keyscan -t rsa -p "${SFTP_PORT}" "${SFTP_HOST}" >> ~/.ssh/known_hosts 2>/dev/null || true

# Runtime files only — NOT .env, node_modules, docs, or the .example template.
# EVERY lib/*.js that server.js require()s MUST ship or the gateway boots into
# "Cannot find module './lib/<name>'" and the whole Claude tool goes down:
#   lib/quotaTap.js     — token-quota tap
#   lib/effortPrefs.js  — default-effort preference (requires lib/effortPolicy.js)
#   lib/modelPolicy.js  — the Fable 5 model allowlist
#   lib/effortPolicy.js — the low|medium effort allowlist
#   lib/streamGuard.js  — the streamed-response budgets + terminating error frame
# The .test.js files are NOT shipped.
# ⚠ ADDING A NEW lib/ MODULE? Add it HERE in the same commit. This list is the one thing that
#   local tests cannot catch: everything passes locally and Passenger dies on boot.
FILES=(
  server.js package.json
  public/overlay.js public/overlay.css
  lib/quotaTap.js lib/effortPrefs.js lib/modelPolicy.js
  lib/effortPolicy.js lib/streamGuard.js
)

echo "==> Deploying Claude gateway  ->  ${SFTP_USER}@${SFTP_HOST}:${SERVER_DIR}  (vhost ${VHOST})"

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

# Restart Passenger by touching tmp/restart.txt (mtime change triggers a reload). Passenger
# only acts on the NEXT request after the bump, so poke the app a few times below.
TMP="$(mktemp)"; date +%s%N > "$TMP" 2>/dev/null || date > "$TMP"
curl -sS --ftp-create-dirs -u "${SFTP_USER}:${SFTP_PASS}" -T "$TMP" "sftp://${SFTP_HOST}:${SFTP_PORT}${SERVER_DIR}/tmp/restart.txt" >/dev/null 2>&1 || true
rm -f "$TMP"
echo "   ✓ restart triggered (tmp/restart.txt)"

# Verify: /__genz/health is a lease-free health route → 200 when up; / requires a lease → 403.
HCODE=000
for i in 1 2 3 4 5 6; do
  curl -s -o /dev/null "https://${VHOST}/__genz/health" >/dev/null 2>&1 || true   # poke → force reload
  sleep 3
  HCODE="$(curl -s -o /dev/null -w '%{http_code}' "https://${VHOST}/__genz/health" || echo 000)"
  [ "$HCODE" = "200" ] && break
done
ROOT="$(curl -s -o /dev/null -w '%{http_code}' "https://${VHOST}/" || echo 000)"
case "$HCODE" in
  200) if [ "$ROOT" = "403" ]; then echo "   ✓ https://${VHOST} live (health 200, / -> 403 lease-gated)"; else echo "   ~ health 200 but / returned ${ROOT} (expected 403 block/lease page) — check .htaccess SetEnv"; fi;;
  000) echo "   ~ no response yet (Passenger may still be restarting) — retry /__genz/health shortly";;
  502) echo "   ~ 502 — app not booting; check the subdomain .htaccess Passenger block + node path + Passenger logs";;
  *)   echo "   ~ /__genz/health returned HTTP ${HCODE} — check the app .env / .htaccess / Passenger logs";;
esac
# ── Did the upload actually take effect, on EVERY worker? ─────────────────────────────────────
# "health 200" only proves SOMETHING is up. It cannot distinguish a completed deploy from a
# Passenger worker still serving the previous code — and that ambiguity is expensive: a Cloudflare
# verification page on a MacBook or a phone looks identical whether the challenge-handling fix is
# live or was never picked up. server.js hashes the shipped file set and reports it at
# /__genz/health .build.id; `node server.js --build-id` computes the same value locally from the
# bytes we just uploaded (no .env needed). Equal ids = this exact code is live.
#
# Passenger runs several workers and bumping tmp/restart.txt retires them lazily, so poll a few
# times: each response also carries a short per-worker id, and a worker still on the old build
# shows up as a MISMATCHED id. Advisory only — never fails the deploy, since the code is already
# uploaded by this point and a false alarm here must not look like a failed release.
EXPECTED_ID="$(node server.js --build-id 2>/dev/null || echo '')"
if [ "$HCODE" = "200" ] && [ -n "$EXPECTED_ID" ]; then
  echo "==> Verifying build ${EXPECTED_ID} is live on every worker"
  WORKERS=""; MISMATCH=0; SEEN=0
  for i in 1 2 3 4 5 6 7 8; do
    J="$(curl -s -m 15 "https://${VHOST}/__genz/health" || echo '')"
    [ -n "$J" ] || continue
    # Parse with node (no jq on this box). Prints "<build.id> <worker>".
    PAIR="$(printf '%s' "$J" | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{try{const b=(JSON.parse(s).build)||{};console.log((b.id||"?")+" "+(b.worker||"?"))}catch(_){console.log("? ?")}})' 2>/dev/null || echo '? ?')"
    LID="${PAIR%% *}"; WID="${PAIR##* }"
    [ "$LID" = "?" ] && continue
    SEEN=$((SEEN+1))
    case " $WORKERS " in *" ${WID} "*) ;; *) WORKERS="${WORKERS} ${WID}";; esac
    if [ "$LID" != "$EXPECTED_ID" ]; then
      MISMATCH=1
      echo "   !! worker ${WID} is serving build ${LID}, expected ${EXPECTED_ID} — STALE WORKER"
    fi
  done
  NWORKERS="$(printf '%s' "$WORKERS" | wc -w | tr -d ' ')"
  if [ "$SEEN" = "0" ]; then
    echo "   ~ health did not report a build id (older gateway build, or /__genz/health unreachable)"
  elif [ "$MISMATCH" = "0" ]; then
    echo "   ✓ build ${EXPECTED_ID} live and consistent across ${NWORKERS} worker(s) seen in ${SEEN} polls"
  else
    echo "   ~ STALE WORKERS PRESENT. Re-bump the restart file and re-poll; if it persists, restart the"
    echo "     app from hPanel (Node.js app → Restart). Do NOT re-diagnose the gateway code until the"
    echo "     live build id matches ${EXPECTED_ID} — an old worker will reproduce old bugs."
  fi
fi

echo "==> Done. Next: in Admin → Proxy Tools → Claude, add an account (Capture via proxy so"
echo "    cf_clearance is minted in-context), then grant a client access to test an Open."
