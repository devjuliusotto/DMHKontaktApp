use chrono::Utc;
use rusqlite::{params, Connection, OptionalExtension};
use serde::{Deserialize, Serialize};
use std::env;
use std::fs;
use std::path::PathBuf;
use std::process::Command;
use std::sync::Mutex;
use tauri::{AppHandle, Manager};

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

#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BackupData {
    pub version: String,
    pub exported_at: String,
    pub contacts: Vec<Contact>,
    pub groups: Vec<Group>,
    pub settings: Vec<AppSetting>,
}

#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AppSetting {
    pub key: String,
    pub value: String,
}

#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CalendarEvent {
    pub id: String,
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
    pub errors: usize,
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
    entry_id: String,
    #[serde(default)]
    store_id: String,
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
    contacts: Vec<OutlookContactRecord>,
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
    outlook_entry_id: Option<String>,
    outlook_store_id: Option<String>,
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
    errors: usize,
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
    Connection::open(db_path).map_err(|err| err.to_string())
}

fn init_db(app: &AppHandle) -> Result<(), String> {
    let app_dir = app
        .path()
        .app_data_dir()
        .map_err(|err| format!("App-Datenverzeichnis konnte nicht erstellt werden: {err}"))?;
    fs::create_dir_all(&app_dir).map_err(|err| err.to_string())?;
    let db_path = app_dir.join("agendakontakte.sqlite");

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
        ",
    )
    .map_err(|err| err.to_string())?;

    ensure_column(&conn, "contacts", "deleted_at", "TEXT")?;
    ensure_column(&conn, "contacts", "short_info", "TEXT NOT NULL DEFAULT ''")?;
    ensure_column(&conn, "contacts", "outlook_entry_id", "TEXT")?;
    ensure_column(&conn, "contacts", "outlook_store_id", "TEXT")?;
    ensure_column(&conn, "groups", "deleted_at", "TEXT")?;
    conn.execute_batch(
        "
        DROP INDEX IF EXISTS idx_contacts_email_unique;
        ",
    )
    .map_err(|err| err.to_string())?;

    create_auto_backup(&conn, &app_dir)?;
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

fn create_auto_backup(conn: &Connection, app_dir: &PathBuf) -> Result<(), String> {
    let backup_dir = app_dir.join("backups");
    fs::create_dir_all(&backup_dir).map_err(|err| err.to_string())?;
    let stamp = Utc::now().format("%Y%m%d-%H%M%S");
    let path = backup_dir.join(format!("auto-backup-{stamp}.json"));
    let data = load_backup_data(conn)?;
    let json = serde_json::to_string_pretty(&data).map_err(|err| err.to_string())?;
    fs::write(path, json).map_err(|err| err.to_string())
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
    delete_local_contact_from_outlook(&conn, id)?;
    conn.execute(
        "UPDATE contacts SET deleted_at = ?, updated_at = ? WHERE id = ?",
        params![now(), now(), id],
    )
    .map_err(|err| err.to_string())?;
    Ok(())
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
    let tx = conn.transaction().map_err(|err| err.to_string())?;
    let timestamp = now();
    let batch_id = format!("import-{}", Utc::now().timestamp_millis());
    let mut imported = 0usize;

    for contact in payload.contacts {
        let email = contact.email.trim().to_lowercase();
        let display_name = if contact.display_name.trim().is_empty() {
            format!("{} {}", contact.first_name.trim(), contact.last_name.trim())
                .trim()
                .to_string()
        } else {
            contact.display_name.trim().to_string()
        };

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
        params![batch_id, payload.source_file, imported as i64, 0, timestamp],
    )
    .map_err(|err| err.to_string())?;
    tx.commit().map_err(|err| err.to_string())?;

    Ok(ImportResult {
        imported,
        skipped_duplicates: 0,
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
            .prepare("SELECT key, value FROM app_settings ORDER BY key")
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
        version: "1.0.0".to_string(),
        exported_at: now(),
        contacts,
        groups,
        settings,
    })
}

#[tauri::command]
fn get_backup_data(app: AppHandle) -> Result<BackupData, String> {
    let conn = open_db(&app)?;
    load_backup_data(&conn)
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
    tx.execute("DELETE FROM app_settings", [])
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

    for setting in backup.settings {
        tx.execute(
            "INSERT INTO app_settings (key, value, updated_at) VALUES (?, ?, ?)",
            params![setting.key, setting.value, now()],
        )
        .map_err(|err| err.to_string())?;
    }

    tx.commit().map_err(|err| err.to_string())
}

#[tauri::command]
fn write_export_file(path: String, content: String) -> Result<(), String> {
    fs::write(&path, content).map_err(|err| format!("Datei konnte nicht geschrieben werden: {err}"))
}

#[tauri::command]
fn delete_all_contacts(app: AppHandle) -> Result<usize, String> {
    let conn = open_db(&app)?;
    let contact_ids = {
        let mut stmt = conn
            .prepare("SELECT id FROM contacts WHERE deleted_at IS NULL")
            .map_err(|err| err.to_string())?;
        let rows = stmt
            .query_map([], |row| row.get::<_, i64>(0))
            .map_err(|err| err.to_string())?;
        rows.collect::<Result<Vec<_>, _>>()
            .map_err(|err| err.to_string())?
    };

    for contact_id in &contact_ids {
        delete_local_contact_from_outlook(&conn, *contact_id)?;
    }

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

fn read_outlook_classic_contacts() -> Result<Vec<OutlookContactRecord>, String> {
    let script = r#"
$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
$outlook = New-Object -ComObject Outlook.Application
$namespace = $outlook.Session
$contactsFolder = $namespace.GetDefaultFolder(10)
$contacts = New-Object System.Collections.Generic.List[object]
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
function Read-Contact-Folders($folder) {
  try {
    $folderItems = $folder.Items
    for ($index = 1; $index -le $folderItems.Count; $index++) {
      try {
        $item = $folderItems.Item($index)
        $messageClass = [string]$item.MessageClass
        if ($messageClass -like 'IPM.Contact*') {
          $contacts.Add([pscustomobject]@{
            entryId = [string]$item.EntryID
            storeId = [string]$folder.StoreID
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
      } catch {}
    }
  } catch {}
  foreach ($child in @($folder.Folders)) { Read-Contact-Folders $child }
}
Read-Contact-Folders $contactsFolder
[pscustomobject]@{ contacts = $contacts; events = @() } | ConvertTo-Json -Depth 6 -Compress
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
    let data = serde_json::from_str::<OutlookReadData>(stdout.trim()).map_err(|err| {
        format!("Outlook-Kontakte konnten nicht ausgewertet werden: {err}. Ausgabe: {stdout}")
    })?;
    Ok(data.contacts)
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
                outlook_entry_id: row.get(13)?,
                outlook_store_id: row.get(14)?,
            })
        })
        .map_err(|err| err.to_string())?;

    rows.collect::<Result<Vec<_>, _>>()
        .map_err(|err| err.to_string())
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
                outlook_entry_id: row.get(13)?,
                outlook_store_id: row.get(14)?,
            })
        },
    )
    .optional()
    .map_err(|err| err.to_string())
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

fn push_local_contacts_to_outlook(conn: &mut Connection) -> Result<OutlookPushResult, String> {
    let contacts = load_local_outlook_contacts(conn)?;
    if contacts.is_empty() {
        return Ok(OutlookPushResult {
            total: 0,
            created: 0,
            updated: 0,
            linked: 0,
            errors: 0,
            folder_path: String::new(),
            store_name: String::new(),
        });
    }

    let json = serde_json::to_string(&contacts).map_err(|err| err.to_string())?;
    let json_path = env::temp_dir().join(format!(
        "agendakontakte-outlook-sync-{}.json",
        Utc::now().timestamp_millis()
    ));
    fs::write(&json_path, json).map_err(|err| err.to_string())?;
    let escaped_path = json_path.to_string_lossy().replace('\'', "''");
    let script = format!(
        r#"
$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
$contactsPath = '{escaped_path}'
$localContacts = @(Get-Content -LiteralPath $contactsPath -Raw -Encoding UTF8 | ConvertFrom-Json)
$outlook = New-Object -ComObject Outlook.Application
$namespace = $outlook.Session
$contactsFolder = $namespace.GetDefaultFolder(10)
$links = New-Object System.Collections.Generic.List[object]
$createdCount = 0
$updatedCount = 0
$errorCount = 0
$storeName = ''
try {{ $storeName = [string]$contactsFolder.Store.DisplayName }} catch {{}}

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

$allContacts = New-Object System.Collections.ArrayList
Read-Contact-Folders $contactsFolder $allContacts

foreach ($local in $localContacts) {{
  try {{
    $item = Find-Outlook-Contact $local $allContacts
    if ($null -eq $item) {{
      $item = $contactsFolder.Items.Add(2)
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

    $localId = [string](Get-Scalar $local.id)
    $links.Add([pscustomobject]@{{
      localId = $localId
      entryId = [string]$item.EntryID
      storeId = [string]$contactsFolder.StoreID
    }}) | Out-Null
  }} catch {{
    $errorCount++
  }}
}}

[pscustomobject]@{{
  links = $links
  created = $createdCount
  updated = $updatedCount
  errors = $errorCount
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
        total: contacts.len(),
        created: data.created,
        updated: data.updated,
        linked: data.links.len(),
        errors: data.errors,
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
fn sync_outlook_classic_contacts(app: AppHandle) -> Result<OutlookSyncResult, String> {
    let mut conn = open_db(&app)?;
    let pushed = push_local_contacts_to_outlook(&mut conn)?;
    let contacts = read_outlook_classic_contacts()?;
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
fn push_project_contacts_to_outlook(app: AppHandle) -> Result<OutlookPushResult, String> {
    let mut conn = open_db(&app)?;
    push_local_contacts_to_outlook(&mut conn)
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
          $events.Add([pscustomobject]@{{
            id = [string]$item.GlobalAppointmentID
            title = [string]$item.Subject
            startsAt = if ($item.Start) {{ ([datetime]$item.Start).ToString('o') }} else {{ '' }}
            endsAt = if ($item.End) {{ ([datetime]$item.End).ToString('o') }} else {{ '' }}
            location = [string]$item.Location
            description = [string]$item.Body
            color = 'blue'
            category = ''
            source = $path
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
            restore_contact,
            list_groups,
            list_deleted_groups,
            save_group,
            delete_group,
            restore_group,
            import_contacts,
            undo_last_import,
            get_backup_data,
            restore_backup,
            write_export_file,
            delete_all_contacts,
            add_contact_to_group,
            move_contact_to_group,
            clear_contact_groups,
            open_outlook_classic_email,
            open_new_outlook_email,
            open_outlook_classic_bulk_email,
            open_new_outlook_bulk_email,
            get_app_setting,
            set_app_setting,
            sync_outlook_classic_contacts,
            push_project_contacts_to_outlook,
            diagnose_outlook_contact_folders,
            import_outlook_store
        ])
        .run(tauri::generate_context!())
        .expect("Fehler beim Starten von AgendaKontakte");
}
