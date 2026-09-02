use crate::{hidden_command, now, open_db, AppState};
use aes_gcm::{
    aead::{Aead, KeyInit, Payload},
    Aes256Gcm, Nonce,
};
use argon2::{
    password_hash::{
        rand_core::OsRng as PasswordOsRng, PasswordHash, PasswordHasher, PasswordVerifier,
        SaltString,
    },
    Argon2,
};
use base64::{engine::general_purpose::STANDARD as BASE64_STANDARD, Engine as _};
use chrono::Utc;
use rand::{rngs::OsRng, Rng, RngCore};
use rusqlite::{params, OptionalExtension};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::time::{Duration, Instant};
use tauri::{AppHandle, Manager};
use uuid::Uuid;
use zeroize::{Zeroize, Zeroizing};

const VAULT_KEY_LENGTH: usize = 32;
const VAULT_NONCE_LENGTH: usize = 12;
const RECOVERY_VALIDITY: Duration = Duration::from_secs(10 * 60);
const RECOVERY_REQUEST_DELAY: Duration = Duration::from_secs(60);
const LOGIN_BLOCK_DURATION: Duration = Duration::from_secs(30);
const MAX_LOGIN_FAILURES: u8 = 5;
const MAX_RECOVERY_ATTEMPTS: u8 = 5;
const DPAPI_ENTROPY: &[u8] = b"de.dmh.agendakontakte.vault.v1";

#[derive(Default)]
pub(crate) struct VaultRuntime {
    key: Option<Zeroizing<[u8; VAULT_KEY_LENGTH]>>,
    recovery: Option<RecoveryChallenge>,
    local_account_recovery: Option<LocalAccountRecoveryChallenge>,
    login_failures: u8,
    login_blocked_until: Option<Instant>,
}

pub(crate) fn clear_runtime(app: &AppHandle) -> Result<(), String> {
    let state = app.state::<AppState>();
    let mut runtime = state
        .vault
        .lock()
        .map_err(|_| "Der Passwort-Speicher konnte nicht zurückgesetzt werden.".to_string())?;
    *runtime = VaultRuntime::default();
    Ok(())
}

struct RecoveryChallenge {
    code_hash: [u8; 32],
    expires_at: Instant,
    next_request_at: Instant,
    attempts: u8,
}

struct LocalAccountRecoveryChallenge {
    email: String,
    challenge: RecoveryChallenge,
}

#[derive(Debug)]
struct VaultConfigRow {
    protected_key: Vec<u8>,
    username: String,
    recovery_email: String,
    password_hash: Option<String>,
    protection_enabled: bool,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct VaultStatus {
    protection_enabled: bool,
    unlocked: bool,
    username: String,
    recovery_email: String,
    recovery_email_hint: String,
    recovery_available: bool,
    entry_count: usize,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct VaultRecoveryDelivery {
    recovery_email_hint: String,
    expires_in_minutes: u8,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct VaultEntry {
    id: i64,
    kind: String,
    totp_algorithm: Option<String>,
    totp_digits: Option<u32>,
    totp_period: Option<u32>,
    platform: String,
    username: String,
    password: String,
    url: String,
    description: String,
    created_at: String,
    updated_at: String,
    deleted_at: Option<String>,
}

impl Drop for VaultEntry {
    fn drop(&mut self) {
        self.password.zeroize();
    }
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct VaultEntryInput {
    id: Option<i64>,
    #[serde(default)]
    kind: String,
    #[serde(default)]
    totp_algorithm: Option<String>,
    #[serde(default)]
    totp_digits: Option<u32>,
    #[serde(default)]
    totp_period: Option<u32>,
    platform: String,
    username: String,
    password: String,
    url: String,
    description: String,
}

impl Drop for VaultEntryInput {
    fn drop(&mut self) {
        self.password.zeroize();
    }
}

#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct VaultEntrySecret {
    #[serde(default)]
    kind: String,
    #[serde(default)]
    totp_algorithm: Option<String>,
    #[serde(default)]
    totp_digits: Option<u32>,
    #[serde(default)]
    totp_period: Option<u32>,
    platform: String,
    username: String,
    password: String,
    url: String,
    description: String,
}

impl Drop for VaultEntrySecret {
    fn drop(&mut self) {
        self.password.zeroize();
    }
}

const AUTOMATIC_PASSWORD_BACKUP_LATEST: &str = "DMH-Kennwörter-Auto-Backup.enc.json";
const AUTOMATIC_PASSWORD_BACKUP_SNAPSHOT_PREFIX: &str = "auto-password-backup-";
const AUTOMATIC_PASSWORD_BACKUP_VERSION: &str = "1.0.0";
const DELETED_ELEMENT_MARKER: &str = "Gelöschtes Element";

#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct AutomaticPasswordBackup {
    version: String,
    exported_at: String,
    vault: Option<AutomaticVaultConfig>,
    entries: Vec<AutomaticPasswordEntry>,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
struct AutomaticVaultConfig {
    protected_key: String,
    username: String,
    recovery_email: String,
    password_hash: Option<String>,
    protection_enabled: bool,
    created_at: String,
    updated_at: String,
}

#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct AutomaticPasswordEntry {
    entry_uuid: String,
    nonce: String,
    ciphertext: String,
    created_at: String,
    updated_at: String,
    deleted_at: Option<String>,
}

fn load_config(app: &AppHandle) -> Result<Option<VaultConfigRow>, String> {
    let conn = open_db(app)?;
    conn.query_row(
        "SELECT protected_key, username, recovery_email, password_hash, protection_enabled
         FROM vault_config WHERE id = 1",
        [],
        |row| {
            Ok(VaultConfigRow {
                protected_key: row.get(0)?,
                username: row.get(1)?,
                recovery_email: row.get(2)?,
                password_hash: row.get(3)?,
                protection_enabled: row.get::<_, i64>(4)? != 0,
            })
        },
    )
    .optional()
    .map_err(|error| error.to_string())
}

fn current_session_key(app: &AppHandle) -> Result<Option<Zeroizing<[u8; 32]>>, String> {
    let state = app.state::<AppState>();
    let runtime = state
        .vault
        .lock()
        .map_err(|_| "Der Passwort-Speicher konnte nicht gesperrt werden.".to_string())?;
    Ok(runtime.key.as_ref().map(|key| Zeroizing::new(**key)))
}

fn set_session_key(app: &AppHandle, key: Zeroizing<[u8; 32]>) -> Result<(), String> {
    let state = app.state::<AppState>();
    let mut runtime = state
        .vault
        .lock()
        .map_err(|_| "Der Passwort-Speicher konnte nicht gesperrt werden.".to_string())?;
    runtime.key = Some(key);
    runtime.login_failures = 0;
    runtime.login_blocked_until = None;
    Ok(())
}

fn ensure_vault_key(app: &AppHandle) -> Result<Zeroizing<[u8; 32]>, String> {
    if let Some(key) = current_session_key(app)? {
        return Ok(key);
    }

    if let Some(config) = load_config(app)? {
        if config.protection_enabled {
            return Err("Der Passwort-Speicher ist gesperrt.".to_string());
        }
        let key = unprotect_key(&config.protected_key)?;
        set_session_key(app, Zeroizing::new(*key))?;
        return Ok(key);
    }

    let mut key = Zeroizing::new([0u8; VAULT_KEY_LENGTH]);
    OsRng.fill_bytes(&mut key[..]);
    let protected_key = protect_key(&key[..])?;
    let timestamp = now();
    let conn = open_db(app)?;
    conn.execute(
        "INSERT INTO vault_config (
            id, protected_key, username, recovery_email, password_hash,
            protection_enabled, created_at, updated_at
         ) VALUES (1, ?1, '', '', NULL, 0, ?2, ?2)",
        params![protected_key, timestamp],
    )
    .map_err(|error| format!("Der Passwort-Speicher konnte nicht vorbereitet werden: {error}"))?;
    set_session_key(app, Zeroizing::new(*key))?;
    Ok(key)
}

fn validate_protection_fields(username: &str, email: &str, password: &str) -> Result<(), String> {
    let username = username.trim();
    let email = email.trim();
    if username.len() < 3 || username.len() > 80 {
        return Err("Der Benutzername muss zwischen 3 und 80 Zeichen lang sein.".to_string());
    }
    if email.len() > 254 || !email.contains('@') || email.starts_with('@') || email.ends_with('@') {
        return Err(
            "Bitte geben Sie eine gültige Wiederherstellungs-E-Mail-Adresse ein.".to_string(),
        );
    }
    if password.chars().count() < 8 {
        return Err("Das App-Kennwort muss mindestens 8 Zeichen lang sein.".to_string());
    }
    if password.len() > 1024 {
        return Err("Das App-Kennwort ist zu lang.".to_string());
    }
    Ok(())
}

fn hash_password(password: &str) -> Result<String, String> {
    let salt = SaltString::generate(&mut PasswordOsRng);
    Argon2::default()
        .hash_password(password.as_bytes(), &salt)
        .map(|hash| hash.to_string())
        .map_err(|_| "Das App-Kennwort konnte nicht sicher gespeichert werden.".to_string())
}

fn password_matches(password: &str, encoded_hash: &str) -> bool {
    PasswordHash::new(encoded_hash).ok().is_some_and(|hash| {
        Argon2::default()
            .verify_password(password.as_bytes(), &hash)
            .is_ok()
    })
}

fn validate_entry(entry: &VaultEntryInput) -> Result<(), String> {
    if !entry.kind.trim().is_empty()
        && entry.kind.trim() != "password"
        && entry.kind.trim() != "totp"
    {
        return Err("Unbekannter Tresor-Eintragstyp.".to_string());
    }
    if entry.kind.trim() == "totp" {
        if let Some(algorithm) = &entry.totp_algorithm {
            if !["SHA1", "SHA256", "SHA512"].contains(&algorithm.as_str()) {
                return Err("Unbekannter TOTP-Algorithmus.".to_string());
            }
        }
        if let Some(digits) = entry.totp_digits {
            if digits != 6 && digits != 8 {
                return Err("Die Anzahl der TOTP-Ziffern ist ungültig.".to_string());
            }
        }
        if let Some(period) = entry.totp_period {
            if !(10..=120).contains(&period) {
                return Err("Das TOTP-Zeitfenster ist ungültig.".to_string());
            }
        }
    }
    if entry.platform.trim().is_empty() {
        return Err("Bitte geben Sie eine Plattform ein.".to_string());
    }
    if entry.platform.len() > 200 || entry.username.len() > 500 || entry.url.len() > 2000 {
        return Err("Plattform, Benutzername oder Link ist zu lang.".to_string());
    }
    if entry.password.is_empty() {
        return Err("Bitte geben Sie ein Kennwort ein.".to_string());
    }
    if entry.password.len() > 2048 || entry.description.len() > 8000 {
        return Err("Kennwort oder Beschreibung ist zu lang.".to_string());
    }
    let url = entry.url.trim();
    if !url.is_empty() && !url.starts_with("https://") && !url.starts_with("http://") {
        return Err("Der Link muss mit https:// oder http:// beginnen.".to_string());
    }
    Ok(())
}

fn entry_aad(entry_uuid: &str) -> Vec<u8> {
    format!("DMH-Vault-Entry-v1\n{entry_uuid}").into_bytes()
}

fn encrypt_entry(
    key: &[u8; 32],
    entry_uuid: &str,
    secret: &VaultEntrySecret,
) -> Result<(Vec<u8>, Vec<u8>), String> {
    let plaintext = Zeroizing::new(
        serde_json::to_vec(secret)
            .map_err(|_| "Der Kennwort-Eintrag konnte nicht vorbereitet werden.".to_string())?,
    );
    let mut nonce = [0u8; VAULT_NONCE_LENGTH];
    OsRng.fill_bytes(&mut nonce);
    let cipher = Aes256Gcm::new_from_slice(key)
        .map_err(|_| "Die lokale Verschlüsselung konnte nicht vorbereitet werden.".to_string())?;
    let aad = entry_aad(entry_uuid);
    let ciphertext = cipher
        .encrypt(
            Nonce::from_slice(&nonce),
            Payload {
                msg: plaintext.as_slice(),
                aad: &aad,
            },
        )
        .map_err(|_| "Der Kennwort-Eintrag konnte nicht verschlüsselt werden.".to_string())?;
    Ok((nonce.to_vec(), ciphertext))
}

fn decrypt_entry(
    key: &[u8; 32],
    entry_uuid: &str,
    nonce: &[u8],
    ciphertext: &[u8],
) -> Result<VaultEntrySecret, String> {
    if nonce.len() != VAULT_NONCE_LENGTH {
        return Err("Ein verschlüsselter Kennwort-Eintrag ist beschädigt.".to_string());
    }
    let cipher = Aes256Gcm::new_from_slice(key)
        .map_err(|_| "Die lokale Entschlüsselung konnte nicht vorbereitet werden.".to_string())?;
    let aad = entry_aad(entry_uuid);
    let plaintext = Zeroizing::new(
        cipher
            .decrypt(
                Nonce::from_slice(nonce),
                Payload {
                    msg: ciphertext,
                    aad: &aad,
                },
            )
            .map_err(|_| "Ein Kennwort-Eintrag konnte nicht entschlüsselt werden.".to_string())?,
    );
    serde_json::from_slice(&plaintext)
        .map_err(|_| "Ein entschlüsselter Kennwort-Eintrag ist beschädigt.".to_string())
}

fn automatic_password_backup_path(app: &AppHandle) -> Result<std::path::PathBuf, String> {
    Ok(crate::automatic_backup_dir(app)?.join(AUTOMATIC_PASSWORD_BACKUP_LATEST))
}

fn automatic_password_backup_app_data_path(app: &AppHandle) -> Result<std::path::PathBuf, String> {
    Ok(crate::automatic_backup_app_data_dir(app)?.join(AUTOMATIC_PASSWORD_BACKUP_LATEST))
}

fn read_automatic_password_backup(
    app: &AppHandle,
) -> Result<Option<AutomaticPasswordBackup>, String> {
    let app_data_path = automatic_password_backup_app_data_path(app)?;
    let path = if app_data_path.is_file() {
        Some(app_data_path)
    } else {
        automatic_password_backup_path(app)
            .ok()
            .filter(|path| path.is_file())
    };
    let Some(path) = path else { return Ok(None) };
    let content = std::fs::read_to_string(path).map_err(|error| {
        format!("Automatische Kennwort-Sicherung konnte nicht gelesen werden: {error}")
    })?;
    let backup = serde_json::from_str(&content).map_err(|error| {
        format!("Automatische Kennwort-Sicherung ist beschädigt oder unbekannt: {error}")
    })?;
    Ok(Some(backup))
}

fn purge_targets_from_password_backup(
    backup: &mut AutomaticPasswordBackup,
    entry_uuids: &std::collections::HashSet<String>,
) -> bool {
    let previous_count = backup.entries.len();
    backup
        .entries
        .retain(|entry| !entry_uuids.contains(&entry.entry_uuid));
    previous_count != backup.entries.len()
}

pub(crate) fn purge_targets_from_automatic_backups(
    app: &AppHandle,
    entry_uuids: &std::collections::HashSet<String>,
) -> Result<(), String> {
    if entry_uuids.is_empty() {
        return Ok(());
    }
    for path in crate::automatic_backup_file_paths(
        app,
        AUTOMATIC_PASSWORD_BACKUP_LATEST,
        AUTOMATIC_PASSWORD_BACKUP_SNAPSHOT_PREFIX,
    )? {
        let content = std::fs::read_to_string(&path).map_err(|error| {
            format!(
                "Automatische Kennwort-Sicherung konnte nicht gelesen werden ({}): {error}",
                path.display()
            )
        })?;
        let mut backup =
            serde_json::from_str::<AutomaticPasswordBackup>(&content).map_err(|error| {
                format!(
                    "Automatische Kennwort-Sicherung ist beschädigt ({}): {error}",
                    path.display()
                )
            })?;
        if purge_targets_from_password_backup(&mut backup, entry_uuids) {
            let json = serde_json::to_string_pretty(&backup).map_err(|error| error.to_string())?;
            crate::replace_json_file(&path, &json)?;
        }
    }
    Ok(())
}

fn decode_automatic_password_entry(
    entry: &AutomaticPasswordEntry,
) -> Result<(Vec<u8>, Vec<u8>), String> {
    let nonce = BASE64_STANDARD.decode(&entry.nonce).map_err(|_| {
        "Eine automatische Kennwort-Sicherung enthält eine ungültige Nonce.".to_string()
    })?;
    let ciphertext = BASE64_STANDARD.decode(&entry.ciphertext).map_err(|_| {
        "Eine automatische Kennwort-Sicherung enthält verschlüsselte beschädigte Daten.".to_string()
    })?;
    if nonce.len() != VAULT_NONCE_LENGTH || ciphertext.is_empty() || entry.entry_uuid.is_empty() {
        return Err(
            "Eine automatische Kennwort-Sicherung enthält einen ungültigen Eintrag.".to_string(),
        );
    }
    Ok((nonce, ciphertext))
}

fn automatic_backup_key(
    backup: &AutomaticPasswordBackup,
) -> Result<Zeroizing<[u8; VAULT_KEY_LENGTH]>, String> {
    let vault = backup.vault.as_ref().ok_or_else(|| {
        "Die automatische Kennwort-Sicherung enthält keinen Schlüsselschutz.".to_string()
    })?;
    let protected_key = BASE64_STANDARD
        .decode(&vault.protected_key)
        .map_err(|_| "Der geschützte Kennwort-Schlüssel ist beschädigt.".to_string())?;
    unprotect_key(&protected_key)
}

fn append_deleted_marker(value: &str) -> String {
    if value.contains(DELETED_ELEMENT_MARKER) {
        return value.to_string();
    }
    if value.trim().is_empty() {
        DELETED_ELEMENT_MARKER.to_string()
    } else {
        format!("{value}\n{DELETED_ELEMENT_MARKER}")
    }
}

fn mark_automatic_password_entry_deleted(
    entry: &mut AutomaticPasswordEntry,
    key: &[u8; VAULT_KEY_LENGTH],
) -> Result<(), String> {
    let (nonce, ciphertext) = decode_automatic_password_entry(entry)?;
    let mut secret = decrypt_entry(key, &entry.entry_uuid, &nonce, &ciphertext)?;
    secret.description = append_deleted_marker(&secret.description);
    let (next_nonce, next_ciphertext) = encrypt_entry(key, &entry.entry_uuid, &secret)?;
    entry.nonce = BASE64_STANDARD.encode(next_nonce);
    entry.ciphertext = BASE64_STANDARD.encode(next_ciphertext);
    entry.deleted_at = Some(entry.deleted_at.clone().unwrap_or_else(now));
    entry.updated_at = now();
    Ok(())
}

fn load_current_automatic_password_backup(
    conn: &rusqlite::Connection,
) -> Result<AutomaticPasswordBackup, String> {
    let vault = conn
        .query_row(
            "SELECT protected_key, username, recovery_email, password_hash, protection_enabled, created_at, updated_at
             FROM vault_config WHERE id = 1",
            [],
            |row| {
                let protected_key: Vec<u8> = row.get(0)?;
                Ok(AutomaticVaultConfig {
                    protected_key: BASE64_STANDARD.encode(protected_key),
                    username: row.get(1)?,
                    recovery_email: row.get(2)?,
                    password_hash: row.get(3)?,
                    protection_enabled: row.get::<_, i64>(4)? != 0,
                    created_at: row.get(5)?,
                    updated_at: row.get(6)?,
                })
            },
        )
        .optional()
        .map_err(|error| error.to_string())?;

    let mut statement = conn
        .prepare(
            "SELECT entry_uuid, nonce, ciphertext, created_at, updated_at, deleted_at
             FROM vault_entries ORDER BY updated_at DESC",
        )
        .map_err(|error| error.to_string())?;
    let entries = statement
        .query_map([], |row| {
            let nonce: Vec<u8> = row.get(1)?;
            let ciphertext: Vec<u8> = row.get(2)?;
            Ok(AutomaticPasswordEntry {
                entry_uuid: row.get(0)?,
                nonce: BASE64_STANDARD.encode(nonce),
                ciphertext: BASE64_STANDARD.encode(ciphertext),
                created_at: row.get(3)?,
                updated_at: row.get(4)?,
                deleted_at: row.get(5)?,
            })
        })
        .map_err(|error| error.to_string())?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|error| error.to_string())?;

    Ok(AutomaticPasswordBackup {
        version: AUTOMATIC_PASSWORD_BACKUP_VERSION.to_string(),
        exported_at: now(),
        vault,
        entries,
    })
}

fn merge_automatic_password_backup(
    previous: Option<AutomaticPasswordBackup>,
    mut current: AutomaticPasswordBackup,
) -> Result<AutomaticPasswordBackup, String> {
    let previous = match (&current.vault, previous) {
        (Some(current_vault), Some(previous))
            if previous.vault.as_ref().is_some_and(|previous_vault| {
                previous_vault.protected_key == current_vault.protected_key
            }) =>
        {
            Some(previous)
        }
        (Some(_), Some(_)) => None,
        (_, previous) => previous,
    };
    if current.vault.is_none() {
        current.vault = previous.as_ref().and_then(|backup| backup.vault.clone());
    }

    let key_source = if current.vault.is_some() {
        Some(&current)
    } else {
        previous.as_ref()
    };
    let key = if current.entries.is_empty()
        && previous
            .as_ref()
            .is_none_or(|backup| backup.entries.is_empty())
    {
        None
    } else {
        Some(automatic_backup_key(key_source.ok_or_else(|| {
            "Kennwort-Sicherungsschlüssel fehlt.".to_string()
        })?)?)
    };

    for entry in &mut current.entries {
        if entry.deleted_at.is_some() {
            mark_automatic_password_entry_deleted(entry, key.as_deref().ok_or_else(|| {
                "Gelöschter Kennwort-Eintrag kann ohne Sicherungsschlüssel nicht markiert werden."
                    .to_string()
            })?)?;
        }
    }

    if let Some(previous) = previous {
        let current_ids: std::collections::HashSet<String> = current
            .entries
            .iter()
            .map(|entry| entry.entry_uuid.clone())
            .collect();
        for mut entry in previous.entries {
            if !current_ids.contains(&entry.entry_uuid) {
                mark_automatic_password_entry_deleted(
                    &mut entry,
                    key.as_deref().ok_or_else(|| {
                        "Gelöschter Kennwort-Eintrag kann ohne Sicherungsschlüssel nicht markiert werden."
                            .to_string()
                    })?,
                )?;
                current.entries.push(entry);
            }
        }
    }

    current
        .entries
        .sort_by(|left, right| right.updated_at.cmp(&left.updated_at));
    Ok(current)
}

fn validate_automatic_password_backup_data(backup: &AutomaticPasswordBackup) -> Result<(), String> {
    if backup.version != AUTOMATIC_PASSWORD_BACKUP_VERSION {
        return Err(
            "Version der automatischen Kennwort-Sicherung wird nicht unterstützt.".to_string(),
        );
    }
    if backup.entries.is_empty() && backup.vault.is_none() {
        return Ok(());
    }
    let _key = automatic_backup_key(backup)?;
    for entry in &backup.entries {
        let (nonce, ciphertext) = decode_automatic_password_entry(entry)?;
        decrypt_entry(&_key, &entry.entry_uuid, &nonce, &ciphertext)?;
    }
    Ok(())
}

pub(crate) fn validate_automatic_password_backup(app: &AppHandle) -> Result<bool, String> {
    let Some(backup) = read_automatic_password_backup(app)? else {
        return Ok(false);
    };
    validate_automatic_password_backup_data(&backup)?;
    Ok(true)
}

pub(crate) fn write_automatic_password_backup(
    app: &AppHandle,
    snapshot: bool,
) -> Result<(), String> {
    let app_data_directory = crate::automatic_backup_app_data_dir(&app)?;
    let app_data_latest_path = automatic_password_backup_app_data_path(&app)?;
    let previous = read_automatic_password_backup(&app)?;
    let conn = open_db(&app)?;
    let current = load_current_automatic_password_backup(&conn)?;
    let merged = merge_automatic_password_backup(previous, current)?;
    let json = serde_json::to_string_pretty(&merged).map_err(|error| error.to_string())?;
    crate::replace_json_file(&app_data_latest_path, &json)?;

    if snapshot {
        let stamp = Utc::now().format("%Y%m%d-%H%M%S-%f");
        let app_data_snapshots = app_data_directory.join("Snapshots");
        std::fs::create_dir_all(&app_data_snapshots).map_err(|error| error.to_string())?;
        crate::replace_json_file(
            &app_data_snapshots.join(format!("auto-password-backup-{stamp}.json")),
            &json,
        )?;
    }

    if let Ok(directory) = crate::automatic_backup_dir(&app) {
        crate::write_external_backup_best_effort(
            &directory.join(AUTOMATIC_PASSWORD_BACKUP_LATEST),
            &json,
            "Externe automatische Kennwort-Sicherung",
        );
        if snapshot {
            let snapshots = directory.join("Snapshots");
            if let Err(error) = std::fs::create_dir_all(&snapshots) {
                eprintln!(
                    "Externer Kennwort-Snapshot-Ordner konnte nicht erstellt werden: {error}"
                );
            } else {
                let stamp = Utc::now().format("%Y%m%d-%H%M%S-%f");
                crate::write_external_backup_best_effort(
                    &snapshots.join(format!("auto-password-backup-{stamp}.json")),
                    &json,
                    "Externer automatischer Kennwort-Snapshot",
                );
            }
        }
    }
    Ok(())
}

#[tauri::command]
pub fn create_automatic_password_backup(
    app: AppHandle,
    snapshot: Option<bool>,
) -> Result<(), String> {
    write_automatic_password_backup(&app, snapshot.unwrap_or(false))
}

pub(crate) fn restore_automatic_password_backup(app: &AppHandle) -> Result<bool, String> {
    let Some(backup) = read_automatic_password_backup(app)? else {
        return Ok(false);
    };
    validate_automatic_password_backup_data(&backup)?;
    let mut conn = open_db(app)?;
    let tx = conn.transaction().map_err(|error| error.to_string())?;
    tx.execute("DELETE FROM vault_entries", [])
        .map_err(|error| error.to_string())?;
    tx.execute("DELETE FROM vault_config", [])
        .map_err(|error| error.to_string())?;

    if let Some(vault) = backup.vault {
        let protected_key = BASE64_STANDARD
            .decode(vault.protected_key)
            .map_err(|_| "Der geschützte Kennwort-Schlüssel ist beschädigt.".to_string())?;
        tx.execute(
            "INSERT INTO vault_config (id, protected_key, username, recovery_email, password_hash, protection_enabled, created_at, updated_at)
             VALUES (1, ?, ?, ?, ?, ?, ?, ?)",
            rusqlite::params![
                protected_key,
                vault.username,
                vault.recovery_email,
                vault.password_hash,
                if vault.protection_enabled { 1 } else { 0 },
                vault.created_at,
                vault.updated_at
            ],
        )
        .map_err(|error| error.to_string())?;
    }

    for entry in backup.entries {
        let (nonce, ciphertext) = decode_automatic_password_entry(&entry)?;
        tx.execute(
            "INSERT INTO vault_entries (entry_uuid, nonce, ciphertext, created_at, updated_at, deleted_at)
             VALUES (?, ?, ?, ?, ?, ?)",
            rusqlite::params![
                entry.entry_uuid,
                nonce,
                ciphertext,
                entry.created_at,
                entry.updated_at,
                entry.deleted_at
            ],
        )
        .map_err(|error| error.to_string())?;
    }

    tx.commit().map_err(|error| error.to_string())?;
    clear_runtime(app)?;
    Ok(true)
}

#[tauri::command]
pub fn get_vault_status(app: AppHandle) -> Result<VaultStatus, String> {
    let config = load_config(&app)?;
    let entry_count = open_db(&app)?
        .query_row(
            "SELECT COUNT(*) FROM vault_entries WHERE deleted_at IS NULL",
            [],
            |row| row.get::<_, i64>(0),
        )
        .map_err(|error| error.to_string())? as usize;
    let session_unlocked = current_session_key(&app)?.is_some();
    let Some(config) = config else {
        return Ok(VaultStatus {
            protection_enabled: false,
            unlocked: true,
            username: String::new(),
            recovery_email: String::new(),
            recovery_email_hint: String::new(),
            recovery_available: false,
            entry_count,
        });
    };
    let unlocked = !config.protection_enabled || session_unlocked;
    Ok(VaultStatus {
        protection_enabled: config.protection_enabled,
        unlocked,
        username: config.username,
        recovery_email: if unlocked {
            config.recovery_email.clone()
        } else {
            String::new()
        },
        recovery_email_hint: mask_email(&config.recovery_email),
        recovery_available: config.protection_enabled && !config.recovery_email.is_empty(),
        entry_count,
    })
}

#[tauri::command]
pub fn list_vault_entries(app: AppHandle) -> Result<Vec<VaultEntry>, String> {
    list_vault_entries_by_state(app, false)
}

#[tauri::command]
pub fn list_deleted_vault_entries(app: AppHandle) -> Result<Vec<VaultEntry>, String> {
    list_vault_entries_by_state(app, true)
}

fn list_vault_entries_by_state(app: AppHandle, deleted: bool) -> Result<Vec<VaultEntry>, String> {
    let key = ensure_vault_key(&app)?;
    let conn = open_db(&app)?;
    let query = if deleted {
        "SELECT id, entry_uuid, nonce, ciphertext, created_at, updated_at, deleted_at
         FROM vault_entries WHERE deleted_at IS NOT NULL ORDER BY deleted_at DESC"
    } else {
        "SELECT id, entry_uuid, nonce, ciphertext, created_at, updated_at, deleted_at
         FROM vault_entries WHERE deleted_at IS NULL ORDER BY updated_at DESC"
    };
    let mut statement = conn.prepare(query).map_err(|error| error.to_string())?;
    let encrypted_rows = statement
        .query_map([], |row| {
            Ok((
                row.get::<_, i64>(0)?,
                row.get::<_, String>(1)?,
                row.get::<_, Vec<u8>>(2)?,
                row.get::<_, Vec<u8>>(3)?,
                row.get::<_, String>(4)?,
                row.get::<_, String>(5)?,
                row.get::<_, Option<String>>(6)?,
            ))
        })
        .map_err(|error| error.to_string())?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|error| error.to_string())?;

    encrypted_rows
        .into_iter()
        .map(
            |(id, entry_uuid, nonce, ciphertext, created_at, updated_at, deleted_at)| {
                let mut secret = decrypt_entry(&key, &entry_uuid, &nonce, &ciphertext)?;
                Ok(VaultEntry {
                    id,
                    kind: if secret.kind.is_empty() {
                        "password".to_string()
                    } else {
                        std::mem::take(&mut secret.kind)
                    },
                    totp_algorithm: secret.totp_algorithm.take(),
                    totp_digits: secret.totp_digits.take(),
                    totp_period: secret.totp_period.take(),
                    platform: std::mem::take(&mut secret.platform),
                    username: std::mem::take(&mut secret.username),
                    password: std::mem::take(&mut secret.password),
                    url: std::mem::take(&mut secret.url),
                    description: std::mem::take(&mut secret.description),
                    created_at,
                    updated_at,
                    deleted_at,
                })
            },
        )
        .collect()
}

#[tauri::command]
pub fn save_vault_entry(app: AppHandle, mut entry: VaultEntryInput) -> Result<i64, String> {
    validate_entry(&entry)?;
    let key = ensure_vault_key(&app)?;
    let id = entry.id;
    let mut secret = VaultEntrySecret {
        kind: if entry.kind.trim().is_empty() {
            "password".to_string()
        } else {
            entry.kind.trim().to_string()
        },
        totp_algorithm: entry.totp_algorithm.take(),
        totp_digits: entry.totp_digits.take(),
        totp_period: entry.totp_period.take(),
        platform: std::mem::take(&mut entry.platform).trim().to_string(),
        username: std::mem::take(&mut entry.username).trim().to_string(),
        password: std::mem::take(&mut entry.password),
        url: std::mem::take(&mut entry.url).trim().to_string(),
        description: std::mem::take(&mut entry.description).trim().to_string(),
    };
    let conn = open_db(&app)?;
    let timestamp = now();

    if let Some(id) = id {
        let entry_uuid = conn
            .query_row(
                "SELECT entry_uuid FROM vault_entries WHERE id = ?1 AND deleted_at IS NULL",
                [id],
                |row| row.get::<_, String>(0),
            )
            .optional()
            .map_err(|error| error.to_string())?
            .ok_or_else(|| "Der Kennwort-Eintrag wurde nicht gefunden.".to_string())?;
        let (nonce, ciphertext) = encrypt_entry(&key, &entry_uuid, &secret)?;
        conn.execute(
            "UPDATE vault_entries SET nonce = ?1, ciphertext = ?2, updated_at = ?3 WHERE id = ?4",
            params![nonce, ciphertext, timestamp, id],
        )
        .map_err(|error| {
            format!("Der Kennwort-Eintrag konnte nicht gespeichert werden: {error}")
        })?;
        secret.password.zeroize();
        return Ok(id);
    }

    let entry_uuid = Uuid::new_v4().to_string();
    let (nonce, ciphertext) = encrypt_entry(&key, &entry_uuid, &secret)?;
    conn.execute(
        "INSERT INTO vault_entries (entry_uuid, nonce, ciphertext, created_at, updated_at)
         VALUES (?1, ?2, ?3, ?4, ?4)",
        params![entry_uuid, nonce, ciphertext, timestamp],
    )
    .map_err(|error| format!("Der Kennwort-Eintrag konnte nicht gespeichert werden: {error}"))?;
    secret.password.zeroize();
    Ok(conn.last_insert_rowid())
}

#[tauri::command]
pub fn delete_vault_entry(app: AppHandle, id: i64) -> Result<(), String> {
    ensure_vault_key(&app)?;
    let timestamp = now();
    let changed = open_db(&app)?
        .execute(
            "UPDATE vault_entries SET deleted_at = ?1, updated_at = ?1
             WHERE id = ?2 AND deleted_at IS NULL",
            params![timestamp, id],
        )
        .map_err(|error| format!("Der Kennwort-Eintrag konnte nicht gelöscht werden: {error}"))?;
    if changed == 0 {
        return Err("Der Kennwort-Eintrag wurde nicht gefunden.".to_string());
    }
    Ok(())
}

#[tauri::command]
pub fn delete_all_vault_entries(app: AppHandle, kind: Option<String>) -> Result<usize, String> {
    ensure_vault_key(&app)?;
    let ids = match kind.as_deref() {
        Some("password") | Some("totp") => list_vault_entries_by_state(app.clone(), false)?
            .into_iter()
            .filter(|entry| entry.kind == kind.as_deref().unwrap_or("password"))
            .map(|entry| entry.id)
            .collect::<Vec<_>>(),
        Some(_) => return Err("Unbekannter Tresor-Eintragstyp.".to_string()),
        None => {
            let conn = open_db(&app)?;
            let mut statement = conn
                .prepare("SELECT id FROM vault_entries WHERE deleted_at IS NULL")
                .map_err(|error| error.to_string())?;
            let ids = statement
                .query_map([], |row| row.get::<_, i64>(0))
                .map_err(|error| error.to_string())?
                .collect::<Result<Vec<_>, _>>()
                .map_err(|error| error.to_string())?;
            ids
        }
    };
    let timestamp = now();
    let mut conn = open_db(&app)?;
    let tx = conn
        .transaction()
        .map_err(|error| format!("Die Kennwort-Einträge konnten nicht gelöscht werden: {error}"))?;
    for id in &ids {
        tx.execute(
            "UPDATE vault_entries SET deleted_at = ?1, updated_at = ?1
             WHERE id = ?2 AND deleted_at IS NULL",
            params![timestamp, id],
        )
        .map_err(|error| format!("Die Kennwort-Einträge konnten nicht gelöscht werden: {error}"))?;
    }
    tx.commit()
        .map_err(|error| format!("Die Kennwort-Einträge konnten nicht gelöscht werden: {error}"))?;
    Ok(ids.len())
}

#[tauri::command]
pub fn restore_vault_entry(app: AppHandle, id: i64) -> Result<(), String> {
    ensure_vault_key(&app)?;
    let changed = open_db(&app)?
        .execute(
            "UPDATE vault_entries SET deleted_at = NULL, updated_at = ?1
             WHERE id = ?2 AND deleted_at IS NOT NULL",
            params![now(), id],
        )
        .map_err(|error| {
            format!("Der Kennwort-Eintrag konnte nicht wiederhergestellt werden: {error}")
        })?;
    if changed == 0 {
        return Err("Der gelöschte Kennwort-Eintrag wurde nicht gefunden.".to_string());
    }
    Ok(())
}

#[tauri::command]
pub fn configure_vault_protection(
    app: AppHandle,
    username: String,
    recovery_email: String,
    mut password: String,
) -> Result<VaultStatus, String> {
    validate_protection_fields(&username, &recovery_email, &password)?;
    ensure_vault_key(&app)?;
    let password_hash = hash_password(&password)?;
    password.zeroize();
    open_db(&app)?
        .execute(
            "UPDATE vault_config
             SET username = ?1, recovery_email = ?2, password_hash = ?3,
                 protection_enabled = 1, updated_at = ?4
             WHERE id = 1",
            params![
                username.trim(),
                recovery_email.trim().to_ascii_lowercase(),
                password_hash,
                now()
            ],
        )
        .map_err(|error| format!("Der App-Schutz konnte nicht gespeichert werden: {error}"))?;
    get_vault_status(app)
}

#[tauri::command]
pub fn disable_vault_protection(app: AppHandle) -> Result<VaultStatus, String> {
    if current_session_key(&app)?.is_none() {
        return Err("Der Passwort-Speicher ist gesperrt.".to_string());
    }
    open_db(&app)?
        .execute(
            "UPDATE vault_config
             SET username = '', recovery_email = '', password_hash = NULL,
                 protection_enabled = 0, updated_at = ?1
             WHERE id = 1",
            [now()],
        )
        .map_err(|error| format!("Der App-Schutz konnte nicht deaktiviert werden: {error}"))?;
    get_vault_status(app)
}

fn login_allowed(runtime: &mut VaultRuntime) -> Result<(), String> {
    if let Some(blocked_until) = runtime.login_blocked_until {
        if Instant::now() < blocked_until {
            return Err("Zu viele Fehlversuche. Bitte warten Sie 30 Sekunden.".to_string());
        }
        runtime.login_blocked_until = None;
        runtime.login_failures = 0;
    }
    Ok(())
}

fn register_failed_login(app: &AppHandle) -> Result<(), String> {
    let state = app.state::<AppState>();
    let mut runtime = state
        .vault
        .lock()
        .map_err(|_| "Der Passwort-Speicher konnte nicht gesperrt werden.".to_string())?;
    runtime.login_failures = runtime.login_failures.saturating_add(1);
    if runtime.login_failures >= MAX_LOGIN_FAILURES {
        runtime.login_blocked_until = Some(Instant::now() + LOGIN_BLOCK_DURATION);
    }
    Ok(())
}

#[tauri::command]
pub fn unlock_vault(
    app: AppHandle,
    username: String,
    mut password: String,
) -> Result<VaultStatus, String> {
    {
        let state = app.state::<AppState>();
        let mut runtime = state
            .vault
            .lock()
            .map_err(|_| "Der Passwort-Speicher konnte nicht gesperrt werden.".to_string())?;
        login_allowed(&mut runtime)?;
    }
    let config = load_config(&app)?
        .ok_or_else(|| "Der App-Schutz wurde noch nicht eingerichtet.".to_string())?;
    let valid = config.protection_enabled
        && config.username.eq_ignore_ascii_case(username.trim())
        && config
            .password_hash
            .as_deref()
            .is_some_and(|hash| password_matches(&password, hash));
    password.zeroize();
    if !valid {
        register_failed_login(&app)?;
        return Err("Benutzername oder Kennwort ist falsch.".to_string());
    }
    let key = unprotect_key(&config.protected_key)?;
    set_session_key(&app, key)?;
    get_vault_status(app)
}

#[tauri::command]
pub fn lock_vault(app: AppHandle) -> Result<VaultStatus, String> {
    let state = app.state::<AppState>();
    let mut runtime = state
        .vault
        .lock()
        .map_err(|_| "Der Passwort-Speicher konnte nicht gesperrt werden.".to_string())?;
    runtime.key = None;
    runtime.recovery = None;
    drop(runtime);
    get_vault_status(app)
}

#[tauri::command]
pub fn request_vault_recovery(
    app: AppHandle,
    username: String,
) -> Result<VaultRecoveryDelivery, String> {
    let config = load_config(&app)?
        .filter(|config| config.protection_enabled)
        .ok_or_else(|| "Der App-Schutz wurde noch nicht eingerichtet.".to_string())?;
    if !config.username.eq_ignore_ascii_case(username.trim()) {
        return Err(
            "Für diesen Benutzernamen konnte keine Wiederherstellung gestartet werden.".to_string(),
        );
    }
    if config.recovery_email.is_empty() {
        return Err("Es wurde keine Wiederherstellungs-E-Mail-Adresse hinterlegt.".to_string());
    }
    {
        let state = app.state::<AppState>();
        let runtime = state
            .vault
            .lock()
            .map_err(|_| "Der Passwort-Speicher konnte nicht gesperrt werden.".to_string())?;
        if runtime
            .recovery
            .as_ref()
            .is_some_and(|challenge| Instant::now() < challenge.next_request_at)
        {
            return Err(
                "Bitte warten Sie eine Minute, bevor Sie einen neuen Code anfordern.".to_string(),
            );
        }
    }

    let mut code = Zeroizing::new(format!("{:06}", OsRng.gen_range(0..1_000_000u32)));
    let code_hash: [u8; 32] = Sha256::digest(code.as_bytes()).into();
    send_recovery_email(&config.recovery_email, &config.username, &code)?;
    code.zeroize();

    let now = Instant::now();
    let state = app.state::<AppState>();
    let mut runtime = state
        .vault
        .lock()
        .map_err(|_| "Der Passwort-Speicher konnte nicht gesperrt werden.".to_string())?;
    runtime.recovery = Some(RecoveryChallenge {
        code_hash,
        expires_at: now + RECOVERY_VALIDITY,
        next_request_at: now + RECOVERY_REQUEST_DELAY,
        attempts: 0,
    });
    Ok(VaultRecoveryDelivery {
        recovery_email_hint: mask_email(&config.recovery_email),
        expires_in_minutes: 10,
    })
}

#[tauri::command]
pub fn complete_vault_recovery(
    app: AppHandle,
    mut code: String,
    mut new_password: String,
) -> Result<VaultStatus, String> {
    if new_password.chars().count() < 8 || new_password.len() > 1024 {
        new_password.zeroize();
        return Err("Das neue App-Kennwort muss mindestens 8 Zeichen lang sein.".to_string());
    }
    let submitted_hash: [u8; 32] = Sha256::digest(code.trim().as_bytes()).into();
    code.zeroize();
    {
        let state = app.state::<AppState>();
        let mut runtime = state
            .vault
            .lock()
            .map_err(|_| "Der Passwort-Speicher konnte nicht gesperrt werden.".to_string())?;
        let challenge = runtime.recovery.as_mut().ok_or_else(|| {
            "Fordern Sie zuerst einen neuen Wiederherstellungscode an.".to_string()
        })?;
        if Instant::now() > challenge.expires_at {
            runtime.recovery = None;
            return Err("Der Wiederherstellungscode ist abgelaufen.".to_string());
        }
        challenge.attempts = challenge.attempts.saturating_add(1);
        if challenge.code_hash != submitted_hash {
            if challenge.attempts >= MAX_RECOVERY_ATTEMPTS {
                runtime.recovery = None;
                return Err("Zu viele falsche Codes. Fordern Sie einen neuen Code an.".to_string());
            }
            return Err("Der Wiederherstellungscode ist falsch.".to_string());
        }
        runtime.recovery = None;
    }

    let config = load_config(&app)?
        .ok_or_else(|| "Der App-Schutz wurde noch nicht eingerichtet.".to_string())?;
    let password_hash = hash_password(&new_password)?;
    new_password.zeroize();
    open_db(&app)?
        .execute(
            "UPDATE vault_config SET password_hash = ?1, updated_at = ?2 WHERE id = 1",
            params![password_hash, now()],
        )
        .map_err(|error| {
            format!("Das neue App-Kennwort konnte nicht gespeichert werden: {error}")
        })?;
    let key = unprotect_key(&config.protected_key)?;
    set_session_key(&app, key)?;
    get_vault_status(app)
}

fn normalize_recovery_email(email: &str) -> Result<String, String> {
    let email = email.trim().to_ascii_lowercase();
    let valid = email.len() <= 254
        && email.matches('@').count() == 1
        && email.split_once('@').is_some_and(|(local, domain)| {
            !local.is_empty() && domain.contains('.') && !domain.ends_with('.')
        })
        && !email.chars().any(|character| {
            character.is_control()
                || character.is_whitespace()
                || matches!(character, ';' | ',' | '"')
        });
    if !valid {
        return Err("Bitte geben Sie eine gültige E-Mail-Adresse ein.".to_string());
    }
    Ok(email)
}

#[tauri::command]
pub fn request_local_account_password_recovery(
    app: AppHandle,
    email: String,
) -> Result<VaultRecoveryDelivery, String> {
    let email = normalize_recovery_email(&email)?;
    {
        let state = app.state::<AppState>();
        let runtime = state.vault.lock().map_err(|_| {
            "Die Kennwort-Wiederherstellung konnte nicht vorbereitet werden.".to_string()
        })?;
        if runtime
            .local_account_recovery
            .as_ref()
            .is_some_and(|recovery| Instant::now() < recovery.challenge.next_request_at)
        {
            return Err(
                "Bitte warten Sie eine Minute, bevor Sie einen neuen Code anfordern.".to_string(),
            );
        }
    }

    let mut code = Zeroizing::new(format!("{:06}", OsRng.gen_range(0..1_000_000u32)));
    let code_hash: [u8; 32] = Sha256::digest(code.as_bytes()).into();
    send_recovery_email(&email, &email, &code)?;
    code.zeroize();

    let now = Instant::now();
    let state = app.state::<AppState>();
    let mut runtime = state.vault.lock().map_err(|_| {
        "Die Kennwort-Wiederherstellung konnte nicht gespeichert werden.".to_string()
    })?;
    runtime.local_account_recovery = Some(LocalAccountRecoveryChallenge {
        email: email.clone(),
        challenge: RecoveryChallenge {
            code_hash,
            expires_at: now + RECOVERY_VALIDITY,
            next_request_at: now + RECOVERY_REQUEST_DELAY,
            attempts: 0,
        },
    });
    Ok(VaultRecoveryDelivery {
        recovery_email_hint: mask_email(&email),
        expires_in_minutes: 10,
    })
}

#[tauri::command]
pub fn complete_local_account_password_recovery(
    app: AppHandle,
    email: String,
    mut code: String,
) -> Result<(), String> {
    let email = normalize_recovery_email(&email)?;
    let submitted_hash: [u8; 32] = Sha256::digest(code.trim().as_bytes()).into();
    code.zeroize();

    let state = app.state::<AppState>();
    let mut runtime = state
        .vault
        .lock()
        .map_err(|_| "Die Kennwort-Wiederherstellung konnte nicht geprüft werden.".to_string())?;
    let recovery = runtime
        .local_account_recovery
        .as_mut()
        .ok_or_else(|| "Fordern Sie zuerst einen neuen Wiederherstellungscode an.".to_string())?;
    if !recovery.email.eq_ignore_ascii_case(&email) {
        return Err(
            "Der Wiederherstellungscode gehört zu einer anderen E-Mail-Adresse.".to_string(),
        );
    }
    if Instant::now() > recovery.challenge.expires_at {
        runtime.local_account_recovery = None;
        return Err("Der Wiederherstellungscode ist abgelaufen.".to_string());
    }
    recovery.challenge.attempts = recovery.challenge.attempts.saturating_add(1);
    if recovery.challenge.code_hash != submitted_hash {
        if recovery.challenge.attempts >= MAX_RECOVERY_ATTEMPTS {
            runtime.local_account_recovery = None;
            return Err("Zu viele falsche Codes. Fordern Sie einen neuen Code an.".to_string());
        }
        return Err("Der Wiederherstellungscode ist falsch.".to_string());
    }
    runtime.local_account_recovery = None;
    Ok(())
}

fn mask_email(email: &str) -> String {
    let Some((local, domain)) = email.split_once('@') else {
        return String::new();
    };
    let first = local.chars().next().unwrap_or('*');
    format!("{first}***@{domain}")
}

fn send_recovery_email(email: &str, username: &str, code: &str) -> Result<(), String> {
    let script = r#"
$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
$outlook = New-Object -ComObject Outlook.Application
$mail = $outlook.CreateItem(0)
$mail.To = $env:DMH_VAULT_RECOVERY_EMAIL
$mail.Subject = 'DMH Backup - Wiederherstellungscode'
$mail.Body = "Hallo,`r`n`r`nfür den Benutzer '$($env:DMH_VAULT_RECOVERY_USER)' wurde ein Wiederherstellungscode angefordert.`r`n`r`nCode: $($env:DMH_VAULT_RECOVERY_CODE)`r`n`r`nDer Code ist 10 Minuten gültig. Wenn Sie ihn nicht angefordert haben, können Sie diese E-Mail ignorieren.`r`n`r`nDMH Backup"
$mail.Send()
"#;
    let mut output = hidden_command("powershell")
        .args([
            "-NoProfile",
            "-ExecutionPolicy",
            "Bypass",
            "-Command",
            script,
        ])
        .env("DMH_VAULT_RECOVERY_EMAIL", email)
        .env("DMH_VAULT_RECOVERY_USER", username)
        .env("DMH_VAULT_RECOVERY_CODE", code)
        .output()
        .map_err(|_| {
            "Outlook Classic konnte für die Wiederherstellung nicht gestartet werden.".to_string()
        })?;
    if output.status.success() {
        output.stdout.zeroize();
        output.stderr.zeroize();
        return Ok(());
    }
    output.stdout.zeroize();
    output.stderr.zeroize();
    Err("Der Wiederherstellungscode konnte nicht gesendet werden. Öffnen Sie Outlook Classic und versuchen Sie es erneut.".to_string())
}

#[cfg(target_os = "windows")]
fn protect_key(key: &[u8]) -> Result<Vec<u8>, String> {
    use windows::{
        core::PCWSTR,
        Win32::{
            Foundation::{LocalFree, HLOCAL},
            Security::Cryptography::{
                CryptProtectData, CRYPTPROTECT_UI_FORBIDDEN, CRYPT_INTEGER_BLOB,
            },
        },
    };

    let input = CRYPT_INTEGER_BLOB {
        cbData: key.len() as u32,
        pbData: key.as_ptr() as *mut u8,
    };
    let entropy = CRYPT_INTEGER_BLOB {
        cbData: DPAPI_ENTROPY.len() as u32,
        pbData: DPAPI_ENTROPY.as_ptr() as *mut u8,
    };
    let mut output = CRYPT_INTEGER_BLOB::default();
    unsafe {
        CryptProtectData(
            &input,
            PCWSTR::null(),
            Some(&entropy),
            None,
            None,
            CRYPTPROTECT_UI_FORBIDDEN,
            &mut output,
        )
    }
    .map_err(|error| format!("Die Windows-Schlüsselverschlüsselung ist fehlgeschlagen: {error}"))?;
    if output.pbData.is_null() || output.cbData == 0 {
        return Err("Die Windows-Schlüsselverschlüsselung lieferte keine Daten.".to_string());
    }
    let protected =
        unsafe { std::slice::from_raw_parts(output.pbData, output.cbData as usize).to_vec() };
    unsafe {
        LocalFree(Some(HLOCAL(output.pbData.cast())));
    }
    Ok(protected)
}

#[cfg(target_os = "windows")]
fn unprotect_key(protected_key: &[u8]) -> Result<Zeroizing<[u8; 32]>, String> {
    use windows::Win32::{
        Foundation::{LocalFree, HLOCAL},
        Security::Cryptography::{
            CryptUnprotectData, CRYPTPROTECT_UI_FORBIDDEN, CRYPT_INTEGER_BLOB,
        },
    };

    let input = CRYPT_INTEGER_BLOB {
        cbData: protected_key.len() as u32,
        pbData: protected_key.as_ptr() as *mut u8,
    };
    let entropy = CRYPT_INTEGER_BLOB {
        cbData: DPAPI_ENTROPY.len() as u32,
        pbData: DPAPI_ENTROPY.as_ptr() as *mut u8,
    };
    let mut output = CRYPT_INTEGER_BLOB::default();
    unsafe {
        CryptUnprotectData(
            &input,
            None,
            Some(&entropy),
            None,
            None,
            CRYPTPROTECT_UI_FORBIDDEN,
            &mut output,
        )
    }
    .map_err(|error| {
        format!(
            "Der Passwort-Speicher gehört zu einem anderen Windows-Benutzer oder Computer: {error}"
        )
    })?;
    if output.pbData.is_null() || output.cbData as usize != VAULT_KEY_LENGTH {
        if !output.pbData.is_null() {
            unsafe {
                let bytes = std::slice::from_raw_parts_mut(output.pbData, output.cbData as usize);
                bytes.zeroize();
                LocalFree(Some(HLOCAL(output.pbData.cast())));
            }
        }
        return Err("Der geschützte Schlüssel des Passwort-Speichers ist ungültig.".to_string());
    }
    let mut key = Zeroizing::new([0u8; VAULT_KEY_LENGTH]);
    unsafe {
        let bytes = std::slice::from_raw_parts_mut(output.pbData, output.cbData as usize);
        key.copy_from_slice(bytes);
        bytes.zeroize();
        LocalFree(Some(HLOCAL(output.pbData.cast())));
    }
    Ok(key)
}

#[cfg(not(target_os = "windows"))]
fn protect_key(_key: &[u8]) -> Result<Vec<u8>, String> {
    Err("Der Passwort-Speicher wird nur unter Windows unterstützt.".to_string())
}

#[cfg(not(target_os = "windows"))]
fn unprotect_key(_protected_key: &[u8]) -> Result<Zeroizing<[u8; 32]>, String> {
    Err("Der Passwort-Speicher wird nur unter Windows unterstützt.".to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn encrypted_entry_round_trips() {
        let key = [7u8; 32];
        let mut source = VaultEntrySecret {
            kind: "password".to_string(),
            totp_algorithm: None,
            totp_digits: None,
            totp_period: None,
            platform: "Beispiel".to_string(),
            username: "benutzer".to_string(),
            password: "geheim".to_string(),
            url: "https://example.invalid".to_string(),
            description: "Notiz".to_string(),
        };
        let (nonce, ciphertext) = encrypt_entry(&key, "entry-1", &source).unwrap();
        let decoded = decrypt_entry(&key, "entry-1", &nonce, &ciphertext).unwrap();
        assert_eq!(decoded.platform, "Beispiel");
        assert_eq!(decoded.password, "geheim");
        source.password.zeroize();
    }

    #[test]
    fn automatic_password_backup_marks_deleted_description_without_plaintext_archive() {
        let key = [5u8; VAULT_KEY_LENGTH];
        let secret = VaultEntrySecret {
            kind: "password".to_string(),
            totp_algorithm: None,
            totp_digits: None,
            totp_period: None,
            platform: "Beispiel".to_string(),
            username: "benutzer".to_string(),
            password: "geheim".to_string(),
            url: "https://example.invalid".to_string(),
            description: "Vorherige Notiz".to_string(),
        };
        let (nonce, ciphertext) = encrypt_entry(&key, "entry-restore-1", &secret).unwrap();
        let mut entry = AutomaticPasswordEntry {
            entry_uuid: "entry-restore-1".to_string(),
            nonce: BASE64_STANDARD.encode(nonce),
            ciphertext: BASE64_STANDARD.encode(ciphertext),
            created_at: "2026-08-18T10:00:00Z".to_string(),
            updated_at: "2026-08-18T10:00:00Z".to_string(),
            deleted_at: None,
        };

        mark_automatic_password_entry_deleted(&mut entry, &key).unwrap();
        let (nonce, ciphertext) = decode_automatic_password_entry(&entry).unwrap();
        let restored = decrypt_entry(&key, &entry.entry_uuid, &nonce, &ciphertext).unwrap();

        assert_eq!(restored.description, "Vorherige Notiz\nGelöschtes Element");
        assert!(entry.deleted_at.is_some());
        assert_eq!(restored.password, "geheim");
    }

    #[test]
    fn automatic_password_backup_does_not_merge_a_different_vault() {
        let vault = |protected_key: &str| AutomaticVaultConfig {
            protected_key: protected_key.to_string(),
            username: String::new(),
            recovery_email: String::new(),
            password_hash: None,
            protection_enabled: false,
            created_at: "2026-08-25T10:00:00Z".to_string(),
            updated_at: "2026-08-25T10:00:00Z".to_string(),
        };
        let previous = AutomaticPasswordBackup {
            version: AUTOMATIC_PASSWORD_BACKUP_VERSION.to_string(),
            exported_at: "2026-08-25T10:00:00Z".to_string(),
            vault: Some(vault("anderer-geschuetzter-schluessel")),
            entries: vec![AutomaticPasswordEntry {
                entry_uuid: "fremder-eintrag".to_string(),
                nonce: "ungueltig".to_string(),
                ciphertext: "ungueltig".to_string(),
                created_at: "2026-08-25T10:00:00Z".to_string(),
                updated_at: "2026-08-25T10:00:00Z".to_string(),
                deleted_at: None,
            }],
        };
        let current = AutomaticPasswordBackup {
            version: AUTOMATIC_PASSWORD_BACKUP_VERSION.to_string(),
            exported_at: "2026-08-25T10:01:00Z".to_string(),
            vault: Some(vault("aktueller-geschuetzter-schluessel")),
            entries: Vec::new(),
        };

        let merged = merge_automatic_password_backup(Some(previous), current)
            .expect("different vault backup must be ignored");

        assert!(merged.entries.is_empty());
        assert_eq!(
            merged.vault.expect("current vault").protected_key,
            "aktueller-geschuetzter-schluessel"
        );
    }

    #[test]
    fn permanent_deletion_removes_password_from_pre_deletion_snapshot() {
        let entry = |entry_uuid: &str| AutomaticPasswordEntry {
            entry_uuid: entry_uuid.to_string(),
            nonce: "snapshot-value".to_string(),
            ciphertext: "snapshot-value".to_string(),
            created_at: "2026-01-01T10:00:00Z".to_string(),
            updated_at: "2026-01-01T10:00:00Z".to_string(),
            deleted_at: None,
        };
        let mut backup = AutomaticPasswordBackup {
            version: AUTOMATIC_PASSWORD_BACKUP_VERSION.to_string(),
            exported_at: "2026-01-01T10:00:00Z".to_string(),
            vault: None,
            entries: vec![entry("remove-entry"), entry("keep-entry")],
        };

        assert!(purge_targets_from_password_backup(
            &mut backup,
            &std::collections::HashSet::from(["remove-entry".to_string()]),
        ));
        assert_eq!(backup.entries.len(), 1);
        assert_eq!(backup.entries[0].entry_uuid, "keep-entry");
    }

    #[test]
    fn password_hash_accepts_only_matching_password() {
        let hash = hash_password("ein-sicheres-kennwort").unwrap();
        assert!(password_matches("ein-sicheres-kennwort", &hash));
        assert!(!password_matches("falsch", &hash));
    }

    #[test]
    fn recovery_email_is_masked() {
        assert_eq!(mask_email("max@example.org"), "m***@example.org");
    }

    #[test]
    fn local_recovery_email_rejects_recipient_injection() {
        assert_eq!(
            normalize_recovery_email(" Maria.Mustermann@dmh.example ").unwrap(),
            "maria.mustermann@dmh.example"
        );
        assert!(normalize_recovery_email("person@example.org;other@example.org").is_err());
        assert!(normalize_recovery_email("person@example.org\r\nBCC: other@example.org").is_err());
    }

    #[cfg(target_os = "windows")]
    #[test]
    fn dpapi_key_round_trips_for_current_windows_user() {
        let source = [9u8; VAULT_KEY_LENGTH];
        let protected = protect_key(&source).unwrap();
        assert_ne!(protected, source);
        let decoded = unprotect_key(&protected).unwrap();
        assert_eq!(&decoded[..], &source);
    }
}
