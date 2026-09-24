[CmdletBinding()]
param()

$ErrorActionPreference = "Stop"
$encodedPfx = $env:DMH_WINDOWS_CODESIGN_PFX_BASE64
$passwordText = $env:DMH_WINDOWS_CODESIGN_PFX_PASSWORD
if ([string]::IsNullOrWhiteSpace($encodedPfx) -or [string]::IsNullOrWhiteSpace($passwordText)) {
  throw "DMH_WINDOWS_CODESIGN_PFX_BASE64 e DMH_WINDOWS_CODESIGN_PFX_PASSWORD são obrigatórios."
}

$temporaryPfx = Join-Path ([IO.Path]::GetTempPath()) ("dmh-code-signing-" + [guid]::NewGuid().ToString("N") + ".pfx")
try {
  [IO.File]::WriteAllBytes($temporaryPfx, [Convert]::FromBase64String($encodedPfx))
  $password = ConvertTo-SecureString $passwordText -AsPlainText -Force
  $certificate = Import-PfxCertificate -FilePath $temporaryPfx -CertStoreLocation "Cert:\CurrentUser\My" -Password $password
  if (-not $certificate.HasPrivateKey) {
    throw "O PFX importado não contém uma chave privada utilizável."
  }
  [PSCustomObject]@{
    Subject = $certificate.Subject
    Thumbprint = $certificate.Thumbprint
    NotAfter = $certificate.NotAfter
  } | Format-List
} finally {
  Remove-Item -LiteralPath $temporaryPfx -Force -ErrorAction SilentlyContinue
}
