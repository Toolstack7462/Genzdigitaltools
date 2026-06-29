@echo off
REM ── WriteHuman V2 Cookie Sync Agent launcher ─────────────────────────────────
REM Edit the values below, then either run this directly or install it as a service
REM (install-service.ps1) or a scheduled task (register-task.ps1).

set "WHV2_INGEST_URL=https://writehuman2.genzdigitalstore.com/v2/cookies/ingest"
set "WHV2_AGENT_KEY=PUT-AGENT-KEY-HERE"
set "WHV2_CDP_URL=http://127.0.0.1:9222"
set "WHV2_TARGET_DOMAIN=writehuman.ai"
set "WHV2_SUPABASE_REF=hicfsbrfkzsxbwayibfm"
set "WHV2_POLL_MS=120000"

REM Run the agent (path is relative to this script: ..\cookie-sync-agent.js)
node "%~dp0..\cookie-sync-agent.js"
