#!/usr/bin/env bash
# proxyTools.js (agent version flag etc.). Delegates to the SHA-256-verified deployer.
set -euo pipefail
cd "$(dirname "$0")"
exec bash deploy-backend.sh backend/routes/admin/proxyTools.js
