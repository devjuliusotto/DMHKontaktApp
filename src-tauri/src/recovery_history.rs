use crate::{AppSetting, BackupData, CalendarEvent, Contact, Group};
use chrono::{Duration as ChronoDuration, SecondsFormat, Utc};
use rusqlite::{params, params_from_iter, Connection, OptionalExtension, Transaction};
use serde::Serialize;
use sha2::{Digest, Sha256};
use std::collections::HashMap;
use std::fs;
use std::path::PathBuf;
use tauri::{AppHandle, Manager};

const HISTORY_FILE: &str = "recovery-history.sqlite";
const HISTORY_VERSION: &str = "1";
const BATCH_SIZE: usize = 1_000;
const ACTIVE_CALENDAR_KEY: &str = "agendakontakte.calendarEvents";
const DELETED_CALENDAR_KEY: &str = "agendakontakte.deletedCalendarEvents";

#[derive(Debug, Clone)]
pub(crate) struct HistoryRunSummary {
    pub id: String,
    pub created_at: String,
    pub contacts: usize,
    pub groups: usize,
    pub calendar_events: usize,
    pub size_bytes: u64,
}

#[derive(Debug, Clone)]
pub(crate) struct HistoryStatus {
    pub available: bool,
    pub latest_at: Option<String>,
    pub contacts: usize,
    pub groups: usize,
    pub calendar_events: usize,
    pub total_versions: usize,
    pub size_bytes: u64,
    pub runs: Vec<HistoryRunSummary>,
    pub location: String,
}

fn now() -> String {
    // Match SQLite's trigger timestamps so lexical comparisons remain correct.
    Utc::now().to_rfc3339_opts(SecondsFormat::Millis, true)
}

pub(crate) fn history_path(app: &AppHandle) -> Result<PathBuf, String> {
    let directory = app
        .path()
        .app_data_dir()
        .map_err(|error| {
            format!("Lokaler Sicherungsordner konnte nicht ermittelt werden: {error}")
        })?
        .join("backups");
    fs::create_dir_all(&directory).map_err(|error| {
        format!("Lokaler Sicherungsordner konnte nicht erstellt werden: {error}")
    })?;
    Ok(directory.join(HISTORY_FILE))
}

fn open_history(app: &AppHandle) -> Result<Connection, String> {
    let conn = Connection::open(history_path(app)?).map_err(|error| error.to_string())?;
    conn.execute_batch(
        "PRAGMA journal_mode = WAL;
         PRAGMA synchronous = NORMAL;
         PRAGMA busy_timeout = 5000;
         CREATE TABLE IF NOT EXISTS history_meta (
           key TEXT PRIMARY KEY,
           value TEXT NOT NULL
         );
         CREATE TABLE IF NOT EXISTS entity_versions (
           version_id INTEGER PRIMARY KEY AUTOINCREMENT,
           entity_kind TEXT NOT NULL,
           entity_id TEXT NOT NULL,
           payload_json TEXT NOT NULL,
           content_hash TEXT NOT NULL,
           source_updated_at TEXT NOT NULL,
           recorded_at TEXT NOT NULL,
           is_deleted INTEGER NOT NULL DEFAULT 0
         );
         CREATE INDEX IF NOT EXISTS idx_history_entity
           ON entity_versions(entity_kind, entity_id, version_id DESC);
         CREATE INDEX IF NOT EXISTS idx_history_recorded
           ON entity_versions(recorded_at DESC);
         CREATE TABLE IF NOT EXISTS entity_latest (
           entity_kind TEXT NOT NULL,
           entity_id TEXT NOT NULL,
           version_id INTEGER NOT NULL,
           content_hash TEXT NOT NULL,
           source_updated_at TEXT NOT NULL,
           is_deleted INTEGER NOT NULL DEFAULT 0,
           PRIMARY KEY(entity_kind, entity_id),
           FOREIGN KEY(version_id) REFERENCES entity_versions(version_id)
         );
         CREATE TABLE IF NOT EXISTS backup_runs (
           run_id TEXT PRIMARY KEY,
           created_at TEXT NOT NULL,
           max_version_id INTEGER NOT NULL,
           changed_entities INTEGER NOT NULL,
           contacts INTEGER NOT NULL,
           groups INTEGER NOT NULL,
           calendar_events INTEGER NOT NULL
         );",
    )
    .map_err(|error| error.to_string())?;
    conn.execute(
        "INSERT INTO history_meta(key, value) VALUES('schema_version', ?1)
         ON CONFLICT(key) DO UPDATE SET value = excluded.value",
        params![HISTORY_VERSION],
    )
    .map_err(|error| error.to_string())?;
    Ok(conn)
}

fn content_hash(json: &str) -> String {
    let mut hasher = Sha256::new();
    hasher.update(json.as_bytes());
    format!("{:x}", hasher.finalize())
}

fn record_json<T: Serialize>(
    tx: &Transaction<'_>,
    kind: &str,
    id: &str,
    payload: &T,
    source_updated_at: &str,
    is_deleted: bool,
    recorded_at: &str,
) -> Result<bool, String> {
    let json = serde_json::to_string(payload).map_err(|error| error.to_string())?;
    let hash = content_hash(&json);
    let previous_hash = tx
        .query_row(
            "SELECT content_hash FROM entity_latest WHERE entity_kind = ?1 AND entity_id = ?2",
            params![kind, id],
            |row| row.get::<_, String>(0),
        )
        .optional()
        .map_err(|error| error.to_string())?;
    if previous_hash.as_deref() == Some(hash.as_str()) {
        return Ok(false);
    }
    tx.execute(
        "INSERT INTO entity_versions(
           entity_kind, entity_id, payload_json, content_hash, source_updated_at, recorded_at, is_deleted
         ) VALUES(?1, ?2, ?3, ?4, ?5, ?6, ?7)",
        params![kind, id, json, hash, source_updated_at, recorded_at, is_deleted],
    )
    .map_err(|error| error.to_string())?;
    let version_id = tx.last_insert_rowid();
    tx.execute(
        "INSERT INTO entity_latest(entity_kind, entity_id, version_id, content_hash, source_updated_at, is_deleted)
         VALUES(?1, ?2, ?3, ?4, ?5, ?6)
         ON CONFLICT(entity_kind, entity_id) DO UPDATE SET
           version_id = excluded.version_id,
           content_hash = excluded.content_hash,
           source_updated_at = excluded.source_updated_at,
           is_deleted = excluded.is_deleted",
        params![kind, id, version_id, hash, source_updated_at, is_deleted],
    )
    .map_err(|error| error.to_string())?;
    Ok(true)
}

fn meta_value(conn: &Connection, key: &str) -> Result<Option<String>, String> {
    conn.query_row(
        "SELECT value FROM history_meta WHERE key = ?1",
        params![key],
        |row| row.get(0),
    )
    .optional()
    .map_err(|error| error.to_string())
}

fn set_meta(tx: &Transaction<'_>, key: &str, value: &str) -> Result<(), String> {
    tx.execute(
        "INSERT INTO history_meta(key, value) VALUES(?1, ?2)
         ON CONFLICT(key) DO UPDATE SET value = excluded.value",
        params![key, value],
    )
    .map_err(|error| error.to_string())?;
    Ok(())
}

fn groups_for_contacts(
    source: &Connection,
    contact_ids: &[i64],
) -> Result<HashMap<i64, Vec<Group>>, String> {
    if contact_ids.is_empty() {
        return Ok(HashMap::new());
    }
    let placeholders = std::iter::repeat_n("?", contact_ids.len())
        .collect::<Vec<_>>()
        .join(",");
    let mut statement = source
        .prepare(&format!(
            "SELECT cg.contact_id, g.id, g.name, g.description, g.created_at, g.updated_at, g.deleted_at
             FROM contact_groups cg
             JOIN groups g ON g.id = cg.group_id
             WHERE cg.contact_id IN ({placeholders})
             ORDER BY g.name COLLATE NOCASE"
        ))
        .map_err(|error| error.to_string())?;
    let rows = statement
        .query_map(params_from_iter(contact_ids.iter()), |row| {
            Ok((
                row.get::<_, i64>(0)?,
                Group {
                    id: Some(row.get(1)?),
                    name: row.get(2)?,
                    description: row.get(3)?,
                    created_at: row.get(4)?,
                    updated_at: row.get(5)?,
                    deleted_at: row.get(6)?,
                },
            ))
        })
        .map_err(|error| error.to_string())?;
    let mut result = HashMap::<i64, Vec<Group>>::new();
    for row in rows {
        let (contact_id, group) = row.map_err(|error| error.to_string())?;
        result.entry(contact_id).or_default().push(group);
    }
    Ok(result)
}

fn sync_contacts(
    source: &Connection,
    history: &mut Connection,
    lower: &str,
    upper: &str,
    recorded_at: &str,
) -> Result<usize, String> {
    let mut cursor_time = lower.to_string();
    let mut cursor_id = 0i64;
    let mut changed = 0usize;
    loop {
        let mut statement = source
            .prepare(
                "SELECT id, first_name, last_name, display_name, email, private_email,
                        second_private_email, phone, mobile_phone, private_phone,
                        second_private_phone, company, street, postal_code, city, country,
                        short_info, notes, created_at, updated_at, deleted_at
                 FROM contacts
                 WHERE (updated_at > ?1 OR (updated_at = ?1 AND id > ?2))
                   AND updated_at <= ?3
                 ORDER BY updated_at, id
                 LIMIT ?4",
            )
            .map_err(|error| error.to_string())?;
        let rows = statement
            .query_map(
                params![cursor_time, cursor_id, upper, BATCH_SIZE as i64],
                |row| {
                    Ok(Contact {
                        id: Some(row.get(0)?),
                        first_name: row.get(1)?,
                        last_name: row.get(2)?,
                        display_name: row.get(3)?,
                        email: row.get(4)?,
                        private_email: row.get(5)?,
                        second_private_email: row.get(6)?,
                        phone: row.get(7)?,
                        mobile_phone: row.get(8)?,
                        private_phone: row.get(9)?,
                        second_private_phone: row.get(10)?,
                        company: row.get(11)?,
                        street: row.get(12)?,
                        postal_code: row.get(13)?,
                        city: row.get(14)?,
                        country: row.get(15)?,
                        short_info: row.get(16)?,
                        notes: row.get(17)?,
                        groups: Vec::new(),
                        created_at: row.get(18)?,
                        updated_at: row.get(19)?,
                        deleted_at: row.get(20)?,
                    })
                },
            )
            .map_err(|error| error.to_string())?;
        let mut contacts = rows
            .collect::<Result<Vec<_>, _>>()
            .map_err(|error| error.to_string())?;
        drop(statement);
        if contacts.is_empty() {
            break;
        }
        let ids = contacts
            .iter()
            .filter_map(|contact| contact.id)
            .collect::<Vec<_>>();
        let mut memberships = groups_for_contacts(source, &ids)?;
        let tx = history.transaction().map_err(|error| error.to_string())?;
        for contact in &mut contacts {
            let id = contact.id.unwrap_or_default();
            contact.groups = memberships.remove(&id).unwrap_or_default();
            changed += usize::from(record_json(
                &tx,
                "contact",
                &id.to_string(),
                contact,
                &contact.updated_at,
                contact.deleted_at.is_some(),
                recorded_at,
            )?);
        }
        tx.commit().map_err(|error| error.to_string())?;
        let last = contacts.last().expect("contact batch is not empty");
        cursor_time = last.updated_at.clone();
        cursor_id = last.id.unwrap_or_default();
        if contacts.len() < BATCH_SIZE {
            break;
        }
    }
    Ok(changed)
}

fn sync_groups(
    source: &Connection,
    history: &mut Connection,
    lower: &str,
    upper: &str,
    recorded_at: &str,
) -> Result<usize, String> {
    let mut cursor_time = lower.to_string();
    let mut cursor_id = 0i64;
    let mut changed = 0usize;
    loop {
        let mut statement = source
            .prepare(
                "SELECT id, name, description, created_at, updated_at, deleted_at
                 FROM groups
                 WHERE (updated_at > ?1 OR (updated_at = ?1 AND id > ?2))
                   AND updated_at <= ?3
                 ORDER BY updated_at, id
                 LIMIT ?4",
            )
            .map_err(|error| error.to_string())?;
        let groups = statement
            .query_map(
                params![cursor_time, cursor_id, upper, BATCH_SIZE as i64],
                |row| {
                    Ok(Group {
                        id: Some(row.get(0)?),
                        name: row.get(1)?,
                        description: row.get(2)?,
                        created_at: row.get(3)?,
                        updated_at: row.get(4)?,
                        deleted_at: row.get(5)?,
                    })
                },
            )
            .map_err(|error| error.to_string())?
            .collect::<Result<Vec<_>, _>>()
            .map_err(|error| error.to_string())?;
        drop(statement);
        if groups.is_empty() {
            break;
        }
        let tx = history.transaction().map_err(|error| error.to_string())?;
        for group in &groups {
            changed += usize::from(record_json(
                &tx,
                "group",
                &group.id.unwrap_or_default().to_string(),
                group,
                &group.updated_at,
                group.deleted_at.is_some(),
                recorded_at,
            )?);
        }
        tx.commit().map_err(|error| error.to_string())?;
        let last = groups.last().expect("group batch is not empty");
        cursor_time = last.updated_at.clone();
        cursor_id = last.id.unwrap_or_default();
        if groups.len() < BATCH_SIZE {
            break;
        }
    }
    Ok(changed)
}

fn sync_calendar(
    source: &Connection,
    history: &mut Connection,
    lower: &str,
    upper: &str,
    recorded_at: &str,
) -> Result<usize, String> {
    let mut cursor_time = lower.to_string();
    let mut cursor_id = String::new();
    let mut changed = 0usize;
    loop {
        let mut statement = source
            .prepare(
                "SELECT id, event_json, updated_at, deleted_at
                 FROM calendar_events
                 WHERE (updated_at > ?1 OR (updated_at = ?1 AND id > ?2))
                   AND updated_at <= ?3
                 ORDER BY updated_at, id
                 LIMIT ?4",
            )
            .map_err(|error| error.to_string())?;
        let rows = statement
            .query_map(
                params![cursor_time, cursor_id, upper, BATCH_SIZE as i64],
                |row| {
                    Ok((
                        row.get::<_, String>(0)?,
                        row.get::<_, String>(1)?,
                        row.get::<_, String>(2)?,
                        row.get::<_, Option<String>>(3)?,
                    ))
                },
            )
            .map_err(|error| error.to_string())?
            .collect::<Result<Vec<_>, _>>()
            .map_err(|error| error.to_string())?;
        drop(statement);
        if rows.is_empty() {
            break;
        }
        let tx = history.transaction().map_err(|error| error.to_string())?;
        for (id, json, updated_at, deleted_at) in &rows {
            let mut event = serde_json::from_str::<CalendarEvent>(json)
                .map_err(|error| format!("Termin {id} konnte nicht gesichert werden: {error}"))?;
            event.updated_at = updated_at.clone();
            event.deleted_at = deleted_at.clone();
            changed += usize::from(record_json(
                &tx,
                "calendar",
                id,
                &event,
                updated_at,
                deleted_at.is_some(),
                recorded_at,
            )?);
        }
        tx.commit().map_err(|error| error.to_string())?;
        let last = rows.last().expect("calendar batch is not empty");
        cursor_id = last.0.clone();
        cursor_time = last.2.clone();
        if rows.len() < BATCH_SIZE {
            break;
        }
    }
    Ok(changed)
}

fn sync_settings(
    source: &Connection,
    history: &mut Connection,
    lower: &str,
    upper: &str,
    recorded_at: &str,
) -> Result<usize, String> {
    let mut statement = source
        .prepare(
            "SELECT key, value, updated_at FROM app_settings
             WHERE updated_at > ?1 AND updated_at <= ?2
             ORDER BY updated_at, key",
        )
        .map_err(|error| error.to_string())?;
    let rows = statement
        .query_map(params![lower, upper], |row| {
            Ok((
                AppSetting {
                    key: row.get(0)?,
                    value: row.get(1)?,
                },
                row.get::<_, String>(2)?,
            ))
        })
        .map_err(|error| error.to_string())?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|error| error.to_string())?;
    let tx = history.transaction().map_err(|error| error.to_string())?;
    let mut changed = 0usize;
    for (setting, updated_at) in rows {
        changed += usize::from(record_json(
            &tx,
            "setting",
            &setting.key,
            &setting,
            &updated_at,
            false,
            recorded_at,
        )?);
    }
    tx.commit().map_err(|error| error.to_string())?;
    Ok(changed)
}

fn current_counts(history: &Connection) -> Result<(usize, usize, usize), String> {
    let count = |kind: &str| {
        history
            .query_row(
                "SELECT COUNT(*) FROM entity_latest WHERE entity_kind = ?1",
                params![kind],
                |row| row.get::<_, usize>(0),
            )
            .map_err(|error| error.to_string())
    };
    Ok((count("contact")?, count("group")?, count("calendar")?))
}

fn compact_old_history(history: &Connection) -> Result<(), String> {
    let cutoff =
        (Utc::now() - ChronoDuration::days(365)).to_rfc3339_opts(SecondsFormat::Millis, true);
    // Keep every recent edit, the current version forever, and one older
    // baseline per entity so recent points can still be reconstructed.
    history
        .execute(
            "DELETE FROM entity_versions
             WHERE recorded_at < ?1
               AND version_id NOT IN (SELECT version_id FROM entity_latest)
               AND version_id NOT IN (
                 SELECT MAX(version_id) FROM entity_versions
                 WHERE recorded_at < ?1 GROUP BY entity_kind, entity_id
               )",
            params![cutoff],
        )
        .map_err(|error| error.to_string())?;
    history
        .execute(
            "DELETE FROM backup_runs WHERE created_at < ?1",
            params![cutoff],
        )
        .map_err(|error| error.to_string())?;
    Ok(())
}

fn pending_ids(source: &Connection, kind: &str, upper: &str) -> Result<Vec<String>, String> {
    let mut statement = source
        .prepare(
            "SELECT entity_id FROM backup_change_log
             WHERE entity_kind = ?1 AND changed_at <= ?2
             ORDER BY changed_at, entity_id LIMIT ?3",
        )
        .map_err(|error| error.to_string())?;
    let ids = statement
        .query_map(params![kind, upper, BATCH_SIZE as i64], |row| row.get(0))
        .map_err(|error| error.to_string())?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|error| error.to_string())?;
    Ok(ids)
}

fn clear_pending_ids(
    source: &Connection,
    kind: &str,
    ids: &[String],
    upper: &str,
) -> Result<(), String> {
    let tx = source
        .unchecked_transaction()
        .map_err(|error| error.to_string())?;
    for id in ids {
        tx.execute(
            "DELETE FROM backup_change_log
             WHERE entity_kind = ?1 AND entity_id = ?2 AND changed_at <= ?3",
            params![kind, id, upper],
        )
        .map_err(|error| error.to_string())?;
    }
    tx.commit().map_err(|error| error.to_string())
}

fn sync_pending_contacts(
    source: &Connection,
    history: &mut Connection,
    upper: &str,
    recorded_at: &str,
) -> Result<usize, String> {
    let mut changed = 0usize;
    loop {
        let ids = pending_ids(source, "contact", upper)?;
        if ids.is_empty() {
            break;
        }
        let numeric_ids = ids
            .iter()
            .filter_map(|id| id.parse::<i64>().ok())
            .collect::<Vec<_>>();
        let mut contacts = Vec::new();
        if !numeric_ids.is_empty() {
            let placeholders = std::iter::repeat_n("?", numeric_ids.len())
                .collect::<Vec<_>>()
                .join(",");
            let mut statement = source
                .prepare(&format!(
                    "SELECT id, first_name, last_name, display_name, email, private_email,
                            second_private_email, phone, mobile_phone, private_phone,
                            second_private_phone, company, street, postal_code, city, country,
                            short_info, notes, created_at, updated_at, deleted_at
                     FROM contacts WHERE id IN ({placeholders})"
                ))
                .map_err(|error| error.to_string())?;
            contacts = statement
                .query_map(params_from_iter(numeric_ids.iter()), |row| {
                    Ok(Contact {
                        id: Some(row.get(0)?),
                        first_name: row.get(1)?,
                        last_name: row.get(2)?,
                        display_name: row.get(3)?,
                        email: row.get(4)?,
                        private_email: row.get(5)?,
                        second_private_email: row.get(6)?,
                        phone: row.get(7)?,
                        mobile_phone: row.get(8)?,
                        private_phone: row.get(9)?,
                        second_private_phone: row.get(10)?,
                        company: row.get(11)?,
                        street: row.get(12)?,
                        postal_code: row.get(13)?,
                        city: row.get(14)?,
                        country: row.get(15)?,
                        short_info: row.get(16)?,
                        notes: row.get(17)?,
                        groups: Vec::new(),
                        created_at: row.get(18)?,
                        updated_at: row.get(19)?,
                        deleted_at: row.get(20)?,
                    })
                })
                .map_err(|error| error.to_string())?
                .collect::<Result<Vec<_>, _>>()
                .map_err(|error| error.to_string())?;
        }
        let mut memberships = groups_for_contacts(source, &numeric_ids)?;
        let tx = history.transaction().map_err(|error| error.to_string())?;
        for contact in &mut contacts {
            let id = contact.id.unwrap_or_default();
            contact.groups = memberships.remove(&id).unwrap_or_default();
            changed += usize::from(record_json(
                &tx,
                "contact",
                &id.to_string(),
                contact,
                &contact.updated_at,
                contact.deleted_at.is_some(),
                recorded_at,
            )?);
        }
        tx.commit().map_err(|error| error.to_string())?;
        clear_pending_ids(source, "contact", &ids, upper)?;
    }
    Ok(changed)
}

fn sync_pending_groups(
    source: &Connection,
    history: &mut Connection,
    upper: &str,
    recorded_at: &str,
) -> Result<usize, String> {
    let mut changed = 0usize;
    loop {
        let ids = pending_ids(source, "group", upper)?;
        if ids.is_empty() {
            break;
        }
        let numeric_ids = ids
            .iter()
            .filter_map(|id| id.parse::<i64>().ok())
            .collect::<Vec<_>>();
        if !numeric_ids.is_empty() {
            let placeholders = std::iter::repeat_n("?", numeric_ids.len())
                .collect::<Vec<_>>()
                .join(",");
            let mut statement = source
                .prepare(&format!("SELECT id, name, description, created_at, updated_at, deleted_at FROM groups WHERE id IN ({placeholders})"))
                .map_err(|error| error.to_string())?;
            let groups = statement
                .query_map(params_from_iter(numeric_ids.iter()), |row| {
                    Ok(Group {
                        id: Some(row.get(0)?),
                        name: row.get(1)?,
                        description: row.get(2)?,
                        created_at: row.get(3)?,
                        updated_at: row.get(4)?,
                        deleted_at: row.get(5)?,
                    })
                })
                .map_err(|error| error.to_string())?
                .collect::<Result<Vec<_>, _>>()
                .map_err(|error| error.to_string())?;
            let tx = history.transaction().map_err(|error| error.to_string())?;
            for group in groups {
                changed += usize::from(record_json(
                    &tx,
                    "group",
                    &group.id.unwrap_or_default().to_string(),
                    &group,
                    &group.updated_at,
                    group.deleted_at.is_some(),
                    recorded_at,
                )?);
            }
            tx.commit().map_err(|error| error.to_string())?;
        }
        clear_pending_ids(source, "group", &ids, upper)?;
    }
    Ok(changed)
}

fn sync_pending_calendar(
    source: &Connection,
    history: &mut Connection,
    upper: &str,
    recorded_at: &str,
) -> Result<usize, String> {
    let mut changed = 0usize;
    loop {
        let ids = pending_ids(source, "calendar", upper)?;
        if ids.is_empty() {
            break;
        }
        let placeholders = std::iter::repeat_n("?", ids.len())
            .collect::<Vec<_>>()
            .join(",");
        let mut statement = source
            .prepare(&format!("SELECT id, event_json, updated_at, deleted_at FROM calendar_events WHERE id IN ({placeholders})"))
            .map_err(|error| error.to_string())?;
        let rows = statement
            .query_map(params_from_iter(ids.iter()), |row| {
                Ok((
                    row.get::<_, String>(0)?,
                    row.get::<_, String>(1)?,
                    row.get::<_, String>(2)?,
                    row.get::<_, Option<String>>(3)?,
                ))
            })
            .map_err(|error| error.to_string())?
            .collect::<Result<Vec<_>, _>>()
            .map_err(|error| error.to_string())?;
        drop(statement);
        let tx = history.transaction().map_err(|error| error.to_string())?;
        for (id, json, updated_at, deleted_at) in rows {
            let mut event = serde_json::from_str::<CalendarEvent>(&json)
                .map_err(|error| format!("Termin {id} konnte nicht gesichert werden: {error}"))?;
            event.updated_at = updated_at.clone();
            event.deleted_at = deleted_at.clone();
            changed += usize::from(record_json(
                &tx,
                "calendar",
                &id,
                &event,
                &updated_at,
                deleted_at.is_some(),
                recorded_at,
            )?);
        }
        tx.commit().map_err(|error| error.to_string())?;
        clear_pending_ids(source, "calendar", &ids, upper)?;
    }
    Ok(changed)
}

fn sync_pending_settings(
    source: &Connection,
    history: &mut Connection,
    upper: &str,
    recorded_at: &str,
) -> Result<usize, String> {
    let mut changed = 0usize;
    loop {
        let ids = pending_ids(source, "setting", upper)?;
        if ids.is_empty() {
            break;
        }
        let placeholders = std::iter::repeat_n("?", ids.len())
            .collect::<Vec<_>>()
            .join(",");
        let mut statement = source
            .prepare(&format!(
                "SELECT key, value, updated_at FROM app_settings WHERE key IN ({placeholders})"
            ))
            .map_err(|error| error.to_string())?;
        let rows = statement
            .query_map(params_from_iter(ids.iter()), |row| {
                Ok((
                    AppSetting {
                        key: row.get(0)?,
                        value: row.get(1)?,
                    },
                    row.get::<_, String>(2)?,
                ))
            })
            .map_err(|error| error.to_string())?
            .collect::<Result<Vec<_>, _>>()
            .map_err(|error| error.to_string())?;
        drop(statement);
        let tx = history.transaction().map_err(|error| error.to_string())?;
        for (setting, updated_at) in rows {
            changed += usize::from(record_json(
                &tx,
                "setting",
                &setting.key,
                &setting,
                &updated_at,
                false,
                recorded_at,
            )?);
        }
        tx.commit().map_err(|error| error.to_string())?;
        clear_pending_ids(source, "setting", &ids, upper)?;
    }
    Ok(changed)
}

pub(crate) fn sync_from_app_database(
    app: &AppHandle,
    source: &Connection,
    browser_storage: HashMap<String, String>,
) -> Result<usize, String> {
    let mut history = open_history(app)?;
    let lower = meta_value(&history, "last_sync_started_at")?.unwrap_or_default();
    let upper = now();
    let recorded_at = upper.clone();
    let mut changed = 0usize;
    if lower.is_empty() {
        changed += sync_contacts(source, &mut history, &lower, &upper, &recorded_at)?;
        changed += sync_groups(source, &mut history, &lower, &upper, &recorded_at)?;
        changed += sync_calendar(source, &mut history, &lower, &upper, &recorded_at)?;
        changed += sync_settings(source, &mut history, &lower, &upper, &recorded_at)?;
        source
            .execute(
                "DELETE FROM backup_change_log WHERE changed_at <= ?1",
                params![upper],
            )
            .map_err(|error| error.to_string())?;
    } else {
        changed += sync_pending_contacts(source, &mut history, &upper, &recorded_at)?;
        changed += sync_pending_groups(source, &mut history, &upper, &recorded_at)?;
        changed += sync_pending_calendar(source, &mut history, &upper, &recorded_at)?;
        changed += sync_pending_settings(source, &mut history, &upper, &recorded_at)?;
    }

    if !browser_storage.is_empty() {
        let tx = history.transaction().map_err(|error| error.to_string())?;
        for (key, value) in browser_storage {
            if key == ACTIVE_CALENDAR_KEY || key == DELETED_CALENDAR_KEY {
                continue;
            }
            changed += usize::from(record_json(
                &tx,
                "browser",
                &key,
                &value,
                &upper,
                false,
                &recorded_at,
            )?);
        }
        tx.commit().map_err(|error| error.to_string())?;
    }

    let tx = history.transaction().map_err(|error| error.to_string())?;
    set_meta(&tx, "last_sync_started_at", &upper)?;
    if changed > 0 {
        let max_version_id = tx
            .query_row(
                "SELECT COALESCE(MAX(version_id), 0) FROM entity_versions",
                [],
                |row| row.get::<_, i64>(0),
            )
            .map_err(|error| error.to_string())?;
        let (contacts, groups, calendar_events) = current_counts(&tx)?;
        let run_id = format!("history-{max_version_id}");
        tx.execute(
            "INSERT OR IGNORE INTO backup_runs(
               run_id, created_at, max_version_id, changed_entities, contacts, groups, calendar_events
             ) VALUES(?1, ?2, ?3, ?4, ?5, ?6, ?7)",
            params![run_id, upper, max_version_id, changed, contacts, groups, calendar_events],
        )
        .map_err(|error| error.to_string())?;
    }
    tx.commit().map_err(|error| error.to_string())?;
    compact_old_history(&history)?;
    history
        .execute_batch("PRAGMA wal_checkpoint(PASSIVE);")
        .map_err(|error| error.to_string())?;
    Ok(changed)
}

pub(crate) fn import_legacy_backup(app: &AppHandle, backup: &BackupData) -> Result<usize, String> {
    let mut history = open_history(app)?;
    let already_imported = meta_value(&history, "legacy_imported")?.as_deref() == Some("true");
    if already_imported {
        return Ok(0);
    }
    let recorded_at = backup.exported_at.clone();
    let tx = history.transaction().map_err(|error| error.to_string())?;
    let mut changed = 0usize;
    for contact in &backup.contacts {
        changed += usize::from(record_json(
            &tx,
            "contact",
            &contact.id.map(|id| id.to_string()).unwrap_or_else(|| {
                format!(
                    "legacy-{}",
                    Utc::now().timestamp_nanos_opt().unwrap_or_default()
                )
            }),
            contact,
            &contact.updated_at,
            contact.deleted_at.is_some(),
            &recorded_at,
        )?);
    }
    for group in &backup.groups {
        changed += usize::from(record_json(
            &tx,
            "group",
            &group.id.map(|id| id.to_string()).unwrap_or_else(|| {
                format!(
                    "legacy-{}",
                    Utc::now().timestamp_nanos_opt().unwrap_or_default()
                )
            }),
            group,
            &group.updated_at,
            group.deleted_at.is_some(),
            &recorded_at,
        )?);
    }
    for setting in &backup.settings {
        changed += usize::from(record_json(
            &tx,
            "setting",
            &setting.key,
            setting,
            &recorded_at,
            false,
            &recorded_at,
        )?);
    }
    for (key, value) in &backup.browser_storage {
        if key == ACTIVE_CALENDAR_KEY || key == DELETED_CALENDAR_KEY {
            let events = serde_json::from_str::<Vec<CalendarEvent>>(value).unwrap_or_default();
            for event in events {
                changed += usize::from(record_json(
                    &tx,
                    "calendar",
                    &event.id,
                    &event,
                    &event.updated_at,
                    event.deleted_at.is_some() || key == DELETED_CALENDAR_KEY,
                    &recorded_at,
                )?);
            }
        } else {
            changed += usize::from(record_json(
                &tx,
                "browser",
                key,
                value,
                &recorded_at,
                false,
                &recorded_at,
            )?);
        }
    }
    set_meta(&tx, "legacy_imported", "true")?;
    if changed > 0 {
        let max_version_id = tx
            .query_row(
                "SELECT COALESCE(MAX(version_id), 0) FROM entity_versions",
                [],
                |row| row.get::<_, i64>(0),
            )
            .map_err(|error| error.to_string())?;
        let (contacts, groups, calendar_events) = current_counts(&tx)?;
        tx.execute(
            "INSERT OR IGNORE INTO backup_runs(run_id, created_at, max_version_id, changed_entities, contacts, groups, calendar_events)
             VALUES(?1, ?2, ?3, ?4, ?5, ?6, ?7)",
            params![format!("legacy-{max_version_id}"), recorded_at, max_version_id, changed, contacts, groups, calendar_events],
        )
        .map_err(|error| error.to_string())?;
    }
    tx.commit().map_err(|error| error.to_string())?;
    Ok(changed)
}

fn max_version_for_run(history: &Connection, run_id: Option<&str>) -> Result<i64, String> {
    if let Some(run_id) = run_id {
        return history
            .query_row(
                "SELECT max_version_id FROM backup_runs WHERE run_id = ?1",
                params![run_id],
                |row| row.get(0),
            )
            .optional()
            .map_err(|error| error.to_string())?
            .ok_or_else(|| "Der gewählte Sicherungszeitpunkt wurde nicht gefunden.".to_string());
    }
    history
        .query_row(
            "SELECT COALESCE(MAX(version_id), 0) FROM entity_versions",
            [],
            |row| row.get(0),
        )
        .map_err(|error| error.to_string())
}

fn read_payloads(
    history: &Connection,
    kind: &str,
    max_version: i64,
) -> Result<Vec<String>, String> {
    let mut statement = history
        .prepare(
            "SELECT v.payload_json
             FROM entity_versions v
             JOIN (
               SELECT entity_kind, entity_id, MAX(version_id) AS version_id
               FROM entity_versions
               WHERE entity_kind = ?1 AND version_id <= ?2
               GROUP BY entity_kind, entity_id
             ) latest ON latest.version_id = v.version_id
             ORDER BY v.entity_id",
        )
        .map_err(|error| error.to_string())?;
    let payloads = statement
        .query_map(params![kind, max_version], |row| row.get::<_, String>(0))
        .map_err(|error| error.to_string())?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|error| error.to_string())?;
    Ok(payloads)
}

pub(crate) fn load_backup(app: &AppHandle, run_id: Option<&str>) -> Result<BackupData, String> {
    let history = open_history(app)?;
    let max_version = max_version_for_run(&history, run_id)?;
    if max_version == 0 {
        return Err("Es ist noch kein lokaler Sicherungsverlauf vorhanden.".to_string());
    }
    let contacts = read_payloads(&history, "contact", max_version)?
        .into_iter()
        .map(|json| serde_json::from_str::<Contact>(&json).map_err(|error| error.to_string()))
        .collect::<Result<Vec<_>, _>>()?;
    let groups = read_payloads(&history, "group", max_version)?
        .into_iter()
        .map(|json| serde_json::from_str::<Group>(&json).map_err(|error| error.to_string()))
        .collect::<Result<Vec<_>, _>>()?;
    let settings = read_payloads(&history, "setting", max_version)?
        .into_iter()
        .map(|json| serde_json::from_str::<AppSetting>(&json).map_err(|error| error.to_string()))
        .collect::<Result<Vec<_>, _>>()?;
    let events = read_payloads(&history, "calendar", max_version)?
        .into_iter()
        .map(|json| serde_json::from_str::<CalendarEvent>(&json).map_err(|error| error.to_string()))
        .collect::<Result<Vec<_>, _>>()?;
    let (active, deleted): (Vec<_>, Vec<_>) = events
        .into_iter()
        .partition(|event| event.deleted_at.is_none());
    let mut browser_storage = HashMap::new();
    browser_storage.insert(
        ACTIVE_CALENDAR_KEY.to_string(),
        serde_json::to_string(&active).map_err(|error| error.to_string())?,
    );
    browser_storage.insert(
        DELETED_CALENDAR_KEY.to_string(),
        serde_json::to_string(&deleted).map_err(|error| error.to_string())?,
    );
    let mut browser_statement = history
        .prepare(
            "SELECT v.entity_id, v.payload_json
             FROM entity_versions v
             JOIN (
               SELECT entity_id, MAX(version_id) AS version_id
               FROM entity_versions
               WHERE entity_kind = 'browser' AND version_id <= ?1
               GROUP BY entity_id
             ) latest ON latest.version_id = v.version_id",
        )
        .map_err(|error| error.to_string())?;
    let browser_rows = browser_statement
        .query_map(params![max_version], |row| {
            Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?))
        })
        .map_err(|error| error.to_string())?;
    for row in browser_rows {
        let (key, json) = row.map_err(|error| error.to_string())?;
        browser_storage.insert(
            key,
            serde_json::from_str::<String>(&json).map_err(|error| error.to_string())?,
        );
    }
    let exported_at = run_id
        .and_then(|id| {
            history
                .query_row(
                    "SELECT created_at FROM backup_runs WHERE run_id = ?1",
                    params![id],
                    |row| row.get::<_, String>(0),
                )
                .ok()
        })
        .or_else(|| {
            history
                .query_row(
                    "SELECT created_at FROM backup_runs ORDER BY max_version_id DESC LIMIT 1",
                    [],
                    |row| row.get::<_, String>(0),
                )
                .ok()
        })
        .unwrap_or_else(now);
    Ok(BackupData {
        version: "3.0.0".to_string(),
        exported_at,
        contacts,
        groups,
        settings,
        browser_storage,
    })
}

pub(crate) fn status(app: &AppHandle) -> Result<HistoryStatus, String> {
    let path = history_path(app)?;
    let history = open_history(app)?;
    let latest = history
        .query_row(
            "SELECT created_at, contacts, groups, calendar_events FROM backup_runs ORDER BY max_version_id DESC LIMIT 1",
            [],
            |row| Ok((row.get::<_, String>(0)?, row.get::<_, usize>(1)?, row.get::<_, usize>(2)?, row.get::<_, usize>(3)?)),
        )
        .optional()
        .map_err(|error| error.to_string())?;
    let total_versions = history
        .query_row("SELECT COUNT(*) FROM entity_versions", [], |row| {
            row.get::<_, usize>(0)
        })
        .map_err(|error| error.to_string())?;
    let mut statement = history
        .prepare(
            "SELECT run_id, created_at, contacts, groups, calendar_events
             FROM backup_runs ORDER BY max_version_id DESC LIMIT 24",
        )
        .map_err(|error| error.to_string())?;
    let runs = statement
        .query_map([], |row| {
            Ok(HistoryRunSummary {
                id: row.get(0)?,
                created_at: row.get(1)?,
                contacts: row.get(2)?,
                groups: row.get(3)?,
                calendar_events: row.get(4)?,
                size_bytes: 0,
            })
        })
        .map_err(|error| error.to_string())?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|error| error.to_string())?;
    let size_bytes = fs::metadata(&path)
        .map(|metadata| metadata.len())
        .unwrap_or(0);
    let (latest_at, contacts, groups, calendar_events) = latest
        .map(|item| (Some(item.0), item.1, item.2, item.3))
        .unwrap_or((None, 0, 0, 0));
    Ok(HistoryStatus {
        available: latest_at.is_some(),
        latest_at,
        contacts,
        groups,
        calendar_events,
        total_versions,
        size_bytes,
        runs,
        location: path.display().to_string(),
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn history_connection() -> Connection {
        let conn = Connection::open_in_memory().unwrap();
        conn.execute_batch(
            "CREATE TABLE entity_versions (
               version_id INTEGER PRIMARY KEY AUTOINCREMENT, entity_kind TEXT, entity_id TEXT,
               payload_json TEXT, content_hash TEXT, source_updated_at TEXT, recorded_at TEXT, is_deleted INTEGER
             );
             CREATE TABLE entity_latest (
               entity_kind TEXT, entity_id TEXT, version_id INTEGER, content_hash TEXT,
               source_updated_at TEXT, is_deleted INTEGER, PRIMARY KEY(entity_kind, entity_id)
             );",
        )
        .unwrap();
        conn
    }

    #[test]
    fn identical_payload_is_not_recorded_twice() {
        let mut conn = history_connection();
        let tx = conn.transaction().unwrap();
        assert!(record_json(&tx, "browser", "theme", &"light", "1", false, "1").unwrap());
        tx.commit().unwrap();
        let tx = conn.transaction().unwrap();
        assert!(!record_json(&tx, "browser", "theme", &"light", "2", false, "2").unwrap());
        tx.commit().unwrap();
        assert_eq!(
            conn.query_row("SELECT COUNT(*) FROM entity_versions", [], |row| row
                .get::<_, i64>(0))
                .unwrap(),
            1
        );
    }

    #[test]
    fn change_log_captures_old_dated_import_and_keeps_tombstone_after_purge() {
        let source = Connection::open_in_memory().unwrap();
        source
            .execute_batch(
                "CREATE TABLE calendar_events (
                   id TEXT PRIMARY KEY, event_json TEXT NOT NULL, updated_at TEXT NOT NULL, deleted_at TEXT
                 );
                 CREATE TABLE backup_change_log (
                   entity_kind TEXT NOT NULL, entity_id TEXT NOT NULL, changed_at TEXT NOT NULL,
                   PRIMARY KEY(entity_kind, entity_id)
                 );
                 CREATE TRIGGER calendar_insert AFTER INSERT ON calendar_events BEGIN
                   INSERT INTO backup_change_log VALUES('calendar', NEW.id, strftime('%Y-%m-%dT%H:%M:%fZ','now'))
                   ON CONFLICT(entity_kind, entity_id) DO UPDATE SET changed_at = excluded.changed_at;
                 END;
                 CREATE TRIGGER calendar_update AFTER UPDATE ON calendar_events BEGIN
                   INSERT INTO backup_change_log VALUES('calendar', NEW.id, strftime('%Y-%m-%dT%H:%M:%fZ','now'))
                   ON CONFLICT(entity_kind, entity_id) DO UPDATE SET changed_at = excluded.changed_at;
                 END;
                 CREATE TRIGGER calendar_delete BEFORE DELETE ON calendar_events BEGIN
                   INSERT INTO backup_change_log VALUES('calendar', OLD.id, strftime('%Y-%m-%dT%H:%M:%fZ','now'))
                   ON CONFLICT(entity_kind, entity_id) DO UPDATE SET changed_at = excluded.changed_at;
                 END;",
            )
            .unwrap();
        let active_json = r#"{"id":"old-import","updatedAt":"2001-01-01T00:00:00Z","title":"Alt importiert","startsAt":"2026-01-01T10:00:00Z","endsAt":"2026-01-01T11:00:00Z","isAllDay":false,"location":"","description":"","color":"blue","category":"","source":"ICS","excludedDates":[],"deletedAt":null,"meeting":{}}"#;
        source
            .execute(
                "INSERT INTO calendar_events VALUES(?1, ?2, ?3, NULL)",
                params!["old-import", active_json, "2001-01-01T00:00:00Z"],
            )
            .unwrap();
        let mut history = history_connection();
        assert_eq!(
            sync_pending_calendar(
                &source,
                &mut history,
                "9999-12-31T23:59:59.999Z",
                "2026-09-24T12:00:00.000Z"
            )
            .unwrap(),
            1
        );

        let deleted_json = active_json.replace(
            "\"deletedAt\":null",
            "\"deletedAt\":\"2026-09-24T12:01:00Z\"",
        );
        source
            .execute(
                "UPDATE calendar_events SET event_json = ?1, updated_at = ?2, deleted_at = ?2 WHERE id = ?3",
                params![deleted_json, "2026-09-24T12:01:00Z", "old-import"],
            )
            .unwrap();
        assert_eq!(
            sync_pending_calendar(
                &source,
                &mut history,
                "9999-12-31T23:59:59.999Z",
                "2026-09-24T12:01:01.000Z"
            )
            .unwrap(),
            1
        );
        source.execute("DELETE FROM calendar_events", []).unwrap();
        assert_eq!(
            sync_pending_calendar(
                &source,
                &mut history,
                "9999-12-31T23:59:59.999Z",
                "2026-09-24T12:02:00.000Z"
            )
            .unwrap(),
            0
        );
        let (versions, deleted): (i64, i64) = history
            .query_row(
                "SELECT COUNT(*), (SELECT is_deleted FROM entity_latest WHERE entity_kind = 'calendar' AND entity_id = 'old-import') FROM entity_versions",
                [],
                |row| Ok((row.get(0)?, row.get(1)?)),
            )
            .unwrap();
        assert_eq!(versions, 2);
        assert_eq!(deleted, 1);
    }
}
