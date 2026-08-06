use crate::{hidden_command, open_db, AppState};
use base64::{engine::general_purpose::STANDARD as BASE64_STANDARD, Engine as _};
use chrono::{Duration as ChronoDuration, Utc};
use rusqlite::{params, OptionalExtension};
use serde::{Deserialize, Serialize};
use std::collections::HashSet;
use std::sync::Mutex;
use tauri::{AppHandle, Manager, State};
use uuid::Uuid;
use zeroize::Zeroize;

const TOKEN_SETTING_KEY: &str = "m365_token_bundle_v1";
const PROFILE_SETTING_KEY: &str = "m365_connection_profile_v1";
const EDV_TOKEN_SETTING_KEY: &str = "m365_edv_token_bundle_v1";
const DPAPI_ENTROPY: &[u8] = b"de.dmh.agendakontakte.m365.v1";
const GRAPH_PROFILE_URL: &str =
    "https://graph.microsoft.com/v1.0/me?$select=id,displayName,mail,userPrincipalName";
const GRAPH_GROUPS_URL: &str =
    "https://graph.microsoft.com/v1.0/me/transitiveMemberOf/microsoft.graph.group?$select=id";
const LOGIN_SCOPES: &str =
    "openid profile offline_access User.Read Contacts.ReadWrite Calendars.ReadWrite";
const EDV_SCOPES: &str = "openid profile offline_access User.Read User.Read.All User.ReadWrite.All User.EnableDisableAccount.All User-PasswordProfile.ReadWrite.All Group.Read.All Group.ReadWrite.All GroupMember.ReadWrite.All Tasks.ReadWrite";
const PRIVATSCHWESTERN_MODULE: &str = "privatschwestern";
const EDV_MODULE: &str = "edv";

#[derive(Default)]
pub struct Microsoft365Runtime {
    pending_device_flow: Mutex<Option<PendingDeviceFlow>>,
    pending_edv_device_flow: Mutex<Option<PendingDeviceFlow>>,
    session_token: Mutex<Option<StoredTokenBundle>>,
    session_account: Mutex<Option<Microsoft365Account>>,
    edv_session: Mutex<Option<StoredEdvTokenBundle>>,
}

#[derive(Debug, Clone)]
struct PendingDeviceFlow {
    device_code: String,
    expires_at: String,
    interval_seconds: u64,
    remember_sign_in: bool,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct Microsoft365Account {
    id: String,
    display_name: String,
    email: String,
    user_principal_name: String,
    connected_at: String,
    #[serde(default)]
    tenant_id: String,
    #[serde(default)]
    group_ids: Vec<String>,
    #[serde(default)]
    last_validated_at: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Microsoft365ConnectionStatus {
    configured: bool,
    connected: bool,
    account: Option<Microsoft365Account>,
    remember_sign_in: bool,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PortalSession {
    configured: bool,
    state: String,
    account: Option<Microsoft365Account>,
    remember_sign_in: bool,
    authorization_configured: bool,
    modules: Vec<String>,
    message: String,
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

#[derive(Debug, Deserialize)]
struct GraphGroup {
    id: String,
}

#[derive(Debug, Deserialize)]
struct GraphGroupPage {
    value: Vec<GraphGroup>,
    #[serde(rename = "@odata.nextLink")]
    next_link: Option<String>,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
struct StoredTokenBundle {
    refresh_token: String,
    scope: String,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
struct StoredEdvTokenBundle {
    refresh_token: String,
    scope: String,
    account_id: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct EdvAdminSessionStatus {
    configured: bool,
    connected: bool,
    account_matches: bool,
    scopes: Vec<String>,
}

fn default_poll_interval() -> u64 {
    5
}

fn client_id() -> Option<&'static str> {
    option_env!("M365_CLIENT_ID")
        .map(str::trim)
        .filter(|value| is_identifier(value))
}

fn edv_client_id() -> Option<&'static str> {
    option_env!("M365_EDV_CLIENT_ID")
        .map(str::trim)
        .filter(|value| is_identifier(value))
        .or_else(client_id)
}

fn tenant_id() -> &'static str {
    option_env!("M365_TENANT_ID")
        .map(str::trim)
        .filter(|value| is_tenant(value))
        .unwrap_or("organizations")
}

fn configured_group_ids(value: Option<&'static str>) -> Vec<String> {
    value
        .unwrap_or("")
        .split(',')
        .map(str::trim)
        .filter_map(|value| Uuid::parse_str(value).ok())
        .map(|value| value.hyphenated().to_string())
        .collect()
}

fn privatschwestern_group_ids() -> Vec<String> {
    configured_group_ids(option_env!("DMH_PORTAL_PRIVATSCHWESTERN_GROUP_IDS"))
}

fn edv_group_ids() -> Vec<String> {
    configured_group_ids(option_env!("DMH_PORTAL_EDV_GROUP_IDS"))
}

fn modules_for_groups(
    memberships: &[String],
    privatschwestern_groups: &[String],
    edv_groups: &[String],
) -> Vec<String> {
    let memberships = memberships
        .iter()
        .map(|value| value.to_ascii_lowercase())
        .collect::<HashSet<_>>();
    let mut modules = Vec::new();
    if privatschwestern_groups
        .iter()
        .any(|group| memberships.contains(&group.to_ascii_lowercase()))
    {
        modules.push(PRIVATSCHWESTERN_MODULE.to_string());
    }
    if edv_groups
        .iter()
        .any(|group| memberships.contains(&group.to_ascii_lowercase()))
    {
        modules.push(EDV_MODULE.to_string());
    }
    modules
}

fn authorization_configured() -> bool {
    !privatschwestern_group_ids().is_empty() || !edv_group_ids().is_empty()
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
        "DELETE FROM app_settings WHERE key IN (?1, ?2, ?3)",
        params![
            TOKEN_SETTING_KEY,
            PROFILE_SETTING_KEY,
            EDV_TOKEN_SETTING_KEY
        ],
    )
    .map_err(|error| error.to_string())?;
    Ok(())
}

fn read_persisted_account(app: &AppHandle) -> Result<Option<Microsoft365Account>, String> {
    get_setting(app, PROFILE_SETTING_KEY)?
        .map(|value| {
            serde_json::from_str(&value)
                .map_err(|_| "Das gespeicherte Microsoft-365-Kontoprofil ist ungültig.".to_string())
        })
        .transpose()
}

fn save_connection(
    app: &AppHandle,
    state: &AppState,
    account: &Microsoft365Account,
    token: &StoredTokenBundle,
    remember_sign_in: bool,
) -> Result<(), String> {
    if remember_sign_in {
        let mut token_json = serde_json::to_vec(token).map_err(|_| {
            "Microsoft-Anmeldung konnte nicht sicher gespeichert werden.".to_string()
        })?;
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
    } else {
        delete_connection_settings(app)?;
    }
    *state
        .m365
        .session_token
        .lock()
        .map_err(|_| "Microsoft-Sitzung konnte intern nicht gespeichert werden.".to_string())? =
        Some(token.clone());
    *state
        .m365
        .session_account
        .lock()
        .map_err(|_| "Microsoft-Konto konnte intern nicht gespeichert werden.".to_string())? =
        Some(account.clone());
    Ok(())
}

fn read_persisted_token(app: &AppHandle) -> Result<Option<StoredTokenBundle>, String> {
    let Some(encoded) = get_setting(app, TOKEN_SETTING_KEY)? else {
        return Ok(None);
    };
    let protected = BASE64_STANDARD
        .decode(encoded)
        .map_err(|_| "Die gespeicherte Microsoft-Anmeldung ist ungültig.".to_string())?;
    let mut token_json = unprotect_secret(&protected)?;
    let token = serde_json::from_slice(&token_json).map_err(|_| {
        "Die gespeicherte Microsoft-Anmeldung konnte nicht gelesen werden.".to_string()
    })?;
    token_json.zeroize();
    Ok(Some(token))
}

fn read_persisted_edv_token(app: &AppHandle) -> Result<Option<StoredEdvTokenBundle>, String> {
    let Some(encoded) = get_setting(app, EDV_TOKEN_SETTING_KEY)? else {
        return Ok(None);
    };
    let protected = BASE64_STANDARD
        .decode(encoded)
        .map_err(|_| "Die gespeicherte EDV-Anmeldung ist ungültig.".to_string())?;
    let mut token_json = unprotect_secret(&protected)?;
    let token = serde_json::from_slice(&token_json)
        .map_err(|_| "Die gespeicherte EDV-Anmeldung konnte nicht gelesen werden.".to_string())?;
    token_json.zeroize();
    Ok(Some(token))
}

fn read_edv_token(app: &AppHandle, state: &AppState) -> Result<StoredEdvTokenBundle, String> {
    if let Some(token) = state
        .m365
        .edv_session
        .lock()
        .map_err(|_| "EDV-Sitzung konnte intern nicht gelesen werden.".to_string())?
        .clone()
    {
        return Ok(token);
    }
    read_persisted_edv_token(app)?
        .ok_or_else(|| "Die administrative EDV-Sitzung ist nicht verbunden.".to_string())
}

fn save_edv_token(
    app: &AppHandle,
    state: &AppState,
    token: &StoredEdvTokenBundle,
) -> Result<(), String> {
    let mut token_json = serde_json::to_vec(token)
        .map_err(|_| "EDV-Anmeldung konnte nicht sicher gespeichert werden.".to_string())?;
    let protected = protect_secret(&token_json)?;
    token_json.zeroize();
    set_setting(
        app,
        EDV_TOKEN_SETTING_KEY,
        &BASE64_STANDARD.encode(protected),
    )?;
    *state
        .m365
        .edv_session
        .lock()
        .map_err(|_| "EDV-Sitzung konnte intern nicht gespeichert werden.".to_string())? =
        Some(token.clone());
    Ok(())
}

fn clear_edv_session(app: &AppHandle, state: &AppState) -> Result<(), String> {
    *state
        .m365
        .edv_session
        .lock()
        .map_err(|_| "EDV-Sitzung konnte intern nicht beendet werden.".to_string())? = None;
    let conn = open_db(app)?;
    conn.execute(
        "DELETE FROM app_settings WHERE key = ?1",
        [EDV_TOKEN_SETTING_KEY],
    )
    .map_err(|error| error.to_string())?;
    Ok(())
}

fn read_account(app: &AppHandle, state: &AppState) -> Result<Option<Microsoft365Account>, String> {
    if let Some(account) = state
        .m365
        .session_account
        .lock()
        .map_err(|_| "Microsoft-Konto konnte intern nicht gelesen werden.".to_string())?
        .clone()
    {
        return Ok(Some(account));
    }
    read_persisted_account(app)
}

fn read_token(app: &AppHandle, state: &AppState) -> Result<StoredTokenBundle, String> {
    if let Some(token) = state
        .m365
        .session_token
        .lock()
        .map_err(|_| "Microsoft-Sitzung konnte intern nicht gelesen werden.".to_string())?
        .clone()
    {
        return Ok(token);
    }
    read_persisted_token(app)?.ok_or_else(|| "Microsoft-365-Konto ist nicht verbunden.".to_string())
}

fn clear_session(app: &AppHandle, state: &AppState) -> Result<(), String> {
    *state
        .m365
        .session_token
        .lock()
        .map_err(|_| "Microsoft-Sitzung konnte intern nicht beendet werden.".to_string())? = None;
    *state
        .m365
        .session_account
        .lock()
        .map_err(|_| "Microsoft-Konto konnte intern nicht beendet werden.".to_string())? = None;
    delete_connection_settings(app)
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

async fn graph_group_ids(access_token: &str) -> Result<Vec<String>, String> {
    let client = reqwest::Client::new();
    let mut next_url = Some(GRAPH_GROUPS_URL.to_string());
    let mut group_ids = Vec::new();
    while let Some(url) = next_url.take() {
        if !url.starts_with("https://graph.microsoft.com/") {
            return Err("Microsoft Graph hat eine ungültige Folgeseite geliefert.".to_string());
        }
        let response = client
            .get(&url)
            .bearer_auth(access_token)
            .send()
            .await
            .map_err(|_| {
                "Microsoft Graph ist derzeit nicht erreichbar. Internetverbindung prüfen."
                    .to_string()
            })?;
        if !response.status().is_success() {
            return Err(format!(
                "Microsoft Graph konnte die Portal-Gruppen nicht prüfen (HTTP {}).",
                response.status().as_u16()
            ));
        }
        let page = response
            .json::<GraphGroupPage>()
            .await
            .map_err(|_| "Microsoft Graph hat ungültige Portal-Gruppen geliefert.".to_string())?;
        group_ids.extend(page.value.into_iter().map(|group| group.id));
        next_url = page.next_link;
    }
    group_ids.sort();
    group_ids.dedup();
    Ok(group_ids)
}

fn account_from_profile(profile: GraphProfile, group_ids: Vec<String>) -> Microsoft365Account {
    let timestamp = Utc::now().to_rfc3339();
    Microsoft365Account {
        id: profile.id,
        display_name: profile.display_name,
        email: profile.mail,
        user_principal_name: profile.user_principal_name,
        connected_at: timestamp.clone(),
        tenant_id: tenant_id().to_string(),
        group_ids,
        last_validated_at: timestamp,
    }
}

fn portal_session_for_account(
    account: Microsoft365Account,
    remember_sign_in: bool,
    online: bool,
    mut message: String,
) -> PortalSession {
    let private_groups = privatschwestern_group_ids();
    let edv_groups = edv_group_ids();
    let authorization_configured = !private_groups.is_empty() || !edv_groups.is_empty();
    let mut modules = modules_for_groups(&account.group_ids, &private_groups, &edv_groups);
    let offline_access_current = account
        .last_validated_at
        .parse::<chrono::DateTime<Utc>>()
        .is_ok_and(|validated_at| validated_at >= Utc::now() - ChronoDuration::hours(24));
    let state = if !authorization_configured {
        "configuration_required"
    } else if modules.is_empty() {
        "access_denied"
    } else if online {
        "authenticated"
    } else if !offline_access_current {
        modules.clear();
        if message.is_empty() {
            message = "Die Offline-Berechtigung ist abgelaufen. Bitte stellen Sie eine Internetverbindung her und melden Sie sich erneut an.".to_string();
        }
        "signed_out"
    } else {
        "offline"
    };
    PortalSession {
        configured: client_id().is_some(),
        state: state.to_string(),
        account: Some(account),
        remember_sign_in,
        authorization_configured,
        modules,
        message,
    }
}

fn signed_out_portal_session(message: String) -> PortalSession {
    let configured = client_id().is_some();
    let authorization_configured = authorization_configured();
    PortalSession {
        configured,
        state: if configured && authorization_configured {
            "signed_out".to_string()
        } else {
            "configuration_required".to_string()
        },
        account: None,
        remember_sign_in: false,
        authorization_configured,
        modules: Vec::new(),
        message,
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

pub(crate) async fn acquire_graph_access_token(
    app: &AppHandle,
    state: &AppState,
) -> Result<String, String> {
    let client_id = client_id().ok_or_else(|| {
        "Die Microsoft-Anwendungs-ID ist in diesem Build nicht hinterlegt.".to_string()
    })?;
    let account = read_account(app, state)?
        .ok_or_else(|| "Microsoft-365-Konto ist nicht verbunden.".to_string())?;
    if !modules_for_groups(
        &account.group_ids,
        &privatschwestern_group_ids(),
        &edv_group_ids(),
    )
    .iter()
    .any(|module| module == PRIVATSCHWESTERN_MODULE)
    {
        return Err(
            "Dieses Microsoft-Konto hat keinen Zugriff auf das Modul Privatschwestern.".to_string(),
        );
    }
    let stored = read_token(app, state)?;
    let token = request_token(&[
        ("grant_type", "refresh_token"),
        ("client_id", client_id),
        ("refresh_token", &stored.refresh_token),
        ("scope", LOGIN_SCOPES),
    ])
    .await
    .map_err(|error| oauth_error_message(&error))?;
    let bundle = StoredTokenBundle {
        refresh_token: token.refresh_token.unwrap_or(stored.refresh_token),
        scope: token.scope,
    };
    let remember_sign_in = get_setting(app, TOKEN_SETTING_KEY)?.is_some();
    save_connection(app, state, &account, &bundle, remember_sign_in)?;
    Ok(token.access_token)
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
pub fn get_m365_connection_status(
    app: AppHandle,
    state: State<'_, AppState>,
) -> Result<Microsoft365ConnectionStatus, String> {
    let account = read_account(&app, &state)?;
    let connected = account.is_some() && read_token(&app, &state).is_ok();
    Ok(Microsoft365ConnectionStatus {
        configured: client_id().is_some(),
        connected,
        account,
        remember_sign_in: get_setting(&app, TOKEN_SETTING_KEY)?.is_some(),
    })
}

#[tauri::command]
pub fn get_portal_session(
    app: AppHandle,
    state: State<'_, AppState>,
) -> Result<PortalSession, String> {
    let Some(account) = read_account(&app, &state)? else {
        return Ok(signed_out_portal_session(String::new()));
    };
    if read_token(&app, &state).is_err() {
        return Ok(signed_out_portal_session(String::new()));
    }
    let remember_sign_in = get_setting(&app, TOKEN_SETTING_KEY)?.is_some();
    Ok(portal_session_for_account(
        account,
        remember_sign_in,
        false,
        "Gespeicherte Microsoft-Sitzung wird geprüft.".to_string(),
    ))
}

#[tauri::command]
pub async fn start_m365_connection(
    state: State<'_, AppState>,
    remember_sign_in: Option<bool>,
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
            remember_sign_in: remember_sign_in.unwrap_or(true),
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
    let group_result = if profile_result.is_ok() {
        graph_group_ids(&access_token).await
    } else {
        Ok(Vec::new())
    };
    access_token.zeroize();
    let account = account_from_profile(profile_result?, group_result?);
    save_connection(
        &app,
        &state,
        &account,
        &StoredTokenBundle {
            refresh_token,
            scope: token.scope,
        },
        flow.remember_sign_in,
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
pub async fn restore_portal_session(
    app: AppHandle,
    state: State<'_, AppState>,
) -> Result<PortalSession, String> {
    let client_id = client_id().ok_or_else(|| {
        "Die Microsoft-Anwendungs-ID ist in diesem Build nicht hinterlegt.".to_string()
    })?;
    let Some(cached_account) = read_account(&app, &state)? else {
        return Ok(signed_out_portal_session(String::new()));
    };
    let stored = match read_token(&app, &state) {
        Ok(token) => token,
        Err(_) => return Ok(signed_out_portal_session(String::new())),
    };
    let remember_sign_in = get_setting(&app, TOKEN_SETTING_KEY)?.is_some();
    let token = match request_token(&[
        ("grant_type", "refresh_token"),
        ("client_id", client_id),
        ("refresh_token", &stored.refresh_token),
        ("scope", LOGIN_SCOPES),
    ])
    .await
    {
        Ok(token) => token,
        Err(error) if error.error == "network_error" => {
            return Ok(portal_session_for_account(
                cached_account,
                remember_sign_in,
                false,
                "Keine Verbindung zu Microsoft 365. Der zuletzt bestätigte Offline-Zugriff wird verwendet."
                    .to_string(),
            ));
        }
        Err(error) => {
            clear_session(&app, &state)?;
            return Ok(signed_out_portal_session(oauth_error_message(&error)));
        }
    };
    let OAuthTokenResponse {
        mut access_token,
        refresh_token,
        scope,
    } = token;
    let refreshed_bundle = StoredTokenBundle {
        refresh_token: refresh_token.unwrap_or(stored.refresh_token),
        scope,
    };
    let profile_result = graph_profile(&access_token).await;
    let group_result = if profile_result.is_ok() {
        graph_group_ids(&access_token).await
    } else {
        Ok(Vec::new())
    };
    access_token.zeroize();
    let account = match (profile_result, group_result) {
        (Ok(profile), Ok(groups)) => account_from_profile(profile, groups),
        _ => {
            save_connection(
                &app,
                &state,
                &cached_account,
                &refreshed_bundle,
                remember_sign_in,
            )?;
            return Ok(portal_session_for_account(
                cached_account,
                remember_sign_in,
                false,
                "Microsoft Graph ist derzeit nicht erreichbar. Der zuletzt bestätigte Offline-Zugriff wird verwendet."
                    .to_string(),
            ));
        }
    };
    save_connection(&app, &state, &account, &refreshed_bundle, remember_sign_in)?;
    Ok(portal_session_for_account(
        account,
        remember_sign_in,
        true,
        String::new(),
    ))
}

#[tauri::command]
pub async fn test_m365_connection(
    app: AppHandle,
    state: State<'_, AppState>,
) -> Result<Microsoft365ConnectionStatus, String> {
    let session = restore_portal_session(app, state).await?;
    Ok(Microsoft365ConnectionStatus {
        configured: session.configured,
        connected: matches!(session.state.as_str(), "authenticated" | "offline"),
        account: session.account,
        remember_sign_in: session.remember_sign_in,
    })
}

#[tauri::command]
pub fn disconnect_m365_account(app: AppHandle, state: State<'_, AppState>) -> Result<(), String> {
    clear_pending_flow(&state)?;
    if let Ok(mut pending) = state.m365.pending_edv_device_flow.lock() {
        *pending = None;
    }
    if let Ok(mut token) = state.m365.edv_session.lock() {
        *token = None;
    }
    clear_session(&app, &state)
}

#[tauri::command]
pub fn get_edv_admin_session_status(
    app: AppHandle,
    state: State<'_, AppState>,
) -> Result<EdvAdminSessionStatus, String> {
    let primary = read_account(&app, &state)?;
    let token = read_edv_token(&app, &state).ok();
    let account_matches = token
        .as_ref()
        .zip(primary.as_ref())
        .is_some_and(|(token, account)| token.account_id == account.id);
    Ok(EdvAdminSessionStatus {
        configured: edv_client_id().is_some(),
        connected: token.is_some() && account_matches,
        account_matches,
        scopes: token
            .map(|value| value.scope.split_whitespace().map(str::to_string).collect())
            .unwrap_or_default(),
    })
}

#[tauri::command]
pub async fn start_edv_admin_connection(
    state: State<'_, AppState>,
) -> Result<Microsoft365DeviceCode, String> {
    let client_id = edv_client_id()
        .ok_or_else(|| "Die Microsoft-Anwendungs-ID für die EDV-Verwaltung fehlt.".to_string())?;
    let response = reqwest::Client::new()
        .post(oauth_url("devicecode"))
        .header("content-type", "application/x-www-form-urlencoded")
        .body(form_body(&[
            ("client_id", client_id),
            ("scope", EDV_SCOPES),
        ]))
        .send()
        .await
        .map_err(|_| "Microsoft-Anmeldedienst ist nicht erreichbar.".to_string())?;
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
        .map_err(|_| "Microsoft hat eine ungültige EDV-Anmeldeantwort geliefert.".to_string())?;
    let expires_at = (Utc::now() + ChronoDuration::seconds(device.expires_in)).to_rfc3339();
    *state
        .m365
        .pending_edv_device_flow
        .lock()
        .map_err(|_| "EDV-Anmeldung konnte intern nicht vorbereitet werden.".to_string())? =
        Some(PendingDeviceFlow {
            device_code: device.device_code,
            expires_at: expires_at.clone(),
            interval_seconds: device.interval.max(3),
            remember_sign_in: true,
        });
    Ok(Microsoft365DeviceCode {
        user_code: device.user_code,
        verification_uri: device.verification_uri,
        expires_at,
        interval_seconds: device.interval.max(3),
    })
}

#[tauri::command]
pub async fn poll_edv_admin_connection(
    app: AppHandle,
    state: State<'_, AppState>,
) -> Result<Microsoft365PollResult, String> {
    let client_id = edv_client_id()
        .ok_or_else(|| "Die Microsoft-Anwendungs-ID für die EDV-Verwaltung fehlt.".to_string())?;
    let flow = state
        .m365
        .pending_edv_device_flow
        .lock()
        .map_err(|_| "EDV-Anmeldung konnte intern nicht gelesen werden.".to_string())?
        .clone()
        .ok_or_else(|| "Es läuft keine administrative EDV-Anmeldung.".to_string())?;
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
            return Ok(Microsoft365PollResult {
                state: "pending".to_string(),
                account: None,
                interval_seconds: flow.interval_seconds + 5,
            })
        }
        Err(error) => return Err(oauth_error_message(&error)),
    };
    let profile = graph_profile(&token.access_token).await?;
    let primary = read_account(&app, &state)?
        .ok_or_else(|| "Das normale Microsoft-Konto ist nicht mehr verbunden.".to_string())?;
    if profile.id != primary.id {
        return Err(
            "Für die EDV-Verwaltung muss dasselbe Microsoft-Konto verwendet werden.".to_string(),
        );
    }
    if !modules_for_groups(
        &primary.group_ids,
        &privatschwestern_group_ids(),
        &edv_group_ids(),
    )
    .iter()
    .any(|module| module == EDV_MODULE)
    {
        return Err("Dieses Konto ist nicht für das EDV-Modul freigegeben.".to_string());
    }
    save_edv_token(
        &app,
        &state,
        &StoredEdvTokenBundle {
            refresh_token: token.refresh_token.ok_or_else(|| {
                "Microsoft hat keine erneuerbare EDV-Anmeldung geliefert.".to_string()
            })?,
            scope: token.scope,
            account_id: profile.id,
        },
    )?;
    *state
        .m365
        .pending_edv_device_flow
        .lock()
        .map_err(|_| "EDV-Anmeldung konnte intern nicht beendet werden.".to_string())? = None;
    Ok(Microsoft365PollResult {
        state: "connected".to_string(),
        account: Some(primary),
        interval_seconds: flow.interval_seconds,
    })
}

#[tauri::command]
pub fn disconnect_edv_admin_session(
    app: AppHandle,
    state: State<'_, AppState>,
) -> Result<(), String> {
    clear_edv_session(&app, &state)
}

pub(crate) async fn acquire_edv_graph_access_token(
    app: &AppHandle,
    state: &AppState,
) -> Result<String, String> {
    let client_id = edv_client_id()
        .ok_or_else(|| "Die Microsoft-Anwendungs-ID für die EDV-Verwaltung fehlt.".to_string())?;
    let primary = read_account(app, state)?
        .ok_or_else(|| "Microsoft-365-Konto ist nicht verbunden.".to_string())?;
    if !modules_for_groups(
        &primary.group_ids,
        &privatschwestern_group_ids(),
        &edv_group_ids(),
    )
    .iter()
    .any(|module| module == EDV_MODULE)
    {
        return Err("Dieses Konto ist nicht für das EDV-Modul freigegeben.".to_string());
    }
    let stored = read_edv_token(app, state)?;
    if stored.account_id != primary.id {
        return Err("Die EDV-Sitzung gehört zu einem anderen Microsoft-Konto.".to_string());
    }
    let token = request_token(&[
        ("grant_type", "refresh_token"),
        ("client_id", client_id),
        ("refresh_token", &stored.refresh_token),
        ("scope", EDV_SCOPES),
    ])
    .await
    .map_err(|error| oauth_error_message(&error))?;
    save_edv_token(
        app,
        state,
        &StoredEdvTokenBundle {
            refresh_token: token.refresh_token.unwrap_or(stored.refresh_token),
            scope: token.scope,
            account_id: stored.account_id,
        },
    )?;
    Ok(token.access_token)
}

pub(crate) fn edv_actor(
    app: &AppHandle,
    state: &AppState,
) -> Result<(String, String, String), String> {
    let account = read_account(app, state)?
        .ok_or_else(|| "Microsoft-365-Konto ist nicht verbunden.".to_string())?;
    Ok((
        account.id,
        account.display_name,
        account.user_principal_name,
    ))
}

pub(crate) fn edv_access_level(app: &AppHandle, state: &AppState) -> Result<&'static str, String> {
    let account = read_account(app, state)?
        .ok_or_else(|| "Microsoft-365-Konto ist nicht verbunden.".to_string())?;
    let memberships = account
        .group_ids
        .iter()
        .map(|value| value.to_ascii_lowercase())
        .collect::<HashSet<_>>();
    if edv_group_ids()
        .iter()
        .any(|group| memberships.contains(&group.to_ascii_lowercase()))
    {
        return Ok("identity_admin");
    }
    Err("Dieses Konto ist nicht für das EDV-Modul freigegeben.".to_string())
}

pub(crate) fn clear_runtime(app: &AppHandle) -> Result<(), String> {
    let state = app.state::<AppState>();
    *state.m365.pending_device_flow.lock().map_err(|_| {
        "Microsoft-Anmeldung konnte intern nicht zurückgesetzt werden.".to_string()
    })? = None;
    *state
        .m365
        .session_token
        .lock()
        .map_err(|_| "Microsoft-Sitzung konnte intern nicht zurückgesetzt werden.".to_string())? =
        None;
    *state
        .m365
        .session_account
        .lock()
        .map_err(|_| "Microsoft-Konto konnte intern nicht zurückgesetzt werden.".to_string())? =
        None;
    *state
        .m365
        .pending_edv_device_flow
        .lock()
        .map_err(|_| "EDV-Anmeldung konnte intern nicht zurückgesetzt werden.".to_string())? = None;
    *state
        .m365
        .edv_session
        .lock()
        .map_err(|_| "EDV-Sitzung konnte intern nicht zurückgesetzt werden.".to_string())? = None;
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
            "scope=openid+profile+offline_access+User.Read+Contacts.ReadWrite+Calendars.ReadWrite"
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

    #[test]
    fn portal_modules_follow_security_group_memberships() {
        let memberships = vec![
            "11111111-1111-1111-1111-111111111111".to_string(),
            "AAAAAAAA-AAAA-AAAA-AAAA-AAAAAAAAAAAA".to_string(),
        ];
        let private_groups = vec!["aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa".to_string()];
        let edv_groups = vec!["bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb".to_string()];

        assert_eq!(
            modules_for_groups(&memberships, &private_groups, &edv_groups),
            vec![PRIVATSCHWESTERN_MODULE.to_string()]
        );
    }

    #[test]
    fn portal_modules_are_closed_without_a_matching_group() {
        assert!(modules_for_groups(
            &["11111111-1111-1111-1111-111111111111".to_string()],
            &["22222222-2222-2222-2222-222222222222".to_string()],
            &[]
        )
        .is_empty());
    }

    #[test]
    fn configured_groups_accept_only_valid_object_ids() {
        assert_eq!(
            configured_group_ids(Some("AAAAAAAA-AAAA-AAAA-AAAA-AAAAAAAAAAAA,not-a-group-id")),
            vec!["aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa".to_string()]
        );
    }
}
