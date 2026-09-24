[CmdletBinding()]
param()

$ErrorActionPreference = "Stop"
$isAdministrator = ([Security.Principal.WindowsPrincipal] [Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole(
  [Security.Principal.WindowsBuiltInRole]::Administrator
)
if (-not $isAdministrator) {
  throw "Execute este script em uma sessão elevada do PowerShell."
}

$projectRoot = Split-Path -Parent $PSScriptRoot
$certificatePath = Join-Path $projectRoot "certificates\public\Diakonissenmutterhaus-Aidlingen-Internal-Code-Signing.cer"
if (-not (Test-Path -LiteralPath $certificatePath -PathType Leaf)) {
  throw "Certificado público não encontrado em '$certificatePath'."
}

Import-Certificate -FilePath $certificatePath -CertStoreLocation "Cert:\LocalMachine\Root" | Out-Null
Import-Certificate -FilePath $certificatePath -CertStoreLocation "Cert:\LocalMachine\TrustedPublisher" | Out-Null

$certificate = Get-PfxCertificate -FilePath $certificatePath
$thumbprint = $certificate.Thumbprint
if (-not (Test-Path "Cert:\LocalMachine\Root\$thumbprint")) {
  throw "O certificado não foi encontrado em Trusted Root Certification Authorities após a importação."
}
if (-not (Test-Path "Cert:\LocalMachine\TrustedPublisher\$thumbprint")) {
  throw "O certificado não foi encontrado em Trusted Publishers após a importação."
}

[PSCustomObject]@{
  Thumbprint = $thumbprint
  TrustedRoot = $true
  TrustedPublisher = $true
} | Format-List
