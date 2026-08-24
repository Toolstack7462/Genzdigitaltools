# WriteHuman Universal Cookie Sync Agent - installer for ANY authorised Windows machine.
#
# The same package on the local PC, RDP-01, or any future approved RDP. Nothing about the machine
# is baked in: the agent pairs once with a code from the admin panel and stores its own identity.
#
# ASCII ONLY. Windows PowerShell 5.1 reads this file as ANSI, so a non-ASCII character (an em dash
# is the usual culprit) is silently mangled into a smart quote and breaks the parse.
#
#   Install:          powershell -ExecutionPolicy Bypass -File install-universal-agent.ps1 -SyncKey <PROXY_AGENT_SYNC_KEY>
#   (legacy pairing:   ... -PairCode ABCDE-FGHIJ   - still supported, no longer required)
#   Status:           powershell -File install-universal-agent.ps1 -Status
#   Uninstall:        powershell -File install-universal-agent.ps1 -Uninstall
#
# DELIBERATELY DOES NOT TOUCH CHROME. On a personal machine the agent must never close the browser
# you are using, and a fresh --user-data-dir would NOT carry your existing WriteHuman login. Chrome
# is started by you (see -ShowChromeCommand); this installer only manages the agent.

[CmdletBinding()]
param(
  [string]$SyncKey = '',
  [string]$PairCode = '',
  [string]$DeviceName = $env:COMPUTERNAME,
  [string]$InstallDir = "$env:LOCALAPPDATA\WriteHumanAgent",
  [string]$IngestUrl = 'https://api.genzdigitalstore.com/api/crm/proxy/agent/writehuman/cookies',
  [string]$CdpUrl = 'http://127.0.0.1:9222',
  [string]$ChromeProfile = '',
  [int]$DebugPort = 9222,
  [switch]$Status,
  [switch]$Uninstall,
  [switch]$ShowChromeCommand
)

$ErrorActionPreference = 'Stop'
$TaskName = 'WriteHumanUniversalAgent'
$AgentSrc = Join-Path $PSScriptRoot 'cookie-sync-agent.js'

function Write-Step($m) { Write-Host "==> $m" }
function Fail($m) { Write-Host "ERROR: $m" -ForegroundColor Red; exit 1 }

function Get-NodeExe {
  $c = Get-Command node -ErrorAction SilentlyContinue
  if ($c) { return $c.Source }
  foreach ($p in @("$env:ProgramFiles\nodejs\node.exe", "C:\nodejs\node.exe")) {
    if (Test-Path $p) { return $p }
  }
  return $null
}

# ---------------------------------------------------------------- status
if ($Status) {
  Write-Step "Agent install directory: $InstallDir"
  if (-not (Test-Path $InstallDir)) { Write-Host '  not installed'; exit 0 }
  $devFile = Join-Path $InstallDir 'agent-device.json'
  if (Test-Path $devFile) {
    $d = Get-Content $devFile -Raw | ConvertFrom-Json
    # The device KEY is never printed - only the id and name, which are not secret.
    Write-Host "  paired: deviceId=$($d.deviceId) name=$($d.name) seq=$($d.seq)"
  } else { Write-Host '  not paired yet (run with -PairCode)' }

  $t = Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue
  if ($t) { Write-Host "  task: $($t.State)" } else { Write-Host '  task: not registered' }
  $procs = @(Get-CimInstance Win32_Process -Filter "Name='node.exe'" |
             Where-Object { $_.CommandLine -like '*cookie-sync-agent.js*' })
  Write-Host "  running agent processes: $($procs.Count)   (exactly 1 is correct)"
  $lock = Join-Path $InstallDir 'agent.lock'
  if (Test-Path $lock) { Write-Host "  lock: $(Get-Content $lock -Raw)" }
  $log = Join-Path $InstallDir 'agent.log'
  if (Test-Path $log) { Write-Host "  log: $log ($([math]::Round((Get-Item $log).Length/1KB)) KB)" }
  exit 0
}

# ------------------------------------------------------------- uninstall
if ($Uninstall) {
  Write-Step "Removing scheduled task $TaskName"
  cmd /c "schtasks /end /tn $TaskName >nul 2>&1"
  cmd /c "schtasks /delete /tn $TaskName /f >nul 2>&1"
  Write-Step 'Stopping any running agent'
  Get-CimInstance Win32_Process -Filter "Name='node.exe'" |
    Where-Object { $_.CommandLine -like '*cookie-sync-agent.js*' } |
    ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }
  Write-Host ''
  Write-Host "The install directory was KEPT: $InstallDir"
  Write-Host 'It holds agent-device.json (this machine pairing). Delete it only if you also intend'
  Write-Host 'to revoke this device in the admin panel - otherwise the pairing is orphaned.'
  Write-Host 'Uninstalling does NOT affect the stored WriteHuman session; a revoked or removed'
  Write-Host 'device loses the right to push cookies, it does not sign anyone out.'
  exit 0
}

# --------------------------------------------------------- chrome command
if ($ShowChromeCommand) {
  $profileDir = if ($ChromeProfile) { $ChromeProfile } else { "$env:LOCALAPPDATA\WriteHumanChrome" }
  Write-Host 'Start Chrome yourself with a debug port, then sign in to WriteHuman normally:'
  Write-Host ''
  Write-Host "  chrome.exe --user-data-dir=`"$profileDir`" --remote-debugging-port=$DebugPort ``"
  Write-Host '    --disable-background-timer-throttling --disable-backgrounding-occluded-windows ``'
  Write-Host '    --disable-renderer-backgrounding https://writehuman.ai'
  Write-Host ''
  Write-Host 'Notes:'
  Write-Host " - The debug port binds to 127.0.0.1 only. Do not expose $DebugPort to the network:"
  Write-Host '   it is unauthenticated, so anyone who can reach it can read every cookie in that profile.'
  Write-Host ' - A --user-data-dir that is ALREADY open ignores these flags and no debug port appears.'
  Write-Host '   Use a profile that is not currently running, or close that profile first.'
  Write-Host " - Then set -ChromeProfile `"$profileDir`" so the agent refuses to read any other profile."
  exit 0
}

# ---------------------------------------------------------------- install
$node = Get-NodeExe
if (-not $node) { Fail 'Node.js not found. Install Node 22 or newer, then re-run.' }
$ver = (& $node -v).TrimStart('v')
if ([int]($ver.Split('.')[0]) -lt 22) { Fail "Node $ver is too old - the agent needs a global WebSocket (Node 22+)." }
if (-not (Test-Path $AgentSrc)) { Fail "cookie-sync-agent.js not found next to this script ($AgentSrc)" }

Write-Step "Installing to $InstallDir (node $ver)"
New-Item -ItemType Directory -Force -Path $InstallDir | Out-Null
Copy-Item $AgentSrc (Join-Path $InstallDir 'cookie-sync-agent.js') -Force

# Non-secret settings only. The device key lives in agent-device.json, never here.
$cfg = [ordered]@{
  ingestUrl       = $IngestUrl
  cdpUrl          = $CdpUrl
  deviceName      = $DeviceName
  chromeProfile   = $ChromeProfile
  deviceStateFile = (Join-Path $InstallDir 'agent-device.json') -replace '\\','/'
  lockFile        = (Join-Path $InstallDir 'agent.lock') -replace '\\','/'
  agentKeyDpapiFile = (Join-Path $InstallDir 'agent.key.dpapi') -replace '\\','/'
  pollMs          = 300000
}
# Set-Content -Encoding Ascii: a UTF-8/BOM file makes cmd and JSON.parse fail in ways that produce
# no error output at all. This has cost hours before.
$cfg | ConvertTo-Json | Set-Content -Path (Join-Path $InstallDir 'config.json') -Encoding Ascii

# ---- shared sync key, protected with DPAPI (CurrentUser) -------------------
# ConvertFrom-SecureString encrypts with the Windows user's own DPAPI master key, so the file is
# useless to any other account on this machine and useless if copied to another machine - strictly
# better than a plaintext file whose only defence is an ACL. The key is never echoed, never written
# into config.json, and never placed on a command line.
if ($SyncKey) {
  $keyPath = Join-Path $InstallDir 'agent.key.dpapi'
  ConvertTo-SecureString -String $SyncKey -AsPlainText -Force | ConvertFrom-SecureString |
    Set-Content -Path $keyPath -Encoding Ascii
  icacls $keyPath /inheritance:r /grant:r "$($env:USERNAME):R" | Out-Null
  Write-Step "Sync key stored DPAPI-protected at $keyPath"
  # Prove it round-trips NOW, rather than finding out at the first poll that it cannot be decrypted.
  $chk  = ConvertTo-SecureString ((Get-Content -Raw $keyPath).Trim())
  $bstr = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($chk)
  if ([Runtime.InteropServices.Marshal]::PtrToStringBSTR($bstr) -eq $SyncKey) { Write-Host '    verified: decrypts back correctly' }
  else { Fail 'the DPAPI key file did not round-trip - refusing to continue' }
} elseif (-not (Test-Path (Join-Path $InstallDir 'agent.key.dpapi'))) {
  Write-Host '    NOTE: no -SyncKey given and none stored, so the agent cannot sync yet.' -ForegroundColor Yellow
  Write-Host '          Re-run with -SyncKey <PROXY_AGENT_SYNC_KEY> (from hPanel).'
}

$runCmd = @"
@echo off
set WHV2_CONFIG=$InstallDir\config.json
"$node" "$InstallDir\cookie-sync-agent.js" >> "$InstallDir\agent.log" 2>&1
"@
$runCmd | Set-Content -Path (Join-Path $InstallDir 'run-agent.cmd') -Encoding Ascii

# ------------------------------------------------------------------ pair
if ($PairCode) {
  Write-Step "Pairing as $DeviceName"
  $env:WHV2_CONFIG = Join-Path $InstallDir 'config.json'
  $env:WHV2_PAIR_CODE = $PairCode
  $env:WHV2_DEVICE_NAME = $DeviceName
  # One foreground run: it redeems the code, writes agent-device.json, then starts polling.
  # Give it a few seconds and stop it; the scheduled task owns it from here.
  $p = Start-Process -FilePath $node -ArgumentList "`"$InstallDir\cookie-sync-agent.js`"" -PassThru -WindowStyle Hidden `
        -RedirectStandardOutput (Join-Path $InstallDir 'pair.log') -RedirectStandardError (Join-Path $InstallDir 'pair.err')
  Start-Sleep -Seconds 8
  Stop-Process -Id $p.Id -Force -ErrorAction SilentlyContinue
  $env:WHV2_PAIR_CODE = ''
  if (Test-Path (Join-Path $InstallDir 'agent-device.json')) {
    Write-Host '    paired OK'
    # Owner-only ACL on the device secret.
    icacls (Join-Path $InstallDir 'agent-device.json') /inheritance:r /grant:r "$($env:USERNAME):R" | Out-Null
  } else {
    Write-Host '    PAIRING DID NOT COMPLETE - see pair.log / pair.err' -ForegroundColor Yellow
    Write-Host '    Common causes: the code expired (15 min), was already used, or the ingest URL is wrong.'
  }
}

# ------------------------------------------------------------- auto-start
# A per-user LOGON task. Deliberately not SYSTEM and not a service on a personal machine: the agent
# only ever needs to reach a loopback debug port in the user's own session, and running it with more
# privilege than that buys nothing. -MultipleInstances IgnoreNew plus the agent's own PID+heartbeat
# lock file give two independent guarantees of a single instance.
Write-Step "Registering logon task $TaskName"
cmd /c "schtasks /delete /tn $TaskName /f >nul 2>&1"
$action  = New-ScheduledTaskAction -Execute 'cmd.exe' -Argument "/c `"$InstallDir\run-agent.cmd`""
$trigger = New-ScheduledTaskTrigger -AtLogOn -User $env:USERNAME
$set     = New-ScheduledTaskSettingsSet -MultipleInstances IgnoreNew -RestartCount 999 -RestartInterval (New-TimeSpan -Minutes 1) `
             -ExecutionTimeLimit (New-TimeSpan -Seconds 0) -StartWhenAvailable -DontStopIfGoingOnBatteries -AllowStartIfOnBatteries
Register-ScheduledTask -TaskName $TaskName -Action $action -Trigger $trigger -Settings $set -RunLevel Limited | Out-Null

Write-Host ''
Write-Host 'Installed.' -ForegroundColor Green
Write-Host "  agent version : 3.1.0"
Write-Host "  directory     : $InstallDir"
Write-Host "  log           : $InstallDir\agent.log"
Write-Host "  identity      : $InstallDir\agent-device.json (device key, owner-only)"
Write-Host "  auto-start    : scheduled task '$TaskName' at logon, restarts every 1 min on failure"
Write-Host "  single copy   : task IgnoreNew + PID/heartbeat lock ($InstallDir\agent.lock)"
Write-Host ''
Write-Host 'Next:'
Write-Host '  1. Start Chrome with a debug port:  -ShowChromeCommand'
Write-Host '  2. Sign in to WriteHuman in that window.'
Write-Host "  3. Start the agent now:  schtasks /run /tn $TaskName"
Write-Host '  4. It registers itself on first sync - no pairing code and no approval step.'
Write-Host ''
Write-Host 'The agent never signs in for you and never launches Chrome. It reads only the WriteHuman'
Write-Host 'auth cookies from the profile you point it at, and nothing else.'
