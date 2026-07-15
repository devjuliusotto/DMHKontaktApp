use crate::{hidden_command, open_db};
use rusqlite::{params, Connection, OptionalExtension};
use serde::{de::DeserializeOwned, Deserialize, Serialize};
use std::{fs, path::PathBuf};
use tauri::{AppHandle, Manager};

const HELPER_NAMES: [&str; 2] = [
    "outlook-profile-reader-x64.exe",
    "outlook-profile-reader-x86.exe",
];

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
            "Outlook-Hilfsprogramm fehlt. Installieren oder bauen Sie AgendaKontakte erneut."
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
    let incoming_reference = format!("AgendaKontakte/imap/{normalized_id}/incoming");
    let outgoing_reference = format!("AgendaKontakte/imap/{normalized_id}/outgoing");
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
pub fn remove_mail_account(app: AppHandle, account_id: i64) -> Result<(), String> {
    let conn = open_db(&app)?;
    let account = get_mail_account(&conn, account_id)?
        .ok_or_else(|| "Gespeichertes E-Mail-Konto wurde nicht gefunden.".to_string())?;
    let mut arguments = vec!["delete".to_string(), account.credential_reference];
    if let Some(reference) = account.outgoing_credential_reference {
        arguments.push(reference);
    }
    let _: serde_json::Value = run_helper(&app, &arguments)?;
    conn.execute("DELETE FROM mail_accounts WHERE id = ?1", [account_id])
        .map_err(|error| error.to_string())?;
    Ok(())
}
