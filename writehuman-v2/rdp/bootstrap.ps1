#requires -Version 5.1
<#
  WriteHuman V2 - RDP bootstrap / provisioner (IDEMPOTENT).

  Provisions a fresh (or existing) Windows box to run the Cookie Sync Agent 24/7:
    - installs Node 22 (if missing)
    - deploys the agent + launcher scripts into $InstallDir
    - registers scheduled tasks: agent (SYSTEM/ONSTART), chrome-debug (user/ONLOGON),
      watchdog (SYSTEM/every 5 min)
    - (optional) configures autologon via Sysinternals Autologon (-AdminPassword)

  Run in an ELEVATED PowerShell. Safe to re-run. Secrets are PARAMETERS - never committed.

  Migrate to a new RDP:
    git clone -b writehuman-v2-clone <repo>; cd writehuman-v2\rdp
    powershell -ExecutionPolicy Bypass -File bootstrap.ps1 -AgentKey <KEY> -AdminPassword <PW>
    then log into WriteHuman once in the Chrome that opens.
#>
param(
  [string]$AgentKey      = $env:WHV2_AGENT_KEY,
  [string]$IngestUrl     = 'https://api.genzdigitalstore.com/api/crm/proxy/agent/writehuman/cookies',
  [string]$CdpUrl        = 'http://127.0.0.1:9222',
  [string]$TargetDomain  = 'writehuman.ai',
  [string]$SupabaseRef   = 'hicfsbrfkzsxbwayibfm',
  [int]   $PollMs        = 60000,
  [string]$AdminUser     = 'administrator',
  [string]$AdminPassword,                       # only to (re)configure autologon; not stored/committed
  [string]$InstallDir    = 'C:\Projects\writehuman-v2',
  [string]$NodeDir       = 'C:\nodejs',
  [string]$ChromeProfile = 'C:\wh-profile',
  [switch]$SkipAutologon
)
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12
function Info($m){ Write-Host "[bootstrap] $m" }

# 0) Elevation + required inputs ------------------------------------------------
$admin = ([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([Security.Principal.WindowsBuiltinRole]::Administrator)
if(-not $admin){ throw 'Run this in an ELEVATED PowerShell (Administrator).' }
if(-not $AgentKey){ throw 'AgentKey required: pass -AgentKey <key> or set $env:WHV2_AGENT_KEY.' }

# 1) Node 22 (install if missing) ----------------------------------------------
$nodeDirEntry = Get-ChildItem $NodeDir -Directory -ErrorAction SilentlyContinue | Where-Object { Test-Path (Join-Path $_.FullName 'node.exe') } | Select-Object -First 1
if(-not $nodeDirEntry){
  Info 'Node not found - installing Node 22...'
  $shas = Invoke-RestMethod 'https://nodejs.org/dist/latest-v22.x/SHASUMS256.txt'
  $file = (($shas -split "`n") | Where-Object { $_ -match 'node-v22\.[0-9.]+-win-x64\.zip' } | Select-Object -First 1) -replace '.*\s(\S+)$','$1'
  $file = $file.Trim()
  $zip  = Join-Path $env:TEMP $file
  Invoke-WebRequest ("https://nodejs.org/dist/latest-v22.x/$file") -OutFile $zip
  # Verify the download against the official SHASUMS256 (integrity / supply-chain).
  $expected = ((($shas -split "`n") | Where-Object { $_ -match [Regex]::Escape($file) } | Select-Object -First 1) -replace '\s.*$','').Trim().ToLower()
  $actual = (Get-FileHash $zip -Algorithm SHA256).Hash.ToLower()
  if(-not $expected -or $actual -ne $expected){ Remove-Item $zip -Force -ErrorAction SilentlyContinue; throw "Node download checksum mismatch (expected '$expected', got '$actual')" }
  Info 'Node download checksum OK'
  New-Item -ItemType Directory -Force $NodeDir | Out-Null
  tar -xf $zip -C $NodeDir
  Remove-Item $zip -Force
  $nodeDirEntry = Get-ChildItem $NodeDir -Directory | Where-Object { Test-Path (Join-Path $_.FullName 'node.exe') } | Select-Object -First 1
  $mp = [Environment]::GetEnvironmentVariable('Path','Machine')
  if($mp -notlike "*$($nodeDirEntry.FullName)*"){ [Environment]::SetEnvironmentVariable('Path', ($mp.TrimEnd(';')+';'+$nodeDirEntry.FullName), 'Machine') }
}
$nodeExe = Join-Path $nodeDirEntry.FullName 'node.exe'
Info ("Node: " + (& $nodeExe --version))

# 2) Deploy agent + rdp scripts into $InstallDir -------------------------------
$repoRoot = Split-Path $PSScriptRoot -Parent          # ...\writehuman-v2
New-Item -ItemType Directory -Force (Join-Path $InstallDir 'agent') | Out-Null
New-Item -ItemType Directory -Force (Join-Path $InstallDir 'rdp')   | Out-Null
function Deploy($src,$dst){
  if(-not (Test-Path $src)){ return }
  $s = (Resolve-Path $src).Path
  $d = (Resolve-Path $dst -ErrorAction SilentlyContinue).Path
  if($s -ne $d){ Copy-Item $src $dst -Force }
}
Deploy (Join-Path $repoRoot 'agent\cookie-sync-agent.js') (Join-Path $InstallDir 'agent\cookie-sync-agent.js')
foreach($f in 'watchdog.ps1','status.ps1','uninstall.ps1','ensure-chrome-debug.ps1'){ Deploy (Join-Path $PSScriptRoot $f) (Join-Path $InstallDir "rdp\$f") }
Deploy (Join-Path $repoRoot 'test\soak-monitor.js') (Join-Path $InstallDir 'soak-monitor.js')

# 3) Machine config (non-secret) for status/watchdog ---------------------------
$healthUrl = ($IngestUrl -replace '^(https?://[^/]+).*$','$1/')  # origin reachability probe (agent ingest is POST-only + key-gated)
# Single config source: config.json holds ALL non-secret settings, read by BOTH the agent (via
# WHV2_CONFIG) and the watchdog. The secret agent key goes in a separate locked-down file.
$agentKeyFile = Join-Path $InstallDir 'agent.key'
[ordered]@{ installDir=$InstallDir; nodeExe=$nodeExe; ingestUrl=$IngestUrl; cdpUrl=$CdpUrl; domain=$TargetDomain; ref=$SupabaseRef; pollMs=$PollMs; chromeTask='WriteHumanChromeDebug'; agentKeyFile=$agentKeyFile; chromeProfile=$ChromeProfile; healthUrl=$healthUrl; adminUser=$AdminUser } |
  ConvertTo-Json | Set-Content (Join-Path $InstallDir 'rdp\config.json') -Encoding ASCII
# Agent key AT REST: written to a file locked to SYSTEM + Administrators only (icacls), so the secret
# is not sitting in the world-readable launcher/config. The agent reads it via WHV2_AGENT_KEY_FILE.
Set-Content -Path $agentKeyFile -Value $AgentKey -Encoding ASCII -NoNewline
try { & icacls $agentKeyFile /inheritance:r /grant:r 'SYSTEM:R' 'Administrators:R' | Out-Null; Info 'Wrote locked-down agent.key (SYSTEM + Administrators read-only).' } catch { Info 'WARNING: could not restrict agent.key ACL.' }

# 4) Launchers (resolved paths + config) ---------------------------------------
# Auto-detect Chrome (Program Files, x86, per-user LocalAppData, then the App Paths registry) so a
# fresh box "just works" regardless of how Chrome was installed.
$chromeExe = @(
  "$env:ProgramFiles\Google\Chrome\Application\chrome.exe",
  "${env:ProgramFiles(x86)}\Google\Chrome\Application\chrome.exe",
  "$env:LOCALAPPDATA\Google\Chrome\Application\chrome.exe"
) | Where-Object { $_ -and (Test-Path $_) } | Select-Object -First 1
if(-not $chromeExe){ try { $chromeExe = (Get-ItemProperty 'HKLM:\SOFTWARE\Microsoft\Windows\CurrentVersion\App Paths\chrome.exe' -ErrorAction Stop).'(default)' } catch {} }
if(-not $chromeExe){ $chromeExe = 'C:\Program Files\Google\Chrome\Application\chrome.exe'; Info 'WARNING: Chrome not auto-detected; using the default path. Install Chrome or edit chrome-debug.cmd.' }
Info ("Chrome: " + $chromeExe)
# chrome-debug.cmd is now a THIN WRAPPER around ensure-chrome-debug.ps1, which is self-verifying and
# idempotent: it no-ops when CDP 9222 is already up, else kills stray Chrome, clears a stale profile
# lock, launches Chrome WITH --remote-debugging-port + the anti-throttle flags (these keep the
# WriteHuman tab's Supabase auto-refresh timer alive when the desktop is locked/occluded so the token
# is rotated before expiry), then POLLS until the debug port actually opens and retries. Every trigger
# (ONLOGON task, watchdog, and the agent's 'relaunch-chrome') routes through this, so a no-flag Chrome
# owning the profile — the usual "cdp: fetch failed" cause — now self-heals instead of looping.
$ensurePs1 = Join-Path $InstallDir 'rdp\ensure-chrome-debug.ps1'
$chromeCmd = "@echo off`r`npowershell -NoProfile -ExecutionPolicy Bypass -File `"$ensurePs1`"`r`n"
Set-Content (Join-Path $InstallDir 'chrome-debug.cmd') $chromeCmd -Encoding ASCII -NoNewline
# Launcher now just points the agent at the config + the locked key file (no plaintext secret in it).
$cfgPath = Join-Path $InstallDir 'rdp\config.json'
$runCmd = "@echo off`r`nset `"WHV2_CONFIG=$cfgPath`"`r`nset `"WHV2_AGENT_KEY_FILE=$agentKeyFile`"`r`n`"$nodeExe`" `"$InstallDir\agent\cookie-sync-agent.js`" >> `"$InstallDir\agent.log`" 2>&1`r`n"
Set-Content (Join-Path $InstallDir 'run-agent.cmd') $runCmd -Encoding ASCII -NoNewline

# 5) Scheduled tasks (idempotent: end + delete + recreate) ---------------------
$user = "$env:COMPUTERNAME\$AdminUser"
function Reset-Task($name){ cmd /c "schtasks /end /tn $name >nul 2>&1"; cmd /c "schtasks /delete /tn $name /f >nul 2>&1" }
Reset-Task 'WriteHumanV2Agent'
& schtasks /create /tn WriteHumanV2Agent     /tr ("cmd /c "+$InstallDir+"\run-agent.cmd")   /sc ONSTART /ru SYSTEM /rl HIGHEST /f | Out-Null
# Harden the agent task to native Windows service semantics (no third-party supervisor):
#  - MultipleInstances IgnoreNew  → OS-level single-instance (belt to the agent's own port lock)
#  - RestartCount/RestartInterval → auto-restart on crash (node exits 1) every 1 min, up to 999x
#  - ExecutionTimeLimit 0         → never force-killed (it's a daemon)
# schtasks can't set these, so apply them via the ScheduledTasks module after creation.
try {
  $agS = New-ScheduledTaskSettingsSet -MultipleInstances IgnoreNew -RestartCount 999 -RestartInterval (New-TimeSpan -Minutes 1) -ExecutionTimeLimit ([TimeSpan]::Zero) -StartWhenAvailable
  $agS.DisallowStartIfOnBatteries = $false; $agS.StopIfGoingOnBatteries = $false
  Set-ScheduledTask -TaskName WriteHumanV2Agent -Settings $agS | Out-Null
  Info 'Agent task hardened: single-instance + auto-restart-on-crash + no time limit.'
} catch { Info 'WARNING: could not apply hardened task settings (agent still runs on boot).' }
Reset-Task 'WriteHumanChromeDebug'
& schtasks /create /tn WriteHumanChromeDebug /tr ("cmd /c "+$InstallDir+"\chrome-debug.cmd") /sc ONLOGON /ru $user /rl HIGHEST /f | Out-Null
Reset-Task 'WriteHumanWatchdog'
& schtasks /create /tn WriteHumanWatchdog    /tr ("powershell -NoProfile -ExecutionPolicy Bypass -File "+$InstallDir+"\rdp\watchdog.ps1") /sc MINUTE /mo 5 /ru SYSTEM /rl HIGHEST /f | Out-Null
# taskkill any orphaned node agent from a prior run before the fresh /run below
Get-CimInstance Win32_Process -Filter "name='node.exe'" -ErrorAction SilentlyContinue | Where-Object { $_.CommandLine -match 'cookie-sync-agent' } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }
Info 'Tasks registered: WriteHumanV2Agent, WriteHumanChromeDebug, WriteHumanWatchdog'

# 6) Autologon (optional; needs -AdminPassword) --------------------------------
if($AdminPassword -and -not $SkipAutologon){
  $alDir = Join-Path $InstallDir 'AutoLogon'
  $al    = Join-Path $alDir 'Autologon64.exe'
  if(-not (Test-Path $al)){
    New-Item -ItemType Directory -Force $alDir | Out-Null
    $z = Join-Path $env:TEMP 'AutoLogon.zip'
    Invoke-WebRequest 'https://download.sysinternals.com/files/AutoLogon.zip' -OutFile $z
    Expand-Archive $z -DestinationPath $alDir -Force; Remove-Item $z -Force
  }
  & $al -accepteula $AdminUser $env:COMPUTERNAME $AdminPassword | Out-Null
  $aal = (Get-ItemProperty 'HKLM:\SOFTWARE\Microsoft\Windows NT\CurrentVersion\Winlogon' -ErrorAction SilentlyContinue).AutoAdminLogon
  if($aal -eq '1'){ Info "Autologon: CONFIGURED (user=$AdminUser)" } else { Info "Autologon: FAILED (check the password)"; }
} else {
  Info 'Autologon: skipped (pass -AdminPassword to enable).'
}

# 7) Start the agent now -------------------------------------------------------
& schtasks /run /tn WriteHumanV2Agent | Out-Null
Info 'Bootstrap complete.'
Info 'First-time setup: log into WriteHuman ONCE in the Chrome that chrome-debug.cmd opens (run it, or log on).'
Info "Status any time:  powershell -File $InstallDir\rdp\status.ps1"
