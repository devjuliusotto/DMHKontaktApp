use base64::{engine::general_purpose::STANDARD as BASE64_STANDARD, Engine as _};
use serde::{Deserialize, Serialize};
use std::fs;
use std::net::IpAddr;
use std::path::{Path, PathBuf};
use tauri::{async_runtime::spawn_blocking, AppHandle, Manager};
use uuid::Uuid;

use super::{hidden_command, powershell_single_quote};

const KONICA_RESOURCE_PATH: [&str; 3] = ["printer-drivers", "konica-universal-pcl", "win_x64"];
const KONICA_INSTALL_SCRIPT: &str = "install-kopierraum.ps1";

fn powershell_compatible_path(path: &Path) -> String {
    let value = path.to_string_lossy();
    if let Some(path_without_prefix) = value.strip_prefix(r"\\?\UNC\") {
        format!(r"\\{path_without_prefix}")
    } else if let Some(path_without_prefix) = value.strip_prefix(r"\\?\") {
        path_without_prefix.to_string()
    } else {
        value.into_owned()
    }
}

fn encode_powershell_command(script: &str) -> String {
    let bytes = script
        .encode_utf16()
        .flat_map(u16::to_le_bytes)
        .collect::<Vec<_>>();
    BASE64_STANDARD.encode(bytes)
}

fn run_elevated_printer_script(script: &str) -> Result<(), String> {
    let result_path =
        std::env::temp_dir().join(format!("dmh-network-printer-{}.txt", Uuid::new_v4()));
    let result_path_for_powershell = powershell_compatible_path(&result_path);
    let elevated_script = format!(
        r#"
$ErrorActionPreference = 'Stop'
$resultPath = {result_path}
$utf8NoBom = New-Object System.Text.UTF8Encoding($false)
function Write-InstallResult([string]$value) {{
  [System.IO.File]::WriteAllText($resultPath, $value, $utf8NoBom)
}}
try {{
{script}
  Write-InstallResult 'success'
  exit 0
}} catch {{
  $message = ([string]$_.Exception.Message).Replace("`r", ' ').Replace("`n", ' ').Trim()
  Write-InstallResult ('error:' + $message)
  exit 1
}}
"#,
        result_path = powershell_single_quote(&result_path_for_powershell),
    );
    let encoded_command = encode_powershell_command(&elevated_script);
    let launch_script = format!(
        r#"
$ErrorActionPreference = 'Stop'
try {{
  $process = Start-Process -FilePath 'powershell.exe' -ArgumentList @('-NoProfile', '-ExecutionPolicy', 'Bypass', '-EncodedCommand', '{encoded_command}') -Verb RunAs -WindowStyle Hidden -Wait -PassThru
  exit $process.ExitCode
}} catch {{
  [Console]::Error.WriteLine([string]$_.Exception.Message)
  exit 1223
}}
"#
    );
    let output = hidden_command("powershell")
        .args([
            "-NoProfile",
            "-ExecutionPolicy",
            "Bypass",
            "-Command",
            launch_script.as_str(),
        ])
        .output()
        .map_err(|error| format!("Administratorfreigabe konnte nicht gestartet werden: {error}"))?;

    let result = fs::read_to_string(&result_path)
        .unwrap_or_default()
        .trim_start_matches('\u{feff}')
        .trim()
        .to_string();
    let _ = fs::remove_file(&result_path);
    if let Some(message) = result.strip_prefix("error:") {
        return Err(if message.trim().is_empty() {
            "Die Druckerinstallation ist fehlgeschlagen.".to_string()
        } else {
            message.trim().to_string()
        });
    }
    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        return Err(if stderr.trim().is_empty() {
            "Die Administratorfreigabe wurde abgebrochen oder Windows hat die Druckerinstallation beendet."
                .to_string()
        } else {
            format!(
                "Die Administratorfreigabe wurde abgebrochen: {}",
                stderr.trim()
            )
        });
    }
    if result == "success" {
        Ok(())
    } else {
        Err("Windows hat kein Ergebnis der Druckerinstallation zurückgegeben.".to_string())
    }
}

#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PrinterInfo {
    pub name: String,
    pub driver_name: String,
    pub port_name: String,
    pub printer_status: String,
    pub shared: bool,
    pub share_name: String,
    pub is_default: bool,
}

#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PrinterDriver {
    pub name: String,
    pub manufacturer: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AddNetworkPrinterRequest {
    pub mode: String,
    pub connection_name: String,
    pub ip_address: String,
    pub printer_name: String,
    pub driver_name: String,
}

fn run_powershell_json<T: for<'de> Deserialize<'de>>(
    script: &str,
    context: &str,
) -> Result<T, String> {
    let output = hidden_command("powershell")
        .args([
            "-NoProfile",
            "-ExecutionPolicy",
            "Bypass",
            "-Command",
            script,
        ])
        .output()
        .map_err(|error| format!("{context}: {error}"))?;

    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        return Err(format!("{context}: {}", stderr.trim()));
    }

    let stdout = String::from_utf8_lossy(&output.stdout);
    serde_json::from_str(stdout.trim()).map_err(|error| {
        format!("{context}: Die Windows-Ausgabe konnte nicht ausgewertet werden ({error}).")
    })
}

fn validate_single_line(value: &str, label: &str, maximum: usize) -> Result<String, String> {
    let value = value.trim();
    if value.is_empty() {
        return Err(format!("{label} fehlt."));
    }
    if value.len() > maximum || value.chars().any(char::is_control) {
        return Err(format!("{label} ist ungültig."));
    }
    Ok(value.to_string())
}

fn validate_network_host(value: &str) -> Result<String, String> {
    let value = validate_single_line(value, "IP-Adresse oder Hostname", 253)?;
    if value.parse::<IpAddr>().is_ok() {
        return Ok(value);
    }
    if value.starts_with('.')
        || value.ends_with('.')
        || value.starts_with('-')
        || value.ends_with('-')
        || !value
            .chars()
            .all(|character| character.is_ascii_alphanumeric() || matches!(character, '.' | '-'))
    {
        return Err(
            "Bitte geben Sie eine gültige IP-Adresse oder einen Hostnamen ein.".to_string(),
        );
    }
    Ok(value)
}

fn validate_shared_path(value: &str) -> Result<String, String> {
    let value = validate_single_line(value, "Freigabepfad", 512)?;
    let parts: Vec<_> = value.trim_start_matches('\\').split('\\').collect();
    if !value.starts_with("\\\\")
        || parts.len() != 2
        || parts.iter().any(|part| part.trim().is_empty())
    {
        return Err("Der Freigabepfad muss wie \\\\Server\\Drucker aufgebaut sein.".to_string());
    }
    Ok(value)
}

fn konica_resource_candidates(app: &AppHandle) -> Vec<PathBuf> {
    let relative_root = KONICA_RESOURCE_PATH.iter().collect::<PathBuf>();
    let mut candidates = Vec::new();
    if let Ok(resource_dir) = app.path().resource_dir() {
        candidates.push(resource_dir.join("resources").join(&relative_root));
        candidates.push(resource_dir.join(&relative_root));
    }
    candidates.push(
        PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .join("resources")
            .join(relative_root),
    );
    candidates
}

fn konica_resource_root(app: &AppHandle) -> Result<PathBuf, String> {
    konica_resource_candidates(app)
        .into_iter()
        .find(|candidate| {
            candidate.join("KOAWNJ__.inf").is_file()
                && candidate
                    .parent()
                    .is_some_and(|parent| parent.join(KONICA_INSTALL_SCRIPT).is_file())
        })
        .ok_or_else(|| "Der mitgelieferte KONICA-MINOLTA-Treiber wurde nicht gefunden.".to_string())
}

fn install_dmh_kopierraum_printer_blocking(app: AppHandle) -> Result<String, String> {
    let driver_directory = konica_resource_root(&app)?;
    let script_path = driver_directory
        .parent()
        .expect("validated KONICA resource parent")
        .join(KONICA_INSTALL_SCRIPT);
    let result_path =
        std::env::temp_dir().join(format!("dmh-kopierraum-printer-{}.txt", Uuid::new_v4()));
    let script_path_for_powershell = powershell_compatible_path(&script_path);
    let driver_directory_for_powershell = powershell_compatible_path(&driver_directory);
    let result_path_for_powershell = powershell_compatible_path(&result_path);

    let elevation_script = format!(
        r#"
$ErrorActionPreference = 'Stop'
$scriptPath = {script_path}
$driverDirectory = {driver_directory}
$resultPath = {result_path}
$arguments = '-NoProfile -ExecutionPolicy Bypass -File "' + $scriptPath + '" -DriverDirectory "' + $driverDirectory + '" -ResultPath "' + $resultPath + '"'
try {{
  $process = Start-Process -FilePath 'powershell.exe' -ArgumentList $arguments -Verb RunAs -WindowStyle Hidden -Wait -PassThru
  exit $process.ExitCode
}} catch {{
  [Console]::Error.WriteLine([string]$_.Exception.Message)
  exit 1223
}}
"#,
        script_path = powershell_single_quote(&script_path_for_powershell),
        driver_directory = powershell_single_quote(&driver_directory_for_powershell),
        result_path = powershell_single_quote(&result_path_for_powershell),
    );

    let output = hidden_command("powershell")
        .args([
            "-NoProfile",
            "-ExecutionPolicy",
            "Bypass",
            "-Command",
            elevation_script.as_str(),
        ])
        .output()
        .map_err(|error| {
            format!("Die Druckerinstallation konnte nicht gestartet werden: {error}")
        })?;

    let result = fs::read_to_string(&result_path)
        .unwrap_or_default()
        .trim_start_matches('\u{feff}')
        .trim()
        .to_string();
    let _ = fs::remove_file(&result_path);

    if let Some(message) = result.strip_prefix("error:") {
        let message = message.trim();
        return Err(if message.is_empty() {
            "Die Druckerinstallation ist fehlgeschlagen.".to_string()
        } else {
            message.to_string()
        });
    }
    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        return Err(if stderr.trim().is_empty() {
            "Die Administratorfreigabe wurde abgebrochen oder die Druckerinstallation ist fehlgeschlagen."
                .to_string()
        } else {
            format!(
                "Die Administratorfreigabe wurde abgebrochen: {}",
                stderr.trim()
            )
        });
    }

    match result.as_str() {
        "installed" | "alreadyInstalled" => Ok(result),
        _ => Err("Windows hat kein Ergebnis der Druckerinstallation zurückgegeben.".to_string()),
    }
}

fn list_printers_blocking() -> Result<Vec<PrinterInfo>, String> {
    let script = r#"
$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
$defaultName = ''
try { $defaultName = [string](Get-CimInstance Win32_Printer | Where-Object { $_.Default } | Select-Object -First 1 -ExpandProperty Name) } catch {}
$items = @(Get-Printer | Sort-Object Name | ForEach-Object {
  [pscustomobject]@{
    name = [string]$_.Name
    driverName = [string]$_.DriverName
    portName = [string]$_.PortName
    printerStatus = [string]$_.PrinterStatus
    shared = [bool]$_.Shared
    shareName = [string]$_.ShareName
    isDefault = ([string]$_.Name -eq $defaultName)
  }
})
ConvertTo-Json -InputObject $items -Depth 4 -Compress
"#;
    run_powershell_json(script, "Drucker konnten nicht gelesen werden")
}

fn list_printer_drivers_blocking() -> Result<Vec<PrinterDriver>, String> {
    let script = r#"
$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
$items = @(Get-PrinterDriver | Sort-Object Name | ForEach-Object {
  [pscustomobject]@{
    name = [string]$_.Name
    manufacturer = [string]$_.Manufacturer
  }
})
ConvertTo-Json -InputObject $items -Depth 3 -Compress
"#;
    run_powershell_json(script, "Druckertreiber konnten nicht gelesen werden")
}

fn add_network_printer_blocking(request: AddNetworkPrinterRequest) -> Result<(), String> {
    match request.mode.as_str() {
        "shared" => {
            let connection_name = validate_shared_path(&request.connection_name)?;
            let script = format!(
                "  Add-Printer -ConnectionName {} -ErrorAction Stop",
                powershell_single_quote(&connection_name)
            );
            run_elevated_printer_script(&script)
        }
        "ip" => {
            let host = validate_network_host(&request.ip_address)?;
            let printer_name = validate_single_line(&request.printer_name, "Druckername", 128)?;
            let driver_name = validate_single_line(&request.driver_name, "Druckertreiber", 256)?;
            let port_name = format!("DMH_IP_{host}");
            let script = format!(
                r#"
$ErrorActionPreference = 'Stop'
$portName = {port_name}
$hostAddress = {host}
$printerName = {printer_name}
$driverName = {driver_name}
if (Get-Printer -Name $printerName -ErrorAction SilentlyContinue) {{ throw "Ein Drucker mit diesem Namen ist bereits installiert." }}
if (-not (Get-PrinterDriver -Name $driverName -ErrorAction SilentlyContinue)) {{ throw "Der gewählte Druckertreiber ist nicht mehr installiert." }}
$portCreated = $false
try {{
  if (-not (Get-PrinterPort -Name $portName -ErrorAction SilentlyContinue)) {{
    Add-PrinterPort -Name $portName -PrinterHostAddress $hostAddress -ErrorAction Stop
    $portCreated = $true
  }}
  Add-Printer -Name $printerName -DriverName $driverName -PortName $portName -ErrorAction Stop
}} catch {{
  if ($portCreated) {{ Remove-PrinterPort -Name $portName -ErrorAction SilentlyContinue }}
  throw
}}
"#,
                port_name = powershell_single_quote(&port_name),
                host = powershell_single_quote(&host),
                printer_name = powershell_single_quote(&printer_name),
                driver_name = powershell_single_quote(&driver_name)
            );
            run_elevated_printer_script(&script)
        }
        _ => Err("Unbekannte Drucker-Verbindungsart.".to_string()),
    }
}

#[tauri::command]
pub async fn list_printers() -> Result<Vec<PrinterInfo>, String> {
    spawn_blocking(list_printers_blocking)
        .await
        .map_err(|error| format!("Druckerliste wurde unerwartet beendet: {error}"))?
}

#[tauri::command]
pub async fn list_printer_drivers() -> Result<Vec<PrinterDriver>, String> {
    spawn_blocking(list_printer_drivers_blocking)
        .await
        .map_err(|error| format!("Treiberliste wurde unerwartet beendet: {error}"))?
}

#[tauri::command]
pub async fn add_network_printer(request: AddNetworkPrinterRequest) -> Result<(), String> {
    spawn_blocking(move || add_network_printer_blocking(request))
        .await
        .map_err(|error| format!("Druckerinstallation wurde unerwartet beendet: {error}"))?
}

#[tauri::command]
pub async fn install_dmh_kopierraum_printer(app: AppHandle) -> Result<String, String> {
    spawn_blocking(move || install_dmh_kopierraum_printer_blocking(app))
        .await
        .map_err(|error| format!("Druckerinstallation wurde unerwartet beendet: {error}"))?
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn validates_network_hosts_without_allowing_shell_syntax() {
        assert!(validate_network_host("192.168.10.25").is_ok());
        assert!(validate_network_host("drucker-buero.local").is_ok());
        assert!(validate_network_host("printer; Remove-Item C:\\").is_err());
    }

    #[test]
    fn validates_shared_printer_paths() {
        assert!(validate_shared_path(r"\\server\drucker").is_ok());
        assert!(validate_shared_path(r"\\server\").is_err());
        assert!(validate_shared_path(r"server\drucker").is_err());
    }

    #[test]
    fn removes_windows_verbatim_prefix_for_powershell() {
        assert_eq!(
            powershell_compatible_path(Path::new(r"\\?\C:\Programme\DMH\driver.inf")),
            r"C:\Programme\DMH\driver.inf"
        );
        assert_eq!(
            powershell_compatible_path(Path::new(r"\\?\UNC\server\freigabe\driver.inf")),
            r"\\server\freigabe\driver.inf"
        );
    }

    #[test]
    fn encodes_commands_for_elevated_windows_powershell() {
        let script = "Write-Output 'Drucker hinzufügen'";
        let decoded = BASE64_STANDARD
            .decode(encode_powershell_command(script))
            .expect("encoded PowerShell command");
        let utf16 = decoded
            .chunks_exact(2)
            .map(|bytes| u16::from_le_bytes([bytes[0], bytes[1]]))
            .collect::<Vec<_>>();
        assert_eq!(String::from_utf16(&utf16).expect("UTF-16 script"), script);
    }
}
