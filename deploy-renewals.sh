#!/usr/bin/env bash
# Renewals engine. Delegates to deploy-backend.sh so the upload is SHA-256 verified
# (the old inline multi-file curl transfer could silently drop the file).
set -euo pipefail
cd "$(dirname "$0")"
exec bash deploy-backend.sh backend/routes/admin/renewals.js
