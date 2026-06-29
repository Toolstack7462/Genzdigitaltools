# ── Install the WriteHuman V2 Cookie Sync Agent as a Windows service (NSSM) ──────
# Preferred option: a true auto-start service that restarts the agent if it ever exits.
# Requires nssm.exe (https://nssm.cc/download) in PATH or beside this script.
# Run this in an ELEVATED PowerShell (Run as Administrator).
#
#   powershell -ExecutionPolicy Bypass -File install-service.ps1 -AgentKey "<WRITEHUMAN_V2_AGENT_KEY>"
#
param(
  [string]$AgentKey = "PUT-AGENT-KEY-HERE",
  [string]$IngestUrl = "https://writehuman2.genzdigitalstore.com/v2/cookies/ingest",
  [string]$CdpUrl = "http://127.0.0.1:9222",
  [int]$PollMs = 120000,
  [string]$ServiceName = "WriteHumanV2Agent"
)
$ErrorActionPreference = "Stop"

$node = (Get-Command node -ErrorAction Stop).Source
$agent = (Resolve-Path (Join-Path $PSScriptRoot "..\cookie-sync-agent.js")).Path
$agentDir = Split-Path $agent

$nssm = (Get-Command nssm -ErrorAction SilentlyContinue).Source
if (-not $nssm) { $nssm = Join-Path $PSScriptRoot "nssm.exe" }
if (-not (Test-Path $nssm)) { throw "nssm.exe not found. Download from https://nssm.cc/download and put it in PATH or beside this script." }

Write-Host "Installing service '$ServiceName' -> $node $agent"
# Remove any prior install (ignore errors), then install fresh.
& $nssm stop $ServiceName 2>$null | Out-Null
& $nssm remove $ServiceName confirm 2>$null | Out-Null

& $nssm install $ServiceName "$node" "`"$agent`""
& $nssm set $ServiceName AppDirectory "$agentDir"
& $nssm set $ServiceName AppEnvironmentExtra `
    "WHV2_INGEST_URL=$IngestUrl" `
    "WHV2_AGENT_KEY=$AgentKey" `
    "WHV2_CDP_URL=$CdpUrl" `
    "WHV2_TARGET_DOMAIN=writehuman.ai" `
    "WHV2_SUPABASE_REF=hicfsbrfkzsxbwayibfm" `
    "WHV2_POLL_MS=$PollMs"
& $nssm set $ServiceName Start SERVICE_AUTO_START
& $nssm set $ServiceName AppStdout (Join-Path $PSScriptRoot "agent.out.log")
& $nssm set $ServiceName AppStderr (Join-Path $PSScriptRoot "agent.err.log")
& $nssm set $ServiceName AppRotateFiles 1
& $nssm set $ServiceName AppRotateBytes 1048576
& $nssm set $ServiceName AppExit Default Restart
& $nssm set $ServiceName AppRestartDelay 5000
& $nssm start $ServiceName

Write-Host "Done. '$ServiceName' is installed and started (auto-start, auto-restart)."
Write-Host "Logs: $PSScriptRoot\agent.out.log / agent.err.log"
Write-Host "Manage: nssm restart $ServiceName  |  nssm stop $ServiceName  |  nssm remove $ServiceName confirm"
