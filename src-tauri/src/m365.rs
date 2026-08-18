use crate::{hidden_command, open_db, AppState};
use base64::{engine::general_purpose::STANDARD as BASE64_STANDARD, Engine as _};
use chrono::{Duration as ChronoDuration, Utc};
use rusqlite::{params, OptionalExtension};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::collections::HashSet;
use std::sync::Mutex;
use tauri::{AppHandle, Manager, State};
use zeroize::Zeroize;

const TOKEN_SETTING_KEY: &str = "m365_token_bundle_v1";
const PROFILE_SETTING_KEY: &str = "m365_connection_profile_v1";
const DPAPI_ENTROPY: &[u8] = b"de.dmh.agendakontakte.m365.v1";
const GRAPH_PROFILE_URL: &str =
    "https://graph.microsoft.com/v1.0/me?$select=id,displayName,mail,userPrincipalName";
const LOGIN_SCOPES: &str = "openid profile offline_access User.Read Contacts.ReadWrite Calendars.ReadWrite Calendars.Read.Shared";

#[derive(Default)]
pub struct Microsoft365Runtime {
    pending_device_flow: Mutex<Option<PendingDeviceFlow>>,
}

#[derive(Debug, Clone)]
struct PendingDeviceFlow {
    device_code: String,
    expires_at: String,
    interval_seconds: u64,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct Microsoft365Account {
    id: String,
    display_name: String,
    email: String,
    user_principal_name: String,
    connected_at: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Microsoft365ConnectionStatus {
    configured: bool,
    connected: bool,
    account: Option<Microsoft365Account>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Microsoft365DeviceCode {
    user_code: String,
    verification_uri: String,
    expires_at: String,
    interval_seconds: u64,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Microsoft365PollResult {
    state: String,
    account: Option<Microsoft365Account>,
    interval_seconds: u64,
}

#[derive(Debug, Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct Microsoft365SyncSource {
    pub id: String,
    pub name: String,
    pub kind: String,
    pub editable: bool,
    pub shared: bool,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Microsoft365SyncSources {
    pub contacts: Vec<Microsoft365SyncSource>,
    pub calendars: Vec<Microsoft365SyncSource>,
    pub shared_access_available: bool,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Microsoft365SyncPreviewRequest {
    pub direction: String,
    pub base: String,
    pub contacts: bool,
    pub calendars: bool,
    pub shared_calendars: bool,
    pub backup: crate::BackupData,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Microsoft365SyncChange {
    pub kind: String,
    pub action: String,
    pub title: String,
    pub detail: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Microsoft365SyncPreview {
    pub local_contacts: usize,
    pub remote_contacts: usize,
    pub local_events: usize,
    pub remote_events: usize,
    pub create_in_m365: usize,
    pub import_to_app: usize,
    pub conflicts: usize,
    pub shared_sources_skipped: usize,
    pub changes: Vec<Microsoft365SyncChange>,
}

#[derive(Debug, Deserialize)]
struct DeviceCodeResponse {
    device_code: String,
    user_code: String,
    verification_uri: String,
    expires_in: i64,
    #[serde(default = "default_poll_interval")]
    interval: u64,
}

#[derive(Debug, Deserialize)]
struct OAuthTokenResponse {
    access_token: String,
    refresh_token: Option<String>,
    #[serde(default)]
    scope: String,
}

#[derive(Debug, Deserialize)]
struct OAuthErrorResponse {
    #[serde(default)]
    error: String,
    #[serde(default)]
    error_description: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct GraphProfile {
    id: String,
    #[serde(default)]
    display_name: String,
    #[serde(default)]
    mail: String,
    #[serde(default)]
    user_principal_name: String,
}

#[derive(Debug, Serialize, Deserialize)]
struct StoredTokenBundle {
    refresh_token: String,
    scope: String,
}

fn default_poll_interval() -> u64 {
    5
}

fn client_id() -> Option<&'static str> {
    option_env!("M365_CLIENT_ID")
        .map(str::trim)
        .filter(|value| is_identifier(value))
}

fn tenant_id() -> &'static str {
    option_env!("M365_TENANT_ID")
        .map(str::trim)
        .filter(|value| is_tenant(value))
        .unwrap_or("organizations")
}

fn is_identifier(value: &str) -> bool {
    !value.is_empty()
        && value.len() <= 128
        && value
            .chars()
            .all(|character| character.is_ascii_alphanumeric() || character == '-')
}

fn is_tenant(value: &str) -> bool {
    !value.is_empty()
        && value.len() <= 255
        && value
            .chars()
            .all(|character| character.is_ascii_alphanumeric() || matches!(character, '-' | '.'))
}

fn oauth_url(endpoint: &str) -> String {
    format!(
        "https://login.microsoftonline.com/{}/oauth2/v2.0/{endpoint}",
        tenant_id()
    )
}

fn encode_form_component(value: &str) -> String {
    let mut encoded = String::new();
    for byte in value.bytes() {
        match byte {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'_' | b'.' | b'~' => {
                encoded.push(byte as char)
            }
            b' ' => encoded.push('+'),
            _ => encoded.push_str(&format!("%{byte:02X}")),
        }
    }
    encoded
}

fn form_body(fields: &[(&str, &str)]) -> String {
    fields
        .iter()
        .map(|(key, value)| {
            format!(
                "{}={}",
                encode_form_component(key),
                encode_form_component(value)
            )
        })
        .collect::<Vec<_>>()
        .join("&")
}

fn oauth_error_message(error: &OAuthErrorResponse) -> String {
    let description = error
        .error_description
        .split("\r\n")
        .next()
        .unwrap_or("")
        .trim();
    match error.error.as_str() {
        "authorization_declined" => "Die Microsoft-Anmeldung wurde abgelehnt.".to_string(),
        "expired_token" => {
            "Der Anmeldecode ist abgelaufen. Starten Sie die Verbindung erneut.".to_string()
        }
        "bad_verification_code" => {
            "Der Microsoft-Anmeldecode ist ungültig oder abgelaufen.".to_string()
        }
        "invalid_client" => {
            "Die Microsoft-Anwendung ist im Entra ID nicht korrekt eingerichtet.".to_string()
        }
        "invalid_grant" => {
            "Die Microsoft-Sitzung ist abgelaufen. Verbinden Sie das Konto erneut.".to_string()
        }
        _ if !description.is_empty() => {
            format!("Microsoft-Anmeldung fehlgeschlagen: {description}")
        }
        _ => "Microsoft-Anmeldung ist fehlgeschlagen.".to_string(),
    }
}

fn get_setting(app: &AppHandle, key: &str) -> Result<Option<String>, String> {
    let conn = open_db(app)?;
    conn.query_row(
        "SELECT value FROM app_settings WHERE key = ?1",
        [key],
        |row| row.get(0),
    )
    .optional()
    .map_err(|error| error.to_string())
}

fn set_setting(app: &AppHandle, key: &str, value: &str) -> Result<(), String> {
    let conn = open_db(app)?;
    conn.execute(
        "INSERT INTO app_settings (key, value, updated_at) VALUES (?1, ?2, ?3)
         ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at",
        params![key, value, Utc::now().to_rfc3339()],
    )
    .map_err(|error| error.to_string())?;
    Ok(())
}

fn delete_connection_settings(app: &AppHandle) -> Result<(), String> {
    let conn = open_db(app)?;
    conn.execute_batch("PRAGMA secure_delete = ON;")
        .map_err(|error| error.to_string())?;
    conn.execute(
        "DELETE FROM app_settings WHERE key IN (?1, ?2)",
        params![TOKEN_SETTING_KEY, PROFILE_SETTING_KEY],
    )
    .map_err(|error| error.to_string())?;
    Ok(())
}

fn read_account(app: &AppHandle) -> Result<Option<Microsoft365Account>, String> {
    get_setting(app, PROFILE_SETTING_KEY)?
        .map(|value| {
            serde_json::from_str(&value)
                .map_err(|_| "Das gespeicherte Microsoft-365-Kontoprofil ist ungültig.".to_string())
        })
        .transpose()
}

fn save_connection(
    app: &AppHandle,
    account: &Microsoft365Account,
    token: &StoredTokenBundle,
) -> Result<(), String> {
    let mut token_json = serde_json::to_vec(token)
        .map_err(|_| "Microsoft-Anmeldung konnte nicht sicher gespeichert werden.".to_string())?;
    let protected = protect_secret(&token_json)?;
    token_json.zeroize();
    let encoded = BASE64_STANDARD.encode(protected);
    let profile_json = serde_json::to_string(account)
        .map_err(|_| "Microsoft-Kontoprofil konnte nicht gespeichert werden.".to_string())?;
    set_setting(app, TOKEN_SETTING_KEY, &encoded)?;
    if let Err(error) = set_setting(app, PROFILE_SETTING_KEY, &profile_json) {
        let _ = delete_connection_settings(app);
        return Err(error);
    }
    Ok(())
}

fn read_token(app: &AppHandle) -> Result<StoredTokenBundle, String> {
    let encoded = get_setting(app, TOKEN_SETTING_KEY)?
        .ok_or_else(|| "Microsoft-365-Konto ist nicht verbunden.".to_string())?;
    let protected = BASE64_STANDARD
        .decode(encoded)
        .map_err(|_| "Die gespeicherte Microsoft-Anmeldung ist ungültig.".to_string())?;
    let mut token_json = unprotect_secret(&protected)?;
    let token = serde_json::from_slice(&token_json).map_err(|_| {
        "Die gespeicherte Microsoft-Anmeldung konnte nicht gelesen werden.".to_string()
    })?;
    token_json.zeroize();
    Ok(token)
}

async fn graph_profile(access_token: &str) -> Result<GraphProfile, String> {
    let response = reqwest::Client::new()
        .get(GRAPH_PROFILE_URL)
        .bearer_auth(access_token)
        .send()
        .await
        .map_err(|_| {
            "Microsoft Graph ist derzeit nicht erreichbar. Internetverbindung prüfen.".to_string()
        })?;
    if !response.status().is_success() {
        return Err(format!(
            "Microsoft Graph hat die Verbindung nicht bestätigt (HTTP {}).",
            response.status().as_u16()
        ));
    }
    response
        .json::<GraphProfile>()
        .await
        .map_err(|_| "Microsoft Graph hat ein ungültiges Kontoprofil geliefert.".to_string())
}

async fn refreshed_access_token(app: &AppHandle) -> Result<String, String> {
    let client_id = client_id().ok_or_else(|| {
        "Die EDV muss zuerst die Microsoft-Anwendungs-ID für diesen Build hinterlegen.".to_string()
    })?;
    let stored = read_token(app)?;
    let token = request_token(&[
        ("grant_type", "refresh_token"),
        ("client_id", client_id),
        ("refresh_token", &stored.refresh_token),
        ("scope", LOGIN_SCOPES),
    ])
    .await
    .map_err(|error| oauth_error_message(&error))?;
    let refresh_token = token.refresh_token.unwrap_or(stored.refresh_token);
    let account = read_account(app)?.ok_or_else(|| {
        "Microsoft-365-Kontoprofil fehlt. Verbinden Sie das Konto erneut.".to_string()
    })?;
    save_connection(
        app,
        &account,
        &StoredTokenBundle {
            refresh_token,
            scope: token.scope,
        },
    )?;
    Ok(token.access_token)
}

async fn graph_json(access_token: &str, url: &str) -> Result<Value, String> {
    let response = reqwest::Client::new()
        .get(url)
        .bearer_auth(access_token)
        .send()
        .await
        .map_err(|_| "Microsoft Graph ist derzeit nicht erreichbar. Internetverbindung prüfen.".to_string())?;
    if !response.status().is_success() {
        return Err(format!(
            "Microsoft Graph konnte die Synchronisierungsquellen nicht lesen (HTTP {}).",
            response.status().as_u16()
        ));
    }
    response.json::<Value>().await.map_err(|_| {
        "Microsoft Graph hat eine ungültige Antwort für die Synchronisierungsquellen geliefert."
            .to_string()
    })
}

async fn graph_collection(
    access_token: &str,
    url: &str,
) -> Result<Vec<Value>, String> {
    let mut next_url = Some(url.to_string());
    let mut values = Vec::new();
    while let Some(current_url) = next_url.take() {
        let page = graph_json(access_token, &current_url).await?;
        if let Some(items) = page.get("value").and_then(Value::as_array) {
            values.extend(items.iter().cloned());
        }
        next_url = page
            .get("@odata.nextLink")
            .and_then(Value::as_str)
            .map(ToOwned::to_owned);
    }
    Ok(values)
}

fn sync_source(value: &Value, kind: &str, shared: bool) -> Option<Microsoft365SyncSource> {
    let id = value.get("id")?.as_str()?.trim();
    if id.is_empty() {
        return None;
    }
    let name = value
        .get("displayName")
        .or_else(|| value.get("name"))
        .and_then(Value::as_str)
        .unwrap_or("Ohne Namen")
        .trim()
        .to_string();
    Some(Microsoft365SyncSource {
        id: id.to_string(),
        name,
        kind: kind.to_string(),
        editable: value.get("canEdit").and_then(Value::as_bool).unwrap_or(true),
        shared,
    })
}

#[tauri::command]
pub async fn list_m365_sync_sources(app: AppHandle) -> Result<Microsoft365SyncSources, String> {
    let access_token = refreshed_access_token(&app).await?;
    let contact_folders = graph_collection(
        &access_token,
        "https://graph.microsoft.com/v1.0/me/contactFolders?$select=id,displayName,parentFolderId&$top=100",
    )
    .await?;
    let calendars = graph_collection(
        &access_token,
        "https://graph.microsoft.com/v1.0/me/calendars?$select=id,name,canEdit,owner&$top=100",
    )
    .await?;
    let calendar_groups = graph_collection(
        &access_token,
        "https://graph.microsoft.com/v1.0/me/calendarGroups?$select=id,name&$top=100",
    )
    .await
    .unwrap_or_default();

    let mut calendar_sources: Vec<Microsoft365SyncSource> = calendars
        .iter()
        .filter_map(|value| sync_source(value, "calendar", false))
        .collect();
    for group in calendar_groups {
        let Some(group_id) = group.get("id").and_then(Value::as_str) else { continue };
        let group_name = group.get("name").and_then(Value::as_str).unwrap_or("Freigegeben");
        let url = format!(
            "https://graph.microsoft.com/v1.0/me/calendarGroups/{group_id}/calendars?$select=id,name,canEdit,owner&$top=100"
        );
        if let Ok(shared_calendars) = graph_collection(&access_token, &url).await {
            calendar_sources.extend(shared_calendars.iter().filter_map(|value| {
                let mut source = sync_source(value, "calendar", true)?;
                source.name = format!("{group_name} · {}", source.name);
                Some(source)
            }));
        }
    }

    Ok(Microsoft365SyncSources {
        contacts: contact_folders
            .iter()
            .filter_map(|value| sync_source(value, "contactFolder", false))
            .collect(),
        calendars: calendar_sources,
        shared_access_available: true,
    })
}

fn normalized_contact_key(value: &Value) -> String {
    let email = value
        .get("emailAddresses")
        .and_then(Value::as_array)
        .and_then(|addresses| addresses.first())
        .and_then(|address| address.get("address"))
        .and_then(Value::as_str)
        .unwrap_or("")
        .trim()
        .to_lowercase();
    if !email.is_empty() {
        return format!("email:{email}");
    }
    let name = value
        .get("displayName")
        .and_then(Value::as_str)
        .unwrap_or("")
        .trim()
        .to_lowercase();
    format!("name:{name}")
}

fn local_contact_key(contact: &crate::Contact) -> String {
    if !contact.email.trim().is_empty() {
        return format!("email:{}", contact.email.trim().to_lowercase());
    }
    format!(
        "name:{}",
        if contact.display_name.trim().is_empty() {
            format!("{} {}", contact.first_name, contact.last_name)
        } else {
            contact.display_name.clone()
        }
        .trim()
        .to_lowercase()
    )
}

fn local_calendar_events(backup: &crate::BackupData) -> Vec<crate::CalendarEvent> {
    backup
        .browser_storage
        .get("agendakontakte.calendarEvents")
        .and_then(|raw| serde_json::from_str::<Vec<crate::CalendarEvent>>(raw).ok())
        .unwrap_or_default()
}

fn remote_event_key(value: &Value) -> String {
    let subject = value
        .get("subject")
        .and_then(Value::as_str)
        .unwrap_or("")
        .trim()
        .to_lowercase();
    let start = value
        .get("start")
        .and_then(|start| start.get("dateTime"))
        .and_then(Value::as_str)
        .unwrap_or("")
        .trim()
        .to_string();
    format!("{subject}|{start}")
}

fn local_event_key(event: &crate::CalendarEvent) -> String {
    format!("{}|{}", event.title.trim().to_lowercase(), event.starts_at.trim())
}

fn add_preview_change(
    changes: &mut Vec<Microsoft365SyncChange>,
    kind: &str,
    action: &str,
    title: impl Into<String>,
    detail: impl Into<String>,
) {
    if changes.len() >= 200 {
        return;
    }
    changes.push(Microsoft365SyncChange {
        kind: kind.to_string(),
        action: action.to_string(),
        title: title.into(),
        detail: detail.into(),
    });
}

#[tauri::command]
pub async fn preview_m365_sync(
    app: AppHandle,
    request: Microsoft365SyncPreviewRequest,
) -> Result<Microsoft365SyncPreview, String> {
    let access_token = refreshed_access_token(&app).await?;
    let sources = list_m365_sync_sources(app.clone()).await?;
    let mut changes = Vec::new();
    let mut create_in_m365 = 0usize;
    let mut import_to_app = 0usize;
    let mut conflicts = 0usize;
    let mut remote_contacts = 0usize;
    let mut remote_events = 0usize;

    if request.contacts {
        let mut remote_contact_values = graph_collection(
            &access_token,
            "https://graph.microsoft.com/v1.0/me/contacts?$select=id,displayName,emailAddresses,lastModifiedDateTime&$top=100",
        )
        .await?;
        for folder in &sources.contacts {
            let url = format!(
                "https://graph.microsoft.com/v1.0/me/contactFolders/{}/contacts?$select=id,displayName,emailAddresses,lastModifiedDateTime&$top=100",
                folder.id
            );
            if let Ok(values) = graph_collection(&access_token, &url).await {
                remote_contact_values.extend(values);
            }
        }
        let remote_keys: HashSet<String> = remote_contact_values.iter().map(normalized_contact_key).collect();
        let local_keys: HashSet<String> = request.backup.contacts.iter().filter(|contact| contact.deleted_at.is_none()).map(local_contact_key).collect();
        remote_contacts = remote_keys.len();
        for contact in request.backup.contacts.iter().filter(|contact| contact.deleted_at.is_none()) {
            if !remote_keys.contains(&local_contact_key(contact)) {
                if request.direction != "import" {
                    create_in_m365 += 1;
                    add_preview_change(&mut changes, "Kontakt", "export", contact.display_name.clone(), "Wird in Microsoft 365 angelegt.");
                }
            }
        }
        for value in &remote_contact_values {
            if !local_keys.contains(&normalized_contact_key(value)) && request.direction != "export" {
                import_to_app += 1;
                add_preview_change(&mut changes, "Kontakt", "import", value.get("displayName").and_then(Value::as_str).unwrap_or("Ohne Namen"), "Wird in der App angelegt.");
            }
        }
    }

    if request.calendars {
        let local_events = local_calendar_events(&request.backup);
        let local_keys: HashSet<String> = local_events.iter().filter(|event| event.deleted_at.is_none()).map(local_event_key).collect();
        for calendar in &sources.calendars {
            if calendar.shared {
                if request.shared_calendars {
                    // Shared calendar IDs need their owning calendar group path; they are
                    // listed above and are intentionally reported as pending for the next
                    // preview pass instead of being silently written to the wrong calendar.
                }
                continue;
            }
            let url = format!(
                "https://graph.microsoft.com/v1.0/me/calendars/{}/events?$select=id,subject,start,end,lastModifiedDateTime,location,categories,attendees,onlineMeeting,recurrence&$top=100",
                calendar.id
            );
            let values = graph_collection(&access_token, &url).await?;
            remote_events += values.len();
            let remote_keys: HashSet<String> = values.iter().map(remote_event_key).collect();
            for event in &local_events {
                if event.deleted_at.is_none() && !remote_keys.contains(&local_event_key(event)) && request.direction != "import" {
                    create_in_m365 += 1;
                    add_preview_change(&mut changes, "Kalender", "export", event.title.clone(), "Wird in Microsoft 365 angelegt.");
                }
            }
            for value in &values {
                if !local_keys.contains(&remote_event_key(value)) && request.direction != "export" {
                    import_to_app += 1;
                    add_preview_change(&mut changes, "Kalender", "import", value.get("subject").and_then(Value::as_str).unwrap_or("Ohne Titel"), format!("Wird aus {} in die App übernommen.", calendar.name));
                }
            }
        }
    }

    if request.base == "m365" && request.direction == "bidirectional" {
        conflicts = changes.len();
    }

    Ok(Microsoft365SyncPreview {
        local_contacts: request.backup.contacts.iter().filter(|contact| contact.deleted_at.is_none()).count(),
        remote_contacts,
        local_events: local_calendar_events(&request.backup).iter().filter(|event| event.deleted_at.is_none()).count(),
        remote_events,
        create_in_m365,
        import_to_app,
        conflicts,
        shared_sources_skipped: sources.calendars.iter().filter(|source| source.shared).count(),
        changes,
    })
}

fn account_from_profile(profile: GraphProfile) -> Microsoft365Account {
    Microsoft365Account {
        id: profile.id,
        display_name: profile.display_name,
        email: profile.mail,
        user_principal_name: profile.user_principal_name,
        connected_at: Utc::now().to_rfc3339(),
    }
}

async fn request_token(fields: &[(&str, &str)]) -> Result<OAuthTokenResponse, OAuthErrorResponse> {
    let response = reqwest::Client::new()
        .post(oauth_url("token"))
        .header("content-type", "application/x-www-form-urlencoded")
        .body(form_body(fields))
        .send()
        .await
        .map_err(|_| OAuthErrorResponse {
            error: "network_error".to_string(),
            error_description:
                "Microsoft-Anmeldedienst ist nicht erreichbar. Internetverbindung prüfen."
                    .to_string(),
        })?;
    if response.status().is_success() {
        return response
            .json::<OAuthTokenResponse>()
            .await
            .map_err(|_| OAuthErrorResponse {
                error: "invalid_response".to_string(),
                error_description: "Microsoft hat eine ungültige Antwort geliefert.".to_string(),
            });
    }
    let error = response
        .json::<OAuthErrorResponse>()
        .await
        .unwrap_or(OAuthErrorResponse {
            error: "unknown_error".to_string(),
            error_description: "Microsoft-Anmeldung ist fehlgeschlagen.".to_string(),
        });
    Err(error)
}

fn pending_flow(state: &State<'_, AppState>) -> Result<PendingDeviceFlow, String> {
    state
        .m365
        .pending_device_flow
        .lock()
        .map_err(|_| "Microsoft-Anmeldung konnte intern nicht gelesen werden.".to_string())?
        .clone()
        .ok_or_else(|| "Es läuft keine Microsoft-Anmeldung mehr.".to_string())
}

fn clear_pending_flow(state: &State<'_, AppState>) -> Result<(), String> {
    *state
        .m365
        .pending_device_flow
        .lock()
        .map_err(|_| "Microsoft-Anmeldung konnte intern nicht beendet werden.".to_string())? = None;
    Ok(())
}

#[tauri::command]
pub fn get_m365_connection_status(app: AppHandle) -> Result<Microsoft365ConnectionStatus, String> {
    let account = read_account(&app)?;
    Ok(Microsoft365ConnectionStatus {
        configured: client_id().is_some(),
        connected: account.is_some() && get_setting(&app, TOKEN_SETTING_KEY)?.is_some(),
        account,
    })
}

#[tauri::command]
pub async fn start_m365_connection(
    state: State<'_, AppState>,
) -> Result<Microsoft365DeviceCode, String> {
    let client_id = client_id().ok_or_else(|| {
        "Die EDV muss zuerst die Microsoft-Anwendungs-ID für diesen Build hinterlegen.".to_string()
    })?;
    let response = reqwest::Client::new()
        .post(oauth_url("devicecode"))
        .header("content-type", "application/x-www-form-urlencoded")
        .body(form_body(&[
            ("client_id", client_id),
            ("scope", LOGIN_SCOPES),
        ]))
        .send()
        .await
        .map_err(|_| {
            "Microsoft-Anmeldedienst ist nicht erreichbar. Internetverbindung prüfen.".to_string()
        })?;
    if !response.status().is_success() {
        let error = response
            .json::<OAuthErrorResponse>()
            .await
            .unwrap_or(OAuthErrorResponse {
                error: "unknown_error".to_string(),
                error_description: String::new(),
            });
        return Err(oauth_error_message(&error));
    }
    let device = response
        .json::<DeviceCodeResponse>()
        .await
        .map_err(|_| "Microsoft-Anmeldedienst hat eine ungültige Antwort geliefert.".to_string())?;
    let expires_at = (Utc::now() + ChronoDuration::seconds(device.expires_in)).to_rfc3339();
    *state
        .m365
        .pending_device_flow
        .lock()
        .map_err(|_| "Microsoft-Anmeldung konnte intern nicht vorbereitet werden.".to_string())? =
        Some(PendingDeviceFlow {
            device_code: device.device_code,
            expires_at: expires_at.clone(),
            interval_seconds: device.interval.max(3),
        });
    Ok(Microsoft365DeviceCode {
        user_code: device.user_code,
        verification_uri: device.verification_uri,
        expires_at,
        interval_seconds: device.interval.max(3),
    })
}

#[tauri::command]
pub async fn poll_m365_connection(
    app: AppHandle,
    state: State<'_, AppState>,
) -> Result<Microsoft365PollResult, String> {
    let client_id = client_id().ok_or_else(|| {
        "Die Microsoft-Anwendungs-ID ist in diesem Build nicht hinterlegt.".to_string()
    })?;
    let flow = pending_flow(&state)?;
    if flow
        .expires_at
        .parse::<chrono::DateTime<Utc>>()
        .is_ok_and(|expires_at| expires_at <= Utc::now())
    {
        clear_pending_flow(&state)?;
        return Err(
            "Der Anmeldecode ist abgelaufen. Starten Sie die Verbindung erneut.".to_string(),
        );
    }
    let token = match request_token(&[
        ("grant_type", "urn:ietf:params:oauth:grant-type:device_code"),
        ("client_id", client_id),
        ("device_code", &flow.device_code),
    ])
    .await
    {
        Ok(token) => token,
        Err(error) if error.error == "authorization_pending" => {
            return Ok(Microsoft365PollResult {
                state: "pending".to_string(),
                account: None,
                interval_seconds: flow.interval_seconds,
            })
        }
        Err(error) if error.error == "slow_down" => {
            let slower_interval = flow.interval_seconds + 5;
            if let Ok(mut pending) = state.m365.pending_device_flow.lock() {
                if let Some(pending) = pending.as_mut() {
                    pending.interval_seconds = slower_interval;
                }
            }
            return Ok(Microsoft365PollResult {
                state: "pending".to_string(),
                account: None,
                interval_seconds: slower_interval,
            });
        }
        Err(error) => {
            clear_pending_flow(&state)?;
            return Err(oauth_error_message(&error));
        }
    };
    let refresh_token = token.refresh_token.ok_or_else(|| {
        "Microsoft hat keine erneuerbare Anmeldung bereitgestellt. Die EDV muss offline_access erlauben."
            .to_string()
    })?;
    let mut access_token = token.access_token;
    let profile_result = graph_profile(&access_token).await;
    access_token.zeroize();
    let account = account_from_profile(profile_result?);
    save_connection(
        &app,
        &account,
        &StoredTokenBundle {
            refresh_token,
            scope: token.scope,
        },
    )?;
    clear_pending_flow(&state)?;
    Ok(Microsoft365PollResult {
        state: "connected".to_string(),
        account: Some(account),
        interval_seconds: flow.interval_seconds,
    })
}

#[tauri::command]
pub fn cancel_m365_connection(state: State<'_, AppState>) -> Result<(), String> {
    clear_pending_flow(&state)
}

#[tauri::command]
pub fn open_m365_sign_in() -> Result<(), String> {
    hidden_command("explorer.exe")
        .arg("https://microsoft.com/devicelogin")
        .spawn()
        .map_err(|error| format!("Microsoft-Anmeldung konnte nicht geöffnet werden: {error}"))?;
    Ok(())
}

#[tauri::command]
pub async fn test_m365_connection(app: AppHandle) -> Result<Microsoft365ConnectionStatus, String> {
    let client_id = client_id().ok_or_else(|| {
        "Die Microsoft-Anwendungs-ID ist in diesem Build nicht hinterlegt.".to_string()
    })?;
    let stored = read_token(&app)?;
    let token = request_token(&[
        ("grant_type", "refresh_token"),
        ("client_id", client_id),
        ("refresh_token", &stored.refresh_token),
        ("scope", LOGIN_SCOPES),
    ])
    .await
    .map_err(|error| oauth_error_message(&error))?;
    let refresh_token = token.refresh_token.unwrap_or(stored.refresh_token);
    let mut access_token = token.access_token;
    let profile_result = graph_profile(&access_token).await;
    access_token.zeroize();
    let account = account_from_profile(profile_result?);
    save_connection(
        &app,
        &account,
        &StoredTokenBundle {
            refresh_token,
            scope: token.scope,
        },
    )?;
    Ok(Microsoft365ConnectionStatus {
        configured: true,
        connected: true,
        account: Some(account),
    })
}

#[tauri::command]
pub fn disconnect_m365_account(app: AppHandle, state: State<'_, AppState>) -> Result<(), String> {
    clear_pending_flow(&state)?;
    delete_connection_settings(&app)
}

pub(crate) fn clear_runtime(app: &AppHandle) -> Result<(), String> {
    let state = app.state::<AppState>();
    *state.m365.pending_device_flow.lock().map_err(|_| {
        "Microsoft-Anmeldung konnte intern nicht zurückgesetzt werden.".to_string()
    })? = None;
    Ok(())
}

#[cfg(target_os = "windows")]
fn protect_secret(secret: &[u8]) -> Result<Vec<u8>, String> {
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
        cbData: secret.len() as u32,
        pbData: secret.as_ptr() as *mut u8,
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
    .map_err(|error| {
        format!("Microsoft-Anmeldung konnte von Windows nicht geschützt werden: {error}")
    })?;
    if output.pbData.is_null() || output.cbData == 0 {
        return Err("Windows hat keine geschützten Anmeldedaten geliefert.".to_string());
    }
    let protected =
        unsafe { std::slice::from_raw_parts(output.pbData, output.cbData as usize).to_vec() };
    unsafe {
        LocalFree(Some(HLOCAL(output.pbData.cast())));
    }
    Ok(protected)
}

#[cfg(target_os = "windows")]
fn unprotect_secret(protected_secret: &[u8]) -> Result<Vec<u8>, String> {
    use windows::Win32::{
        Foundation::{LocalFree, HLOCAL},
        Security::Cryptography::{
            CryptUnprotectData, CRYPTPROTECT_UI_FORBIDDEN, CRYPT_INTEGER_BLOB,
        },
    };

    let input = CRYPT_INTEGER_BLOB {
        cbData: protected_secret.len() as u32,
        pbData: protected_secret.as_ptr() as *mut u8,
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
    .map_err(|_| {
        "Die Microsoft-Anmeldung gehört zu einem anderen Windows-Benutzer oder Computer."
            .to_string()
    })?;
    if output.pbData.is_null() || output.cbData == 0 {
        return Err("Die geschützte Microsoft-Anmeldung ist ungültig.".to_string());
    }
    let secret = unsafe {
        let bytes = std::slice::from_raw_parts_mut(output.pbData, output.cbData as usize);
        let secret = bytes.to_vec();
        bytes.zeroize();
        LocalFree(Some(HLOCAL(output.pbData.cast())));
        secret
    };
    Ok(secret)
}

#[cfg(not(target_os = "windows"))]
fn protect_secret(_secret: &[u8]) -> Result<Vec<u8>, String> {
    Err("Microsoft-365-Anmeldung wird derzeit nur unter Windows unterstützt.".to_string())
}

#[cfg(not(target_os = "windows"))]
fn unprotect_secret(_protected_secret: &[u8]) -> Result<Vec<u8>, String> {
    Err("Microsoft-365-Anmeldung wird derzeit nur unter Windows unterstützt.".to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn form_values_are_encoded_without_losing_scopes() {
        assert_eq!(
            form_body(&[("scope", LOGIN_SCOPES)]),
            "scope=openid+profile+offline_access+User.Read+Contacts.ReadWrite+Calendars.ReadWrite+Calendars.Read.Shared"
        );
    }

    #[test]
    fn rejects_unsafe_tenant_values() {
        assert!(is_tenant("organizations"));
        assert!(is_tenant("tenant.onmicrosoft.com"));
        assert!(!is_tenant("../common?redirect=evil"));
    }

    #[test]
    fn oauth_errors_are_safe_and_understandable() {
        assert_eq!(
            oauth_error_message(&OAuthErrorResponse {
                error: "authorization_declined".to_string(),
                error_description: "untrusted detail".to_string(),
            }),
            "Die Microsoft-Anmeldung wurde abgelehnt."
        );
    }
}
