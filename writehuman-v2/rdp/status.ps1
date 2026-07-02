#requires -Version 5.1
<# WriteHuman V2 - one-shot status report for the RDP runtime. Read-only. #>
$ErrorActionPreference = 'SilentlyContinue'
$cfg = Get-Content (Join-Path $PSScriptRoot 'config.json') | ConvertFrom-Json

Write-Host "==== WriteHuman V2 - RDP status ===="
Write-Host ("Node        : " + (& $cfg.nodeExe --version))
foreach($n in 'WriteHumanV2Agent','WriteHumanChromeDebug','WriteHumanWatchdog'){
  $t = Get-ScheduledTask -TaskName $n -ErrorAction SilentlyContinue
  Write-Host ("Task        : {0,-22} {1}" -f $n, $(if($t){$t.State}else{'MISSING'}))
}
$cdp = try { (Invoke-WebRequest ($cfg.cdpUrl + '/json/version') -UseBasicParsing -TimeoutSec 5).StatusCode } catch { 'DOWN' }
Write-Host ("CDP 9222    : " + $cdp)
Write-Host ("wh-profile  : " + (Test-Path $cfg.chromeProfile))
$aal = (Get-ItemProperty 'HKLM:\SOFTWARE\Microsoft\Windows NT\CurrentVersion\Winlogon' -ErrorAction SilentlyContinue).AutoAdminLogon
Write-Host ("Autologon   : " + $(if($aal -eq '1'){'ON'}else{'OFF'}))
try {
  $h = Invoke-RestMethod $cfg.healthUrl -TimeoutSec 15
  Write-Host ("V2 account  : status={0} session={1} verify={2} agentStale={3}" -f $h.account.status,$h.account.sessionStatus,$h.account.verificationResult,$h.account.agentStale)
  Write-Host ("V2 lastSync : " + $h.account.lastSyncedAt + "  (syncCount=" + $h.account.syncCount + ")")
} catch { Write-Host "V2 health   : UNREACHABLE" }
$logf = Join-Path $cfg.installDir 'agent.log'
if(Test-Path $logf){ Write-Host "---- agent.log (tail) ----"; Get-Content $logf -Tail 5 }
