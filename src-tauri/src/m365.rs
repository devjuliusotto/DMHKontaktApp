use crate::{hidden_command, open_db, AppState};
use base64::{
    engine::general_purpose::{STANDARD as BASE64_STANDARD, URL_SAFE_NO_PAD},
    Engine as _,
};
use chrono::{Duration as ChronoDuration, Utc};
use rand::{rngs::OsRng, RngCore};
use rusqlite::{params, OptionalExtension};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::collections::HashSet;
use std::sync::Mutex;
use tauri::{AppHandle, Manager, State};
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::TcpListener;
use tokio::time::{timeout, Duration};
use url::Url;
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
const BROWSER_SIGN_IN_TIMEOUT_SECONDS: u64 = 300;

#[derive(Default)]
pub struct Microsoft365Runtime {
    session_token: Mutex<Option<StoredTokenBundle>>,
    session_account: Mutex<Option<Microsoft365Account>>,
    edv_session: Mutex<Option<StoredEdvTokenBundle>>,
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
pub struct Microsoft365PollResult {
    state: String,
    account: Option<Microsoft365Account>,
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

fn client_id() -> Option<&'static str> {
    option_env!("M365_CLIENT_ID")
        .map(str::trim)
        .filter(|value| is_identifier(value) && !value.eq_ignore_ascii_case(tenant_id()))
}

fn edv_client_id() -> Option<&'static str> {
    match option_env!("M365_EDV_CLIENT_ID").map(str::trim) {
        Some(value) if !value.is_empty() => {
            (is_identifier(value) && !value.eq_ignore_ascii_case(tenant_id())).then_some(value)
        }
        _ => client_id(),
    }
}

fn tenant_id() -> &'static str {
    option_env!("M365_TENANT_ID")
        .map(str::trim)
        .filter(|value| is_tenant(value))
        .unwrap_or("organizations")
}

fn configured_client_id() -> Result<&'static str, String> {
    let raw = option_env!("M365_CLIENT_ID").map(str::trim).unwrap_or("");
    if raw.eq_ignore_ascii_case(tenant_id()) && !raw.is_empty() {
        return Err(
            "Die Microsoft-Anwendungs-ID darf nicht mit der Mandanten-ID identisch sein. Die EDV muss die Anwendungs-ID (Client) im Build korrigieren."
                .to_string(),
        );
    }
    client_id().ok_or_else(|| {
        "Die EDV muss zuerst die Microsoft-Anwendungs-ID für diesen Build hinterlegen.".to_string()
    })
}

fn configured_edv_client_id() -> Result<&'static str, String> {
    let raw = option_env!("M365_EDV_CLIENT_ID")
        .map(str::trim)
        .filter(|value| !value.is_empty());
    if raw.is_some_and(|value| value.eq_ignore_ascii_case(tenant_id())) {
        return Err(
            "Die EDV-Anwendungs-ID darf nicht mit der Mandanten-ID identisch sein. Verwenden Sie die Anwendungs-ID (Client) aus der Entra-App-Registrierung."
                .to_string(),
        );
    }
    edv_client_id().ok_or_else(|| {
        "Die Microsoft-Anwendungs-ID für die EDV-Verwaltung fehlt oder ist ungültig.".to_string()
    })
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
        "authorization_declined" | "access_denied" => {
            "Die Microsoft-Anmeldung wurde abgebrochen oder abgelehnt.".to_string()
        }
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

fn focus_portal_window(app: &AppHandle) {
    if let Some(window) = app.get_webview_window("main") {
        let _ = window.unminimize();
        let _ = window.show();
        let _ = window.set_focus();
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

fn random_urlsafe_secret(byte_count: usize) -> String {
    let mut bytes = vec![0_u8; byte_count];
    OsRng.fill_bytes(&mut bytes);
    let value = URL_SAFE_NO_PAD.encode(&bytes);
    bytes.zeroize();
    value
}

async fn send_browser_response(
    stream: &mut tokio::net::TcpStream,
    success: bool,
) -> Result<(), String> {
    let (title, message, accent) = if success {
        (
            "Anmeldung abgeschlossen",
            "Sie sind angemeldet. Dieses Fenster kann geschlossen werden. Kehren Sie jetzt zum DMH Portal zurück.",
            "#007a5a",
        )
    } else {
        (
            "Anmeldung nicht abgeschlossen",
            "Die Anmeldung wurde nicht übernommen. Kehren Sie zum DMH Portal zurück und versuchen Sie es erneut.",
            "#b42318",
        )
    };
    let body = format!(
        "<!doctype html><html lang=\"de\"><head><meta charset=\"utf-8\"><meta name=\"viewport\" content=\"width=device-width,initial-scale=1\"><title>{title}</title><style>body{{margin:0;background:#f5f7fa;color:#10243e;font-family:Segoe UI,Arial,sans-serif;display:grid;min-height:100vh;place-items:center}}main{{background:#fff;border:1px solid #d8dee8;border-radius:18px;box-shadow:0 18px 50px #10243e1f;max-width:620px;margin:24px;padding:42px;text-align:center}}i{{align-items:center;background:{accent}18;border-radius:999px;color:{accent};display:inline-flex;font-size:32px;font-style:normal;height:72px;justify-content:center;width:72px}}h1{{font-size:32px;margin:24px 0 14px}}p{{font-size:21px;line-height:1.55;margin:0}}</style></head><body><main><i>{}</i><h1>{title}</h1><p>{message}</p></main></body></html>",
        if success { "✓" } else { "!" }
    );
    let response = format!(
        "HTTP/1.1 200 OK\r\nContent-Type: text/html; charset=utf-8\r\nContent-Length: {}\r\nCache-Control: no-store\r\nConnection: close\r\n\r\n{}",
        body.len(),
        body
    );
    stream
        .write_all(response.as_bytes())
        .await
        .map_err(|_| "Die Browser-Rückmeldung konnte nicht angezeigt werden.".to_string())?;
    let _ = stream.shutdown().await;
    Ok(())
}

fn parse_browser_callback(target: &str, expected_state: &str) -> Result<String, String> {
    let callback = Url::parse("http://localhost")
        .and_then(|base| base.join(target))
        .map_err(|_| "Die Browser-Rückmeldung enthielt keine gültige Adresse.".to_string())?;
    if callback.scheme() != "http"
        || callback.host_str() != Some("localhost")
        || callback.path() != "/"
    {
        return Err("Die Browser-Rückmeldung kam nicht vom erwarteten Rückkanal.".to_string());
    }
    let values = callback
        .query_pairs()
        .collect::<std::collections::HashMap<_, _>>();
    let returned_state = values
        .get("state")
        .map(|value| value.as_ref())
        .unwrap_or("");
    if returned_state != expected_state {
        return Err(
            "Die Microsoft-Anmeldung konnte aus Sicherheitsgründen nicht übernommen werden."
                .to_string(),
        );
    }
    if let Some(error) = values.get("error") {
        return Err(oauth_error_message(&OAuthErrorResponse {
            error: error.to_string(),
            error_description: values
                .get("error_description")
                .map(ToString::to_string)
                .unwrap_or_default(),
        }));
    }
    values
        .get("code")
        .map(ToString::to_string)
        .filter(|value| !value.is_empty())
        .ok_or_else(|| "Microsoft hat keinen Anmeldecode zurückgegeben.".to_string())
}

async fn receive_browser_authorization_code(
    listener: TcpListener,
    expected_state: &str,
) -> Result<(String, tokio::net::TcpStream), String> {
    let (mut stream, _) = timeout(
        Duration::from_secs(BROWSER_SIGN_IN_TIMEOUT_SECONDS),
        listener.accept(),
    )
    .await
    .map_err(|_| {
        "Die Microsoft-Anmeldung hat zu lange gedauert. Bitte starten Sie sie erneut.".to_string()
    })?
    .map_err(|_| "Die Rückmeldung von Microsoft konnte nicht empfangen werden.".to_string())?;

    let mut request = Vec::with_capacity(4096);
    let mut chunk = [0_u8; 2048];
    loop {
        let read = timeout(Duration::from_secs(15), stream.read(&mut chunk))
            .await
            .map_err(|_| "Die Browser-Rückmeldung war unvollständig.".to_string())?
            .map_err(|_| "Die Browser-Rückmeldung konnte nicht gelesen werden.".to_string())?;
        if read == 0 {
            break;
        }
        request.extend_from_slice(&chunk[..read]);
        if request.windows(4).any(|window| window == b"\r\n\r\n") {
            break;
        }
        if request.len() > 16 * 1024 {
            let _ = send_browser_response(&mut stream, false).await;
            return Err("Die Browser-Rückmeldung war unerwartet groß.".to_string());
        }
    }

    let request = String::from_utf8(request)
        .map_err(|_| "Die Browser-Rückmeldung war ungültig.".to_string())?;
    let target = request
        .lines()
        .next()
        .and_then(|line| line.split_whitespace().nth(1))
        .ok_or_else(|| "Die Browser-Rückmeldung war unvollständig.".to_string())?;
    let code = match parse_browser_callback(target, expected_state) {
        Ok(code) => code,
        Err(error) => {
            let _ = send_browser_response(&mut stream, false).await;
            return Err(error);
        }
    };
    Ok((code, stream))
}

async fn request_interactive_token(
    client_id: &str,
    scopes: &str,
    login_hint: Option<&str>,
) -> Result<OAuthTokenResponse, String> {
    let listener = TcpListener::bind("127.0.0.1:0").await.map_err(|_| {
        "Der sichere Rückkanal für die Microsoft-Anmeldung konnte nicht geöffnet werden."
            .to_string()
    })?;
    let port = listener
        .local_addr()
        .map_err(|_| "Der Rückkanal der Microsoft-Anmeldung ist ungültig.".to_string())?
        .port();
    let redirect_uri = format!("http://localhost:{port}");
    let mut code_verifier = random_urlsafe_secret(48);
    let code_challenge = URL_SAFE_NO_PAD.encode(Sha256::digest(code_verifier.as_bytes()));
    let state = random_urlsafe_secret(32);
    let mut authorize_url = Url::parse(&oauth_url("authorize"))
        .map_err(|_| "Die Microsoft-Anmeldeadresse ist ungültig.".to_string())?;
    {
        let mut query = authorize_url.query_pairs_mut();
        query
            .append_pair("client_id", client_id)
            .append_pair("response_type", "code")
            .append_pair("redirect_uri", &redirect_uri)
            .append_pair("response_mode", "query")
            .append_pair("scope", scopes)
            .append_pair("state", &state)
            .append_pair("code_challenge", &code_challenge)
            .append_pair("code_challenge_method", "S256");
        if let Some(login_hint) = login_hint.filter(|value| !value.trim().is_empty()) {
            query.append_pair("login_hint", login_hint);
        }
    }
    hidden_command("explorer.exe")
        .arg(authorize_url.as_str())
        .spawn()
        .map_err(|error| format!("Microsoft-Anmeldung konnte nicht geöffnet werden: {error}"))?;

    let (code, mut callback_stream) = receive_browser_authorization_code(listener, &state).await?;
    let token = request_token(&[
        ("grant_type", "authorization_code"),
        ("client_id", client_id),
        ("code", &code),
        ("redirect_uri", &redirect_uri),
        ("code_verifier", &code_verifier),
        ("scope", scopes),
    ])
    .await
    .map_err(|error| oauth_error_message(&error));
    let _ = send_browser_response(&mut callback_stream, token.is_ok()).await;
    code_verifier.zeroize();
    token
}

pub(crate) async fn acquire_graph_access_token(
    app: &AppHandle,
    state: &AppState,
) -> Result<String, String> {
    let client_id = configured_client_id()?;
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
    app: AppHandle,
    state: State<'_, AppState>,
    remember_sign_in: Option<bool>,
) -> Result<Microsoft365PollResult, String> {
    let client_id = configured_client_id()?;
    let token = match request_interactive_token(client_id, LOGIN_SCOPES, None).await {
        Ok(token) => token,
        Err(error) => {
            focus_portal_window(&app);
            return Err(error);
        }
    };
    focus_portal_window(&app);
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
        remember_sign_in.unwrap_or(true),
    )?;
    Ok(Microsoft365PollResult {
        state: "connected".to_string(),
        account: Some(account),
    })
}

fn open_microsoft_account_page(url: &str, label: &str) -> Result<(), String> {
    hidden_command("explorer.exe")
        .arg(url)
        .spawn()
        .map_err(|error| format!("{label} konnte nicht geöffnet werden: {error}"))?;
    Ok(())
}

#[tauri::command]
pub fn open_m365_password_reset() -> Result<(), String> {
    open_microsoft_account_page("https://aka.ms/sspr", "Microsoft-Kennwortwiederherstellung")
}

#[tauri::command]
pub fn open_m365_password_change() -> Result<(), String> {
    open_microsoft_account_page(
        "https://mysignins.microsoft.com/security-info/password/change",
        "Microsoft-Kennwortänderung",
    )
}

#[tauri::command]
pub fn open_m365_security_info() -> Result<(), String> {
    open_microsoft_account_page(
        "https://aka.ms/ssprsetup",
        "Microsoft-Sicherheitsinformationen",
    )
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
    app: AppHandle,
    state: State<'_, AppState>,
) -> Result<Microsoft365PollResult, String> {
    let client_id = configured_edv_client_id()?;
    let primary = read_account(&app, &state)?
        .ok_or_else(|| "Das normale Microsoft-Konto ist nicht mehr verbunden.".to_string())?;
    let login_hint = primary.user_principal_name.clone();
    let token = match request_interactive_token(client_id, EDV_SCOPES, Some(&login_hint)).await {
        Ok(token) => token,
        Err(error) => {
            focus_portal_window(&app);
            return Err(error);
        }
    };
    focus_portal_window(&app);
    let profile = graph_profile(&token.access_token).await?;
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
    Ok(Microsoft365PollResult {
        state: "connected".to_string(),
        account: Some(primary),
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
    let client_id = configured_edv_client_id()?;
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
            "Die Microsoft-Anmeldung wurde abgebrochen oder abgelehnt."
        );
    }

    #[test]
    fn browser_callback_requires_matching_state_and_decodes_code() {
        assert_eq!(
            parse_browser_callback("/?code=abc%2B123&state=trusted-state", "trusted-state"),
            Ok("abc+123".to_string())
        );
        assert!(
            parse_browser_callback("/?code=abc&state=other", "trusted-state")
                .unwrap_err()
                .contains("Sicherheitsgründen")
        );
        assert!(parse_browser_callback(
            "http://example.invalid/?code=abc&state=trusted-state",
            "trusted-state"
        )
        .unwrap_err()
        .contains("Rückkanal"));
    }

    #[test]
    fn browser_callback_reports_cancelled_sign_in() {
        assert_eq!(
            parse_browser_callback(
                "/?error=access_denied&error_description=cancelled&state=trusted-state",
                "trusted-state"
            ),
            Err("Die Microsoft-Anmeldung wurde abgebrochen oder abgelehnt.".to_string())
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

    #[test]
    fn edv_only_configuration_opens_the_edv_module() {
        let edv_group = "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb".to_string();

        assert_eq!(
            modules_for_groups(
                std::slice::from_ref(&edv_group),
                &[],
                std::slice::from_ref(&edv_group),
            ),
            vec![EDV_MODULE.to_string()]
        );
    }

    #[test]
    fn release_builds_require_an_embedded_portal_group() {
        if option_env!("DMH_RELEASE_CHANNEL").is_some() {
            assert!(
                authorization_configured(),
                "Release-Build enthält keine konfigurierte Portal-Sicherheitsgruppe."
            );
        }
    }
}
