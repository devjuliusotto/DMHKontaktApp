[CmdletBinding()]
param(
  [Parameter(Mandatory)]
  [ValidateScript({ Test-Path -LiteralPath $_ -PathType Leaf })]
  [string[]]$ArtifactPath,

  [string]$CertificateThumbprint = $env:DMH_CODE_SIGNING_CERT_THUMBPRINT
)

$ErrorActionPreference = "Stop"
$subject = "CN=Diakonissenmutterhaus Aidlingen Internal Code Signing"

function Get-SignToolPath {
  $kitsRoot = (Get-ItemProperty "HKLM:\SOFTWARE\Microsoft\Windows Kits\Installed Roots" -ErrorAction Stop).KitsRoot10
  if ([string]::IsNullOrWhiteSpace($kitsRoot)) {
    throw "O Windows SDK 10 não foi encontrado no registro."
  }

  $candidate = Get-ChildItem -Path (Join-Path $kitsRoot "bin") -Filter "signtool.exe" -Recurse -ErrorAction SilentlyContinue |
    Where-Object { $_.FullName -match "\\x64\\signtool\.exe$" } |
    Sort-Object FullName -Descending |
    Select-Object -First 1
  if ($null -eq $candidate) {
    throw "signtool.exe x64 não foi encontrado no Windows SDK em '$kitsRoot'."
  }
  return $candidate.FullName
}

if ([string]::IsNullOrWhiteSpace($CertificateThumbprint)) {
  $certificate = @(Get-ChildItem Cert:\CurrentUser\My -CodeSigningCert |
    Where-Object { $_.Subject -eq $subject -and $_.HasPrivateKey } |
    Sort-Object NotAfter -Descending |
    Select-Object -First 1)
  if ($certificate.Count -eq 0) {
    throw "Nenhum certificado de Code Signing utilizável foi encontrado em Cert:\CurrentUser\My para '$subject'."
  }
  $CertificateThumbprint = $certificate[0].Thumbprint
} else {
  $CertificateThumbprint = $CertificateThumbprint -replace "\s", ""
  $certificate = Get-Item "Cert:\CurrentUser\My\$CertificateThumbprint" -ErrorAction Stop
}

if (-not $certificate.HasPrivateKey) {
  throw "O certificado selecionado não possui chave privada."
}
if ($certificate.NotAfter -le (Get-Date)) {
  throw "O certificado selecionado expirou em $($certificate.NotAfter.ToString('u'))."
}

$signTool = Get-SignToolPath
foreach ($artifact in $ArtifactPath) {
  $resolvedArtifact = (Resolve-Path -LiteralPath $artifact).Path
  & $signTool sign /sha1 $CertificateThumbprint /fd SHA256 /v $resolvedArtifact
  if ($LASTEXITCODE -ne 0) {
    throw "A assinatura falhou para '$resolvedArtifact' (signtool exit code $LASTEXITCODE)."
  }
}
