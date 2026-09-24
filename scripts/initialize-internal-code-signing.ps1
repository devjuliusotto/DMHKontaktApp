[CmdletBinding()]
param(
  [ValidateSet("CurrentUser", "Password")]
  [string]$PfxProtection = "CurrentUser",

  [ValidatePattern('^[^\\/:*?"<>|]+\.pfx$')]
  [string]$PfxFileName = "Diakonissenmutterhaus-Aidlingen-Internal-Code-Signing.pfx"
)

$ErrorActionPreference = "Stop"

$subject = "CN=Diakonissenmutterhaus Aidlingen Internal Code Signing"
$projectRoot = Split-Path -Parent $PSScriptRoot
$publicDirectory = Join-Path $projectRoot "certificates\public"
$privateDirectory = Join-Path $projectRoot "certificates\private"
$publicCertificatePath = Join-Path $publicDirectory "Diakonissenmutterhaus-Aidlingen-Internal-Code-Signing.cer"
$pfxPath = Join-Path $privateDirectory $PfxFileName

$certificate = @(Get-ChildItem Cert:\CurrentUser\My -CodeSigningCert |
  Where-Object { $_.Subject -eq $subject } |
  Sort-Object NotAfter -Descending |
  Select-Object -First 1)

if ($certificate.Count -eq 0) {
  $certificate = New-SelfSignedCertificate `
    -Type CodeSigningCert `
    -Subject $subject `
    -CertStoreLocation "Cert:\CurrentUser\My" `
    -KeyAlgorithm RSA `
    -KeyLength 3072 `
    -HashAlgorithm SHA256 `
    -KeyExportPolicy Exportable `
    -NotAfter (Get-Date).AddYears(5)
} else {
  $certificate = $certificate[0]
}

New-Item -ItemType Directory -Force -Path $publicDirectory, $privateDirectory | Out-Null
Export-Certificate -Cert $certificate -FilePath $publicCertificatePath -Force | Out-Null

if (Test-Path -LiteralPath $pfxPath) {
  throw "O backup PFX já existe em '$pfxPath'. Ele não será sobrescrito automaticamente."
}

if ($PfxProtection -eq "Password") {
  $password = Read-Host -Prompt "Defina a senha do backup PFX (ela não será gravada)" -AsSecureString
  Export-PfxCertificate -Cert $certificate -FilePath $pfxPath -Password $password -CryptoAlgorithmOption TripleDES_SHA1 | Out-Null
} else {
  $currentUser = [Security.Principal.WindowsIdentity]::GetCurrent().Name
  Export-PfxCertificate -Cert $certificate -FilePath $pfxPath -ProtectTo $currentUser -CryptoAlgorithmOption TripleDES_SHA1 | Out-Null
}

[PSCustomObject]@{
  Subject = $certificate.Subject
  Thumbprint = $certificate.Thumbprint
  NotAfter = $certificate.NotAfter
  PublicCertificate = $publicCertificatePath
  ProtectedPfxBackup = $pfxPath
  PfxProtection = $PfxProtection
} | Format-List
