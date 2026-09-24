use crate::{
    default_calendar_color, normalized_calendar_duplicate_key, now, open_db, AppState,
    CalendarEvent, CalendarMeetingOptions, CalendarRecurrence,
};
use chrono::{Days, NaiveDate};
use encoding_rs::WINDOWS_1252;
use rusqlite::{params, Connection, OptionalExtension, Transaction};
use serde::Serialize;
use sha2::{Digest, Sha256};
use std::collections::{HashMap, HashSet};
use std::fs::{self, File};
use std::io::{BufRead, BufReader, Seek, SeekFrom};
use std::path::{Path, PathBuf};
use std::sync::atomic::Ordering;
use std::time::UNIX_EPOCH;
use tauri::{AppHandle, Emitter, Manager};
use uuid::Uuid;

const IMPORT_BATCH_SIZE: usize = 1_000;
const PROGRESS_EVENT: &str = "calendar-file-import-progress";

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CalendarFileImportStatus {
    pub job_id: String,
    pub file_path: String,
    pub file_name: String,
    pub file_size: u64,
    pub byte_offset: u64,
    pub processed: usize,
    pub imported: usize,
    pub skipped_same_id: usize,
    pub skipped_exact_duplicates: usize,
    pub skipped_invalid: usize,
    pub status: String,
    pub progress_percent: f64,
    pub fallback_category: String,
    pub fallback_color: String,
    pub resumable: bool,
    pub last_error: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CalendarImportCategory {
    pub name: String,
    pub color: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CalendarFileImportResult {
    #[serde(flatten)]
    pub status: CalendarFileImportStatus,
    pub categories: Vec<CalendarImportCategory>,
}

#[derive(Debug, Clone)]
struct ImportJob {
    id: String,
    file_path: String,
    file_name: String,
    file_size: u64,
    file_modified_ms: u64,
    fallback_category: String,
    fallback_color: String,
    byte_offset: u64,
    processed: usize,
    imported: usize,
    skipped_same_id: usize,
    skipped_exact_duplicates: usize,
    skipped_invalid: usize,
    status: String,
    last_error: Option<String>,
}

#[derive(Default)]
struct BatchMergeResult {
    imported: usize,
    skipped_same_id: usize,
    skipped_exact_duplicates: usize,
    skipped_invalid: usize,
}

#[derive(Clone, Default)]
struct IcsGlobals {
    category: String,
    color: String,
}

#[derive(Clone)]
struct ParsedEvent {
    event: CalendarEvent,
    uid: String,
}

#[derive(Clone)]
enum ParsedItem {
    Event(ParsedEvent),
    Ignored,
    Invalid,
}

enum StreamOutcome {
    Completed,
    Paused,
}

fn progress_percent(offset: u64, size: u64) -> f64 {
    if size == 0 {
        return 0.0;
    }
    ((offset.min(size) as f64 / size as f64) * 100.0).clamp(0.0, 100.0)
}

impl ImportJob {
    fn status(&self) -> CalendarFileImportStatus {
        CalendarFileImportStatus {
            job_id: self.id.clone(),
            file_path: self.file_path.clone(),
            file_name: self.file_name.clone(),
            file_size: self.file_size,
            byte_offset: self.byte_offset,
            processed: self.processed,
            imported: self.imported,
            skipped_same_id: self.skipped_same_id,
            skipped_exact_duplicates: self.skipped_exact_duplicates,
            skipped_invalid: self.skipped_invalid,
            status: self.status.clone(),
            progress_percent: progress_percent(self.byte_offset, self.file_size),
            fallback_category: self.fallback_category.clone(),
            fallback_color: self.fallback_color.clone(),
            resumable: matches!(self.status.as_str(), "prepared" | "paused" | "failed"),
            last_error: self.last_error.clone(),
        }
    }
}

fn file_modified_ms(metadata: &fs::Metadata) -> u64 {
    metadata
        .modified()
        .ok()
        .and_then(|value| value.duration_since(UNIX_EPOCH).ok())
        .map(|value| value.as_millis().min(u128::from(u64::MAX)) as u64)
        .unwrap_or(0)
}

fn canonical_import_path(path: &str) -> Result<PathBuf, String> {
    let candidate = PathBuf::from(path);
    let canonical = candidate
        .canonicalize()
        .map_err(|error| format!("Kalenderdatei konnte nicht geöffnet werden: {error}"))?;
    if !canonical.is_file() {
        return Err("Die ausgewählte Kalenderdatei existiert nicht mehr.".to_string());
    }
    let supported = canonical
        .extension()
        .and_then(|value| value.to_str())
        .is_some_and(|value| matches!(value.to_ascii_lowercase().as_str(), "ics" | "eml"));
    if !supported {
        return Err(
            "Für den sicheren Großimport werden ICS- oder EML-Dateien unterstützt.".to_string(),
        );
    }
    Ok(canonical)
}

fn row_to_job(row: &rusqlite::Row<'_>) -> rusqlite::Result<ImportJob> {
    Ok(ImportJob {
        id: row.get(0)?,
        file_path: row.get(1)?,
        file_name: row.get(2)?,
        file_size: row.get::<_, i64>(3)?.max(0) as u64,
        file_modified_ms: row.get::<_, i64>(4)?.max(0) as u64,
        fallback_category: row.get(5)?,
        fallback_color: row.get(6)?,
        byte_offset: row.get::<_, i64>(7)?.max(0) as u64,
        processed: row.get::<_, i64>(8)?.max(0) as usize,
        imported: row.get::<_, i64>(9)?.max(0) as usize,
        skipped_same_id: row.get::<_, i64>(10)?.max(0) as usize,
        skipped_exact_duplicates: row.get::<_, i64>(11)?.max(0) as usize,
        skipped_invalid: row.get::<_, i64>(12)?.max(0) as usize,
        status: row.get(13)?,
        last_error: row.get(14)?,
    })
}

const JOB_COLUMNS: &str = "id, file_path, file_name, file_size, file_modified_ms,
    fallback_category, fallback_color, byte_offset, processed, imported,
    skipped_same_id, skipped_exact_duplicates, skipped_invalid, status, last_error";

fn load_job(conn: &Connection, id: &str) -> Result<Option<ImportJob>, String> {
    conn.query_row(
        &format!("SELECT {JOB_COLUMNS} FROM calendar_file_import_jobs WHERE id = ?1"),
        [id],
        row_to_job,
    )
    .optional()
    .map_err(|error| error.to_string())
}

fn load_latest_pending_job(conn: &Connection) -> Result<Option<ImportJob>, String> {
    conn.query_row(
        &format!(
            "SELECT {JOB_COLUMNS} FROM calendar_file_import_jobs
             WHERE status IN ('prepared', 'running', 'paused', 'failed')
             ORDER BY updated_at DESC LIMIT 1"
        ),
        [],
        row_to_job,
    )
    .optional()
    .map_err(|error| error.to_string())
}

fn safe_color(value: &str) -> String {
    match value.trim().to_ascii_lowercase().as_str() {
        "green" => "green".to_string(),
        "yellow" => "yellow".to_string(),
        "red" => "red".to_string(),
        "purple" => "purple".to_string(),
        "gray" => "gray".to_string(),
        _ => default_calendar_color(),
    }
}

#[tauri::command]
pub fn prepare_calendar_file_import(
    app: AppHandle,
    path: String,
    fallback_category: String,
    fallback_color: String,
) -> Result<CalendarFileImportStatus, String> {
    if app
        .state::<AppState>()
        .calendar_import_running
        .load(Ordering::SeqCst)
    {
        return Err("Ein Kalenderimport läuft bereits.".to_string());
    }
    let canonical = canonical_import_path(&path)?;
    let metadata = canonical.metadata().map_err(|error| error.to_string())?;
    let canonical_string = canonical.to_string_lossy().to_string();
    let file_name = canonical
        .file_name()
        .and_then(|value| value.to_str())
        .unwrap_or("Kalender.ics")
        .to_string();
    let size = metadata.len();
    let modified_ms = file_modified_ms(&metadata);
    let category = fallback_category.trim().to_string();
    let color = safe_color(&fallback_color);
    let conn = open_db(&app)?;
    let existing = conn
        .query_row(
            &format!(
                "SELECT {JOB_COLUMNS} FROM calendar_file_import_jobs
                 WHERE file_path = ?1 AND file_size = ?2 AND file_modified_ms = ?3
                   AND fallback_category = ?4 AND fallback_color = ?5
                   AND status IN ('prepared', 'running', 'paused', 'failed')
                 ORDER BY updated_at DESC LIMIT 1"
            ),
            params![
                canonical_string,
                size as i64,
                modified_ms as i64,
                category,
                color
            ],
            row_to_job,
        )
        .optional()
        .map_err(|error| error.to_string())?;
    if let Some(mut job) = existing {
        if job.status == "running" {
            job.status = "paused".to_string();
            conn.execute(
                "UPDATE calendar_file_import_jobs SET status = 'paused', updated_at = ?2 WHERE id = ?1",
                params![job.id, now()],
            )
            .map_err(|error| error.to_string())?;
        }
        return Ok(job.status());
    }

    let id = Uuid::new_v4().to_string();
    conn.execute(
        "INSERT INTO calendar_file_import_jobs
         (id, file_path, file_name, file_size, file_modified_ms, fallback_category,
          fallback_color, status, created_at, updated_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, 'prepared', ?8, ?8)",
        params![
            id,
            canonical_string,
            file_name,
            size as i64,
            modified_ms as i64,
            category,
            color,
            now()
        ],
    )
    .map_err(|error| error.to_string())?;
    load_job(&conn, &id)?
        .map(|job| job.status())
        .ok_or_else(|| "Importauftrag konnte nicht angelegt werden.".to_string())
}

#[tauri::command]
pub fn get_pending_calendar_file_import(
    app: AppHandle,
) -> Result<Option<CalendarFileImportStatus>, String> {
    let conn = open_db(&app)?;
    let Some(mut job) = load_latest_pending_job(&conn)? else {
        return Ok(None);
    };
    if job.status == "running"
        && !app
            .state::<AppState>()
            .calendar_import_running
            .load(Ordering::SeqCst)
    {
        job.status = "paused".to_string();
        conn.execute(
            "UPDATE calendar_file_import_jobs SET status = 'paused', updated_at = ?2 WHERE id = ?1",
            params![job.id, now()],
        )
        .map_err(|error| error.to_string())?;
    }
    Ok(Some(job.status()))
}

#[tauri::command]
pub fn cancel_calendar_file_import(app: AppHandle, job_id: String) -> Result<(), String> {
    let conn = open_db(&app)?;
    if load_job(&conn, &job_id)?.is_none() {
        return Err("Der Importauftrag wurde nicht gefunden.".to_string());
    }
    app.state::<AppState>()
        .calendar_import_cancel_requested
        .store(true, Ordering::SeqCst);
    Ok(())
}

#[tauri::command]
pub fn discard_calendar_file_import(app: AppHandle, job_id: String) -> Result<(), String> {
    if app
        .state::<AppState>()
        .calendar_import_running
        .load(Ordering::SeqCst)
    {
        return Err("Der laufende Import muss zuerst pausiert werden.".to_string());
    }
    open_db(&app)?
        .execute(
            "DELETE FROM calendar_file_import_jobs WHERE id = ?1",
            [job_id],
        )
        .map_err(|error| error.to_string())?;
    Ok(())
}

#[tauri::command]
pub async fn run_calendar_file_import(
    app: AppHandle,
    job_id: String,
    fallback_category: String,
    fallback_color: String,
) -> Result<CalendarFileImportResult, String> {
    let state = app.state::<AppState>();
    if state
        .calendar_import_running
        .compare_exchange(false, true, Ordering::SeqCst, Ordering::SeqCst)
        .is_err()
    {
        return Err("Ein Kalenderimport läuft bereits.".to_string());
    }
    state
        .calendar_import_cancel_requested
        .store(false, Ordering::SeqCst);

    let worker_app = app.clone();
    let worker_job_id = job_id.clone();
    let result = tauri::async_runtime::spawn_blocking(move || {
        run_import_blocking(
            &worker_app,
            &worker_job_id,
            fallback_category.trim(),
            &safe_color(&fallback_color),
        )
    })
    .await
    .map_err(|error| format!("Kalenderimport wurde unerwartet beendet: {error}"));

    app.state::<AppState>()
        .calendar_import_running
        .store(false, Ordering::SeqCst);
    let outcome = match result {
        Ok(outcome) => outcome,
        Err(error) => Err(error),
    };
    if let Err(error) = &outcome {
        record_job_error(&app, &job_id, error);
    }
    outcome
}

fn record_job_error(app: &AppHandle, job_id: &str, error: &str) {
    let Ok(conn) = open_db(app) else { return };
    let Ok(Some(mut job)) = load_job(&conn, job_id) else {
        return;
    };
    if job.status == "completed" || job.status == "paused" {
        return;
    }
    job.status = "failed".to_string();
    job.last_error = Some(error.to_string());
    let _ = conn.execute(
        "UPDATE calendar_file_import_jobs SET status = 'failed', last_error = ?2, updated_at = ?3 WHERE id = ?1",
        params![job_id, error, now()],
    );
    emit_status(app, &job);
}

fn run_import_blocking(
    app: &AppHandle,
    job_id: &str,
    fallback_category: &str,
    fallback_color: &str,
) -> Result<CalendarFileImportResult, String> {
    let mut conn = open_db(app)?;
    let mut job = load_job(&conn, job_id)?
        .ok_or_else(|| "Der Importauftrag wurde nicht gefunden.".to_string())?;
    if job.status == "completed" {
        return import_result(&conn, job);
    }
    if job.byte_offset > 0
        && (job.fallback_category != fallback_category || job.fallback_color != fallback_color)
    {
        return Err(
            "Nach Beginn des Imports können Ersatzkategorie und Farbe nicht mehr geändert werden."
                .to_string(),
        );
    }
    if job.byte_offset == 0 {
        job.fallback_category = fallback_category.to_string();
        job.fallback_color = fallback_color.to_string();
    }

    let path = canonical_import_path(&job.file_path)?;
    let metadata = path.metadata().map_err(|error| error.to_string())?;
    if metadata.len() != job.file_size || file_modified_ms(&metadata) != job.file_modified_ms {
        return fail_job(
            app,
            &conn,
            &mut job,
            "Die Kalenderdatei wurde seit Beginn des Imports verändert. Bitte wählen Sie sie erneut aus.",
        );
    }
    conn.execute(
        "UPDATE calendar_file_import_jobs
         SET status = 'running', fallback_category = ?2, fallback_color = ?3,
             last_error = NULL, updated_at = ?4 WHERE id = ?1",
        params![job.id, job.fallback_category, job.fallback_color, now()],
    )
    .map_err(|error| error.to_string())?;
    job.status = "running".to_string();
    job.last_error = None;
    emit_status(app, &job);

    let globals = read_ics_globals(&path)?;
    let file = File::open(&path).map_err(|error| error.to_string())?;
    let mut reader = BufReader::with_capacity(128 * 1024, file);
    let source = job.file_name.clone();
    let start_offset = job.byte_offset;
    let import_job_id = job.id.clone();
    let import_category = job.fallback_category.clone();
    let import_color = job.fallback_color.clone();
    let outcome = stream_ics_batches(
        &mut reader,
        start_offset,
        &globals,
        &source,
        &import_job_id,
        &import_category,
        &import_color,
        || {
            app.state::<AppState>()
                .calendar_import_cancel_requested
                .load(Ordering::SeqCst)
        },
        |batch, offset| commit_batch(app, &mut conn, &mut job, batch, offset),
    )?;
    if matches!(outcome, StreamOutcome::Paused) {
        pause_job(app, &conn, &mut job)?;
        return import_result(&conn, job);
    }
    job.byte_offset = job.file_size;
    job.status = "completed".to_string();
    conn.execute(
        "UPDATE calendar_file_import_jobs
         SET byte_offset = file_size, status = 'completed', last_error = NULL, updated_at = ?2
         WHERE id = ?1",
        params![job.id, now()],
    )
    .map_err(|error| error.to_string())?;
    emit_status(app, &job);
    import_result(&conn, job)
}

fn fail_job(
    app: &AppHandle,
    conn: &Connection,
    job: &mut ImportJob,
    error: &str,
) -> Result<CalendarFileImportResult, String> {
    job.status = "failed".to_string();
    job.last_error = Some(error.to_string());
    conn.execute(
        "UPDATE calendar_file_import_jobs SET status = 'failed', last_error = ?2, updated_at = ?3 WHERE id = ?1",
        params![job.id, error, now()],
    )
    .map_err(|db_error| db_error.to_string())?;
    emit_status(app, job);
    Err(error.to_string())
}

fn pause_job(app: &AppHandle, conn: &Connection, job: &mut ImportJob) -> Result<(), String> {
    job.status = "paused".to_string();
    conn.execute(
        "UPDATE calendar_file_import_jobs SET status = 'paused', updated_at = ?2 WHERE id = ?1",
        params![job.id, now()],
    )
    .map_err(|error| error.to_string())?;
    emit_status(app, job);
    Ok(())
}

fn emit_status(app: &AppHandle, job: &ImportJob) {
    let _ = app.emit(PROGRESS_EVENT, job.status());
}

fn import_result(conn: &Connection, job: ImportJob) -> Result<CalendarFileImportResult, String> {
    let mut statement = conn
        .prepare(
            "SELECT name, color FROM calendar_file_import_categories
             WHERE job_id = ?1 ORDER BY name COLLATE NOCASE",
        )
        .map_err(|error| error.to_string())?;
    let categories = statement
        .query_map([&job.id], |row| {
            Ok(CalendarImportCategory {
                name: row.get(0)?,
                color: row.get(1)?,
            })
        })
        .map_err(|error| error.to_string())?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|error| error.to_string())?;
    Ok(CalendarFileImportResult {
        status: job.status(),
        categories,
    })
}

fn commit_batch(
    app: &AppHandle,
    conn: &mut Connection,
    job: &mut ImportJob,
    batch: &[ParsedItem],
    byte_offset: u64,
) -> Result<(), String> {
    let tx = conn.transaction().map_err(|error| error.to_string())?;
    let merged = merge_batch(&tx, &job.id, batch)?;
    let processed = job.processed + batch.len();
    let imported = job.imported + merged.imported;
    let skipped_same_id = job.skipped_same_id + merged.skipped_same_id;
    let skipped_exact_duplicates = job.skipped_exact_duplicates + merged.skipped_exact_duplicates;
    let skipped_invalid = job.skipped_invalid + merged.skipped_invalid;
    tx.execute(
        "UPDATE calendar_file_import_jobs SET
           fallback_category = ?2, fallback_color = ?3, byte_offset = ?4,
           processed = ?5, imported = ?6, skipped_same_id = ?7,
           skipped_exact_duplicates = ?8, skipped_invalid = ?9,
           status = 'running', last_error = NULL, updated_at = ?10
         WHERE id = ?1",
        params![
            job.id,
            job.fallback_category,
            job.fallback_color,
            byte_offset as i64,
            processed as i64,
            imported as i64,
            skipped_same_id as i64,
            skipped_exact_duplicates as i64,
            skipped_invalid as i64,
            now()
        ],
    )
    .map_err(|error| error.to_string())?;
    tx.commit().map_err(|error| error.to_string())?;
    job.byte_offset = byte_offset;
    job.processed = processed;
    job.imported = imported;
    job.skipped_same_id = skipped_same_id;
    job.skipped_exact_duplicates = skipped_exact_duplicates;
    job.skipped_invalid = skipped_invalid;
    emit_status(app, job);
    Ok(())
}

fn merge_batch(
    tx: &Transaction<'_>,
    job_id: &str,
    batch: &[ParsedItem],
) -> Result<BatchMergeResult, String> {
    let mut result = BatchMergeResult::default();
    let mut batch_ids = HashSet::new();
    let mut batch_duplicates = HashSet::new();
    for item in batch {
        let ParsedItem::Event(parsed) = item else {
            if matches!(item, ParsedItem::Invalid) {
                result.skipped_invalid += 1;
            }
            continue;
        };
        let event = &parsed.event;
        if event.id.trim().is_empty() || event.starts_at.trim().is_empty() {
            result.skipped_invalid += 1;
            continue;
        }
        if !event.category.trim().is_empty() {
            tx.execute(
                "INSERT INTO calendar_file_import_categories (job_id, name, color)
                 VALUES (?1, ?2, ?3)
                 ON CONFLICT(job_id, name) DO UPDATE SET color = excluded.color",
                params![job_id, event.category.trim(), event.color],
            )
            .map_err(|error| error.to_string())?;
        }
        if let Some(recurrence_id) = event.recurrence_id.as_deref() {
            add_master_exclusion(tx, &parsed.uid, recurrence_id)?;
        }
        let id_exists = batch_ids.contains(&event.id)
            || tx
                .query_row(
                    "SELECT 1 FROM calendar_events WHERE id = ?1 LIMIT 1",
                    [&event.id],
                    |_| Ok(()),
                )
                .optional()
                .map_err(|error| error.to_string())?
                .is_some();
        if id_exists {
            result.skipped_same_id += 1;
            continue;
        }
        let duplicate_key = normalized_calendar_duplicate_key(event);
        let duplicate_exists = batch_duplicates.contains(&duplicate_key)
            || tx
                .query_row(
                    "SELECT 1 FROM calendar_events
                     WHERE deleted_at IS NULL AND duplicate_key = ?1 LIMIT 1",
                    [&duplicate_key],
                    |_| Ok(()),
                )
                .optional()
                .map_err(|error| error.to_string())?
                .is_some();
        if duplicate_exists {
            result.skipped_exact_duplicates += 1;
            continue;
        }
        let mut stored = event.clone();
        if stored.updated_at.trim().is_empty() {
            stored.updated_at = now();
        }
        let json = serde_json::to_string(&stored).map_err(|error| error.to_string())?;
        tx.execute(
            "INSERT INTO calendar_events
             (id, starts_at, duplicate_key, event_json, updated_at, deleted_at)
             VALUES (?1, ?2, ?3, ?4, ?5, NULL)",
            params![
                stored.id,
                stored.starts_at,
                duplicate_key,
                json,
                stored.updated_at
            ],
        )
        .map_err(|error| error.to_string())?;
        tx.execute(
            "INSERT INTO calendar_sync_outbox (event_id, action, queued_at, attempts, last_error)
             VALUES (?1, 'upsert', ?2, 0, NULL)
             ON CONFLICT(event_id) DO UPDATE SET action = 'upsert', queued_at = excluded.queued_at,
               attempts = 0, last_error = NULL",
            params![stored.id, now()],
        )
        .map_err(|error| error.to_string())?;
        batch_ids.insert(stored.id);
        batch_duplicates.insert(duplicate_key);
        result.imported += 1;
    }
    Ok(result)
}

fn add_master_exclusion(
    tx: &Transaction<'_>,
    master_id: &str,
    recurrence_id: &str,
) -> Result<(), String> {
    let Some(json) = tx
        .query_row(
            "SELECT event_json FROM calendar_events WHERE id = ?1 AND deleted_at IS NULL",
            [master_id],
            |row| row.get::<_, String>(0),
        )
        .optional()
        .map_err(|error| error.to_string())?
    else {
        return Ok(());
    };
    let mut master = serde_json::from_str::<CalendarEvent>(&json)
        .map_err(|error| format!("Serientermin ist beschädigt: {error}"))?;
    let date = recurrence_id.get(..10).unwrap_or(recurrence_id).to_string();
    if master.excluded_dates.contains(&date) {
        return Ok(());
    }
    master.excluded_dates.push(date);
    master.excluded_dates.sort();
    master.excluded_dates.dedup();
    master.updated_at = now();
    let updated_json = serde_json::to_string(&master).map_err(|error| error.to_string())?;
    tx.execute(
        "UPDATE calendar_events SET event_json = ?2, updated_at = ?3 WHERE id = ?1",
        params![master.id, updated_json, master.updated_at],
    )
    .map_err(|error| error.to_string())?;
    tx.execute(
        "INSERT INTO calendar_sync_outbox (event_id, action, queued_at, attempts, last_error)
         VALUES (?1, 'upsert', ?2, 0, NULL)
         ON CONFLICT(event_id) DO UPDATE SET action = 'upsert', queued_at = excluded.queued_at,
           attempts = 0, last_error = NULL",
        params![master.id, now()],
    )
    .map_err(|error| error.to_string())?;
    Ok(())
}

fn read_ics_globals(path: &Path) -> Result<IcsGlobals, String> {
    let file = File::open(path).map_err(|error| error.to_string())?;
    let mut reader = BufReader::with_capacity(64 * 1024, file);
    let mut globals = IcsGlobals::default();
    let mut bytes = Vec::new();
    while reader
        .read_until(b'\n', &mut bytes)
        .map_err(|error| error.to_string())?
        > 0
    {
        let line = decode_ics_line(&bytes);
        bytes.clear();
        if line.eq_ignore_ascii_case("BEGIN:VEVENT") {
            break;
        }
        let upper = line.to_ascii_uppercase();
        if globals.category.is_empty()
            && (upper.starts_with("CATEGORIES:")
                || upper.starts_with("NAME:")
                || upper.starts_with("X-WR-CALNAME:"))
        {
            globals.category = property_value(&line);
        }
        if globals.color.is_empty()
            && (upper.starts_with("COLOR:")
                || upper.starts_with("X-APPLE-CALENDAR-COLOR:")
                || upper.starts_with("X-OUTLOOK-COLOR:"))
        {
            globals.color = property_value(&line);
        }
    }
    Ok(globals)
}

fn decode_ics_line(bytes: &[u8]) -> String {
    let without_lf = bytes.strip_suffix(b"\n").unwrap_or(bytes);
    let trimmed = without_lf.strip_suffix(b"\r").unwrap_or(without_lf);
    match std::str::from_utf8(trimmed) {
        Ok(value) => value.to_string(),
        Err(_) => WINDOWS_1252.decode(trimmed).0.into_owned(),
    }
}

#[allow(clippy::too_many_arguments)]
fn stream_ics_batches<R, C, F>(
    reader: &mut R,
    start_offset: u64,
    globals: &IcsGlobals,
    source: &str,
    job_id: &str,
    fallback_category: &str,
    fallback_color: &str,
    mut should_pause: C,
    mut on_batch: F,
) -> Result<StreamOutcome, String>
where
    R: BufRead + Seek,
    C: FnMut() -> bool,
    F: FnMut(&[ParsedItem], u64) -> Result<(), String>,
{
    reader
        .seek(SeekFrom::Start(start_offset))
        .map_err(|error| error.to_string())?;
    let mut block = Vec::<String>::new();
    let mut collecting = false;
    let mut batch = Vec::<ParsedItem>::with_capacity(IMPORT_BATCH_SIZE);
    let mut batch_offset = start_offset;
    let mut physical = Vec::new();

    loop {
        if should_pause() {
            return Ok(StreamOutcome::Paused);
        }
        physical.clear();
        if reader
            .read_until(b'\n', &mut physical)
            .map_err(|error| error.to_string())?
            == 0
        {
            break;
        }
        let current_offset = reader
            .stream_position()
            .map_err(|error| error.to_string())?;
        let line = decode_ics_line(&physical);
        if collecting && (line.starts_with(' ') || line.starts_with('\t')) {
            if let Some(previous) = block.last_mut() {
                previous.push_str(line.get(1..).unwrap_or_default());
            }
            continue;
        }
        if line.eq_ignore_ascii_case("BEGIN:VEVENT") {
            collecting = true;
            block.clear();
            continue;
        }
        if !collecting {
            continue;
        }
        if line.eq_ignore_ascii_case("END:VEVENT") {
            batch.push(parse_ics_event(
                &block,
                globals,
                source,
                job_id,
                current_offset,
                fallback_category,
                fallback_color,
            ));
            batch_offset = current_offset;
            collecting = false;
            block.clear();
            if batch.len() >= IMPORT_BATCH_SIZE {
                on_batch(&batch, batch_offset)?;
                batch.clear();
            }
            continue;
        }
        block.push(line);
    }

    if !batch.is_empty() {
        on_batch(&batch, batch_offset)?;
    }
    Ok(StreamOutcome::Completed)
}

fn property_lines<'a>(lines: &'a [String], key: &str) -> Vec<&'a str> {
    let key = key.to_ascii_uppercase();
    lines
        .iter()
        .filter_map(|line| {
            let upper = line.to_ascii_uppercase();
            (upper.starts_with(&format!("{key}:")) || upper.starts_with(&format!("{key};")))
                .then_some(line.as_str())
        })
        .collect()
}

fn unescape_ics_text(value: &str) -> String {
    value
        .replace("\\n", "\n")
        .replace("\\N", "\n")
        .replace("\\,", ",")
        .replace("\\;", ";")
        .replace("\\\\", "\\")
        .trim()
        .to_string()
}

fn property_value(line: &str) -> String {
    line.split_once(':')
        .map(|(_, value)| unescape_ics_text(value))
        .unwrap_or_default()
}

fn value(lines: &[String], key: &str) -> String {
    property_lines(lines, key)
        .first()
        .map(|line| property_value(line))
        .unwrap_or_default()
}

fn parse_ics_date(raw: &str) -> String {
    let value = raw.trim();
    let bytes = value.as_bytes();
    if bytes.len() < 8 || !bytes[..8].iter().all(u8::is_ascii_digit) {
        return value.to_string();
    }
    let date = format!("{}-{}-{}", &value[0..4], &value[4..6], &value[6..8]);
    if bytes.get(8) != Some(&b'T') || bytes.len() < 13 {
        return format!("{date}T00:00:00");
    }
    let hour = value.get(9..11).unwrap_or("00");
    let minute = value.get(11..13).unwrap_or("00");
    let second = value.get(13..15).unwrap_or("00");
    let utc = value.ends_with('Z').then_some("Z").unwrap_or("");
    format!("{date}T{hour}:{minute}:{second}{utc}")
}

fn next_calendar_day(value: &str) -> String {
    value
        .get(..10)
        .and_then(|date| NaiveDate::parse_from_str(date, "%Y-%m-%d").ok())
        .and_then(|date| date.checked_add_days(Days::new(1)))
        .map(|date| format!("{}T00:00:00", date.format("%Y-%m-%d")))
        .unwrap_or_else(|| value.to_string())
}

fn parse_number<T: std::str::FromStr>(value: Option<&String>) -> Option<T> {
    value.and_then(|value| value.parse::<T>().ok())
}

fn parse_recurrence(raw: &str) -> Option<CalendarRecurrence> {
    if raw.trim().is_empty() {
        return None;
    }
    let fields = raw
        .split(';')
        .filter_map(|part| part.split_once('='))
        .map(|(key, value)| (key.to_ascii_uppercase(), value.to_string()))
        .collect::<HashMap<_, _>>();
    let frequency = fields.get("FREQ")?.to_ascii_lowercase();
    if !matches!(
        frequency.as_str(),
        "daily" | "weekly" | "monthly" | "yearly"
    ) {
        return None;
    }
    let weekday = |value: &str| match value {
        "SU" => Some(0),
        "MO" => Some(1),
        "TU" => Some(2),
        "WE" => Some(3),
        "TH" => Some(4),
        "FR" => Some(5),
        "SA" => Some(6),
        _ => None,
    };
    let by_day = fields
        .get("BYDAY")
        .map(|value| value.split(',').collect::<Vec<_>>())
        .unwrap_or_default();
    let days_of_week = by_day
        .iter()
        .filter_map(|entry| entry.get(entry.len().saturating_sub(2)..))
        .filter_map(weekday)
        .collect::<Vec<_>>();
    let ordinal = by_day.first().and_then(|entry| {
        entry
            .get(..entry.len().saturating_sub(2))
            .filter(|value| !value.is_empty())
            .and_then(|value| value.parse::<i32>().ok())
    });
    Some(CalendarRecurrence {
        frequency,
        interval: parse_number::<u32>(fields.get("INTERVAL"))
            .unwrap_or(1)
            .max(1),
        days_of_week,
        day_of_month: parse_number::<u32>(fields.get("BYMONTHDAY")),
        month_of_year: parse_number::<u32>(fields.get("BYMONTH")),
        week_of_month: parse_number::<i32>(fields.get("BYSETPOS")).or(ordinal),
        until: fields
            .get("UNTIL")
            .map(|value| parse_ics_date(value).chars().take(10).collect()),
        count: parse_number::<u32>(fields.get("COUNT")),
    })
}

fn normalized_category(value: &str) -> String {
    value
        .to_lowercase()
        .replace([' ', '_', '-'], "")
        .replace('ü', "u")
}

fn category_color(category: &str, fallback: &str) -> String {
    let category = normalized_category(category);
    let detected = if ["rot", "red", "rosa", "pink"]
        .iter()
        .any(|value| category.contains(value))
    {
        "red"
    } else if ["grun", "green", "turkis", "teal", "olive"]
        .iter()
        .any(|value| category.contains(value))
    {
        "green"
    } else if ["gelb", "yellow", "orange", "peach"]
        .iter()
        .any(|value| category.contains(value))
    {
        "yellow"
    } else if ["lila", "violett", "purple", "maroon"]
        .iter()
        .any(|value| category.contains(value))
    {
        "purple"
    } else if ["grau", "gray", "grey", "schwarz", "black", "steel"]
        .iter()
        .any(|value| category.contains(value))
    {
        "gray"
    } else if ["blau", "blue"]
        .iter()
        .any(|value| category.contains(value))
    {
        "blue"
    } else {
        return safe_color(fallback);
    };
    detected.to_string()
}

fn explicit_color(raw: &str, category: &str) -> String {
    let value = raw.trim().trim_start_matches('#');
    if value.len() >= 6 {
        if let Ok(rgb) = u32::from_str_radix(&value[..6], 16) {
            let red = ((rgb >> 16) & 255) as i64;
            let green = ((rgb >> 8) & 255) as i64;
            let blue = (rgb & 255) as i64;
            return [
                ("blue", 0x25i64, 0x63i64, 0xebi64),
                ("green", 0x15, 0x80, 0x3d),
                ("yellow", 0xca, 0x8a, 0x04),
                ("red", 0xdc, 0x26, 0x26),
                ("purple", 0x7c, 0x3a, 0xed),
                ("gray", 0x64, 0x74, 0x8b),
            ]
            .into_iter()
            .min_by_key(|(_, target_red, target_green, target_blue)| {
                (red - target_red).pow(2)
                    + (green - target_green).pow(2)
                    + (blue - target_blue).pow(2)
            })
            .map(|(name, _, _, _)| name.to_string())
            .unwrap_or_else(default_calendar_color);
        }
    }
    let normalized = normalized_category(raw);
    if normalized.contains("red") {
        "red".to_string()
    } else if normalized.contains("green") || normalized.contains("teal") {
        "green".to_string()
    } else if normalized.contains("yellow") || normalized.contains("orange") {
        "yellow".to_string()
    } else if normalized.contains("purple") || normalized.contains("violet") {
        "purple".to_string()
    } else if normalized.contains("gray") || normalized.contains("grey") {
        "gray".to_string()
    } else if normalized.contains("blue") {
        "blue".to_string()
    } else {
        category_color(category, &default_calendar_color())
    }
}

fn parse_ics_event(
    lines: &[String],
    globals: &IcsGlobals,
    source: &str,
    job_id: &str,
    offset: u64,
    fallback_category: &str,
    fallback_color: &str,
) -> ParsedItem {
    if value(lines, "STATUS").eq_ignore_ascii_case("CANCELLED") {
        return ParsedItem::Ignored;
    }
    let start_line = property_lines(lines, "DTSTART")
        .first()
        .copied()
        .unwrap_or_default();
    let end_line = property_lines(lines, "DTEND")
        .first()
        .copied()
        .unwrap_or_default();
    let raw_start = property_value(start_line);
    if raw_start.is_empty() {
        return ParsedItem::Invalid;
    }
    let starts_at = parse_ics_date(&raw_start);
    if starts_at.is_empty() {
        return ParsedItem::Invalid;
    }
    let is_all_day = start_line.to_ascii_uppercase().contains("VALUE=DATE")
        || (raw_start.len() == 8 && raw_start.bytes().all(|value| value.is_ascii_digit()));
    let raw_end = property_value(end_line);
    let ends_at = if raw_end.is_empty() {
        if is_all_day {
            next_calendar_day(&starts_at)
        } else {
            starts_at.clone()
        }
    } else {
        parse_ics_date(&raw_end)
    };
    let uid = {
        let value = value(lines, "UID");
        if value.trim().is_empty() {
            let mut hasher = Sha256::new();
            hasher.update(job_id.as_bytes());
            hasher.update(offset.to_le_bytes());
            format!("ics-{:x}", hasher.finalize())
        } else {
            value
        }
    };
    let recurrence_id = parse_ics_date(&value(lines, "RECURRENCE-ID"));
    let source_category = {
        let own = value(lines, "CATEGORIES");
        if own.trim().is_empty() {
            globals.category.clone()
        } else {
            own
        }
    };
    let category = if source_category.trim().is_empty() {
        fallback_category.trim().to_string()
    } else {
        source_category.trim().to_string()
    };
    let source_color = [
        value(lines, "COLOR"),
        value(lines, "X-APPLE-EVENT-COLOR"),
        value(lines, "X-OUTLOOK-COLOR"),
        globals.color.clone(),
    ]
    .into_iter()
    .find(|value| !value.trim().is_empty())
    .unwrap_or_default();
    let color = if !source_color.is_empty() {
        explicit_color(&source_color, &category)
    } else if !source_category.trim().is_empty() {
        category_color(&category, &default_calendar_color())
    } else {
        safe_color(fallback_color)
    };
    let excluded_dates = property_lines(lines, "EXDATE")
        .into_iter()
        .flat_map(|line| {
            property_value(line)
                .split(',')
                .map(str::to_string)
                .collect::<Vec<_>>()
        })
        .map(|value| parse_ics_date(&value))
        .filter(|value| value.len() >= 10)
        .map(|value| value[..10].to_string())
        .collect::<Vec<_>>();
    ParsedItem::Event(ParsedEvent {
        event: CalendarEvent {
            id: if recurrence_id.is_empty() {
                uid.clone()
            } else {
                format!("{uid}::{recurrence_id}")
            },
            updated_at: String::new(),
            title: {
                let title = value(lines, "SUMMARY");
                if title.trim().is_empty() {
                    "Ohne Titel".to_string()
                } else {
                    title
                }
            },
            starts_at,
            ends_at,
            is_all_day,
            location: value(lines, "LOCATION"),
            description: value(lines, "DESCRIPTION"),
            color,
            category,
            source: source.to_string(),
            recurrence: parse_recurrence(&value(lines, "RRULE")),
            excluded_dates,
            deleted_at: None,
            recurrence_master_id: (!recurrence_id.is_empty()).then_some(uid.clone()),
            recurrence_id: (!recurrence_id.is_empty()).then_some(recurrence_id),
            meeting: CalendarMeetingOptions::default(),
        },
        uid,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Cursor;

    #[test]
    fn parses_folded_all_day_and_recurring_ics_event() {
        let lines = vec![
            "UID:series-1".to_string(),
            "DTSTART;VALUE=DATE:20260924".to_string(),
            "DTEND;VALUE=DATE:20260925".to_string(),
            "SUMMARY:Sehr langer Termin".to_string(),
            "DESCRIPTION:Erste Zeile\\nZweite Zeile".to_string(),
            "RRULE:FREQ=WEEKLY;INTERVAL=2;BYDAY=TH;COUNT=5".to_string(),
            "EXDATE;VALUE=DATE:20261008".to_string(),
        ];
        let ParsedItem::Event(parsed) = parse_ics_event(
            &lines,
            &IcsGlobals::default(),
            "test.ics",
            "job",
            100,
            "Allgemein",
            "blue",
        ) else {
            panic!("event expected");
        };
        assert!(parsed.event.is_all_day);
        assert_eq!(parsed.event.starts_at, "2026-09-24T00:00:00");
        assert_eq!(parsed.event.ends_at, "2026-09-25T00:00:00");
        assert_eq!(parsed.event.description, "Erste Zeile\nZweite Zeile");
        assert_eq!(parsed.event.excluded_dates, vec!["2026-10-08"]);
        assert_eq!(parsed.event.recurrence.unwrap().interval, 2);
    }

    #[test]
    fn cancelled_events_are_ignored() {
        let lines = vec![
            "UID:cancelled".to_string(),
            "DTSTART:20260924T100000".to_string(),
            "STATUS:CANCELLED".to_string(),
        ];
        assert!(matches!(
            parse_ics_event(
                &lines,
                &IcsGlobals::default(),
                "test.ics",
                "job",
                10,
                "Allgemein",
                "blue"
            ),
            ParsedItem::Ignored
        ));
    }

    #[test]
    fn streams_two_hundred_thousand_events_in_bounded_batches() {
        let total = 200_000usize;
        let mut source = String::from("BEGIN:VCALENDAR\r\nVERSION:2.0\r\n");
        for index in 0..total {
            source.push_str(&format!(
                "BEGIN:VEVENT\r\nUID:event-{index}\r\nDTSTART:20260924T100000\r\nDTEND:20260924T103000\r\nSUMMARY:Termin {index}\r\nEND:VEVENT\r\n"
            ));
        }
        source.push_str("END:VCALENDAR\r\n");
        let source_len = source.len() as u64;
        let mut reader = Cursor::new(source.into_bytes());
        let mut parsed = 0usize;
        let mut largest_batch = 0usize;
        let mut final_offset = 0u64;

        let outcome = stream_ics_batches(
            &mut reader,
            0,
            &IcsGlobals::default(),
            "large.ics",
            "large-job",
            "Allgemein",
            "blue",
            || false,
            |batch, offset| {
                largest_batch = largest_batch.max(batch.len());
                parsed += batch.len();
                final_offset = offset;
                Ok(())
            },
        )
        .expect("streaming parser should finish");

        assert!(matches!(outcome, StreamOutcome::Completed));
        assert_eq!(parsed, total);
        assert!(largest_batch <= IMPORT_BATCH_SIZE);
        assert!(final_offset <= source_len);
    }
}
