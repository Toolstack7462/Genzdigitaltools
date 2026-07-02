#requires -Version 5.1
<#
  WriteHuman V2 - teardown. Removes the scheduled tasks; optionally disables autologon and
  purges files. Use before migrating a box or decommissioning it.
    -DisableAutologon : set AutoAdminLogon=0 (does not remove the LSA secret)
    -Purge            : also delete C:\Projects\writehuman-v2 and C:\wh-profile
#>
param([switch]$Purge, [switch]$DisableAutologon)
$ErrorActionPreference = 'SilentlyContinue'
foreach($n in 'WriteHumanV2Agent','WriteHumanChromeDebug','WriteHumanWatchdog'){
  & schtasks /end /tn $n 2>&1 | Out-Null
  & schtasks /delete /tn $n /f 2>&1 | Out-Null
  Write-Host "removed task: $n"
}
taskkill /im chrome.exe /f 2>&1 | Out-Null
if($DisableAutologon){
  Set-ItemProperty 'HKLM:\SOFTWARE\Microsoft\Windows NT\CurrentVersion\Winlogon' -Name AutoAdminLogon -Value '0'
  Write-Host 'autologon disabled (AutoAdminLogon=0)'
}
if($Purge){
  Remove-Item 'C:\Projects\writehuman-v2' -Recurse -Force
  Remove-Item 'C:\wh-profile' -Recurse -Force
  Write-Host 'purged install dir + chrome profile'
}
Write-Host 'Uninstall complete.'
