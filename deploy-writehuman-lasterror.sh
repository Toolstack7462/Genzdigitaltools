#!/usr/bin/env bash
# Sticky last-error: agentSync.js + proxyTools.js. Delegates to the SHA-256-verified deployer.
set -euo pipefail
cd "$(dirname "$0")"
exec bash deploy-backend.sh backend/routes/proxy/agentSync.js backend/routes/admin/proxyTools.js
