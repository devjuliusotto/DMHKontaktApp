param(
  [ValidateSet("debug", "release")]
  [string]$Configuration = "debug"
)

$ErrorActionPreference = "Stop"

$projectRoot = Split-Path -Parent $PSScriptRoot
$manifestPath = Join-Path $projectRoot "outlook-profile-reader\Cargo.toml"
$helperTargetDir = Join-Path $projectRoot "outlook-profile-reader\target"
$resourceDir = Join-Path $projectRoot "src-tauri\resources"
$targets = @(
  @{ Triple = "x86_64-pc-windows-msvc"; FileName = "outlook-profile-reader-x64.exe" },
  @{ Triple = "i686-pc-windows-msvc"; FileName = "outlook-profile-reader-x86.exe" }
)

$installedTargets = @(rustup target list --installed)
foreach ($target in $targets) {
  if ($installedTargets -notcontains $target.Triple) {
    throw "Rust target '$($target.Triple)' fehlt. Installieren Sie ihn einmalig mit: rustup target add $($target.Triple)"
  }
}

New-Item -ItemType Directory -Force -Path $resourceDir | Out-Null
$previousTargetDir = $env:CARGO_TARGET_DIR
$env:CARGO_TARGET_DIR = $helperTargetDir

try {
  foreach ($target in $targets) {
    $cargoArguments = @(
      "build",
      "--locked",
      "--manifest-path", $manifestPath,
      "--target", $target.Triple
    )
    if ($Configuration -eq "release") {
      $cargoArguments += "--release"
    }

    & cargo @cargoArguments
    if ($LASTEXITCODE -ne 0) {
      throw "Outlook helper konnte für $($target.Triple) nicht gebaut werden."
    }

    $profileFolder = if ($Configuration -eq "release") { "release" } else { "debug" }
    $source = Join-Path $helperTargetDir "$($target.Triple)\$profileFolder\outlook-profile-reader.exe"
    $destination = Join-Path $resourceDir $target.FileName
    Copy-Item -LiteralPath $source -Destination $destination -Force
  }
}
finally {
  $env:CARGO_TARGET_DIR = $previousTargetDir
}

