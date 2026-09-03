use crate::{hidden_command, open_db};
use aes_gcm::{
    aead::{Aead, KeyInit, Payload},
    Aes256Gcm, Nonce,
};
use base64::{engine::general_purpose::STANDARD as BASE64_STANDARD, Engine as _};
use rand::{rngs::OsRng, RngCore};
use rsa::{BigUint, Oaep, RsaPublicKey};
use rusqlite::{params, Connection, OptionalExtension};
use serde::{de::DeserializeOwned, Deserialize, Serialize};
use sha2::Sha256;
use std::{
    collections::HashSet,
    env, fs,
    fs::OpenOptions,
    io::Write,
    path::PathBuf,
    time::{Duration, Instant},
};
use tauri::{AppHandle, Manager};
use uuid::Uuid;
use zeroize::{Zeroize, Zeroizing};

const HELPER_NAMES: [&str; 2] = [
    "outlook-profile-reader-x64.exe",
    "outlook-profile-reader-x86.exe",
];
const MIGRATION_CAPTURE_COMPLETED_KEY: &str = "migration_capture_v2_completed_at";
const MIGRATION_CAPTURE_SUBMISSION_KEY: &str = "migration_capture_v2_submission_id";
const MIGRATION_ENVELOPE_VERSION: u8 = 1;
const MIGRATION_ENVELOPE_ALGORITHM: &str = "RSA-OAEP-256+A256GCM";
const MIGRATION_DELIVERY_ATTEMPTS: usize = 3;
const MIGRATION_DELIVERY_TIMEOUT_SECONDS: u64 = 90;
const MIGRATION_RETRY_DELAYS_SECONDS: [u64; MIGRATION_DELIVERY_ATTEMPTS] = [0, 2, 6];
const MIGRATION_DIAGNOSTIC_DIRECTORY: &str = "diagnostics";
const MIGRATION_DIAGNOSTIC_FILE: &str = "edv-transfer.log";
const MIGRATION_DIAGNOSTIC_PREVIOUS_FILE: &str = "edv-transfer.previous.log";
const MIGRATION_DIAGNOSTIC_MAX_BYTES: u64 = 256 * 1024;
const STABLE_CREDENTIAL_NAMESPACE: &str = "AgendaKontakte";
const ADMIN_TEST_CREDENTIAL_NAMESPACE: &str = "AgendaKontakte-AdminTest";

fn credential_namespace() -> &'static str {
    if option_env!("DMH_RELEASE_CHANNEL") == Some("admin-test") {
        ADMIN_TEST_CREDENTIAL_NAMESPACE
    } else {
        STABLE_CREDENTIAL_NAMESPACE
    }
}

fn credential_reference_belongs_to_current_channel(reference: &str) -> bool {
    reference.starts_with(&format!("{}/imap/", credential_namespace()))
}

fn migration_diagnostic_paths(app: &AppHandle) -> Result<(PathBuf, PathBuf), String> {
    let directory = app
        .path()
        .app_data_dir()
        .map_err(|error| format!("Diagnoseverzeichnis konnte nicht ermittelt werden: {error}"))?
        .join(MIGRATION_DIAGNOSTIC_DIRECTORY);
    Ok((
        directory.join(MIGRATION_DIAGNOSTIC_FILE),
        directory.join(MIGRATION_DIAGNOSTIC_PREVIOUS_FILE),
    ))
}

fn sanitize_diagnostic_value(value: &str) -> String {
    value
        .chars()
        .map(|character| {
            if character.is_ascii_control() {
                ' '
            } else {
                character
            }
        })
        .take(160)
        .collect()
}

fn append_migration_diagnostic(
    app: &AppHandle,
    diagnostic_id: &str,
    stage: &str,
    result: &str,
    detail: &str,
) {
    let Ok((current_path, previous_path)) = migration_diagnostic_paths(app) else {
        return;
    };
    let Some(directory) = current_path.parent() else {
        return;
    };
    if fs::create_dir_all(directory).is_err() {
        return;
    }
    if fs::metadata(&current_path)
        .is_ok_and(|metadata| metadata.len() >= MIGRATION_DIAGNOSTIC_MAX_BYTES)
    {
        let _ = fs::remove_file(&previous_path);
        let _ = fs::rename(&current_path, &previous_path);
    }
    let Ok(mut file) = OpenOptions::new()
        .create(true)
        .append(true)
        .open(current_path)
    else {
        return;
    };
    let _ = writeln!(
        file,
        "{}\tapp={}\tdiagnostic={}\tstage={}\tresult={}\tdetail={}",
        chrono::Utc::now().to_rfc3339(),
        env!("CARGO_PKG_VERSION"),
        sanitize_diagnostic_value(diagnostic_id),
        sanitize_diagnostic_value(stage),
        sanitize_diagnostic_value(result),
        sanitize_diagnostic_value(detail)
    );
}

fn migration_stage_error(
    app: &AppHandle,
    diagnostic_id: &str,
    stage: &str,
    detail: &str,
    message: String,
) -> String {
    append_migration_diagnostic(app, diagnostic_id, stage, "error", detail);
    message
}

fn short_diagnostic_id(diagnostic_id: &str) -> &str {
    diagnostic_id.get(..8).unwrap_or(diagnostic_id)
}

#[tauri::command]
pub fn get_migration_diagnostic_log(app: AppHandle) -> Result<String, String> {
    let (current_path, previous_path) = migration_diagnostic_paths(&app)?;
    let mut sections = vec![
        "DMH EDV-Übertragungsdiagnose".to_string(),
        "Der Bericht enthält keine Kennwörter, E-Mail-Adressen, Servernamen oder übertragenen Inhalte.".to_string(),
        String::new(),
    ];
    for (label, path) in [
        ("Vorheriger Bericht", previous_path),
        ("Aktueller Bericht", current_path),
    ] {
        if !path.exists() {
            continue;
        }
        let content = fs::read_to_string(path)
            .map_err(|error| format!("Diagnosebericht konnte nicht gelesen werden: {error}"))?;
        sections.push(format!("--- {label} ---"));
        sections.push(content);
    }
    if sections.len() == 3 {
        sections.push("Noch kein Übertragungsversuch protokolliert.".to_string());
    }
    Ok(sections.join("\n"))
}

pub(crate) fn clear_migration_diagnostics(app: &AppHandle) -> Result<(), String> {
    let (current_path, _) = migration_diagnostic_paths(app)?;
    let Some(directory) = current_path.parent() else {
        return Ok(());
    };
    if directory.exists() {
        fs::remove_dir_all(directory)
            .map_err(|error| format!("Diagnoseberichte konnten nicht gelöscht werden: {error}"))?;
    }
    Ok(())
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct OutlookAccountCandidate {
    pub source_account_id: String,
    pub account_name: String,
    pub email: String,
    pub account_type: String,
    pub incoming_server: String,
    pub incoming_user: String,
    pub incoming_port: u16,
    pub incoming_security: String,
    pub incoming_use_spa: bool,
    pub outgoing_server: String,
    pub outgoing_user: String,
    pub outgoing_port: u16,
    pub outgoing_security: String,
    pub outgoing_use_auth: bool,
    pub outgoing_auth_method: u32,
    pub password_available: bool,
    pub smtp_password_available: bool,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct ImportedOutlookAccount {
    #[serde(flatten)]
    account: OutlookAccountCandidate,
    incoming_credential_reference: String,
    outgoing_credential_reference: Option<String>,
}

#[derive(Debug, Deserialize)]
struct HelperError {
    error: String,
}

#[derive(Debug, Deserialize, Serialize)]
pub struct RevealedMailPassword {
    password: String,
}

impl Drop for RevealedMailPassword {
    fn drop(&mut self) {
        self.password.zeroize();
    }
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MigrationCaptureStatus {
    pub configured: bool,
    pub completed: bool,
    pub completed_at: Option<String>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MigrationCaptureResult {
    pub accounts_submitted: usize,
    pub completed_at: String,
    pub accounts: Vec<MigrationAccountSummary>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MigrationAccountSummary {
    pub account_name: String,
    pub email: String,
    pub incoming_user: String,
    pub incoming_server: String,
    pub incoming_port: u16,
    pub incoming_security: String,
}

#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct MigrationAccountSubmission {
    account_name: String,
    email: String,
    incoming_user: String,
    incoming_server: String,
    incoming_port: u16,
    incoming_security: String,
    password: String,
}

impl Drop for MigrationAccountSubmission {
    fn drop(&mut self) {
        self.password.zeroize();
    }
}

#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct MigrationEncryptedContent {
    accounts: Vec<MigrationAccountSubmission>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct MigrationEncryptedEnvelope {
    version: u8,
    submission_id: String,
    captured_at: String,
    computer: String,
    key_id: String,
    algorithm: &'static str,
    wrapped_key: String,
    nonce: String,
    ciphertext: String,
    status: &'static str,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct MigrationPublicKeyConfig {
    key_id: String,
    modulus: String,
    exponent: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MailAccount {
    pub id: i64,
    pub source: String,
    pub source_account_id: String,
    pub account_name: String,
    pub email: String,
    pub account_type: String,
    pub incoming_server: String,
    pub incoming_user: String,
    pub incoming_port: u16,
    pub incoming_security: String,
    pub incoming_use_spa: bool,
    pub outgoing_server: String,
    pub outgoing_user: String,
    pub outgoing_port: u16,
    pub outgoing_security: String,
    pub outgoing_use_auth: bool,
    pub outgoing_auth_method: u32,
    #[serde(skip_serializing)]
    pub credential_reference: String,
    #[serde(skip_serializing)]
    pub outgoing_credential_reference: Option<String>,
    pub created_at: String,
    pub updated_at: String,
}

fn current_outlook_profile_name() -> Result<String, String> {
    let script = r#"
$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
$outlook = New-Object -ComObject Outlook.Application
[Console]::Write([string]$outlook.Session.CurrentProfileName)
"#;
    let output = hidden_command("powershell")
        .args([
            "-NoProfile",
            "-ExecutionPolicy",
            "Bypass",
            "-Command",
            script,
        ])
        .output()
        .map_err(|_| "Outlook Classic konnte nicht gestartet werden.".to_string())?;
    if !output.status.success() {
        return Err(
            "Das aktuelle Outlook-Classic-Profil konnte nicht ermittelt werden. Outlook Classic muss installiert und eingerichtet sein."
                .to_string(),
        );
    }

    let profile = String::from_utf8_lossy(&output.stdout).trim().to_string();
    if profile.is_empty() {
        return Err(
            "Outlook Classic hat kein aktives Profil zurückgegeben. Öffnen Sie Outlook Classic einmal und versuchen Sie es erneut."
                .to_string(),
        );
    }
    Ok(profile)
}

fn helper_candidates(app: &AppHandle, name: &str) -> Vec<PathBuf> {
    let mut paths = Vec::new();
    if let Ok(resource_dir) = app.path().resource_dir() {
        paths.push(resource_dir.join("resources").join(name));
        paths.push(resource_dir.join(name));
    }
    paths.push(
        PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .join("resources")
            .join(name),
    );
    paths
}

fn helper_path(app: &AppHandle, name: &str) -> Option<PathBuf> {
    helper_candidates(app, name)
        .into_iter()
        .find(|path| fs::metadata(path).is_ok_and(|metadata| metadata.is_file()))
}

fn run_helper<T: DeserializeOwned>(app: &AppHandle, arguments: &[String]) -> Result<T, String> {
    let mut errors = Vec::new();
    let mut found_helper = false;

    for name in HELPER_NAMES {
        let Some(path) = helper_path(app, name) else {
            continue;
        };
        found_helper = true;
        let output = hidden_command(path.to_string_lossy().as_ref())
            .args(arguments)
            .output()
            .map_err(|_| "Outlook-Hilfsprogramm konnte nicht gestartet werden.".to_string())?;
        let stdout = String::from_utf8_lossy(&output.stdout);

        if output.status.success() {
            return serde_json::from_str(stdout.trim()).map_err(|_| {
                "Outlook-Hilfsprogramm hat eine ungültige Antwort geliefert.".to_string()
            });
        }

        let message = serde_json::from_str::<HelperError>(stdout.trim())
            .map(|value| value.error)
            .unwrap_or_else(|_| "Outlook-Hilfsprogramm ist fehlgeschlagen.".to_string());
        errors.push(message);
    }

    if !found_helper {
        return Err(
            "Outlook-Hilfsprogramm fehlt. Installieren oder bauen Sie DMH Backup erneut."
                .to_string(),
        );
    }

    let message = errors
        .iter()
        .find(|message| {
            !message.contains("Architektur")
                && !message.contains("ClassFactory")
                && !message.contains("MAPI konnte nicht initialisiert")
        })
        .cloned()
        .or_else(|| errors.first().cloned())
        .unwrap_or_else(|| "Outlook-IMAP-Konto konnte nicht gelesen werden.".to_string());
    Err(message)
}

fn run_secret_helper(
    app: &AppHandle,
    arguments: &[String],
) -> Result<RevealedMailPassword, String> {
    let mut errors = Vec::new();
    let mut found_helper = false;

    for name in HELPER_NAMES {
        let Some(path) = helper_path(app, name) else {
            continue;
        };
        found_helper = true;
        let mut output = hidden_command(path.to_string_lossy().as_ref())
            .args(arguments)
            .output()
            .map_err(|_| "Outlook-Hilfsprogramm konnte nicht gestartet werden.".to_string())?;

        if output.status.success() {
            let result =
                serde_json::from_slice::<RevealedMailPassword>(&output.stdout).map_err(|_| {
                    "Outlook-Hilfsprogramm hat eine ungültige Antwort geliefert.".to_string()
                });
            output.stdout.zeroize();
            output.stderr.zeroize();
            return result;
        }

        let message = serde_json::from_slice::<HelperError>(&output.stdout)
            .map(|value| value.error)
            .unwrap_or_else(|_| "Outlook-Hilfsprogramm ist fehlgeschlagen.".to_string());
        output.stdout.zeroize();
        output.stderr.zeroize();
        errors.push(message);
    }

    if !found_helper {
        return Err(
            "Outlook-Hilfsprogramm fehlt. Installieren oder bauen Sie DMH Backup erneut."
                .to_string(),
        );
    }

    Err(errors
        .into_iter()
        .next()
        .unwrap_or_else(|| "Gespeichertes IMAP-Kennwort konnte nicht gelesen werden.".to_string()))
}

fn migration_capture_endpoint() -> Option<&'static str> {
    option_env!("MIGRATION_CAPTURE_URL")
        .map(str::trim)
        .filter(|value| value.starts_with("https://") && value.len() > "https://".len())
}

fn migration_public_key() -> Result<(String, RsaPublicKey), String> {
    let config: MigrationPublicKeyConfig =
        serde_json::from_str(include_str!("../migration-public-key.json")).map_err(|_| {
            "Der öffentliche EDV-Schlüssel ist in diesem Build ungültig.".to_string()
        })?;
    let modulus = BASE64_STANDARD
        .decode(config.modulus)
        .map_err(|_| "Der öffentliche EDV-Schlüssel ist in diesem Build ungültig.".to_string())?;
    let exponent = BASE64_STANDARD
        .decode(config.exponent)
        .map_err(|_| "Der öffentliche EDV-Schlüssel ist in diesem Build ungültig.".to_string())?;
    let public_key = RsaPublicKey::new(
        BigUint::from_bytes_be(&modulus),
        BigUint::from_bytes_be(&exponent),
    )
    .map_err(|_| "Der öffentliche EDV-Schlüssel konnte nicht geladen werden.".to_string())?;
    Ok((config.key_id, public_key))
}

fn migration_aad(
    version: u8,
    submission_id: &str,
    captured_at: &str,
    computer: &str,
    key_id: &str,
) -> Vec<u8> {
    format!("AKM{version}\n{submission_id}\n{captured_at}\n{computer}\n{key_id}").into_bytes()
}

fn encrypt_migration_accounts_with_key(
    submission_id: String,
    captured_at: String,
    computer: String,
    accounts: Vec<MigrationAccountSubmission>,
    key_id: String,
    public_key: &RsaPublicKey,
) -> Result<MigrationEncryptedEnvelope, String> {
    let plaintext = Zeroizing::new(
        serde_json::to_vec(&MigrationEncryptedContent { accounts }).map_err(|_| {
            "Die Migrationsdaten konnten intern nicht vorbereitet werden.".to_string()
        })?,
    );
    let aad = migration_aad(
        MIGRATION_ENVELOPE_VERSION,
        &submission_id,
        &captured_at,
        &computer,
        &key_id,
    );

    let mut data_key = Zeroizing::new([0u8; 32]);
    let mut nonce_bytes = [0u8; 12];
    OsRng.fill_bytes(&mut data_key[..]);
    OsRng.fill_bytes(&mut nonce_bytes);

    let cipher = Aes256Gcm::new_from_slice(&data_key[..])
        .map_err(|_| "Die lokale Verschlüsselung konnte nicht vorbereitet werden.".to_string())?;
    let ciphertext = cipher
        .encrypt(
            Nonce::from_slice(&nonce_bytes),
            Payload {
                msg: plaintext.as_slice(),
                aad: &aad,
            },
        )
        .map_err(|_| "Die E-Mail-Zugangsdaten konnten nicht verschlüsselt werden.".to_string())?;

    let wrapped_key = public_key
        .encrypt(&mut OsRng, Oaep::new::<Sha256>(), &data_key[..])
        .map_err(|_| "Der EDV-Schlüssel konnte nicht angewendet werden.".to_string())?;

    Ok(MigrationEncryptedEnvelope {
        version: MIGRATION_ENVELOPE_VERSION,
        submission_id,
        captured_at,
        computer,
        key_id,
        algorithm: MIGRATION_ENVELOPE_ALGORITHM,
        wrapped_key: BASE64_STANDARD.encode(wrapped_key),
        nonce: BASE64_STANDARD.encode(nonce_bytes),
        ciphertext: BASE64_STANDARD.encode(ciphertext),
        status: "Verschlüsselt",
    })
}

fn encrypt_migration_accounts(
    submission_id: String,
    captured_at: String,
    computer: String,
    accounts: Vec<MigrationAccountSubmission>,
) -> Result<MigrationEncryptedEnvelope, String> {
    let (key_id, public_key) = migration_public_key()?;
    encrypt_migration_accounts_with_key(
        submission_id,
        captured_at,
        computer,
        accounts,
        key_id,
        &public_key,
    )
}

fn get_migration_setting(conn: &Connection, key: &str) -> Result<Option<String>, String> {
    conn.query_row(
        "SELECT value FROM app_settings WHERE key = ?1",
        [key],
        |row| row.get(0),
    )
    .optional()
    .map_err(|error| error.to_string())
}

fn set_migration_setting(conn: &Connection, key: &str, value: &str) -> Result<(), String> {
    conn.execute(
        "INSERT INTO app_settings (key, value, updated_at) VALUES (?1, ?2, ?3)
         ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at",
        params![key, value, chrono::Utc::now().to_rfc3339()],
    )
    .map_err(|error| error.to_string())?;
    Ok(())
}

fn map_mail_account(row: &rusqlite::Row<'_>) -> rusqlite::Result<MailAccount> {
    Ok(MailAccount {
        id: row.get(0)?,
        source: row.get(1)?,
        source_account_id: row.get(2)?,
        account_name: row.get(3)?,
        email: row.get(4)?,
        account_type: row.get(5)?,
        incoming_server: row.get(6)?,
        incoming_user: row.get(7)?,
        incoming_port: row.get::<_, u16>(8)?,
        incoming_security: row.get(9)?,
        incoming_use_spa: row.get::<_, i64>(10)? != 0,
        outgoing_server: row.get(11)?,
        outgoing_user: row.get(12)?,
        outgoing_port: row.get::<_, u16>(13)?,
        outgoing_security: row.get(14)?,
        outgoing_use_auth: row.get::<_, i64>(15)? != 0,
        outgoing_auth_method: row.get(16)?,
        credential_reference: row.get(17)?,
        outgoing_credential_reference: row.get(18)?,
        created_at: row.get(19)?,
        updated_at: row.get(20)?,
    })
}

const MAIL_ACCOUNT_COLUMNS: &str = "
    id, source, source_account_id, account_name, email, account_type,
    incoming_server, incoming_user, incoming_port, incoming_security, incoming_use_spa,
    outgoing_server, outgoing_user, outgoing_port, outgoing_security, outgoing_use_auth,
    outgoing_auth_method, credential_reference, outgoing_credential_reference, created_at, updated_at
";

fn get_mail_account(conn: &Connection, id: i64) -> Result<Option<MailAccount>, String> {
    conn.query_row(
        &format!("SELECT {MAIL_ACCOUNT_COLUMNS} FROM mail_accounts WHERE id = ?1"),
        [id],
        map_mail_account,
    )
    .optional()
    .map_err(|error| error.to_string())
}

fn get_mail_account_by_source(
    conn: &Connection,
    source_account_id: &str,
) -> Result<MailAccount, String> {
    conn.query_row(
        &format!("SELECT {MAIL_ACCOUNT_COLUMNS} FROM mail_accounts WHERE source_account_id = ?1"),
        [source_account_id],
        map_mail_account,
    )
    .map_err(|error| error.to_string())
}

#[tauri::command]
pub fn scan_outlook_accounts(app: AppHandle) -> Result<Vec<OutlookAccountCandidate>, String> {
    let profile = current_outlook_profile_name()?;
    run_helper(&app, &["scan".to_string(), profile])
}

#[tauri::command]
pub fn list_mail_accounts(app: AppHandle) -> Result<Vec<MailAccount>, String> {
    let conn = open_db(&app)?;
    let mut statement = conn
        .prepare(&format!(
            "SELECT {MAIL_ACCOUNT_COLUMNS} FROM mail_accounts ORDER BY lower(account_name), lower(email)"
        ))
        .map_err(|error| error.to_string())?;
    let accounts = statement
        .query_map([], map_mail_account)
        .map_err(|error| error.to_string())?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|error| error.to_string())?;
    Ok(accounts)
}

#[tauri::command]
pub fn import_outlook_account(
    app: AppHandle,
    source_account_id: String,
) -> Result<MailAccount, String> {
    if source_account_id.is_empty()
        || !source_account_id
            .chars()
            .all(|character| character.is_ascii_hexdigit())
    {
        return Err("Ungültige Outlook-Konto-ID.".to_string());
    }

    let profile = current_outlook_profile_name()?;
    let normalized_id = source_account_id.to_ascii_uppercase();
    let namespace = credential_namespace();
    let incoming_reference = format!("{namespace}/imap/{normalized_id}/incoming");
    let outgoing_reference = format!("{namespace}/imap/{normalized_id}/outgoing");
    let existed_before = open_db(&app)?
        .query_row(
            "SELECT EXISTS(SELECT 1 FROM mail_accounts WHERE source_account_id = ?1)",
            [&normalized_id],
            |row| row.get::<_, i64>(0),
        )
        .map_err(|error| error.to_string())?
        != 0;
    let imported: ImportedOutlookAccount = run_helper(
        &app,
        &[
            "import".to_string(),
            profile,
            normalized_id.clone(),
            incoming_reference.clone(),
            outgoing_reference.clone(),
        ],
    )?;

    let account = imported.account;
    let has_outgoing_credential = imported.outgoing_credential_reference.is_some();
    let timestamp = chrono::Utc::now().to_rfc3339();
    let conn = open_db(&app)?;
    let save_result = conn.execute(
        "
        INSERT INTO mail_accounts (
            source, source_account_id, account_name, email, account_type,
            incoming_server, incoming_user, incoming_port, incoming_security, incoming_use_spa,
            outgoing_server, outgoing_user, outgoing_port, outgoing_security, outgoing_use_auth,
            outgoing_auth_method, credential_reference, outgoing_credential_reference,
            created_at, updated_at
        ) VALUES (
            'outlook-classic', ?1, ?2, ?3, ?4,
            ?5, ?6, ?7, ?8, ?9,
            ?10, ?11, ?12, ?13, ?14,
            ?15, ?16, ?17, ?18, ?18
        )
        ON CONFLICT(source_account_id) DO UPDATE SET
            account_name = excluded.account_name,
            email = excluded.email,
            account_type = excluded.account_type,
            incoming_server = excluded.incoming_server,
            incoming_user = excluded.incoming_user,
            incoming_port = excluded.incoming_port,
            incoming_security = excluded.incoming_security,
            incoming_use_spa = excluded.incoming_use_spa,
            outgoing_server = excluded.outgoing_server,
            outgoing_user = excluded.outgoing_user,
            outgoing_port = excluded.outgoing_port,
            outgoing_security = excluded.outgoing_security,
            outgoing_use_auth = excluded.outgoing_use_auth,
            outgoing_auth_method = excluded.outgoing_auth_method,
            credential_reference = excluded.credential_reference,
            outgoing_credential_reference = excluded.outgoing_credential_reference,
            updated_at = excluded.updated_at
        ",
        params![
            account.source_account_id,
            account.account_name,
            account.email,
            account.account_type,
            account.incoming_server,
            account.incoming_user,
            account.incoming_port,
            account.incoming_security,
            account.incoming_use_spa as i64,
            account.outgoing_server,
            account.outgoing_user,
            account.outgoing_port,
            account.outgoing_security,
            account.outgoing_use_auth as i64,
            account.outgoing_auth_method,
            imported.incoming_credential_reference,
            imported.outgoing_credential_reference.clone(),
            timestamp,
        ],
    );

    if let Err(error) = save_result {
        if !existed_before {
            let mut cleanup_arguments = vec!["delete".to_string(), incoming_reference];
            if has_outgoing_credential {
                cleanup_arguments.push(outgoing_reference);
            }
            let _: Result<serde_json::Value, _> = run_helper(&app, &cleanup_arguments);
        }
        return Err(format!(
            "E-Mail-Konto konnte nicht gespeichert werden: {error}"
        ));
    }

    get_mail_account_by_source(&conn, &normalized_id)
}

#[tauri::command]
pub fn test_mail_connection(app: AppHandle, account_id: i64) -> Result<(), String> {
    let conn = open_db(&app)?;
    let account = get_mail_account(&conn, account_id)?
        .ok_or_else(|| "Gespeichertes E-Mail-Konto wurde nicht gefunden.".to_string())?;
    if account.incoming_use_spa {
        return Err("IMAP-Konten mit SPA können derzeit nicht getestet werden.".to_string());
    }

    let _: serde_json::Value = run_helper(
        &app,
        &[
            "test".to_string(),
            account.incoming_server,
            account.incoming_port.to_string(),
            account.incoming_security,
            account.incoming_user,
            account.credential_reference,
        ],
    )?;
    Ok(())
}

#[tauri::command]
pub fn reveal_mail_password(
    app: AppHandle,
    account_id: i64,
) -> Result<RevealedMailPassword, String> {
    let conn = open_db(&app)?;
    let account = get_mail_account(&conn, account_id)?
        .ok_or_else(|| "Gespeichertes E-Mail-Konto wurde nicht gefunden.".to_string())?;

    run_secret_helper(&app, &["reveal".to_string(), account.credential_reference])
}

#[tauri::command]
pub fn get_migration_capture_status(app: AppHandle) -> Result<MigrationCaptureStatus, String> {
    let conn = open_db(&app)?;
    let completed_at = get_migration_setting(&conn, MIGRATION_CAPTURE_COMPLETED_KEY)?;
    Ok(MigrationCaptureStatus {
        configured: migration_capture_endpoint().is_some(),
        completed: completed_at.is_some(),
        completed_at,
    })
}

#[tauri::command]
pub fn reset_migration_capture_status(app: AppHandle) -> Result<MigrationCaptureStatus, String> {
    let conn = open_db(&app)?;
    conn.execute(
        "DELETE FROM app_settings WHERE key = ?1",
        [MIGRATION_CAPTURE_COMPLETED_KEY],
    )
    .map_err(|error| format!("EDV-Übertragung konnte nicht erneut freigegeben werden: {error}"))?;
    let diagnostic_id = Uuid::new_v4().to_string();
    append_migration_diagnostic(
        &app,
        &diagnostic_id,
        "manual_reopen",
        "success",
        "completion_state_cleared_submission_id_preserved",
    );
    drop(conn);
    get_migration_capture_status(app)
}

fn migration_http_status_is_retryable(status: reqwest::StatusCode) -> bool {
    matches!(status.as_u16(), 408 | 409 | 423 | 425 | 429 | 500..=599)
}

fn migration_http_error_message(status: reqwest::StatusCode) -> String {
    match status.as_u16() {
        401 | 403 => format!(
            "Die sichere EDV-Übertragungsadresse hat die Anfrage abgelehnt (EDV-AUTH-{}). Bitte informieren Sie die EDV.",
            status.as_u16()
        ),
        404 | 410 => format!(
            "Die sichere EDV-Übertragungsadresse ist nicht mehr aktiv (EDV-ENDPUNKT-{}). Bitte informieren Sie die EDV.",
            status.as_u16()
        ),
        code => format!(
            "Die EDV hat die Übertragung nach mehreren Versuchen nicht bestätigt (EDV-HTTP-{code}). Bitte versuchen Sie es später erneut oder informieren Sie die EDV."
        ),
    }
}

fn migration_network_error_message(error: &reqwest::Error) -> String {
    if error.is_timeout() {
        return "Die Antwort der EDV hat auch nach mehreren Versuchen zu lange gedauert (EDV-TIMEOUT). Bitte versuchen Sie es später erneut oder informieren Sie die EDV.".to_string();
    }
    if error.is_connect() {
        return "Die sichere EDV-Übertragungsadresse war nicht erreichbar (EDV-VERBINDUNG). Bitte prüfen Sie die Netzwerkverbindung und versuchen Sie es erneut.".to_string();
    }
    "Die verschlüsselte Übertragung wurde durch einen Netzwerkfehler unterbrochen (EDV-NETZWERK). Bitte versuchen Sie es erneut.".to_string()
}

async fn deliver_migration_payload(
    app: &AppHandle,
    diagnostic_id: &str,
    client: &reqwest::Client,
    endpoint: &str,
    submission_id: &str,
    payload_json: &[u8],
) -> Result<(), String> {
    let mut last_network_error: Option<reqwest::Error> = None;
    let mut last_http_status: Option<reqwest::StatusCode> = None;

    for attempt in 0..MIGRATION_DELIVERY_ATTEMPTS {
        if MIGRATION_RETRY_DELAYS_SECONDS[attempt] > 0 {
            tokio::time::sleep(Duration::from_secs(MIGRATION_RETRY_DELAYS_SECONDS[attempt])).await;
        }

        let started = Instant::now();
        match client
            .post(endpoint)
            .header(reqwest::header::CONTENT_TYPE, "application/json")
            .header("x-dmh-submission-id", submission_id)
            .header("x-dmh-diagnostic-id", diagnostic_id)
            .body(payload_json.to_vec())
            .send()
            .await
        {
            Ok(response) if response.status().is_success() => {
                append_migration_diagnostic(
                    app,
                    diagnostic_id,
                    "http_delivery",
                    "success",
                    &format!(
                        "attempt={} status={} duration_ms={}",
                        attempt + 1,
                        response.status().as_u16(),
                        started.elapsed().as_millis()
                    ),
                );
                return Ok(());
            }
            Ok(response) => {
                let status = response.status();
                append_migration_diagnostic(
                    app,
                    diagnostic_id,
                    "http_delivery",
                    "error",
                    &format!(
                        "attempt={} status={} duration_ms={}",
                        attempt + 1,
                        status.as_u16(),
                        started.elapsed().as_millis()
                    ),
                );
                last_http_status = Some(status);
                last_network_error = None;
                if !migration_http_status_is_retryable(status) {
                    return Err(migration_http_error_message(status));
                }
            }
            Err(error) => {
                let kind = if error.is_timeout() {
                    "timeout"
                } else if error.is_connect() {
                    "connect"
                } else {
                    "network"
                };
                append_migration_diagnostic(
                    app,
                    diagnostic_id,
                    "http_delivery",
                    "error",
                    &format!(
                        "attempt={} kind={} duration_ms={}",
                        attempt + 1,
                        kind,
                        started.elapsed().as_millis()
                    ),
                );
                last_network_error = Some(error);
                last_http_status = None;
            }
        }
    }

    if let Some(status) = last_http_status {
        return Err(migration_http_error_message(status));
    }
    if let Some(error) = last_network_error {
        return Err(migration_network_error_message(&error));
    }
    Err("Die verschlüsselte Übertragung konnte nicht bestätigt werden (EDV-UNBEKANNT). Bitte informieren Sie die EDV.".to_string())
}

#[tauri::command]
pub async fn submit_migration_credentials(
    app: AppHandle,
) -> Result<MigrationCaptureResult, String> {
    let diagnostic_id = Uuid::new_v4().to_string();
    append_migration_diagnostic(
        &app,
        &diagnostic_id,
        "submission",
        "started",
        "user_confirmed",
    );
    match submit_migration_credentials_inner(app.clone(), &diagnostic_id).await {
        Ok(result) => {
            append_migration_diagnostic(&app, &diagnostic_id, "submission", "success", "completed");
            Ok(result)
        }
        Err(message) => {
            append_migration_diagnostic(
                &app,
                &diagnostic_id,
                "submission",
                "error",
                "not_completed",
            );
            Err(format!(
                "{message} Diagnose-ID: {}.",
                short_diagnostic_id(&diagnostic_id)
            ))
        }
    }
}

async fn submit_migration_credentials_inner(
    app: AppHandle,
    diagnostic_id: &str,
) -> Result<MigrationCaptureResult, String> {
    let endpoint = migration_capture_endpoint().ok_or_else(|| {
        migration_stage_error(
            &app,
            diagnostic_id,
            "endpoint_configuration",
            "not_configured",
            "Die zeitlich begrenzte E-Mail-Migration ist in diesem Build nicht aktiviert."
                .to_string(),
        )
    })?;
    let submission_id = {
        let conn = open_db(&app).map_err(|message| {
            migration_stage_error(
                &app,
                diagnostic_id,
                "local_database",
                "open_failed",
                message,
            )
        })?;
        if let Some(completed_at) = get_migration_setting(&conn, MIGRATION_CAPTURE_COMPLETED_KEY)
            .map_err(|message| {
                migration_stage_error(
                    &app,
                    diagnostic_id,
                    "submission_state",
                    "read_failed",
                    message,
                )
            })?
        {
            append_migration_diagnostic(
                &app,
                diagnostic_id,
                "submission_state",
                "success",
                "already_completed",
            );
            return Ok(MigrationCaptureResult {
                accounts_submitted: 0,
                completed_at,
                accounts: Vec::new(),
            });
        }

        match get_migration_setting(&conn, MIGRATION_CAPTURE_SUBMISSION_KEY).map_err(|message| {
            migration_stage_error(
                &app,
                diagnostic_id,
                "submission_state",
                "read_failed",
                message,
            )
        })? {
            Some(value) => value,
            None => {
                let value = Uuid::new_v4().to_string();
                set_migration_setting(&conn, MIGRATION_CAPTURE_SUBMISSION_KEY, &value).map_err(
                    |message| {
                        migration_stage_error(
                            &app,
                            diagnostic_id,
                            "submission_state",
                            "write_failed",
                            message,
                        )
                    },
                )?;
                value
            }
        }
    };

    let candidates = scan_outlook_accounts(app.clone()).map_err(|message| {
        migration_stage_error(&app, diagnostic_id, "outlook_scan", "scan_failed", message)
    })?;
    let candidates = candidates
        .into_iter()
        .filter(|candidate| candidate.password_available)
        .collect::<Vec<_>>();
    if candidates.is_empty() {
        return Err(migration_stage_error(
            &app,
            diagnostic_id,
            "outlook_scan",
            "no_saved_password",
            "In Outlook Classic wurde kein IMAP-Konto mit gespeichertem Kennwort gefunden."
                .to_string(),
        ));
    }
    append_migration_diagnostic(
        &app,
        diagnostic_id,
        "outlook_scan",
        "success",
        &format!("eligible_accounts={}", candidates.len()),
    );

    let captured_at = chrono::Utc::now().to_rfc3339();
    let computer = env::var("COMPUTERNAME").unwrap_or_else(|_| "Windows-PC".to_string());
    let mut accounts = Vec::with_capacity(candidates.len());
    let mut account_summaries = Vec::with_capacity(candidates.len());

    for candidate in candidates {
        let account = import_outlook_account(app.clone(), candidate.source_account_id).map_err(
            |message| {
                migration_stage_error(
                    &app,
                    diagnostic_id,
                    "outlook_import",
                    "account_import_failed",
                    message,
                )
            },
        )?;
        let mut revealed = run_secret_helper(
            &app,
            &["reveal".to_string(), account.credential_reference.clone()],
        )
        .map_err(|message| {
            migration_stage_error(
                &app,
                diagnostic_id,
                "credential_reveal",
                "credential_unavailable",
                message,
            )
        })?;
        account_summaries.push(MigrationAccountSummary {
            account_name: account.account_name.clone(),
            email: account.email.clone(),
            incoming_user: account.incoming_user.clone(),
            incoming_server: account.incoming_server.clone(),
            incoming_port: account.incoming_port,
            incoming_security: account.incoming_security.clone(),
        });
        accounts.push(MigrationAccountSubmission {
            account_name: account.account_name,
            email: account.email,
            incoming_user: account.incoming_user,
            incoming_server: account.incoming_server,
            incoming_port: account.incoming_port,
            incoming_security: account.incoming_security,
            password: std::mem::take(&mut revealed.password),
        });
    }

    let accounts_submitted = accounts.len();
    let payload =
        encrypt_migration_accounts(submission_id, captured_at.clone(), computer, accounts)
            .map_err(|message| {
                migration_stage_error(
                    &app,
                    diagnostic_id,
                    "encryption",
                    "encryption_failed",
                    message,
                )
            })?;
    let payload_json = serde_json::to_vec(&payload).map_err(|_| {
        migration_stage_error(
            &app,
            diagnostic_id,
            "serialization",
            "serialization_failed",
            "Das verschlüsselte Datenpaket konnte nicht vorbereitet werden.".to_string(),
        )
    })?;
    let client = reqwest::Client::builder()
        .connect_timeout(Duration::from_secs(15))
        .timeout(Duration::from_secs(MIGRATION_DELIVERY_TIMEOUT_SECONDS))
        .user_agent(concat!(
            "DMH-Kontakte-und-Kalender/",
            env!("CARGO_PKG_VERSION")
        ))
        .build()
        .map_err(|_| {
            migration_stage_error(
                &app,
                diagnostic_id,
                "http_client",
                "client_build_failed",
                "Die sichere Übertragung konnte nicht vorbereitet werden.".to_string(),
            )
        })?;
    deliver_migration_payload(
        &app,
        diagnostic_id,
        &client,
        endpoint,
        &payload.submission_id,
        &payload_json,
    )
    .await
    .map_err(|message| {
        migration_stage_error(&app, diagnostic_id, "delivery", "delivery_failed", message)
    })?;

    {
        let conn = open_db(&app).map_err(|message| {
            migration_stage_error(
                &app,
                diagnostic_id,
                "completion_state",
                "database_open_failed",
                message,
            )
        })?;
        set_migration_setting(&conn, MIGRATION_CAPTURE_COMPLETED_KEY, &captured_at).map_err(
            |message| {
                migration_stage_error(
                    &app,
                    diagnostic_id,
                    "completion_state",
                    "write_failed",
                    message,
                )
            },
        )?;
    }

    Ok(MigrationCaptureResult {
        accounts_submitted,
        completed_at: captured_at,
        accounts: account_summaries,
    })
}

#[tauri::command]
pub fn remove_mail_account(app: AppHandle, account_id: i64) -> Result<(), String> {
    let conn = open_db(&app)?;
    let account = get_mail_account(&conn, account_id)?
        .ok_or_else(|| "Gespeichertes E-Mail-Konto wurde nicht gefunden.".to_string())?;
    let references = std::iter::once(account.credential_reference)
        .chain(account.outgoing_credential_reference)
        .filter(|reference| credential_reference_belongs_to_current_channel(reference))
        .collect::<Vec<_>>();
    if !references.is_empty() {
        let mut arguments = vec!["delete".to_string()];
        arguments.extend(references);
        let _: serde_json::Value = run_helper(&app, &arguments)?;
    }
    conn.execute("DELETE FROM mail_accounts WHERE id = ?1", [account_id])
        .map_err(|error| error.to_string())?;
    Ok(())
}

pub(crate) fn remove_all_mail_credentials(app: &AppHandle) -> Result<usize, String> {
    let conn = open_db(app)?;
    let mut statement = conn
        .prepare(
            "SELECT credential_reference, outgoing_credential_reference
             FROM mail_accounts",
        )
        .map_err(|error| error.to_string())?;
    let rows = statement
        .query_map([], |row| {
            Ok((row.get::<_, String>(0)?, row.get::<_, Option<String>>(1)?))
        })
        .map_err(|error| error.to_string())?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|error| error.to_string())?;
    let references = rows
        .into_iter()
        .flat_map(|(incoming, outgoing)| std::iter::once(incoming).chain(outgoing))
        .filter(|reference| credential_reference_belongs_to_current_channel(reference))
        .collect::<HashSet<_>>();
    if references.is_empty() {
        return Ok(0);
    }
    let mut arguments = vec!["delete".to_string()];
    arguments.extend(references.iter().cloned());
    let _: serde_json::Value = run_helper(app, &arguments)?;
    Ok(references.len())
}

#[cfg(test)]
mod tests {
    use super::*;
    use rsa::RsaPrivateKey;

    #[test]
    fn diagnostic_fields_cannot_inject_lines_and_are_bounded() {
        let sanitized = sanitize_diagnostic_value(&format!("stage\r\n{}", "x".repeat(300)));
        assert!(!sanitized.contains('\r'));
        assert!(!sanitized.contains('\n'));
        assert_eq!(sanitized.chars().count(), 160);
    }

    #[test]
    fn credential_references_are_scoped_to_the_active_release_channel() {
        let expected = format!("{}/imap/ABC/incoming", credential_namespace());
        let other = if credential_namespace() == STABLE_CREDENTIAL_NAMESPACE {
            format!("{ADMIN_TEST_CREDENTIAL_NAMESPACE}/imap/ABC/incoming")
        } else {
            format!("{STABLE_CREDENTIAL_NAMESPACE}/imap/ABC/incoming")
        };
        assert!(credential_reference_belongs_to_current_channel(&expected));
        assert!(!credential_reference_belongs_to_current_channel(&other));
        assert!(!credential_reference_belongs_to_current_channel(
            "unrelated/credential"
        ));
    }

    #[test]
    fn migration_delivery_retries_only_transient_http_failures() {
        for status in [408, 409, 423, 425, 429, 500, 503, 599] {
            let status = reqwest::StatusCode::from_u16(status).expect("valid status");
            assert!(
                migration_http_status_is_retryable(status),
                "{status} should be retryable"
            );
        }

        for status in [400, 401, 403, 404, 410, 422] {
            let status = reqwest::StatusCode::from_u16(status).expect("valid status");
            assert!(
                !migration_http_status_is_retryable(status),
                "{status} should not be retryable"
            );
        }
    }

    #[test]
    fn migration_delivery_errors_expose_actionable_diagnostic_codes() {
        assert!(
            migration_http_error_message(reqwest::StatusCode::UNAUTHORIZED).contains("EDV-AUTH")
        );
        assert!(migration_http_error_message(reqwest::StatusCode::GONE).contains("EDV-ENDPUNKT"));
        assert!(
            migration_http_error_message(reqwest::StatusCode::UNPROCESSABLE_ENTITY)
                .contains("EDV-HTTP-422")
        );
    }

    #[test]
    fn migration_envelope_round_trips_without_plaintext_fields() {
        let private_key = RsaPrivateKey::new(&mut OsRng, 2048).expect("private key");
        let public_key = private_key.to_public_key();
        let submission_id = "11111111-2222-3333-4444-555555555555".to_string();
        let captured_at = "2026-07-15T12:00:00Z".to_string();
        let computer = "TEST-PC".to_string();
        let key_id = "TEST-KEY".to_string();
        let envelope = encrypt_migration_accounts_with_key(
            submission_id.clone(),
            captured_at.clone(),
            computer.clone(),
            vec![MigrationAccountSubmission {
                account_name: "Testkonto".to_string(),
                email: "test@example.invalid".to_string(),
                incoming_user: "test-user".to_string(),
                incoming_server: "imap.example.invalid".to_string(),
                incoming_port: 993,
                incoming_security: "ssl".to_string(),
                password: "dummy-secret".to_string(),
            }],
            key_id.clone(),
            &public_key,
        )
        .expect("encrypt envelope");

        let serialized = serde_json::to_string(&envelope).expect("serialize envelope");
        assert!(!serialized.contains("dummy-secret"));
        assert!(!serialized.contains("test@example.invalid"));

        let wrapped_key = BASE64_STANDARD
            .decode(&envelope.wrapped_key)
            .expect("wrapped key");
        let data_key = private_key
            .decrypt(Oaep::new::<Sha256>(), &wrapped_key)
            .expect("unwrap key");
        let nonce = BASE64_STANDARD.decode(&envelope.nonce).expect("nonce");
        let ciphertext = BASE64_STANDARD
            .decode(&envelope.ciphertext)
            .expect("ciphertext");
        let aad = migration_aad(
            envelope.version,
            &submission_id,
            &captured_at,
            &computer,
            &key_id,
        );
        let cipher = Aes256Gcm::new_from_slice(&data_key).expect("AES key");
        let plaintext = cipher
            .decrypt(
                Nonce::from_slice(&nonce),
                Payload {
                    msg: &ciphertext,
                    aad: &aad,
                },
            )
            .expect("decrypt payload");
        let content: MigrationEncryptedContent =
            serde_json::from_slice(&plaintext).expect("payload JSON");

        assert_eq!(content.accounts.len(), 1);
        assert_eq!(content.accounts[0].email, "test@example.invalid");
        assert_eq!(content.accounts[0].incoming_security, "ssl");
        assert_eq!(content.accounts[0].password, "dummy-secret");
        assert_eq!(envelope.algorithm, MIGRATION_ENVELOPE_ALGORITHM);
    }
}
