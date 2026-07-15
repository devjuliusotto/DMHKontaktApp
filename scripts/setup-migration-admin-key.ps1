#requires -Version 7.0

[CmdletBinding()]
param(
  [string]$Subject = 'CN=AgendaKontakte Migration Admin 2026',
  [string]$PublicKeyOutput = (Join-Path $PSScriptRoot '..\src-tauri\migration-public-key.json')
)

$ErrorActionPreference = 'Stop'

$certificate = Get-ChildItem Cert:\CurrentUser\My |
  Where-Object { $_.Subject -eq $Subject -and $_.HasPrivateKey } |
  Sort-Object NotBefore -Descending |
  Select-Object -First 1

if (-not $certificate) {
  $certificate = New-SelfSignedCertificate `
    -Type Custom `
    -Subject $Subject `
    -FriendlyName 'AgendaKontakte Migration - Verwaltungs-PC' `
    -KeyAlgorithm RSA `
    -KeyLength 3072 `
    -HashAlgorithm SHA256 `
    -KeyExportPolicy NonExportable `
    -KeyUsage KeyEncipherment, DataEncipherment `
    -CertStoreLocation 'Cert:\CurrentUser\My' `
    -NotAfter (Get-Date).AddYears(3)
}

$rsa = [System.Security.Cryptography.X509Certificates.RSACertificateExtensions]::GetRSAPublicKey($certificate)
$parameters = $rsa.ExportParameters($false)
$publicConfiguration = [ordered]@{
  keyId = $certificate.Thumbprint.ToUpperInvariant()
  modulus = [Convert]::ToBase64String($parameters.Modulus)
  exponent = [Convert]::ToBase64String($parameters.Exponent)
  subject = $certificate.Subject
  notAfter = $certificate.NotAfter.ToUniversalTime().ToString('o')
}

$resolvedOutput = [IO.Path]::GetFullPath($PublicKeyOutput)
$outputDirectory = Split-Path -Parent $resolvedOutput
[IO.Directory]::CreateDirectory($outputDirectory) | Out-Null
$publicConfiguration | ConvertTo-Json -Depth 3 | Set-Content -LiteralPath $resolvedOutput -Encoding utf8NoBOM

Write-Host "Administrativer Schlüssel ist eingerichtet." -ForegroundColor Green
Write-Host "Fingerabdruck: $($certificate.Thumbprint)"
Write-Host "Öffentliche Konfiguration: $resolvedOutput"
Write-Warning 'Der private Schlüssel ist nicht exportierbar. Ohne diesen Windows-Benutzer und diesen PC können vorhandene Pakete nicht entschlüsselt werden.'

