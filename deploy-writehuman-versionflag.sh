#!/usr/bin/env bash
# proxyTools.js (agent version flag etc.). Delegates to the SHA-256-verified deployer.
set -euo pipefail
cd "$(dirname "$0")"
# proxyTools.js / agentSync.js require() the multi-device modules at module load, so they
# must ship together or Passenger boots into "Cannot find module" (whole API down).
exec bash deploy-backend.sh backend/routes/admin/proxyTools.js backend/utils/proxy/deviceSync.js backend/utils/proxy/candidateSync.js backend/utils/proxy/agentEnroll.js backend/utils/proxy/sessionHealth.js
