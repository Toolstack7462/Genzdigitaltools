# ── Alternative: run the Cookie Sync Agent via a Windows Scheduled Task ──────────
# No extra software needed (no NSSM). Runs run-agent.cmd at logon, keeps it running, and
# restarts it on failure. Edit run-agent.cmd FIRST (set WHV2_AGENT_KEY), then run elevated:
#
#   powershell -ExecutionPolicy Bypass -File register-task.ps1
#
param(
  [string]$TaskName = "WriteHumanV2Agent",
  [string]$RunAs = "$env:USERDOMAIN\$env:USERNAME"
)
$ErrorActionPreference = "Stop"

$cmd = (Resolve-Path (Join-Path $PSScriptRoot "run-agent.cmd")).Path
$action  = New-ScheduledTaskAction -Execute "cmd.exe" -Argument "/c `"$cmd`""
$trigger = New-ScheduledTaskTrigger -AtLogOn
# Keep it alive: restart on failure every minute indefinitely; no execution time limit.
$settings = New-ScheduledTaskSettingsSet -StartWhenAvailable `
  -RestartCount 999 -RestartInterval (New-TimeSpan -Minutes 1) `
  -ExecutionTimeLimit (New-TimeSpan -Seconds 0) -DontStopOnIdleEnd -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries

Register-ScheduledTask -TaskName $TaskName -Action $action -Trigger $trigger -Settings $settings `
  -RunLevel Highest -User $RunAs -Force

Start-ScheduledTask -TaskName $TaskName
Write-Host "Registered + started scheduled task '$TaskName'."
Write-Host "Manage: Start-ScheduledTask $TaskName | Stop-ScheduledTask $TaskName | Unregister-ScheduledTask $TaskName"
