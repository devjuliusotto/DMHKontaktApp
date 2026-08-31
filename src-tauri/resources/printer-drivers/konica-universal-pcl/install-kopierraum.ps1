param(
    [Parameter(Mandatory = $true)]
    [string]$DriverDirectory,

    [Parameter(Mandatory = $true)]
    [string]$ResultPath
)

$ErrorActionPreference = "Stop"
$driverName = "KONICA MINOLTA Universal PCL"
$printerIp = "172.16.40.53"
$portName = "IP_$printerIp"
$printerName = "Kopierraum SH2 UG"
$infPath = Join-Path $DriverDirectory "KOAWNJ__.inf"
$utf8NoBom = New-Object System.Text.UTF8Encoding($false)

function Write-InstallResult([string]$Value) {
    [System.IO.File]::WriteAllText($ResultPath, $Value, $utf8NoBom)
}

try {
    $identity = [Security.Principal.WindowsIdentity]::GetCurrent()
    $principal = New-Object Security.Principal.WindowsPrincipal($identity)
    if (-not $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) {
        throw "Administratorrechte wurden nicht erteilt."
    }

    if (-not (Test-Path -LiteralPath $infPath -PathType Leaf)) {
        throw "Der mitgelieferte KONICA-MINOLTA-Treiber wurde nicht gefunden."
    }

    $existingPrinter = Get-Printer -Name $printerName -ErrorAction SilentlyContinue
    if ($existingPrinter -and $existingPrinter.DriverName -eq $driverName -and $existingPrinter.PortName -eq $portName) {
        Write-InstallResult "alreadyInstalled"
        exit 0
    }

    & pnputil.exe /add-driver $infPath /install | Out-Null
    if ($LASTEXITCODE -notin @(0, 3010)) {
        throw "Das Treiberpaket konnte nicht in Windows installiert werden."
    }

    & rundll32.exe printui.dll,PrintUIEntry /ia /m $driverName /f $infPath
    if ($LASTEXITCODE -ne 0) {
        throw "Der KONICA-MINOLTA-Treiber konnte nicht registriert werden."
    }

    $driverReady = $false
    for ($attempt = 0; $attempt -lt 10; $attempt++) {
        if (Get-PrinterDriver -Name $driverName -ErrorAction SilentlyContinue) {
            $driverReady = $true
            break
        }
        Start-Sleep -Milliseconds 500
    }
    if (-not $driverReady) {
        throw "Windows hat den KONICA-MINOLTA-Treiber nicht registriert."
    }

    if (-not (Get-PrinterPort -Name $portName -ErrorAction SilentlyContinue)) {
        Add-PrinterPort -Name $portName -PrinterHostAddress $printerIp
    }

    $existingPrinter = Get-Printer -Name $printerName -ErrorAction SilentlyContinue
    if ($existingPrinter) {
        Set-Printer -Name $printerName -DriverName $driverName -PortName $portName
    } else {
        Add-Printer -Name $printerName -DriverName $driverName -PortName $portName
    }

    Write-InstallResult "installed"
    exit 0
} catch {
    $message = [string]$_.Exception.Message
    $message = $message.Replace("`r", " ").Replace("`n", " ").Trim()
    Write-InstallResult "error:$message"
    exit 1
}
