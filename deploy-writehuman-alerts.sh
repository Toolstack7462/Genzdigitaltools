#!/usr/bin/env bash
# Alert-email config: proxyTools.js + healthAlerts.js. Delegates to the SHA-256-verified deployer.
set -euo pipefail
cd "$(dirname "$0")"
exec bash deploy-backend.sh backend/routes/admin/proxyTools.js backend/utils/proxy/healthAlerts.js
