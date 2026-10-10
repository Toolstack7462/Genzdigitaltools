# Enroll-SourceCredential.ps1
#
# Stores the MAIN WriteHuman account's email + password on the APPROVED WINDOWS
# SOURCE PC ONLY, protected with the Windows user's own DPAPI master key.
#
# WHY THIS EXISTS
#   The master credential is currently held only in the CRM `Tool` record, which is
#   the record designed to be handed to client extensions. That makes it unreachable
#   by the source-side Agent (by design - the Agent has no credential channel) and
#   historically reachable by clients (now closed). Source-side automatic re-login
#   needs the credential in a store that ONLY the source machine's own user account
#   can open, and that the server never holds.
#
# MECHANISM - identical to the idiom install-universal-agent.ps1 already uses for the
#   shared sync key (see its "shared sync key, protected with DPAPI" block):
#   ConvertFrom-SecureString encrypts with the logged-on Windows user's DPAPI master
#   key, so the file is useless to any other account on this machine and useless if
#   copied to another machine. The Agent runs as a PER-USER LOGON TASK as that same
#   user (install-universal-agent.ps1:186 - "deliberately not SYSTEM"), so it can
#   decrypt; nothing else can.
#
# SAFETY
#   - The password is NEVER a parameter: it is read interactively as a SecureString,
#     so it cannot land in shell history, argv, a process list, or a transcript.
#   - It is never echoed, never written to config.json, never sent to the server,
#     never logged. Only a MASKED form appears in the sidecar metadata.
#   - The vault is verified to round-trip before the script reports success.
#
# USAGE (run on the source PC, as the user the Agent runs as)
#   .\Enroll-SourceCredential.ps1              # enrol / replace
#   .\Enroll-SourceCredential.ps1 -Verify      # prove it still decrypts
#   .\Enroll-SourceCredential.ps1 -Remove      # delete the vault
#
[CmdletBinding()]
param(
  [string]$InstallDir = (Join-Path $env:LOCALAPPDATA 'GenZ\WriteHumanAgent'),
  [switch]$Verify,
  [switch]$Remove
)

$ErrorActionPreference = 'Stop'

function Write-Step($m) { Write-Host "[*] $m" -ForegroundColor Cyan }
function Fail($m) { Write-Host "[!] $m" -ForegroundColor Red; exit 1 }

if ($env:OS -ne 'Windows_NT') { Fail 'DPAPI is Windows-only; run this on the approved source PC.' }

$vaultPath = Join-Path $InstallDir 'source-credential.dpapi'
$metaPath  = Join-Path $InstallDir 'source-credential.meta.json'

function Read-Vault {
  if (-not (Test-Path $vaultPath)) { return $null }
  $enc = (Get-Content -Raw $vaultPath).Trim()
  if (-not $enc) { return $null }
  # Throws if this user / machine cannot decrypt - which is the desired behaviour.
  $sec  = ConvertTo-SecureString $enc
  $bstr = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($sec)
  try { $json = [Runtime.InteropServices.Marshal]::PtrToStringBSTR($bstr) }
  finally { [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($bstr) }
  return ($json | ConvertFrom-Json)
}

function Mask-Email($e) {
  if (-not $e) { return $null }
  $parts = $e.Split('@')
  if ($parts.Count -ne 2) { return '***' }
  $local = $parts[0]
  if ($local.Length -le 1) { $head = $local } else { $head = $local.Substring(0,1) }
  return ($head + '****@' + $parts[1])
}

# ---- -Remove ---------------------------------------------------------------
if ($Remove) {
  $did = $false
  foreach ($p in @($vaultPath, $metaPath)) {
    if (Test-Path $p) {
      # A vault written by an earlier read-only-ACL version cannot be deleted until
      # the owner grants themselves delete rights back.
      try { Remove-Item -Force $p }
      catch {
        icacls $p /grant:r "$($env:USERNAME):(F)" | Out-Null
        Remove-Item -Force $p
      }
      Write-Step "Removed $p"; $did = $true
    }
  }
  if (-not $did) { Write-Host '    Nothing to remove.' -ForegroundColor Yellow }
  Write-Host '[+] Source credential vault removed. Automatic re-login cannot run until re-enrolled.' -ForegroundColor Green
  exit 0
}

# ---- -Verify ---------------------------------------------------------------
if ($Verify) {
  if (-not (Test-Path $vaultPath)) { Fail "No vault at $vaultPath - run without -Verify to enrol." }
  try { $v = Read-Vault } catch { Fail "The vault exists but THIS user on THIS machine cannot decrypt it: $($_.Exception.Message)" }
  if (-not $v -or -not $v.email -or -not $v.password) { Fail 'The vault decrypted but is incomplete - re-enrol.' }
  Write-Host '[+] Vault decrypts correctly.' -ForegroundColor Green
  Write-Host "    account   : $(Mask-Email $v.email)"
  Write-Host "    password  : present ($($v.password.Length) characters, not shown)"
  Write-Host "    user      : $env:USERDOMAIN\$env:USERNAME"
  Write-Host "    machine   : $env:COMPUTERNAME"
  exit 0
}

# ---- enrol -----------------------------------------------------------------
if (-not (Test-Path $InstallDir)) {
  Write-Step "Creating $InstallDir"
  New-Item -ItemType Directory -Force -Path $InstallDir | Out-Null
}

Write-Host ''
Write-Host 'Enrolling the MAIN WriteHuman source credential.' -ForegroundColor White
Write-Host 'This is stored ONLY on this machine, for ONLY this Windows user.' -ForegroundColor White
Write-Host 'It is never uploaded, never logged, and never shown again.' -ForegroundColor White
Write-Host ''

$email = Read-Host 'WriteHuman account email'
if (-not $email -or $email -notmatch '^[^@\s]+@[^@\s]+\.[^@\s]+$') { Fail 'That does not look like an email address.' }

$pw1 = Read-Host 'WriteHuman account password' -AsSecureString
$pw2 = Read-Host 'Confirm password' -AsSecureString

function Secure-ToPlain($s) {
  $b = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($s)
  try { return [Runtime.InteropServices.Marshal]::PtrToStringBSTR($b) }
  finally { [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($b) }
}

$p1 = Secure-ToPlain $pw1
$p2 = Secure-ToPlain $pw2
if (-not $p1) { Fail 'Empty password.' }
if ($p1 -ne $p2) { Fail 'The two passwords do not match.' }

# One compact JSON document, DPAPI-encrypted as a single blob.
$payload = (@{ email = $email; password = $p1; enrolledAt = (Get-Date).ToUniversalTime().ToString('o') } | ConvertTo-Json -Compress)

ConvertTo-SecureString -String $payload -AsPlainText -Force | ConvertFrom-SecureString |
  Set-Content -Path $vaultPath -Encoding Ascii

# Strip inheritance and grant THIS USER ONLY, with read+write+delete so the owner can
# rotate or remove their own credential. (Read-only here would make -Remove and
# re-enrolment fail with "Access to the path is denied" - found by testing it.)
# DPAPI is the real protection; this ACL is defence-in-depth against other accounts.
icacls $vaultPath /inheritance:r /grant:r "$($env:USERNAME):(R,W,D)" | Out-Null
Write-Step "Vault written DPAPI-protected at $vaultPath"

# Prove it round-trips NOW rather than discovering at the first recovery that it cannot be read.
$check = Read-Vault
if (-not $check -or $check.email -ne $email -or $check.password -ne $p1) {
  Remove-Item -Force $vaultPath -ErrorAction SilentlyContinue
  Fail 'The vault did not round-trip - nothing was kept. Re-run as the user the Agent runs as.'
}
Write-Host '    verified: decrypts back correctly' -ForegroundColor Green

# Non-secret sidecar so an operator (and later the Agent's status report) can see
# WHAT is enrolled without the vault being opened. Masked email only.
@{
  maskedAccount = (Mask-Email $email)
  enrolledAt    = (Get-Date).ToUniversalTime().ToString('o')
  windowsUser   = "$env:USERDOMAIN\$env:USERNAME"
  machine       = $env:COMPUTERNAME
  protection    = 'DPAPI CurrentUser'
  vaultFile     = 'source-credential.dpapi'
} | ConvertTo-Json | Set-Content -Path $metaPath -Encoding Ascii
Write-Step "Metadata (masked, non-secret) at $metaPath"

# Clear the plaintext copies from this session's memory as promptly as PowerShell allows.
$p1 = $null; $p2 = $null; $payload = $null
[System.GC]::Collect()

Write-Host ''
Write-Host '[+] Enrolled.' -ForegroundColor Green
Write-Host "    account : $(Mask-Email $email)"
Write-Host "    scope   : $env:USERDOMAIN\$env:USERNAME on $env:COMPUTERNAME only"
Write-Host ''
Write-Host 'NOTE: nothing consumes this vault yet. Source-side automatic re-login is' -ForegroundColor Yellow
Write-Host 'not enabled until the Agent change is approved and built from the' -ForegroundColor Yellow
Write-Host 'authoritative v3.5.2 source. This vault is inert until then.' -ForegroundColor Yellow
