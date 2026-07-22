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
    login_failures: u8,
    login_blocked_until: Option<Instant>,
}

struct RecoveryChallenge {
    code_hash: [u8; 32],
    expires_at: Instant,
    next_request_at: Instant,
    attempts: u8,
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

#[tauri::command]
pub fn get_vault_status(app: AppHandle) -> Result<VaultStatus, String> {
    let config = load_config(&app)?;
    let entry_count = open_db(&app)?
        .query_row("SELECT COUNT(*) FROM vault_entries WHERE deleted_at IS NULL", [], |row| {
            row.get::<_, i64>(0)
        })
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

fn list_vault_entries_by_state(
    app: AppHandle,
    deleted: bool,
) -> Result<Vec<VaultEntry>, String> {
    let key = ensure_vault_key(&app)?;
    let conn = open_db(&app)?;
    let query = if deleted {
        "SELECT id, entry_uuid, nonce, ciphertext, created_at, updated_at, deleted_at
         FROM vault_entries WHERE deleted_at IS NOT NULL ORDER BY deleted_at DESC"
    } else {
        "SELECT id, entry_uuid, nonce, ciphertext, created_at, updated_at, deleted_at
         FROM vault_entries WHERE deleted_at IS NULL ORDER BY updated_at DESC"
    };
    let mut statement = conn
        .prepare(query)
        .map_err(|error| error.to_string())?;
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
pub fn delete_all_vault_entries(app: AppHandle) -> Result<usize, String> {
    ensure_vault_key(&app)?;
    let timestamp = now();
    open_db(&app)?
        .execute(
            "UPDATE vault_entries SET deleted_at = ?1, updated_at = ?1
             WHERE deleted_at IS NULL",
            params![timestamp],
        )
        .map_err(|error| format!("Die Kennwort-Einträge konnten nicht gelöscht werden: {error}"))
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
$mail.Subject = 'DMH Kontakte und Kalender - Wiederherstellungscode'
$mail.Body = "Hallo,`r`n`r`nfür den Benutzer '$($env:DMH_VAULT_RECOVERY_USER)' wurde ein Wiederherstellungscode angefordert.`r`n`r`nCode: $($env:DMH_VAULT_RECOVERY_CODE)`r`n`r`nDer Code ist 10 Minuten gültig. Wenn Sie ihn nicht angefordert haben, können Sie diese E-Mail ignorieren.`r`n`r`nDMH Kontakte und Kalender"
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
    fn password_hash_accepts_only_matching_password() {
        let hash = hash_password("ein-sicheres-kennwort").unwrap();
        assert!(password_matches("ein-sicheres-kennwort", &hash));
        assert!(!password_matches("falsch", &hash));
    }

    #[test]
    fn recovery_email_is_masked() {
        assert_eq!(mask_email("max@example.org"), "m***@example.org");
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
