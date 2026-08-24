use crate::{hidden_command, open_db, AppState};
use base64::{engine::general_purpose::STANDARD as BASE64_STANDARD, Engine as _};
use chrono::{Duration as ChronoDuration, Utc};
use rusqlite::{params, OptionalExtension};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::collections::{HashMap, HashSet};
use std::sync::Mutex;
use tauri::{AppHandle, Manager, State};
use zeroize::Zeroize;

const TOKEN_SETTING_KEY: &str = "m365_token_bundle_v1";
const PROFILE_SETTING_KEY: &str = "m365_connection_profile_v1";
const DPAPI_ENTROPY: &[u8] = b"de.dmh.agendakontakte.m365.v1";
const GRAPH_PROFILE_URL: &str =
    "https://graph.microsoft.com/v1.0/me?$select=id,displayName,mail,userPrincipalName";
const LOGIN_SCOPES: &str = "openid profile offline_access User.Read Contacts.ReadWrite Contacts.ReadWrite.Shared Calendars.ReadWrite Calendars.ReadWrite.Shared Calendars.Read.Shared Files.ReadWrite.All Sites.Read.All";

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
    pub resource_path: String,
    pub mailbox: Option<String>,
}

#[derive(Debug, Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct Microsoft365SharedMailbox {
    pub address: String,
    pub display_name: String,
    pub available: bool,
    pub contact_folder_count: usize,
    pub calendar_count: usize,
    pub error: Option<String>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Microsoft365SyncSources {
    pub contacts: Vec<Microsoft365SyncSource>,
    pub calendars: Vec<Microsoft365SyncSource>,
    pub shared_mailboxes: Vec<Microsoft365SharedMailbox>,
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
    pub shared_mailboxes: bool,
    #[serde(default)]
    pub shared_mailbox_addresses: Vec<String>,
    #[serde(default)]
    pub selected_contact_source_ids: Vec<String>,
    #[serde(default)]
    pub selected_calendar_source_ids: Vec<String>,
    #[serde(default)]
    pub source_directions: HashMap<String, String>,
    pub backup: crate::BackupData,
}

#[derive(Debug, Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct Microsoft365SyncChange {
    pub id: String,
    pub kind: String,
    pub action: String,
    pub source_id: String,
    pub source_name: String,
    pub title: String,
    pub detail: String,
    pub local_summary: Option<String>,
    pub remote_summary: Option<String>,
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
#[serde(rename_all = "camelCase")]
pub struct Microsoft365SyncApplyRequest {
    pub direction: String,
    pub base: String,
    pub contacts: bool,
    pub calendars: bool,
    pub shared_calendars: bool,
    pub shared_mailboxes: bool,
    #[serde(default)]
    pub shared_mailbox_addresses: Vec<String>,
    #[serde(default)]
    pub selected_contact_source_ids: Vec<String>,
    #[serde(default)]
    pub selected_calendar_source_ids: Vec<String>,
    #[serde(default)]
    pub source_directions: HashMap<String, String>,
    #[serde(default)]
    pub decisions: HashMap<String, String>,
    pub backup: crate::BackupData,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Microsoft365SyncResult {
    pub started_at: String,
    pub finished_at: String,
    pub created: usize,
    pub updated: usize,
    pub ignored: usize,
    pub conflicts: usize,
    pub errors: usize,
    pub error_messages: Vec<String>,
    pub calendar_upserts: Vec<crate::CalendarEvent>,
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

pub(crate) async fn refreshed_access_token(app: &AppHandle) -> Result<String, String> {
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

pub(crate) async fn graph_json(access_token: &str, url: &str) -> Result<Value, String> {
    let response = reqwest::Client::new()
        .get(url)
        .bearer_auth(access_token)
        .send()
        .await
        .map_err(|_| {
            "Microsoft Graph ist derzeit nicht erreichbar. Internetverbindung prüfen.".to_string()
        })?;
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

pub(crate) async fn graph_collection(access_token: &str, url: &str) -> Result<Vec<Value>, String> {
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

fn encode_graph_path_segment(value: &str) -> String {
    let mut encoded = String::new();
    for byte in value.bytes() {
        match byte {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'_' | b'.' | b'~' => {
                encoded.push(byte as char)
            }
            _ => encoded.push_str(&format!("%{byte:02X}")),
        }
    }
    encoded
}

fn sync_source(
    value: &Value,
    kind: &str,
    shared: bool,
    resource_path: String,
    mailbox: Option<String>,
) -> Option<Microsoft365SyncSource> {
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
        editable: value
            .get("canEdit")
            .and_then(Value::as_bool)
            .unwrap_or(true),
        shared,
        resource_path,
        mailbox,
    })
}

fn synthetic_sync_source(
    id: String,
    name: String,
    kind: &str,
    resource_path: String,
    mailbox: String,
) -> Microsoft365SyncSource {
    Microsoft365SyncSource {
        id,
        name,
        kind: kind.to_string(),
        editable: true,
        shared: true,
        resource_path,
        mailbox: Some(mailbox),
    }
}

#[tauri::command]
pub async fn list_m365_sync_sources(
    app: AppHandle,
    shared_mailbox_addresses: Option<Vec<String>>,
) -> Result<Microsoft365SyncSources, String> {
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
        .filter_map(|value| {
            let id = value.get("id").and_then(Value::as_str)?;
            sync_source(
                value,
                "calendar",
                false,
                format!("https://graph.microsoft.com/v1.0/me/calendars/{id}"),
                None,
            )
        })
        .collect();
    for group in calendar_groups {
        let Some(group_id) = group.get("id").and_then(Value::as_str) else {
            continue;
        };
        let group_name = group
            .get("name")
            .and_then(Value::as_str)
            .unwrap_or("Freigegeben");
        let url = format!(
            "https://graph.microsoft.com/v1.0/me/calendarGroups/{group_id}/calendars?$select=id,name,canEdit,owner&$top=100"
        );
        if let Ok(shared_calendars) = graph_collection(&access_token, &url).await {
            calendar_sources.extend(shared_calendars.iter().filter_map(|value| {
                let calendar_id = value.get("id").and_then(Value::as_str)?;
                let mut source = sync_source(
                    value,
                    "calendar",
                    true,
                    format!(
                        "https://graph.microsoft.com/v1.0/me/calendarGroups/{group_id}/calendars/{calendar_id}"
                    ),
                    None,
                )?;
                source.name = format!("{group_name} · {}", source.name);
                Some(source)
            }));
        }
    }

    let mut contact_sources: Vec<Microsoft365SyncSource> = contact_folders
        .iter()
        .filter_map(|value| {
            let id = value.get("id").and_then(Value::as_str)?;
            sync_source(
                value,
                "contactFolder",
                false,
                format!("https://graph.microsoft.com/v1.0/me/contactFolders/{id}/contacts"),
                None,
            )
        })
        .collect();
    contact_sources.insert(
        0,
        Microsoft365SyncSource {
            id: "me:default-contacts".to_string(),
            name: "Kontakte".to_string(),
            kind: "contactFolder".to_string(),
            editable: true,
            shared: false,
            resource_path: "https://graph.microsoft.com/v1.0/me/contacts".to_string(),
            mailbox: None,
        },
    );
    let mut shared_mailboxes = Vec::new();

    for address in shared_mailbox_addresses
        .unwrap_or_default()
        .into_iter()
        .map(|address| address.trim().to_lowercase())
        .filter(|address| address.contains('@') && !address.contains(' '))
        .collect::<Vec<_>>()
    {
        let encoded_address = encode_graph_path_segment(&address);
        let mailbox_calendars = graph_collection(
            &access_token,
            &format!(
                "https://graph.microsoft.com/v1.0/users/{encoded_address}/calendars?$select=id,name,canEdit,owner&$top=100"
            ),
        )
        .await;
        let mailbox_contacts = graph_collection(
            &access_token,
            &format!(
                "https://graph.microsoft.com/v1.0/users/{encoded_address}/contactFolders?$select=id,displayName,parentFolderId&$top=100"
            ),
        )
        .await;
        let mailbox_default_contacts = graph_collection(
            &access_token,
            &format!(
                "https://graph.microsoft.com/v1.0/users/{encoded_address}/contacts?$select=id&$top=1"
            ),
        )
        .await;
        let mailbox_access_error = if mailbox_calendars.is_err()
            && mailbox_contacts.is_err()
            && mailbox_default_contacts.is_err()
        {
            Some(format!(
                "Kalender: {} Kontakte: {}",
                mailbox_calendars.as_ref().err().unwrap(),
                mailbox_contacts
                    .as_ref()
                    .err()
                    .or_else(|| mailbox_default_contacts.as_ref().err())
                    .unwrap()
            ))
        } else {
            None
        };

        if mailbox_default_contacts.is_ok() {
            contact_sources.push(synthetic_sync_source(
                format!("{address}:default-contacts"),
                format!("{address} · Kontakte"),
                "contactFolder",
                format!("https://graph.microsoft.com/v1.0/users/{encoded_address}/contacts"),
                address.clone(),
            ));
        }

        if let Ok(values) = &mailbox_contacts {
            contact_sources.extend(values.iter().filter_map(|value| {
                let id = value.get("id").and_then(Value::as_str)?;
                let mut source = sync_source(
                    value,
                    "contactFolder",
                    true,
                    format!(
                        "https://graph.microsoft.com/v1.0/users/{encoded_address}/contactFolders/{id}/contacts"
                    ),
                    Some(address.clone()),
                )?;
                source.name = format!("{address} · {}", source.name);
                Some(source)
            }));
        }
        if let Ok(values) = &mailbox_calendars {
            calendar_sources.extend(values.iter().filter_map(|value| {
                let id = value.get("id").and_then(Value::as_str)?;
                let mut source = sync_source(
                    value,
                    "calendar",
                    true,
                    format!(
                        "https://graph.microsoft.com/v1.0/users/{encoded_address}/calendars/{id}"
                    ),
                    Some(address.clone()),
                )?;
                source.name = format!("{address} · {}", source.name);
                Some(source)
            }));
        }
        shared_mailboxes.push(Microsoft365SharedMailbox {
            address: address.clone(),
            display_name: address.clone(),
            available: mailbox_access_error.is_none(),
            contact_folder_count: mailbox_contacts.as_ref().map(Vec::len).unwrap_or(0)
                + usize::from(mailbox_default_contacts.is_ok()),
            calendar_count: mailbox_calendars.as_ref().map(Vec::len).unwrap_or(0),
            error: mailbox_access_error,
        });
    }

    let shared_access_available = calendar_sources.iter().any(|source| source.shared)
        || shared_mailboxes.iter().any(|mailbox| mailbox.available);

    Ok(Microsoft365SyncSources {
        contacts: contact_sources,
        calendars: calendar_sources,
        shared_mailboxes,
        shared_access_available,
    })
}

fn value_text<'a>(value: &'a Value, key: &str) -> &'a str {
    value.get(key).and_then(Value::as_str).unwrap_or("")
}

fn first_graph_email(value: &Value) -> &str {
    value
        .get("emailAddresses")
        .and_then(Value::as_array)
        .and_then(|addresses| addresses.first())
        .and_then(|address| address.get("address"))
        .and_then(Value::as_str)
        .unwrap_or("")
}

fn normalized_contact_key(value: &Value) -> String {
    let email = first_graph_email(value).trim().to_lowercase();
    if !email.is_empty() {
        return format!("email:{email}");
    }
    format!(
        "name:{}",
        value_text(value, "displayName").trim().to_lowercase()
    )
}

fn local_contact_key(contact: &crate::Contact) -> String {
    if !contact.email.trim().is_empty() {
        return format!("email:{}", contact.email.trim().to_lowercase());
    }
    let name = if contact.display_name.trim().is_empty() {
        format!("{} {}", contact.first_name, contact.last_name)
    } else {
        contact.display_name.clone()
    };
    format!("name:{}", name.trim().to_lowercase())
}

fn contact_summary(contact: &crate::Contact) -> String {
    [
        contact.display_name.trim(),
        contact.email.trim(),
        contact.phone.trim(),
        contact.city.trim(),
    ]
    .into_iter()
    .filter(|part| !part.is_empty())
    .collect::<Vec<_>>()
    .join(" · ")
}

fn remote_contact_summary(value: &Value) -> String {
    [
        value_text(value, "displayName"),
        first_graph_email(value),
        value
            .get("businessPhones")
            .and_then(Value::as_array)
            .and_then(|phones| phones.first())
            .and_then(Value::as_str)
            .unwrap_or(""),
        value
            .get("businessAddress")
            .and_then(|address| address.get("city"))
            .and_then(Value::as_str)
            .unwrap_or(""),
    ]
    .into_iter()
    .filter(|part| !part.trim().is_empty())
    .collect::<Vec<_>>()
    .join(" · ")
}

fn remote_contact_input(value: &Value, existing: Option<&crate::Contact>) -> crate::ContactInput {
    let address = value.get("businessAddress").unwrap_or(&Value::Null);
    crate::ContactInput {
        id: existing.and_then(|contact| contact.id),
        first_name: value_text(value, "givenName").to_string(),
        last_name: value_text(value, "surname").to_string(),
        display_name: value_text(value, "displayName").to_string(),
        email: first_graph_email(value).to_string(),
        phone: value
            .get("businessPhones")
            .and_then(Value::as_array)
            .and_then(|phones| phones.first())
            .and_then(Value::as_str)
            .unwrap_or("")
            .to_string(),
        mobile_phone: value_text(value, "mobilePhone").to_string(),
        street: value_text(address, "street").to_string(),
        postal_code: value_text(address, "postalCode").to_string(),
        city: value_text(address, "city").to_string(),
        country: value_text(address, "countryOrRegion").to_string(),
        short_info: existing
            .map(|contact| contact.short_info.clone())
            .unwrap_or_default(),
        notes: value_text(value, "personalNotes").to_string(),
        group_ids: existing
            .map(|contact| contact.groups.iter().filter_map(|group| group.id).collect())
            .unwrap_or_default(),
    }
}

fn graph_contact_payload(contact: &crate::Contact) -> Value {
    let display_name = if contact.display_name.trim().is_empty() {
        format!("{} {}", contact.first_name, contact.last_name)
            .trim()
            .to_string()
    } else {
        contact.display_name.clone()
    };
    let emails = if contact.email.trim().is_empty() {
        Vec::new()
    } else {
        vec![json!({"address": contact.email.trim(), "name": display_name})]
    };
    let phones = if contact.phone.trim().is_empty() {
        Vec::<String>::new()
    } else {
        vec![contact.phone.trim().to_string()]
    };
    json!({
        "givenName": contact.first_name,
        "surname": contact.last_name,
        "displayName": display_name,
        "emailAddresses": emails,
        "businessPhones": phones,
        "mobilePhone": contact.mobile_phone,
        "businessAddress": {
            "street": contact.street,
            "postalCode": contact.postal_code,
            "city": contact.city,
            "countryOrRegion": contact.country
        },
        "personalNotes": contact.notes
    })
}

fn contact_equivalent(local: &crate::Contact, remote: &Value) -> bool {
    let remote_input = remote_contact_input(remote, Some(local));
    local.first_name.trim() == remote_input.first_name.trim()
        && local.last_name.trim() == remote_input.last_name.trim()
        && local.display_name.trim() == remote_input.display_name.trim()
        && local
            .email
            .trim()
            .eq_ignore_ascii_case(remote_input.email.trim())
        && local.phone.trim() == remote_input.phone.trim()
        && local.mobile_phone.trim() == remote_input.mobile_phone.trim()
        && local.street.trim() == remote_input.street.trim()
        && local.postal_code.trim() == remote_input.postal_code.trim()
        && local.city.trim() == remote_input.city.trim()
        && local.country.trim() == remote_input.country.trim()
        && local.notes.trim() == remote_input.notes.trim()
}

fn merge_contact(local: &crate::Contact, remote: &Value) -> crate::Contact {
    let remote_input = remote_contact_input(remote, Some(local));
    let mut merged = local.clone();
    if merged.first_name.trim().is_empty() {
        merged.first_name = remote_input.first_name;
    }
    if merged.last_name.trim().is_empty() {
        merged.last_name = remote_input.last_name;
    }
    if merged.display_name.trim().is_empty() {
        merged.display_name = remote_input.display_name;
    }
    if merged.email.trim().is_empty() {
        merged.email = remote_input.email;
    }
    if merged.phone.trim().is_empty() {
        merged.phone = remote_input.phone;
    }
    if merged.mobile_phone.trim().is_empty() {
        merged.mobile_phone = remote_input.mobile_phone;
    }
    if merged.street.trim().is_empty() {
        merged.street = remote_input.street;
    }
    if merged.postal_code.trim().is_empty() {
        merged.postal_code = remote_input.postal_code;
    }
    if merged.city.trim().is_empty() {
        merged.city = remote_input.city;
    }
    if merged.country.trim().is_empty() {
        merged.country = remote_input.country;
    }
    if merged.notes.trim().is_empty() {
        merged.notes = remote_input.notes;
    } else if !remote_input.notes.trim().is_empty()
        && merged.notes.trim() != remote_input.notes.trim()
    {
        merged.notes = format!(
            "{}\n\n--- Microsoft 365 ---\n{}",
            merged.notes.trim(),
            remote_input.notes.trim()
        );
    }
    merged
}

fn local_calendar_events(backup: &crate::BackupData) -> Vec<crate::CalendarEvent> {
    backup
        .browser_storage
        .get("agendakontakte.calendarEvents")
        .and_then(|raw| serde_json::from_str::<Vec<crate::CalendarEvent>>(raw).ok())
        .unwrap_or_default()
}

fn remote_event_key(value: &Value) -> String {
    let subject = value_text(value, "subject").trim().to_lowercase();
    let start = value
        .get("start")
        .and_then(|start| start.get("dateTime"))
        .and_then(Value::as_str)
        .unwrap_or("")
        .trim();
    format!("{subject}|{start}")
}

fn local_event_key(event: &crate::CalendarEvent) -> String {
    format!(
        "{}|{}",
        event.title.trim().to_lowercase(),
        event.starts_at.trim()
    )
}

fn remote_event_to_local(
    value: &Value,
    source: &Microsoft365SyncSource,
    existing: Option<&crate::CalendarEvent>,
) -> crate::CalendarEvent {
    let remote_id = value_text(value, "id");
    crate::CalendarEvent {
        id: existing
            .map(|event| event.id.clone())
            .unwrap_or_else(|| format!("m365:{}:{remote_id}", source.id)),
        title: value_text(value, "subject").to_string(),
        starts_at: value
            .get("start")
            .and_then(|part| part.get("dateTime"))
            .and_then(Value::as_str)
            .unwrap_or("")
            .to_string(),
        ends_at: value
            .get("end")
            .and_then(|part| part.get("dateTime"))
            .and_then(Value::as_str)
            .unwrap_or("")
            .to_string(),
        location: value
            .get("location")
            .and_then(|location| location.get("displayName"))
            .and_then(Value::as_str)
            .unwrap_or("")
            .to_string(),
        description: value
            .get("body")
            .and_then(|body| body.get("content"))
            .and_then(Value::as_str)
            .unwrap_or("")
            .to_string(),
        color: existing
            .map(|event| event.color.clone())
            .unwrap_or_else(|| "blue".to_string()),
        category: value
            .get("categories")
            .and_then(Value::as_array)
            .and_then(|categories| categories.first())
            .and_then(Value::as_str)
            .unwrap_or("")
            .to_string(),
        source: format!("Microsoft 365 · {}", source.name),
        recurrence: existing.and_then(|event| event.recurrence.clone()),
        excluded_dates: existing
            .map(|event| event.excluded_dates.clone())
            .unwrap_or_default(),
        deleted_at: None,
        recurrence_master_id: existing.and_then(|event| event.recurrence_master_id.clone()),
        recurrence_id: existing.and_then(|event| event.recurrence_id.clone()),
    }
}

fn event_summary(event: &crate::CalendarEvent) -> String {
    [
        event.title.trim(),
        event.starts_at.trim(),
        event.location.trim(),
    ]
    .into_iter()
    .filter(|part| !part.is_empty())
    .collect::<Vec<_>>()
    .join(" · ")
}

fn remote_event_summary(value: &Value) -> String {
    let start = value
        .get("start")
        .and_then(|part| part.get("dateTime"))
        .and_then(Value::as_str)
        .unwrap_or("");
    let location = value
        .get("location")
        .and_then(|part| part.get("displayName"))
        .and_then(Value::as_str)
        .unwrap_or("");
    [value_text(value, "subject"), start, location]
        .into_iter()
        .filter(|part| !part.is_empty())
        .collect::<Vec<_>>()
        .join(" · ")
}

fn event_equivalent(
    local: &crate::CalendarEvent,
    remote: &Value,
    source: &Microsoft365SyncSource,
) -> bool {
    let remote_local = remote_event_to_local(remote, source, Some(local));
    local.title.trim() == remote_local.title.trim()
        && local.starts_at.trim() == remote_local.starts_at.trim()
        && local.ends_at.trim() == remote_local.ends_at.trim()
        && local.location.trim() == remote_local.location.trim()
        && local.description.trim() == remote_local.description.trim()
        && local.category.trim() == remote_local.category.trim()
}

fn merge_event(
    local: &crate::CalendarEvent,
    remote: &Value,
    source: &Microsoft365SyncSource,
) -> crate::CalendarEvent {
    let remote_local = remote_event_to_local(remote, source, Some(local));
    let mut merged = local.clone();
    if merged.title.trim().is_empty() {
        merged.title = remote_local.title;
    }
    if merged.starts_at.trim().is_empty() {
        merged.starts_at = remote_local.starts_at;
    }
    if merged.ends_at.trim().is_empty() {
        merged.ends_at = remote_local.ends_at;
    }
    if merged.location.trim().is_empty() {
        merged.location = remote_local.location;
    }
    if merged.category.trim().is_empty() {
        merged.category = remote_local.category;
    }
    if merged.description.trim().is_empty() {
        merged.description = remote_local.description;
    } else if !remote_local.description.trim().is_empty()
        && merged.description.trim() != remote_local.description.trim()
    {
        merged.description = format!(
            "{}\n\n--- Microsoft 365 ---\n{}",
            merged.description.trim(),
            remote_local.description.trim()
        );
    }
    merged
}

fn graph_event_payload(event: &crate::CalendarEvent) -> Value {
    let categories = if event.category.trim().is_empty() {
        Vec::<String>::new()
    } else {
        vec![event.category.trim().to_string()]
    };
    json!({
        "subject": event.title,
        "start": {"dateTime": event.starts_at, "timeZone": "W. Europe Standard Time"},
        "end": {"dateTime": event.ends_at, "timeZone": "W. Europe Standard Time"},
        "location": {"displayName": event.location},
        "body": {"contentType": "text", "content": event.description},
        "categories": categories
    })
}

fn operation_id(kind: &str, source_id: &str, local_id: &str, remote_id: &str) -> String {
    format!("{kind}|{source_id}|{local_id}|{remote_id}")
}

fn source_direction(request: &Microsoft365SyncPreviewRequest, source_id: &str) -> String {
    request
        .source_directions
        .get(source_id)
        .cloned()
        .unwrap_or_else(|| request.direction.clone())
}

#[derive(Clone)]
enum PlannedPayload {
    Contact {
        local: Option<crate::Contact>,
        remote: Option<Value>,
    },
    Calendar {
        local: Option<crate::CalendarEvent>,
        remote: Option<Value>,
    },
}

#[derive(Clone)]
struct PlannedOperation {
    change: Microsoft365SyncChange,
    source: Microsoft365SyncSource,
    payload: PlannedPayload,
}

struct Microsoft365SyncPlan {
    preview: Microsoft365SyncPreview,
    operations: Vec<PlannedOperation>,
}

fn push_operation(operations: &mut Vec<PlannedOperation>, operation: PlannedOperation) {
    if operations.len() < 500 {
        operations.push(operation);
    }
}

async fn build_m365_sync_plan(
    app: &AppHandle,
    access_token: &str,
    request: &Microsoft365SyncPreviewRequest,
) -> Result<Microsoft365SyncPlan, String> {
    let sources =
        list_m365_sync_sources(app.clone(), Some(request.shared_mailbox_addresses.clone())).await?;
    let selected_contacts: HashSet<&str> = request
        .selected_contact_source_ids
        .iter()
        .map(String::as_str)
        .collect();
    let selected_calendars: HashSet<&str> = request
        .selected_calendar_source_ids
        .iter()
        .map(String::as_str)
        .collect();
    let local_contacts: Vec<crate::Contact> = request
        .backup
        .contacts
        .iter()
        .filter(|contact| contact.deleted_at.is_none())
        .cloned()
        .collect();
    let local_events: Vec<crate::CalendarEvent> = local_calendar_events(&request.backup)
        .into_iter()
        .filter(|event| event.deleted_at.is_none())
        .collect();
    let mut operations = Vec::new();
    let mut remote_contacts = 0usize;
    let mut remote_events = 0usize;

    if request.contacts {
        for source in sources.contacts.iter().filter(|source| {
            selected_contacts.contains(source.id.as_str())
                && (!source.shared || request.shared_mailboxes)
        }) {
            let direction = source_direction(request, &source.id);
            let url = format!("{}?$select=id,givenName,surname,displayName,emailAddresses,businessPhones,mobilePhone,businessAddress,personalNotes,lastModifiedDateTime&$top=100", source.resource_path);
            let values = graph_collection(access_token, &url).await?;
            remote_contacts += values.len();
            let remote_by_key: HashMap<String, &Value> = values
                .iter()
                .map(|value| (normalized_contact_key(value), value))
                .collect();
            let local_keys: HashSet<String> =
                local_contacts.iter().map(local_contact_key).collect();

            for local in &local_contacts {
                let key = local_contact_key(local);
                if let Some(remote) = remote_by_key.get(&key) {
                    if contact_equivalent(local, remote) {
                        continue;
                    }
                    let action = match direction.as_str() {
                        "export" => "updateRemote",
                        "import" => "updateLocal",
                        _ => "conflict",
                    };
                    let remote_id = value_text(remote, "id");
                    push_operation(
                        &mut operations,
                        PlannedOperation {
                            change: Microsoft365SyncChange {
                                id: operation_id(
                                    "contact",
                                    &source.id,
                                    &local.id.unwrap_or_default().to_string(),
                                    remote_id,
                                ),
                                kind: "Kontakt".to_string(),
                                action: action.to_string(),
                                source_id: source.id.clone(),
                                source_name: source.name.clone(),
                                title: local.display_name.clone(),
                                detail: format!(
                                    "Unterschiedliche Angaben. Gewählte Basis: {}.",
                                    request.base
                                ),
                                local_summary: Some(contact_summary(local)),
                                remote_summary: Some(remote_contact_summary(remote)),
                            },
                            source: source.clone(),
                            payload: PlannedPayload::Contact {
                                local: Some(local.clone()),
                                remote: Some((*remote).clone()),
                            },
                        },
                    );
                } else if direction != "import" {
                    push_operation(
                        &mut operations,
                        PlannedOperation {
                            change: Microsoft365SyncChange {
                                id: operation_id(
                                    "contact",
                                    &source.id,
                                    &local.id.unwrap_or_default().to_string(),
                                    "new",
                                ),
                                kind: "Kontakt".to_string(),
                                action: "createRemote".to_string(),
                                source_id: source.id.clone(),
                                source_name: source.name.clone(),
                                title: local.display_name.clone(),
                                detail: format!("App → M365: {}", source.name),
                                local_summary: Some(contact_summary(local)),
                                remote_summary: None,
                            },
                            source: source.clone(),
                            payload: PlannedPayload::Contact {
                                local: Some(local.clone()),
                                remote: None,
                            },
                        },
                    );
                }
            }
            if direction != "export" {
                for remote in &values {
                    if local_keys.contains(&normalized_contact_key(remote)) {
                        continue;
                    }
                    push_operation(
                        &mut operations,
                        PlannedOperation {
                            change: Microsoft365SyncChange {
                                id: operation_id(
                                    "contact",
                                    &source.id,
                                    "new",
                                    value_text(remote, "id"),
                                ),
                                kind: "Kontakt".to_string(),
                                action: "createLocal".to_string(),
                                source_id: source.id.clone(),
                                source_name: source.name.clone(),
                                title: value_text(remote, "displayName").to_string(),
                                detail: format!("M365 → App: {}", source.name),
                                local_summary: None,
                                remote_summary: Some(remote_contact_summary(remote)),
                            },
                            source: source.clone(),
                            payload: PlannedPayload::Contact {
                                local: None,
                                remote: Some(remote.clone()),
                            },
                        },
                    );
                }
            }
        }
    }

    if request.calendars {
        for source in sources.calendars.iter().filter(|source| {
            selected_calendars.contains(source.id.as_str())
                && (!source.shared
                    || if source.mailbox.is_some() {
                        request.shared_mailboxes
                    } else {
                        request.shared_calendars
                    })
        }) {
            let direction = source_direction(request, &source.id);
            let url = format!("{}/events?$select=id,subject,start,end,lastModifiedDateTime,location,body,categories,attendees,onlineMeeting,recurrence&$top=100", source.resource_path);
            let values = graph_collection(access_token, &url).await?;
            remote_events += values.len();
            let remote_by_key: HashMap<String, &Value> = values
                .iter()
                .map(|value| (remote_event_key(value), value))
                .collect();
            let local_keys: HashSet<String> = local_events.iter().map(local_event_key).collect();

            for local in &local_events {
                let key = local_event_key(local);
                if let Some(remote) = remote_by_key.get(&key) {
                    if event_equivalent(local, remote, source) {
                        continue;
                    }
                    let action = match direction.as_str() {
                        "export" => "updateRemote",
                        "import" => "updateLocal",
                        _ => "conflict",
                    };
                    push_operation(
                        &mut operations,
                        PlannedOperation {
                            change: Microsoft365SyncChange {
                                id: operation_id(
                                    "calendar",
                                    &source.id,
                                    &local.id,
                                    value_text(remote, "id"),
                                ),
                                kind: "Kalender".to_string(),
                                action: action.to_string(),
                                source_id: source.id.clone(),
                                source_name: source.name.clone(),
                                title: local.title.clone(),
                                detail: format!(
                                    "Unterschiedliche Angaben. Gewählte Basis: {}.",
                                    request.base
                                ),
                                local_summary: Some(event_summary(local)),
                                remote_summary: Some(remote_event_summary(remote)),
                            },
                            source: source.clone(),
                            payload: PlannedPayload::Calendar {
                                local: Some(local.clone()),
                                remote: Some((*remote).clone()),
                            },
                        },
                    );
                } else if direction != "import" {
                    push_operation(
                        &mut operations,
                        PlannedOperation {
                            change: Microsoft365SyncChange {
                                id: operation_id("calendar", &source.id, &local.id, "new"),
                                kind: "Kalender".to_string(),
                                action: "createRemote".to_string(),
                                source_id: source.id.clone(),
                                source_name: source.name.clone(),
                                title: local.title.clone(),
                                detail: format!("App → M365: {}", source.name),
                                local_summary: Some(event_summary(local)),
                                remote_summary: None,
                            },
                            source: source.clone(),
                            payload: PlannedPayload::Calendar {
                                local: Some(local.clone()),
                                remote: None,
                            },
                        },
                    );
                }
            }
            if direction != "export" {
                for remote in &values {
                    if local_keys.contains(&remote_event_key(remote)) {
                        continue;
                    }
                    push_operation(
                        &mut operations,
                        PlannedOperation {
                            change: Microsoft365SyncChange {
                                id: operation_id(
                                    "calendar",
                                    &source.id,
                                    "new",
                                    value_text(remote, "id"),
                                ),
                                kind: "Kalender".to_string(),
                                action: "createLocal".to_string(),
                                source_id: source.id.clone(),
                                source_name: source.name.clone(),
                                title: value_text(remote, "subject").to_string(),
                                detail: format!("M365 → App: {}", source.name),
                                local_summary: None,
                                remote_summary: Some(remote_event_summary(remote)),
                            },
                            source: source.clone(),
                            payload: PlannedPayload::Calendar {
                                local: None,
                                remote: Some(remote.clone()),
                            },
                        },
                    );
                }
            }
        }
    }

    let create_in_m365 = operations
        .iter()
        .filter(|operation| {
            matches!(
                operation.change.action.as_str(),
                "createRemote" | "updateRemote"
            )
        })
        .count();
    let import_to_app = operations
        .iter()
        .filter(|operation| {
            matches!(
                operation.change.action.as_str(),
                "createLocal" | "updateLocal"
            )
        })
        .count();
    let conflicts = operations
        .iter()
        .filter(|operation| operation.change.action == "conflict")
        .count();
    Ok(Microsoft365SyncPlan {
        preview: Microsoft365SyncPreview {
            local_contacts: local_contacts.len(),
            remote_contacts,
            local_events: local_events.len(),
            remote_events,
            create_in_m365,
            import_to_app,
            conflicts,
            shared_sources_skipped: sources
                .calendars
                .iter()
                .filter(|source| source.shared && !selected_calendars.contains(source.id.as_str()))
                .count(),
            changes: operations
                .iter()
                .map(|operation| operation.change.clone())
                .collect(),
        },
        operations,
    })
}

async fn graph_write(
    access_token: &str,
    method: reqwest::Method,
    url: &str,
    body: &Value,
) -> Result<Value, String> {
    let response = reqwest::Client::new()
        .request(method, url)
        .bearer_auth(access_token)
        .json(body)
        .send()
        .await
        .map_err(|_| "Microsoft Graph ist derzeit nicht erreichbar.".to_string())?;
    let status = response.status();
    if !status.is_success() {
        return Err(format!(
            "Microsoft Graph hat die Änderung abgelehnt (HTTP {}).",
            status.as_u16()
        ));
    }
    if status.as_u16() == 204 {
        return Ok(Value::Null);
    }
    response
        .json::<Value>()
        .await
        .map_err(|_| "Microsoft Graph hat eine ungültige Antwort geliefert.".to_string())
}

fn contact_input_from_contact(contact: &crate::Contact) -> crate::ContactInput {
    crate::ContactInput {
        id: contact.id,
        first_name: contact.first_name.clone(),
        last_name: contact.last_name.clone(),
        display_name: contact.display_name.clone(),
        email: contact.email.clone(),
        phone: contact.phone.clone(),
        mobile_phone: contact.mobile_phone.clone(),
        street: contact.street.clone(),
        postal_code: contact.postal_code.clone(),
        city: contact.city.clone(),
        country: contact.country.clone(),
        short_info: contact.short_info.clone(),
        notes: contact.notes.clone(),
        group_ids: contact.groups.iter().filter_map(|group| group.id).collect(),
    }
}

#[tauri::command]
pub async fn preview_m365_sync(
    app: AppHandle,
    request: Microsoft365SyncPreviewRequest,
) -> Result<Microsoft365SyncPreview, String> {
    let access_token = refreshed_access_token(&app).await?;
    Ok(build_m365_sync_plan(&app, &access_token, &request)
        .await?
        .preview)
}

#[tauri::command]
pub async fn apply_m365_sync(
    app: AppHandle,
    request: Microsoft365SyncApplyRequest,
) -> Result<Microsoft365SyncResult, String> {
    let started_at = Utc::now().to_rfc3339();
    let access_token = refreshed_access_token(&app).await?;
    let preview_request = Microsoft365SyncPreviewRequest {
        direction: request.direction,
        base: request.base,
        contacts: request.contacts,
        calendars: request.calendars,
        shared_calendars: request.shared_calendars,
        shared_mailboxes: request.shared_mailboxes,
        shared_mailbox_addresses: request.shared_mailbox_addresses,
        selected_contact_source_ids: request.selected_contact_source_ids,
        selected_calendar_source_ids: request.selected_calendar_source_ids,
        source_directions: request.source_directions,
        backup: request.backup,
    };
    let plan = build_m365_sync_plan(&app, &access_token, &preview_request).await?;
    let mut result = Microsoft365SyncResult {
        started_at,
        finished_at: String::new(),
        created: 0,
        updated: 0,
        ignored: 0,
        conflicts: plan.preview.conflicts,
        errors: 0,
        error_messages: Vec::new(),
        calendar_upserts: Vec::new(),
    };

    for operation in plan.operations {
        let requested_action = if operation.change.action == "conflict" {
            request
                .decisions
                .get(&operation.change.id)
                .map(String::as_str)
                .unwrap_or("ignore")
        } else {
            operation.change.action.as_str()
        };
        let execution = match (&operation.payload, requested_action) {
            (_, "ignore") => {
                result.ignored += 1;
                Ok(())
            }
            (
                PlannedPayload::Contact {
                    local: Some(local),
                    remote: None,
                },
                "createRemote",
            ) => graph_write(
                &access_token,
                reqwest::Method::POST,
                &operation.source.resource_path,
                &graph_contact_payload(local),
            )
            .await
            .map(|_| {
                result.created += 1;
            }),
            (
                PlannedPayload::Contact {
                    local: None,
                    remote: Some(remote),
                },
                "createLocal",
            ) => crate::save_contact(app.clone(), remote_contact_input(remote, None)).map(|_| {
                result.created += 1;
            }),
            (
                PlannedPayload::Contact {
                    local: Some(local),
                    remote: Some(remote),
                },
                "updateRemote" | "keepApp",
            ) => {
                let url = format!(
                    "{}/{}",
                    operation.source.resource_path,
                    encode_graph_path_segment(value_text(remote, "id"))
                );
                graph_write(
                    &access_token,
                    reqwest::Method::PATCH,
                    &url,
                    &graph_contact_payload(local),
                )
                .await
                .map(|_| {
                    result.updated += 1;
                })
            }
            (
                PlannedPayload::Contact {
                    local: Some(local),
                    remote: Some(remote),
                },
                "updateLocal" | "keepM365",
            ) => crate::save_contact(app.clone(), remote_contact_input(remote, Some(local))).map(
                |_| {
                    result.updated += 1;
                },
            ),
            (
                PlannedPayload::Contact {
                    local: Some(local),
                    remote: Some(remote),
                },
                "merge",
            ) => {
                let merged = merge_contact(local, remote);
                let url = format!(
                    "{}/{}",
                    operation.source.resource_path,
                    encode_graph_path_segment(value_text(remote, "id"))
                );
                match graph_write(
                    &access_token,
                    reqwest::Method::PATCH,
                    &url,
                    &graph_contact_payload(&merged),
                )
                .await
                {
                    Ok(_) => crate::save_contact(app.clone(), contact_input_from_contact(&merged))
                        .map(|_| {
                            result.updated += 2;
                        }),
                    Err(error) => Err(error),
                }
            }
            (
                PlannedPayload::Calendar {
                    local: Some(local),
                    remote: None,
                },
                "createRemote",
            ) => {
                let url = format!("{}/events", operation.source.resource_path);
                graph_write(
                    &access_token,
                    reqwest::Method::POST,
                    &url,
                    &graph_event_payload(local),
                )
                .await
                .map(|_| {
                    result.created += 1;
                })
            }
            (
                PlannedPayload::Calendar {
                    local: None,
                    remote: Some(remote),
                },
                "createLocal",
            ) => {
                result.calendar_upserts.push(remote_event_to_local(
                    remote,
                    &operation.source,
                    None,
                ));
                result.created += 1;
                Ok(())
            }
            (
                PlannedPayload::Calendar {
                    local: Some(local),
                    remote: Some(remote),
                },
                "updateRemote" | "keepApp",
            ) => {
                let url = format!(
                    "{}/events/{}",
                    operation.source.resource_path,
                    encode_graph_path_segment(value_text(remote, "id"))
                );
                graph_write(
                    &access_token,
                    reqwest::Method::PATCH,
                    &url,
                    &graph_event_payload(local),
                )
                .await
                .map(|_| {
                    result.updated += 1;
                })
            }
            (
                PlannedPayload::Calendar {
                    local: Some(local),
                    remote: Some(remote),
                },
                "updateLocal" | "keepM365",
            ) => {
                result.calendar_upserts.push(remote_event_to_local(
                    remote,
                    &operation.source,
                    Some(local),
                ));
                result.updated += 1;
                Ok(())
            }
            (
                PlannedPayload::Calendar {
                    local: Some(local),
                    remote: Some(remote),
                },
                "merge",
            ) => {
                let merged = merge_event(local, remote, &operation.source);
                let url = format!(
                    "{}/events/{}",
                    operation.source.resource_path,
                    encode_graph_path_segment(value_text(remote, "id"))
                );
                match graph_write(
                    &access_token,
                    reqwest::Method::PATCH,
                    &url,
                    &graph_event_payload(&merged),
                )
                .await
                {
                    Ok(_) => {
                        result.calendar_upserts.push(merged);
                        result.updated += 2;
                        Ok(())
                    }
                    Err(error) => Err(error),
                }
            }
            _ => {
                result.ignored += 1;
                Ok(())
            }
        };
        if let Err(error) = execution {
            result.errors += 1;
            if result.error_messages.len() < 20 {
                result
                    .error_messages
                    .push(format!("{}: {error}", operation.change.title));
            }
        }
    }
    result.finished_at = Utc::now().to_rfc3339();
    Ok(result)
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
            "scope=openid+profile+offline_access+User.Read+Contacts.ReadWrite+Contacts.ReadWrite.Shared+Calendars.ReadWrite+Calendars.ReadWrite.Shared+Calendars.Read.Shared+Files.ReadWrite.All+Sites.Read.All"
        );
    }

    #[test]
    fn rejects_unsafe_tenant_values() {
        assert!(is_tenant("organizations"));
        assert!(is_tenant("tenant.onmicrosoft.com"));
        assert!(!is_tenant("../common?redirect=evil"));
    }

    #[test]
    fn encodes_shared_mailbox_path_segments() {
        assert_eq!(
            encode_graph_path_segment("team+archive@example.com"),
            "team%2Barchive%40example.com"
        );
        assert_eq!(
            encode_graph_path_segment("shared mailbox@example.com"),
            "shared%20mailbox%40example.com"
        );
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

    #[test]
    fn maps_graph_contact_fields_into_a_local_contact() {
        let contact = remote_contact_input(
            &json!({
                "givenName": "Ada",
                "surname": "Lovelace",
                "displayName": "Ada Lovelace",
                "emailAddresses": [{ "address": "ada@example.com" }],
                "businessPhones": ["+49 711 1234"],
                "mobilePhone": "+49 170 1234",
                "businessAddress": {
                    "street": "Musterweg 1",
                    "postalCode": "70173",
                    "city": "Stuttgart",
                    "countryOrRegion": "Deutschland"
                },
                "personalNotes": "Aus Microsoft 365"
            }),
            None,
        );

        assert_eq!(contact.display_name, "Ada Lovelace");
        assert_eq!(contact.email, "ada@example.com");
        assert_eq!(contact.phone, "+49 711 1234");
        assert_eq!(contact.city, "Stuttgart");
        assert_eq!(contact.notes, "Aus Microsoft 365");
    }

    #[test]
    fn maps_graph_event_and_keeps_its_selected_source_visible() {
        let source = Microsoft365SyncSource {
            id: "me:calendar:team".to_string(),
            name: "Teamkalender".to_string(),
            kind: "calendar".to_string(),
            editable: true,
            shared: false,
            resource_path: "/me/calendars/team/events".to_string(),
            mailbox: None,
        };
        let event = remote_event_to_local(
            &json!({
                "id": "event-42",
                "subject": "Besprechung",
                "start": { "dateTime": "2026-08-18T09:00:00" },
                "end": { "dateTime": "2026-08-18T10:00:00" },
                "location": { "displayName": "Büro" },
                "body": { "content": "Planung" },
                "categories": ["Wichtig"]
            }),
            &source,
            None,
        );

        assert_eq!(event.id, "m365:me:calendar:team:event-42");
        assert_eq!(event.title, "Besprechung");
        assert_eq!(event.category, "Wichtig");
        assert_eq!(event.source, "Microsoft 365 · Teamkalender");
    }
}
