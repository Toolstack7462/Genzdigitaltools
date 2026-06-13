#!/bin/bash

# ============================================================================
# Gen Z Digital Store CRM Backend Startup Script
# ============================================================================
# This script ensures the Node.js CRM backend starts properly

cd /app/backend

# Install dependencies if node_modules doesn't exist
if [ ! -d "node_modules" ]; then
    echo "📦 Installing Node.js dependencies..."
    yarn install
fi

# Start the CRM backend
echo "🚀 Starting Gen Z Digital Store CRM Backend..."
node server-crm.js
