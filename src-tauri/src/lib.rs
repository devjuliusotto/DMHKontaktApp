use chrono::Utc;
use rusqlite::{params, Connection, OptionalExtension};
use serde::de::DeserializeOwned;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::collections::{BTreeMap, HashMap, HashSet};
use std::env;
use std::fs;
use std::io::Write;
use std::path::{Path, PathBuf};
use std::process::Command;
use std::sync::Mutex;
use std::thread;
use std::time::{Duration, Instant};
use tauri::{AppHandle, Manager};
use uuid::Uuid;

mod documents;
mod file_icons;
mod m365;
mod mail_accounts;
mod outlook_autocomplete;
mod phone_transfer;
mod printers;
mod thunderbird;
mod vault;

#[cfg(target_os = "windows")]
use std::os::windows::process::CommandExt;

#[cfg(target_os = "windows")]
const CREATE_NO_WINDOW: u32 = 0x08000000;

fn hidden_command(program: &str) -> Command {
    let mut command = Command::new(program);
    #[cfg(target_os = "windows")]
    command.creation_flags(CREATE_NO_WINDOW);
    command
}

fn normalize_recipients(recipients: Vec<String>) -> Vec<String> {
    let mut normalized = Vec::new();
    for recipient in recipients {
        let email = recipient.trim();
        if email.is_empty() || !email.contains('@') {
            continue;
        }
        if normalized
            .iter()
            .any(|existing: &String| existing.eq_ignore_ascii_case(email))
        {
            continue;
        }
        normalized.push(email.to_string());
    }
    normalized
}

fn powershell_single_quote(value: &str) -> String {
    format!("'{}'", value.replace('\'', "''"))
}

fn url_encode_component(value: &str) -> String {
    let mut encoded = String::new();
    for byte in value.bytes() {
        match byte {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'_' | b'.' | b'~' => {
                encoded.push(byte as char);
            }
            _ => encoded.push_str(&format!("%{byte:02X}")),
        }
    }
    encoded
}

struct AppState {
    db_path: Mutex<PathBuf>,
    vault: Mutex<vault::VaultRuntime>,
    outlook_contact_cache: Mutex<Option<CachedOutlookContacts>>,
    m365: m365::Microsoft365Runtime,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct Contact {
    pub id: Option<i64>,
    pub first_name: String,
    pub last_name: String,
    pub display_name: String,
    pub email: String,
    pub phone: String,
    pub mobile_phone: String,
    pub street: String,
    pub postal_code: String,
    pub city: String,
    pub country: String,
    #[serde(default)]
    pub short_info: String,
    pub notes: String,
    pub groups: Vec<Group>,
    pub created_at: String,
    pub updated_at: String,
    pub deleted_at: Option<String>,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct ContactInput {
    pub id: Option<i64>,
    pub first_name: String,
    pub last_name: String,
    pub display_name: String,
    pub email: String,
    pub phone: String,
    pub mobile_phone: String,
    pub street: String,
    pub postal_code: String,
    pub city: String,
    pub country: String,
    #[serde(default)]
    pub short_info: String,
    pub notes: String,
    pub group_ids: Vec<i64>,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct Group {
    pub id: Option<i64>,
    pub name: String,
    pub description: String,
    pub created_at: String,
    pub updated_at: String,
    pub deleted_at: Option<String>,
}

#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ImportPayload {
    pub source_file: String,
    pub contacts: Vec<ContactInput>,
}

#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ImportResult {
    pub imported: usize,
    pub skipped_duplicates: usize,
    pub batch_id: String,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct BackupData {
    pub version: String,
    pub exported_at: String,
    pub contacts: Vec<Contact>,
    pub groups: Vec<Group>,
    pub settings: Vec<AppSetting>,
    #[serde(default)]
    pub browser_storage: HashMap<String, String>,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct AppSetting {
    pub key: String,
    pub value: String,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct CalendarRecurrence {
    pub frequency: String,
    #[serde(default = "default_recurrence_interval")]
    pub interval: u32,
    #[serde(default, deserialize_with = "deserialize_vec_flexible")]
    pub days_of_week: Vec<u32>,
    pub day_of_month: Option<u32>,
    pub month_of_year: Option<u32>,
    pub week_of_month: Option<i32>,
    pub until: Option<String>,
    pub count: Option<u32>,
}

fn default_recurrence_interval() -> u32 {
    1
}

fn deserialize_vec_flexible<'de, D, T>(deserializer: D) -> Result<Vec<T>, D::Error>
where
    D: serde::Deserializer<'de>,
    T: DeserializeOwned,
{
    let value = serde_json::Value::deserialize(deserializer)?;
    match value {
        serde_json::Value::Null => Ok(Vec::new()),
        serde_json::Value::Object(ref object) if object.is_empty() => Ok(Vec::new()),
        serde_json::Value::Array(_) => {
            serde_json::from_value(value).map_err(serde::de::Error::custom)
        }
        other => serde_json::from_value(other)
            .map(|item| vec![item])
            .map_err(serde::de::Error::custom),
    }
}

#[derive(Debug, Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct CalendarEvent {
    pub id: String,
    #[serde(default)]
    pub updated_at: String,
    pub title: String,
    pub starts_at: String,
    pub ends_at: String,
    pub location: String,
    pub description: String,
    #[serde(default = "default_calendar_color")]
    pub color: String,
    #[serde(default)]
    pub category: String,
    pub source: String,
    #[serde(default)]
    pub recurrence: Option<CalendarRecurrence>,
    #[serde(default)]
    pub excluded_dates: Vec<String>,
    #[serde(default)]
    pub deleted_at: Option<String>,
    #[serde(default)]
    pub recurrence_master_id: Option<String>,
    #[serde(default)]
    pub recurrence_id: Option<String>,
}

fn default_calendar_color() -> String {
    "blue".to_string()
}

#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct OutlookImportData {
    pub contacts: Vec<ContactInput>,
    pub events: Vec<CalendarEvent>,
}

#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct OutlookSyncResult {
    pub scanned: usize,
    pub inserted: usize,
    pub updated: usize,
    pub skipped: usize,
    pub pushed: OutlookPushResult,
}

#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct OutlookPushResult {
    pub total: usize,
    pub created: usize,
    pub updated: usize,
    pub linked: usize,
    pub contact_copies: usize,
    pub folders_created: usize,
    pub folders_used: usize,
    pub errors: usize,
    pub autocomplete_resolved: usize,
    pub autocomplete_errors: usize,
    pub folder_path: String,
    pub store_name: String,
}

#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct OutlookFolderDiagnostic {
    pub folder_path: String,
    pub store_name: String,
    pub item_count: usize,
}

struct ExistingContactRow {
    id: i64,
    first_name: String,
    last_name: String,
    display_name: String,
    email: String,
    phone: String,
    mobile_phone: String,
    street: String,
    postal_code: String,
    city: String,
    country: String,
    short_info: String,
    notes: String,
    deleted_at: Option<String>,
    outlook_entry_id: Option<String>,
    outlook_store_id: Option<String>,
}

#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct OutlookContactRecord {
    #[serde(default)]
    source_kind: String,
    #[serde(default)]
    entry_id: String,
    #[serde(default)]
    store_id: String,
    #[serde(default)]
    store_name: String,
    #[serde(default)]
    folder_id: String,
    #[serde(default)]
    folder_path: String,
    #[serde(default)]
    first_name: String,
    #[serde(default)]
    last_name: String,
    #[serde(default)]
    display_name: String,
    #[serde(default)]
    email: String,
    #[serde(default)]
    phone: String,
    #[serde(default)]
    mobile_phone: String,
    #[serde(default)]
    street: String,
    #[serde(default)]
    postal_code: String,
    #[serde(default)]
    city: String,
    #[serde(default)]
    country: String,
    #[serde(default)]
    short_info: String,
    #[serde(default)]
    notes: String,
}

#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct OutlookReadData {
    #[serde(default)]
    contacts: Vec<OutlookContactRecord>,
    #[serde(default)]
    skipped: usize,
}

#[derive(Debug)]
struct CachedOutlookContacts {
    captured_at: Instant,
    data: OutlookReadData,
}

#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct OutlookAppointmentRecord {
    #[serde(default)]
    entry_id: String,
    #[serde(default)]
    store_id: String,
    #[serde(default)]
    store_name: String,
    #[serde(default)]
    folder_path: String,
    #[serde(default)]
    global_appointment_id: String,
    #[serde(default)]
    title: String,
    #[serde(default)]
    starts_at: String,
    #[serde(default)]
    ends_at: String,
    #[serde(default)]
    location: String,
    #[serde(default)]
    description: String,
    #[serde(default)]
    category: String,
    #[serde(default = "default_calendar_color")]
    color: String,
    #[serde(default)]
    recurrence: Option<CalendarRecurrence>,
    #[serde(default, deserialize_with = "deserialize_vec_flexible")]
    excluded_dates: Vec<String>,
}

#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct OutlookCalendarRecord {
    #[serde(default)]
    id: String,
    #[serde(default)]
    store_id: String,
    #[serde(default)]
    store_name: String,
    #[serde(default)]
    folder_path: String,
    #[serde(default)]
    name: String,
}

#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct OutlookCalendarReadData {
    #[serde(default, deserialize_with = "deserialize_vec_flexible")]
    calendars: Vec<OutlookCalendarRecord>,
    #[serde(default, deserialize_with = "deserialize_vec_flexible")]
    events: Vec<OutlookAppointmentRecord>,
    #[serde(default)]
    skipped: usize,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct OutlookOneTimeContactImportResult {
    pub found: usize,
    pub imported: usize,
    pub skipped_duplicates: usize,
    pub skipped_invalid: usize,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct OutlookContactSourcePreview {
    pub id: String,
    pub kind: String,
    pub store_name: String,
    pub folder_path: String,
    pub suggested_group_name: String,
    pub total: usize,
    pub new_contacts: usize,
    pub exact_duplicates: usize,
    pub conflicts: usize,
    pub without_email: usize,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct OutlookContactPreviewItem {
    pub id: String,
    pub source_id: String,
    pub display_name: String,
    pub email: String,
    pub phone: String,
    pub city: String,
    pub status: String,
    pub reason: String,
    pub existing_name: Option<String>,
    pub default_selected: bool,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct OutlookContactImportPreview {
    pub found: usize,
    pub skipped_invalid: usize,
    pub warnings: Vec<String>,
    pub sources: Vec<OutlookContactSourcePreview>,
    pub contacts: Vec<OutlookContactPreviewItem>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct OutlookContactImportRequest {
    pub selected_source_ids: Vec<String>,
    #[serde(default = "default_true")]
    pub create_source_groups: bool,
    #[serde(default = "default_true")]
    pub clean_imported_names: bool,
}

fn default_true() -> bool {
    true
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct OutlookContactImportResult {
    pub found: usize,
    pub imported: usize,
    pub skipped_exact_duplicates: usize,
    pub skipped_conflicts: usize,
    pub skipped_invalid: usize,
    pub groups_used: usize,
    pub batch_id: String,
}

#[derive(Debug, Default)]
struct ContactFingerprintIndex {
    exact_contacts: HashMap<String, String>,
    emails: HashMap<String, String>,
    phones: HashMap<String, String>,
    names: HashMap<String, String>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct OutlookOneTimeCalendarImportResult {
    pub found: usize,
    pub skipped_invalid: usize,
    pub events: Vec<CalendarEvent>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct OutlookCalendarPreviewCalendar {
    pub id: String,
    pub name: String,
    pub store_name: String,
    pub folder_path: String,
    pub event_count: usize,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct OutlookCalendarDuplicateGroup {
    pub title: String,
    pub starts_at: String,
    pub ends_at: String,
    pub location: String,
    pub occurrence_count: usize,
    pub calendars: Vec<String>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct OutlookCalendarPreview {
    pub calendars: Vec<OutlookCalendarPreviewCalendar>,
    pub total_events: usize,
    pub skipped_invalid: usize,
    pub duplicate_groups: Vec<OutlookCalendarDuplicateGroup>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct LocalOutlookContact {
    id: i64,
    first_name: String,
    last_name: String,
    display_name: String,
    email: String,
    phone: String,
    mobile_phone: String,
    street: String,
    postal_code: String,
    city: String,
    country: String,
    short_info: String,
    notes: String,
    groups: Vec<String>,
    outlook_entry_id: Option<String>,
    outlook_store_id: Option<String>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct LocalOutlookExportPayload {
    contacts: Vec<LocalOutlookContact>,
    groups: Vec<String>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct OutlookLink {
    local_id: String,
    entry_id: String,
    store_id: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct OutlookPushData {
    links: Vec<OutlookLink>,
    created: usize,
    updated: usize,
    contact_copies: usize,
    folders_created: usize,
    folders_used: usize,
    errors: usize,
    autocomplete_resolved: usize,
    autocomplete_errors: usize,
    folder_path: String,
    store_name: String,
}

fn now() -> String {
    Utc::now().to_rfc3339()
}

fn open_db(app: &AppHandle) -> Result<Connection, String> {
    let state = app.state::<AppState>();
    let db_path = state
        .db_path
        .lock()
        .map_err(|_| "Datenbank konnte nicht gesperrt werden.".to_string())?
        .clone();
    let conn = Connection::open(db_path).map_err(|err| err.to_string())?;
    conn.execute_batch("PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;")
        .map_err(|err| err.to_string())?;
    Ok(conn)
}

fn initial_onboarding_completion(database_already_existed: bool) -> &'static str {
    if database_already_existed { "true" } else { "false" }
}

fn init_db(app: &AppHandle) -> Result<(), String> {
    let app_dir = app
        .path()
        .app_data_dir()
        .map_err(|err| format!("App-Datenverzeichnis konnte nicht erstellt werden: {err}"))?;
    fs::create_dir_all(&app_dir).map_err(|err| err.to_string())?;
    let db_path = app_dir.join("agendakontakte.sqlite");
    let database_already_existed = db_path.exists();

    {
        let state = app.state::<AppState>();
        *state
            .db_path
            .lock()
            .map_err(|_| "Datenbankpfad konnte nicht gesetzt werden.".to_string())? =
            db_path.clone();
    }

    let conn = Connection::open(db_path).map_err(|err| err.to_string())?;
    conn.execute_batch(
        "
        PRAGMA foreign_keys = ON;
        CREATE TABLE IF NOT EXISTS contacts (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            first_name TEXT NOT NULL DEFAULT '',
            last_name TEXT NOT NULL DEFAULT '',
            display_name TEXT NOT NULL DEFAULT '',
            email TEXT NOT NULL DEFAULT '',
            phone TEXT NOT NULL DEFAULT '',
            mobile_phone TEXT NOT NULL DEFAULT '',
            street TEXT NOT NULL DEFAULT '',
            postal_code TEXT NOT NULL DEFAULT '',
            city TEXT NOT NULL DEFAULT '',
            country TEXT NOT NULL DEFAULT '',
            short_info TEXT NOT NULL DEFAULT '',
            notes TEXT NOT NULL DEFAULT '',
            import_batch_id TEXT,
            created_at TEXT NOT NULL,
            updated_at TEXT NOT NULL,
            deleted_at TEXT
        );
        CREATE TABLE IF NOT EXISTS groups (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            name TEXT NOT NULL UNIQUE,
            description TEXT NOT NULL DEFAULT '',
            created_at TEXT NOT NULL,
            updated_at TEXT NOT NULL,
            deleted_at TEXT
        );
        CREATE TABLE IF NOT EXISTS contact_groups (
            contact_id INTEGER NOT NULL,
            group_id INTEGER NOT NULL,
            PRIMARY KEY (contact_id, group_id),
            FOREIGN KEY (contact_id) REFERENCES contacts(id) ON DELETE CASCADE,
            FOREIGN KEY (group_id) REFERENCES groups(id) ON DELETE CASCADE
        );
        CREATE TABLE IF NOT EXISTS m365_contact_links (
            local_contact_id INTEGER NOT NULL,
            source_id TEXT NOT NULL,
            remote_id TEXT NOT NULL,
            updated_at TEXT NOT NULL,
            PRIMARY KEY (local_contact_id, source_id),
            UNIQUE (source_id, remote_id),
            FOREIGN KEY (local_contact_id) REFERENCES contacts(id) ON DELETE CASCADE
        );
        CREATE TABLE IF NOT EXISTS import_history (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            batch_id TEXT NOT NULL UNIQUE,
            source_file TEXT NOT NULL,
            imported_count INTEGER NOT NULL,
            skipped_count INTEGER NOT NULL,
            created_at TEXT NOT NULL
        );
        CREATE TABLE IF NOT EXISTS app_settings (
            key TEXT PRIMARY KEY,
            value TEXT NOT NULL,
            updated_at TEXT NOT NULL
        );
        CREATE TABLE IF NOT EXISTS mail_accounts (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            source TEXT NOT NULL DEFAULT 'outlook-classic',
            source_account_id TEXT NOT NULL UNIQUE,
            account_name TEXT NOT NULL DEFAULT '',
            email TEXT NOT NULL DEFAULT '',
            account_type TEXT NOT NULL DEFAULT 'imap',
            incoming_server TEXT NOT NULL,
            incoming_user TEXT NOT NULL,
            incoming_port INTEGER NOT NULL,
            incoming_security TEXT NOT NULL,
            incoming_use_spa INTEGER NOT NULL DEFAULT 0,
            outgoing_server TEXT NOT NULL DEFAULT '',
            outgoing_user TEXT NOT NULL DEFAULT '',
            outgoing_port INTEGER NOT NULL DEFAULT 0,
            outgoing_security TEXT NOT NULL DEFAULT 'none',
            outgoing_use_auth INTEGER NOT NULL DEFAULT 0,
            outgoing_auth_method INTEGER NOT NULL DEFAULT 0,
            credential_reference TEXT NOT NULL,
            outgoing_credential_reference TEXT,
            created_at TEXT NOT NULL,
            updated_at TEXT NOT NULL
        );
        CREATE TABLE IF NOT EXISTS vault_config (
            id INTEGER PRIMARY KEY CHECK (id = 1),
            protected_key BLOB NOT NULL,
            username TEXT NOT NULL DEFAULT '',
            recovery_email TEXT NOT NULL DEFAULT '',
            password_hash TEXT,
            protection_enabled INTEGER NOT NULL DEFAULT 0,
            created_at TEXT NOT NULL,
            updated_at TEXT NOT NULL
        );
        CREATE TABLE IF NOT EXISTS vault_entries (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            entry_uuid TEXT NOT NULL UNIQUE,
            nonce BLOB NOT NULL,
            ciphertext BLOB NOT NULL,
            created_at TEXT NOT NULL,
            updated_at TEXT NOT NULL,
            deleted_at TEXT
        );
        CREATE INDEX IF NOT EXISTS idx_vault_entries_updated_at
            ON vault_entries(updated_at DESC);
        ",
    )
    .map_err(|err| err.to_string())?;

    conn.execute(
        "INSERT OR IGNORE INTO app_settings (key, value, updated_at) VALUES (?, ?, ?)",
        params![
            "onboarding_completed",
            initial_onboarding_completion(database_already_existed),
            now()
        ],
    )
    .map_err(|err| err.to_string())?;

    ensure_column(&conn, "contacts", "deleted_at", "TEXT")?;
    ensure_column(&conn, "contacts", "short_info", "TEXT NOT NULL DEFAULT ''")?;
    ensure_column(&conn, "contacts", "outlook_entry_id", "TEXT")?;
    ensure_column(&conn, "contacts", "outlook_store_id", "TEXT")?;
    ensure_column(&conn, "groups", "deleted_at", "TEXT")?;
    ensure_column(&conn, "vault_entries", "deleted_at", "TEXT")?;
    conn.execute_batch(
        "
        DROP INDEX IF EXISTS idx_contacts_email_unique;
        CREATE INDEX IF NOT EXISTS idx_contacts_display_name_search
            ON contacts(display_name COLLATE NOCASE);
        CREATE INDEX IF NOT EXISTS idx_contacts_email_search
            ON contacts(email COLLATE NOCASE);
        CREATE INDEX IF NOT EXISTS idx_contacts_phone_search ON contacts(phone);
        CREATE INDEX IF NOT EXISTS idx_contacts_mobile_phone_search ON contacts(mobile_phone);
        CREATE INDEX IF NOT EXISTS idx_contacts_import_batch ON contacts(import_batch_id);
        CREATE INDEX IF NOT EXISTS idx_contact_groups_group_contact
            ON contact_groups(group_id, contact_id);
        CREATE INDEX IF NOT EXISTS idx_m365_contact_links_remote
            ON m365_contact_links(source_id, remote_id);
        ",
    )
    .map_err(|err| err.to_string())?;

    if let Err(error) = create_auto_backup(app, &conn) {
        eprintln!("Automatische Sicherung beim Start fehlgeschlagen: {error}");
    }
    if let Err(error) = vault::write_automatic_password_backup(app, false) {
        eprintln!("Automatische Kennwort-Sicherung beim Start fehlgeschlagen: {error}");
    }
    Ok(())
}

fn ensure_column(
    conn: &Connection,
    table: &str,
    column: &str,
    column_type: &str,
) -> Result<(), String> {
    let mut stmt = conn
        .prepare(&format!("PRAGMA table_info({table})"))
        .map_err(|err| err.to_string())?;
    let columns = stmt
        .query_map([], |row| row.get::<_, String>(1))
        .map_err(|err| err.to_string())?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|err| err.to_string())?;
    if !columns.iter().any(|name| name == column) {
        conn.execute(
            &format!("ALTER TABLE {table} ADD COLUMN {column} {column_type}"),
            [],
        )
        .map_err(|err| err.to_string())?;
    }
    Ok(())
}

const AUTOMATIC_BACKUP_FOLDER: &str = "DMH Kontakte und Kalender\\Automatische Sicherung";
const AUTOMATIC_BACKUP_ADMIN_TEST_FOLDER: &str =
    "DMH Kontakte und Kalender Admin Test\\Automatische Sicherung";
const AUTOMATIC_BACKUP_LATEST: &str = "DMH-Kontakte-Kalender-Auto-Backup.json";
const DELETED_ELEMENT_MARKER: &str = "Gelöschtes Element";
const BACKUP_REPLACE_ATTEMPTS: usize = 5;

fn automatic_backup_folder(release_channel: Option<&str>) -> &'static str {
    if release_channel == Some("admin-test") {
        AUTOMATIC_BACKUP_ADMIN_TEST_FOLDER
    } else {
        AUTOMATIC_BACKUP_FOLDER
    }
}

pub(crate) fn automatic_backup_dir(app: &AppHandle) -> Result<PathBuf, String> {
    let documents = app
        .path()
        .document_dir()
        .map_err(|error| format!("Dokumente-Ordner konnte nicht ermittelt werden: {error}"))?;
    let directory = documents.join(automatic_backup_folder(option_env!("DMH_RELEASE_CHANNEL")));
    fs::create_dir_all(&directory).map_err(|error| {
        format!("Automatischer Backup-Ordner konnte nicht erstellt werden: {error}")
    })?;
    Ok(directory)
}

pub(crate) fn automatic_backup_app_data_dir(app: &AppHandle) -> Result<PathBuf, String> {
    let app_data = app
        .path()
        .app_data_dir()
        .map_err(|error| format!("AppData-Ordner konnte nicht ermittelt werden: {error}"))?;
    let directory = app_data.join("backups");
    fs::create_dir_all(&directory)
        .map_err(|error| format!("AppData-Backup-Ordner konnte nicht erstellt werden: {error}"))?;
    Ok(directory)
}

fn append_deleted_element_marker(value: &str) -> String {
    if value.contains(DELETED_ELEMENT_MARKER) {
        return value.to_string();
    }
    if value.trim().is_empty() {
        DELETED_ELEMENT_MARKER.to_string()
    } else {
        format!("{value}\n{DELETED_ELEMENT_MARKER}")
    }
}

fn mark_calendar_event_deleted_for_backup(event: &mut CalendarEvent) {
    event.description = append_deleted_element_marker(&event.description);
    if event.deleted_at.is_none() {
        event.deleted_at = Some(now());
    }
}

fn mark_contact_deleted_for_backup(contact: &mut Contact) {
    contact.notes = append_deleted_element_marker(&contact.notes);
    if contact.deleted_at.is_none() {
        contact.deleted_at = Some(now());
    }
}

fn mark_group_deleted_for_backup(group: &mut Group) {
    group.description = append_deleted_element_marker(&group.description);
    if group.deleted_at.is_none() {
        group.deleted_at = Some(now());
    }
}

fn parse_calendar_events(storage: &HashMap<String, String>, key: &str) -> Vec<CalendarEvent> {
    storage
        .get(key)
        .and_then(|value| serde_json::from_str(value).ok())
        .unwrap_or_default()
}

fn merge_calendar_backup_storage(
    previous: &HashMap<String, String>,
    current: &mut HashMap<String, String>,
) -> Result<(), String> {
    const ACTIVE_KEY: &str = "agendakontakte.calendarEvents";
    const DELETED_KEY: &str = "agendakontakte.deletedCalendarEvents";

    let previous_active = parse_calendar_events(previous, ACTIVE_KEY);
    let previous_deleted = parse_calendar_events(previous, DELETED_KEY);
    let current_has_active = current.contains_key(ACTIVE_KEY);
    let current_has_deleted = current.contains_key(DELETED_KEY);
    let current_active = parse_calendar_events(current, ACTIVE_KEY);
    let current_deleted = parse_calendar_events(current, DELETED_KEY);

    let mut merged: HashMap<String, (CalendarEvent, bool)> = HashMap::new();
    for event in &previous_active {
        merged.insert(event.id.clone(), (event.clone(), false));
    }
    for event in &previous_deleted {
        let mut deleted = event.clone();
        mark_calendar_event_deleted_for_backup(&mut deleted);
        merged.insert(deleted.id.clone(), (deleted, true));
    }

    if current_has_active || current_has_deleted {
        let current_active_ids: HashSet<String> = current_active
            .iter()
            .map(|event| event.id.clone())
            .collect();
        let current_deleted_ids: HashSet<String> = current_deleted
            .iter()
            .map(|event| event.id.clone())
            .collect();

        for event in previous_active {
            if !current_active_ids.contains(&event.id) && !current_deleted_ids.contains(&event.id) {
                let mut deleted = event;
                mark_calendar_event_deleted_for_backup(&mut deleted);
                merged.insert(deleted.id.clone(), (deleted, true));
            }
        }
    }

    if current_has_active {
        for event in current_active {
            merged.insert(event.id.clone(), (event, false));
        }
    }
    if current_has_deleted {
        for event in current_deleted {
            let mut deleted = event;
            mark_calendar_event_deleted_for_backup(&mut deleted);
            merged.insert(deleted.id.clone(), (deleted, true));
        }
    }

    let mut active = Vec::new();
    let mut deleted = Vec::new();
    for (event, is_deleted) in merged.into_values() {
        if is_deleted {
            deleted.push(event);
        } else {
            active.push(event);
        }
    }
    active.sort_by(|left, right| left.starts_at.cmp(&right.starts_at));
    deleted.sort_by(|left, right| left.starts_at.cmp(&right.starts_at));
    current.insert(
        ACTIVE_KEY.to_string(),
        serde_json::to_string(&active).map_err(|error| error.to_string())?,
    );
    current.insert(
        DELETED_KEY.to_string(),
        serde_json::to_string(&deleted).map_err(|error| error.to_string())?,
    );
    Ok(())
}

fn merge_automatic_backup(
    previous: Option<BackupData>,
    mut current: BackupData,
) -> Result<BackupData, String> {
    let Some(previous) = previous else {
        for contact in &mut current.contacts {
            if contact.deleted_at.is_some() {
                mark_contact_deleted_for_backup(contact);
            }
        }
        for group in &mut current.groups {
            if group.deleted_at.is_some() {
                mark_group_deleted_for_backup(group);
            }
        }
        merge_calendar_backup_storage(&HashMap::new(), &mut current.browser_storage)?;
        return Ok(current);
    };

    let current_contact_ids: HashSet<i64> = current
        .contacts
        .iter()
        .filter_map(|contact| contact.id)
        .collect();
    for mut contact in previous.contacts {
        if contact
            .id
            .is_some_and(|id| !current_contact_ids.contains(&id))
        {
            mark_contact_deleted_for_backup(&mut contact);
            current.contacts.push(contact);
        }
    }
    for contact in &mut current.contacts {
        if contact.deleted_at.is_some() {
            mark_contact_deleted_for_backup(contact);
        }
    }

    let current_group_ids: HashSet<i64> =
        current.groups.iter().filter_map(|group| group.id).collect();
    for mut group in previous.groups {
        if group.id.is_some_and(|id| !current_group_ids.contains(&id)) {
            mark_group_deleted_for_backup(&mut group);
            current.groups.push(group);
        }
    }
    for group in &mut current.groups {
        if group.deleted_at.is_some() {
            mark_group_deleted_for_backup(group);
        }
    }

    let mut settings_by_key: HashMap<String, String> = previous
        .settings
        .into_iter()
        .map(|setting| (setting.key, setting.value))
        .collect();
    for setting in current.settings.drain(..) {
        settings_by_key.insert(setting.key, setting.value);
    }
    current.settings = settings_by_key
        .into_iter()
        .map(|(key, value)| AppSetting { key, value })
        .collect();
    current
        .settings
        .sort_by(|left, right| left.key.cmp(&right.key));

    merge_calendar_backup_storage(&previous.browser_storage, &mut current.browser_storage)?;
    Ok(current)
}

pub(crate) fn replace_json_file(path: &Path, json: &str) -> Result<(), String> {
    let file_name = path
        .file_name()
        .and_then(|name| name.to_str())
        .unwrap_or("backup.json");
    let temporary = path.with_file_name(format!(".{file_name}.{}.tmp", Uuid::new_v4()));
    let result = (|| -> Result<(), std::io::Error> {
        let mut file = fs::OpenOptions::new()
            .create_new(true)
            .write(true)
            .open(&temporary)?;
        file.write_all(json.as_bytes())?;
        file.sync_all()?;
        drop(file);

        let mut last_error = None;
        for attempt in 0..BACKUP_REPLACE_ATTEMPTS {
            if path.exists() {
                if let Err(error) = fs::remove_file(path) {
                    last_error = Some(error);
                    if attempt + 1 < BACKUP_REPLACE_ATTEMPTS {
                        thread::sleep(Duration::from_millis(80));
                        continue;
                    }
                    break;
                }
            }
            match fs::rename(&temporary, path) {
                Ok(()) => return Ok(()),
                Err(error) => {
                    last_error = Some(error);
                    if attempt + 1 < BACKUP_REPLACE_ATTEMPTS {
                        thread::sleep(Duration::from_millis(80));
                    }
                }
            }
        }
        Err(last_error
            .unwrap_or_else(|| std::io::Error::other("Backup-Datei konnte nicht ersetzt werden.")))
    })();

    if result.is_err() {
        let _ = fs::remove_file(&temporary);
    }
    result.map_err(|error| format!("{}: {error}", path.display()))
}

pub(crate) fn write_external_backup_best_effort(path: &Path, json: &str, label: &str) {
    if let Err(error) = replace_json_file(path, json) {
        eprintln!("{label} konnte nicht aktualisiert werden: {error}");
    }
}

fn write_automatic_backup(
    app: &AppHandle,
    current: BackupData,
    snapshot: bool,
) -> Result<(), String> {
    let app_data_directory = automatic_backup_app_data_dir(app)?;
    let app_data_latest_path = app_data_directory.join(AUTOMATIC_BACKUP_LATEST);
    let previous_path = if app_data_latest_path.is_file() {
        Some(app_data_latest_path.clone())
    } else {
        automatic_backup_dir(app)
            .ok()
            .map(|directory| directory.join(AUTOMATIC_BACKUP_LATEST))
            .filter(|path| path.is_file())
    };
    let previous = if let Some(previous_path) = previous_path {
        let content = fs::read_to_string(&previous_path).map_err(|error| {
            format!("Automatischer Backup konnte nicht gelesen werden: {error}")
        })?;
        Some(
            serde_json::from_str::<BackupData>(&content).map_err(|error| {
                format!("Automatischer Backup konnte nicht gelesen werden: {error}")
            })?,
        )
    } else {
        None
    };
    let merged = merge_automatic_backup(previous, current)?;
    let json = serde_json::to_string_pretty(&merged).map_err(|error| error.to_string())?;
    replace_json_file(&app_data_latest_path, &json)?;

    if snapshot {
        let stamp = Utc::now().format("%Y%m%d-%H%M%S-%f");
        let app_data_snapshots = app_data_directory.join("Snapshots");
        fs::create_dir_all(&app_data_snapshots).map_err(|error| error.to_string())?;
        replace_json_file(
            &app_data_snapshots.join(format!("auto-backup-{stamp}.json")),
            &json,
        )?;
    }

    if let Ok(directory) = automatic_backup_dir(app) {
        write_external_backup_best_effort(
            &directory.join(AUTOMATIC_BACKUP_LATEST),
            &json,
            "Externe automatische Sicherung",
        );
        if snapshot {
            let snapshots = directory.join("Snapshots");
            if let Err(error) = fs::create_dir_all(&snapshots) {
                eprintln!("Externer Snapshot-Ordner konnte nicht erstellt werden: {error}");
            } else {
                let stamp = Utc::now().format("%Y%m%d-%H%M%S-%f");
                write_external_backup_best_effort(
                    &snapshots.join(format!("auto-backup-{stamp}.json")),
                    &json,
                    "Externer automatischer Snapshot",
                );
            }
        }
    }
    Ok(())
}

fn create_auto_backup(app: &AppHandle, conn: &Connection) -> Result<(), String> {
    let data = load_backup_data(conn)?;
    write_automatic_backup(app, data, false)
}

fn read_groups_for_contact(conn: &Connection, contact_id: i64) -> Result<Vec<Group>, String> {
    let mut stmt = conn
        .prepare(
            "
            SELECT g.id, g.name, g.description, g.created_at, g.updated_at, g.deleted_at
            FROM groups g
            JOIN contact_groups cg ON cg.group_id = g.id
            WHERE cg.contact_id = ?
              AND g.deleted_at IS NULL
            ORDER BY g.name COLLATE NOCASE
            ",
        )
        .map_err(|err| err.to_string())?;

    let rows = stmt
        .query_map(params![contact_id], |row| {
            Ok(Group {
                id: Some(row.get(0)?),
                name: row.get(1)?,
                description: row.get(2)?,
                created_at: row.get(3)?,
                updated_at: row.get(4)?,
                deleted_at: row.get(5)?,
            })
        })
        .map_err(|err| err.to_string())?;

    rows.collect::<Result<Vec<_>, _>>()
        .map_err(|err| err.to_string())
}

fn set_contact_groups(conn: &Connection, contact_id: i64, group_ids: &[i64]) -> Result<(), String> {
    conn.execute(
        "DELETE FROM contact_groups WHERE contact_id = ?",
        params![contact_id],
    )
    .map_err(|err| err.to_string())?;
    for group_id in group_ids {
        conn.execute(
            "INSERT OR IGNORE INTO contact_groups (contact_id, group_id) VALUES (?, ?)",
            params![contact_id, group_id],
        )
        .map_err(|err| err.to_string())?;
    }
    Ok(())
}

#[tauri::command]
fn list_contacts(
    app: AppHandle,
    search: Option<String>,
    group_id: Option<i64>,
) -> Result<Vec<Contact>, String> {
    let conn = open_db(&app)?;
    let query = format!("%{}%", search.unwrap_or_default().to_lowercase());
    let mut stmt = conn
        .prepare(
            "
            SELECT DISTINCT c.id, c.first_name, c.last_name, c.display_name, c.email, c.phone,
                   c.mobile_phone, c.street, c.postal_code, c.city, c.country, c.short_info, c.notes,
                   c.created_at, c.updated_at
            FROM contacts c
            LEFT JOIN contact_groups cg ON cg.contact_id = c.id
            WHERE (?2 IS NULL OR cg.group_id = ?2)
              AND c.deleted_at IS NULL
              AND (
                lower(c.first_name || ' ' || c.last_name || ' ' || c.display_name || ' ' || c.email || ' ' || c.phone || ' ' || c.mobile_phone || ' ' || c.city || ' ' || c.short_info)
                LIKE ?1
              )
            ORDER BY c.last_name COLLATE NOCASE, c.first_name COLLATE NOCASE, c.display_name COLLATE NOCASE
            ",
        )
        .map_err(|err| err.to_string())?;

    let rows = stmt
        .query_map(params![query, group_id], |row| {
            Ok(Contact {
                id: Some(row.get(0)?),
                first_name: row.get(1)?,
                last_name: row.get(2)?,
                display_name: row.get(3)?,
                email: row.get(4)?,
                phone: row.get(5)?,
                mobile_phone: row.get(6)?,
                street: row.get(7)?,
                postal_code: row.get(8)?,
                city: row.get(9)?,
                country: row.get(10)?,
                short_info: row.get(11)?,
                notes: row.get(12)?,
                groups: Vec::new(),
                created_at: row.get(13)?,
                updated_at: row.get(14)?,
                deleted_at: None,
            })
        })
        .map_err(|err| err.to_string())?;

    let mut contacts = rows
        .collect::<Result<Vec<_>, _>>()
        .map_err(|err| err.to_string())?;
    for contact in &mut contacts {
        if let Some(id) = contact.id {
            contact.groups = read_groups_for_contact(&conn, id)?;
        }
    }
    Ok(contacts)
}

#[tauri::command]
fn save_contact(app: AppHandle, contact: ContactInput) -> Result<i64, String> {
    let conn = open_db(&app)?;
    let timestamp = now();
    let display_name = if contact.display_name.trim().is_empty() {
        format!("{} {}", contact.first_name.trim(), contact.last_name.trim())
            .trim()
            .to_string()
    } else {
        contact.display_name.trim().to_string()
    };

    let id = if let Some(id) = contact.id {
        conn.execute(
            "
            UPDATE contacts
            SET first_name = ?, last_name = ?, display_name = ?, email = ?, phone = ?,
                mobile_phone = ?, street = ?, postal_code = ?, city = ?, country = ?,
                short_info = ?, notes = ?, updated_at = ?
            WHERE id = ?
            ",
            params![
                contact.first_name,
                contact.last_name,
                display_name,
                contact.email,
                contact.phone,
                contact.mobile_phone,
                contact.street,
                contact.postal_code,
                contact.city,
                contact.country,
                contact.short_info,
                contact.notes,
                timestamp,
                id
            ],
        )
        .map_err(|err| err.to_string())?;
        id
    } else {
        conn.execute(
            "
            INSERT INTO contacts (
                first_name, last_name, display_name, email, phone, mobile_phone, street,
                postal_code, city, country, short_info, notes, created_at, updated_at
            )
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            ",
            params![
                contact.first_name,
                contact.last_name,
                display_name,
                contact.email,
                contact.phone,
                contact.mobile_phone,
                contact.street,
                contact.postal_code,
                contact.city,
                contact.country,
                contact.short_info,
                contact.notes,
                timestamp,
                timestamp
            ],
        )
        .map_err(|err| err.to_string())?;
        conn.last_insert_rowid()
    };

    set_contact_groups(&conn, id, &contact.group_ids)?;
    Ok(id)
}

#[tauri::command]
fn delete_contact(app: AppHandle, id: i64) -> Result<(), String> {
    let conn = open_db(&app)?;
    conn.execute(
        "UPDATE contacts SET deleted_at = ?, updated_at = ? WHERE id = ?",
        params![now(), now(), id],
    )
    .map_err(|err| err.to_string())?;
    Ok(())
}

fn soft_delete_contacts(
    conn: &mut Connection,
    ids: &[i64],
    timestamp: &str,
) -> Result<usize, String> {
    if ids.is_empty() {
        return Ok(0);
    }

    let tx = conn.transaction().map_err(|err| err.to_string())?;
    let deleted = {
        let mut statement = tx
            .prepare(
                "UPDATE contacts
                 SET deleted_at = ?1, updated_at = ?1
                 WHERE id = ?2 AND deleted_at IS NULL",
            )
            .map_err(|err| err.to_string())?;
        let mut deleted = 0usize;
        for id in ids {
            deleted += statement
                .execute(params![timestamp, id])
                .map_err(|err| err.to_string())?;
        }
        deleted
    };
    tx.commit().map_err(|err| err.to_string())?;
    Ok(deleted)
}

#[tauri::command]
fn delete_contacts(app: AppHandle, ids: Vec<i64>) -> Result<usize, String> {
    let mut conn = open_db(&app)?;
    soft_delete_contacts(&mut conn, &ids, &now())
}

#[tauri::command]
fn restore_contact(app: AppHandle, id: i64) -> Result<(), String> {
    let conn = open_db(&app)?;
    conn.execute(
        "UPDATE contacts SET deleted_at = NULL, updated_at = ? WHERE id = ?",
        params![now(), id],
    )
    .map_err(|err| err.to_string())?;
    Ok(())
}

#[tauri::command]
fn list_deleted_contacts(app: AppHandle) -> Result<Vec<Contact>, String> {
    let conn = open_db(&app)?;
    let mut stmt = conn
        .prepare(
            "
            SELECT id, first_name, last_name, display_name, email, phone, mobile_phone,
                   street, postal_code, city, country, short_info, notes, created_at, updated_at, deleted_at
            FROM contacts
            WHERE deleted_at IS NOT NULL
            ORDER BY deleted_at DESC
            ",
        )
        .map_err(|err| err.to_string())?;
    let rows = stmt
        .query_map([], |row| {
            Ok(Contact {
                id: Some(row.get(0)?),
                first_name: row.get(1)?,
                last_name: row.get(2)?,
                display_name: row.get(3)?,
                email: row.get(4)?,
                phone: row.get(5)?,
                mobile_phone: row.get(6)?,
                street: row.get(7)?,
                postal_code: row.get(8)?,
                city: row.get(9)?,
                country: row.get(10)?,
                short_info: row.get(11)?,
                notes: row.get(12)?,
                groups: Vec::new(),
                created_at: row.get(13)?,
                updated_at: row.get(14)?,
                deleted_at: row.get(15)?,
            })
        })
        .map_err(|err| err.to_string())?;
    rows.collect::<Result<Vec<_>, _>>()
        .map_err(|err| err.to_string())
}

#[tauri::command]
fn list_groups(app: AppHandle) -> Result<Vec<Group>, String> {
    let conn = open_db(&app)?;
    let mut stmt = conn
        .prepare("SELECT id, name, description, created_at, updated_at, deleted_at FROM groups WHERE deleted_at IS NULL ORDER BY name COLLATE NOCASE")
        .map_err(|err| err.to_string())?;
    let rows = stmt
        .query_map([], |row| {
            Ok(Group {
                id: Some(row.get(0)?),
                name: row.get(1)?,
                description: row.get(2)?,
                created_at: row.get(3)?,
                updated_at: row.get(4)?,
                deleted_at: row.get(5)?,
            })
        })
        .map_err(|err| err.to_string())?;
    rows.collect::<Result<Vec<_>, _>>()
        .map_err(|err| err.to_string())
}

#[tauri::command]
fn save_group(app: AppHandle, group: Group) -> Result<i64, String> {
    let conn = open_db(&app)?;
    let timestamp = now();
    if let Some(id) = group.id {
        conn.execute(
            "UPDATE groups SET name = ?, description = ?, updated_at = ? WHERE id = ?",
            params![group.name, group.description, timestamp, id],
        )
        .map_err(|err| err.to_string())?;
        Ok(id)
    } else {
        conn.execute(
            "INSERT INTO groups (name, description, created_at, updated_at) VALUES (?, ?, ?, ?)",
            params![group.name, group.description, timestamp, timestamp],
        )
        .map_err(|err| err.to_string())?;
        Ok(conn.last_insert_rowid())
    }
}

#[tauri::command]
fn delete_group(app: AppHandle, id: i64) -> Result<(), String> {
    let conn = open_db(&app)?;
    conn.execute(
        "UPDATE groups SET deleted_at = ?, updated_at = ? WHERE id = ?",
        params![now(), now(), id],
    )
    .map_err(|err| err.to_string())?;
    Ok(())
}

#[tauri::command]
fn restore_group(app: AppHandle, id: i64) -> Result<(), String> {
    let conn = open_db(&app)?;
    conn.execute(
        "UPDATE groups SET deleted_at = NULL, updated_at = ? WHERE id = ?",
        params![now(), id],
    )
    .map_err(|err| err.to_string())?;
    Ok(())
}

#[tauri::command]
fn list_deleted_groups(app: AppHandle) -> Result<Vec<Group>, String> {
    let conn = open_db(&app)?;
    let mut stmt = conn
        .prepare("SELECT id, name, description, created_at, updated_at, deleted_at FROM groups WHERE deleted_at IS NOT NULL ORDER BY deleted_at DESC")
        .map_err(|err| err.to_string())?;
    let rows = stmt
        .query_map([], |row| {
            Ok(Group {
                id: Some(row.get(0)?),
                name: row.get(1)?,
                description: row.get(2)?,
                created_at: row.get(3)?,
                updated_at: row.get(4)?,
                deleted_at: row.get(5)?,
            })
        })
        .map_err(|err| err.to_string())?;
    rows.collect::<Result<Vec<_>, _>>()
        .map_err(|err| err.to_string())
}

#[tauri::command]
fn import_contacts(app: AppHandle, payload: ImportPayload) -> Result<ImportResult, String> {
    let mut conn = open_db(&app)?;
    let mut fingerprints = load_contact_fingerprints(&conn)?;
    let tx = conn.transaction().map_err(|err| err.to_string())?;
    let timestamp = now();
    let batch_id = format!("import-{}", Utc::now().timestamp_millis());
    let mut imported = 0usize;
    let mut skipped_duplicates = 0usize;

    for contact in payload.contacts {
        let email = contact.email.trim().to_lowercase();
        let display_name = if contact.display_name.trim().is_empty() {
            format!("{} {}", contact.first_name.trim(), contact.last_name.trim())
                .trim()
                .to_string()
        } else {
            contact.display_name.trim().to_string()
        };
        if fingerprints.exact_contacts.contains_key(&contact_exact_key(
            &contact,
            &display_name,
            &email,
        )) {
            skipped_duplicates += 1;
            continue;
        }

        tx.execute(
            "
            INSERT INTO contacts (
                first_name, last_name, display_name, email, phone, mobile_phone, street,
                postal_code, city, country, short_info, notes, import_batch_id, created_at, updated_at
            )
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            ",
            params![
                contact.first_name,
                contact.last_name,
                display_name,
                email,
                contact.phone,
                contact.mobile_phone,
                contact.street,
                contact.postal_code,
                contact.city,
                contact.country,
                contact.short_info,
                contact.notes,
                batch_id,
                timestamp,
                timestamp
            ],
        )
        .map_err(|err| err.to_string())?;
        let contact_id = tx.last_insert_rowid();
        add_fingerprint(&mut fingerprints, &contact, &display_name, &email);
        for group_id in contact.group_ids {
            tx.execute(
                "INSERT OR IGNORE INTO contact_groups (contact_id, group_id) VALUES (?, ?)",
                params![contact_id, group_id],
            )
            .map_err(|err| err.to_string())?;
        }
        imported += 1;
    }

    tx.execute(
        "INSERT INTO import_history (batch_id, source_file, imported_count, skipped_count, created_at) VALUES (?, ?, ?, ?, ?)",
        params![
            batch_id,
            payload.source_file,
            imported as i64,
            skipped_duplicates as i64,
            timestamp
        ],
    )
    .map_err(|err| err.to_string())?;
    tx.commit().map_err(|err| err.to_string())?;

    Ok(ImportResult {
        imported,
        skipped_duplicates,
        batch_id,
    })
}

#[tauri::command]
fn undo_last_import(app: AppHandle) -> Result<usize, String> {
    let conn = open_db(&app)?;
    let batch_id: Option<String> = conn
        .query_row(
            "SELECT batch_id FROM import_history ORDER BY created_at DESC, id DESC LIMIT 1",
            [],
            |row| row.get(0),
        )
        .optional()
        .map_err(|err| err.to_string())?;

    let Some(batch_id) = batch_id else {
        return Ok(0);
    };

    let deleted = conn
        .execute(
            "DELETE FROM contacts WHERE import_batch_id = ?",
            params![batch_id],
        )
        .map_err(|err| err.to_string())?;
    conn.execute(
        "DELETE FROM import_history WHERE batch_id = ?",
        params![batch_id],
    )
    .map_err(|err| err.to_string())?;
    Ok(deleted)
}

#[tauri::command]
fn undo_last_outlook_contact_import(app: AppHandle) -> Result<usize, String> {
    let conn = open_db(&app)?;
    let batch_id: Option<String> = conn
        .query_row(
            "SELECT batch_id
             FROM import_history
             WHERE source_file LIKE 'Outlook%Kontaktimport%'
             ORDER BY created_at DESC, id DESC
             LIMIT 1",
            [],
            |row| row.get(0),
        )
        .optional()
        .map_err(|err| err.to_string())?;

    let Some(batch_id) = batch_id else {
        return Ok(0);
    };
    let deleted = conn
        .execute(
            "DELETE FROM contacts WHERE import_batch_id = ?",
            params![batch_id],
        )
        .map_err(|err| err.to_string())?;
    conn.execute(
        "DELETE FROM import_history WHERE batch_id = ?",
        params![batch_id],
    )
    .map_err(|err| err.to_string())?;
    conn.execute(
        "DELETE FROM groups
         WHERE description LIKE 'Einmaliger Kontaktimport aus%Outlook%'
           AND NOT EXISTS (
             SELECT 1 FROM contact_groups WHERE contact_groups.group_id = groups.id
           )",
        [],
    )
    .map_err(|err| err.to_string())?;
    Ok(deleted)
}

fn load_backup_data(conn: &Connection) -> Result<BackupData, String> {
    let contacts = {
        let mut stmt = conn
            .prepare(
                "
                SELECT id, first_name, last_name, display_name, email, phone, mobile_phone,
                       street, postal_code, city, country, short_info, notes, created_at, updated_at, deleted_at
                FROM contacts
                ORDER BY last_name COLLATE NOCASE, first_name COLLATE NOCASE
                ",
            )
            .map_err(|err| err.to_string())?;
        let rows = stmt
            .query_map([], |row| {
                Ok(Contact {
                    id: Some(row.get(0)?),
                    first_name: row.get(1)?,
                    last_name: row.get(2)?,
                    display_name: row.get(3)?,
                    email: row.get(4)?,
                    phone: row.get(5)?,
                    mobile_phone: row.get(6)?,
                    street: row.get(7)?,
                    postal_code: row.get(8)?,
                    city: row.get(9)?,
                    country: row.get(10)?,
                    short_info: row.get(11)?,
                    notes: row.get(12)?,
                    groups: Vec::new(),
                    created_at: row.get(13)?,
                    updated_at: row.get(14)?,
                    deleted_at: row.get(15)?,
                })
            })
            .map_err(|err| err.to_string())?;
        let mut contacts = rows
            .collect::<Result<Vec<_>, _>>()
            .map_err(|err| err.to_string())?;
        for contact in &mut contacts {
            if let Some(id) = contact.id {
                contact.groups = read_groups_for_contact(conn, id)?;
            }
        }
        contacts
    };

    let groups = {
        let mut stmt = conn
            .prepare("SELECT id, name, description, created_at, updated_at, deleted_at FROM groups ORDER BY name COLLATE NOCASE")
            .map_err(|err| err.to_string())?;
        let rows = stmt
            .query_map([], |row| {
                Ok(Group {
                    id: Some(row.get(0)?),
                    name: row.get(1)?,
                    description: row.get(2)?,
                    created_at: row.get(3)?,
                    updated_at: row.get(4)?,
                    deleted_at: row.get(5)?,
                })
            })
            .map_err(|err| err.to_string())?;
        rows.collect::<Result<Vec<_>, _>>()
            .map_err(|err| err.to_string())?
    };

    let settings = {
        let mut stmt = conn
            .prepare(
                "SELECT key, value FROM app_settings
                 WHERE key NOT LIKE 'migration_capture_%'
                   AND key NOT LIKE 'm365_%'
                 ORDER BY key",
            )
            .map_err(|err| err.to_string())?;
        let rows = stmt
            .query_map([], |row| {
                Ok(AppSetting {
                    key: row.get(0)?,
                    value: row.get(1)?,
                })
            })
            .map_err(|err| err.to_string())?;
        rows.collect::<Result<Vec<_>, _>>()
            .map_err(|err| err.to_string())?
    };

    Ok(BackupData {
        version: "2.0.0".to_string(),
        exported_at: now(),
        contacts,
        groups,
        settings,
        browser_storage: HashMap::new(),
    })
}

#[tauri::command]
fn get_backup_data(app: AppHandle) -> Result<BackupData, String> {
    let conn = open_db(&app)?;
    load_backup_data(&conn)
}

#[tauri::command]
fn create_automatic_backup(
    app: AppHandle,
    backup: BackupData,
    snapshot: Option<bool>,
) -> Result<(), String> {
    write_automatic_backup(&app, backup, snapshot.unwrap_or(false))
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AutomaticBackupRestoreResult {
    pub browser_storage: HashMap<String, String>,
    pub passwords_restored: bool,
}

#[tauri::command]
fn restore_automatic_backup(
    app: AppHandle,
    authorization: String,
) -> Result<AutomaticBackupRestoreResult, String> {
    let authorization = authorization.trim();
    if authorization.len() < 8 || !authorization.to_ascii_uppercase().starts_with("EDV-") {
        return Err(
            "Für diese Wiederherstellung ist der Freigabecode der EDV erforderlich (Format EDV-...)."
                .to_string(),
        );
    }

    let directory = automatic_backup_dir(&app)?;
    let app_data_directory = automatic_backup_app_data_dir(&app)?;
    let latest_path = directory.join(AUTOMATIC_BACKUP_LATEST);
    let app_data_latest_path = app_data_directory.join(AUTOMATIC_BACKUP_LATEST);
    let content = fs::read_to_string(&latest_path)
        .or_else(|_| fs::read_to_string(&app_data_latest_path))
        .map_err(|error| {
            format!("Die automatische Sicherung konnte nicht gelesen werden: {error}")
        })?;
    let backup = serde_json::from_str::<BackupData>(&content).map_err(|error| {
        format!(
            "Die automatische Sicherung ist beschädigt oder stammt aus einer unbekannten Version: {error}"
        )
    })?;

    // Validate the encrypted password archive before replacing contacts and
    // calendar data, so a damaged password archive cannot cause a partial
    // recovery.
    let passwords_restored = vault::validate_automatic_password_backup(&app)?;
    let browser_storage = backup.browser_storage.clone();
    restore_backup(app.clone(), backup)?;
    if passwords_restored {
        vault::restore_automatic_password_backup(&app)?;
    }

    Ok(AutomaticBackupRestoreResult {
        browser_storage,
        passwords_restored,
    })
}

fn is_backup_safe_setting_key(key: &str) -> bool {
    !key.starts_with("migration_capture_") && !key.starts_with("m365_")
}

fn restore_backup_settings(
    tx: &rusqlite::Transaction<'_>,
    settings: Vec<AppSetting>,
) -> Result<(), String> {
    tx.execute(
        "DELETE FROM app_settings
         WHERE key NOT LIKE 'migration_capture_%'
           AND key NOT LIKE 'm365_%'",
        [],
    )
    .map_err(|err| err.to_string())?;

    for setting in settings {
        if !is_backup_safe_setting_key(&setting.key) {
            continue;
        }
        tx.execute(
            "INSERT INTO app_settings (key, value, updated_at) VALUES (?, ?, ?)",
            params![setting.key, setting.value, now()],
        )
        .map_err(|err| err.to_string())?;
    }
    Ok(())
}

#[tauri::command]
fn restore_backup(app: AppHandle, backup: BackupData) -> Result<(), String> {
    let mut conn = open_db(&app)?;
    let tx = conn.transaction().map_err(|err| err.to_string())?;
    tx.execute("DELETE FROM contact_groups", [])
        .map_err(|err| err.to_string())?;
    tx.execute("DELETE FROM contacts", [])
        .map_err(|err| err.to_string())?;
    tx.execute("DELETE FROM groups", [])
        .map_err(|err| err.to_string())?;

    let mut group_id_map: Vec<(i64, i64)> = Vec::new();
    for group in backup.groups {
        let old_id = group.id.unwrap_or_default();
        tx.execute(
            "INSERT INTO groups (name, description, created_at, updated_at, deleted_at) VALUES (?, ?, ?, ?, ?)",
            params![group.name, group.description, group.created_at, group.updated_at, group.deleted_at],
        )
        .map_err(|err| err.to_string())?;
        group_id_map.push((old_id, tx.last_insert_rowid()));
    }

    for contact in backup.contacts {
        tx.execute(
            "
            INSERT INTO contacts (
                first_name, last_name, display_name, email, phone, mobile_phone, street,
                postal_code, city, country, short_info, notes, created_at, updated_at, deleted_at
            )
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            ",
            params![
                contact.first_name,
                contact.last_name,
                contact.display_name,
                contact.email,
                contact.phone,
                contact.mobile_phone,
                contact.street,
                contact.postal_code,
                contact.city,
                contact.country,
                contact.short_info,
                contact.notes,
                contact.created_at,
                contact.updated_at,
                contact.deleted_at
            ],
        )
        .map_err(|err| err.to_string())?;
        let new_contact_id = tx.last_insert_rowid();
        for group in contact.groups {
            if let Some(old_group_id) = group.id {
                if let Some((_, new_group_id)) =
                    group_id_map.iter().find(|(old, _)| *old == old_group_id)
                {
                    tx.execute(
                        "INSERT OR IGNORE INTO contact_groups (contact_id, group_id) VALUES (?, ?)",
                        params![new_contact_id, new_group_id],
                    )
                    .map_err(|err| err.to_string())?;
                }
            }
        }
    }

    restore_backup_settings(&tx, backup.settings)?;

    tx.commit().map_err(|err| err.to_string())
}

#[tauri::command]
fn write_export_file(path: String, content: String) -> Result<(), String> {
    fs::write(&path, content).map_err(|err| format!("Datei konnte nicht geschrieben werden: {err}"))
}

fn clear_local_database(conn: &mut Connection) -> Result<(), String> {
    conn.execute_batch("PRAGMA secure_delete = ON;")
        .map_err(|error| format!("Sicheres Löschen konnte nicht aktiviert werden: {error}"))?;
    let transaction = conn.transaction().map_err(|error| error.to_string())?;
    transaction
        .execute_batch(
            "
            DELETE FROM contact_groups;
            DELETE FROM contacts;
            DELETE FROM groups;
            DELETE FROM import_history;
            DELETE FROM mail_accounts;
            DELETE FROM vault_entries;
            DELETE FROM vault_config;
            DELETE FROM app_settings;
            DELETE FROM sqlite_sequence
             WHERE name IN ('contacts', 'groups', 'import_history', 'mail_accounts', 'vault_entries');
            ",
        )
        .map_err(|error| format!("Lokale Datenbank konnte nicht geleert werden: {error}"))?;
    transaction
        .commit()
        .map_err(|error| format!("Lokale Datenbank konnte nicht zurückgesetzt werden: {error}"))?;
    let _ = conn.execute_batch("VACUUM;");
    Ok(())
}

fn remove_known_app_subdirectory(app_dir: &PathBuf, name: &str) -> Result<(), String> {
    if name.is_empty() || name == "." || name == ".." || name.contains('/') || name.contains('\\') {
        return Err("Ungültiges lokales Reset-Ziel.".to_string());
    }
    let target = app_dir.join(name);
    if target.parent() != Some(app_dir.as_path()) {
        return Err("Lokales Reset-Ziel liegt außerhalb des App-Verzeichnisses.".to_string());
    }
    if target.exists() {
        fs::remove_dir_all(&target).map_err(|error| {
            format!("Lokale {name}-Daten konnten nicht gelöscht werden: {error}")
        })?;
    }
    Ok(())
}

#[tauri::command]
fn reset_local_app_data(app: AppHandle) -> Result<(), String> {
    mail_accounts::remove_all_mail_credentials(&app).map_err(|error| {
        format!(
            "Die gespeicherten E-Mail-Kennwörter konnten nicht sicher entfernt werden. Es wurden noch keine App-Daten gelöscht. {error}"
        )
    })?;

    let app_dir = app
        .path()
        .app_data_dir()
        .map_err(|error| format!("App-Datenverzeichnis konnte nicht ermittelt werden: {error}"))?;
    mail_accounts::clear_migration_diagnostics(&app)?;

    let mut conn = open_db(&app)?;
    // Preserve the state immediately before a destructive reset in the
    // external archive. The archive intentionally lives outside app_data_dir
    // and is therefore not removed by this reset operation.
    write_automatic_backup(&app, load_backup_data(&conn)?, true)?;
    vault::write_automatic_password_backup(&app, true)?;
    remove_known_app_subdirectory(&app_dir, "backups")?;
    clear_local_database(&mut conn)?;
    drop(conn);

    vault::clear_runtime(&app)?;
    m365::clear_runtime(&app)?;
    {
        let state = app.state::<AppState>();
        let mut cache = state
            .outlook_contact_cache
            .lock()
            .map_err(|_| "Outlook-Zwischenspeicher konnte nicht geleert werden.".to_string())?;
        *cache = None;
    }
    Ok(())
}

#[tauri::command]
fn restart_app(app: AppHandle) {
    app.restart()
}

#[tauri::command]
fn delete_all_contacts(app: AppHandle) -> Result<usize, String> {
    let conn = open_db(&app)?;
    conn.execute(
        "UPDATE contacts SET deleted_at = ?, updated_at = ? WHERE deleted_at IS NULL",
        params![now(), now()],
    )
    .map_err(|err| err.to_string())
}

#[tauri::command]
fn add_contact_to_group(app: AppHandle, contact_id: i64, group_id: i64) -> Result<(), String> {
    let conn = open_db(&app)?;
    conn.execute(
        "INSERT OR IGNORE INTO contact_groups (contact_id, group_id) VALUES (?, ?)",
        params![contact_id, group_id],
    )
    .map_err(|err| err.to_string())?;
    Ok(())
}

#[tauri::command]
fn move_contact_to_group(app: AppHandle, contact_id: i64, group_id: i64) -> Result<(), String> {
    let mut conn = open_db(&app)?;
    let contact_exists: bool = conn
        .query_row(
            "SELECT EXISTS(SELECT 1 FROM contacts WHERE id = ? AND deleted_at IS NULL)",
            params![contact_id],
            |row| row.get(0),
        )
        .map_err(|err| err.to_string())?;
    if !contact_exists {
        return Err("Kontakt wurde nicht gefunden oder ist gelöscht.".to_string());
    }

    let group_exists: bool = conn
        .query_row(
            "SELECT EXISTS(SELECT 1 FROM groups WHERE id = ? AND deleted_at IS NULL)",
            params![group_id],
            |row| row.get(0),
        )
        .map_err(|err| err.to_string())?;
    if !group_exists {
        return Err("Gruppe wurde nicht gefunden oder ist gelöscht.".to_string());
    }

    let tx = conn.transaction().map_err(|err| err.to_string())?;
    tx.execute(
        "DELETE FROM contact_groups WHERE contact_id = ?",
        params![contact_id],
    )
    .map_err(|err| err.to_string())?;
    tx.execute(
        "INSERT OR IGNORE INTO contact_groups (contact_id, group_id) VALUES (?, ?)",
        params![contact_id, group_id],
    )
    .map_err(|err| err.to_string())?;
    tx.commit().map_err(|err| err.to_string())
}

#[tauri::command]
fn clear_contact_groups(app: AppHandle, contact_id: i64) -> Result<(), String> {
    let conn = open_db(&app)?;
    let contact_exists: bool = conn
        .query_row(
            "SELECT EXISTS(SELECT 1 FROM contacts WHERE id = ? AND deleted_at IS NULL)",
            params![contact_id],
            |row| row.get(0),
        )
        .map_err(|err| err.to_string())?;
    if !contact_exists {
        return Err("Kontakt wurde nicht gefunden oder ist gelöscht.".to_string());
    }

    conn.execute(
        "DELETE FROM contact_groups WHERE contact_id = ?",
        params![contact_id],
    )
    .map_err(|err| err.to_string())?;
    Ok(())
}

#[tauri::command]
fn open_outlook_classic_email(email: String) -> Result<(), String> {
    let shortcut = r"C:\ProgramData\Microsoft\Windows\Start Menu\Programs\Outlook (classic).lnk";
    let status = hidden_command("cmd")
        .args([
            "/C",
            "start",
            "",
            shortcut,
            "/c",
            "ipm.note",
            "/m",
            email.as_str(),
        ])
        .status()
        .map_err(|err| format!("Outlook Classic konnte nicht geöffnet werden: {err}"))?;
    if status.success() {
        Ok(())
    } else {
        Err("Outlook Classic konnte nicht geöffnet werden.".to_string())
    }
}

#[tauri::command]
fn open_new_outlook_email(email: String) -> Result<(), String> {
    let compose_url = format!("ms-outlook://compose?to={}", email.trim());
    hidden_command("explorer.exe")
        .arg(compose_url)
        .spawn()
        .map_err(|err| format!("Das neue Outlook konnte nicht geöffnet werden: {err}"))?;
    Ok(())
}

#[tauri::command]
fn open_outlook_classic_bulk_email(
    recipients: Vec<String>,
    subject: Option<String>,
) -> Result<(), String> {
    let recipients = normalize_recipients(recipients);
    if recipients.is_empty() {
        return Err("Keine gültigen E-Mail-Adressen gefunden.".to_string());
    }

    let bcc = recipients.join("; ");
    let subject = subject.unwrap_or_default();
    let script = format!(
        r#"
$ErrorActionPreference = 'Stop'
$outlook = New-Object -ComObject Outlook.Application
$mail = $outlook.CreateItem(0)
$mail.Bcc = {bcc}
$mail.Subject = {subject}
$mail.Display()
"#,
        bcc = powershell_single_quote(&bcc),
        subject = powershell_single_quote(&subject)
    );

    let status = hidden_command("powershell")
        .args([
            "-NoProfile",
            "-ExecutionPolicy",
            "Bypass",
            "-Command",
            script.as_str(),
        ])
        .status()
        .map_err(|err| format!("Outlook Classic konnte nicht geöffnet werden: {err}"))?;
    if status.success() {
        Ok(())
    } else {
        Err("Outlook Classic konnte nicht geöffnet werden.".to_string())
    }
}

#[tauri::command]
fn open_new_outlook_bulk_email(
    recipients: Vec<String>,
    subject: Option<String>,
) -> Result<(), String> {
    let recipients = normalize_recipients(recipients);
    if recipients.is_empty() {
        return Err("Keine gültigen E-Mail-Adressen gefunden.".to_string());
    }

    let bcc = recipients.join(";");
    let mut compose_url = format!("ms-outlook://compose?bcc={}", url_encode_component(&bcc));
    if let Some(subject) = subject {
        let subject = subject.trim();
        if !subject.is_empty() {
            compose_url.push_str("&subject=");
            compose_url.push_str(&url_encode_component(subject));
        }
    }

    hidden_command("explorer.exe")
        .arg(compose_url)
        .spawn()
        .map_err(|err| format!("Das neue Outlook konnte nicht geöffnet werden: {err}"))?;
    Ok(())
}

#[tauri::command]
fn get_app_setting(app: AppHandle, key: String) -> Result<Option<String>, String> {
    let conn = open_db(&app)?;
    conn.query_row(
        "SELECT value FROM app_settings WHERE key = ?",
        params![key],
        |row| row.get(0),
    )
    .optional()
    .map_err(|err| err.to_string())
}

#[tauri::command]
fn set_app_setting(app: AppHandle, key: String, value: String) -> Result<(), String> {
    let conn = open_db(&app)?;
    conn.execute(
        "INSERT INTO app_settings (key, value, updated_at) VALUES (?, ?, ?)
         ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at",
        params![key, value, now()],
    )
    .map_err(|err| err.to_string())?;
    Ok(())
}

fn read_outlook_classic_contacts() -> Result<OutlookReadData, String> {
    let script = r#"
$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
$outlook = New-Object -ComObject Outlook.Application
$namespace = $outlook.Session
$contacts = New-Object System.Collections.Generic.List[object]
$skipped = 0
function Get-Contact-Email($item) {
  $email = [string]$item.Email1Address
  try {
    $smtp = [string]$item.PropertyAccessor.GetProperty('http://schemas.microsoft.com/mapi/proptag/0x39FE001E')
    if (-not [string]::IsNullOrWhiteSpace($smtp)) { $email = $smtp }
  } catch {}
  if ([string]::IsNullOrWhiteSpace($email)) { $email = [string]$item.Email2Address }
  if ([string]::IsNullOrWhiteSpace($email)) { $email = [string]$item.Email3Address }
  return $email
}
function Read-Contact-Folder($folder, $storeId, $storeName) {
  try {
    $folderId = [string]$folder.EntryID
    $folderPath = [string]$folder.FolderPath
    $folderItems = $folder.Items
    for ($index = 1; $index -le $folderItems.Count; $index++) {
      try {
        $item = $folderItems.Item($index)
        $messageClass = [string]$item.MessageClass
        if ($messageClass -like 'IPM.Contact*') {
          $contacts.Add([pscustomobject]@{
            entryId = [string]$item.EntryID
            storeId = $storeId
            storeName = $storeName
            folderId = $folderId
            folderPath = $folderPath
            firstName = [string]$item.FirstName
            lastName = [string]$item.LastName
            displayName = [string]$item.FullName
            email = (Get-Contact-Email $item)
            phone = [string]$item.BusinessTelephoneNumber
            mobilePhone = [string]$item.MobileTelephoneNumber
            street = [string]$item.BusinessAddressStreet
            postalCode = [string]$item.BusinessAddressPostalCode
            city = [string]$item.BusinessAddressCity
            country = [string]$item.BusinessAddressCountry
            shortInfo = ''
            notes = [string]$item.Body
          }) | Out-Null
        }
      } catch { $script:skipped++ }
    }
  } catch { $script:skipped++ }
}
function Read-Folders($folder, $storeId, $storeName) {
  try {
    if ([int]$folder.DefaultItemType -eq 2) { Read-Contact-Folder $folder $storeId $storeName }
  } catch { $script:skipped++ }
  try {
    $children = $folder.Folders
    for ($childIndex = 1; $childIndex -le $children.Count; $childIndex++) {
      Read-Folders $children.Item($childIndex) $storeId $storeName
    }
  } catch { $script:skipped++ }
}
for ($storeIndex = 1; $storeIndex -le $namespace.Stores.Count; $storeIndex++) {
  try {
    $store = $namespace.Stores.Item($storeIndex)
    Read-Folders $store.GetRootFolder() ([string]$store.StoreID) ([string]$store.DisplayName)
  } catch { $script:skipped++ }
}
[pscustomobject]@{ contacts = $contacts.ToArray(); skipped = $skipped } | ConvertTo-Json -Depth 6 -Compress
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
        .map_err(|err| format!("Outlook Classic konnte nicht gestartet werden: {err}"))?;

    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        return Err(format!(
            "Outlook Classic konnte nicht gelesen werden. Prüfen Sie, ob Outlook Classic installiert und eingerichtet ist. {stderr}"
        ));
    }

    let stdout = String::from_utf8_lossy(&output.stdout);
    serde_json::from_str::<OutlookReadData>(stdout.trim())
        .map_err(|err| format!("Outlook-Kontakte konnten nicht ausgewertet werden: {err}"))
}

fn read_outlook_classic_contacts_for_import() -> Result<(OutlookReadData, Vec<String>), String> {
    let mut data = read_outlook_classic_contacts()?;
    let autocomplete = outlook_autocomplete::read_outlook_autocomplete();
    let mut warnings = autocomplete.warnings;
    if autocomplete.files_read > 0 {
        warnings.push(
            "Die Outlook-Autovervollständigung wird aus dem zuletzt gespeicherten lokalen Cache gelesen. Sehr neue Empfänger erscheinen möglicherweise erst, nachdem Outlook Classic vollständig beendet wurde."
                .to_string(),
        );
    }
    data.contacts
        .extend(autocomplete.entries.into_iter().map(|entry| {
            let display_name = if entry.display_name.trim().is_empty() {
                entry.email.clone()
            } else {
                entry.display_name
            };
            OutlookContactRecord {
                source_kind: "autocomplete".to_string(),
                entry_id: format!("autocomplete:{}", outlook_hash(&entry.email)),
                store_id: "outlook-autocomplete".to_string(),
                store_name: "Outlook Classic".to_string(),
                folder_id: "outlook-autocomplete".to_string(),
                folder_path: "Outlook-Autovervollständigung".to_string(),
                first_name: String::new(),
                last_name: String::new(),
                display_name,
                email: entry.email,
                phone: String::new(),
                mobile_phone: String::new(),
                street: String::new(),
                postal_code: String::new(),
                city: String::new(),
                country: String::new(),
                short_info: String::new(),
                notes: String::new(),
            }
        }));
    Ok((data, warnings))
}

fn cache_outlook_contacts(app: &AppHandle, data: OutlookReadData) {
    if let Ok(mut cache) = app.state::<AppState>().outlook_contact_cache.lock() {
        *cache = Some(CachedOutlookContacts {
            captured_at: Instant::now(),
            data,
        });
    }
}

fn take_cached_outlook_contacts(app: &AppHandle) -> Option<OutlookReadData> {
    let state = app.state::<AppState>();
    let mut cache = state.outlook_contact_cache.lock().ok()?;
    let cached = cache.take()?;
    if cached.captured_at.elapsed() <= Duration::from_secs(15 * 60) {
        Some(cached.data)
    } else {
        None
    }
}

fn outlook_record_to_contact(record: &OutlookContactRecord) -> ContactInput {
    ContactInput {
        id: None,
        first_name: record.first_name.clone(),
        last_name: record.last_name.clone(),
        display_name: record.display_name.clone(),
        email: record.email.clone(),
        phone: record.phone.clone(),
        mobile_phone: record.mobile_phone.clone(),
        street: record.street.clone(),
        postal_code: record.postal_code.clone(),
        city: record.city.clone(),
        country: record.country.clone(),
        short_info: record.short_info.clone(),
        notes: record.notes.clone(),
        group_ids: Vec::new(),
    }
}

fn extract_imported_email(values: &[&str]) -> String {
    for value in values {
        for candidate in value.split(|character: char| {
            character.is_whitespace()
                || matches!(character, '<' | '>' | '"' | '\'' | '(' | ')' | ',' | ';' | ':')
        }) {
            let cleaned = candidate
                .trim_matches(|character| matches!(character, '.' | ',' | ';' | ':' | '!' | '?'))
                .trim();
            let mut parts = cleaned.split('@');
            let local_part = parts.next().unwrap_or("");
            let domain = parts.next().unwrap_or("");
            if !local_part.is_empty() && !domain.is_empty() && parts.next().is_none() {
                return cleaned.to_string();
            }
        }
    }
    String::new()
}

fn capitalize_imported_name(value: &str) -> String {
    let mut result = String::with_capacity(value.len());
    let mut uppercase_next = true;
    for character in value.trim().chars() {
        if uppercase_next && character.is_alphabetic() {
            result.extend(character.to_uppercase());
            uppercase_next = false;
        } else {
            result.push(character);
            if character.is_alphabetic() {
                uppercase_next = false;
            }
        }
        if character.is_whitespace() || matches!(character, '-' | '\'' | '’') {
            uppercase_next = true;
        }
    }
    result
}

pub(crate) fn clean_imported_display_name(value: &str, email: &str) -> String {
    let trim_quotes = |text: &str| {
        text.trim()
            .trim_matches(|character| {
                matches!(character, '"' | '\'' | '“' | '”' | '„' | '‚' | '‘' | '’')
            })
            .trim()
            .to_string()
    };
    let normalized_email = email.trim();
    let email_local_part = normalized_email.split('@').next().unwrap_or("").trim();
    let mut cleaned = trim_quotes(value);

    if let Some((name, address)) = cleaned.rsplit_once('<') {
        if address
            .trim_end_matches('>')
            .trim()
            .eq_ignore_ascii_case(normalized_email)
        {
            cleaned = trim_quotes(name);
        }
    }

    if let Some((local_part, _)) = cleaned.split_once('@') {
        cleaned = local_part.to_string();
    }
    if cleaned.is_empty() && !email_local_part.is_empty() {
        cleaned = email_local_part.to_string();
    }
    cleaned = cleaned.replace(['.', '_', '@'], " ");

    let normalized = trim_quotes(&cleaned)
        .split_whitespace()
        .collect::<Vec<_>>()
        .join(" ");
    capitalize_imported_name(&normalized)
}

pub(crate) fn clean_imported_contact_name(contact: &mut ContactInput) {
    let fallback_name = format!(
        "{} {}",
        contact.first_name.trim(),
        contact.last_name.trim()
    )
    .trim()
    .to_string();
    let original_email = contact.email.trim().to_string();
    let detected_email = extract_imported_email(&[
        &original_email,
        &contact.display_name,
        &fallback_name,
    ]);
    let source_name = if !contact.display_name.trim().is_empty() {
        contact.display_name.clone()
    } else if !fallback_name.is_empty() {
        fallback_name
    } else if !original_email.is_empty() {
        original_email.clone()
    } else {
        detected_email.clone()
    };
    let comparison_email = if detected_email.is_empty() {
        original_email
    } else {
        detected_email.clone()
    };
    contact.first_name = capitalize_imported_name(&contact.first_name);
    contact.last_name = capitalize_imported_name(&contact.last_name);
    contact.display_name = clean_imported_display_name(&source_name, &comparison_email);
    contact.email = detected_email;
}

fn outlook_hash(value: &str) -> String {
    format!("{:x}", Sha256::digest(value.as_bytes()))
}

fn outlook_source_id(record: &OutlookContactRecord) -> String {
    if record.source_kind == "autocomplete" {
        return "outlook-autocomplete-cache".to_string();
    }
    let folder_key = if record.folder_id.trim().is_empty() {
        record.folder_path.trim()
    } else {
        record.folder_id.trim()
    };
    outlook_hash(&format!("{}|{}", record.store_id.trim(), folder_key))
}

fn outlook_contact_id(record: &OutlookContactRecord) -> String {
    let entry_key = if record.entry_id.trim().is_empty() {
        format!(
            "{}|{}|{}|{}",
            record.display_name.trim(),
            record.email.trim(),
            record.phone.trim(),
            record.mobile_phone.trim()
        )
    } else {
        record.entry_id.trim().to_string()
    };
    outlook_hash(&format!("{}|{}", outlook_source_id(record), entry_key))
}

fn is_outlook_autocomplete_record(record: &OutlookContactRecord) -> bool {
    record.source_kind == "autocomplete"
}

fn outlook_store_name(record: &OutlookContactRecord) -> String {
    let name = record.store_name.trim();
    if name.is_empty() {
        "Outlook".to_string()
    } else {
        name.to_string()
    }
}

fn original_outlook_folder_name(folder_path: &str) -> String {
    let trimmed = folder_path.trim().trim_end_matches(['\\', '/']);
    let folder_name = trimmed.rsplit(['\\', '/']).next().unwrap_or(trimmed).trim();
    if folder_name.is_empty() {
        "Kontakte".to_string()
    } else {
        folder_name.chars().take(80).collect()
    }
}

fn suggested_outlook_group_name(folder_path: &str) -> String {
    original_outlook_folder_name(folder_path)
}

fn normalize_phone_for_match(value: &str) -> String {
    let mut digits: String = value
        .chars()
        .filter(|value| value.is_ascii_digit())
        .collect();
    if digits.starts_with("0049") && digits.len() > 8 {
        digits = format!("0{}", &digits[4..]);
    } else if digits.starts_with("49") && digits.len() > 8 {
        digits = format!("0{}", &digits[2..]);
    }
    if digits.len() < 7 {
        String::new()
    } else {
        digits
    }
}

fn contact_phone_keys(contact: &ContactInput) -> Vec<String> {
    let mut phones = Vec::new();
    for value in [&contact.phone, &contact.mobile_phone] {
        let normalized = normalize_phone_for_match(value);
        if !normalized.is_empty() && !phones.contains(&normalized) {
            phones.push(normalized);
        }
    }
    phones
}

fn contact_exact_key(contact: &ContactInput, display_name: &str, email: &str) -> String {
    serde_json::to_string(&[
        contact.first_name.as_str(),
        contact.last_name.as_str(),
        display_name,
        email,
        contact.phone.as_str(),
        contact.mobile_phone.as_str(),
        contact.street.as_str(),
        contact.postal_code.as_str(),
        contact.city.as_str(),
        contact.country.as_str(),
        contact.short_info.as_str(),
        contact.notes.as_str(),
    ])
    .expect("Kontaktfelder müssen als JSON serialisierbar sein")
}

fn load_contact_fingerprints(conn: &Connection) -> Result<ContactFingerprintIndex, String> {
    let mut stmt = conn
        .prepare(
            "SELECT first_name, last_name, display_name, email, phone, mobile_phone,
                    street, postal_code, city, country, short_info, notes
             FROM contacts
             WHERE deleted_at IS NULL",
        )
        .map_err(|err| err.to_string())?;
    let rows = stmt
        .query_map([], |row| {
            Ok(ContactInput {
                id: None,
                first_name: row.get(0)?,
                last_name: row.get(1)?,
                display_name: row.get(2)?,
                email: row.get(3)?,
                phone: row.get(4)?,
                mobile_phone: row.get(5)?,
                street: row.get(6)?,
                postal_code: row.get(7)?,
                city: row.get(8)?,
                country: row.get(9)?,
                short_info: row.get(10)?,
                notes: row.get(11)?,
                group_ids: Vec::new(),
            })
        })
        .map_err(|err| err.to_string())?;
    let mut fingerprints = ContactFingerprintIndex::default();
    for row in rows {
        let contact = row.map_err(|err| err.to_string())?;
        let display_name = normalize_contact_display_name(&contact);
        let email = contact.email.trim().to_lowercase();
        add_fingerprint(&mut fingerprints, &contact, &display_name, &email);
    }
    Ok(fingerprints)
}

fn classify_outlook_contact(
    fingerprints: &ContactFingerprintIndex,
    contact: &ContactInput,
    display_name: &str,
    email: &str,
) -> (String, String, Option<String>) {
    let exact_key = contact_exact_key(contact, display_name, email);
    if let Some(existing_name) = fingerprints.exact_contacts.get(&exact_key) {
        return (
            "duplicate_exact".to_string(),
            "Alle Kontaktfelder sind zu 100 % identisch.".to_string(),
            Some(existing_name.clone()),
        );
    }

    if !email.is_empty() {
        if let Some(existing_name) = fingerprints.emails.get(email) {
            return (
                "different".to_string(),
                "Gleiche E-Mail-Adresse, aber mindestens ein anderes Kontaktfeld. Beide Kontakte bleiben erhalten.".to_string(),
                Some(existing_name.clone()),
            );
        }
    }

    let phone_keys = contact_phone_keys(contact);
    if !phone_keys.is_empty() {
        if let Some(existing_name) = phone_keys
            .iter()
            .find_map(|phone| fingerprints.phones.get(phone))
        {
            return (
                "different".to_string(),
                "Gleiche Telefonnummer, aber mindestens ein anderes Kontaktfeld. Beide Kontakte bleiben erhalten.".to_string(),
                Some(existing_name.clone()),
            );
        }
    }

    let normalized_name = display_name.trim().to_lowercase();
    if email.is_empty() && !normalized_name.is_empty() {
        if let Some(existing_name) = fingerprints.names.get(&normalized_name) {
            return (
                "different".to_string(),
                "Gleicher Name, aber mindestens ein anderes Kontaktfeld. Beide Kontakte bleiben erhalten.".to_string(),
                Some(existing_name.clone()),
            );
        }
    }

    ("new".to_string(), "Neuer Kontakt".to_string(), None)
}

fn classify_outlook_import_record(
    fingerprints: &ContactFingerprintIndex,
    record: &OutlookContactRecord,
    contact: &ContactInput,
    display_name: &str,
    email: &str,
) -> (String, String, Option<String>) {
    if is_outlook_autocomplete_record(record) && !email.is_empty() {
        if let Some(existing_name) = fingerprints.emails.get(email) {
            return (
                "duplicate_exact".to_string(),
                "Diese E-Mail-Adresse ist bereits als Kontakt oder Autovervollständigungseintrag vorhanden."
                    .to_string(),
                Some(existing_name.clone()),
            );
        }
    }
    classify_outlook_contact(fingerprints, contact, display_name, email)
}

fn add_fingerprint(
    fingerprints: &mut ContactFingerprintIndex,
    contact: &ContactInput,
    display_name: &str,
    email: &str,
) {
    let label = display_name.trim().to_string();
    fingerprints
        .exact_contacts
        .entry(contact_exact_key(contact, display_name, email))
        .or_insert_with(|| label.clone());
    if !email.is_empty() {
        fingerprints
            .emails
            .entry(email.to_string())
            .or_insert_with(|| label.clone());
    }
    for phone in contact_phone_keys(contact) {
        fingerprints
            .phones
            .entry(phone)
            .or_insert_with(|| label.clone());
    }
    let normalized_name = display_name.trim().to_lowercase();
    if !normalized_name.is_empty() {
        fingerprints.names.entry(normalized_name).or_insert(label);
    }
}

fn preview_outlook_classic_contacts_blocking(
    app: AppHandle,
    clean_imported_names: bool,
) -> Result<OutlookContactImportPreview, String> {
    let (read_result, warnings) = read_outlook_classic_contacts_for_import()?;
    let conn = open_db(&app)?;
    let mut fingerprints = load_contact_fingerprints(&conn)?;
    let mut sources: Vec<OutlookContactSourcePreview> = Vec::new();
    let mut source_indexes: HashMap<String, usize> = HashMap::new();
    let mut contacts = Vec::new();
    let mut skipped_invalid = read_result.skipped;

    for record in &read_result.contacts {
        let mut contact = outlook_record_to_contact(record);
        if clean_imported_names {
            clean_imported_contact_name(&mut contact);
        }
        let display_name = normalize_contact_display_name(&contact);
        let email = contact.email.trim().to_lowercase();
        if !contact_has_identity(&contact, &display_name, &email) {
            skipped_invalid += 1;
            continue;
        }

        let source_id = outlook_source_id(record);
        let source_index = if let Some(index) = source_indexes.get(&source_id) {
            *index
        } else {
            let store_name = outlook_store_name(record);
            let index = sources.len();
            sources.push(OutlookContactSourcePreview {
                id: source_id.clone(),
                kind: if is_outlook_autocomplete_record(record) {
                    "autocomplete".to_string()
                } else {
                    "contacts".to_string()
                },
                store_name: store_name.clone(),
                folder_path: if record.folder_path.trim().is_empty() {
                    "Kontakte".to_string()
                } else {
                    record.folder_path.trim().to_string()
                },
                suggested_group_name: suggested_outlook_group_name(&record.folder_path),
                total: 0,
                new_contacts: 0,
                exact_duplicates: 0,
                conflicts: 0,
                without_email: 0,
            });
            source_indexes.insert(source_id.clone(), index);
            index
        };

        let (status, reason, existing_name) =
            classify_outlook_import_record(&fingerprints, record, &contact, &display_name, &email);
        let source = &mut sources[source_index];
        source.total += 1;
        if email.is_empty() {
            source.without_email += 1;
        }
        match status.as_str() {
            "new" => source.new_contacts += 1,
            "duplicate_exact" => source.exact_duplicates += 1,
            _ => source.conflicts += 1,
        }

        contacts.push(OutlookContactPreviewItem {
            id: outlook_contact_id(record),
            source_id,
            display_name: display_name.clone(),
            email: email.clone(),
            phone: if contact.mobile_phone.trim().is_empty() {
                contact.phone.trim().to_string()
            } else {
                contact.mobile_phone.trim().to_string()
            },
            city: contact.city.trim().to_string(),
            default_selected: status != "duplicate_exact",
            status,
            reason,
            existing_name,
        });
        add_fingerprint(&mut fingerprints, &contact, &display_name, &email);
    }

    sources.sort_by(|left, right| {
        left.store_name
            .to_lowercase()
            .cmp(&right.store_name.to_lowercase())
            .then_with(|| {
                left.folder_path
                    .to_lowercase()
                    .cmp(&right.folder_path.to_lowercase())
            })
    });

    let preview = OutlookContactImportPreview {
        found: read_result.contacts.len(),
        skipped_invalid,
        warnings,
        sources,
        contacts,
    };
    cache_outlook_contacts(&app, read_result);
    Ok(preview)
}

#[tauri::command]
async fn preview_outlook_classic_contacts(
    app: AppHandle,
    clean_imported_names: bool,
) -> Result<OutlookContactImportPreview, String> {
    tauri::async_runtime::spawn_blocking(move || {
        preview_outlook_classic_contacts_blocking(app, clean_imported_names)
    })
        .await
        .map_err(|error| format!("Outlook-Kontaktprüfung wurde unerwartet beendet: {error}"))?
}

fn import_selected_outlook_classic_contacts_blocking(
    app: AppHandle,
    request: OutlookContactImportRequest,
) -> Result<OutlookContactImportResult, String> {
    let selected_sources: HashSet<String> = request.selected_source_ids.into_iter().collect();
    if selected_sources.is_empty() {
        return Err("Bitte wählen Sie mindestens eine Outlook-Quelle aus.".to_string());
    }
    let read_result = match take_cached_outlook_contacts(&app) {
        Some(cached) => cached,
        None => read_outlook_classic_contacts_for_import()?.0,
    };
    let mut conn = open_db(&app)?;
    let mut fingerprints = load_contact_fingerprints(&conn)?;
    let tx = conn.transaction().map_err(|err| err.to_string())?;
    let timestamp = now();
    let batch_id = format!("outlook-reviewed-{}", Utc::now().timestamp_millis());
    let mut imported = 0usize;
    let mut found = 0usize;
    let mut skipped_exact_duplicates = 0usize;
    let skipped_conflicts = 0usize;
    let mut skipped_invalid = read_result.skipped;
    let mut group_ids: HashMap<String, i64> = HashMap::new();

    for record in &read_result.contacts {
        let source_id = outlook_source_id(record);
        if !selected_sources.contains(&source_id) {
            continue;
        }
        found += 1;
        let mut contact = outlook_record_to_contact(record);
        if request.clean_imported_names {
            clean_imported_contact_name(&mut contact);
        }
        let display_name = normalize_contact_display_name(&contact);
        let email = contact.email.trim().to_lowercase();
        if !contact_has_identity(&contact, &display_name, &email) {
            skipped_invalid += 1;
            continue;
        }

        let (status, _, _) =
            classify_outlook_import_record(&fingerprints, record, &contact, &display_name, &email);
        if status == "duplicate_exact" {
            skipped_exact_duplicates += 1;
            continue;
        }

        tx.execute(
            "
            INSERT INTO contacts (
                first_name, last_name, display_name, email, phone, mobile_phone, street,
                postal_code, city, country, short_info, notes, import_batch_id,
                created_at, updated_at, outlook_entry_id, outlook_store_id
            )
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            ",
            params![
                contact.first_name,
                contact.last_name,
                display_name,
                email,
                contact.phone,
                contact.mobile_phone,
                contact.street,
                contact.postal_code,
                contact.city,
                contact.country,
                contact.short_info,
                contact.notes,
                batch_id,
                timestamp,
                timestamp,
                record.entry_id.trim(),
                record.store_id.trim()
            ],
        )
        .map_err(|err| err.to_string())?;
        let local_contact_id = tx.last_insert_rowid();

        if request.create_source_groups {
            let store_name = outlook_store_name(record);
            let group_name = suggested_outlook_group_name(&record.folder_path);
            let group_id = if let Some(group_id) = group_ids.get(&group_name) {
                *group_id
            } else {
                tx.execute(
                    "INSERT INTO groups (name, description, created_at, updated_at, deleted_at)
                     VALUES (?, ?, ?, ?, NULL)
                     ON CONFLICT(name) DO UPDATE SET
                       description = excluded.description,
                       updated_at = excluded.updated_at,
                       deleted_at = NULL",
                    params![
                        group_name,
                        if is_outlook_autocomplete_record(record) {
                            "Frühere Empfänger aus der Outlook-Classic-Autovervollständigung"
                                .to_string()
                        } else {
                            format!("Einmaliger Kontaktimport aus Outlook Classic: {store_name}")
                        },
                        timestamp,
                        timestamp
                    ],
                )
                .map_err(|err| err.to_string())?;
                let group_id: i64 = tx
                    .query_row(
                        "SELECT id FROM groups WHERE name = ?",
                        params![group_name],
                        |row| row.get(0),
                    )
                    .map_err(|err| err.to_string())?;
                group_ids.insert(group_name, group_id);
                group_id
            };
            tx.execute(
                "INSERT OR IGNORE INTO contact_groups (contact_id, group_id) VALUES (?, ?)",
                params![local_contact_id, group_id],
            )
            .map_err(|err| err.to_string())?;
        }

        add_fingerprint(&mut fingerprints, &contact, &display_name, &email);
        imported += 1;
    }

    if imported > 0 {
        tx.execute(
            "INSERT INTO import_history (batch_id, source_file, imported_count, skipped_count, created_at)
             VALUES (?, ?, ?, ?, ?)",
            params![
                batch_id,
                "Outlook Classic (geprüfter Kontaktimport)",
                imported as i64,
                (skipped_exact_duplicates + skipped_conflicts + skipped_invalid) as i64,
                timestamp
            ],
        )
        .map_err(|err| err.to_string())?;
    }
    tx.commit().map_err(|err| err.to_string())?;

    Ok(OutlookContactImportResult {
        found,
        imported,
        skipped_exact_duplicates,
        skipped_conflicts,
        skipped_invalid,
        groups_used: group_ids.len(),
        batch_id: if imported > 0 {
            batch_id
        } else {
            String::new()
        },
    })
}

#[tauri::command]
async fn import_selected_outlook_classic_contacts(
    app: AppHandle,
    request: OutlookContactImportRequest,
) -> Result<OutlookContactImportResult, String> {
    tauri::async_runtime::spawn_blocking(move || {
        import_selected_outlook_classic_contacts_blocking(app, request)
    })
    .await
    .map_err(|error| format!("Outlook-Kontaktimport wurde unerwartet beendet: {error}"))?
}

fn load_local_outlook_contacts(conn: &Connection) -> Result<Vec<LocalOutlookContact>, String> {
    let mut stmt = conn
        .prepare(
            "
            SELECT id, first_name, last_name, display_name, email, phone, mobile_phone,
                   street, postal_code, city, country, short_info, notes,
                   outlook_entry_id, outlook_store_id
            FROM contacts
            WHERE deleted_at IS NULL
            ORDER BY updated_at ASC
            ",
        )
        .map_err(|err| err.to_string())?;

    let rows = stmt
        .query_map([], |row| {
            Ok(LocalOutlookContact {
                id: row.get(0)?,
                first_name: row.get(1)?,
                last_name: row.get(2)?,
                display_name: row.get(3)?,
                email: row.get(4)?,
                phone: row.get(5)?,
                mobile_phone: row.get(6)?,
                street: row.get(7)?,
                postal_code: row.get(8)?,
                city: row.get(9)?,
                country: row.get(10)?,
                short_info: row.get(11)?,
                notes: row.get(12)?,
                groups: Vec::new(),
                outlook_entry_id: row.get(13)?,
                outlook_store_id: row.get(14)?,
            })
        })
        .map_err(|err| err.to_string())?;

    let mut contacts = rows
        .collect::<Result<Vec<_>, _>>()
        .map_err(|err| err.to_string())?;
    for contact in &mut contacts {
        contact.groups = read_groups_for_contact(conn, contact.id)?
            .into_iter()
            .map(|group| group.name)
            .collect();
    }
    Ok(contacts)
}

fn load_local_outlook_group_names(conn: &Connection) -> Result<Vec<String>, String> {
    let mut statement = conn
        .prepare(
            "SELECT name FROM groups WHERE deleted_at IS NULL ORDER BY name COLLATE NOCASE",
        )
        .map_err(|error| error.to_string())?;
    let database_names = statement
        .query_map([], |row| row.get(0))
        .map_err(|error| error.to_string())?
        .collect::<Result<Vec<String>, _>>()
        .map_err(|error| error.to_string())?;
    let mut names = vec!["Gesammelte Adressen".to_string()];
    names.extend(database_names.into_iter().filter(|name| {
        !name.trim().eq_ignore_ascii_case("Gesammelte Adressen")
    }));
    Ok(names)
}

fn load_local_outlook_contact(
    conn: &Connection,
    id: i64,
) -> Result<Option<LocalOutlookContact>, String> {
    conn.query_row(
        "
        SELECT id, first_name, last_name, display_name, email, phone, mobile_phone,
               street, postal_code, city, country, short_info, notes,
               outlook_entry_id, outlook_store_id
        FROM contacts
        WHERE id = ?
        ",
        params![id],
        |row| {
            Ok(LocalOutlookContact {
                id: row.get(0)?,
                first_name: row.get(1)?,
                last_name: row.get(2)?,
                display_name: row.get(3)?,
                email: row.get(4)?,
                phone: row.get(5)?,
                mobile_phone: row.get(6)?,
                street: row.get(7)?,
                postal_code: row.get(8)?,
                city: row.get(9)?,
                country: row.get(10)?,
                short_info: row.get(11)?,
                notes: row.get(12)?,
                groups: Vec::new(),
                outlook_entry_id: row.get(13)?,
                outlook_store_id: row.get(14)?,
            })
        },
    )
    .optional()
    .map_err(|err| err.to_string())?
    .map(|mut contact| {
        contact.groups = read_groups_for_contact(conn, contact.id)?
            .into_iter()
            .map(|group| group.name)
            .collect();
        Ok(contact)
    })
    .transpose()
}

fn delete_local_contact_from_outlook(conn: &Connection, id: i64) -> Result<bool, String> {
    let Some(contact) = load_local_outlook_contact(conn, id)? else {
        return Ok(false);
    };

    let json = serde_json::to_string(&contact).map_err(|err| err.to_string())?;
    let json_path = env::temp_dir().join(format!(
        "agendakontakte-outlook-delete-{}.json",
        Utc::now().timestamp_millis()
    ));
    fs::write(&json_path, json).map_err(|err| err.to_string())?;
    let escaped_path = json_path.to_string_lossy().replace('\'', "''");
    let script = format!(
        r#"
$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
$contactPath = '{escaped_path}'
$local = Get-Content -LiteralPath $contactPath -Raw -Encoding UTF8 | ConvertFrom-Json
$outlook = New-Object -ComObject Outlook.Application
$namespace = $outlook.Session
$contactsFolder = $namespace.GetDefaultFolder(10)

function Get-Scalar($value) {{
  if ($null -eq $value) {{ return '' }}
  if ($value -is [System.Array]) {{
    if ($value.Count -eq 0) {{ return '' }}
    return $value[0]
  }}
  return $value
}}

function Get-Contact-Email($item) {{
  $email = [string]$item.Email1Address
  try {{
    $smtp = [string]$item.PropertyAccessor.GetProperty('http://schemas.microsoft.com/mapi/proptag/0x39FE001E')
    if (-not [string]::IsNullOrWhiteSpace($smtp)) {{ $email = $smtp }}
  }} catch {{}}
  if ([string]::IsNullOrWhiteSpace($email)) {{ $email = [string]$item.Email2Address }}
  if ([string]::IsNullOrWhiteSpace($email)) {{ $email = [string]$item.Email3Address }}
  return $email
}}

function Read-Contact-Folders($folder, $items) {{
  try {{
    $folderItems = $folder.Items
    for ($index = 1; $index -le $folderItems.Count; $index++) {{
      try {{
        $item = $folderItems.Item($index)
        if ([string]$item.MessageClass -like 'IPM.Contact*') {{ $items.Add($item) | Out-Null }}
      }} catch {{}}
    }}
  }} catch {{}}
  foreach ($child in @($folder.Folders)) {{ Read-Contact-Folders $child $items }}
}}

function Find-Outlook-Contact($local, $allContacts) {{
  $entryId = [string](Get-Scalar $local.outlookEntryId)
  $storeId = [string](Get-Scalar $local.outlookStoreId)
  if (-not [string]::IsNullOrWhiteSpace($entryId)) {{
    try {{
      if (-not [string]::IsNullOrWhiteSpace($storeId)) {{ return $namespace.GetItemFromID($entryId, $storeId) }}
      return $namespace.GetItemFromID($entryId)
    }} catch {{}}
  }}

  $email = ([string](Get-Scalar $local.email)).Trim().ToLowerInvariant()
  $name = ([string](Get-Scalar $local.displayName)).Trim().ToLowerInvariant()
  if ([string]::IsNullOrWhiteSpace($name)) {{ $name = (([string](Get-Scalar $local.firstName) + ' ' + [string](Get-Scalar $local.lastName)).Trim()).ToLowerInvariant() }}
  $phone = ([string](Get-Scalar $local.phone)).Trim()
  $mobile = ([string](Get-Scalar $local.mobilePhone)).Trim()
  $city = ([string](Get-Scalar $local.city)).Trim().ToLowerInvariant()
  $nameMatches = New-Object System.Collections.Generic.List[object]

  foreach ($item in $allContacts.ToArray()) {{
    try {{
      if (-not [string]::IsNullOrWhiteSpace($email) -and (Get-Contact-Email $item).Trim().ToLowerInvariant() -eq $email) {{ return $item }}
      $itemName = ([string]$item.FullName).Trim().ToLowerInvariant()
      if ([string]::IsNullOrWhiteSpace($itemName)) {{ $itemName = (([string]$item.FirstName + ' ' + [string]$item.LastName).Trim()).ToLowerInvariant() }}
      if (-not [string]::IsNullOrWhiteSpace($name) -and $itemName -eq $name) {{
        $nameMatches.Add($item) | Out-Null
        if ((-not [string]::IsNullOrWhiteSpace($phone) -and [string]$item.BusinessTelephoneNumber -eq $phone) -or
            (-not [string]::IsNullOrWhiteSpace($mobile) -and [string]$item.MobileTelephoneNumber -eq $mobile) -or
            ([string]::IsNullOrWhiteSpace($phone) -and [string]::IsNullOrWhiteSpace($mobile) -and ([string]$item.BusinessAddressCity).Trim().ToLowerInvariant() -eq $city)) {{
          return $item
        }}
      }}
    }} catch {{}}
  }}
  if ($nameMatches.Count -eq 1) {{ return $nameMatches[0] }}
  return $null
}}

$allContacts = New-Object System.Collections.ArrayList
Read-Contact-Folders $contactsFolder $allContacts
$item = Find-Outlook-Contact $local $allContacts
if ($null -ne $item) {{
  $item.Delete()
  [pscustomobject]@{{ deleted = $true }} | ConvertTo-Json -Compress
}} else {{
  [pscustomobject]@{{ deleted = $false }} | ConvertTo-Json -Compress
}}
"#
    );

    let output = hidden_command("powershell")
        .args([
            "-NoProfile",
            "-ExecutionPolicy",
            "Bypass",
            "-Command",
            script.as_str(),
        ])
        .output()
        .map_err(|err| format!("Outlook Classic konnte nicht aktualisiert werden: {err}"));

    let _ = fs::remove_file(&json_path);
    let output = output?;

    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        return Err(format!(
            "Outlook Classic konnte den Kontakt nicht löschen. {stderr}"
        ));
    }

    let stdout = String::from_utf8_lossy(&output.stdout);
    Ok(stdout.contains("true"))
}

fn push_local_contacts_to_outlook(
    conn: &mut Connection,
    target_email: Option<&str>,
) -> Result<OutlookPushResult, String> {
    let contacts = load_local_outlook_contacts(conn)?;
    let groups = load_local_outlook_group_names(conn)?;
    if contacts.is_empty() && groups.is_empty() {
        return Ok(OutlookPushResult {
            total: 0,
            created: 0,
            updated: 0,
            linked: 0,
            contact_copies: 0,
            folders_created: 0,
            folders_used: 0,
            errors: 0,
            autocomplete_resolved: 0,
            autocomplete_errors: 0,
            folder_path: String::new(),
            store_name: String::new(),
        });
    }

    let contact_total = contacts.len();
    let payload = LocalOutlookExportPayload { contacts, groups };
    let json = serde_json::to_string(&payload).map_err(|err| err.to_string())?;
    let json_path = env::temp_dir().join(format!(
        "agendakontakte-outlook-sync-{}.json",
        Utc::now().timestamp_millis()
    ));
    fs::write(&json_path, json).map_err(|err| err.to_string())?;
    let escaped_path = json_path.to_string_lossy().replace('\'', "''");
    let target_email = powershell_single_quote(target_email.unwrap_or_default().trim());
    let script = format!(
        r#"
$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
$contactsPath = '{escaped_path}'
$targetEmail = {target_email}
$payload = Get-Content -LiteralPath $contactsPath -Raw -Encoding UTF8 | ConvertFrom-Json
$localContacts = @($payload.contacts | ForEach-Object {{ $_ }})
$localGroups = @($payload.groups | ForEach-Object {{ [string]$_ }})
$outlook = New-Object -ComObject Outlook.Application
$namespace = $outlook.Session
$targetAccount = $null
$contactsFolder = $null
if (-not [string]::IsNullOrWhiteSpace($targetEmail)) {{
  for ($accountIndex = 1; $accountIndex -le $namespace.Accounts.Count; $accountIndex++) {{
    $candidate = $namespace.Accounts.Item($accountIndex)
    if (([string]$candidate.SmtpAddress).Trim().ToLowerInvariant() -eq $targetEmail.Trim().ToLowerInvariant()) {{
      $targetAccount = $candidate
      try {{ $contactsFolder = $candidate.DeliveryStore.GetDefaultFolder(10) }} catch {{}}
      break
    }}
  }}
  if ($null -eq $targetAccount) {{ throw "Das Outlook-IMAP-Konto '$targetEmail' wurde im aktuellen Outlook-Profil nicht gefunden." }}
}}
if ($null -eq $contactsFolder) {{ $contactsFolder = $namespace.GetDefaultFolder(10) }}
$links = New-Object System.Collections.Generic.List[object]
$autocompleteCandidates = [System.Collections.Generic.HashSet[string]]::new([System.StringComparer]::OrdinalIgnoreCase)
$createdCount = 0
$updatedCount = 0
$contactCopyCount = 0
$foldersCreatedCount = 0
$errorCount = 0
$autocompleteResolvedCount = 0
$autocompleteErrorCount = 0
$storeName = ''
try {{ $storeName = [string]$contactsFolder.Store.DisplayName }} catch {{}}
$folderCache = @{{}}
$folderItemsCache = @{{}}

function Read-Contact-Folder-Only($folder) {{
  $items = New-Object System.Collections.ArrayList
  try {{
    $folderItems = $folder.Items
    for ($index = 1; $index -le $folderItems.Count; $index++) {{
      try {{
        $item = $folderItems.Item($index)
        if ([string]$item.MessageClass -like 'IPM.Contact*') {{ $items.Add($item) | Out-Null }}
      }} catch {{}}
    }}
  }} catch {{}}
  return ,$items
}}

function Get-OrCreate-Contact-Folder($folderName) {{
  $name = ([string]$folderName).Trim()
  if ([string]::IsNullOrWhiteSpace($name)) {{ return $contactsFolder }}
  $cacheKey = $name.ToLowerInvariant()
  if ($folderCache.ContainsKey($cacheKey)) {{ return $folderCache[$cacheKey] }}

  $folder = $null
  foreach ($child in @($contactsFolder.Folders)) {{
    try {{
      if (([string]$child.Name).Trim().ToLowerInvariant() -eq $cacheKey) {{
        $folder = $child
        break
      }}
    }} catch {{}}
  }}
  if ($null -eq $folder) {{
    $folder = $contactsFolder.Folders.Add($name)
    $script:foldersCreatedCount++
  }}
  $folderCache[$cacheKey] = $folder
  return $folder
}}

function Get-Cached-Folder-Contacts($folder) {{
  $cacheKey = [string]$folder.EntryID
  if ($folderItemsCache.ContainsKey($cacheKey)) {{ return ,$folderItemsCache[$cacheKey] }}
  $items = Read-Contact-Folder-Only $folder
  $folderItemsCache[$cacheKey] = $items
  return ,$items
}}

function Find-Outlook-Contact-In-Folder($local, $allContacts, $destinationFolder) {{
  $entryId = [string](Get-Scalar $local.outlookEntryId)
  $storeId = [string](Get-Scalar $local.outlookStoreId)
  if (-not [string]::IsNullOrWhiteSpace($entryId)) {{
    try {{
      $linkedItem = if (-not [string]::IsNullOrWhiteSpace($storeId)) {{ $namespace.GetItemFromID($entryId, $storeId) }} else {{ $namespace.GetItemFromID($entryId) }}
      if ([string]$linkedItem.Parent.EntryID -eq [string]$destinationFolder.EntryID) {{ return $linkedItem }}
    }} catch {{}}
  }}

  $email = ([string](Get-Scalar $local.email)).Trim().ToLowerInvariant()
  $name = ([string](Get-Scalar $local.displayName)).Trim().ToLowerInvariant()
  if ([string]::IsNullOrWhiteSpace($name)) {{ $name = (([string](Get-Scalar $local.firstName) + ' ' + [string](Get-Scalar $local.lastName)).Trim()).ToLowerInvariant() }}
  $phone = ([string](Get-Scalar $local.phone)).Trim()
  $mobile = ([string](Get-Scalar $local.mobilePhone)).Trim()
  $city = ([string](Get-Scalar $local.city)).Trim().ToLowerInvariant()
  $nameMatches = New-Object System.Collections.Generic.List[object]

  foreach ($item in $allContacts.ToArray()) {{
    try {{
      if (-not [string]::IsNullOrWhiteSpace($email) -and (Get-Contact-Email $item).Trim().ToLowerInvariant() -eq $email) {{ return $item }}
      $itemName = ([string]$item.FullName).Trim().ToLowerInvariant()
      if ([string]::IsNullOrWhiteSpace($itemName)) {{ $itemName = (([string]$item.FirstName + ' ' + [string]$item.LastName).Trim()).ToLowerInvariant() }}
      if (-not [string]::IsNullOrWhiteSpace($name) -and $itemName -eq $name) {{
        $nameMatches.Add($item) | Out-Null
        if ((-not [string]::IsNullOrWhiteSpace($phone) -and [string]$item.BusinessTelephoneNumber -eq $phone) -or
            (-not [string]::IsNullOrWhiteSpace($mobile) -and [string]$item.MobileTelephoneNumber -eq $mobile) -or
            ([string]::IsNullOrWhiteSpace($phone) -and [string]::IsNullOrWhiteSpace($mobile) -and ([string]$item.BusinessAddressCity).Trim().ToLowerInvariant() -eq $city)) {{
          return $item
        }}
      }}
    }} catch {{}}
  }}
  if ($nameMatches.Count -eq 1) {{ return $nameMatches[0] }}
  return $null
}}

function Get-Scalar($value) {{
  if ($null -eq $value) {{ return '' }}
  if ($value -is [System.Array]) {{
    if ($value.Count -eq 0) {{ return '' }}
    return $value[0]
  }}
  return $value
}}

function Get-Contact-Email($item) {{
  $email = [string]$item.Email1Address
  try {{
    $smtp = [string]$item.PropertyAccessor.GetProperty('http://schemas.microsoft.com/mapi/proptag/0x39FE001E')
    if (-not [string]::IsNullOrWhiteSpace($smtp)) {{ $email = $smtp }}
  }} catch {{}}
  if ([string]::IsNullOrWhiteSpace($email)) {{ $email = [string]$item.Email2Address }}
  if ([string]::IsNullOrWhiteSpace($email)) {{ $email = [string]$item.Email3Address }}
  return $email
}}

function Read-Contact-Folders($folder, $items) {{
  try {{
    $folderItems = $folder.Items
    for ($index = 1; $index -le $folderItems.Count; $index++) {{
      try {{
        $item = $folderItems.Item($index)
        if ([string]$item.MessageClass -like 'IPM.Contact*') {{ $items.Add($item) | Out-Null }}
      }} catch {{}}
    }}
  }} catch {{}}
  foreach ($child in @($folder.Folders)) {{ Read-Contact-Folders $child $items }}
}}

function Find-Outlook-Contact($local, $allContacts) {{
  $entryId = [string](Get-Scalar $local.outlookEntryId)
  $storeId = [string](Get-Scalar $local.outlookStoreId)
  if (-not [string]::IsNullOrWhiteSpace($entryId)) {{
    try {{
      if (-not [string]::IsNullOrWhiteSpace($storeId)) {{ return $namespace.GetItemFromID($entryId, $storeId) }}
      return $namespace.GetItemFromID($entryId)
    }} catch {{}}
  }}

  $email = ([string](Get-Scalar $local.email)).Trim().ToLowerInvariant()
  $name = ([string](Get-Scalar $local.displayName)).Trim().ToLowerInvariant()
  if ([string]::IsNullOrWhiteSpace($name)) {{ $name = (([string](Get-Scalar $local.firstName) + ' ' + [string](Get-Scalar $local.lastName)).Trim()).ToLowerInvariant() }}
  $phone = ([string](Get-Scalar $local.phone)).Trim()
  $mobile = ([string](Get-Scalar $local.mobilePhone)).Trim()
  $city = ([string](Get-Scalar $local.city)).Trim().ToLowerInvariant()
  $nameMatches = New-Object System.Collections.Generic.List[object]

  foreach ($item in $allContacts.ToArray()) {{
    try {{
      if (-not [string]::IsNullOrWhiteSpace($email) -and (Get-Contact-Email $item).Trim().ToLowerInvariant() -eq $email) {{ return $item }}
      $itemName = ([string]$item.FullName).Trim().ToLowerInvariant()
      if ([string]::IsNullOrWhiteSpace($itemName)) {{ $itemName = (([string]$item.FirstName + ' ' + [string]$item.LastName).Trim()).ToLowerInvariant() }}
      if (-not [string]::IsNullOrWhiteSpace($name) -and $itemName -eq $name) {{
        $nameMatches.Add($item) | Out-Null
        if ((-not [string]::IsNullOrWhiteSpace($phone) -and [string]$item.BusinessTelephoneNumber -eq $phone) -or
            (-not [string]::IsNullOrWhiteSpace($mobile) -and [string]$item.MobileTelephoneNumber -eq $mobile) -or
            ([string]::IsNullOrWhiteSpace($phone) -and [string]::IsNullOrWhiteSpace($mobile) -and ([string]$item.BusinessAddressCity).Trim().ToLowerInvariant() -eq $city)) {{
          return $item
        }}
      }}
    }} catch {{}}
  }}
  if ($nameMatches.Count -eq 1) {{ return $nameMatches[0] }}
  return $null
}}

function Set-When-Present($item, $property, $value) {{
  $text = [string](Get-Scalar $value)
  if (-not [string]::IsNullOrWhiteSpace($text)) {{ $item.$property = $text }}
}}

foreach ($groupName in $localGroups) {{
  if ([string]::IsNullOrWhiteSpace(([string]$groupName).Trim())) {{ continue }}
  try {{ Get-OrCreate-Contact-Folder $groupName | Out-Null }} catch {{ $errorCount++ }}
}}

foreach ($local in $localContacts) {{
  $groupNames = New-Object System.Collections.Generic.List[string]
  $seenGroupNames = [System.Collections.Generic.HashSet[string]]::new([System.StringComparer]::OrdinalIgnoreCase)
  foreach ($rawGroupName in @($local.groups)) {{
    $groupName = ([string]$rawGroupName).Trim()
    if (-not [string]::IsNullOrWhiteSpace($groupName) -and $seenGroupNames.Add($groupName)) {{
      $groupNames.Add($groupName) | Out-Null
    }}
  }}

  $destinations = New-Object System.Collections.Generic.List[object]
  if ($groupNames.Count -eq 0) {{
    try {{ $destinations.Add((Get-OrCreate-Contact-Folder 'Gesammelte Adressen')) | Out-Null }} catch {{ $errorCount++ }}
  }} else {{
    foreach ($groupName in $groupNames) {{
      try {{ $destinations.Add((Get-OrCreate-Contact-Folder $groupName)) | Out-Null }} catch {{ $errorCount++ }}
    }}
  }}

  $linkRecorded = $false
  $exportedContact = $false
  foreach ($destination in $destinations) {{
    try {{
      $allContacts = Get-Cached-Folder-Contacts $destination
      $item = Find-Outlook-Contact-In-Folder $local $allContacts $destination
      if ($null -eq $item) {{
        $item = $destination.Items.Add(2)
        $allContacts.Add($item) | Out-Null
        $createdCount++
      }} else {{
        $updatedCount++
      }}

      Set-When-Present $item 'FirstName' $local.firstName
      Set-When-Present $item 'LastName' $local.lastName
      Set-When-Present $item 'FullName' $local.displayName
      Set-When-Present $item 'Email1Address' $local.email
      Set-When-Present $item 'BusinessTelephoneNumber' $local.phone
      Set-When-Present $item 'MobileTelephoneNumber' $local.mobilePhone
      Set-When-Present $item 'BusinessAddressStreet' $local.street
      Set-When-Present $item 'BusinessAddressPostalCode' $local.postalCode
      Set-When-Present $item 'BusinessAddressCity' $local.city
      Set-When-Present $item 'BusinessAddressCountry' $local.country
      Set-When-Present $item 'Body' $local.notes
      $item.Save()
      $contactCopyCount++
      $exportedContact = $true

      if (-not $linkRecorded) {{
        $links.Add([pscustomobject]@{{
          localId = [string](Get-Scalar $local.id)
          entryId = [string]$item.EntryID
          storeId = [string]$destination.StoreID
        }}) | Out-Null
        $linkRecorded = $true
      }}
    }} catch {{
      $errorCount++
    }}
  }}

  if ($exportedContact) {{
    $autocompleteEmail = ([string](Get-Scalar $local.email)).Trim()
    if (-not [string]::IsNullOrWhiteSpace($autocompleteEmail)) {{
      $autocompleteCandidates.Add($autocompleteEmail) | Out-Null
    }}
  }}
}}

# Resolve every address through Outlook itself. This seeds Outlook's in-memory
# recipient suggestions without sending or saving a message. Outlook persists
# changes to its autocomplete stream when it closes normally.
if ($autocompleteCandidates.Count -gt 0) {{
  $suggestionDraft = $null
  try {{
    $suggestionDraft = $outlook.CreateItem(0)
    if ($null -ne $targetAccount) {{ $suggestionDraft.SendUsingAccount = $targetAccount }}
    foreach ($autocompleteEmail in $autocompleteCandidates) {{
      try {{
        $recipient = $suggestionDraft.Recipients.Add($autocompleteEmail)
        if ($recipient.Resolve()) {{ $autocompleteResolvedCount++ }} else {{ $autocompleteErrorCount++ }}
        if ($suggestionDraft.Recipients.Count -gt 0) {{ $suggestionDraft.Recipients.Remove(1) }}
      }} catch {{
        $autocompleteErrorCount++
        try {{ if ($suggestionDraft.Recipients.Count -gt 0) {{ $suggestionDraft.Recipients.Remove(1) }} }} catch {{}}
      }}
    }}
  }} catch {{
    $autocompleteErrorCount += $autocompleteCandidates.Count
  }} finally {{
    if ($null -ne $suggestionDraft) {{ try {{ $suggestionDraft.Close(1) }} catch {{}} }}
  }}
}}

[pscustomobject]@{{
  links = $links
  created = $createdCount
  updated = $updatedCount
  contactCopies = $contactCopyCount
  foldersCreated = $foldersCreatedCount
  foldersUsed = $folderCache.Count
  errors = $errorCount
  autocompleteResolved = $autocompleteResolvedCount
  autocompleteErrors = $autocompleteErrorCount
  folderPath = [string]$contactsFolder.FolderPath
  storeName = $storeName
}} | ConvertTo-Json -Depth 5 -Compress
"#
    );

    let output = hidden_command("powershell")
        .args([
            "-NoProfile",
            "-ExecutionPolicy",
            "Bypass",
            "-Command",
            script.as_str(),
        ])
        .output()
        .map_err(|err| format!("Outlook Classic konnte nicht aktualisiert werden: {err}"));

    let _ = fs::remove_file(&json_path);
    let output = output?;

    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        return Err(format!(
            "Outlook Classic konnte nicht aktualisiert werden. {stderr}"
        ));
    }

    let stdout = String::from_utf8_lossy(&output.stdout);
    let data = serde_json::from_str::<OutlookPushData>(stdout.trim()).map_err(|err| {
        format!("Outlook-Aktualisierung konnte nicht ausgewertet werden: {err}. Ausgabe: {stdout}")
    })?;

    let tx = conn.transaction().map_err(|err| err.to_string())?;
    for link in &data.links {
        let local_id = link
            .local_id
            .trim()
            .parse::<i64>()
            .map_err(|err| format!("Outlook-Link konnte nicht zugeordnet werden: {err}"))?;
        tx.execute(
            "UPDATE contacts SET outlook_entry_id = ?, outlook_store_id = ? WHERE id = ?",
            params![link.entry_id, link.store_id, local_id],
        )
        .map_err(|err| err.to_string())?;
    }
    tx.commit().map_err(|err| err.to_string())?;

    Ok(OutlookPushResult {
        total: contact_total,
        created: data.created,
        updated: data.updated,
        linked: data.links.len(),
        contact_copies: data.contact_copies,
        folders_created: data.folders_created,
        folders_used: data.folders_used,
        errors: data.errors,
        autocomplete_resolved: data.autocomplete_resolved,
        autocomplete_errors: data.autocomplete_errors,
        folder_path: data.folder_path,
        store_name: data.store_name,
    })
}

fn normalize_contact_display_name(contact: &ContactInput) -> String {
    if contact.display_name.trim().is_empty() {
        format!("{} {}", contact.first_name.trim(), contact.last_name.trim())
            .trim()
            .to_string()
    } else {
        contact.display_name.trim().to_string()
    }
}

fn contact_has_identity(contact: &ContactInput, display_name: &str, email: &str) -> bool {
    !email.is_empty()
        || !display_name.trim().is_empty()
        || !contact.phone.trim().is_empty()
        || !contact.mobile_phone.trim().is_empty()
}

fn find_existing_sync_contact(
    conn: &Connection,
    contact: &ContactInput,
    display_name: &str,
    email: &str,
    entry_id: &str,
) -> Result<Option<ExistingContactRow>, String> {
    let mut stmt = conn
        .prepare(
            "
            SELECT id, first_name, last_name, display_name, email, phone, mobile_phone,
                   street, postal_code, city, country, short_info, notes, deleted_at,
                   outlook_entry_id, outlook_store_id
            FROM contacts
            WHERE (
                ?6 <> '' AND outlook_entry_id = ?6
              )
              OR (
                ?1 <> '' AND lower(email) = ?1
              )
              OR (
                ?1 = ''
                AND lower(display_name) = ?2
                AND (
                  (?3 <> '' AND phone = ?3)
                  OR (?4 <> '' AND mobile_phone = ?4)
                  OR (?3 = '' AND ?4 = '' AND lower(city) = ?5)
                )
              )
            ORDER BY deleted_at IS NOT NULL, updated_at DESC
            LIMIT 1
            ",
        )
        .map_err(|err| err.to_string())?;

    stmt.query_row(
        params![
            email,
            display_name.trim().to_lowercase(),
            contact.phone.trim(),
            contact.mobile_phone.trim(),
            contact.city.trim().to_lowercase(),
            entry_id
        ],
        |row| {
            Ok(ExistingContactRow {
                id: row.get(0)?,
                first_name: row.get(1)?,
                last_name: row.get(2)?,
                display_name: row.get(3)?,
                email: row.get(4)?,
                phone: row.get(5)?,
                mobile_phone: row.get(6)?,
                street: row.get(7)?,
                postal_code: row.get(8)?,
                city: row.get(9)?,
                country: row.get(10)?,
                short_info: row.get(11)?,
                notes: row.get(12)?,
                deleted_at: row.get(13)?,
                outlook_entry_id: row.get(14)?,
                outlook_store_id: row.get(15)?,
            })
        },
    )
    .optional()
    .map_err(|err| err.to_string())
}

fn contact_needs_update(
    existing: &ExistingContactRow,
    contact: &ContactInput,
    display_name: &str,
    email: &str,
    entry_id: &str,
    store_id: &str,
) -> bool {
    existing.deleted_at.is_some()
        || existing.first_name != contact.first_name
        || existing.last_name != contact.last_name
        || existing.display_name != display_name
        || existing.email != email
        || existing.phone != contact.phone
        || existing.mobile_phone != contact.mobile_phone
        || existing.street != contact.street
        || existing.postal_code != contact.postal_code
        || existing.city != contact.city
        || existing.country != contact.country
        || existing.short_info != contact.short_info
        || existing.notes != contact.notes
        || existing.outlook_entry_id.as_deref().unwrap_or_default() != entry_id
        || existing.outlook_store_id.as_deref().unwrap_or_default() != store_id
}

#[tauri::command]
fn import_outlook_classic_contacts_once(
    app: AppHandle,
) -> Result<OutlookOneTimeContactImportResult, String> {
    let read_result = read_outlook_classic_contacts()?;
    let found = read_result.contacts.len();
    let mut conn = open_db(&app)?;
    let mut fingerprints = load_contact_fingerprints(&conn)?;
    let tx = conn.transaction().map_err(|err| err.to_string())?;
    let timestamp = now();
    let batch_id = format!("outlook-once-{}", Utc::now().timestamp_millis());
    let mut imported = 0usize;
    let mut skipped_duplicates = 0usize;
    let mut skipped_invalid = read_result.skipped;

    for record in &read_result.contacts {
        let contact = outlook_record_to_contact(record);
        let display_name = normalize_contact_display_name(&contact);
        let email = contact.email.trim().to_lowercase();

        if !contact_has_identity(&contact, &display_name, &email) {
            skipped_invalid += 1;
            continue;
        }

        if fingerprints.exact_contacts.contains_key(&contact_exact_key(
            &contact,
            &display_name,
            &email,
        )) {
            skipped_duplicates += 1;
            continue;
        }

        tx.execute(
            "
            INSERT INTO contacts (
                first_name, last_name, display_name, email, phone, mobile_phone, street,
                postal_code, city, country, short_info, notes, import_batch_id,
                created_at, updated_at
            )
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            ",
            params![
                contact.first_name,
                contact.last_name,
                display_name,
                email,
                contact.phone,
                contact.mobile_phone,
                contact.street,
                contact.postal_code,
                contact.city,
                contact.country,
                contact.short_info,
                contact.notes,
                batch_id,
                timestamp,
                timestamp
            ],
        )
        .map_err(|err| err.to_string())?;
        add_fingerprint(&mut fingerprints, &contact, &display_name, &email);
        imported += 1;
    }

    if imported > 0 {
        tx.execute(
            "INSERT INTO import_history (batch_id, source_file, imported_count, skipped_count, created_at) VALUES (?, ?, ?, ?, ?)",
            params![
                batch_id,
                "Outlook Classic (einmaliger Kontaktimport)",
                imported as i64,
                (skipped_duplicates + skipped_invalid) as i64,
                timestamp
            ],
        )
        .map_err(|err| err.to_string())?;
    }

    tx.commit().map_err(|err| err.to_string())?;
    Ok(OutlookOneTimeContactImportResult {
        found,
        imported,
        skipped_duplicates,
        skipped_invalid,
    })
}

#[tauri::command]
fn sync_outlook_classic_contacts(app: AppHandle) -> Result<OutlookSyncResult, String> {
    let mut conn = open_db(&app)?;
    let pushed = push_local_contacts_to_outlook(&mut conn, None)?;
    let contacts = read_outlook_classic_contacts()?.contacts;
    let tx = conn.transaction().map_err(|err| err.to_string())?;
    let timestamp = now();
    let mut inserted = 0usize;
    let mut updated = 0usize;
    let mut skipped = 0usize;

    for record in contacts.iter() {
        let contact = outlook_record_to_contact(record);
        let display_name = normalize_contact_display_name(&contact);
        let email = contact.email.trim().to_lowercase();
        let entry_id = record.entry_id.trim();
        let store_id = record.store_id.trim();

        if !contact_has_identity(&contact, &display_name, &email) {
            skipped += 1;
            continue;
        }

        if let Some(existing) =
            find_existing_sync_contact(&tx, &contact, &display_name, &email, entry_id)?
        {
            if contact_needs_update(
                &existing,
                &contact,
                &display_name,
                &email,
                entry_id,
                store_id,
            ) {
                tx.execute(
                    "
                    UPDATE contacts
                    SET first_name = ?, last_name = ?, display_name = ?, email = ?, phone = ?,
                        mobile_phone = ?, street = ?, postal_code = ?, city = ?, country = ?,
                        short_info = ?, notes = ?, outlook_entry_id = ?, outlook_store_id = ?,
                        deleted_at = NULL, updated_at = ?
                    WHERE id = ?
                    ",
                    params![
                        contact.first_name,
                        contact.last_name,
                        display_name,
                        email,
                        contact.phone,
                        contact.mobile_phone,
                        contact.street,
                        contact.postal_code,
                        contact.city,
                        contact.country,
                        contact.short_info,
                        contact.notes,
                        entry_id,
                        store_id,
                        timestamp,
                        existing.id
                    ],
                )
                .map_err(|err| err.to_string())?;
                updated += 1;
            }
        } else {
            tx.execute(
                "
                INSERT INTO contacts (
                    first_name, last_name, display_name, email, phone, mobile_phone, street,
                    postal_code, city, country, short_info, notes, import_batch_id,
                    outlook_entry_id, outlook_store_id, created_at, updated_at
                )
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                ",
                params![
                    contact.first_name,
                    contact.last_name,
                    display_name,
                    email,
                    contact.phone,
                    contact.mobile_phone,
                    contact.street,
                    contact.postal_code,
                    contact.city,
                    contact.country,
                    contact.short_info,
                    contact.notes,
                    "outlook-classic-sync",
                    entry_id,
                    store_id,
                    timestamp,
                    timestamp
                ],
            )
            .map_err(|err| err.to_string())?;
            inserted += 1;
        }
    }

    tx.commit().map_err(|err| err.to_string())?;
    Ok(OutlookSyncResult {
        scanned: contacts.len(),
        inserted,
        updated,
        skipped,
        pushed,
    })
}

#[tauri::command]
fn push_project_contacts_to_outlook(
    app: AppHandle,
    target_email: Option<String>,
) -> Result<OutlookPushResult, String> {
    let mut conn = open_db(&app)?;
    push_local_contacts_to_outlook(&mut conn, target_email.as_deref())
}

#[tauri::command]
fn diagnose_outlook_contact_folders() -> Result<Vec<OutlookFolderDiagnostic>, String> {
    let script = r#"
$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
$outlook = New-Object -ComObject Outlook.Application
$namespace = $outlook.Session
$folders = New-Object System.Collections.Generic.List[object]

function Count-Contact-Items($folder) {
  $count = 0
  try {
    $items = $folder.Items
    for ($index = 1; $index -le $items.Count; $index++) {
      try {
        $item = $items.Item($index)
        if ([string]$item.MessageClass -like 'IPM.Contact*') { $count++ }
      } catch {}
    }
  } catch {}
  return $count
}

function Read-Folders($folder, $storeName) {
  try {
    $folderClass = [string]$folder.DefaultItemType
    $contactCount = Count-Contact-Items $folder
    if ($folderClass -eq '2' -or $contactCount -gt 0 -or ([string]$folder.Name -like '*Kontakt*') -or ([string]$folder.Name -like '*Contact*')) {
      $folders.Add([pscustomobject]@{
        folderPath = [string]$folder.FolderPath
        storeName = $storeName
        itemCount = $contactCount
      }) | Out-Null
    }
  } catch {}
  try {
    foreach ($child in @($folder.Folders)) { Read-Folders $child $storeName }
  } catch {}
}

for ($storeIndex = 1; $storeIndex -le $namespace.Stores.Count; $storeIndex++) {
  $store = $namespace.Stores.Item($storeIndex)
  $storeName = [string]$store.DisplayName
  Read-Folders $store.GetRootFolder() $storeName
}

$folders | ConvertTo-Json -Depth 5 -Compress
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
        .map_err(|err| format!("Outlook Classic konnte nicht gelesen werden: {err}"))?;

    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        return Err(format!(
            "Outlook-Kontaktordner konnten nicht gelesen werden. {stderr}"
        ));
    }

    let stdout = String::from_utf8_lossy(&output.stdout);
    if stdout.trim().is_empty() {
        return Ok(Vec::new());
    }
    serde_json::from_str::<Vec<OutlookFolderDiagnostic>>(stdout.trim())
        .or_else(|_| {
            serde_json::from_str::<OutlookFolderDiagnostic>(stdout.trim())
                .map(|folder| vec![folder])
        })
        .map_err(|err| {
            format!(
                "Outlook-Kontaktordner konnten nicht ausgewertet werden: {err}. Ausgabe: {stdout}"
            )
        })
}

fn read_outlook_classic_appointments() -> Result<OutlookCalendarReadData, String> {
    let script = r#"
$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
$outlook = New-Object -ComObject Outlook.Application
$namespace = $outlook.Session
$calendars = New-Object System.Collections.Generic.List[object]
$events = New-Object System.Collections.Generic.List[object]
$skipped = 0

function Get-Calendar-Color($categoriesText) {
  foreach ($categoryName in @(([string]$categoriesText) -split '[,;]')) {
    $name = $categoryName.Trim()
    if ([string]::IsNullOrWhiteSpace($name)) { continue }
    try {
      switch ([int]$namespace.Categories.Item($name).Color) {
        { $_ -in 1, 10, 16, 25 } { return 'red' }
        { $_ -in 2, 3, 4, 17, 18, 19 } { return 'yellow' }
        { $_ -in 5, 6, 7, 20, 21, 22 } { return 'green' }
        { $_ -in 9, 24 } { return 'purple' }
        { $_ -in 13, 14, 15 } { return 'gray' }
        default { return 'blue' }
      }
    } catch {}
    if ($name -match '(?i)rot|red|rosa|pink') { return 'red' }
    if ($name -match '(?i)grün|gruen|green|türkis|tuerkis|teal|olive') { return 'green' }
    if ($name -match '(?i)gelb|yellow|orange|peach') { return 'yellow' }
    if ($name -match '(?i)lila|violett|purple|maroon') { return 'purple' }
    if ($name -match '(?i)grau|gray|grey|schwarz|black|steel') { return 'gray' }
  }
  return 'blue'
}

function Get-Weekdays($mask) {
  $days = New-Object System.Collections.Generic.List[int]
  if (($mask -band 1) -ne 0) { $days.Add(0) }
  if (($mask -band 2) -ne 0) { $days.Add(1) }
  if (($mask -band 4) -ne 0) { $days.Add(2) }
  if (($mask -band 8) -ne 0) { $days.Add(3) }
  if (($mask -band 16) -ne 0) { $days.Add(4) }
  if (($mask -band 32) -ne 0) { $days.Add(5) }
  if (($mask -band 64) -ne 0) { $days.Add(6) }
  return $days.ToArray()
}

function Get-Recurrence-Data($item) {
  try {
    if (-not [bool]$item.IsRecurring -or [int]$item.RecurrenceState -ne 1) { return $null }
    $pattern = $item.GetRecurrencePattern()
    $recurrenceType = [int]$pattern.RecurrenceType
    $frequency = switch ($recurrenceType) {
      0 { 'daily' }
      1 { 'weekly' }
      2 { 'monthly' }
      3 { 'monthly' }
      5 { 'yearly' }
      6 { 'yearly' }
      default { $null }
    }
    if (-not $frequency) { return $null }
    $interval = [Math]::Max(1, [int]$pattern.Interval)
    if ($recurrenceType -in 5, 6) { $interval = 1 }
    $daysOfWeek = @()
    if ($recurrenceType -in 1, 3, 6) { $daysOfWeek = @(Get-Weekdays ([int]$pattern.DayOfWeekMask)) }
    $dayOfMonth = $null
    if ($recurrenceType -in 2, 5) { $dayOfMonth = [int]$pattern.DayOfMonth }
    $monthOfYear = $null
    if ($recurrenceType -in 5, 6) { $monthOfYear = [int]$pattern.MonthOfYear }
    $weekOfMonth = $null
    if ($recurrenceType -in 3, 6) {
      $weekOfMonth = [int]$pattern.Instance
      if ($weekOfMonth -eq 5) { $weekOfMonth = -1 }
    }
    $until = $null
    if (-not [bool]$pattern.NoEndDate) { $until = ([datetime]$pattern.PatternEndDate).ToString('yyyy-MM-dd') }
    $excludedDates = New-Object System.Collections.Generic.List[string]
    try {
      $exceptions = $pattern.Exceptions
      for ($exceptionIndex = 1; $exceptionIndex -le $exceptions.Count; $exceptionIndex++) {
        $excludedDates.Add(([datetime]$exceptions.Item($exceptionIndex).OriginalDate).ToString('yyyy-MM-dd'))
      }
    } catch {}
    return [pscustomobject]@{
      recurrence = [pscustomobject]@{
        frequency = $frequency
        interval = $interval
        daysOfWeek = $daysOfWeek
        dayOfMonth = $dayOfMonth
        monthOfYear = $monthOfYear
        weekOfMonth = $weekOfMonth
        until = $until
        count = $null
      }
      excludedDates = $excludedDates.ToArray()
    }
  } catch { return $null }
}

function Add-Calendar-Record($item, $folder, $storeId, $storeName, $allowRecurrence, $identitySuffix) {
  try {
    $entryId = ''
    $globalAppointmentId = ''
    $start = ''
    $end = ''
    $categories = ''
    try { $entryId = [string]$item.EntryID } catch {}
    if ($identitySuffix) { $entryId = "$entryId$identitySuffix" }
    try { $globalAppointmentId = [string]$item.GlobalAppointmentID } catch {}
    try { $start = ([datetime]$item.Start).ToString('yyyy-MM-ddTHH:mm:ss') } catch {}
    try { $end = ([datetime]$item.End).ToString('yyyy-MM-ddTHH:mm:ss') } catch {}
    try { $categories = [string]$item.Categories } catch {}
    $recurrenceData = if ($allowRecurrence) { Get-Recurrence-Data $item } else { $null }
    [string[]]$eventExcludedDates = @()
    if ($recurrenceData) { [string[]]$eventExcludedDates = @($recurrenceData.excludedDates) }
    $events.Add([pscustomobject]@{
      entryId = $entryId
      storeId = $storeId
      storeName = $storeName
      folderPath = [string]$folder.FolderPath
      globalAppointmentId = $globalAppointmentId
      title = [string]$item.Subject
      startsAt = $start
      endsAt = $end
      location = [string]$item.Location
      description = [string]$item.Body
      category = $categories
      color = Get-Calendar-Color $categories
      recurrence = if ($recurrenceData) { $recurrenceData.recurrence } else { $null }
      excludedDates = $eventExcludedDates
    }) | Out-Null

    if ($recurrenceData) {
      try {
        $exceptions = $item.GetRecurrencePattern().Exceptions
        for ($exceptionIndex = 1; $exceptionIndex -le $exceptions.Count; $exceptionIndex++) {
          $exception = $exceptions.Item($exceptionIndex)
          if (-not [bool]$exception.Deleted) {
            $suffix = '-exception-' + ([datetime]$exception.OriginalDate).ToString('yyyyMMddHHmmss')
            Add-Calendar-Record $exception.AppointmentItem $folder $storeId $storeName $false $suffix
          }
        }
      } catch { $script:skipped++ }
    }
  } catch { $script:skipped++ }
}

function Read-Calendar-Folder($folder, $storeId, $storeName) {
  try {
    $folderPath = [string]$folder.FolderPath
    $calendars.Add([pscustomobject]@{
      id = "$storeId|$folderPath"
      storeId = $storeId
      storeName = $storeName
      folderPath = $folderPath
      name = [string]$folder.Name
    }) | Out-Null
    $items = $folder.Items
    for ($index = 1; $index -le $items.Count; $index++) {
      try {
        $item = $items.Item($index)
        if ([string]$item.MessageClass -notlike 'IPM.Appointment*') { continue }
        Add-Calendar-Record $item $folder $storeId $storeName $true ''
      } catch { $script:skipped++ }
    }
  } catch { $script:skipped++ }
}

function Read-Folders($folder, $storeId, $storeName) {
  try {
    if ([int]$folder.DefaultItemType -eq 1) {
      Read-Calendar-Folder $folder $storeId $storeName
    }
  } catch { $script:skipped++ }
  try {
    $children = $folder.Folders
    for ($childIndex = 1; $childIndex -le $children.Count; $childIndex++) {
      Read-Folders $children.Item($childIndex) $storeId $storeName
    }
  } catch { $script:skipped++ }
}

for ($storeIndex = 1; $storeIndex -le $namespace.Stores.Count; $storeIndex++) {
  try {
    $store = $namespace.Stores.Item($storeIndex)
    Read-Folders $store.GetRootFolder() ([string]$store.StoreID) ([string]$store.DisplayName)
  } catch { $script:skipped++ }
}

[pscustomobject]@{ calendars = $calendars.ToArray(); events = $events.ToArray(); skipped = $skipped } | ConvertTo-Json -Depth 6 -Compress
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
        .map_err(|err| format!("Outlook Classic konnte nicht gestartet werden: {err}"))?;

    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        return Err(format!(
            "Outlook-Kalender konnten nicht gelesen werden. Prüfen Sie, ob Outlook Classic installiert und eingerichtet ist. {stderr}"
        ));
    }

    let stdout = String::from_utf8_lossy(&output.stdout);
    serde_json::from_str::<OutlookCalendarReadData>(stdout.trim())
        .map_err(|err| format!("Outlook-Termine konnten nicht ausgewertet werden: {err}"))
}

fn outlook_calendar_key(store_id: &str, folder_path: &str) -> String {
    format!("{}\n{}", store_id.trim(), folder_path.trim())
}

fn outlook_calendar_name(store_name: &str, folder_path: &str, fallback: &str) -> String {
    let folder_name = folder_path
        .trim()
        .trim_end_matches(['\\', '/'])
        .rsplit(['\\', '/'])
        .next()
        .unwrap_or("")
        .trim();
    if !store_name.trim().is_empty() && !folder_name.is_empty() {
        format!("{} · {}", store_name.trim(), folder_name)
    } else if !fallback.trim().is_empty() {
        fallback.trim().to_string()
    } else if !folder_name.is_empty() {
        folder_name.to_string()
    } else {
        "Unbenannter Kalender".to_string()
    }
}

fn outlook_duplicate_key(record: &OutlookAppointmentRecord) -> Option<String> {
    let starts_at = record.starts_at.trim();
    if starts_at.is_empty() {
        return None;
    }
    Some(format!(
        "{}\n{}\n{}\n{}",
        record.title.trim().to_lowercase(),
        starts_at,
        record.ends_at.trim(),
        record.location.trim().to_lowercase()
    ))
}

fn build_outlook_calendar_preview(read_result: &OutlookCalendarReadData) -> OutlookCalendarPreview {
    let mut calendars: BTreeMap<String, OutlookCalendarPreviewCalendar> = read_result
        .calendars
        .iter()
        .map(|calendar| {
            (
                outlook_calendar_key(&calendar.store_id, &calendar.folder_path),
                OutlookCalendarPreviewCalendar {
                    id: if calendar.id.trim().is_empty() {
                        outlook_calendar_key(&calendar.store_id, &calendar.folder_path)
                    } else {
                        calendar.id.clone()
                    },
                    name: outlook_calendar_name(
                        &calendar.store_name,
                        &calendar.folder_path,
                        &calendar.name,
                    ),
                    store_name: calendar.store_name.clone(),
                    folder_path: calendar.folder_path.clone(),
                    event_count: 0,
                },
            )
        })
        .collect();
    let mut duplicate_groups: BTreeMap<
        String,
        (
            String,
            String,
            String,
            String,
            BTreeMap<String, String>,
            usize,
        ),
    > = BTreeMap::new();
    let mut skipped_invalid = read_result.skipped;

    for record in &read_result.events {
        if record.starts_at.trim().is_empty() {
            skipped_invalid += 1;
            continue;
        }
        let calendar_key = outlook_calendar_key(&record.store_id, &record.folder_path);
        let calendar_name =
            outlook_calendar_name(&record.store_name, &record.folder_path, &record.folder_path);
        let calendar = calendars.entry(calendar_key.clone()).or_insert_with(|| {
            OutlookCalendarPreviewCalendar {
                id: calendar_key.clone(),
                name: calendar_name.clone(),
                store_name: record.store_name.clone(),
                folder_path: record.folder_path.clone(),
                event_count: 0,
            }
        });
        calendar.event_count += 1;

        if let Some(key) = outlook_duplicate_key(record) {
            let duplicate = duplicate_groups.entry(key).or_insert_with(|| {
                (
                    if record.title.trim().is_empty() {
                        "Ohne Titel".to_string()
                    } else {
                        record.title.trim().to_string()
                    },
                    record.starts_at.trim().to_string(),
                    record.ends_at.trim().to_string(),
                    record.location.trim().to_string(),
                    BTreeMap::new(),
                    0,
                )
            });
            duplicate.4.insert(calendar_key, calendar_name);
            duplicate.5 += 1;
        }
    }

    let duplicate_groups = duplicate_groups
        .into_values()
        .filter_map(
            |(title, starts_at, ends_at, location, calendars, occurrence_count)| {
                (calendars.len() > 1).then(|| OutlookCalendarDuplicateGroup {
                    title,
                    starts_at,
                    ends_at,
                    location,
                    occurrence_count,
                    calendars: calendars.into_values().collect(),
                })
            },
        )
        .collect();

    let total_events = calendars
        .values()
        .map(|calendar| calendar.event_count)
        .sum();
    OutlookCalendarPreview {
        calendars: calendars.into_values().collect(),
        total_events,
        skipped_invalid,
        duplicate_groups,
    }
}

#[tauri::command]
fn preview_outlook_classic_appointments() -> Result<OutlookCalendarPreview, String> {
    let read_result = read_outlook_classic_appointments()?;
    Ok(build_outlook_calendar_preview(&read_result))
}

fn outlook_calendar_event_id(record: &OutlookAppointmentRecord, index: usize) -> String {
    let identity = if !record.entry_id.trim().is_empty() {
        format!("{}\n{}", record.store_id.trim(), record.entry_id.trim())
    } else if !record.global_appointment_id.trim().is_empty() {
        format!(
            "{}\n{}",
            record.store_id.trim(),
            record.global_appointment_id.trim()
        )
    } else {
        format!(
            "{}\n{}\n{}\n{}\n{}",
            record.store_id.trim(),
            record.folder_path.trim(),
            record.starts_at.trim(),
            record.title.trim(),
            index
        )
    };
    let digest = Sha256::digest(identity.as_bytes());
    let mut hash = String::with_capacity(digest.len() * 2);
    for byte in digest {
        hash.push_str(&format!("{byte:02x}"));
    }
    format!("outlook-classic-{hash}")
}

#[tauri::command]
fn import_outlook_classic_appointments_once() -> Result<OutlookOneTimeCalendarImportResult, String>
{
    let read_result = read_outlook_classic_appointments()?;
    let found = read_result.events.len();
    let mut skipped_invalid = read_result.skipped;
    let mut seen_ids = HashSet::new();
    let mut events = Vec::with_capacity(found);

    for (index, record) in read_result.events.into_iter().enumerate() {
        let starts_at = record.starts_at.trim().to_string();
        if starts_at.is_empty() {
            skipped_invalid += 1;
            continue;
        }
        let id = outlook_calendar_event_id(&record, index);
        if !seen_ids.insert(id.clone()) {
            skipped_invalid += 1;
            continue;
        }
        let title = if record.title.trim().is_empty() {
            "Ohne Titel".to_string()
        } else {
            record.title.trim().to_string()
        };
        let source = [
            "Outlook Classic",
            record.store_name.trim(),
            record.folder_path.trim(),
        ]
        .into_iter()
        .filter(|value| !value.is_empty())
        .collect::<Vec<_>>()
        .join(" · ");
        events.push(CalendarEvent {
            id,
            updated_at: now(),
            title,
            starts_at: starts_at.clone(),
            ends_at: if record.ends_at.trim().is_empty() {
                starts_at
            } else {
                record.ends_at.trim().to_string()
            },
            location: record.location,
            description: record.description,
            color: record.color,
            category: record.category,
            source,
            recurrence: record.recurrence,
            excluded_dates: record.excluded_dates,
            deleted_at: None,
            recurrence_master_id: None,
            recurrence_id: None,
        });
    }

    Ok(OutlookOneTimeCalendarImportResult {
        found,
        skipped_invalid,
        events,
    })
}

#[tauri::command]
fn import_outlook_store(path: String) -> Result<OutlookImportData, String> {
    let escaped_path = path.replace('\'', "''");
    let script = format!(
        r#"
$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
$path = '{escaped_path}'
$outlook = New-Object -ComObject Outlook.Application
$namespace = $outlook.Session
$namespace.AddStoreEx($path, 3)
$store = $namespace.Stores.Item($namespace.Stores.Count)
$root = $store.GetRootFolder()
$contacts = New-Object System.Collections.Generic.List[object]
$events = New-Object System.Collections.Generic.List[object]
function Get-Store-Calendar-Color($categoriesText) {{
  foreach ($categoryName in @(([string]$categoriesText) -split '[,;]')) {{
    $name = $categoryName.Trim()
    if ([string]::IsNullOrWhiteSpace($name)) {{ continue }}
    try {{
      switch ([int]$namespace.Categories.Item($name).Color) {{
        {{ $_ -in 1, 10, 16, 25 }} {{ return 'red' }}
        {{ $_ -in 2, 3, 4, 17, 18, 19 }} {{ return 'yellow' }}
        {{ $_ -in 5, 6, 7, 20, 21, 22 }} {{ return 'green' }}
        {{ $_ -in 9, 24 }} {{ return 'purple' }}
        {{ $_ -in 13, 14, 15 }} {{ return 'gray' }}
        default {{ return 'blue' }}
      }}
    }} catch {{}}
    if ($name -match '(?i)rot|red|rosa|pink') {{ return 'red' }}
    if ($name -match '(?i)grün|gruen|green|türkis|tuerkis|teal|olive') {{ return 'green' }}
    if ($name -match '(?i)gelb|yellow|orange|peach') {{ return 'yellow' }}
    if ($name -match '(?i)lila|violett|purple|maroon') {{ return 'purple' }}
    if ($name -match '(?i)grau|gray|grey|schwarz|black|steel') {{ return 'gray' }}
  }}
  return 'blue'
}}
function Get-Store-Weekdays($mask) {{
  $days = New-Object System.Collections.Generic.List[int]
  if (($mask -band 1) -ne 0) {{ $days.Add(0) }}
  if (($mask -band 2) -ne 0) {{ $days.Add(1) }}
  if (($mask -band 4) -ne 0) {{ $days.Add(2) }}
  if (($mask -band 8) -ne 0) {{ $days.Add(3) }}
  if (($mask -band 16) -ne 0) {{ $days.Add(4) }}
  if (($mask -band 32) -ne 0) {{ $days.Add(5) }}
  if (($mask -band 64) -ne 0) {{ $days.Add(6) }}
  return $days.ToArray()
}}
function Get-Store-Recurrence($item) {{
  try {{
    if (-not [bool]$item.IsRecurring -or [int]$item.RecurrenceState -ne 1) {{ return $null }}
    $pattern = $item.GetRecurrencePattern()
    $recurrenceType = [int]$pattern.RecurrenceType
    $frequency = switch ($recurrenceType) {{ 0 {{ 'daily' }} 1 {{ 'weekly' }} 2 {{ 'monthly' }} 3 {{ 'monthly' }} 5 {{ 'yearly' }} 6 {{ 'yearly' }} default {{ $null }} }}
    if (-not $frequency) {{ return $null }}
    $interval = [Math]::Max(1, [int]$pattern.Interval)
    if ($recurrenceType -in 5, 6) {{ $interval = 1 }}
    $daysOfWeek = if ($recurrenceType -in 1, 3, 6) {{ @(Get-Store-Weekdays ([int]$pattern.DayOfWeekMask)) }} else {{ @() }}
    $dayOfMonth = if ($recurrenceType -in 2, 5) {{ [int]$pattern.DayOfMonth }} else {{ $null }}
    $monthOfYear = if ($recurrenceType -in 5, 6) {{ [int]$pattern.MonthOfYear }} else {{ $null }}
    $weekOfMonth = if ($recurrenceType -in 3, 6) {{ [int]$pattern.Instance }} else {{ $null }}
    if ($weekOfMonth -eq 5) {{ $weekOfMonth = -1 }}
    $until = if (-not [bool]$pattern.NoEndDate) {{ ([datetime]$pattern.PatternEndDate).ToString('yyyy-MM-dd') }} else {{ $null }}
    return [pscustomobject]@{{ frequency = $frequency; interval = $interval; daysOfWeek = $daysOfWeek; dayOfMonth = $dayOfMonth; monthOfYear = $monthOfYear; weekOfMonth = $weekOfMonth; until = $until; count = $null }}
  }} catch {{ return $null }}
}}
function Read-Folders($folder) {{
  try {{
    foreach ($item in @($folder.Items)) {{
      try {{
        $messageClass = [string]$item.MessageClass
        if ($messageClass -like 'IPM.Contact*') {{
          $email = [string]$item.Email1Address
          try {{
            $smtp = [string]$item.PropertyAccessor.GetProperty('http://schemas.microsoft.com/mapi/proptag/0x39FE001E')
            if (-not [string]::IsNullOrWhiteSpace($smtp)) {{ $email = $smtp }}
          }} catch {{}}
          if ([string]::IsNullOrWhiteSpace($email)) {{ $email = [string]$item.Email2Address }}
          if ([string]::IsNullOrWhiteSpace($email)) {{ $email = [string]$item.Email3Address }}
          $contacts.Add([pscustomobject]@{{
            id = $null
            firstName = [string]$item.FirstName
            lastName = [string]$item.LastName
            displayName = [string]$item.FullName
            email = $email
            phone = [string]$item.BusinessTelephoneNumber
            mobilePhone = [string]$item.MobileTelephoneNumber
            street = [string]$item.BusinessAddressStreet
            postalCode = [string]$item.BusinessAddressPostalCode
            city = [string]$item.BusinessAddressCity
            country = [string]$item.BusinessAddressCountry
            shortInfo = ''
            notes = [string]$item.Body
            groupIds = @()
          }}) | Out-Null
        }}
        if ($messageClass -like 'IPM.Appointment*') {{
          $categories = [string]$item.Categories
          $events.Add([pscustomobject]@{{
            id = [string]$item.GlobalAppointmentID
            title = [string]$item.Subject
            startsAt = if ($item.Start) {{ ([datetime]$item.Start).ToString('o') }} else {{ '' }}
            endsAt = if ($item.End) {{ ([datetime]$item.End).ToString('o') }} else {{ '' }}
            location = [string]$item.Location
            description = [string]$item.Body
            color = Get-Store-Calendar-Color $categories
            category = $categories
            source = $path
            recurrence = Get-Store-Recurrence $item
            excludedDates = @()
          }}) | Out-Null
        }}
      }} catch {{}}
    }}
  }} catch {{}}
  foreach ($child in @($folder.Folders)) {{ Read-Folders $child }}
}}
Read-Folders $root
try {{ $namespace.RemoveStore($root) }} catch {{}}
[pscustomobject]@{{ contacts = $contacts; events = $events }} | ConvertTo-Json -Depth 6 -Compress
"#
    );

    let output = hidden_command("powershell")
        .args([
            "-NoProfile",
            "-ExecutionPolicy",
            "Bypass",
            "-Command",
            script.as_str(),
        ])
        .output()
        .map_err(|err| format!("Outlook-Import konnte nicht gestartet werden: {err}"))?;

    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        return Err(format!(
            "PST/OST konnte nicht gelesen werden. Outlook Classic muss installiert sein. {stderr}"
        ));
    }

    let stdout = String::from_utf8_lossy(&output.stdout);
    let data = serde_json::from_str::<OutlookImportData>(stdout.trim()).map_err(|err| {
        format!("Outlook-Daten konnten nicht ausgewertet werden: {err}. Ausgabe: {stdout}")
    })?;
    if data.contacts.is_empty() && data.events.is_empty() {
        return Err("Outlook-Datendatei wurde geöffnet, aber es wurden keine Kontakte oder Kalendertermine gefunden. Prüfen Sie, ob die PST/OST Kontakte oder Kalender enthält und ob Outlook Classic Zugriff auf diese Datei hat.".to_string());
    }
    Ok(data)
}

pub fn run() {
    tauri::Builder::default()
        .manage(AppState {
            db_path: Mutex::new(PathBuf::new()),
            vault: Mutex::new(vault::VaultRuntime::default()),
            outlook_contact_cache: Mutex::new(None),
            m365: m365::Microsoft365Runtime::default(),
        })
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_fs::init())
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_clipboard_manager::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .setup(|app| {
            init_db(&app.handle())?;
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            list_contacts,
            list_deleted_contacts,
            save_contact,
            delete_contact,
            delete_contacts,
            restore_contact,
            list_groups,
            list_deleted_groups,
            save_group,
            delete_group,
            restore_group,
            import_contacts,
            undo_last_import,
            undo_last_outlook_contact_import,
            get_backup_data,
            create_automatic_backup,
            restore_automatic_backup,
            restore_backup,
            write_export_file,
            reset_local_app_data,
            restart_app,
            delete_all_contacts,
            add_contact_to_group,
            move_contact_to_group,
            clear_contact_groups,
            push_project_contacts_to_outlook,
            open_outlook_classic_email,
            open_new_outlook_email,
            open_outlook_classic_bulk_email,
            open_new_outlook_bulk_email,
            get_app_setting,
            set_app_setting,
            m365::get_m365_connection_status,
            m365::start_m365_connection,
            m365::poll_m365_connection,
            m365::cancel_m365_connection,
            m365::open_m365_sign_in,
            m365::test_m365_connection,
            m365::disconnect_m365_account,
            m365::list_m365_sync_sources,
            m365::preview_m365_sync,
            m365::apply_m365_sync,
            documents::list_document_sources,
            documents::list_document_items,
            documents::create_document_folder,
            documents::rename_document_item,
            documents::delete_document_item,
            documents::move_document_items,
            documents::copy_document_items,
            documents::open_document_in_office,
            file_icons::get_document_file_icons,
            documents::create_document_text_file,
            documents::create_document_share_link,
            documents::list_document_versions,
            documents::restore_document_version,
            documents::download_document_item,
            documents::make_document_folder_offline,
            documents::upload_document_file,
            documents::upload_document_path,
            documents::upload_document_revision,
            documents::sync_offline_documents,
            documents::list_document_sync_conflicts,
            documents::resolve_document_sync_conflict,
            documents::get_documents_local_root,
            phone_transfer::start_phone_photo_transfer,
            phone_transfer::get_phone_photo_transfer_status,
            phone_transfer::stop_phone_photo_transfer,
            printers::list_printers,
            printers::list_printer_drivers,
            printers::add_network_printer,
            printers::install_dmh_kopierraum_printer,
            import_outlook_store,
            preview_outlook_classic_contacts,
            import_selected_outlook_classic_contacts,
            preview_outlook_classic_appointments,
            import_outlook_classic_appointments_once,
            thunderbird::import_thunderbird_contacts_once,
            thunderbird::import_thunderbird_calendars_once,
            thunderbird::preview_thunderbird_data,
            mail_accounts::scan_outlook_accounts,
            mail_accounts::list_mail_accounts,
            mail_accounts::import_outlook_account,
            mail_accounts::test_mail_connection,
            mail_accounts::reveal_mail_password,
            mail_accounts::get_migration_capture_status,
            mail_accounts::get_migration_diagnostic_log,
            mail_accounts::reset_migration_capture_status,
            mail_accounts::submit_migration_credentials,
            mail_accounts::remove_mail_account,
            vault::get_vault_status,
            vault::create_automatic_password_backup,
            vault::list_vault_entries,
            vault::list_deleted_vault_entries,
            vault::save_vault_entry,
            vault::delete_vault_entry,
            vault::delete_all_vault_entries,
            vault::restore_vault_entry,
            vault::configure_vault_protection,
            vault::disable_vault_protection,
            vault::unlock_vault,
            vault::lock_vault,
            vault::request_vault_recovery,
            vault::complete_vault_recovery,
            vault::request_local_account_password_recovery,
            vault::complete_local_account_password_recovery
        ])
        .run(tauri::generate_context!())
        .expect("Fehler beim Starten von DMH Kontakte und Kalender");
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn onboarding_runs_only_for_a_new_local_database() {
        assert_eq!(initial_onboarding_completion(false), "false");
        assert_eq!(initial_onboarding_completion(true), "true");
    }

    #[test]
    fn outlook_export_preserves_active_groups_and_the_ungrouped_folder() {
        let conn = Connection::open_in_memory().expect("in-memory database");
        conn.execute_batch(
            "
            CREATE TABLE contacts (
                id INTEGER PRIMARY KEY,
                first_name TEXT NOT NULL DEFAULT '',
                last_name TEXT NOT NULL DEFAULT '',
                display_name TEXT NOT NULL DEFAULT '',
                email TEXT NOT NULL DEFAULT '',
                phone TEXT NOT NULL DEFAULT '',
                mobile_phone TEXT NOT NULL DEFAULT '',
                street TEXT NOT NULL DEFAULT '',
                postal_code TEXT NOT NULL DEFAULT '',
                city TEXT NOT NULL DEFAULT '',
                country TEXT NOT NULL DEFAULT '',
                short_info TEXT NOT NULL DEFAULT '',
                notes TEXT NOT NULL DEFAULT '',
                outlook_entry_id TEXT,
                outlook_store_id TEXT,
                updated_at TEXT NOT NULL,
                deleted_at TEXT
            );
            CREATE TABLE groups (
                id INTEGER PRIMARY KEY,
                name TEXT NOT NULL,
                description TEXT NOT NULL DEFAULT '',
                created_at TEXT NOT NULL DEFAULT '',
                updated_at TEXT NOT NULL DEFAULT '',
                deleted_at TEXT
            );
            CREATE TABLE contact_groups (contact_id INTEGER NOT NULL, group_id INTEGER NOT NULL);
            INSERT INTO contacts (id, display_name, email, updated_at) VALUES
                (1, 'Ohne Gruppe', 'ohne@example.org', '2026-01-01'),
                (2, 'In zwei Gruppen', 'gruppen@example.org', '2026-01-02');
            INSERT INTO groups (id, name) VALUES (1, 'Kontakte'), (2, 'Vorstand');
            INSERT INTO groups (id, name, deleted_at) VALUES (3, 'Alt', '2026-01-03');
            INSERT INTO contact_groups VALUES (2, 1), (2, 2), (2, 3);
            ",
        )
        .expect("Outlook export test data");

        let contacts = load_local_outlook_contacts(&conn).expect("contacts with groups");
        assert_eq!(contacts.len(), 2);
        assert!(contacts[0].groups.is_empty());
        assert_eq!(contacts[1].groups, vec!["Kontakte", "Vorstand"]);

        let folders = load_local_outlook_group_names(&conn).expect("active folders");
        assert_eq!(folders, vec!["Gesammelte Adressen", "Kontakte", "Vorstand"]);
    }

    fn sample_contact(name: &str, email: &str, phone: &str) -> ContactInput {
        ContactInput {
            id: None,
            first_name: String::new(),
            last_name: String::new(),
            display_name: name.to_string(),
            email: email.to_string(),
            phone: phone.to_string(),
            mobile_phone: String::new(),
            street: String::new(),
            postal_code: String::new(),
            city: String::new(),
            country: String::new(),
            short_info: String::new(),
            notes: String::new(),
            group_ids: Vec::new(),
        }
    }

    #[test]
    fn cleans_imported_names_and_recognizes_email_fields() {
        assert_eq!(
            clean_imported_display_name("\"max.mustermann@example.org\"", "max.mustermann@example.org"),
            "Max Mustermann"
        );
        assert_eq!(
            clean_imported_display_name("max.mustermann", "max.mustermann@example.org"),
            "Max Mustermann"
        );
        assert_eq!(
            clean_imported_display_name("Dr. Erika Mustermann", "erika@example.org"),
            "Dr Erika Mustermann"
        );

        let mut address_only = sample_contact("", "jane.doe@example.org", "");
        clean_imported_contact_name(&mut address_only);
        assert_eq!(address_only.display_name, "Jane Doe");
        assert_eq!(address_only.email, "jane.doe@example.org");

        let mut invalid_email = sample_contact("", "max.mustermann", "");
        clean_imported_contact_name(&mut invalid_email);
        assert_eq!(invalid_email.display_name, "Max Mustermann");
        assert!(invalid_email.email.is_empty());

        let mut named = sample_contact("", "erika@example.org", "");
        named.first_name = "erika".to_string();
        named.last_name = "mustermann".to_string();
        clean_imported_contact_name(&mut named);
        assert_eq!(named.first_name, "Erika");
        assert_eq!(named.last_name, "Mustermann");
        assert_eq!(named.display_name, "Erika Mustermann");
    }

    #[test]
    fn full_local_reset_clears_every_persisted_table() {
        let mut conn = Connection::open_in_memory().expect("in-memory database");
        conn.execute_batch(
            "
            PRAGMA foreign_keys = ON;
            CREATE TABLE contacts (id INTEGER PRIMARY KEY AUTOINCREMENT);
            CREATE TABLE groups (id INTEGER PRIMARY KEY AUTOINCREMENT);
            CREATE TABLE contact_groups (
                contact_id INTEGER NOT NULL REFERENCES contacts(id) ON DELETE CASCADE,
                group_id INTEGER NOT NULL REFERENCES groups(id) ON DELETE CASCADE
            );
            CREATE TABLE import_history (id INTEGER PRIMARY KEY AUTOINCREMENT);
            CREATE TABLE app_settings (key TEXT PRIMARY KEY);
            CREATE TABLE mail_accounts (id INTEGER PRIMARY KEY AUTOINCREMENT);
            CREATE TABLE vault_entries (id INTEGER PRIMARY KEY AUTOINCREMENT);
            CREATE TABLE vault_config (id INTEGER PRIMARY KEY);
            INSERT INTO contacts DEFAULT VALUES;
            INSERT INTO groups DEFAULT VALUES;
            INSERT INTO contact_groups VALUES (1, 1);
            INSERT INTO import_history DEFAULT VALUES;
            INSERT INTO app_settings VALUES ('migration');
            INSERT INTO mail_accounts DEFAULT VALUES;
            INSERT INTO vault_entries DEFAULT VALUES;
            INSERT INTO vault_config VALUES (1);
            ",
        )
        .expect("test schema and data");

        clear_local_database(&mut conn).expect("full local reset");

        for table in [
            "contact_groups",
            "contacts",
            "groups",
            "import_history",
            "app_settings",
            "mail_accounts",
            "vault_entries",
            "vault_config",
        ] {
            let count: i64 = conn
                .query_row(&format!("SELECT COUNT(*) FROM {table}"), [], |row| {
                    row.get(0)
                })
                .expect("table count");
            assert_eq!(count, 0, "{table} should be empty");
        }
    }

    #[test]
    fn bulk_contact_delete_is_atomic_and_counts_only_active_contacts() {
        let mut conn = Connection::open_in_memory().expect("in-memory database");
        conn.execute_batch(
            "
            CREATE TABLE contacts (
                id INTEGER PRIMARY KEY,
                updated_at TEXT NOT NULL,
                deleted_at TEXT
            );
            INSERT INTO contacts (id, updated_at, deleted_at) VALUES
                (1, 'before', NULL),
                (2, 'before', NULL),
                (3, 'before', NULL);
            ",
        )
        .expect("test contacts");

        let deleted = soft_delete_contacts(&mut conn, &[1, 2, 2, 999], "2026-07-28T12:00:00Z")
            .expect("bulk delete");

        assert_eq!(deleted, 2);
        let active: i64 = conn
            .query_row(
                "SELECT COUNT(*) FROM contacts WHERE deleted_at IS NULL",
                [],
                |row| row.get(0),
            )
            .expect("active count");
        assert_eq!(active, 1);
        let deleted_with_timestamp: i64 = conn
            .query_row(
                "SELECT COUNT(*) FROM contacts
                 WHERE deleted_at = '2026-07-28T12:00:00Z'
                   AND updated_at = '2026-07-28T12:00:00Z'",
                [],
                |row| row.get(0),
            )
            .expect("deleted timestamp count");
        assert_eq!(deleted_with_timestamp, 2);
    }

    #[test]
    fn backup_restore_rejects_edv_transfer_state() {
        let mut conn = Connection::open_in_memory().expect("in-memory database");
        conn.execute_batch(
            "
            CREATE TABLE app_settings (
                key TEXT PRIMARY KEY,
                value TEXT NOT NULL,
                updated_at TEXT NOT NULL
            );
            INSERT INTO app_settings VALUES
                ('theme', 'old', 'before'),
                ('migration_capture_v2_completed_at', 'keep-me', 'before'),
                ('m365_token_bundle_v1', 'keep-token', 'before'),
                ('m365_connection_profile_v1', 'keep-profile', 'before');
            ",
        )
        .expect("test settings");

        let tx = conn.transaction().expect("transaction");
        restore_backup_settings(
            &tx,
            vec![
                AppSetting {
                    key: "theme".to_string(),
                    value: "new".to_string(),
                },
                AppSetting {
                    key: "migration_capture_v2_completed_at".to_string(),
                    value: "must-not-be-restored".to_string(),
                },
                AppSetting {
                    key: "m365_token_bundle_v1".to_string(),
                    value: "must-not-be-restored".to_string(),
                },
            ],
        )
        .expect("restore settings");
        tx.commit().expect("commit");

        let theme: String = conn
            .query_row(
                "SELECT value FROM app_settings WHERE key = 'theme'",
                [],
                |row| row.get(0),
            )
            .expect("theme");
        let transfer_state: String = conn
            .query_row(
                "SELECT value FROM app_settings
                 WHERE key = 'migration_capture_v2_completed_at'",
                [],
                |row| row.get(0),
            )
            .expect("transfer state");
        let m365_token: String = conn
            .query_row(
                "SELECT value FROM app_settings
                 WHERE key = 'm365_token_bundle_v1'",
                [],
                |row| row.get(0),
            )
            .expect("Microsoft 365 token");
        assert_eq!(theme, "new");
        assert_eq!(transfer_state, "keep-me");
        assert_eq!(m365_token, "keep-token");
    }

    #[test]
    fn normalizes_german_phone_numbers_for_duplicate_checks() {
        assert_eq!(
            normalize_phone_for_match("+49 (7034) 12 34"),
            normalize_phone_for_match("07034 / 1234")
        );
    }

    #[test]
    fn skips_only_contacts_with_every_persisted_field_equal() {
        let existing = sample_contact("Erika Muster", "erika@example.org", "07034 1234");
        let mut fingerprints = ContactFingerprintIndex::default();
        add_fingerprint(
            &mut fingerprints,
            &existing,
            "Erika Muster",
            "erika@example.org",
        );
        let candidate = sample_contact("Erika Muster", "ERIKA@example.org", "07034 1234");
        let (status, _, _) = classify_outlook_contact(
            &fingerprints,
            &candidate,
            "Erika Muster",
            "erika@example.org",
        );
        assert_eq!(status, "duplicate_exact");
    }

    #[test]
    fn autocomplete_recipient_is_skipped_when_its_email_already_exists() {
        let existing = sample_contact("Erika Muster", "erika@example.org", "07034 1234");
        let mut fingerprints = ContactFingerprintIndex::default();
        add_fingerprint(
            &mut fingerprints,
            &existing,
            "Erika Muster",
            "erika@example.org",
        );
        let autocomplete: OutlookContactRecord = serde_json::from_value(serde_json::json!({
            "sourceKind": "autocomplete",
            "displayName": "Anderer Anzeigename",
            "email": "erika@example.org"
        }))
        .unwrap();
        let candidate = outlook_record_to_contact(&autocomplete);
        let (status, _, existing_name) = classify_outlook_import_record(
            &fingerprints,
            &autocomplete,
            &candidate,
            "Anderer Anzeigename",
            "erika@example.org",
        );

        assert_eq!(status, "duplicate_exact");
        assert_eq!(existing_name.as_deref(), Some("Erika Muster"));
    }

    #[test]
    fn preserves_same_email_when_one_letter_or_address_differs() {
        let mut existing = sample_contact("Erika Muster", "erika@example.org", "07034 1234");
        existing.street = "Hauptstraße 1".to_string();
        let mut fingerprints = ContactFingerprintIndex::default();
        add_fingerprint(
            &mut fingerprints,
            &existing,
            "Erika Muster",
            "erika@example.org",
        );

        let different_letter = sample_contact("Erika Mustar", "erika@example.org", "07034 1234");
        let (letter_status, _, _) = classify_outlook_contact(
            &fingerprints,
            &different_letter,
            "Erika Mustar",
            "erika@example.org",
        );
        assert_eq!(letter_status, "different");

        let without_address = sample_contact("Erika Muster", "erika@example.org", "07034 1234");
        let (address_status, _, _) = classify_outlook_contact(
            &fingerprints,
            &without_address,
            "Erika Muster",
            "erika@example.org",
        );
        assert_eq!(address_status, "different");
    }

    #[test]
    fn preserves_same_phone_or_name_when_any_field_differs() {
        let existing = sample_contact("Erika Muster", "", "07034 1234");
        let mut fingerprints = ContactFingerprintIndex::default();
        add_fingerprint(&mut fingerprints, &existing, "Erika Muster", "");

        let same_phone = sample_contact("E. Muster", "", "+49 7034 1234");
        let (phone_status, _, _) =
            classify_outlook_contact(&fingerprints, &same_phone, "E. Muster", "");
        assert_eq!(phone_status, "different");

        let mut same_name = sample_contact("Erika Muster", "", "");
        same_name.city = "Aidlingen".to_string();
        let (name_status, _, _) =
            classify_outlook_contact(&fingerprints, &same_name, "Erika Muster", "");
        assert_eq!(name_status, "different");
    }

    #[test]
    fn accepts_outlook_empty_collections_serialized_as_objects() {
        let json = r#"{
          "events": {
            "title": "Serientermin",
            "startsAt": "2026-07-22T09:00:00",
            "recurrence": {
              "frequency": "yearly",
              "interval": 1,
              "daysOfWeek": {}
            },
            "excludedDates": {}
          },
          "skipped": 0
        }"#;
        let parsed: OutlookCalendarReadData = serde_json::from_str(json).unwrap();
        assert_eq!(parsed.events.len(), 1);
        assert!(parsed.events[0].excluded_dates.is_empty());
        assert!(parsed.events[0]
            .recurrence
            .as_ref()
            .unwrap()
            .days_of_week
            .is_empty());
    }

    #[test]
    fn outlook_preview_separates_calendars_and_detects_cross_calendar_duplicates() {
        let event = |store_id: &str, folder_path: &str, entry_id: &str, title: &str| {
            OutlookAppointmentRecord {
                entry_id: entry_id.to_string(),
                store_id: store_id.to_string(),
                store_name: store_id.to_string(),
                folder_path: folder_path.to_string(),
                global_appointment_id: String::new(),
                title: title.to_string(),
                starts_at: "2026-08-20T09:00:00".to_string(),
                ends_at: "2026-08-20T10:00:00".to_string(),
                location: "Büro".to_string(),
                description: String::new(),
                category: String::new(),
                color: "blue".to_string(),
                recurrence: None,
                excluded_dates: Vec::new(),
            }
        };
        let preview = build_outlook_calendar_preview(&OutlookCalendarReadData {
            calendars: vec![
                OutlookCalendarRecord {
                    id: "store-a|\\Kalender".to_string(),
                    store_id: "store-a".to_string(),
                    store_name: "Outlook A".to_string(),
                    folder_path: "\\Kalender".to_string(),
                    name: "Kalender".to_string(),
                },
                OutlookCalendarRecord {
                    id: "store-b|\\Kalender".to_string(),
                    store_id: "store-b".to_string(),
                    store_name: "Outlook B".to_string(),
                    folder_path: "\\Kalender".to_string(),
                    name: "Kalender".to_string(),
                },
            ],
            events: vec![
                event("store-a", "\\Kalender", "a-1", "Gemeinsamer Termin"),
                event("store-b", "\\Kalender", "b-1", "Gemeinsamer Termin"),
                event("store-a", "\\Kalender", "a-2", "Nur in A"),
            ],
            skipped: 0,
        });

        assert_eq!(preview.calendars.len(), 2);
        assert_eq!(preview.total_events, 3);
        assert_eq!(preview.duplicate_groups.len(), 1);
        assert_eq!(preview.duplicate_groups[0].occurrence_count, 2);
        assert_eq!(preview.duplicate_groups[0].calendars.len(), 2);
    }

    #[test]
    fn automatic_backup_keeps_deleted_contact_and_calendar_event() {
        let previous_contact = Contact {
            id: Some(7),
            first_name: "Erika".to_string(),
            last_name: "Mustermann".to_string(),
            display_name: "Erika Mustermann".to_string(),
            email: "erika@example.org".to_string(),
            phone: String::new(),
            mobile_phone: String::new(),
            street: String::new(),
            postal_code: String::new(),
            city: String::new(),
            country: String::new(),
            short_info: String::new(),
            notes: "Vorherige Notiz".to_string(),
            groups: Vec::new(),
            created_at: "2026-08-18T10:00:00Z".to_string(),
            updated_at: "2026-08-18T10:00:00Z".to_string(),
            deleted_at: None,
        };
        let previous_event = CalendarEvent {
            id: "event-7".to_string(),
            updated_at: "2026-08-18T10:00:00Z".to_string(),
            title: "Besprechung".to_string(),
            starts_at: "2026-08-18T10:00:00".to_string(),
            ends_at: "2026-08-18T11:00:00".to_string(),
            location: String::new(),
            description: "Vorherige Beschreibung".to_string(),
            color: "blue".to_string(),
            category: String::new(),
            source: "test".to_string(),
            recurrence: None,
            excluded_dates: Vec::new(),
            deleted_at: None,
            recurrence_master_id: None,
            recurrence_id: None,
        };
        let mut previous_storage = HashMap::new();
        previous_storage.insert(
            "agendakontakte.calendarEvents".to_string(),
            serde_json::to_string(&vec![previous_event]).expect("previous event"),
        );
        let previous = BackupData {
            version: "2.0.0".to_string(),
            exported_at: "2026-08-18T10:00:00Z".to_string(),
            contacts: vec![previous_contact],
            groups: Vec::new(),
            settings: Vec::new(),
            browser_storage: previous_storage,
        };

        let mut current_storage = HashMap::new();
        current_storage.insert(
            "agendakontakte.calendarEvents".to_string(),
            "[]".to_string(),
        );
        current_storage.insert(
            "agendakontakte.deletedCalendarEvents".to_string(),
            "[]".to_string(),
        );
        let merged = merge_automatic_backup(
            Some(previous),
            BackupData {
                version: "2.0.0".to_string(),
                exported_at: "2026-08-18T10:01:00Z".to_string(),
                contacts: Vec::new(),
                groups: Vec::new(),
                settings: Vec::new(),
                browser_storage: current_storage,
            },
        )
        .expect("merge automatic backup");

        assert_eq!(merged.contacts.len(), 1);
        assert_eq!(
            merged.contacts[0].notes,
            "Vorherige Notiz\nGelöschtes Element"
        );
        let deleted_events: Vec<CalendarEvent> = serde_json::from_str(
            merged
                .browser_storage
                .get("agendakontakte.deletedCalendarEvents")
                .expect("deleted calendar events"),
        )
        .expect("parse deleted events");
        assert_eq!(deleted_events.len(), 1);
        assert_eq!(
            deleted_events[0].description,
            "Vorherige Beschreibung\nGelöschtes Element"
        );
    }

    #[test]
    fn backup_folders_are_separated_by_release_channel() {
        assert_eq!(
            automatic_backup_folder(None),
            "DMH Kontakte und Kalender\\Automatische Sicherung"
        );
        assert_eq!(
            automatic_backup_folder(Some("stable")),
            "DMH Kontakte und Kalender\\Automatische Sicherung"
        );
        assert_eq!(
            automatic_backup_folder(Some("admin-test")),
            "DMH Kontakte und Kalender Admin Test\\Automatische Sicherung"
        );
    }

    #[test]
    fn json_backup_replacement_uses_unique_temporary_files() {
        let directory =
            env::temp_dir().join(format!("agendakontakte-backup-test-{}", Uuid::new_v4()));
        fs::create_dir_all(&directory).expect("create backup test directory");
        let path = directory.join("backup.json");

        replace_json_file(&path, "{\"version\":1}").expect("write first backup");
        replace_json_file(&path, "{\"version\":2}").expect("replace backup");

        assert_eq!(
            fs::read_to_string(&path).expect("read replaced backup"),
            "{\"version\":2}"
        );
        assert!(fs::read_dir(&directory)
            .expect("read backup test directory")
            .all(|entry| !entry
                .expect("read backup test entry")
                .file_name()
                .to_string_lossy()
                .ends_with(".tmp")));
        fs::remove_dir_all(directory).expect("remove backup test directory");
    }
}
