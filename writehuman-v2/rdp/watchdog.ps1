#requires -Version 5.1
<#
  WriteHuman V2 — self-healing watchdog. Runs every 5 min (SYSTEM task).
    1. agent task not Running  -> start it
    2. CDP 9222 down + a user is logged on -> trigger the ChromeDebug task (relaunch Chrome
       in the user's session; SYSTEM can't render GUI itself)
    3. rotate agent.log if > 5 MB
  Read-only w.r.t. V2/production. Logs its own actions to watchdog.log.
#>
$ErrorActionPreference = 'SilentlyContinue'
$cfg = Get-Content (Join-Path $PSScriptRoot 'config.json') | ConvertFrom-Json
function Log($m){ Add-Content (Join-Path $cfg.installDir 'watchdog.log') ("[" + (Get-Date -Format o) + "] " + $m) }

# 1) agent alive?
$t = Get-ScheduledTask -TaskName WriteHumanV2Agent
if($t -and $t.State -ne 'Running'){ Start-ScheduledTask -TaskName WriteHumanV2Agent; Log "agent task was $($t.State) -> started" }

# 2) CDP up? (only fixable if someone is logged on — Chrome needs an interactive session)
$cdp = try { (Invoke-WebRequest ($cfg.cdpUrl + '/json/version') -UseBasicParsing -TimeoutSec 5).StatusCode } catch { 0 }
if($cdp -ne 200){
  $sessions = @(quser 2>$null)
  if($sessions.Count -gt 1){   # header + at least one session
    Start-ScheduledTask -TaskName WriteHumanChromeDebug
    Log 'CDP 9222 down + interactive session present -> triggered WriteHumanChromeDebug'
  } else {
    Log 'CDP 9222 down, no interactive session -> cannot relaunch Chrome (needs autologon/user session)'
  }
}

# 3) rotate the agent log
$logf = Join-Path $cfg.installDir 'agent.log'
if((Test-Path $logf) -and ((Get-Item $logf).Length -gt 5MB)){
  Move-Item $logf ($logf + '.1') -Force
  Log 'rotated agent.log (>5MB)'
}
