#requires -Version 5.1
<#
  WriteHuman V2 - one-shot CDP fix, to run ONCE on the RDP (elevated PowerShell) after pulling the
  latest repo. It does everything so the operator only pastes a single command:

    1. Deploys the self-verifying launcher (ensure-chrome-debug.ps1) into the live install and
       rewrites chrome-debug.cmd to the wrapper -> from now on the ONLOGON task, the watchdog, and
       the agent's 'relaunch-chrome' all self-heal.
    2. Heals immediately: kills a no-flag Chrome, relaunches WITH --remote-debugging-port, and
       verifies port 9222 actually opens.
    3. Prints the result. No secrets / no agent key needed.

  Safe to re-run (ensure-chrome-debug.ps1 no-ops if CDP is already up). ASCII-only (PS5.1).
  Usage:  powershell -ExecutionPolicy Bypass -File writehuman-v2\rdp\fix-cdp-now.ps1
          (optional) -InstallDir C:\Projects\writehuman-v2
#>
param([string]$InstallDir = 'C:\Projects\writehuman-v2')
$ErrorActionPreference = 'Stop'
function Info($m){ Write-Host "[fix-cdp] $m" }

$srcEnsure = Join-Path $PSScriptRoot 'ensure-chrome-debug.ps1'
if (-not (Test-Path $srcEnsure)) { throw "ensure-chrome-debug.ps1 not found next to this script ($srcEnsure). Pull the latest repo first (git checkout main; git pull)." }

# 1) Deploy the self-healing launcher into the live install (makes the fix permanent) ----------
$rdpDir = Join-Path $InstallDir 'rdp'
$ensureRun = $srcEnsure
if (Test-Path $rdpDir) {
  Copy-Item $srcEnsure (Join-Path $rdpDir 'ensure-chrome-debug.ps1') -Force
  $ensureRun = Join-Path $rdpDir 'ensure-chrome-debug.ps1'
  $wrapper = "@echo off`r`npowershell -NoProfile -ExecutionPolicy Bypass -File `"$ensureRun`"`r`n"
  Set-Content (Join-Path $InstallDir 'chrome-debug.cmd') $wrapper -Encoding ASCII -NoNewline
  Info "Deployed launcher + rewrote chrome-debug.cmd (watchdog / logon / agent now self-heal)."
} else {
  Info "NOTE: install dir '$InstallDir' not found - healing from the repo copy only. Re-run bootstrap.ps1 for a full install."
}

# 2) Heal now -----------------------------------------------------------------------------------
Info "Relaunching debug Chrome and verifying CDP 9222 (this closes open Chrome windows to reclaim the profile)..."
& powershell -NoProfile -ExecutionPolicy Bypass -File $ensureRun

# 3) Verify -------------------------------------------------------------------------------------
$cdpUrl = 'http://127.0.0.1:9222'
try { $cfg = Get-Content (Join-Path $rdpDir 'config.json') -Raw | ConvertFrom-Json; if ($cfg.cdpUrl) { $cdpUrl = $cfg.cdpUrl } } catch {}
$code = try { (Invoke-WebRequest ($cdpUrl.TrimEnd('/') + '/json/version') -UseBasicParsing -TimeoutSec 5).StatusCode } catch { 0 }
if ($code -eq 200) {
  Info "SUCCESS: CDP $cdpUrl is UP (200). The agent clears 'cdp: fetch failed' within one poll (<=60s)."
  Info "If the dashboard still shows an error after ~1 min, log into WriteHuman ONCE in the Chrome that just opened (so the sb-* auth cookies exist)."
} else {
  Info "STILL DOWN: CDP not answering. Most likely there is NO active desktop session (Autologon OFF) so GUI Chrome cannot run."
  Info "Check: powershell -File `"$rdpDir\status.ps1`"  (expect 'CDP 9222 : 200' and 'Autologon : ON')."
}
exit $(if ($code -eq 200) { 0 } else { 1 })
