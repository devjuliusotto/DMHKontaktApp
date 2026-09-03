use crate::{hidden_command, open_db, AppState};
use base64::{
    engine::general_purpose::{STANDARD as BASE64_STANDARD, URL_SAFE_NO_PAD},
    Engine as _,
};
use chrono::{Duration as ChronoDuration, Utc};
use rand::RngCore;
use rusqlite::{params, OptionalExtension};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::collections::{HashMap, HashSet};
use std::io::{ErrorKind, Read, Write};
use std::net::{TcpListener, TcpStream};
use std::sync::{Mutex, OnceLock};
use std::time::{Duration, Instant};
use tauri::{AppHandle, Manager, State};
use tauri_plugin_opener::OpenerExt;
use zeroize::Zeroize;

const TOKEN_SETTING_KEY: &str = "m365_token_bundle_v1";
const PROFILE_SETTING_KEY: &str = "m365_connection_profile_v1";
const DPAPI_ENTROPY: &[u8] = b"de.dmh.agendakontakte.m365.v1";
const GRAPH_PROFILE_URL: &str =
    "https://graph.microsoft.com/v1.0/me?$select=id,displayName,mail,userPrincipalName";
const LOGIN_SCOPES: &str = "openid profile offline_access User.Read Contacts.ReadWrite Contacts.ReadWrite.Shared Calendars.ReadWrite Calendars.ReadWrite.Shared Calendars.Read.Shared MailboxSettings.Read Files.ReadWrite.All Sites.Read.All";
const INTERACTIVE_LOGIN_TIMEOUT: Duration = Duration::from_secs(5 * 60);

#[derive(Default)]
pub struct Microsoft365Runtime {
    pending_device_flow: Mutex<Option<PendingDeviceFlow>>,
    pending_interactive_state: Mutex<Option<String>>,
    access_token: Mutex<Option<CachedAccessToken>>,
    refresh_gate: tokio::sync::Mutex<()>,
    sync_gate: tokio::sync::Mutex<()>,
}

struct CachedAccessToken {
    value: String,
    expires_at: Instant,
}

impl Drop for CachedAccessToken {
    fn drop(&mut self) {
        self.value.zeroize();
    }
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
    #[serde(default)]
    pub contact_groups: bool,
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
    #[serde(default)]
    pub contact_groups: bool,
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
    pub deleted: usize,
    pub ignored: usize,
    pub conflicts: usize,
    pub errors: usize,
    pub error_messages: Vec<String>,
    pub calendar_upserts: Vec<crate::CalendarEvent>,
    pub calendar_deletes: Vec<String>,
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
    #[serde(default = "default_token_lifetime")]
    expires_in: i64,
}

#[derive(Debug, Deserialize)]
struct OAuthErrorResponse {
    #[serde(default)]
    error: String,
    #[serde(default)]
    error_description: String,
}

#[derive(Debug)]
struct OAuthAuthorizationCallback {
    code: String,
    state: String,
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

fn default_token_lifetime() -> i64 {
    3600
}

pub(crate) fn http_client() -> &'static reqwest::Client {
    static CLIENT: OnceLock<reqwest::Client> = OnceLock::new();
    CLIENT.get_or_init(|| {
        reqwest::Client::builder()
            .connect_timeout(Duration::from_secs(10))
            .build()
            .unwrap_or_else(|_| reqwest::Client::new())
    })
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

fn secure_url_token(byte_count: usize) -> String {
    let mut bytes = vec![0_u8; byte_count];
    rand::thread_rng().fill_bytes(&mut bytes);
    URL_SAFE_NO_PAD.encode(bytes)
}

fn pkce_challenge(verifier: &str) -> String {
    URL_SAFE_NO_PAD.encode(Sha256::digest(verifier.as_bytes()))
}

fn interactive_authorization_url(
    client_id: &str,
    redirect_uri: &str,
    state: &str,
    challenge: &str,
) -> String {
    format!(
        "{}?{}",
        oauth_url("authorize"),
        form_body(&[
            ("client_id", client_id),
            ("response_type", "code"),
            ("redirect_uri", redirect_uri),
            ("response_mode", "query"),
            ("scope", LOGIN_SCOPES),
            ("state", state),
            ("code_challenge", challenge),
            ("code_challenge_method", "S256"),
            ("prompt", "select_account"),
        ])
    )
}

fn callback_response_page(success: bool) -> String {
    let (color, icon, title, detail) = if success {
        (
            "#08784f",
            "✓",
            "Microsoft-Anmeldung bestätigt",
            "Sie können dieses Fenster schließen und zu DMH Backup zurückkehren.",
        )
    } else {
        (
            "#a1123f",
            "!",
            "Anmeldung nicht abgeschlossen",
            "Schließen Sie dieses Fenster und versuchen Sie es in DMH Backup erneut.",
        )
    };
    format!(
        "<!doctype html><html lang=\"de\"><meta charset=\"utf-8\"><meta name=\"viewport\" content=\"width=device-width,initial-scale=1\"><title>{title}</title><body style=\"font-family:Segoe UI,Arial,sans-serif;background:#f6f4f5;color:#171717;display:grid;place-items:center;min-height:100vh;margin:0\"><main style=\"background:white;border:1px solid #dcc6cf;border-radius:16px;padding:36px;max-width:520px;text-align:center;box-shadow:0 12px 32px rgba(0,0,0,.1)\"><div style=\"width:64px;height:64px;border-radius:50%;background:{color};color:white;display:grid;place-items:center;font-size:38px;margin:0 auto 20px\">{icon}</div><h1 style=\"font-size:26px;margin:0 0 12px\">{title}</h1><p style=\"font-size:18px;line-height:1.5;margin:0\">{detail}</p></main></body></html>"
    )
}

fn write_callback_response(stream: &mut TcpStream, success: bool) {
    let body = callback_response_page(success);
    let response = format!(
        "HTTP/1.1 200 OK\r\nContent-Type: text/html; charset=utf-8\r\nContent-Length: {}\r\nCache-Control: no-store\r\nConnection: close\r\n\r\n{}",
        body.len(),
        body
    );
    let _ = stream.write_all(response.as_bytes());
    let _ = stream.flush();
}

fn parse_authorization_callback(target: &str) -> Result<OAuthAuthorizationCallback, String> {
    let parsed = url::Url::parse(&format!("http://localhost{target}"))
        .map_err(|_| "Microsoft hat eine ungültige Rückmeldung geliefert.".to_string())?;
    let parameters = parsed.query_pairs().into_owned().collect::<HashMap<_, _>>();
    if let Some(error) = parameters.get("error") {
        return Err(if error == "access_denied" {
            "Die Microsoft-Anmeldung wurde abgebrochen.".to_string()
        } else {
            "Microsoft konnte die Anmeldung nicht abschließen.".to_string()
        });
    }
    let code = parameters
        .get("code")
        .filter(|value| !value.is_empty())
        .cloned()
        .ok_or_else(|| "Microsoft hat keinen Anmeldecode zurückgegeben.".to_string())?;
    let state = parameters
        .get("state")
        .filter(|value| !value.is_empty())
        .cloned()
        .ok_or_else(|| "Microsoft hat die Anmeldung nicht eindeutig bestätigt.".to_string())?;
    Ok(OAuthAuthorizationCallback { code, state })
}

fn read_callback_request(stream: &mut TcpStream) -> Result<String, String> {
    stream
        .set_read_timeout(Some(Duration::from_secs(3)))
        .map_err(|_| "Microsoft-Rückmeldung konnte nicht gelesen werden.".to_string())?;
    let mut buffer = [0_u8; 16 * 1024];
    let length = stream
        .read(&mut buffer)
        .map_err(|_| "Microsoft-Rückmeldung konnte nicht gelesen werden.".to_string())?;
    let request = String::from_utf8_lossy(&buffer[..length]);
    let first_line = request
        .lines()
        .next()
        .ok_or_else(|| "Microsoft hat eine leere Rückmeldung geliefert.".to_string())?;
    let mut parts = first_line.split_whitespace();
    if parts.next() != Some("GET") {
        return Err("Microsoft hat eine ungültige Rückmeldung geliefert.".to_string());
    }
    parts
        .next()
        .map(str::to_string)
        .ok_or_else(|| "Microsoft hat eine ungültige Rückmeldung geliefert.".to_string())
}

fn interactive_state_is_current(app: &AppHandle, expected: &str) -> Result<bool, String> {
    let state = app.state::<AppState>();
    let pending = state
        .m365
        .pending_interactive_state
        .lock()
        .map_err(|_| "Microsoft-Anmeldung konnte intern nicht gelesen werden.".to_string())?;
    Ok(pending.as_deref() == Some(expected))
}

fn clear_interactive_state(app: &AppHandle, expected: &str) -> Result<(), String> {
    let state = app.state::<AppState>();
    let mut pending = state
        .m365
        .pending_interactive_state
        .lock()
        .map_err(|_| "Microsoft-Anmeldung konnte intern nicht beendet werden.".to_string())?;
    if pending.as_deref() == Some(expected) {
        *pending = None;
    }
    Ok(())
}

async fn wait_for_authorization_callback(
    app: &AppHandle,
    listener: &TcpListener,
    expected_state: &str,
) -> Result<OAuthAuthorizationCallback, String> {
    let deadline = Instant::now() + INTERACTIVE_LOGIN_TIMEOUT;
    loop {
        if !interactive_state_is_current(app, expected_state)? {
            return Err("Die Microsoft-Anmeldung wurde abgebrochen.".to_string());
        }
        if Instant::now() >= deadline {
            return Err(
                "Die Microsoft-Anmeldung hat zu lange gedauert. Versuchen Sie es erneut."
                    .to_string(),
            );
        }
        match listener.accept() {
            Ok((mut stream, _)) => {
                let callback = read_callback_request(&mut stream)
                    .and_then(|target| parse_authorization_callback(&target));
                let valid = callback
                    .as_ref()
                    .is_ok_and(|callback| callback.state == expected_state);
                write_callback_response(&mut stream, valid);
                let callback = callback?;
                if callback.state != expected_state {
                    return Err("Die Microsoft-Anmeldung konnte aus Sicherheitsgründen nicht bestätigt werden.".to_string());
                }
                return Ok(callback);
            }
            Err(error) if error.kind() == ErrorKind::WouldBlock => {
                tokio::time::sleep(Duration::from_millis(120)).await;
            }
            Err(_) => {
                return Err(
                    "Die automatische Rückkehr von Microsoft konnte nicht empfangen werden."
                        .to_string(),
                )
            }
        }
    }
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

fn microsoft_session_requires_reconnect(error: &str) -> bool {
    error.contains("Microsoft-Sitzung ist abgelaufen")
        || error.contains("Microsoft-365-Konto ist nicht verbunden")
        || error.contains("gespeicherte Microsoft-Anmeldung ist ungültig")
        || error.contains("gespeicherte Microsoft-Anmeldung konnte nicht gelesen werden")
        || error.contains("Microsoft-365-Kontoprofil fehlt")
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
    let response = http_client()
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
    let state = app.state::<AppState>();
    if let Some(token) = cached_access_token(&state)? {
        return Ok(token);
    }
    let _refresh_guard = state.m365.refresh_gate.lock().await;
    if let Some(token) = cached_access_token(&state)? {
        return Ok(token);
    }
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
    let expires_in = token.expires_in.max(300) as u64;
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
    let access_token = token.access_token;
    *state.m365.access_token.lock().map_err(|_| {
        "Microsoft-Anmeldung konnte intern nicht zwischengespeichert werden.".to_string()
    })? = Some(CachedAccessToken {
        value: access_token.clone(),
        expires_at: Instant::now() + Duration::from_secs(expires_in),
    });
    Ok(access_token)
}

fn cached_access_token(state: &State<'_, AppState>) -> Result<Option<String>, String> {
    let mut cache = state
        .m365
        .access_token
        .lock()
        .map_err(|_| "Microsoft-Anmeldung konnte intern nicht gelesen werden.".to_string())?;
    if cache
        .as_ref()
        .is_some_and(|token| token.expires_at > Instant::now() + Duration::from_secs(60))
    {
        return Ok(cache.as_ref().map(|token| token.value.clone()));
    }
    *cache = None;
    Ok(None)
}

pub(crate) async fn graph_json(access_token: &str, url: &str) -> Result<Value, String> {
    let response = http_client()
        .get(url)
        .bearer_auth(access_token)
        .header("Prefer", "outlook.timezone=\"W. Europe Standard Time\"")
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

fn remote_contact_input_for_source(
    value: &Value,
    existing: Option<&crate::Contact>,
    backup: &crate::BackupData,
    source: &Microsoft365SyncSource,
) -> crate::ContactInput {
    let mut input = remote_contact_input(value, existing);
    if let Some(group_id) = source_group_id(backup, source) {
        if !input.group_ids.contains(&group_id) {
            input.group_ids.push(group_id);
        }
    }
    input
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

fn decode_html_entities(value: &str) -> String {
    let chars = value.chars().collect::<Vec<_>>();
    let mut decoded = String::with_capacity(value.len());
    let mut index = 0usize;
    while index < chars.len() {
        if chars[index] != '&' {
            decoded.push(chars[index]);
            index += 1;
            continue;
        }
        let Some(end) = chars[index + 1..]
            .iter()
            .position(|character| *character == ';')
            .map(|offset| index + 1 + offset)
        else {
            decoded.push('&');
            index += 1;
            continue;
        };
        let entity = chars[index + 1..end].iter().collect::<String>();
        let replacement = match entity.as_str() {
            "amp" => Some('&'),
            "lt" => Some('<'),
            "gt" => Some('>'),
            "quot" => Some('"'),
            "apos" | "#39" => Some('\''),
            "nbsp" => Some(' '),
            _ if entity.starts_with("#x") || entity.starts_with("#X") => {
                u32::from_str_radix(&entity[2..], 16)
                    .ok()
                    .and_then(char::from_u32)
            }
            _ if entity.starts_with('#') => {
                entity[1..].parse::<u32>().ok().and_then(char::from_u32)
            }
            _ => None,
        };
        if let Some(character) = replacement {
            decoded.push(character);
            index = end + 1;
        } else {
            decoded.push('&');
            index += 1;
        }
    }
    decoded
}

fn html_to_plain_text(value: &str) -> String {
    let chars = value.chars().collect::<Vec<_>>();
    let mut text = String::with_capacity(value.len());
    let mut index = 0usize;
    let mut suppressed_tag: Option<String> = None;
    while index < chars.len() {
        if chars[index] != '<' {
            if suppressed_tag.is_none() {
                text.push(chars[index]);
            }
            index += 1;
            continue;
        }
        let Some(end) = chars[index + 1..]
            .iter()
            .position(|character| *character == '>')
            .map(|offset| index + 1 + offset)
        else {
            if suppressed_tag.is_none() {
                text.push('<');
            }
            index += 1;
            continue;
        };
        let raw_tag = chars[index + 1..end].iter().collect::<String>();
        let trimmed = raw_tag.trim();
        let closing = trimmed.starts_with('/');
        let tag_name = trimmed
            .trim_start_matches('/')
            .split_ascii_whitespace()
            .next()
            .unwrap_or("")
            .trim_end_matches('/')
            .to_ascii_lowercase();
        if matches!(tag_name.as_str(), "head" | "style" | "script") {
            if closing {
                if suppressed_tag.as_deref() == Some(tag_name.as_str()) {
                    suppressed_tag = None;
                }
            } else if suppressed_tag.is_none() {
                suppressed_tag = Some(tag_name.clone());
            }
        } else if suppressed_tag.is_none()
            && matches!(
                tag_name.as_str(),
                "br" | "p"
                    | "div"
                    | "li"
                    | "tr"
                    | "table"
                    | "ul"
                    | "ol"
                    | "h1"
                    | "h2"
                    | "h3"
                    | "h4"
                    | "h5"
                    | "h6"
            )
        {
            text.push('\n');
        }
        index = end + 1;
    }

    decode_html_entities(&text)
        .lines()
        .map(|line| line.split_whitespace().collect::<Vec<_>>().join(" "))
        .filter(|line| !line.is_empty())
        .collect::<Vec<_>>()
        .join("\n")
}

fn remote_event_description(value: &Value) -> String {
    let Some(body) = value.get("body") else {
        return String::new();
    };
    let content = body.get("content").and_then(Value::as_str).unwrap_or("");
    if body
        .get("contentType")
        .and_then(Value::as_str)
        .is_some_and(|content_type| content_type.eq_ignore_ascii_case("html"))
    {
        html_to_plain_text(content)
    } else {
        content.to_string()
    }
}

fn deleted_calendar_events(backup: &crate::BackupData) -> Vec<crate::CalendarEvent> {
    backup
        .browser_storage
        .get("agendakontakte.deletedCalendarEvents")
        .and_then(|raw| serde_json::from_str::<Vec<crate::CalendarEvent>>(raw).ok())
        .unwrap_or_default()
}

fn linked_calendar_remote_id<'a>(
    event: &'a crate::CalendarEvent,
    source_id: &str,
) -> Option<&'a str> {
    event.id.strip_prefix(&format!("m365:{source_id}:"))
}

fn normalized_duplicate_value(value: &str) -> String {
    value
        .split_whitespace()
        .collect::<Vec<_>>()
        .join(" ")
        .to_lowercase()
}

fn calendar_event_duplicate_key(event: &crate::CalendarEvent) -> Option<String> {
    if event.title.trim().is_empty()
        || event.starts_at.trim().is_empty()
        || event.ends_at.trim().is_empty()
    {
        return None;
    }
    Some(format!(
        "{}|{}|{}|{}|{}|{}|{}|{}|{}",
        normalized_duplicate_value(&event.title),
        event.starts_at.trim(),
        event.ends_at.trim(),
        normalized_duplicate_value(&event.location),
        normalized_duplicate_value(&html_to_plain_text(&event.description)),
        normalized_duplicate_value(&event.category),
        serde_json::to_string(&event.recurrence).unwrap_or_default(),
        serde_json::to_string(&event.excluded_dates).unwrap_or_default(),
        event.recurrence_id.as_deref().unwrap_or("")
    ))
}

fn duplicate_calendar_event_ids(
    events: &[crate::CalendarEvent],
    sources: &[Microsoft365SyncSource],
    export_target_id: Option<&str>,
) -> HashSet<String> {
    let mut groups = HashMap::<String, Vec<&crate::CalendarEvent>>::new();
    for event in events {
        if let Some(key) = calendar_event_duplicate_key(event) {
            groups.entry(key).or_default().push(event);
        }
    }

    let mut duplicate_ids = HashSet::new();
    for group in groups.values().filter(|group| group.len() > 1) {
        let keep =
            group
                .iter()
                .min_by_key(|event| match linked_calendar_source_id(event, sources) {
                    Some(source_id) if Some(source_id) == export_target_id => 0u8,
                    Some(_) => 1u8,
                    None => 2u8,
                });
        for event in group {
            if keep.is_some_and(|kept| kept.id == event.id) {
                continue;
            }
            duplicate_ids.insert(event.id.clone());
        }
    }
    duplicate_ids
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

fn outlook_category_color(value: &str) -> &'static str {
    match value.trim().to_ascii_lowercase().as_str() {
        "preset0" | "preset9" | "preset15" | "preset24" => "red",
        "preset1" | "preset2" | "preset3" | "preset16" | "preset17" | "preset18" => "yellow",
        "preset4" | "preset5" | "preset6" | "preset19" | "preset20" | "preset21" => "green",
        "preset7" | "preset22" => "blue",
        "preset8" | "preset23" => "purple",
        "preset10" | "preset11" | "preset12" | "preset13" | "preset14" => "gray",
        _ => "blue",
    }
}

async fn m365_master_category_colors(access_token: &str) -> HashMap<String, String> {
    let Ok(categories) = graph_collection(
        access_token,
        "https://graph.microsoft.com/v1.0/me/outlook/masterCategories?$select=displayName,color",
    )
    .await
    else {
        return HashMap::new();
    };
    categories
        .into_iter()
        .filter_map(|category| {
            let name = value_text(&category, "displayName").trim();
            if name.is_empty() {
                return None;
            }
            Some((
                name.to_lowercase(),
                outlook_category_color(value_text(&category, "color")).to_string(),
            ))
        })
        .collect()
}

fn apply_m365_category_color(value: &mut Value, colors: &HashMap<String, String>) {
    let category = value
        .get("categories")
        .and_then(Value::as_array)
        .and_then(|categories| categories.first())
        .and_then(Value::as_str)
        .unwrap_or("")
        .trim()
        .to_lowercase();
    let Some(color) = colors.get(&category) else {
        return;
    };
    if let Some(object) = value.as_object_mut() {
        object.insert(
            "_dmhCategoryColor".to_string(),
            Value::String(color.clone()),
        );
    }
}

fn remote_event_to_local(
    value: &Value,
    source: &Microsoft365SyncSource,
    existing: Option<&crate::CalendarEvent>,
) -> crate::CalendarEvent {
    let remote_id = value_text(value, "id");
    let category = value
        .get("categories")
        .and_then(Value::as_array)
        .and_then(|categories| categories.first())
        .and_then(Value::as_str)
        .unwrap_or("")
        .to_string();
    let imported_color = value_text(value, "_dmhCategoryColor");
    crate::CalendarEvent {
        id: existing
            .filter(|event| linked_calendar_remote_id(event, &source.id).is_some())
            .map(|event| event.id.clone())
            .unwrap_or_else(|| format!("m365:{}:{remote_id}", source.id)),
        updated_at: value_text(value, "lastModifiedDateTime").to_string(),
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
        description: remote_event_description(value),
        color: if imported_color.is_empty() {
            existing
                .map(|event| event.color.clone())
                .unwrap_or_else(|| "blue".to_string())
        } else {
            imported_color.to_string()
        },
        category,
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
        && local.color.trim() == remote_local.color.trim()
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
    if !value_text(remote, "_dmhCategoryColor").is_empty() {
        merged.color = remote_local.color;
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
        "body": {"contentType": "text", "content": html_to_plain_text(&event.description)},
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

fn calendar_source_is_enabled(
    request: &Microsoft365SyncPreviewRequest,
    selected: &HashSet<&str>,
    source: &Microsoft365SyncSource,
) -> bool {
    selected.contains(source.id.as_str())
        && (!source.shared
            || if source.mailbox.is_some() {
                request.shared_mailboxes
            } else {
                request.shared_calendars
            })
}

fn calendar_export_target_id<'a>(
    request: &Microsoft365SyncPreviewRequest,
    sources: &'a [Microsoft365SyncSource],
    selected: &HashSet<&str>,
) -> Option<&'a str> {
    request.selected_calendar_source_ids.iter().find_map(|id| {
        sources
            .iter()
            .find(|source| {
                source.id.as_str() == id.as_str()
                    && source.editable
                    && calendar_source_is_enabled(request, selected, source)
                    && source_direction(request, &source.id) != "import"
            })
            .map(|source| source.id.as_str())
    })
}

fn linked_calendar_source_id<'a>(
    event: &crate::CalendarEvent,
    sources: &'a [Microsoft365SyncSource],
) -> Option<&'a str> {
    sources
        .iter()
        .find(|source| linked_calendar_remote_id(event, &source.id).is_some())
        .map(|source| source.id.as_str())
}

fn local_event_belongs_to_calendar_source(
    event: &crate::CalendarEvent,
    source: &Microsoft365SyncSource,
    sources: &[Microsoft365SyncSource],
    export_target_id: Option<&str>,
) -> bool {
    match linked_calendar_source_id(event, sources) {
        Some(linked_source_id) => linked_source_id == source.id,
        None => export_target_id == Some(source.id.as_str()),
    }
}

fn source_group_id(backup: &crate::BackupData, source: &Microsoft365SyncSource) -> Option<i64> {
    if source.shared || source.id == "me:default-contacts" {
        return None;
    }
    backup
        .groups
        .iter()
        .find(|group| {
            group.deleted_at.is_none() && group.name.trim().eq_ignore_ascii_case(source.name.trim())
        })
        .and_then(|group| group.id)
}

fn contact_source_selected(
    request: &Microsoft365SyncPreviewRequest,
    selected: &HashSet<&str>,
    source: &Microsoft365SyncSource,
) -> bool {
    selected.contains(source.id.as_str())
        || (request.contact_groups && source_group_id(&request.backup, source).is_some())
}

fn local_contacts_for_source(
    contacts: &[crate::Contact],
    request: &Microsoft365SyncPreviewRequest,
    source: &Microsoft365SyncSource,
) -> Vec<crate::Contact> {
    if !request.contact_groups || source.shared {
        return contacts.to_vec();
    }
    if source.id == "me:default-contacts" {
        return contacts
            .iter()
            .filter(|contact| contact.groups.is_empty())
            .cloned()
            .collect();
    }
    let Some(group_id) = source_group_id(&request.backup, source) else {
        return Vec::new();
    };
    contacts
        .iter()
        .filter(|contact| {
            contact
                .groups
                .iter()
                .any(|group| group.id == Some(group_id))
        })
        .cloned()
        .collect()
}

fn load_contact_links(
    app: &AppHandle,
    source_id: &str,
) -> Result<(HashMap<i64, String>, HashMap<String, i64>), String> {
    let conn = open_db(app)?;
    let mut statement = conn
        .prepare("SELECT local_contact_id, remote_id FROM m365_contact_links WHERE source_id = ?")
        .map_err(|error| error.to_string())?;
    let rows = statement
        .query_map(params![source_id], |row| {
            Ok((row.get::<_, i64>(0)?, row.get::<_, String>(1)?))
        })
        .map_err(|error| error.to_string())?;
    let mut by_local = HashMap::new();
    let mut by_remote = HashMap::new();
    for row in rows {
        let (local_id, remote_id) = row.map_err(|error| error.to_string())?;
        by_remote.insert(remote_id.clone(), local_id);
        by_local.insert(local_id, remote_id);
    }
    Ok((by_local, by_remote))
}

fn save_contact_link(
    app: &AppHandle,
    local_contact_id: i64,
    source_id: &str,
    remote_id: &str,
) -> Result<(), String> {
    let conn = open_db(app)?;
    conn.execute(
        "INSERT INTO m365_contact_links (local_contact_id, source_id, remote_id, updated_at)
         VALUES (?, ?, ?, ?)
         ON CONFLICT(local_contact_id, source_id) DO UPDATE SET
           remote_id = excluded.remote_id, updated_at = excluded.updated_at",
        params![
            local_contact_id,
            source_id,
            remote_id,
            Utc::now().to_rfc3339()
        ],
    )
    .map_err(|error| error.to_string())?;
    Ok(())
}

fn delete_contact_link(
    app: &AppHandle,
    local_contact_id: i64,
    source_id: &str,
) -> Result<(), String> {
    let conn = open_db(app)?;
    conn.execute(
        "DELETE FROM m365_contact_links WHERE local_contact_id = ? AND source_id = ?",
        params![local_contact_id, source_id],
    )
    .map_err(|error| error.to_string())?;
    Ok(())
}

fn remove_contact_from_group(
    app: &AppHandle,
    local_contact_id: i64,
    group_id: i64,
) -> Result<(), String> {
    let conn = open_db(app)?;
    conn.execute(
        "DELETE FROM contact_groups WHERE contact_id = ? AND group_id = ?",
        params![local_contact_id, group_id],
    )
    .map_err(|error| error.to_string())?;
    Ok(())
}

fn local_changed_after_remote(local_updated_at: &str, remote: &Value) -> bool {
    let remote_updated_at = value_text(remote, "lastModifiedDateTime");
    match (
        chrono::DateTime::parse_from_rfc3339(local_updated_at),
        chrono::DateTime::parse_from_rfc3339(remote_updated_at),
    ) {
        (Ok(local), Ok(remote)) => local > remote,
        _ => !local_updated_at.trim().is_empty() && local_updated_at > remote_updated_at,
    }
}

async fn ensure_contact_group_folders(
    access_token: &str,
    backup: &crate::BackupData,
) -> Result<(), String> {
    let folders = graph_collection(
        access_token,
        "https://graph.microsoft.com/v1.0/me/contactFolders?$select=id,displayName&$top=100",
    )
    .await?;
    let existing: HashSet<String> = folders
        .iter()
        .map(|folder| value_text(folder, "displayName").trim().to_lowercase())
        .collect();
    for group in backup
        .groups
        .iter()
        .filter(|group| group.deleted_at.is_none())
    {
        let name = group.name.trim();
        if name.is_empty() || existing.contains(&name.to_lowercase()) {
            continue;
        }
        graph_write(
            access_token,
            reqwest::Method::POST,
            "https://graph.microsoft.com/v1.0/me/contactFolders",
            &json!({ "displayName": name }),
        )
        .await?;
    }
    Ok(())
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
    let local_contacts_by_key: HashMap<String, &crate::Contact> = local_contacts
        .iter()
        .map(|contact| (local_contact_key(contact), contact))
        .collect();
    let local_events: Vec<crate::CalendarEvent> = local_calendar_events(&request.backup)
        .into_iter()
        .filter(|event| event.deleted_at.is_none())
        .collect();
    let mut operations = Vec::new();
    let mut remote_contacts = 0usize;
    let mut remote_events = 0usize;
    let calendar_export_target_id =
        calendar_export_target_id(request, &sources.calendars, &selected_calendars);
    let duplicate_calendar_event_ids =
        duplicate_calendar_event_ids(&local_events, &sources.calendars, calendar_export_target_id);
    let master_category_colors = if request.calendars {
        m365_master_category_colors(access_token).await
    } else {
        HashMap::new()
    };

    if request.contacts {
        for source in sources.contacts.iter().filter(|source| {
            contact_source_selected(request, &selected_contacts, source)
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
            let remote_by_id: HashMap<String, &Value> = values
                .iter()
                .map(|value| (value_text(value, "id").to_string(), value))
                .collect();
            let source_contacts = local_contacts_for_source(&local_contacts, request, source);
            let source_contact_ids: HashSet<i64> = source_contacts
                .iter()
                .filter_map(|contact| contact.id)
                .collect();
            let local_keys: HashSet<String> =
                source_contacts.iter().map(local_contact_key).collect();
            let (links_by_local, links_by_remote) = load_contact_links(app, &source.id)?;
            let mut matched_remote_ids = HashSet::new();

            for local in &source_contacts {
                let local_id = local.id.unwrap_or_default();
                let linked_remote_id = links_by_local.get(&local_id);
                let linked_remote = links_by_local
                    .get(&local_id)
                    .and_then(|remote_id| remote_by_id.get(remote_id).copied());
                let remote =
                    linked_remote.or_else(|| remote_by_key.get(&local_contact_key(local)).copied());
                if let Some(remote) = remote {
                    let remote_id = value_text(remote, "id");
                    matched_remote_ids.insert(remote_id.to_string());
                    let equivalent = contact_equivalent(local, remote);
                    let is_linked =
                        linked_remote_id.is_some_and(|linked_id| linked_id == remote_id);
                    if equivalent && is_linked {
                        continue;
                    }
                    let action = match direction.as_str() {
                        "export" => "updateRemote",
                        "import" => "updateLocal",
                        _ if equivalent => "updateLocal",
                        _ if local_changed_after_remote(&local.updated_at, remote) => {
                            "updateRemote"
                        }
                        _ => "updateLocal",
                    };
                    push_operation(
                        &mut operations,
                        PlannedOperation {
                            change: Microsoft365SyncChange {
                                id: operation_id(
                                    "contact",
                                    &source.id,
                                    &local_id.to_string(),
                                    remote_id,
                                ),
                                kind: "Kontakt".to_string(),
                                action: action.to_string(),
                                source_id: source.id.clone(),
                                source_name: source.name.clone(),
                                title: local.display_name.clone(),
                                detail: if equivalent {
                                    "Kontakt wird dauerhaft mit Microsoft 365 verknüpft."
                                        .to_string()
                                } else {
                                    "Neueste Änderung wird übernommen.".to_string()
                                },
                                local_summary: Some(contact_summary(local)),
                                remote_summary: Some(remote_contact_summary(remote)),
                            },
                            source: source.clone(),
                            payload: PlannedPayload::Contact {
                                local: Some(local.clone()),
                                remote: Some(remote.clone()),
                            },
                        },
                    );
                } else if links_by_local.contains_key(&local_id) && direction != "export" {
                    push_operation(
                        &mut operations,
                        PlannedOperation {
                            change: Microsoft365SyncChange {
                                id: operation_id(
                                    "contact",
                                    &source.id,
                                    &local_id.to_string(),
                                    "deleted",
                                ),
                                kind: "Kontakt".to_string(),
                                action: "deleteLocal".to_string(),
                                source_id: source.id.clone(),
                                source_name: source.name.clone(),
                                title: local.display_name.clone(),
                                detail: "In Microsoft 365 gelöscht → App-Papierkorb".to_string(),
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
                } else if direction != "import" {
                    push_operation(
                        &mut operations,
                        PlannedOperation {
                            change: Microsoft365SyncChange {
                                id: operation_id(
                                    "contact",
                                    &source.id,
                                    &local_id.to_string(),
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

            if direction != "import" {
                for local in local_contacts.iter().filter(|contact| {
                    contact.id.is_some_and(|id| {
                        links_by_local.contains_key(&id) && !source_contact_ids.contains(&id)
                    })
                }) {
                    let local_id = local.id.unwrap_or_default();
                    let Some(remote_id) = links_by_local.get(&local_id) else {
                        continue;
                    };
                    let Some(remote) = remote_by_id.get(remote_id).copied() else {
                        continue;
                    };
                    push_operation(
                        &mut operations,
                        PlannedOperation {
                            change: Microsoft365SyncChange {
                                id: operation_id(
                                    "contact",
                                    &source.id,
                                    &local_id.to_string(),
                                    remote_id,
                                ),
                                kind: "Kontakt".to_string(),
                                action: "deleteRemote".to_string(),
                                source_id: source.id.clone(),
                                source_name: source.name.clone(),
                                title: local.display_name.clone(),
                                detail: "Kontakt wurde aus diesem App-Ordner verschoben."
                                    .to_string(),
                                local_summary: Some(contact_summary(local)),
                                remote_summary: Some(remote_contact_summary(remote)),
                            },
                            source: source.clone(),
                            payload: PlannedPayload::Contact {
                                local: Some(local.clone()),
                                remote: Some(remote.clone()),
                            },
                        },
                    );
                }
            }

            for deleted in request
                .backup
                .contacts
                .iter()
                .filter(|contact| contact.deleted_at.is_some())
            {
                let Some(local_id) = deleted.id else {
                    continue;
                };
                let Some(remote_id) = links_by_local.get(&local_id) else {
                    continue;
                };
                let Some(remote) = remote_by_id.get(remote_id).copied() else {
                    continue;
                };
                if direction == "import" {
                    continue;
                }
                push_operation(
                    &mut operations,
                    PlannedOperation {
                        change: Microsoft365SyncChange {
                            id: operation_id(
                                "contact",
                                &source.id,
                                &local_id.to_string(),
                                remote_id,
                            ),
                            kind: "Kontakt".to_string(),
                            action: "deleteRemote".to_string(),
                            source_id: source.id.clone(),
                            source_name: source.name.clone(),
                            title: deleted.display_name.clone(),
                            detail: "App-Papierkorb → in Microsoft 365 löschen".to_string(),
                            local_summary: Some(contact_summary(deleted)),
                            remote_summary: Some(remote_contact_summary(remote)),
                        },
                        source: source.clone(),
                        payload: PlannedPayload::Contact {
                            local: Some(deleted.clone()),
                            remote: Some(remote.clone()),
                        },
                    },
                );
            }

            if direction != "export" {
                for remote in &values {
                    let remote_id = value_text(remote, "id");
                    if matched_remote_ids.contains(remote_id)
                        || links_by_remote.contains_key(remote_id)
                        || local_keys.contains(&normalized_contact_key(remote))
                    {
                        continue;
                    }
                    if let Some(local) = local_contacts_by_key.get(&normalized_contact_key(remote))
                    {
                        if request.contact_groups && direction != "import" {
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
                                        action: "deleteRemote".to_string(),
                                        source_id: source.id.clone(),
                                        source_name: source.name.clone(),
                                        title: local.display_name.clone(),
                                        detail: "Kontakt gehört im App zu einem anderen Ordner."
                                            .to_string(),
                                        local_summary: Some(contact_summary(local)),
                                        remote_summary: Some(remote_contact_summary(remote)),
                                    },
                                    source: source.clone(),
                                    payload: PlannedPayload::Contact {
                                        local: Some((*local).clone()),
                                        remote: Some(remote.clone()),
                                    },
                                },
                            );
                        }
                        continue;
                    }
                    push_operation(
                        &mut operations,
                        PlannedOperation {
                            change: Microsoft365SyncChange {
                                id: operation_id("contact", &source.id, "new", remote_id),
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
        let local_cleanup_source = calendar_export_target_id
            .and_then(|target_id| {
                sources
                    .calendars
                    .iter()
                    .find(|source| source.id == target_id)
            })
            .or_else(|| {
                sources
                    .calendars
                    .iter()
                    .find(|source| calendar_source_is_enabled(request, &selected_calendars, source))
            });
        if let Some(cleanup_source) = local_cleanup_source {
            for local in local_events.iter().filter(|event| {
                duplicate_calendar_event_ids.contains(&event.id)
                    && linked_calendar_source_id(event, &sources.calendars).is_none()
            }) {
                push_operation(
                    &mut operations,
                    PlannedOperation {
                        change: Microsoft365SyncChange {
                            id: operation_id(
                                "calendar",
                                &cleanup_source.id,
                                &local.id,
                                "duplicate",
                            ),
                            kind: "Kalender".to_string(),
                            action: "deleteLocal".to_string(),
                            source_id: cleanup_source.id.clone(),
                            source_name: cleanup_source.name.clone(),
                            title: local.title.clone(),
                            detail: "Überzählige lokale Terminkopie entfernen; eine Kopie bleibt erhalten."
                                .to_string(),
                            local_summary: Some(event_summary(local)),
                            remote_summary: None,
                        },
                        source: cleanup_source.clone(),
                        payload: PlannedPayload::Calendar {
                            local: Some(local.clone()),
                            remote: None,
                        },
                    },
                );
            }
        }

        for source in sources
            .calendars
            .iter()
            .filter(|source| calendar_source_is_enabled(request, &selected_calendars, source))
        {
            let direction = source_direction(request, &source.id);
            let url = format!("{}/events?$select=id,subject,start,end,lastModifiedDateTime,location,body,categories,attendees,onlineMeeting,recurrence&$top=100", source.resource_path);
            let mut values = graph_collection(access_token, &url).await?;
            for value in &mut values {
                apply_m365_category_color(value, &master_category_colors);
            }
            remote_events += values.len();
            let remote_by_key: HashMap<String, &Value> = values
                .iter()
                .map(|value| (remote_event_key(value), value))
                .collect();
            let remote_by_id: HashMap<String, &Value> = values
                .iter()
                .map(|value| (value_text(value, "id").to_string(), value))
                .collect();
            let local_keys: HashSet<String> = local_events.iter().map(local_event_key).collect();
            let mut matched_remote_ids = HashSet::new();

            for local in local_events.iter().filter(|event| {
                duplicate_calendar_event_ids.contains(&event.id)
                    && linked_calendar_remote_id(event, &source.id).is_some()
            }) {
                let remote = linked_calendar_remote_id(local, &source.id)
                    .and_then(|remote_id| remote_by_id.get(remote_id).copied());
                let (action, remote_summary) = if let Some(remote) = remote {
                    if !source.editable {
                        continue;
                    }
                    ("deleteRemote", Some(remote_event_summary(remote)))
                } else {
                    ("deleteLocal", None)
                };
                push_operation(
                    &mut operations,
                    PlannedOperation {
                        change: Microsoft365SyncChange {
                            id: operation_id(
                                "calendar",
                                &source.id,
                                &local.id,
                                "duplicate",
                            ),
                            kind: "Kalender".to_string(),
                            action: action.to_string(),
                            source_id: source.id.clone(),
                            source_name: source.name.clone(),
                            title: local.title.clone(),
                            detail: "Überzählige Terminkopie in App und Exchange entfernen; eine Kopie bleibt erhalten."
                                .to_string(),
                            local_summary: Some(event_summary(local)),
                            remote_summary,
                        },
                        source: source.clone(),
                        payload: PlannedPayload::Calendar {
                            local: Some(local.clone()),
                            remote: remote.cloned(),
                        },
                    },
                );
            }

            for local in &local_events {
                if duplicate_calendar_event_ids.contains(&local.id) {
                    continue;
                }
                if !local_event_belongs_to_calendar_source(
                    local,
                    source,
                    &sources.calendars,
                    calendar_export_target_id,
                ) {
                    continue;
                }
                let linked_id = linked_calendar_remote_id(local, &source.id);
                let remote = linked_id
                    .and_then(|remote_id| remote_by_id.get(remote_id).copied())
                    .or_else(|| remote_by_key.get(&local_event_key(local)).copied());
                if let Some(remote) = remote {
                    let remote_id = value_text(remote, "id");
                    matched_remote_ids.insert(remote_id.to_string());
                    let equivalent = event_equivalent(local, remote, source);
                    if equivalent && linked_id.is_some() {
                        continue;
                    }
                    let action = match direction.as_str() {
                        "export" => "updateRemote",
                        "import" => "updateLocal",
                        _ if equivalent => "updateLocal",
                        _ if local_changed_after_remote(&local.updated_at, remote) => {
                            "updateRemote"
                        }
                        _ => "updateLocal",
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
                                detail: if equivalent {
                                    "Termin wird dauerhaft mit Microsoft 365 verknüpft.".to_string()
                                } else {
                                    "Neueste Änderung wird übernommen.".to_string()
                                },
                                local_summary: Some(event_summary(local)),
                                remote_summary: Some(remote_event_summary(remote)),
                            },
                            source: source.clone(),
                            payload: PlannedPayload::Calendar {
                                local: Some(local.clone()),
                                remote: Some(remote.clone()),
                            },
                        },
                    );
                } else if linked_id.is_some() && direction != "export" {
                    push_operation(
                        &mut operations,
                        PlannedOperation {
                            change: Microsoft365SyncChange {
                                id: operation_id("calendar", &source.id, &local.id, "deleted"),
                                kind: "Kalender".to_string(),
                                action: "deleteLocal".to_string(),
                                source_id: source.id.clone(),
                                source_name: source.name.clone(),
                                title: local.title.clone(),
                                detail: "In Microsoft 365 gelöscht → App-Papierkorb".to_string(),
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

            for deleted in deleted_calendar_events(&request.backup) {
                let Some(remote_id) = linked_calendar_remote_id(&deleted, &source.id) else {
                    continue;
                };
                let Some(remote) = remote_by_id.get(remote_id).copied() else {
                    continue;
                };
                if direction == "import" {
                    continue;
                }
                push_operation(
                    &mut operations,
                    PlannedOperation {
                        change: Microsoft365SyncChange {
                            id: operation_id("calendar", &source.id, &deleted.id, remote_id),
                            kind: "Kalender".to_string(),
                            action: "deleteRemote".to_string(),
                            source_id: source.id.clone(),
                            source_name: source.name.clone(),
                            title: deleted.title.clone(),
                            detail: "App-Papierkorb → in Microsoft 365 löschen".to_string(),
                            local_summary: Some(event_summary(&deleted)),
                            remote_summary: Some(remote_event_summary(remote)),
                        },
                        source: source.clone(),
                        payload: PlannedPayload::Calendar {
                            local: Some(deleted),
                            remote: Some(remote.clone()),
                        },
                    },
                );
            }
            if direction != "export" {
                for remote in &values {
                    if matched_remote_ids.contains(value_text(remote, "id"))
                        || local_keys.contains(&remote_event_key(remote))
                    {
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
                "createRemote" | "updateRemote" | "deleteRemote"
            )
        })
        .count();
    let import_to_app = operations
        .iter()
        .filter(|operation| {
            matches!(
                operation.change.action.as_str(),
                "createLocal" | "updateLocal" | "deleteLocal"
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
    let response = http_client()
        .request(method, url)
        .bearer_auth(access_token)
        .header("Prefer", "outlook.timezone=\"W. Europe Standard Time\"")
        .json(body)
        .send()
        .await
        .map_err(|_| "Microsoft Graph ist derzeit nicht erreichbar.".to_string())?;
    let status = response.status();
    if !status.is_success() {
        let detail = response.json::<Value>().await.ok().and_then(|value| {
            let code = value
                .pointer("/error/code")
                .and_then(Value::as_str)
                .unwrap_or("");
            let message = value
                .pointer("/error/message")
                .and_then(Value::as_str)
                .unwrap_or("");
            let safe = format!("{code}: {message}")
                .chars()
                .filter(|character| !character.is_control())
                .take(240)
                .collect::<String>();
            (!safe.trim_matches([':', ' ']).is_empty()).then_some(safe)
        });
        return Err(format!(
            "Microsoft Graph hat die Änderung abgelehnt (HTTP {}){}.",
            status.as_u16(),
            detail.map(|value| format!(", {value}")).unwrap_or_default()
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
    // A manual sync can overlap the automatic change/poll sync. Building the
    // second plan only after the first write is visible lets the remote-key
    // matching relink the event instead of creating it a second time.
    let runtime = app.state::<Microsoft365Runtime>();
    let _sync_guard = runtime.sync_gate.lock().await;
    let started_at = Utc::now().to_rfc3339();
    let access_token = refreshed_access_token(&app).await?;
    if request.contacts && request.contact_groups {
        ensure_contact_group_folders(&access_token, &request.backup).await?;
    }
    let preview_request = Microsoft365SyncPreviewRequest {
        direction: request.direction,
        base: request.base,
        contacts: request.contacts,
        contact_groups: request.contact_groups,
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
        deleted: 0,
        ignored: 0,
        conflicts: plan.preview.conflicts,
        errors: 0,
        error_messages: Vec::new(),
        calendar_upserts: Vec::new(),
        calendar_deletes: Vec::new(),
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
            ) => {
                match graph_write(
                    &access_token,
                    reqwest::Method::POST,
                    &operation.source.resource_path,
                    &graph_contact_payload(local),
                )
                .await
                {
                    Ok(remote) => {
                        let local_id = local
                            .id
                            .ok_or_else(|| "Lokaler Kontakt hat keine ID.".to_string())?;
                        let remote_id = value_text(&remote, "id");
                        if remote_id.is_empty() {
                            Err("Microsoft 365 hat keine Kontakt-ID zurückgegeben.".to_string())
                        } else {
                            save_contact_link(&app, local_id, &operation.source.id, remote_id)?;
                            result.created += 1;
                            Ok(())
                        }
                    }
                    Err(error) => Err(error),
                }
            }
            (
                PlannedPayload::Contact {
                    local: None,
                    remote: Some(remote),
                },
                "createLocal",
            ) => {
                let input = remote_contact_input_for_source(
                    remote,
                    None,
                    &preview_request.backup,
                    &operation.source,
                );
                crate::save_contact(app.clone(), input).and_then(|local_id| {
                    save_contact_link(
                        &app,
                        local_id,
                        &operation.source.id,
                        value_text(remote, "id"),
                    )?;
                    result.created += 1;
                    Ok(())
                })
            }
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
                    if let Some(local_id) = local.id {
                        let _ = save_contact_link(
                            &app,
                            local_id,
                            &operation.source.id,
                            value_text(remote, "id"),
                        );
                    }
                    result.updated += 1;
                })
            }
            (
                PlannedPayload::Contact {
                    local: Some(local),
                    remote: Some(remote),
                },
                "updateLocal" | "keepM365",
            ) => crate::save_contact(
                app.clone(),
                remote_contact_input_for_source(
                    remote,
                    Some(local),
                    &preview_request.backup,
                    &operation.source,
                ),
            )
            .and_then(|local_id| {
                save_contact_link(
                    &app,
                    local_id,
                    &operation.source.id,
                    value_text(remote, "id"),
                )?;
                result.updated += 1;
                Ok(())
            }),
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
                PlannedPayload::Contact {
                    local: Some(local),
                    remote: Some(remote),
                },
                "deleteRemote",
            ) => {
                let url = format!(
                    "{}/{}",
                    operation.source.resource_path,
                    encode_graph_path_segment(value_text(remote, "id"))
                );
                graph_write(&access_token, reqwest::Method::DELETE, &url, &Value::Null)
                    .await
                    .and_then(|_| {
                        if let Some(local_id) = local.id {
                            delete_contact_link(&app, local_id, &operation.source.id)?;
                        }
                        result.deleted += 1;
                        Ok(())
                    })
            }
            (
                PlannedPayload::Contact {
                    local: Some(local),
                    remote: None,
                },
                "deleteLocal",
            ) => {
                let local_id = local
                    .id
                    .ok_or_else(|| "Lokaler Kontakt hat keine ID.".to_string())?;
                if let Some(group_id) = source_group_id(&preview_request.backup, &operation.source)
                {
                    remove_contact_from_group(&app, local_id, group_id)?;
                } else {
                    crate::delete_contact(app.clone(), local_id)?;
                }
                delete_contact_link(&app, local_id, &operation.source.id)?;
                result.deleted += 1;
                Ok(())
            }
            (
                PlannedPayload::Calendar {
                    local: Some(local),
                    remote: None,
                },
                "createRemote",
            ) => {
                let url = format!("{}/events", operation.source.resource_path);
                match graph_write(
                    &access_token,
                    reqwest::Method::POST,
                    &url,
                    &graph_event_payload(local),
                )
                .await
                {
                    Ok(remote) => {
                        if value_text(&remote, "id").is_empty() {
                            Err("Microsoft 365 hat keine Termin-ID zurückgegeben.".to_string())
                        } else {
                            let linked =
                                remote_event_to_local(&remote, &operation.source, Some(local));
                            if linked.id != local.id {
                                result.calendar_deletes.push(local.id.clone());
                            }
                            result.calendar_upserts.push(linked);
                            result.created += 1;
                            Ok(())
                        }
                    }
                    Err(error) => Err(error),
                }
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
                let linked = remote_event_to_local(remote, &operation.source, Some(local));
                if linked.id != local.id {
                    result.calendar_deletes.push(local.id.clone());
                }
                result.calendar_upserts.push(linked);
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
            (
                PlannedPayload::Calendar {
                    local: Some(_local),
                    remote: Some(remote),
                },
                "deleteRemote",
            ) => {
                let url = format!(
                    "{}/events/{}",
                    operation.source.resource_path,
                    encode_graph_path_segment(value_text(remote, "id"))
                );
                graph_write(&access_token, reqwest::Method::DELETE, &url, &Value::Null)
                    .await
                    .map(|_| {
                        result.calendar_deletes.push(_local.id.clone());
                        result.deleted += 1;
                    })
            }
            (
                PlannedPayload::Calendar {
                    local: Some(local),
                    remote: None,
                },
                "deleteLocal",
            ) => {
                result.calendar_deletes.push(local.id.clone());
                result.deleted += 1;
                Ok(())
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
    let response = http_client()
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
pub async fn get_m365_connection_status(
    app: AppHandle,
) -> Result<Microsoft365ConnectionStatus, String> {
    let account = read_account(&app)?;
    let locally_connected = account.is_some() && get_setting(&app, TOKEN_SETTING_KEY)?.is_some();
    let connected = if locally_connected && client_id().is_some() {
        match refreshed_access_token(&app).await {
            Ok(mut access_token) => {
                access_token.zeroize();
                true
            }
            Err(error) if microsoft_session_requires_reconnect(&error) => false,
            Err(_) => true,
        }
    } else {
        false
    };
    Ok(Microsoft365ConnectionStatus {
        configured: client_id().is_some(),
        connected,
        account,
    })
}

#[tauri::command]
pub async fn start_m365_interactive_connection(
    app: AppHandle,
) -> Result<Microsoft365Account, String> {
    let client_id = client_id().ok_or_else(|| {
        "Die EDV muss zuerst die Microsoft-Anwendungs-ID für diesen Build hinterlegen.".to_string()
    })?;
    let listener = TcpListener::bind("127.0.0.1:0").map_err(|_| {
        "Die sichere Microsoft-Rückmeldung konnte nicht vorbereitet werden.".to_string()
    })?;
    listener.set_nonblocking(true).map_err(|_| {
        "Die sichere Microsoft-Rückmeldung konnte nicht vorbereitet werden.".to_string()
    })?;
    let port = listener
        .local_addr()
        .map_err(|_| {
            "Die sichere Microsoft-Rückmeldung konnte nicht vorbereitet werden.".to_string()
        })?
        .port();
    let redirect_uri = format!("http://localhost:{port}");
    let state_token = secure_url_token(32);
    let mut verifier = secure_url_token(64);
    let challenge = pkce_challenge(&verifier);
    {
        let runtime = app.state::<AppState>();
        *runtime.m365.pending_interactive_state.lock().map_err(|_| {
            "Microsoft-Anmeldung konnte intern nicht vorbereitet werden.".to_string()
        })? = Some(state_token.clone());
    }
    let authorization_url =
        interactive_authorization_url(client_id, &redirect_uri, &state_token, &challenge);
    if let Err(error) = app.opener().open_url(authorization_url, None::<&str>) {
        let _ = clear_interactive_state(&app, &state_token);
        verifier.zeroize();
        return Err(format!(
            "Microsoft-Anmeldung konnte nicht im Browser geöffnet werden: {error}"
        ));
    }
    let callback = wait_for_authorization_callback(&app, &listener, &state_token).await;
    let _ = clear_interactive_state(&app, &state_token);
    let mut callback = callback?;
    let token_result = request_token(&[
        ("grant_type", "authorization_code"),
        ("client_id", client_id),
        ("code", &callback.code),
        ("redirect_uri", &redirect_uri),
        ("code_verifier", &verifier),
        ("scope", LOGIN_SCOPES),
    ])
    .await;
    verifier.zeroize();
    callback.code.zeroize();
    let token = token_result.map_err(|error| oauth_error_message(&error))?;
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
    Ok(account)
}

#[tauri::command]
pub async fn start_m365_connection(
    state: State<'_, AppState>,
) -> Result<Microsoft365DeviceCode, String> {
    let client_id = client_id().ok_or_else(|| {
        "Die EDV muss zuerst die Microsoft-Anwendungs-ID für diesen Build hinterlegen.".to_string()
    })?;
    let response = http_client()
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
    clear_pending_flow(&state)?;
    *state
        .m365
        .pending_interactive_state
        .lock()
        .map_err(|_| "Microsoft-Anmeldung konnte intern nicht beendet werden.".to_string())? = None;
    Ok(())
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
    *state.m365.pending_interactive_state.lock().map_err(|_| {
        "Microsoft-Anmeldung konnte intern nicht zurückgesetzt werden.".to_string()
    })? = None;
    *state.m365.access_token.lock().map_err(|_| {
        "Microsoft-Anmeldung konnte intern nicht zurückgesetzt werden.".to_string()
    })? = None;
    delete_connection_settings(&app)
}

pub(crate) fn clear_runtime(app: &AppHandle) -> Result<(), String> {
    let state = app.state::<AppState>();
    *state.m365.pending_device_flow.lock().map_err(|_| {
        "Microsoft-Anmeldung konnte intern nicht zurückgesetzt werden.".to_string()
    })? = None;
    *state.m365.pending_interactive_state.lock().map_err(|_| {
        "Microsoft-Anmeldung konnte intern nicht zurückgesetzt werden.".to_string()
    })? = None;
    *state.m365.access_token.lock().map_err(|_| {
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

    fn calendar_source(id: &str) -> Microsoft365SyncSource {
        Microsoft365SyncSource {
            id: id.to_string(),
            name: id.to_string(),
            kind: "calendar".to_string(),
            editable: true,
            shared: false,
            resource_path: format!("/me/calendars/{id}/events"),
            mailbox: None,
        }
    }

    fn calendar_sync_request(selected_ids: &[&str]) -> Microsoft365SyncPreviewRequest {
        Microsoft365SyncPreviewRequest {
            direction: "bidirectional".to_string(),
            base: "local".to_string(),
            contacts: false,
            contact_groups: false,
            calendars: true,
            shared_calendars: false,
            shared_mailboxes: false,
            shared_mailbox_addresses: Vec::new(),
            selected_contact_source_ids: Vec::new(),
            selected_calendar_source_ids: selected_ids.iter().map(|id| (*id).to_string()).collect(),
            source_directions: HashMap::new(),
            backup: crate::BackupData {
                version: "test".to_string(),
                exported_at: "2026-09-01T00:00:00Z".to_string(),
                contacts: Vec::new(),
                groups: Vec::new(),
                settings: Vec::new(),
                browser_storage: HashMap::new(),
            },
        }
    }

    fn calendar_event(id: &str) -> crate::CalendarEvent {
        crate::CalendarEvent {
            id: id.to_string(),
            updated_at: "2026-09-01T00:00:00Z".to_string(),
            title: "Besprechung".to_string(),
            starts_at: "2026-09-01T09:00:00".to_string(),
            ends_at: "2026-09-01T10:00:00".to_string(),
            location: String::new(),
            description: String::new(),
            color: "blue".to_string(),
            category: String::new(),
            source: "AgendaKontakte".to_string(),
            recurrence: None,
            excluded_dates: Vec::new(),
            deleted_at: None,
            recurrence_master_id: None,
            recurrence_id: None,
        }
    }

    #[test]
    fn form_values_are_encoded_without_losing_scopes() {
        assert_eq!(
            form_body(&[("scope", LOGIN_SCOPES)]),
            "scope=openid+profile+offline_access+User.Read+Contacts.ReadWrite+Contacts.ReadWrite.Shared+Calendars.ReadWrite+Calendars.ReadWrite.Shared+Calendars.Read.Shared+MailboxSettings.Read+Files.ReadWrite.All+Sites.Read.All"
        );
    }

    #[test]
    fn exports_a_new_local_event_to_only_one_selected_calendar() {
        let sources = vec![calendar_source("calendar-a"), calendar_source("calendar-b")];
        let request = calendar_sync_request(&["calendar-a", "calendar-b"]);
        let selected = request
            .selected_calendar_source_ids
            .iter()
            .map(String::as_str)
            .collect::<HashSet<_>>();
        let target = calendar_export_target_id(&request, &sources, &selected);
        let event = calendar_event("local-event");

        assert_eq!(target, Some("calendar-a"));
        assert!(local_event_belongs_to_calendar_source(
            &event,
            &sources[0],
            &sources,
            target
        ));
        assert!(!local_event_belongs_to_calendar_source(
            &event,
            &sources[1],
            &sources,
            target
        ));
    }

    #[test]
    fn keeps_an_imported_event_bound_to_its_exchange_calendar() {
        let sources = vec![calendar_source("calendar-a"), calendar_source("calendar-b")];
        let request = calendar_sync_request(&["calendar-a", "calendar-b"]);
        let selected = request
            .selected_calendar_source_ids
            .iter()
            .map(String::as_str)
            .collect::<HashSet<_>>();
        let target = calendar_export_target_id(&request, &sources, &selected);
        let event = calendar_event("m365:calendar-b:remote-event");

        assert!(!local_event_belongs_to_calendar_source(
            &event,
            &sources[0],
            &sources,
            target
        ));
        assert!(local_event_belongs_to_calendar_source(
            &event,
            &sources[1],
            &sources,
            target
        ));
    }

    #[test]
    fn skips_import_only_calendars_when_choosing_the_export_target() {
        let sources = vec![calendar_source("calendar-a"), calendar_source("calendar-b")];
        let mut request = calendar_sync_request(&["calendar-a", "calendar-b"]);
        request
            .source_directions
            .insert("calendar-a".to_string(), "import".to_string());
        let selected = request
            .selected_calendar_source_ids
            .iter()
            .map(String::as_str)
            .collect::<HashSet<_>>();

        assert_eq!(
            calendar_export_target_id(&request, &sources, &selected),
            Some("calendar-b")
        );
    }

    #[test]
    fn converts_exchange_html_descriptions_to_readable_text() {
        let source = calendar_source("calendar-a");
        let event = remote_event_to_local(
            &json!({
                "id": "event-html",
                "subject": "Besprechung",
                "start": { "dateTime": "2026-09-01T09:00:00" },
                "end": { "dateTime": "2026-09-01T10:00:00" },
                "body": {
                    "contentType": "html",
                    "content": "<html><head><style>.x{color:red}</style></head><body><p>Hallo&nbsp;Team</p><div>Termin &amp; Planung<br>Raum 2</div></body></html>"
                }
            }),
            &source,
            None,
        );

        assert_eq!(event.description, "Hallo Team\nTermin & Planung\nRaum 2");

        let mut local = calendar_event("local-html");
        local.description = "<p>Lokaler&nbsp;Text</p>".to_string();
        assert_eq!(
            graph_event_payload(&local)["body"]["content"],
            "Lokaler Text"
        );
    }

    #[test]
    fn marks_only_extra_calendar_copies_for_cleanup() {
        let sources = vec![
            calendar_source("calendar-a"),
            calendar_source("calendar-b"),
            calendar_source("calendar-c"),
        ];
        let kept = calendar_event("m365:calendar-a:event-1");
        let duplicate_two = calendar_event("m365:calendar-b:event-2");
        let duplicate_three = calendar_event("m365:calendar-c:event-3");
        let mut single = calendar_event("m365:calendar-b:event-single");
        single.title = "Einmaliger Termin".to_string();

        let duplicate_ids = duplicate_calendar_event_ids(
            &[kept, duplicate_two, duplicate_three, single],
            &sources,
            Some("calendar-a"),
        );

        assert_eq!(duplicate_ids.len(), 2);
        assert!(duplicate_ids.contains("m365:calendar-b:event-2"));
        assert!(duplicate_ids.contains("m365:calendar-c:event-3"));
        assert!(!duplicate_ids.contains("m365:calendar-a:event-1"));
        assert!(!duplicate_ids.contains("m365:calendar-b:event-single"));
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
    fn builds_pkce_authorization_url_for_the_loopback_callback() {
        let url = interactive_authorization_url(
            "11111111-2222-3333-4444-555555555555",
            "http://localhost:45678",
            "expected-state",
            "expected-challenge",
        );
        let parsed = url::Url::parse(&url).expect("authorization URL");
        let query = parsed.query_pairs().into_owned().collect::<HashMap<_, _>>();

        assert_eq!(parsed.path(), "/organizations/oauth2/v2.0/authorize");
        assert_eq!(query.get("response_type").map(String::as_str), Some("code"));
        assert_eq!(
            query.get("redirect_uri").map(String::as_str),
            Some("http://localhost:45678")
        );
        assert_eq!(
            query.get("state").map(String::as_str),
            Some("expected-state")
        );
        assert_eq!(
            query.get("code_challenge_method").map(String::as_str),
            Some("S256")
        );
        assert_eq!(
            query.get("code_challenge").map(String::as_str),
            Some("expected-challenge")
        );
    }

    #[test]
    fn parses_and_decodes_the_interactive_callback() {
        let callback = parse_authorization_callback(
            "/?code=abc%2B123&state=expected-state&session_state=ignored",
        )
        .expect("valid callback");

        assert_eq!(callback.code, "abc+123");
        assert_eq!(callback.state, "expected-state");
        assert!(
            parse_authorization_callback("/?error=access_denied&state=expected-state")
                .unwrap_err()
                .contains("abgebrochen")
        );
    }

    #[test]
    fn creates_a_valid_pkce_s256_challenge() {
        assert_eq!(
            pkce_challenge("dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk"),
            "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM"
        );
    }

    #[test]
    fn distinguishes_expired_sessions_from_temporary_connection_errors() {
        assert!(microsoft_session_requires_reconnect(
            "Die Microsoft-Sitzung ist abgelaufen. Verbinden Sie das Konto erneut."
        ));
        assert!(!microsoft_session_requires_reconnect(
            "Microsoft Graph ist derzeit nicht erreichbar. Internetverbindung prüfen."
        ));
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
                "categories": ["Wichtig"],
                "_dmhCategoryColor": "red"
            }),
            &source,
            None,
        );

        assert_eq!(event.id, "m365:me:calendar:team:event-42");
        assert_eq!(event.title, "Besprechung");
        assert_eq!(event.category, "Wichtig");
        assert_eq!(event.color, "red");
        assert_eq!(event.source, "Microsoft 365 · Teamkalender");
        assert_eq!(
            linked_calendar_remote_id(&event, &source.id),
            Some("event-42")
        );
    }

    #[test]
    fn relinks_legacy_local_calendar_ids_to_the_graph_event() {
        let source = Microsoft365SyncSource {
            id: "me:calendar:team".to_string(),
            name: "Teamkalender".to_string(),
            kind: "calendar".to_string(),
            editable: true,
            shared: false,
            resource_path: "/me/calendars/team/events".to_string(),
            mailbox: None,
        };
        let remote = json!({
            "id": "event-99",
            "lastModifiedDateTime": "2026-08-27T10:00:00Z",
            "subject": "Arzttermin",
            "start": { "dateTime": "2026-08-28T09:00:00" },
            "end": { "dateTime": "2026-08-28T10:00:00" }
        });
        let mut legacy = remote_event_to_local(&remote, &source, None);
        legacy.id = "local-before-link".to_string();

        let linked = remote_event_to_local(&remote, &source, Some(&legacy));

        assert_eq!(linked.id, "m365:me:calendar:team:event-99");
        assert_eq!(linked.updated_at, "2026-08-27T10:00:00Z");
    }

    #[test]
    fn maps_outlook_category_presets_to_the_local_palette() {
        assert_eq!(outlook_category_color("preset0"), "red");
        assert_eq!(outlook_category_color("preset4"), "green");
        assert_eq!(outlook_category_color("preset7"), "blue");
        assert_eq!(outlook_category_color("preset8"), "purple");
        assert_eq!(outlook_category_color("preset12"), "gray");
        assert_eq!(outlook_category_color("preset18"), "yellow");
    }
}
