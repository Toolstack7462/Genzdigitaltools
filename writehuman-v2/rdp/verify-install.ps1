#requires -Version 5.1
<#
  WriteHuman - post-provision self-test. Green/red checks that the RDP agent box is set up right.
  Run:  powershell -ExecutionPolicy Bypass -File verify-install.ps1
  Exit 0 = all good, 1 = one or more checks failed. ASCII-only (PS5.1).
#>
$ErrorActionPreference = 'Continue'
$InstallDir = 'C:\Projects\writehuman-v2'
$pass = 0; $fail = 0
function Check($name, $ok, $detail) {
  if ($ok) { $script:pass++; Write-Host ("  [OK]  " + $name) }
  else { $script:fail++; Write-Host ("  [XX]  " + $name + $(if ($detail) { " -> " + $detail } else { "" })) }
}

Write-Host "== WriteHuman agent install self-test =="
$cfg = try { Get-Content (Join-Path $InstallDir 'rdp\config.json') -Raw | ConvertFrom-Json } catch { $null }
$nodeExe = if ($cfg -and $cfg.nodeExe) { $cfg.nodeExe } else { 'node' }
$nv = try { & $nodeExe --version } catch { $null }
Check ("Node present (" + $nv + ")") ($nv -match '^v\d+') $null
Check "Node >= 22 (global WebSocket)" ($nv -match '^v(2[2-9]|[3-9]\d)') "install Node 22+"

Check "config.json present" ($cfg -ne $null) "run bootstrap.ps1"
Check "agent.key present + readable" ($cfg -and $cfg.agentKeyFile -and (Test-Path $cfg.agentKeyFile)) $null
Check "agent script present" (Test-Path (Join-Path $InstallDir 'agent\cookie-sync-agent.js')) $null

foreach ($t in 'WriteHumanV2Agent', 'WriteHumanChromeDebug', 'WriteHumanWatchdog') {
  $st = try { (Get-ScheduledTask -TaskName $t -ErrorAction Stop).State } catch { $null }
  Check ("task " + $t + " registered") ($st -ne $null) "re-run bootstrap.ps1"
}

Check "agent (node) running" ((Get-Process node -ErrorAction SilentlyContinue | Measure-Object).Count -ge 1) "Start-ScheduledTask WriteHumanV2Agent"

$cdpUrl = if ($cfg -and $cfg.cdpUrl) { $cfg.cdpUrl } else { 'http://127.0.0.1:9222' }
$cdp = try { (Invoke-WebRequest ($cdpUrl + '/json/version') -UseBasicParsing -TimeoutSec 5).StatusCode } catch { 0 }
Check ("CDP reachable (" + $cdpUrl + ")") ($cdp -eq 200) "run chrome-debug.cmd + log into WriteHuman"
if ($cdp -ne 200) {
  # Pinpoint the usual cause: a Chrome is up but was launched WITHOUT --remote-debugging-port, so the
  # debug port was never opened and the agent reports 'cdp: fetch failed'.
  $withFlag = @(Get-CimInstance Win32_Process -Filter "name='chrome.exe'" -ErrorAction SilentlyContinue | Where-Object { $_.CommandLine -match 'remote-debugging-port' }).Count
  $anyChrome = @(Get-CimInstance Win32_Process -Filter "name='chrome.exe'" -ErrorAction SilentlyContinue).Count
  if ($anyChrome -gt 0 -and $withFlag -eq 0) {
    Write-Host "        -> Chrome is running WITHOUT --remote-debugging-port (a no-flag Chrome owns the profile)."
    Write-Host "           Fix: run ensure-chrome-debug.ps1 (kills + relaunches with the flag, verifies the port)."
  } elseif ($anyChrome -eq 0) {
    Write-Host "        -> No Chrome running. Ensure a desktop session is active (autologon) so the ONLOGON task can launch it."
  }
}

$logf = Join-Path $InstallDir 'agent.log'
$recent = if (Test-Path $logf) { (Get-Item $logf).LastWriteTime -gt (Get-Date).AddMinutes(-5) } else { $false }
Check "agent.log written in last 5 min" $recent "agent may be down or not posting"

Write-Host ("== RESULT: {0} passed, {1} failed ==" -f $pass, $fail)
exit $(if ($fail -eq 0) { 0 } else { 1 })
