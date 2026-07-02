#requires -Version 5.1
<#
  WriteHuman V2 — RDP bootstrap / provisioner (IDEMPOTENT).

  Provisions a fresh (or existing) Windows box to run the Cookie Sync Agent 24/7:
    - installs Node 22 (if missing)
    - deploys the agent + launcher scripts into $InstallDir
    - registers scheduled tasks: agent (SYSTEM/ONSTART), chrome-debug (user/ONLOGON),
      watchdog (SYSTEM/every 5 min)
    - (optional) configures autologon via Sysinternals Autologon (-AdminPassword)

  Run in an ELEVATED PowerShell. Safe to re-run. Secrets are PARAMETERS — never committed.

  Migrate to a new RDP:
    git clone -b writehuman-v2-clone <repo>; cd writehuman-v2\rdp
    powershell -ExecutionPolicy Bypass -File bootstrap.ps1 -AgentKey <KEY> -AdminPassword <PW>
    then log into WriteHuman once in the Chrome that opens.
#>
param(
  [string]$AgentKey      = $env:WHV2_AGENT_KEY,
  [string]$IngestUrl     = 'https://writehuman2.genzdigitalstore.com/v2/cookies/ingest',
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
  Info 'Node not found — installing Node 22...'
  $shas = Invoke-RestMethod 'https://nodejs.org/dist/latest-v22.x/SHASUMS256.txt'
  $file = (($shas -split "`n") | Where-Object { $_ -match 'node-v22\.[0-9.]+-win-x64\.zip' } | Select-Object -First 1) -replace '.*\s(\S+)$','$1'
  $file = $file.Trim()
  $zip  = Join-Path $env:TEMP $file
  Invoke-WebRequest ("https://nodejs.org/dist/latest-v22.x/$file") -OutFile $zip
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
foreach($f in 'watchdog.ps1','status.ps1','uninstall.ps1'){ Deploy (Join-Path $PSScriptRoot $f) (Join-Path $InstallDir "rdp\$f") }
Deploy (Join-Path $repoRoot 'test\soak-monitor.js') (Join-Path $InstallDir 'soak-monitor.js')

# 3) Machine config (non-secret) for status/watchdog ---------------------------
$healthUrl = ($IngestUrl -replace '/cookies/ingest$','/health')
[ordered]@{ installDir=$InstallDir; nodeExe=$nodeExe; ingestUrl=$IngestUrl; cdpUrl=$CdpUrl; chromeProfile=$ChromeProfile; healthUrl=$healthUrl; adminUser=$AdminUser } |
  ConvertTo-Json | Set-Content (Join-Path $InstallDir 'rdp\config.json') -Encoding ASCII

# 4) Launchers (resolved paths + config) ---------------------------------------
$chromeExe = 'C:\Program Files\Google\Chrome\Application\chrome.exe'
if(-not (Test-Path $chromeExe)){ $chromeExe = 'C:\Program Files (x86)\Google\Chrome\Application\chrome.exe' }
$chromeCmd = "@echo off`r`ntaskkill /im chrome.exe /f >nul 2>&1`r`nping -n 3 127.0.0.1 >nul`r`nstart `"`" `"$chromeExe`" --user-data-dir=`"$ChromeProfile`" --remote-debugging-port=9222 --no-first-run --no-default-browser-check https://$TargetDomain`r`n"
Set-Content (Join-Path $InstallDir 'chrome-debug.cmd') $chromeCmd -Encoding ASCII -NoNewline
$runCmd = "@echo off`r`nset `"WHV2_INGEST_URL=$IngestUrl`"`r`nset `"WHV2_AGENT_KEY=$AgentKey`"`r`nset `"WHV2_CDP_URL=$CdpUrl`"`r`nset `"WHV2_TARGET_DOMAIN=$TargetDomain`"`r`nset `"WHV2_SUPABASE_REF=$SupabaseRef`"`r`nset `"WHV2_POLL_MS=$PollMs`"`r`n`"$nodeExe`" `"$InstallDir\agent\cookie-sync-agent.js`" >> `"$InstallDir\agent.log`" 2>&1`r`n"
Set-Content (Join-Path $InstallDir 'run-agent.cmd') $runCmd -Encoding ASCII -NoNewline

# 5) Scheduled tasks (idempotent: delete + recreate) ---------------------------
$user = "$env:COMPUTERNAME\$AdminUser"
& schtasks /delete /tn WriteHumanV2Agent /f     2>&1 | Out-Null
& schtasks /create /tn WriteHumanV2Agent     /tr ("cmd /c "+$InstallDir+"\run-agent.cmd")   /sc ONSTART /ru SYSTEM /rl HIGHEST /f | Out-Null
& schtasks /delete /tn WriteHumanChromeDebug /f 2>&1 | Out-Null
& schtasks /create /tn WriteHumanChromeDebug /tr ("cmd /c "+$InstallDir+"\chrome-debug.cmd") /sc ONLOGON /ru $user /rl HIGHEST /f | Out-Null
& schtasks /delete /tn WriteHumanWatchdog /f    2>&1 | Out-Null
& schtasks /create /tn WriteHumanWatchdog    /tr ("powershell -NoProfile -ExecutionPolicy Bypass -File "+$InstallDir+"\rdp\watchdog.ps1") /sc MINUTE /mo 5 /ru SYSTEM /rl HIGHEST /f | Out-Null
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
