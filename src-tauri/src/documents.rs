use crate::m365;
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
    entries: Vec<OfflineDocumentEntry>,
}

#[derive(Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
struct OfflineDocumentEntry {
    drive_id: String,
    item_id: String,
    e_tag: String,
    local_path: String,
    #[serde(default)]
    content_sha256: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DocumentMutationRequest {
    drive_id: String,
    parent_id: Option<String>,
    item_id: Option<String>,
    name: Option<String>,
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
    let client = reqwest::Client::new();
    let mut request = client.request(method, url).bearer_auth(token);
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
pub async fn list_document_sources(app: AppHandle) -> Result<Vec<DocumentSource>, String> {
    let token = m365::refreshed_access_token(&app).await?;
    let mut sources = Vec::new();
    let mut seen = HashSet::new();
    let own_drive =
        m365::graph_json(&token, &format!("{GRAPH}/me/drive?$select=id,name,webUrl")).await?;
    if let Some(source) = drive_source(&own_drive, "onedrive", "Mein OneDrive") {
        seen.insert(source.id.clone());
        sources.push(source);
    }

    let sites = m365::graph_collection(
        &token,
        &format!("{GRAPH}/sites?search=*&$select=id,displayName,webUrl&$top=50"),
    )
    .await
    .unwrap_or_default();
    for site in sites {
        let site_id = text(&site, "id");
        if site_id.is_empty() {
            continue;
        }
        let site_name = text(&site, "displayName");
        let drives = m365::graph_collection(
            &token,
            &format!(
                "{GRAPH}/sites/{}/drives?$select=id,name,webUrl&$top=50",
                encode_segment(&site_id)
            ),
        )
        .await
        .unwrap_or_default();
        for drive in drives {
            if let Some(source) = drive_source(&drive, "sharepoint", &site_name) {
                if seen.insert(source.id.clone()) {
                    sources.push(source);
                }
            }
        }
    }
    sources.sort_by(|left, right| {
        left.kind
            .cmp(&right.kind)
            .then_with(|| left.site_name.cmp(&right.site_name))
            .then_with(|| left.name.cmp(&right.name))
    });
    Ok(sources)
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

fn record_offline_file(
    app: &AppHandle,
    drive_id: &str,
    item_id: &str,
    e_tag: &str,
    local_path: &Path,
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
    let endpoint = match request.parent_id.filter(|value| !value.trim().is_empty()) {
        Some(parent) => format!(
            "{GRAPH}/drives/{}/items/{}/children",
            encode_segment(&request.drive_id),
            encode_segment(&parent)
        ),
        None => format!(
            "{GRAPH}/drives/{}/root/children",
            encode_segment(&request.drive_id)
        ),
    };
    let value = graph_write(
        &token,
        Method::POST,
        &endpoint,
        Some(json!({"name": name, "folder": {}, "@microsoft.graph.conflictBehavior": "fail"})),
    )
    .await?;
    item_from_value(value, &request.drive_id)
        .ok_or_else(|| "Der neue Ordner konnte nicht ausgewertet werden.".to_string())
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
    let response = reqwest::Client::new()
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
    let client = reqwest::Client::new();
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

#[tauri::command]
pub async fn download_document_item(
    app: AppHandle,
    drive_id: String,
    item_id: String,
    name: String,
    relative_path: Option<Vec<String>>,
    e_tag: Option<String>,
) -> Result<String, String> {
    ensure_local_file_can_be_replaced(&app, &drive_id, &item_id)?;
    let token = m365::refreshed_access_token(&app).await?;
    let url = format!(
        "{GRAPH}/drives/{}/items/{}/content",
        encode_segment(&drive_id),
        encode_segment(&item_id)
    );
    let response = reqwest::Client::new()
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
    )?;
    Ok(path.to_string_lossy().to_string())
}

#[tauri::command]
pub async fn upload_document_file(
    app: AppHandle,
    drive_id: String,
    parent_id: Option<String>,
    file_path: String,
) -> Result<DocumentItem, String> {
    let path = PathBuf::from(file_path);
    let metadata = fs::metadata(&path).map_err(|error| error.to_string())?;
    if !metadata.is_file() {
        return Err("Bitte wählen Sie eine Datei aus.".to_string());
    }
    let file_name = path
        .file_name()
        .and_then(|value| value.to_str())
        .map(safe_file_name)
        .ok_or_else(|| "Der Dateiname konnte nicht gelesen werden.".to_string())?;
    let parent = parent_id.filter(|value| !value.trim().is_empty());
    let token = m365::refreshed_access_token(&app).await?;
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
        graph_upload_bytes(&token, &endpoint, bytes).await?
    } else {
        upload_large_file(
            &token,
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
    let metadata_url = format!(
        "{GRAPH}/drives/{}/items/{}?$select=id,eTag",
        encode_segment(&drive_id),
        encode_segment(&item_id)
    );
    let remote = m365::graph_json(&token, &metadata_url).await?;
    let current_e_tag = text(&remote, "eTag");
    if !expected_e_tag.is_empty() && current_e_tag != expected_e_tag {
        return Err("Konflikt: Die Online-Datei wurde seit dem Offline-Download geändert. Laden Sie zuerst die aktuelle Version herunter oder öffnen Sie beide Versionen zum Vergleichen.".to_string());
    }

    let value = if metadata.len() <= SIMPLE_UPLOAD_LIMIT {
        let endpoint = format!(
            "{GRAPH}/drives/{}/items/{}/content",
            encode_segment(&drive_id),
            encode_segment(&item_id)
        );
        graph_upload_bytes(
            &token,
            &endpoint,
            fs::read(&path).map_err(|error| error.to_string())?,
        )
        .await?
    } else {
        let endpoint = format!(
            "{GRAPH}/drives/{}/items/{}/createUploadSession",
            encode_segment(&drive_id),
            encode_segment(&item_id)
        );
        let session = graph_write(
            &token,
            Method::POST,
            &endpoint,
            Some(json!({"item": {"@microsoft.graph.conflictBehavior": "replace"}})),
        )
        .await?;
        let upload_url = session
            .get("uploadUrl")
            .and_then(Value::as_str)
            .ok_or_else(|| "Microsoft 365 hat keine Upload-Adresse zurückgegeben.".to_string())?;
        upload_file_chunks(upload_url, &path, metadata.len()).await?
    };
    let item = item_from_value(value, &drive_id)
        .ok_or_else(|| "Die aktualisierte Datei konnte nicht ausgewertet werden.".to_string())?;
    record_offline_file(&app, &drive_id, &item_id, &item.e_tag, &path)?;
    Ok(item)
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
}
