$ErrorActionPreference = "Stop"

$root = Split-Path -Parent $PSScriptRoot
Set-Location $root

$env:CARGO_TARGET_DIR = Join-Path $env:TEMP "agendakontakte-cargo-target"
$exe = Join-Path $env:CARGO_TARGET_DIR "debug\agendakontakte.exe"
$manifest = Join-Path $root "src-tauri\Cargo.toml"

function Test-VitePort {
  $connection = Get-NetTCPConnection -LocalAddress 127.0.0.1 -LocalPort 1420 -State Listen -ErrorAction SilentlyContinue
  return $null -ne $connection
}

if (!(Test-Path $exe)) {
  cargo build --manifest-path $manifest
}

Get-Process agendakontakte -ErrorAction SilentlyContinue | Stop-Process -Force

if (!(Test-VitePort)) {
  Start-Process powershell `
    -ArgumentList "-NoProfile", "-ExecutionPolicy", "Bypass", "-Command", "Set-Location '$root'; npm run dev" `
    -WorkingDirectory $root `
    -WindowStyle Minimized
}

$deadline = (Get-Date).AddSeconds(25)
while (!(Test-VitePort)) {
  if ((Get-Date) -gt $deadline) {
    throw "Vite wurde nicht auf 127.0.0.1:1420 gestartet. Starten Sie testweise 'npm run dev' und prüfen Sie die Fehlermeldung."
  }
  Start-Sleep -Milliseconds 500
}

Start-Process -FilePath $exe -WorkingDirectory $root
