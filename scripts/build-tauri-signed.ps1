[CmdletBinding()]
param()

$ErrorActionPreference = "Stop"
$projectRoot = Split-Path -Parent $PSScriptRoot
$targetDirectory = Join-Path $env:TEMP "agendakontakte-cargo-target"
$signScript = Join-Path $PSScriptRoot "sign-windows-artifact.ps1"

Push-Location $projectRoot
try {
  $env:CARGO_TARGET_DIR = $targetDirectory
  & npx.cmd tauri build
  $tauriExitCode = $LASTEXITCODE

  $bundleDirectory = Join-Path $targetDirectory "release\bundle"
  $installers = @(Get-ChildItem -LiteralPath $bundleDirectory -Recurse -File -Include "*.exe", "*.msi" -ErrorAction Stop)
  if ($installers.Count -eq 0) {
    throw "Nenhum instalador EXE ou MSI foi gerado em '$bundleDirectory'."
  }

  foreach ($installer in $installers) {
    & $signScript -ArtifactPath $installer.FullName
    if ($LASTEXITCODE -ne 0) {
      throw "A assinatura falhou para '$($installer.FullName)' (exit code $LASTEXITCODE)."
    }
  }

  $installers | Select-Object FullName, Length, LastWriteTime | Format-Table -AutoSize

  if ($tauriExitCode -ne 0) {
    throw "O Tauri gerou e assinou os instaladores, mas terminou com exit code $tauriExitCode. Verifique a configuração da assinatura do updater (TAURI_SIGNING_PRIVATE_KEY)."
  }
} finally {
  Pop-Location
}
