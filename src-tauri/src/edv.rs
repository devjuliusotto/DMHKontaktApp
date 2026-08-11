use crate::{m365, open_db, AppState};
use chrono::Utc;
use reqwest::{Method, StatusCode};
use rusqlite::{params, OptionalExtension};
use serde::{de::DeserializeOwned, Deserialize, Deserializer, Serialize};
use serde_json::{json, Value};
use tauri::{AppHandle, State};
use uuid::Uuid;

const PLANNER_PLAN_SETTING: &str = "edv_planner_plan_id_v1";

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct EdvAccessProfile {
    level: String,
    can_manage_tickets: bool,
    can_manage_members: bool,
    can_manage_identities: bool,
    can_manage_systems: bool,
}

#[derive(Debug, Deserialize)]
struct GraphPage<T> {
    value: Vec<T>,
    #[serde(rename = "@odata.nextLink")]
    next_link: Option<String>,
}

#[derive(Debug, Deserialize)]
struct GraphErrorEnvelope {
    error: Option<GraphError>,
}

#[derive(Debug, Deserialize)]
struct GraphError {
    code: Option<String>,
    message: Option<String>,
}

fn deserialize_null_default<'de, D, T>(deserializer: D) -> Result<T, D::Error>
where
    D: Deserializer<'de>,
    T: Deserialize<'de> + Default,
{
    Ok(Option::<T>::deserialize(deserializer)?.unwrap_or_default())
}

#[derive(Debug, Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct EdvDirectoryUser {
    id: String,
    #[serde(default, deserialize_with = "deserialize_null_default")]
    display_name: String,
    #[serde(default, deserialize_with = "deserialize_null_default")]
    user_principal_name: String,
    #[serde(default, deserialize_with = "deserialize_null_default")]
    mail: String,
    account_enabled: Option<bool>,
    #[serde(default, deserialize_with = "deserialize_null_default")]
    job_title: String,
    #[serde(default, deserialize_with = "deserialize_null_default")]
    department: String,
    #[serde(default, deserialize_with = "deserialize_null_default")]
    mobile_phone: String,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct EdvDirectoryGroup {
    id: String,
    #[serde(default, deserialize_with = "deserialize_null_default")]
    display_name: String,
    #[serde(default, deserialize_with = "deserialize_null_default")]
    description: String,
    #[serde(default, deserialize_with = "deserialize_null_default")]
    mail: String,
    mail_enabled: Option<bool>,
    security_enabled: Option<bool>,
    #[serde(default, deserialize_with = "deserialize_null_default")]
    group_types: Vec<String>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CreateUserRequest {
    display_name: String,
    user_principal_name: String,
    initial_password: String,
    #[serde(default)]
    job_title: String,
    #[serde(default)]
    department: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct UpdateUserRequest {
    id: String,
    display_name: String,
    account_enabled: bool,
    #[serde(default)]
    job_title: String,
    #[serde(default)]
    department: String,
    #[serde(default)]
    mobile_phone: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CreateGroupRequest {
    display_name: String,
    #[serde(default)]
    description: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct UpdateGroupRequest {
    id: String,
    display_name: String,
    #[serde(default)]
    description: String,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct PlannerPlan {
    id: String,
    #[serde(default)]
    title: String,
    #[serde(default)]
    owner: String,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct PlannerBucket {
    id: String,
    #[serde(default)]
    name: String,
    #[serde(default)]
    plan_id: String,
    #[serde(default)]
    order_hint: String,
    #[serde(rename = "@odata.etag", default)]
    etag: String,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct PlannerTask {
    id: String,
    #[serde(default)]
    title: String,
    #[serde(default)]
    plan_id: String,
    #[serde(default)]
    bucket_id: String,
    #[serde(default)]
    order_hint: String,
    #[serde(default)]
    priority: i32,
    #[serde(default)]
    percent_complete: i32,
    start_date_time: Option<String>,
    due_date_time: Option<String>,
    #[serde(default)]
    assignments: Value,
    #[serde(rename = "@odata.etag", default)]
    etag: String,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct PlannerTaskDetails {
    id: String,
    #[serde(default, deserialize_with = "deserialize_null_default")]
    description: String,
    #[serde(default)]
    preview_type: String,
    #[serde(rename = "@odata.etag", default)]
    etag: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PlannerBoard {
    plan: PlannerPlan,
    buckets: Vec<PlannerBucket>,
    tasks: Vec<PlannerTask>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PlannerTaskInput {
    title: String,
    bucket_id: String,
    #[serde(default)]
    assignee_ids: Vec<String>,
    due_date_time: Option<String>,
    #[serde(default = "default_priority")]
    priority: i32,
}

fn default_priority() -> i32 {
    5
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PlannerTaskUpdate {
    id: String,
    etag: String,
    title: String,
    bucket_id: String,
    due_date_time: Option<String>,
    priority: i32,
    percent_complete: i32,
    #[serde(default)]
    assignee_ids: Vec<String>,
}

fn assignment_changes(current: &Value, desired_ids: &[String]) -> serde_json::Map<String, Value> {
    let desired = desired_ids
        .iter()
        .cloned()
        .collect::<std::collections::HashSet<_>>();
    let current_ids = current
        .as_object()
        .map(|assignments| {
            assignments
                .keys()
                .cloned()
                .collect::<std::collections::HashSet<_>>()
        })
        .unwrap_or_default();
    let mut changes = serde_json::Map::new();
    for removed in current_ids.difference(&desired) {
        changes.insert(removed.clone(), Value::Null);
    }
    for added in desired.difference(&current_ids) {
        changes.insert(
            added.clone(),
            json!({"@odata.type": "#microsoft.graph.plannerAssignment", "orderHint": " !"}),
        );
    }
    changes
}

#[derive(Debug, Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct EdvSystemRecord {
    id: String,
    name: String,
    category: String,
    owner: String,
    status: String,
    provider: String,
    url: String,
    notes: String,
    created_at: String,
    updated_at: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct EdvSystemInput {
    id: Option<String>,
    name: String,
    #[serde(default)]
    category: String,
    #[serde(default)]
    owner: String,
    #[serde(default)]
    status: String,
    #[serde(default)]
    provider: String,
    #[serde(default)]
    url: String,
    #[serde(default)]
    notes: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct EdvAuditEntry {
    id: i64,
    occurred_at: String,
    actor_name: String,
    actor_upn: String,
    action: String,
    target_type: String,
    target_id: String,
    target_name: String,
    details: String,
    result: String,
}

fn require_level(app: &AppHandle, state: &AppState, minimum: &str) -> Result<String, String> {
    let level = m365::edv_access_level(app, state)?;
    let allowed = match minimum {
        "reader" => true,
        "operator" => matches!(level, "operator" | "identity_admin"),
        "identity_admin" => level == "identity_admin",
        _ => false,
    };
    if !allowed {
        return Err("Ihre EDV-Rolle erlaubt diese Änderung nicht.".to_string());
    }
    Ok(level.to_string())
}

fn safe_id(value: &str, label: &str) -> Result<String, String> {
    let value = value.trim();
    if value.is_empty()
        || value.len() > 200
        || !value.chars().all(|character| {
            character.is_ascii_alphanumeric() || matches!(character, '-' | '_' | '.' | '~')
        })
    {
        return Err(format!("Ungültige {label}."));
    }
    Ok(value.to_string())
}

fn validate_text(value: &str, label: &str, max: usize) -> Result<String, String> {
    let value = value.trim();
    if value.is_empty() || value.chars().count() > max {
        return Err(format!("{label} fehlt oder ist zu lang."));
    }
    Ok(value.to_string())
}

async fn graph_response(
    token: &str,
    method: Method,
    url: &str,
    body: Option<Value>,
    etag: Option<&str>,
) -> Result<reqwest::Response, String> {
    if !url.starts_with("https://graph.microsoft.com/v1.0/") {
        return Err("Unsichere Microsoft-Graph-Adresse wurde abgelehnt.".to_string());
    }
    let client = reqwest::Client::new();
    let mut request = client.request(method, url).bearer_auth(token);
    if let Some(body) = body {
        request = request.json(&body);
    }
    if let Some(etag) = etag {
        request = request.header("If-Match", etag);
    }
    let response = request
        .send()
        .await
        .map_err(|_| "Microsoft Graph ist derzeit nicht erreichbar.".to_string())?;
    if response.status().is_success() {
        return Ok(response);
    }
    let status = response.status();
    let payload = response.json::<GraphErrorEnvelope>().await.ok();
    let message = payload
        .and_then(|value| value.error)
        .and_then(|value| value.message.or(value.code))
        .unwrap_or_else(|| "Microsoft hat die Anfrage abgelehnt.".to_string());
    let hint = match status {
        StatusCode::FORBIDDEN => " Prüfen Sie Entra-Rolle und API-Berechtigungen.",
        StatusCode::PRECONDITION_FAILED => {
            " Der Datensatz wurde zwischenzeitlich geändert; bitte neu laden."
        }
        _ => "",
    };
    Err(format!(
        "Microsoft Graph (HTTP {}): {}{}",
        status.as_u16(),
        message,
        hint
    ))
}

async fn graph_json<T: DeserializeOwned>(token: &str, url: &str) -> Result<T, String> {
    graph_response(token, Method::GET, url, None, None)
        .await?
        .json::<T>()
        .await
        .map_err(|error| format!("Microsoft Graph hat ungültige Daten geliefert: {error}"))
}

async fn graph_pages<T: DeserializeOwned>(
    token: &str,
    first_url: String,
) -> Result<Vec<T>, String> {
    let mut next = Some(first_url);
    let mut values = Vec::new();
    while let Some(url) = next.take() {
        let page: GraphPage<T> = graph_json(token, &url).await?;
        values.extend(page.value);
        next = page
            .next_link
            .filter(|url| url.starts_with("https://graph.microsoft.com/v1.0/"));
    }
    Ok(values)
}

fn audit(
    app: &AppHandle,
    state: &AppState,
    action: &str,
    target_type: &str,
    target_id: &str,
    target_name: &str,
    details: &str,
    result: &str,
) -> Result<(), String> {
    let (_, actor_name, actor_upn) = m365::edv_actor(app, state)?;
    open_db(app)?
        .execute(
            "INSERT INTO edv_audit_log
             (occurred_at, actor_name, actor_upn, action, target_type, target_id, target_name, details, result)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)",
            params![Utc::now().to_rfc3339(), actor_name, actor_upn, action, target_type, target_id, target_name, details, result],
        )
        .map_err(|error| error.to_string())?;
    Ok(())
}

#[tauri::command]
pub fn get_edv_access_profile(
    app: AppHandle,
    state: State<'_, AppState>,
) -> Result<EdvAccessProfile, String> {
    let level = require_level(&app, &state, "reader")?;
    Ok(EdvAccessProfile {
        can_manage_tickets: matches!(level.as_str(), "operator" | "identity_admin"),
        can_manage_members: level == "identity_admin",
        can_manage_identities: level == "identity_admin",
        can_manage_systems: matches!(level.as_str(), "operator" | "identity_admin"),
        level,
    })
}

#[tauri::command]
pub fn get_edv_planner_plan_id(app: AppHandle) -> Result<String, String> {
    Ok(open_db(&app)?
        .query_row(
            "SELECT value FROM app_settings WHERE key = ?1",
            [PLANNER_PLAN_SETTING],
            |row| row.get(0),
        )
        .optional()
        .map_err(|error| error.to_string())?
        .unwrap_or_default())
}

#[tauri::command]
pub fn set_edv_planner_plan_id(
    app: AppHandle,
    state: State<'_, AppState>,
    plan_id: String,
) -> Result<(), String> {
    require_level(&app, &state, "operator")?;
    let plan_id = safe_id(&plan_id, "Planner-Plan-ID")?;
    open_db(&app)?
        .execute(
            "INSERT INTO app_settings (key, value, updated_at) VALUES (?1, ?2, ?3)
         ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at",
            params![PLANNER_PLAN_SETTING, plan_id, Utc::now().to_rfc3339()],
        )
        .map_err(|error| error.to_string())?;
    Ok(())
}

#[tauri::command]
pub async fn load_planner_board(
    app: AppHandle,
    state: State<'_, AppState>,
    plan_id: String,
) -> Result<PlannerBoard, String> {
    require_level(&app, &state, "reader")?;
    let plan_id = safe_id(&plan_id, "Planner-Plan-ID")?;
    let token = m365::acquire_edv_graph_access_token(&app, &state).await?;
    let plan: PlannerPlan = graph_json(
        &token,
        &format!("https://graph.microsoft.com/v1.0/planner/plans/{plan_id}"),
    )
    .await?;
    let mut buckets: Vec<PlannerBucket> = graph_pages(
        &token,
        format!("https://graph.microsoft.com/v1.0/planner/plans/{plan_id}/buckets"),
    )
    .await?;
    let tasks: Vec<PlannerTask> = graph_pages(
        &token,
        format!("https://graph.microsoft.com/v1.0/planner/plans/{plan_id}/tasks"),
    )
    .await?;
    buckets.sort_by(|left, right| left.order_hint.cmp(&right.order_hint));
    Ok(PlannerBoard {
        plan,
        buckets,
        tasks,
    })
}

#[tauri::command]
pub async fn create_planner_task(
    app: AppHandle,
    state: State<'_, AppState>,
    plan_id: String,
    input: PlannerTaskInput,
) -> Result<PlannerTask, String> {
    require_level(&app, &state, "operator")?;
    let plan_id = safe_id(&plan_id, "Planner-Plan-ID")?;
    let bucket_id = safe_id(&input.bucket_id, "Planner-Spalten-ID")?;
    let title = validate_text(&input.title, "Titel", 250)?;
    let assignments = input
        .assignee_ids
        .into_iter()
        .filter_map(|id| safe_id(&id, "Benutzer-ID").ok())
        .map(|id| {
            (
                id,
                json!({"@odata.type": "#microsoft.graph.plannerAssignment", "orderHint": " !"}),
            )
        })
        .collect::<serde_json::Map<_, _>>();
    let token = m365::acquire_edv_graph_access_token(&app, &state).await?;
    let task = graph_response(
        &token,
        Method::POST,
        "https://graph.microsoft.com/v1.0/planner/tasks",
        Some(json!({
            "planId": plan_id,
            "bucketId": bucket_id,
            "title": title,
            "priority": input.priority.clamp(0, 10),
            "dueDateTime": input.due_date_time,
            "assignments": assignments
        })),
        None,
    )
    .await?
    .json::<PlannerTask>()
    .await
    .map_err(|_| "Planner hat eine ungültige Aufgabe geliefert.".to_string())?;
    audit(
        &app,
        &state,
        "create",
        "planner_task",
        &task.id,
        &task.title,
        "Ticket erstellt",
        "success",
    )?;
    Ok(task)
}

#[tauri::command]
pub async fn update_planner_task(
    app: AppHandle,
    state: State<'_, AppState>,
    input: PlannerTaskUpdate,
) -> Result<(), String> {
    require_level(&app, &state, "operator")?;
    let id = safe_id(&input.id, "Planner-Ticket-ID")?;
    let bucket_id = safe_id(&input.bucket_id, "Planner-Spalten-ID")?;
    let title = validate_text(&input.title, "Titel", 250)?;
    if input.etag.trim().is_empty() {
        return Err("Die Ticket-Version fehlt; bitte neu laden.".to_string());
    }
    let token = m365::acquire_edv_graph_access_token(&app, &state).await?;
    let current: PlannerTask = graph_json(
        &token,
        &format!("https://graph.microsoft.com/v1.0/planner/tasks/{id}"),
    )
    .await?;
    let assignee_ids = input
        .assignee_ids
        .iter()
        .map(|value| safe_id(value, "Benutzer-ID"))
        .collect::<Result<Vec<_>, _>>()?;
    let assignments = assignment_changes(&current.assignments, &assignee_ids);
    let mut body = json!({
        "title": title,
        "bucketId": bucket_id,
        "dueDateTime": input.due_date_time,
        "priority": input.priority.clamp(0, 10),
        "percentComplete": input.percent_complete.clamp(0, 100)
    });
    if !assignments.is_empty() {
        body.as_object_mut()
            .expect("planner update body must be an object")
            .insert("assignments".to_string(), Value::Object(assignments));
    }
    graph_response(
        &token,
        Method::PATCH,
        &format!("https://graph.microsoft.com/v1.0/planner/tasks/{id}"),
        Some(body),
        Some(input.etag.trim()),
    )
    .await?;
    audit(
        &app,
        &state,
        "update",
        "planner_task",
        &id,
        &title,
        "Ticket bearbeitet oder verschoben",
        "success",
    )?;
    Ok(())
}

#[tauri::command]
pub async fn get_planner_task_details(
    app: AppHandle,
    state: State<'_, AppState>,
    task_id: String,
) -> Result<PlannerTaskDetails, String> {
    require_level(&app, &state, "reader")?;
    let task_id = safe_id(&task_id, "Planner-Ticket-ID")?;
    let token = m365::acquire_edv_graph_access_token(&app, &state).await?;
    graph_json(
        &token,
        &format!("https://graph.microsoft.com/v1.0/planner/tasks/{task_id}/details"),
    )
    .await
}

#[tauri::command]
pub async fn update_planner_task_details(
    app: AppHandle,
    state: State<'_, AppState>,
    task_id: String,
    etag: String,
    description: String,
) -> Result<(), String> {
    require_level(&app, &state, "operator")?;
    let task_id = safe_id(&task_id, "Planner-Ticket-ID")?;
    if etag.trim().is_empty() {
        return Err("Die Version der Ticket-Notizen fehlt; bitte neu laden.".to_string());
    }
    if description.chars().count() > 4000 {
        return Err("Die Ticket-Notizen dürfen höchstens 4.000 Zeichen enthalten.".to_string());
    }
    let token = m365::acquire_edv_graph_access_token(&app, &state).await?;
    graph_response(
        &token,
        Method::PATCH,
        &format!("https://graph.microsoft.com/v1.0/planner/tasks/{task_id}/details"),
        Some(json!({"description": description, "previewType": "description"})),
        Some(etag.trim()),
    )
    .await?;
    Ok(())
}

#[tauri::command]
pub async fn create_planner_bucket(
    app: AppHandle,
    state: State<'_, AppState>,
    plan_id: String,
    name: String,
) -> Result<PlannerBucket, String> {
    require_level(&app, &state, "operator")?;
    let plan_id = safe_id(&plan_id, "Planner-Plan-ID")?;
    let name = validate_text(&name, "Spaltenname", 120)?;
    let token = m365::acquire_edv_graph_access_token(&app, &state).await?;
    let bucket = graph_response(
        &token,
        Method::POST,
        "https://graph.microsoft.com/v1.0/planner/buckets",
        Some(json!({"name": name, "planId": plan_id, "orderHint": " !"})),
        None,
    )
    .await?
    .json::<PlannerBucket>()
    .await
    .map_err(|error| format!("Planner hat eine ungültige Spalte geliefert: {error}"))?;
    audit(
        &app,
        &state,
        "create",
        "planner_bucket",
        &bucket.id,
        &bucket.name,
        "Ticket-Spalte erstellt",
        "success",
    )?;
    Ok(bucket)
}

#[tauri::command]
pub async fn update_planner_bucket(
    app: AppHandle,
    state: State<'_, AppState>,
    bucket_id: String,
    etag: String,
    name: String,
) -> Result<(), String> {
    require_level(&app, &state, "operator")?;
    let bucket_id = safe_id(&bucket_id, "Planner-Spalten-ID")?;
    let name = validate_text(&name, "Spaltenname", 120)?;
    if etag.trim().is_empty() {
        return Err("Die Spalten-Version fehlt; bitte neu laden.".to_string());
    }
    let token = m365::acquire_edv_graph_access_token(&app, &state).await?;
    graph_response(
        &token,
        Method::PATCH,
        &format!("https://graph.microsoft.com/v1.0/planner/buckets/{bucket_id}"),
        Some(json!({"name": name})),
        Some(etag.trim()),
    )
    .await?;
    audit(
        &app,
        &state,
        "update",
        "planner_bucket",
        &bucket_id,
        &name,
        "Ticket-Spalte umbenannt",
        "success",
    )?;
    Ok(())
}

#[tauri::command]
pub async fn delete_planner_task(
    app: AppHandle,
    state: State<'_, AppState>,
    id: String,
    etag: String,
    title: String,
) -> Result<(), String> {
    require_level(&app, &state, "operator")?;
    let id = safe_id(&id, "Planner-Ticket-ID")?;
    if etag.trim().is_empty() {
        return Err("Die Ticket-Version fehlt; bitte neu laden.".to_string());
    }
    let token = m365::acquire_edv_graph_access_token(&app, &state).await?;
    graph_response(
        &token,
        Method::DELETE,
        &format!("https://graph.microsoft.com/v1.0/planner/tasks/{id}"),
        None,
        Some(etag.trim()),
    )
    .await?;
    audit(
        &app,
        &state,
        "delete",
        "planner_task",
        &id,
        &title,
        "Ticket gelöscht",
        "success",
    )?;
    Ok(())
}

#[tauri::command]
pub async fn list_directory_users(
    app: AppHandle,
    state: State<'_, AppState>,
) -> Result<Vec<EdvDirectoryUser>, String> {
    require_level(&app, &state, "reader")?;
    let token = m365::acquire_edv_graph_access_token(&app, &state).await?;
    let mut users: Vec<EdvDirectoryUser> = graph_pages(&token, "https://graph.microsoft.com/v1.0/users?$select=id,displayName,userPrincipalName,mail,accountEnabled,jobTitle,department,mobilePhone&$top=100".to_string()).await?;
    users.sort_by(|left, right| {
        left.display_name
            .to_lowercase()
            .cmp(&right.display_name.to_lowercase())
    });
    Ok(users)
}

#[tauri::command]
pub async fn list_directory_groups(
    app: AppHandle,
    state: State<'_, AppState>,
) -> Result<Vec<EdvDirectoryGroup>, String> {
    require_level(&app, &state, "reader")?;
    let token = m365::acquire_edv_graph_access_token(&app, &state).await?;
    let mut groups: Vec<EdvDirectoryGroup> = graph_pages(&token, "https://graph.microsoft.com/v1.0/groups?$select=id,displayName,description,mail,mailEnabled,securityEnabled,groupTypes&$top=100".to_string()).await?;
    groups.sort_by(|left, right| {
        left.display_name
            .to_lowercase()
            .cmp(&right.display_name.to_lowercase())
    });
    Ok(groups)
}

#[tauri::command]
pub async fn list_group_members(
    app: AppHandle,
    state: State<'_, AppState>,
    group_id: String,
) -> Result<Vec<EdvDirectoryUser>, String> {
    require_level(&app, &state, "reader")?;
    let group_id = safe_id(&group_id, "Gruppen-ID")?;
    let token = m365::acquire_edv_graph_access_token(&app, &state).await?;
    graph_pages(&token, format!("https://graph.microsoft.com/v1.0/groups/{group_id}/members/microsoft.graph.user?$select=id,displayName,userPrincipalName,mail,accountEnabled,jobTitle,department,mobilePhone&$top=100")).await
}

#[tauri::command]
pub async fn add_group_member(
    app: AppHandle,
    state: State<'_, AppState>,
    group_id: String,
    user_id: String,
    user_name: String,
) -> Result<(), String> {
    require_level(&app, &state, "identity_admin")?;
    let group_id = safe_id(&group_id, "Gruppen-ID")?;
    let user_id = safe_id(&user_id, "Benutzer-ID")?;
    let token = m365::acquire_edv_graph_access_token(&app, &state).await?;
    graph_response(&token, Method::POST, &format!("https://graph.microsoft.com/v1.0/groups/{group_id}/members/$ref"), Some(json!({"@odata.id": format!("https://graph.microsoft.com/v1.0/directoryObjects/{user_id}")})), None).await?;
    audit(
        &app,
        &state,
        "add_member",
        "group",
        &group_id,
        &user_name,
        "Benutzer zur Gruppe hinzugefügt",
        "success",
    )?;
    Ok(())
}

#[tauri::command]
pub async fn remove_group_member(
    app: AppHandle,
    state: State<'_, AppState>,
    group_id: String,
    user_id: String,
    user_name: String,
) -> Result<(), String> {
    require_level(&app, &state, "identity_admin")?;
    let group_id = safe_id(&group_id, "Gruppen-ID")?;
    let user_id = safe_id(&user_id, "Benutzer-ID")?;
    let token = m365::acquire_edv_graph_access_token(&app, &state).await?;
    graph_response(
        &token,
        Method::DELETE,
        &format!("https://graph.microsoft.com/v1.0/groups/{group_id}/members/{user_id}/$ref"),
        None,
        None,
    )
    .await?;
    audit(
        &app,
        &state,
        "remove_member",
        "group",
        &group_id,
        &user_name,
        "Benutzer aus Gruppe entfernt",
        "success",
    )?;
    Ok(())
}

#[tauri::command]
pub async fn create_directory_user(
    app: AppHandle,
    state: State<'_, AppState>,
    input: CreateUserRequest,
) -> Result<EdvDirectoryUser, String> {
    require_level(&app, &state, "identity_admin")?;
    let display_name = validate_text(&input.display_name, "Anzeigename", 120)?;
    let upn = validate_text(&input.user_principal_name, "Benutzername", 200)?;
    if !upn.contains('@') || input.initial_password.chars().count() < 8 {
        return Err("Benutzername oder temporäres Kennwort ist ungültig.".to_string());
    }
    let mail_nickname = upn.split('@').next().unwrap_or("user");
    let token = m365::acquire_edv_graph_access_token(&app, &state).await?;
    let user = graph_response(&token, Method::POST, "https://graph.microsoft.com/v1.0/users", Some(json!({
        "accountEnabled": true,
        "displayName": display_name,
        "mailNickname": mail_nickname,
        "userPrincipalName": upn,
        "jobTitle": input.job_title,
        "department": input.department,
        "passwordProfile": {"forceChangePasswordNextSignIn": true, "password": input.initial_password}
    })), None).await?.json::<EdvDirectoryUser>().await.map_err(|_| "Microsoft hat ein ungültiges Benutzerprofil geliefert.".to_string())?;
    audit(
        &app,
        &state,
        "create",
        "user",
        &user.id,
        &user.display_name,
        "Benutzer erstellt; Kennwort nicht protokolliert",
        "success",
    )?;
    Ok(user)
}

#[tauri::command]
pub async fn update_directory_user(
    app: AppHandle,
    state: State<'_, AppState>,
    input: UpdateUserRequest,
) -> Result<(), String> {
    require_level(&app, &state, "identity_admin")?;
    let id = safe_id(&input.id, "Benutzer-ID")?;
    let display_name = validate_text(&input.display_name, "Anzeigename", 120)?;
    let token = m365::acquire_edv_graph_access_token(&app, &state).await?;
    graph_response(
        &token,
        Method::PATCH,
        &format!("https://graph.microsoft.com/v1.0/users/{id}"),
        Some(json!({
            "displayName": display_name,
            "accountEnabled": input.account_enabled,
            "jobTitle": input.job_title,
            "department": input.department,
            "mobilePhone": input.mobile_phone
        })),
        None,
    )
    .await?;
    audit(
        &app,
        &state,
        "update",
        "user",
        &id,
        &display_name,
        "Benutzerprofil oder Kontostatus geändert",
        "success",
    )?;
    Ok(())
}

#[tauri::command]
pub async fn reset_directory_user_password(
    app: AppHandle,
    state: State<'_, AppState>,
    user_id: String,
    user_name: String,
    temporary_password: String,
) -> Result<(), String> {
    require_level(&app, &state, "identity_admin")?;
    let user_id = safe_id(&user_id, "Benutzer-ID")?;
    if temporary_password.chars().count() < 8 {
        return Err("Das temporäre Kennwort ist zu kurz.".to_string());
    }
    let token = m365::acquire_edv_graph_access_token(&app, &state).await?;
    graph_response(&token, Method::PATCH, &format!("https://graph.microsoft.com/v1.0/users/{user_id}"), Some(json!({"passwordProfile": {"forceChangePasswordNextSignIn": true, "password": temporary_password}})), None).await?;
    audit(
        &app,
        &state,
        "reset_password",
        "user",
        &user_id,
        &user_name,
        "Temporäres Kennwort gesetzt; Kennwort nicht protokolliert",
        "success",
    )?;
    Ok(())
}

#[tauri::command]
pub async fn create_directory_group(
    app: AppHandle,
    state: State<'_, AppState>,
    input: CreateGroupRequest,
) -> Result<EdvDirectoryGroup, String> {
    require_level(&app, &state, "identity_admin")?;
    let display_name = validate_text(&input.display_name, "Gruppenname", 120)?;
    let nickname = format!("dmh-{}", Uuid::new_v4().simple());
    let token = m365::acquire_edv_graph_access_token(&app, &state).await?;
    let group = graph_response(
        &token,
        Method::POST,
        "https://graph.microsoft.com/v1.0/groups",
        Some(json!({
            "displayName": display_name,
            "description": input.description,
            "mailEnabled": false,
            "mailNickname": nickname,
            "securityEnabled": true
        })),
        None,
    )
    .await?
    .json::<EdvDirectoryGroup>()
    .await
    .map_err(|_| "Microsoft hat eine ungültige Gruppe geliefert.".to_string())?;
    audit(
        &app,
        &state,
        "create",
        "group",
        &group.id,
        &group.display_name,
        "Sicherheitsgruppe erstellt",
        "success",
    )?;
    Ok(group)
}

#[tauri::command]
pub async fn update_directory_group(
    app: AppHandle,
    state: State<'_, AppState>,
    input: UpdateGroupRequest,
) -> Result<(), String> {
    require_level(&app, &state, "identity_admin")?;
    let id = safe_id(&input.id, "Gruppen-ID")?;
    let display_name = validate_text(&input.display_name, "Gruppenname", 120)?;
    let token = m365::acquire_edv_graph_access_token(&app, &state).await?;
    graph_response(
        &token,
        Method::PATCH,
        &format!("https://graph.microsoft.com/v1.0/groups/{id}"),
        Some(json!({"displayName": display_name, "description": input.description})),
        None,
    )
    .await?;
    audit(
        &app,
        &state,
        "update",
        "group",
        &id,
        &display_name,
        "Gruppe bearbeitet",
        "success",
    )?;
    Ok(())
}

#[tauri::command]
pub async fn delete_directory_group(
    app: AppHandle,
    state: State<'_, AppState>,
    group_id: String,
    group_name: String,
) -> Result<(), String> {
    require_level(&app, &state, "identity_admin")?;
    let group_id = safe_id(&group_id, "Gruppen-ID")?;
    let token = m365::acquire_edv_graph_access_token(&app, &state).await?;
    graph_response(
        &token,
        Method::DELETE,
        &format!("https://graph.microsoft.com/v1.0/groups/{group_id}"),
        None,
        None,
    )
    .await?;
    audit(
        &app,
        &state,
        "delete",
        "group",
        &group_id,
        &group_name,
        "Gruppe gelöscht",
        "success",
    )?;
    Ok(())
}

#[tauri::command]
pub fn list_edv_systems(
    app: AppHandle,
    state: State<'_, AppState>,
) -> Result<Vec<EdvSystemRecord>, String> {
    require_level(&app, &state, "reader")?;
    let conn = open_db(&app)?;
    let mut stmt = conn.prepare("SELECT id, name, category, owner, status, provider, url, notes, created_at, updated_at FROM edv_systems ORDER BY name COLLATE NOCASE").map_err(|error| error.to_string())?;
    let rows = stmt
        .query_map([], |row| {
            Ok(EdvSystemRecord {
                id: row.get(0)?,
                name: row.get(1)?,
                category: row.get(2)?,
                owner: row.get(3)?,
                status: row.get(4)?,
                provider: row.get(5)?,
                url: row.get(6)?,
                notes: row.get(7)?,
                created_at: row.get(8)?,
                updated_at: row.get(9)?,
            })
        })
        .map_err(|error| error.to_string())?;
    rows.collect::<Result<Vec<_>, _>>()
        .map_err(|error| error.to_string())
}

#[tauri::command]
pub fn save_edv_system(
    app: AppHandle,
    state: State<'_, AppState>,
    input: EdvSystemInput,
) -> Result<EdvSystemRecord, String> {
    require_level(&app, &state, "operator")?;
    let name = validate_text(&input.name, "Systemname", 160)?;
    let timestamp = Utc::now().to_rfc3339();
    let id = input.id.unwrap_or_else(|| Uuid::new_v4().to_string());
    safe_id(&id, "System-ID")?;
    let conn = open_db(&app)?;
    let created_at: String = conn
        .query_row(
            "SELECT created_at FROM edv_systems WHERE id = ?1",
            [&id],
            |row| row.get(0),
        )
        .optional()
        .map_err(|error| error.to_string())?
        .unwrap_or_else(|| timestamp.clone());
    conn.execute("INSERT INTO edv_systems (id, name, category, owner, status, provider, url, notes, created_at, updated_at) VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10) ON CONFLICT(id) DO UPDATE SET name=excluded.name, category=excluded.category, owner=excluded.owner, status=excluded.status, provider=excluded.provider, url=excluded.url, notes=excluded.notes, updated_at=excluded.updated_at", params![id, name, input.category, input.owner, input.status, input.provider, input.url, input.notes, created_at, timestamp]).map_err(|error| error.to_string())?;
    audit(
        &app,
        &state,
        "save",
        "system",
        &id,
        &name,
        "Systeminventar geändert",
        "success",
    )?;
    Ok(EdvSystemRecord {
        id,
        name,
        category: input.category,
        owner: input.owner,
        status: input.status,
        provider: input.provider,
        url: input.url,
        notes: input.notes,
        created_at,
        updated_at: timestamp,
    })
}

#[tauri::command]
pub fn delete_edv_system(
    app: AppHandle,
    state: State<'_, AppState>,
    id: String,
    name: String,
) -> Result<(), String> {
    require_level(&app, &state, "operator")?;
    let id = safe_id(&id, "System-ID")?;
    open_db(&app)?
        .execute("DELETE FROM edv_systems WHERE id = ?1", [&id])
        .map_err(|error| error.to_string())?;
    audit(
        &app,
        &state,
        "delete",
        "system",
        &id,
        &name,
        "System aus Inventar gelöscht",
        "success",
    )?;
    Ok(())
}

#[tauri::command]
pub fn list_edv_audit_log(
    app: AppHandle,
    state: State<'_, AppState>,
) -> Result<Vec<EdvAuditEntry>, String> {
    require_level(&app, &state, "reader")?;
    let conn = open_db(&app)?;
    let mut stmt = conn.prepare("SELECT id, occurred_at, actor_name, actor_upn, action, target_type, target_id, target_name, details, result FROM edv_audit_log ORDER BY id DESC LIMIT 500").map_err(|error| error.to_string())?;
    let rows = stmt
        .query_map([], |row| {
            Ok(EdvAuditEntry {
                id: row.get(0)?,
                occurred_at: row.get(1)?,
                actor_name: row.get(2)?,
                actor_upn: row.get(3)?,
                action: row.get(4)?,
                target_type: row.get(5)?,
                target_id: row.get(6)?,
                target_name: row.get(7)?,
                details: row.get(8)?,
                result: row.get(9)?,
            })
        })
        .map_err(|error| error.to_string())?;
    rows.collect::<Result<Vec<_>, _>>()
        .map_err(|error| error.to_string())
}

#[cfg(test)]
mod tests {
    use super::{assignment_changes, EdvDirectoryGroup, EdvDirectoryUser, GraphPage};
    use serde_json::json;

    #[test]
    fn directory_users_accept_null_optional_graph_fields() {
        let page: GraphPage<EdvDirectoryUser> = serde_json::from_str(
            r#"{
                "value": [{
                    "id": "11111111-1111-1111-1111-111111111111",
                    "displayName": "Test User",
                    "userPrincipalName": "test@dmh-aidlingen.de",
                    "mail": null,
                    "accountEnabled": true,
                    "jobTitle": null,
                    "department": null,
                    "mobilePhone": null
                }]
            }"#,
        )
        .expect("Microsoft Graph user payload with null fields must be accepted");

        let user = &page.value[0];
        assert_eq!(user.display_name, "Test User");
        assert!(user.mail.is_empty());
        assert!(user.job_title.is_empty());
        assert!(user.department.is_empty());
        assert!(user.mobile_phone.is_empty());
    }

    #[test]
    fn directory_groups_accept_null_optional_graph_fields() {
        let page: GraphPage<EdvDirectoryGroup> = serde_json::from_str(
            r#"{
                "value": [{
                    "id": "22222222-2222-2222-2222-222222222222",
                    "displayName": "DMH Portal - EDV",
                    "description": null,
                    "mail": null,
                    "mailEnabled": false,
                    "securityEnabled": true,
                    "groupTypes": null
                }]
            }"#,
        )
        .expect("Microsoft Graph group payload with null fields must be accepted");

        let group = &page.value[0];
        assert_eq!(group.display_name, "DMH Portal - EDV");
        assert!(group.description.is_empty());
        assert!(group.mail.is_empty());
        assert!(group.group_types.is_empty());
    }

    #[test]
    fn planner_assignment_changes_add_and_remove_only_differences() {
        let current = json!({
            "11111111-1111-1111-1111-111111111111": {"orderHint": "A"},
            "22222222-2222-2222-2222-222222222222": {"orderHint": "B"}
        });
        let changes = assignment_changes(
            &current,
            &[
                "22222222-2222-2222-2222-222222222222".to_string(),
                "33333333-3333-3333-3333-333333333333".to_string(),
            ],
        );

        assert_eq!(
            changes.get("11111111-1111-1111-1111-111111111111"),
            Some(&serde_json::Value::Null)
        );
        assert!(changes.contains_key("33333333-3333-3333-3333-333333333333"));
        assert!(!changes.contains_key("22222222-2222-2222-2222-222222222222"));
    }
}
