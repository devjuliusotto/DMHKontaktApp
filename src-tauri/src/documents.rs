use crate::m365;
use chrono::Utc;
use futures_util::{future, stream, StreamExt};
use reqwest::Method;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::collections::HashSet;
use std::fs::{self, File};
use std::io::Read;
use std::path::{Path, PathBuf};
use tauri::{AppHandle, Manager};

const GRAPH: &str = "https://graph.microsoft.com/v1.0";
const SIMPLE_UPLOAD_LIMIT: u64 = 10 * 1024 * 1024;
const UPLOAD_CHUNK_SIZE: usize = 10 * 1024 * 1024;

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DocumentSource {
    id: String,
    name: String,
    kind: String,
    web_url: String,
    site_name: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DocumentItem {
    id: String,
    drive_id: String,
    name: String,
    is_folder: bool,
    size: u64,
    last_modified_at: String,
    modified_by: String,
    web_url: String,
    e_tag: String,
    offline_available: bool,
    offline_outdated: bool,
    offline_e_tag: String,
    local_path: String,
}

#[derive(Debug, Default, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
struct OfflineManifest {
    #[serde(default)]
    entries: Vec<OfflineDocumentEntry>,
    #[serde(default)]
    folders: Vec<OfflineFolderEntry>,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
struct OfflineFolderEntry {
    drive_id: String,
    item_id: String,
    local_path: String,
    name: String,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
struct OfflineDocumentEntry {
    drive_id: String,
    item_id: String,
    e_tag: String,
    local_path: String,
    #[serde(default)]
    content_sha256: String,
    #[serde(default)]
    name: String,
    #[serde(default)]
    parent_id: String,
}

#[derive(Debug, Default, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
struct DocumentConflictStore {
    conflicts: Vec<DocumentSyncConflict>,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DocumentSyncConflict {
    id: String,
    drive_id: String,
    item_id: String,
    name: String,
    local_path: String,
    parent_id: String,
    base_e_tag: String,
    remote_e_tag: String,
    remote_modified_at: String,
    remote_modified_by: String,
    kind: String,
    detected_at: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DocumentSyncSummary {
    checked: usize,
    uploaded: usize,
    downloaded: usize,
    conflicts: usize,
    errors: Vec<String>,
}

#[derive(Debug, PartialEq, Eq)]
enum OfflineSyncAction {
    Nothing,
    UploadLocal,
    DownloadRemote,
    Conflict,
}

fn offline_sync_action(local_changed: bool, remote_changed: bool) -> OfflineSyncAction {
    match (local_changed, remote_changed) {
        (true, true) => OfflineSyncAction::Conflict,
        (true, false) => OfflineSyncAction::UploadLocal,
        (false, true) => OfflineSyncAction::DownloadRemote,
        (false, false) => OfflineSyncAction::Nothing,
    }
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DocumentMutationRequest {
    drive_id: String,
    parent_id: Option<String>,
    item_id: Option<String>,
    name: Option<String>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DocumentTransferRequest {
    source_drive_id: String,
    item_ids: Vec<String>,
    destination_drive_id: String,
    destination_parent_id: Option<String>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DocumentTransferResult {
    processed: usize,
    queued: usize,
    errors: Vec<String>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DocumentUploadResult {
    files: usize,
    folders: usize,
}

#[derive(Debug, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DocumentOfflineFolderResult {
    files: usize,
    folders: usize,
    skipped_local_changes: usize,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DocumentVersion {
    id: String,
    last_modified_at: String,
    modified_by: String,
    size: u64,
}

fn text(value: &Value, key: &str) -> String {
    value
        .get(key)
        .and_then(Value::as_str)
        .unwrap_or("")
        .to_string()
}

fn encode_segment(value: &str) -> String {
    value
        .bytes()
        .map(|byte| match byte {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'_' | b'.' | b'~' => {
                (byte as char).to_string()
            }
            _ => format!("%{byte:02X}"),
        })
        .collect()
}

async fn graph_write(
    token: &str,
    method: Method,
    url: &str,
    body: Option<Value>,
) -> Result<Value, String> {
    let mut request = m365::http_client().request(method, url).bearer_auth(token);
    if let Some(body) = body {
        request = request.json(&body);
    }
    let response = request.send().await.map_err(|error| error.to_string())?;
    let status = response.status();
    let bytes = response.bytes().await.map_err(|error| error.to_string())?;
    if !status.is_success() {
        let detail = serde_json::from_slice::<Value>(&bytes)
            .ok()
            .and_then(|value| {
                value
                    .pointer("/error/message")
                    .and_then(Value::as_str)
                    .map(str::to_string)
            })
            .unwrap_or_else(|| String::from_utf8_lossy(&bytes).to_string());
        return Err(format!("Microsoft 365 ({status}): {detail}"));
    }
    if bytes.is_empty() {
        Ok(Value::Null)
    } else {
        serde_json::from_slice(&bytes).map_err(|error| error.to_string())
    }
}

fn drive_source(value: &Value, kind: &str, site_name: &str) -> Option<DocumentSource> {
    let id = text(value, "id");
    if id.is_empty() {
        return None;
    }
    Some(DocumentSource {
        id,
        name: text(value, "name"),
        kind: kind.to_string(),
        web_url: text(value, "webUrl"),
        site_name: site_name.to_string(),
    })
}

#[tauri::command]
pub async fn list_document_sources(
    app: AppHandle,
    scope: Option<String>,
) -> Result<Vec<DocumentSource>, String> {
    let token = m365::refreshed_access_token(&app).await?;
    match scope.as_deref().unwrap_or("all") {
        "onedrive" => own_document_sources(&token).await,
        "sharepoint" => sharepoint_document_sources(&token).await,
        "all" => {
            let (own, sharepoint) = future::join(
                own_document_sources(&token),
                sharepoint_document_sources(&token),
            )
            .await;
            let mut sources = own?;
            sources.extend(sharepoint.unwrap_or_default());
            Ok(sorted_unique_sources(sources))
        }
        _ => Err("Unbekannter Dokumentquellen-Bereich.".to_string()),
    }
}

async fn own_document_sources(token: &str) -> Result<Vec<DocumentSource>, String> {
    let mut sources = Vec::new();
    let own_drive =
        m365::graph_json(&token, &format!("{GRAPH}/me/drive?$select=id,name,webUrl")).await?;
    if let Some(source) = drive_source(&own_drive, "onedrive", "Mein OneDrive") {
        sources.push(source);
    }
    Ok(sources)
}

async fn sharepoint_document_sources(token: &str) -> Result<Vec<DocumentSource>, String> {
    let sites = m365::graph_collection(
        &token,
        &format!("{GRAPH}/sites?search=*&$select=id,displayName,webUrl&$top=50"),
    )
    .await?;
    let site_requests = sites.into_iter().filter_map(|site| {
        let site_id = text(&site, "id");
        if site_id.is_empty() {
            return None;
        }
        let site_name = text(&site, "displayName");
        let token = token.to_string();
        Some(async move {
            let drives = m365::graph_collection(
                &token,
                &format!(
                    "{GRAPH}/sites/{}/drives?$select=id,name,webUrl&$top=50",
                    encode_segment(&site_id)
                ),
            )
            .await
            .unwrap_or_default();
            drives
                .iter()
                .filter_map(|drive| drive_source(drive, "sharepoint", &site_name))
                .collect::<Vec<_>>()
        })
    });
    let sources = stream::iter(site_requests)
        .buffer_unordered(4)
        .collect::<Vec<_>>()
        .await
        .into_iter()
        .flatten()
        .collect::<Vec<_>>();
    Ok(sorted_unique_sources(sources))
}

fn sorted_unique_sources(sources: Vec<DocumentSource>) -> Vec<DocumentSource> {
    let mut seen = HashSet::new();
    let mut sources = sources
        .into_iter()
        .filter(|source| seen.insert(source.id.clone()))
        .collect::<Vec<_>>();
    sources.sort_by(|left, right| {
        left.kind
            .cmp(&right.kind)
            .then_with(|| left.site_name.cmp(&right.site_name))
            .then_with(|| left.name.cmp(&right.name))
    });
    sources
}

fn item_from_value(value: Value, drive_id: &str) -> Option<DocumentItem> {
    let id = text(&value, "id");
    if id.is_empty() {
        return None;
    }
    Some(DocumentItem {
        id,
        drive_id: drive_id.to_string(),
        name: text(&value, "name"),
        is_folder: value.get("folder").is_some(),
        size: value.get("size").and_then(Value::as_u64).unwrap_or(0),
        last_modified_at: text(&value, "lastModifiedDateTime"),
        modified_by: value
            .pointer("/lastModifiedBy/user/displayName")
            .and_then(Value::as_str)
            .unwrap_or("")
            .to_string(),
        web_url: text(&value, "webUrl"),
        e_tag: text(&value, "eTag"),
        offline_available: false,
        offline_outdated: false,
        offline_e_tag: String::new(),
        local_path: String::new(),
    })
}

async fn destination_folder_id(
    token: &str,
    drive_id: &str,
    parent_id: Option<&str>,
) -> Result<String, String> {
    if let Some(parent_id) = parent_id.filter(|value| !value.trim().is_empty()) {
        return Ok(parent_id.to_string());
    }
    let root = m365::graph_json(
        token,
        &format!(
            "{GRAPH}/drives/{}/root?$select=id",
            encode_segment(drive_id)
        ),
    )
    .await?;
    let id = text(&root, "id");
    if id.is_empty() {
        Err("Der Stammordner des Zielorts konnte nicht ermittelt werden.".to_string())
    } else {
        Ok(id)
    }
}

async fn create_folder_with_token(
    token: &str,
    drive_id: &str,
    parent_id: Option<&str>,
    name: &str,
    conflict_behavior: &str,
) -> Result<DocumentItem, String> {
    let endpoint = match parent_id.filter(|value| !value.trim().is_empty()) {
        Some(parent) => format!(
            "{GRAPH}/drives/{}/items/{}/children",
            encode_segment(drive_id),
            encode_segment(parent)
        ),
        None => format!("{GRAPH}/drives/{}/root/children", encode_segment(drive_id)),
    };
    let value = graph_write(
        token,
        Method::POST,
        &endpoint,
        Some(json!({
            "name": name,
            "folder": {},
            "@microsoft.graph.conflictBehavior": conflict_behavior
        })),
    )
    .await?;
    item_from_value(value, drive_id)
        .ok_or_else(|| "Der neue Ordner konnte nicht ausgewertet werden.".to_string())
}

fn offline_manifest_path(app: &AppHandle) -> Result<PathBuf, String> {
    Ok(app
        .path()
        .app_data_dir()
        .map_err(|error| error.to_string())?
        .join("documents-offline.json"))
}

fn load_offline_manifest(app: &AppHandle) -> Result<OfflineManifest, String> {
    let path = offline_manifest_path(app)?;
    if !path.exists() {
        return Ok(OfflineManifest::default());
    }
    let content = fs::read_to_string(path).map_err(|error| error.to_string())?;
    serde_json::from_str(&content).map_err(|error| error.to_string())
}

fn save_offline_manifest(app: &AppHandle, manifest: &OfflineManifest) -> Result<(), String> {
    let path = offline_manifest_path(app)?;
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent).map_err(|error| error.to_string())?;
    }
    fs::write(
        &path,
        serde_json::to_vec_pretty(manifest).map_err(|error| error.to_string())?,
    )
    .map_err(|error| error.to_string())
}

fn document_conflicts_path(app: &AppHandle) -> Result<PathBuf, String> {
    Ok(app.path().app_data_dir().map_err(|error| error.to_string())?.join("documents-conflicts.json"))
}

fn load_document_conflicts(app: &AppHandle) -> Result<DocumentConflictStore, String> {
    let path = document_conflicts_path(app)?;
    if !path.exists() { return Ok(DocumentConflictStore::default()); }
    serde_json::from_slice(&fs::read(path).map_err(|error| error.to_string())?)
        .map_err(|error| error.to_string())
}

fn save_document_conflicts(app: &AppHandle, store: &DocumentConflictStore) -> Result<(), String> {
    let path = document_conflicts_path(app)?;
    if let Some(parent) = path.parent() { fs::create_dir_all(parent).map_err(|error| error.to_string())?; }
    fs::write(path, serde_json::to_vec_pretty(store).map_err(|error| error.to_string())?)
        .map_err(|error| error.to_string())
}

fn conflict_id(drive_id: &str, item_id: &str) -> String {
    format!("{drive_id}:{item_id}")
}

fn upsert_document_conflict(app: &AppHandle, conflict: DocumentSyncConflict) -> Result<(), String> {
    let mut store = load_document_conflicts(app)?;
    store.conflicts.retain(|item| item.id != conflict.id);
    store.conflicts.push(conflict);
    save_document_conflicts(app, &store)
}

fn record_offline_file(
    app: &AppHandle,
    drive_id: &str,
    item_id: &str,
    e_tag: &str,
    local_path: &Path,
    name: &str,
    parent_id: Option<&str>,
) -> Result<(), String> {
    let mut manifest = load_offline_manifest(app)?;
    manifest
        .entries
        .retain(|entry| entry.drive_id != drive_id || entry.item_id != item_id);
    manifest.entries.push(OfflineDocumentEntry {
        drive_id: drive_id.to_string(),
        item_id: item_id.to_string(),
        e_tag: e_tag.to_string(),
        local_path: local_path.to_string_lossy().to_string(),
        content_sha256: file_sha256(local_path)?,
        name: name.to_string(),
        parent_id: parent_id.unwrap_or("").to_string(),
    });
    save_offline_manifest(app, &manifest)
}

fn file_sha256(path: &Path) -> Result<String, String> {
    let mut file = File::open(path).map_err(|error| error.to_string())?;
    let mut hasher = Sha256::new();
    let mut buffer = [0_u8; 64 * 1024];
    loop {
        let read = file.read(&mut buffer).map_err(|error| error.to_string())?;
        if read == 0 {
            break;
        }
        hasher.update(&buffer[..read]);
    }
    Ok(format!("{:x}", hasher.finalize()))
}

fn ensure_local_file_can_be_replaced(
    app: &AppHandle,
    drive_id: &str,
    item_id: &str,
) -> Result<(), String> {
    let manifest = load_offline_manifest(app)?;
    let Some(entry) = manifest
        .entries
        .iter()
        .find(|entry| entry.drive_id == drive_id && entry.item_id == item_id)
    else {
        return Ok(());
    };
    let path = Path::new(&entry.local_path);
    if path.is_file()
        && !entry.content_sha256.is_empty()
        && file_sha256(path)? != entry.content_sha256
    {
        return Err("Die lokale Datei enthält noch nicht hochgeladene Änderungen. Sie wurde nicht überschrieben. Laden Sie zuerst die lokale Änderung hoch oder speichern Sie sie unter einem anderen Namen.".to_string());
    }
    Ok(())
}

fn attach_offline_status(app: &AppHandle, items: &mut [DocumentItem]) -> Result<(), String> {
    let manifest = load_offline_manifest(app)?;
    for item in items {
        if item.is_folder {
            if let Some(folder) = manifest.folders.iter().find(|entry| entry.drive_id == item.drive_id && entry.item_id == item.id) {
                item.offline_available = Path::new(&folder.local_path).is_dir();
                item.local_path = folder.local_path.clone();
            }
            continue;
        }
        if let Some(entry) = manifest
            .entries
            .iter()
            .find(|entry| entry.drive_id == item.drive_id && entry.item_id == item.id)
        {
            let exists = Path::new(&entry.local_path).is_file();
            item.offline_available = exists;
            item.offline_outdated = exists && !item.e_tag.is_empty() && entry.e_tag != item.e_tag;
            if exists {
                item.offline_e_tag = entry.e_tag.clone();
                item.local_path = entry.local_path.clone();
            }
        }
    }
    Ok(())
}

#[tauri::command]
pub async fn list_document_items(
    app: AppHandle,
    drive_id: String,
    parent_id: Option<String>,
) -> Result<Vec<DocumentItem>, String> {
    let token = m365::refreshed_access_token(&app).await?;
    let parent = parent_id.filter(|value| !value.trim().is_empty());
    let url = match parent {
        Some(parent) => format!("{GRAPH}/drives/{}/items/{}/children?$select=id,name,size,folder,lastModifiedDateTime,lastModifiedBy,webUrl,eTag&$top=200", encode_segment(&drive_id), encode_segment(&parent)),
        None => format!("{GRAPH}/drives/{}/root/children?$select=id,name,size,folder,lastModifiedDateTime,lastModifiedBy,webUrl,eTag&$top=200", encode_segment(&drive_id)),
    };
    let values = m365::graph_collection(&token, &url).await?;
    let mut items = values
        .into_iter()
        .filter_map(|value| item_from_value(value, &drive_id))
        .collect::<Vec<_>>();
    attach_offline_status(&app, &mut items)?;
    items.sort_by(|left, right| {
        right
            .is_folder
            .cmp(&left.is_folder)
            .then_with(|| left.name.to_lowercase().cmp(&right.name.to_lowercase()))
    });
    Ok(items)
}

#[tauri::command]
pub async fn create_document_folder(
    app: AppHandle,
    request: DocumentMutationRequest,
) -> Result<DocumentItem, String> {
    let token = m365::refreshed_access_token(&app).await?;
    let name = request.name.unwrap_or_default().trim().to_string();
    if name.is_empty() || name.contains('/') || name.contains('\\') {
        return Err("Bitte geben Sie einen gültigen Ordnernamen ein.".to_string());
    }
    create_folder_with_token(
        &token,
        &request.drive_id,
        request.parent_id.as_deref(),
        &name,
        "fail",
    )
    .await
}

#[tauri::command]
pub async fn rename_document_item(
    app: AppHandle,
    request: DocumentMutationRequest,
) -> Result<DocumentItem, String> {
    let token = m365::refreshed_access_token(&app).await?;
    let item_id = request
        .item_id
        .ok_or_else(|| "Dokument-ID fehlt.".to_string())?;
    let name = request.name.unwrap_or_default().trim().to_string();
    if name.is_empty() || name.contains('/') || name.contains('\\') {
        return Err("Bitte geben Sie einen gültigen Namen ein.".to_string());
    }
    let endpoint = format!(
        "{GRAPH}/drives/{}/items/{}",
        encode_segment(&request.drive_id),
        encode_segment(&item_id)
    );
    let value = graph_write(
        &token,
        Method::PATCH,
        &endpoint,
        Some(json!({"name": name})),
    )
    .await?;
    item_from_value(value, &request.drive_id)
        .ok_or_else(|| "Das umbenannte Element konnte nicht ausgewertet werden.".to_string())
}

#[tauri::command]
pub async fn delete_document_item(
    app: AppHandle,
    drive_id: String,
    item_id: String,
) -> Result<(), String> {
    let token = m365::refreshed_access_token(&app).await?;
    let endpoint = format!(
        "{GRAPH}/drives/{}/items/{}",
        encode_segment(&drive_id),
        encode_segment(&item_id)
    );
    graph_write(&token, Method::DELETE, &endpoint, None).await?;
    let mut manifest = load_offline_manifest(&app)?;
    manifest
        .entries
        .retain(|entry| entry.drive_id != drive_id || entry.item_id != item_id);
    save_offline_manifest(&app, &manifest)?;
    Ok(())
}

#[tauri::command]
pub async fn move_document_items(
    app: AppHandle,
    request: DocumentTransferRequest,
) -> Result<DocumentTransferResult, String> {
    if request.source_drive_id != request.destination_drive_id {
        return Err("Verschieben zwischen OneDrive- und SharePoint-Bibliotheken ist technisch nicht möglich. Verwenden Sie Kopieren und löschen Sie das Original anschließend bewusst.".to_string());
    }
    let token = m365::refreshed_access_token(&app).await?;
    let destination_id = destination_folder_id(
        &token,
        &request.destination_drive_id,
        request.destination_parent_id.as_deref(),
    )
    .await?;
    let mut result = DocumentTransferResult { processed: 0, queued: 0, errors: Vec::new() };
    for item_id in request.item_ids {
        if item_id == destination_id {
            result.errors.push("Ein Ordner kann nicht in sich selbst verschoben werden.".to_string());
            continue;
        }
        let endpoint = format!(
            "{GRAPH}/drives/{}/items/{}",
            encode_segment(&request.source_drive_id),
            encode_segment(&item_id)
        );
        match graph_write(
            &token,
            Method::PATCH,
            &endpoint,
            Some(json!({"parentReference": {"id": &destination_id}})),
        )
        .await
        {
            Ok(_) => result.processed += 1,
            Err(error) => result.errors.push(error),
        }
    }
    Ok(result)
}

#[tauri::command]
pub async fn copy_document_items(
    app: AppHandle,
    request: DocumentTransferRequest,
) -> Result<DocumentTransferResult, String> {
    let token = m365::refreshed_access_token(&app).await?;
    let destination_id = destination_folder_id(
        &token,
        &request.destination_drive_id,
        request.destination_parent_id.as_deref(),
    )
    .await?;
    let mut result = DocumentTransferResult { processed: 0, queued: 0, errors: Vec::new() };
    for item_id in request.item_ids {
        let endpoint = format!(
            "{GRAPH}/drives/{}/items/{}/copy?@microsoft.graph.conflictBehavior=rename",
            encode_segment(&request.source_drive_id),
            encode_segment(&item_id)
        );
        let response = m365::http_client()
            .post(&endpoint)
            .bearer_auth(&token)
            .json(&json!({
                "parentReference": {
                    "driveId": &request.destination_drive_id,
                    "id": &destination_id
                }
            }))
            .send()
            .await
            .map_err(|error| error.to_string())?;
        if response.status().is_success() {
            result.queued += 1;
        } else {
            let status = response.status();
            let detail = response.text().await.unwrap_or_default();
            result.errors.push(format!("Microsoft 365 ({status}): {detail}"));
        }
    }
    Ok(result)
}

#[tauri::command]
pub async fn create_document_text_file(
    app: AppHandle,
    drive_id: String,
    parent_id: Option<String>,
    name: String,
    content: Option<String>,
) -> Result<DocumentItem, String> {
    let name = name.trim();
    if name.is_empty() || name.contains('/') || name.contains('\\') {
        return Err("Bitte geben Sie einen gültigen Dateinamen ein.".to_string());
    }
    let file_name = if name.contains('.') { name.to_string() } else { format!("{name}.txt") };
    let token = m365::refreshed_access_token(&app).await?;
    let endpoint = match parent_id.as_deref().filter(|value| !value.trim().is_empty()) {
        Some(parent) => format!(
            "{GRAPH}/drives/{}/items/{}:/{}/content?@microsoft.graph.conflictBehavior=fail",
            encode_segment(&drive_id),
            encode_segment(parent),
            encode_segment(&file_name)
        ),
        None => format!(
            "{GRAPH}/drives/{}/root:/{}/content?@microsoft.graph.conflictBehavior=fail",
            encode_segment(&drive_id),
            encode_segment(&file_name)
        ),
    };
    let value = graph_upload_bytes(&token, &endpoint, content.unwrap_or_default().into_bytes()).await?;
    item_from_value(value, &drive_id)
        .ok_or_else(|| "Die neue Datei konnte nicht ausgewertet werden.".to_string())
}

#[tauri::command]
pub async fn create_document_share_link(
    app: AppHandle,
    drive_id: String,
    item_id: String,
    allow_edit: bool,
) -> Result<String, String> {
    let token = m365::refreshed_access_token(&app).await?;
    let endpoint = format!(
        "{GRAPH}/drives/{}/items/{}/createLink",
        encode_segment(&drive_id),
        encode_segment(&item_id)
    );
    let value = graph_write(
        &token,
        Method::POST,
        &endpoint,
        Some(json!({
            "type": if allow_edit { "edit" } else { "view" },
            "scope": "organization"
        })),
    )
    .await?;
    value.pointer("/link/webUrl")
        .and_then(Value::as_str)
        .map(str::to_string)
        .ok_or_else(|| "Microsoft 365 hat keinen Freigabelink zurückgegeben.".to_string())
}

#[tauri::command]
pub async fn list_document_versions(
    app: AppHandle,
    drive_id: String,
    item_id: String,
) -> Result<Vec<DocumentVersion>, String> {
    let token = m365::refreshed_access_token(&app).await?;
    let endpoint = format!(
        "{GRAPH}/drives/{}/items/{}/versions?$select=id,lastModifiedDateTime,lastModifiedBy,size&$top=100",
        encode_segment(&drive_id),
        encode_segment(&item_id)
    );
    let values = m365::graph_collection(&token, &endpoint).await?;
    Ok(values.into_iter().map(|value| DocumentVersion {
        id: text(&value, "id"),
        last_modified_at: text(&value, "lastModifiedDateTime"),
        modified_by: value.pointer("/lastModifiedBy/user/displayName").and_then(Value::as_str).unwrap_or("").to_string(),
        size: value.get("size").and_then(Value::as_u64).unwrap_or(0),
    }).collect())
}

#[tauri::command]
pub async fn restore_document_version(
    app: AppHandle,
    drive_id: String,
    item_id: String,
    version_id: String,
) -> Result<(), String> {
    let token = m365::refreshed_access_token(&app).await?;
    let endpoint = format!(
        "{GRAPH}/drives/{}/items/{}/versions/{}/restoreVersion",
        encode_segment(&drive_id),
        encode_segment(&item_id),
        encode_segment(&version_id)
    );
    graph_write(&token, Method::POST, &endpoint, Some(json!({}))).await?;
    Ok(())
}

fn safe_file_name(name: &str) -> String {
    let sanitized = name
        .chars()
        .map(|character| {
            if "<>:\"/\\|?*".contains(character) {
                '_'
            } else {
                character
            }
        })
        .collect::<String>()
        .trim()
        .to_string();
    if sanitized.is_empty() || sanitized == "." || sanitized == ".." {
        "_".to_string()
    } else {
        sanitized
    }
}

fn documents_root(app: &AppHandle) -> Result<PathBuf, String> {
    Ok(app
        .path()
        .document_dir()
        .map_err(|error| error.to_string())?
        .join("DMH Dokumente"))
}

fn local_document_folder(app: &AppHandle, relative_path: Vec<String>) -> Result<PathBuf, String> {
    let mut target = documents_root(app)?;
    for segment in relative_path {
        target.push(safe_file_name(&segment));
    }
    fs::create_dir_all(&target).map_err(|error| error.to_string())?;
    Ok(target)
}

async fn graph_upload_bytes(token: &str, url: &str, bytes: Vec<u8>) -> Result<Value, String> {
    let response = m365::http_client()
        .put(url)
        .bearer_auth(token)
        .header(reqwest::header::CONTENT_TYPE, "application/octet-stream")
        .body(bytes)
        .send()
        .await
        .map_err(|error| error.to_string())?;
    let status = response.status();
    let bytes = response.bytes().await.map_err(|error| error.to_string())?;
    if !status.is_success() {
        return Err(format!(
            "Upload fehlgeschlagen ({status}): {}",
            String::from_utf8_lossy(&bytes)
        ));
    }
    serde_json::from_slice(&bytes).map_err(|error| error.to_string())
}

async fn upload_large_file(
    token: &str,
    drive_id: &str,
    parent_id: Option<&str>,
    file_path: &Path,
    file_name: &str,
    file_size: u64,
) -> Result<Value, String> {
    let target = match parent_id {
        Some(parent) => format!(
            "{GRAPH}/drives/{}/items/{}:/{}/createUploadSession",
            encode_segment(drive_id),
            encode_segment(parent),
            encode_segment(file_name)
        ),
        None => format!(
            "{GRAPH}/drives/{}/root:/{}/createUploadSession",
            encode_segment(drive_id),
            encode_segment(file_name)
        ),
    };
    let session = graph_write(
        token,
        Method::POST,
        &target,
        Some(json!({
            "item": {
                "@microsoft.graph.conflictBehavior": "rename",
                "name": file_name
            }
        })),
    )
    .await?;
    let upload_url = session
        .get("uploadUrl")
        .and_then(Value::as_str)
        .ok_or_else(|| "Microsoft 365 hat keine Upload-Adresse zurückgegeben.".to_string())?;
    upload_file_chunks(upload_url, file_path, file_size).await
}

async fn upload_file_chunks(
    upload_url: &str,
    file_path: &Path,
    file_size: u64,
) -> Result<Value, String> {
    let mut file = File::open(file_path).map_err(|error| error.to_string())?;
    let client = m365::http_client();
    let mut offset = 0_u64;
    loop {
        let mut chunk = vec![0_u8; UPLOAD_CHUNK_SIZE];
        let read = file.read(&mut chunk).map_err(|error| error.to_string())?;
        if read == 0 {
            return Err("Der Upload wurde unerwartet beendet.".to_string());
        }
        chunk.truncate(read);
        let end = offset + read as u64 - 1;
        let response = client
            .put(upload_url)
            .header(reqwest::header::CONTENT_LENGTH, read)
            .header(
                reqwest::header::CONTENT_RANGE,
                format!("bytes {offset}-{end}/{file_size}"),
            )
            .body(chunk)
            .send()
            .await
            .map_err(|error| error.to_string())?;
        let status = response.status();
        let bytes = response.bytes().await.map_err(|error| error.to_string())?;
        if !status.is_success() {
            return Err(format!(
                "Upload fehlgeschlagen ({status}): {}",
                String::from_utf8_lossy(&bytes)
            ));
        }
        offset = end + 1;
        if offset >= file_size {
            return serde_json::from_slice(&bytes).map_err(|error| error.to_string());
        }
    }
}

async fn remote_document_metadata(
    token: &str,
    drive_id: &str,
    item_id: &str,
) -> Result<Option<Value>, String> {
    let url = format!(
        "{GRAPH}/drives/{}/items/{}?$select=id,name,eTag,lastModifiedDateTime,lastModifiedBy,parentReference",
        encode_segment(drive_id),
        encode_segment(item_id)
    );
    let response = m365::http_client().get(url).bearer_auth(token).send().await.map_err(|error| error.to_string())?;
    if response.status() == reqwest::StatusCode::NOT_FOUND { return Ok(None); }
    let status = response.status();
    let bytes = response.bytes().await.map_err(|error| error.to_string())?;
    if !status.is_success() {
        return Err(format!("Microsoft 365 ({status}): {}", String::from_utf8_lossy(&bytes)));
    }
    serde_json::from_slice(&bytes).map(Some).map_err(|error| error.to_string())
}

async fn download_remote_to_path(
    token: &str,
    drive_id: &str,
    item_id: &str,
    path: &Path,
) -> Result<(), String> {
    let url = format!(
        "{GRAPH}/drives/{}/items/{}/content",
        encode_segment(drive_id),
        encode_segment(item_id)
    );
    let response = m365::http_client().get(url).bearer_auth(token).send().await.map_err(|error| error.to_string())?;
    if !response.status().is_success() { return Err(format!("Download fehlgeschlagen: {}", response.status())); }
    if let Some(parent) = path.parent() { fs::create_dir_all(parent).map_err(|error| error.to_string())?; }
    fs::write(path, response.bytes().await.map_err(|error| error.to_string())?).map_err(|error| error.to_string())
}

async fn replace_remote_content(
    token: &str,
    drive_id: &str,
    item_id: &str,
    file_path: &Path,
) -> Result<DocumentItem, String> {
    let metadata = fs::metadata(file_path).map_err(|error| error.to_string())?;
    let value = if metadata.len() <= SIMPLE_UPLOAD_LIMIT {
        let endpoint = format!(
            "{GRAPH}/drives/{}/items/{}/content",
            encode_segment(drive_id),
            encode_segment(item_id)
        );
        graph_upload_bytes(token, &endpoint, fs::read(file_path).map_err(|error| error.to_string())?).await?
    } else {
        let endpoint = format!(
            "{GRAPH}/drives/{}/items/{}/createUploadSession",
            encode_segment(drive_id),
            encode_segment(item_id)
        );
        let session = graph_write(token, Method::POST, &endpoint, Some(json!({"item": {"@microsoft.graph.conflictBehavior": "replace"}}))).await?;
        let upload_url = session.get("uploadUrl").and_then(Value::as_str)
            .ok_or_else(|| "Microsoft 365 hat keine Upload-Adresse zurückgegeben.".to_string())?;
        upload_file_chunks(upload_url, file_path, metadata.len()).await?
    };
    item_from_value(value, drive_id).ok_or_else(|| "Die aktualisierte Datei konnte nicht ausgewertet werden.".to_string())
}

#[tauri::command]
pub async fn download_document_item(
    app: AppHandle,
    drive_id: String,
    item_id: String,
    name: String,
    relative_path: Option<Vec<String>>,
    e_tag: Option<String>,
    parent_id: Option<String>,
) -> Result<String, String> {
    ensure_local_file_can_be_replaced(&app, &drive_id, &item_id)?;
    let token = m365::refreshed_access_token(&app).await?;
    let url = format!(
        "{GRAPH}/drives/{}/items/{}/content",
        encode_segment(&drive_id),
        encode_segment(&item_id)
    );
    let response = m365::http_client()
        .get(url)
        .bearer_auth(&token)
        .send()
        .await
        .map_err(|error| error.to_string())?;
    if !response.status().is_success() {
        return Err(format!("Download fehlgeschlagen: {}", response.status()));
    }
    let bytes = response.bytes().await.map_err(|error| error.to_string())?;
    let root = local_document_folder(
        &app,
        relative_path.unwrap_or_else(|| vec!["Downloads".to_string()]),
    )?;
    let path = root.join(safe_file_name(&name));
    fs::write(&path, bytes).map_err(|error| error.to_string())?;
    record_offline_file(
        &app,
        &drive_id,
        &item_id,
        e_tag.as_deref().unwrap_or(""),
        &path,
        &name,
        parent_id.as_deref(),
    )?;
    Ok(path.to_string_lossy().to_string())
}

async fn download_offline_folder_tree(
    app: &AppHandle,
    token: &str,
    folder: &OfflineFolderEntry,
) -> Result<DocumentOfflineFolderResult, String> {
    let root = PathBuf::from(&folder.local_path);
    fs::create_dir_all(&root).map_err(|error| error.to_string())?;
    let mut result = DocumentOfflineFolderResult { files: 0, folders: 1, skipped_local_changes: 0 };
    let mut pending = vec![(folder.item_id.clone(), root)];
    while let Some((remote_folder_id, local_folder)) = pending.pop() {
        let url = format!(
            "{GRAPH}/drives/{}/items/{}/children?$select=id,name,size,folder,lastModifiedDateTime,lastModifiedBy,webUrl,eTag&$top=200",
            encode_segment(&folder.drive_id),
            encode_segment(&remote_folder_id)
        );
        for value in m365::graph_collection(token, &url).await? {
            let item_id = text(&value, "id");
            let name = text(&value, "name");
            if item_id.is_empty() || name.is_empty() { continue; }
            let local_path = local_folder.join(safe_file_name(&name));
            if value.get("folder").is_some() {
                fs::create_dir_all(&local_path).map_err(|error| error.to_string())?;
                result.folders += 1;
                pending.push((item_id, local_path));
                continue;
            }
            let existing = load_offline_manifest(app)?.entries.into_iter()
                .find(|entry| entry.drive_id == folder.drive_id && entry.item_id == item_id);
            if local_path.is_file()
                && existing.as_ref().is_some_and(|entry| entry.e_tag == text(&value, "eTag"))
            {
                continue;
            }
            if ensure_local_file_can_be_replaced(app, &folder.drive_id, &item_id).is_err() {
                result.skipped_local_changes += 1;
                continue;
            }
            download_remote_to_path(token, &folder.drive_id, &item_id, &local_path).await?;
            record_offline_file(
                app,
                &folder.drive_id,
                &item_id,
                &text(&value, "eTag"),
                &local_path,
                &name,
                Some(&remote_folder_id),
            )?;
            result.files += 1;
        }
    }
    Ok(result)
}

async fn refresh_pinned_offline_folders(app: &AppHandle, token: &str) -> Result<DocumentOfflineFolderResult, String> {
    let folders = load_offline_manifest(app)?.folders;
    let mut total = DocumentOfflineFolderResult::default();
    for folder in folders {
        let result = download_offline_folder_tree(app, token, &folder).await?;
        total.files += result.files;
        total.folders += result.folders;
        total.skipped_local_changes += result.skipped_local_changes;
    }
    Ok(total)
}

#[tauri::command]
pub async fn make_document_folder_offline(
    app: AppHandle,
    drive_id: String,
    folder_id: String,
    name: String,
    relative_path: Vec<String>,
) -> Result<DocumentOfflineFolderResult, String> {
    let local_path = local_document_folder(&app, relative_path)?;
    let folder = OfflineFolderEntry {
        drive_id: drive_id.clone(),
        item_id: folder_id.clone(),
        local_path: local_path.to_string_lossy().to_string(),
        name,
    };
    let mut manifest = load_offline_manifest(&app)?;
    manifest.folders.retain(|entry| entry.drive_id != drive_id || entry.item_id != folder_id);
    manifest.folders.push(folder.clone());
    save_offline_manifest(&app, &manifest)?;
    let token = m365::refreshed_access_token(&app).await?;
    download_offline_folder_tree(&app, &token, &folder).await
}

async fn upload_document_file_as_with_token(
    token: &str,
    drive_id: String,
    parent_id: Option<String>,
    file_path: String,
    remote_name: Option<String>,
) -> Result<DocumentItem, String> {
    let path = PathBuf::from(file_path);
    let metadata = fs::metadata(&path).map_err(|error| error.to_string())?;
    if !metadata.is_file() {
        return Err("Bitte wählen Sie eine Datei aus.".to_string());
    }
    let file_name = remote_name.map(|value| safe_file_name(&value)).or_else(|| path.file_name()
        .and_then(|value| value.to_str()).map(safe_file_name))
        .ok_or_else(|| "Der Dateiname konnte nicht gelesen werden.".to_string())?;
    let parent = parent_id.filter(|value| !value.trim().is_empty());
    let value = if metadata.len() <= SIMPLE_UPLOAD_LIMIT {
        let endpoint = match parent.as_deref() {
            Some(parent) => format!(
                "{GRAPH}/drives/{}/items/{}:/{}/content?@microsoft.graph.conflictBehavior=rename",
                encode_segment(&drive_id),
                encode_segment(parent),
                encode_segment(&file_name)
            ),
            None => format!(
                "{GRAPH}/drives/{}/root:/{}/content?@microsoft.graph.conflictBehavior=rename",
                encode_segment(&drive_id),
                encode_segment(&file_name)
            ),
        };
        let bytes = fs::read(&path).map_err(|error| error.to_string())?;
        graph_upload_bytes(token, &endpoint, bytes).await?
    } else {
        upload_large_file(
            token,
            &drive_id,
            parent.as_deref(),
            &path,
            &file_name,
            metadata.len(),
        )
        .await?
    };
    item_from_value(value, &drive_id)
        .ok_or_else(|| "Die hochgeladene Datei konnte nicht ausgewertet werden.".to_string())
}

async fn upload_document_file_with_token(
    token: &str,
    drive_id: String,
    parent_id: Option<String>,
    file_path: String,
) -> Result<DocumentItem, String> {
    upload_document_file_as_with_token(token, drive_id, parent_id, file_path, None).await
}

#[tauri::command]
pub async fn upload_document_file(
    app: AppHandle,
    drive_id: String,
    parent_id: Option<String>,
    file_path: String,
) -> Result<DocumentItem, String> {
    let token = m365::refreshed_access_token(&app).await?;
    upload_document_file_with_token(&token, drive_id, parent_id, file_path).await
}

#[tauri::command]
pub async fn upload_document_path(
    app: AppHandle,
    drive_id: String,
    parent_id: Option<String>,
    local_path: String,
) -> Result<DocumentUploadResult, String> {
    let path = PathBuf::from(local_path);
    if !path.exists() {
        return Err("Die ausgewählte Datei oder der Ordner wurde nicht gefunden.".to_string());
    }
    let token = m365::refreshed_access_token(&app).await?;
    if path.is_file() {
        upload_document_file_with_token(
            &token,
            drive_id,
            parent_id,
            path.to_string_lossy().to_string(),
        )
        .await?;
        return Ok(DocumentUploadResult { files: 1, folders: 0 });
    }

    let root_name = path.file_name()
        .and_then(|value| value.to_str())
        .map(safe_file_name)
        .ok_or_else(|| "Der Ordnername konnte nicht gelesen werden.".to_string())?;
    let root_folder = create_folder_with_token(
        &token,
        &drive_id,
        parent_id.as_deref(),
        &root_name,
        "rename",
    )
    .await?;
    let mut result = DocumentUploadResult { files: 0, folders: 1 };
    let mut pending = vec![(path, root_folder.id)];
    while let Some((local_folder, remote_parent_id)) = pending.pop() {
        let mut entries = fs::read_dir(&local_folder)
            .map_err(|error| error.to_string())?
            .collect::<Result<Vec<_>, _>>()
            .map_err(|error| error.to_string())?;
        entries.sort_by_key(|entry| entry.file_name());
        for entry in entries {
            let entry_path = entry.path();
            if entry_path.is_dir() {
                let name = entry.file_name().to_string_lossy().to_string();
                let folder = create_folder_with_token(
                    &token,
                    &drive_id,
                    Some(&remote_parent_id),
                    &safe_file_name(&name),
                    "rename",
                )
                .await?;
                result.folders += 1;
                pending.push((entry_path, folder.id));
            } else if entry_path.is_file() {
                upload_document_file_with_token(
                    &token,
                    drive_id.clone(),
                    Some(remote_parent_id.clone()),
                    entry_path.to_string_lossy().to_string(),
                )
                .await?;
                result.files += 1;
            }
        }
    }
    Ok(result)
}

#[tauri::command]
pub async fn upload_document_revision(
    app: AppHandle,
    drive_id: String,
    item_id: String,
    file_path: String,
    expected_e_tag: String,
) -> Result<DocumentItem, String> {
    let path = PathBuf::from(file_path);
    let metadata = fs::metadata(&path).map_err(|error| error.to_string())?;
    if !metadata.is_file() {
        return Err("Die lokale Datei wurde nicht gefunden.".to_string());
    }
    let token = m365::refreshed_access_token(&app).await?;
    let remote = remote_document_metadata(&token, &drive_id, &item_id).await?
        .ok_or_else(|| "Die Online-Datei wurde gelöscht.".to_string())?;
    let current_e_tag = text(&remote, "eTag");
    if !expected_e_tag.is_empty() && current_e_tag != expected_e_tag {
        return Err("Konflikt: Die Online-Datei wurde seit dem Offline-Download geändert. Laden Sie zuerst die aktuelle Version herunter oder öffnen Sie beide Versionen zum Vergleichen.".to_string());
    }

    let item = replace_remote_content(&token, &drive_id, &item_id, &path).await?;
    let parent_id = remote.pointer("/parentReference/id").and_then(Value::as_str);
    record_offline_file(
        &app,
        &drive_id,
        &item_id,
        &item.e_tag,
        &path,
        &item.name,
        parent_id,
    )?;
    Ok(item)
}

fn remove_offline_entry(app: &AppHandle, drive_id: &str, item_id: &str) -> Result<(), String> {
    let mut manifest = load_offline_manifest(app)?;
    manifest.entries.retain(|entry| entry.drive_id != drive_id || entry.item_id != item_id);
    save_offline_manifest(app, &manifest)
}

fn conflict_copy_name(name: &str, user_name: &str) -> String {
    let path = Path::new(name);
    let stem = path.file_stem().and_then(|value| value.to_str()).unwrap_or(name);
    let extension = path.extension().and_then(|value| value.to_str());
    let suffix = format!(" - Konflikt von {} - {}", safe_file_name(user_name), Utc::now().format("%Y-%m-%d %H%M"));
    match extension {
        Some(extension) if !extension.is_empty() => format!("{stem}{suffix}.{extension}"),
        _ => format!("{stem}{suffix}"),
    }
}

fn conflict_from_entry(entry: &OfflineDocumentEntry, remote: Option<&Value>, kind: &str) -> DocumentSyncConflict {
    let remote_name = remote.map(|value| text(value, "name")).unwrap_or_default();
    DocumentSyncConflict {
        id: conflict_id(&entry.drive_id, &entry.item_id),
        drive_id: entry.drive_id.clone(),
        item_id: entry.item_id.clone(),
        name: if remote_name.is_empty() { if entry.name.is_empty() { Path::new(&entry.local_path).file_name().and_then(|value| value.to_str()).unwrap_or("Dokument").to_string() } else { entry.name.clone() } } else { remote_name },
        local_path: entry.local_path.clone(),
        parent_id: remote.and_then(|value| value.pointer("/parentReference/id")).and_then(Value::as_str).unwrap_or(&entry.parent_id).to_string(),
        base_e_tag: entry.e_tag.clone(),
        remote_e_tag: remote.map(|value| text(value, "eTag")).unwrap_or_default(),
        remote_modified_at: remote.map(|value| text(value, "lastModifiedDateTime")).unwrap_or_default(),
        remote_modified_by: remote.and_then(|value| value.pointer("/lastModifiedBy/user/displayName")).and_then(Value::as_str).unwrap_or("").to_string(),
        kind: kind.to_string(),
        detected_at: Utc::now().to_rfc3339(),
    }
}

#[tauri::command]
pub async fn sync_offline_documents(app: AppHandle) -> Result<DocumentSyncSummary, String> {
    let mut summary = DocumentSyncSummary { checked: 0, uploaded: 0, downloaded: 0, conflicts: 0, errors: Vec::new() };
    let initial_manifest = load_offline_manifest(&app)?;
    if initial_manifest.entries.is_empty() && initial_manifest.folders.is_empty() { return Ok(summary); }
    let token = m365::refreshed_access_token(&app).await?;
    match refresh_pinned_offline_folders(&app, &token).await {
        Ok(result) => summary.downloaded += result.files,
        Err(error) => summary.errors.push(format!("Offline-Ordner: {error}")),
    }
    let manifest = load_offline_manifest(&app)?;
    let existing_conflicts = load_document_conflicts(&app)?.conflicts.into_iter().map(|item| item.id).collect::<HashSet<_>>();

    for entry in manifest.entries {
        summary.checked += 1;
        if existing_conflicts.contains(&conflict_id(&entry.drive_id, &entry.item_id)) {
            summary.conflicts += 1;
            continue;
        }
        let path = PathBuf::from(&entry.local_path);
        if !path.is_file() {
            summary.errors.push(format!("Lokale Datei fehlt: {}", entry.local_path));
            continue;
        }
        let local_hash = match file_sha256(&path) {
            Ok(hash) => hash,
            Err(error) => { summary.errors.push(error); continue; }
        };
        let local_changed = !entry.content_sha256.is_empty() && local_hash != entry.content_sha256;
        let remote = match remote_document_metadata(&token, &entry.drive_id, &entry.item_id).await {
            Ok(value) => value,
            Err(error) => { summary.errors.push(format!("{}: {error}", entry.name)); continue; }
        };
        let Some(remote) = remote else {
            if let Err(error) = upsert_document_conflict(&app, conflict_from_entry(&entry, None, "remoteDeleted")) { summary.errors.push(error); }
            else { summary.conflicts += 1; }
            continue;
        };
        let remote_e_tag = text(&remote, "eTag");
        let remote_changed = !entry.e_tag.is_empty() && remote_e_tag != entry.e_tag;
        let name = text(&remote, "name");
        let parent_id = remote.pointer("/parentReference/id").and_then(Value::as_str);
        match offline_sync_action(local_changed, remote_changed) {
            OfflineSyncAction::Conflict => {
                if let Err(error) = upsert_document_conflict(&app, conflict_from_entry(&entry, Some(&remote), "bothModified")) { summary.errors.push(error); }
                else { summary.conflicts += 1; }
            }
            OfflineSyncAction::UploadLocal => match replace_remote_content(&token, &entry.drive_id, &entry.item_id, &path).await {
                Ok(item) => match record_offline_file(&app, &entry.drive_id, &entry.item_id, &item.e_tag, &path, &item.name, parent_id) {
                    Ok(()) => summary.uploaded += 1,
                    Err(error) => summary.errors.push(error),
                },
                Err(error) => summary.errors.push(format!("{}: {error}", name)),
            },
            OfflineSyncAction::DownloadRemote => match download_remote_to_path(&token, &entry.drive_id, &entry.item_id, &path).await {
                Ok(()) => match record_offline_file(&app, &entry.drive_id, &entry.item_id, &remote_e_tag, &path, &name, parent_id) {
                    Ok(()) => summary.downloaded += 1,
                    Err(error) => summary.errors.push(error),
                },
                Err(error) => summary.errors.push(format!("{}: {error}", name)),
            },
            OfflineSyncAction::Nothing => {}
        }
    }
    Ok(summary)
}

#[tauri::command]
pub fn list_document_sync_conflicts(app: AppHandle) -> Result<Vec<DocumentSyncConflict>, String> {
    let mut conflicts = load_document_conflicts(&app)?.conflicts;
    conflicts.sort_by(|left, right| right.detected_at.cmp(&left.detected_at));
    Ok(conflicts)
}

#[tauri::command]
pub async fn resolve_document_sync_conflict(
    app: AppHandle,
    conflict_id_value: String,
    decision: String,
) -> Result<(), String> {
    if decision == "later" { return Ok(()); }
    let mut store = load_document_conflicts(&app)?;
    let conflict = store.conflicts.iter().find(|item| item.id == conflict_id_value).cloned()
        .ok_or_else(|| "Der Konflikt wurde bereits gelöst oder nicht gefunden.".to_string())?;
    let path = PathBuf::from(&conflict.local_path);
    if !path.is_file() { return Err("Die lokale Konfliktdatei wurde nicht gefunden.".to_string()); }
    let token = m365::refreshed_access_token(&app).await?;
    let remote = remote_document_metadata(&token, &conflict.drive_id, &conflict.item_id).await?;
    let account = m365::graph_json(&token, &format!("{GRAPH}/me?$select=displayName")).await.unwrap_or(Value::Null);
    let user_name = account.get("displayName").and_then(Value::as_str).unwrap_or("Offline");

    match decision.as_str() {
        "keepBoth" => {
            if let Some(remote) = remote.as_ref() {
                let parent_id = remote.pointer("/parentReference/id").and_then(Value::as_str).unwrap_or(&conflict.parent_id);
                let conflict_name = conflict_copy_name(&conflict.name, user_name);
                upload_document_file_as_with_token(&token, conflict.drive_id.clone(), Some(parent_id.to_string()), conflict.local_path.clone(), Some(conflict_name)).await?;
                download_remote_to_path(&token, &conflict.drive_id, &conflict.item_id, &path).await?;
                record_offline_file(&app, &conflict.drive_id, &conflict.item_id, &text(remote, "eTag"), &path, &text(remote, "name"), Some(parent_id))?;
            } else {
                let item = upload_document_file_as_with_token(&token, conflict.drive_id.clone(), non_empty(&conflict.parent_id), conflict.local_path.clone(), Some(conflict.name.clone())).await?;
                remove_offline_entry(&app, &conflict.drive_id, &conflict.item_id)?;
                record_offline_file(&app, &conflict.drive_id, &item.id, &item.e_tag, &path, &item.name, non_empty_ref(&conflict.parent_id))?;
            }
        }
        "useLocal" => {
            if let Some(remote) = remote.as_ref() {
                let item = replace_remote_content(&token, &conflict.drive_id, &conflict.item_id, &path).await?;
                let parent_id = remote.pointer("/parentReference/id").and_then(Value::as_str);
                record_offline_file(&app, &conflict.drive_id, &conflict.item_id, &item.e_tag, &path, &item.name, parent_id)?;
            } else {
                let item = upload_document_file_as_with_token(&token, conflict.drive_id.clone(), non_empty(&conflict.parent_id), conflict.local_path.clone(), Some(conflict.name.clone())).await?;
                remove_offline_entry(&app, &conflict.drive_id, &conflict.item_id)?;
                record_offline_file(&app, &conflict.drive_id, &item.id, &item.e_tag, &path, &item.name, non_empty_ref(&conflict.parent_id))?;
            }
        }
        "useOnline" => {
            if let Some(remote) = remote.as_ref() {
                download_remote_to_path(&token, &conflict.drive_id, &conflict.item_id, &path).await?;
                let parent_id = remote.pointer("/parentReference/id").and_then(Value::as_str);
                record_offline_file(&app, &conflict.drive_id, &conflict.item_id, &text(remote, "eTag"), &path, &text(remote, "name"), parent_id)?;
            } else {
                let recovered = documents_root(&app)?.join("Gelöschte Elemente");
                fs::create_dir_all(&recovered).map_err(|error| error.to_string())?;
                let target = recovered.join(conflict_copy_name(&conflict.name, user_name));
                fs::copy(&path, &target).map_err(|error| error.to_string())?;
                remove_offline_entry(&app, &conflict.drive_id, &conflict.item_id)?;
            }
        }
        _ => return Err("Unbekannte Konfliktentscheidung.".to_string()),
    }
    store.conflicts.retain(|item| item.id != conflict_id_value);
    save_document_conflicts(&app, &store)
}

fn non_empty(value: &str) -> Option<String> {
    if value.trim().is_empty() { None } else { Some(value.to_string()) }
}

fn non_empty_ref(value: &str) -> Option<&str> {
    if value.trim().is_empty() { None } else { Some(value) }
}

#[tauri::command]
pub fn get_documents_local_root(app: AppHandle) -> Result<String, String> {
    let root = documents_root(&app)?;
    fs::create_dir_all(&root).map_err(|error| error.to_string())?;
    Ok(root.to_string_lossy().to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn sanitizes_windows_file_names_and_path_segments() {
        assert_eq!(safe_file_name("Plan: 2026?.docx"), "Plan_ 2026_.docx");
        assert_eq!(safe_file_name(".."), "_");
        assert_eq!(safe_file_name("  "), "_");
    }

    #[test]
    fn classifies_offline_sync_without_overwriting_conflicts() {
        assert_eq!(offline_sync_action(false, false), OfflineSyncAction::Nothing);
        assert_eq!(offline_sync_action(true, false), OfflineSyncAction::UploadLocal);
        assert_eq!(offline_sync_action(false, true), OfflineSyncAction::DownloadRemote);
        assert_eq!(offline_sync_action(true, true), OfflineSyncAction::Conflict);
    }

    #[test]
    fn conflict_copy_keeps_the_original_extension() {
        let name = conflict_copy_name("Bericht.docx", "Maria");
        assert!(name.starts_with("Bericht - Konflikt von Maria - "));
        assert!(name.ends_with(".docx"));
    }

    #[test]
    fn document_sources_are_sorted_and_deduplicated() {
        let source = |id: &str, kind: &str, site_name: &str, name: &str| DocumentSource {
            id: id.to_string(),
            kind: kind.to_string(),
            site_name: site_name.to_string(),
            name: name.to_string(),
            web_url: String::new(),
        };
        let sources = sorted_unique_sources(vec![
            source("2", "sharepoint", "Zentrale", "Dokumente"),
            source("1", "onedrive", "Mein OneDrive", "OneDrive"),
            source("2", "sharepoint", "Zentrale", "Duplikat"),
        ]);

        assert_eq!(sources.len(), 2);
        assert_eq!(sources[0].id, "1");
        assert_eq!(sources[1].id, "2");
    }
}
