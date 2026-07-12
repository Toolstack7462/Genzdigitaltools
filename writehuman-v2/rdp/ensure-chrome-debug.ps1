#requires -Version 5.1
<#
  WriteHuman V2 - robust debug-Chrome launcher (self-verifying + idempotent).

  Runs in the INTERACTIVE USER session (invoked by the WriteHumanChromeDebug task, which is
  triggered ONLOGON, by the watchdog when CDP is down, and by the agent's 'relaunch-chrome'
  auto-recovery). Chrome needs a desktop to render, so this must NOT run as SYSTEM directly.

  Safe to run repeatedly:
    - if CDP 9222 already answers -> DOES NOTHING (never disturbs a healthy session)
    - otherwise -> kill stray Chrome, clear a stale profile lock, launch Chrome WITH
      --remote-debugging-port + the anti-throttle flags, then POLL until the port actually
      opens; retry up to 3 times.

  This fixes the common "cdp: fetch failed" root cause: a normal (no-flag) Chrome already owns
  the --user-data-dir, so Chrome silently IGNORES --remote-debugging-port on the next launch and
  the debug port is never opened. Killing first + verifying the port guarantees a debug endpoint.

  Non-secret settings are read from rdp\config.json (chromeExe, chromeProfile, cdpUrl, domain);
  each has a safe fallback so the script still works if config.json is missing. ASCII-only (PS5.1).
#>
$ErrorActionPreference = 'SilentlyContinue'

$cfg = try { Get-Content (Join-Path $PSScriptRoot 'config.json') -Raw | ConvertFrom-Json } catch { $null }
$installDir    = if ($cfg -and $cfg.installDir)    { $cfg.installDir }    else { 'C:\Projects\writehuman-v2' }
$cdpUrl        = if ($cfg -and $cfg.cdpUrl)        { $cfg.cdpUrl }        else { 'http://127.0.0.1:9222' }
$chromeProfile = if ($cfg -and $cfg.chromeProfile) { $cfg.chromeProfile } else { 'C:\wh-profile' }
$domain        = if ($cfg -and $cfg.domain)        { $cfg.domain }        else { 'writehuman.ai' }
$chromeExe     = if ($cfg -and $cfg.chromeExe)     { $cfg.chromeExe }     else { $null }

$verUrl = ($cdpUrl.TrimEnd('/') + '/json/version')
$port = 9222; if ($cdpUrl -match ':(\d+)') { $port = [int]$Matches[1] }

function Log($m){ try { Add-Content (Join-Path $installDir 'chrome-debug.log') ("[" + (Get-Date -Format o) + "] " + $m) } catch {} }
function Test-CdpUp { param([int]$TimeoutSec = 4)
  try { return ((Invoke-WebRequest $verUrl -UseBasicParsing -TimeoutSec $TimeoutSec).StatusCode -eq 200) } catch { return $false }
}

# 0) Already healthy? No-op so a working session is never disturbed.
if (Test-CdpUp 5) { Log ("CDP already up on " + $port + " - no action"); exit 0 }

# Resolve chrome.exe (config first, then the usual install locations, then App Paths).
if (-not $chromeExe -or -not (Test-Path $chromeExe)) {
  $chromeExe = @(
    "$env:ProgramFiles\Google\Chrome\Application\chrome.exe",
    "${env:ProgramFiles(x86)}\Google\Chrome\Application\chrome.exe",
    "$env:LOCALAPPDATA\Google\Chrome\Application\chrome.exe"
  ) | Where-Object { $_ -and (Test-Path $_) } | Select-Object -First 1
  if (-not $chromeExe) { try { $chromeExe = (Get-ItemProperty 'HKLM:\SOFTWARE\Microsoft\Windows\CurrentVersion\App Paths\chrome.exe' -ErrorAction Stop).'(default)' } catch {} }
}
if (-not $chromeExe -or -not (Test-Path $chromeExe)) { Log 'FATAL: chrome.exe not found'; exit 1 }

# Anti-throttle flags keep the WriteHuman tab's Supabase auto-refresh timer running when the RDP
# desktop is locked / the window is occluded, so the browser rotates the access token before it
# expires (the agent then syncs the fresh cookie). --disable-session-crashed-bubble avoids the
# "restore pages?" bubble after we force-kill Chrome (Chrome treats a kill as a crash).
$chromeArgs = @(
  "--user-data-dir=$chromeProfile",
  "--remote-debugging-port=$port",
  '--no-first-run', '--no-default-browser-check',
  '--disable-background-timer-throttling', '--disable-backgrounding-occluded-windows',
  '--disable-renderer-backgrounding', '--disable-session-crashed-bubble',
  "https://$domain"
)

for ($attempt = 1; $attempt -le 3; $attempt++) {
  Log ("relaunch attempt " + $attempt + " (CDP down on port " + $port + ")")
  # Kill ALL chrome so the debug flag can't be ignored by a process already holding the profile.
  taskkill /im chrome.exe /f 2>$null | Out-Null
  Start-Sleep -Seconds 2
  # Clear a stale single-instance lock so the fresh launch owns the profile.
  foreach ($lk in 'SingletonLock','SingletonCookie','SingletonSocket','lockfile') {
    Remove-Item (Join-Path $chromeProfile $lk) -Force -ErrorAction SilentlyContinue
  }
  Start-Process -FilePath $chromeExe -ArgumentList $chromeArgs | Out-Null
  # Poll up to ~24s for the debug port to actually open.
  for ($i = 0; $i -lt 12; $i++) {
    Start-Sleep -Seconds 2
    if (Test-CdpUp 3) { Log ("CDP up after attempt " + $attempt + " (~" + ($i * 2) + "s)"); exit 0 }
  }
  Log ("attempt " + $attempt + " did not open CDP " + $port + "; retrying")
}
Log 'ERROR: CDP still down after 3 attempts (is a desktop session active? is the profile locked by another user?)'
exit 1
