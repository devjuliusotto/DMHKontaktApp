use crate::{m365, now, open_db, url_encode_component, AppState, CalendarRecurrence};
use chrono::{DateTime, Utc};
use reqwest::{Client, Method, StatusCode};
use rusqlite::{params, Connection};
use serde::{de::DeserializeOwned, Deserialize, Serialize};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::collections::{HashMap, HashSet};
use tauri::{AppHandle, State};
use uuid::Uuid;
use zeroize::Zeroize;

const GRAPH_ROOT: &str = "https://graph.microsoft.com/v1.0";
const GRAPH_PREFER: &str =
    "IdType=\"ImmutableId\", outlook.timezone=\"W. Europe Standard Time\", outlook.body-content-type=\"text\"";

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ExchangeCalendarEvent {
    pub id: String,
    pub title: String,
    pub starts_at: String,
    pub ends_at: String,
    pub location: String,
    pub description: String,
    #[serde(default = "default_calendar_color")]
    pub color: String,
    #[serde(default)]
    pub category: String,
    #[serde(default)]
    pub source: String,
    #[serde(default)]
    pub recurrence: Option<CalendarRecurrence>,
    #[serde(default)]
    pub excluded_dates: Vec<String>,
    #[serde(default)]
    pub deleted_at: Option<String>,
    #[serde(default)]
    pub updated_at: String,
    #[serde(default)]
    pub exchange_id: Option<String>,
    #[serde(default)]
    pub exchange_change_key: Option<String>,
    #[serde(default)]
    pub exchange_last_synced_hash: Option<String>,
    #[serde(default)]
    pub exchange_is_online_meeting: bool,
    #[serde(default)]
    pub exchange_is_all_day: bool,
}

fn default_calendar_color() -> String {
    "blue".to_string()
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ExchangeSyncRequest {
    #[serde(default)]
    calendar_events: Vec<ExchangeCalendarEvent>,
    #[serde(default)]
    deleted_calendar_events: Vec<ExchangeCalendarEvent>,
}

#[derive(Debug, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ExchangeEntitySyncSummary {
    uploaded: usize,
    downloaded: usize,
    updated: usize,
    deleted: usize,
    conflicts: usize,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ExchangeSyncResult {
    contacts: ExchangeEntitySyncSummary,
    calendar: ExchangeEntitySyncSummary,
    calendar_events: Vec<ExchangeCalendarEvent>,
    deleted_calendar_events: Vec<ExchangeCalendarEvent>,
    synced_at: String,
}

#[derive(Debug, Deserialize)]
struct GraphPage<T> {
    value: Vec<T>,
    #[serde(rename = "@odata.nextLink")]
    next_link: Option<String>,
}

fn deserialize_default_on_null<'de, D, T>(deserializer: D) -> Result<T, D::Error>
where
    D: serde::Deserializer<'de>,
    T: Deserialize<'de> + Default,
{
    Option::<T>::deserialize(deserializer).map(Option::unwrap_or_default)
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
struct GraphEmailAddress {
    #[serde(default, deserialize_with = "deserialize_default_on_null")]
    address: String,
}

#[derive(Debug, Clone, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
struct GraphPhysicalAddress {
    #[serde(default, deserialize_with = "deserialize_default_on_null")]
    street: String,
    #[serde(default, deserialize_with = "deserialize_default_on_null")]
    postal_code: String,
    #[serde(default, deserialize_with = "deserialize_default_on_null")]
    city: String,
    #[serde(default, deserialize_with = "deserialize_default_on_null")]
    country_or_region: String,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
struct GraphContact {
    id: String,
    #[serde(default, deserialize_with = "deserialize_default_on_null")]
    change_key: String,
    #[serde(default, deserialize_with = "deserialize_default_on_null")]
    last_modified_date_time: String,
    #[serde(default, deserialize_with = "deserialize_default_on_null")]
    given_name: String,
    #[serde(default, deserialize_with = "deserialize_default_on_null")]
    surname: String,
    #[serde(default, deserialize_with = "deserialize_default_on_null")]
    display_name: String,
    #[serde(default, deserialize_with = "deserialize_default_on_null")]
    email_addresses: Vec<GraphEmailAddress>,
    #[serde(default, deserialize_with = "deserialize_default_on_null")]
    business_phones: Vec<String>,
    #[serde(default, deserialize_with = "deserialize_default_on_null")]
    home_phones: Vec<String>,
    #[serde(default, deserialize_with = "deserialize_default_on_null")]
    mobile_phone: String,
    #[serde(default, deserialize_with = "deserialize_default_on_null")]
    home_address: GraphPhysicalAddress,
    #[serde(default, deserialize_with = "deserialize_default_on_null")]
    company_name: String,
    #[serde(default, deserialize_with = "deserialize_default_on_null")]
    personal_notes: String,
    #[serde(default, deserialize_with = "deserialize_default_on_null")]
    categories: Vec<String>,
}

#[derive(Debug, Clone)]
struct LocalContact {
    id: i64,
    first_name: String,
    last_name: String,
    display_name: String,
    email: String,
    phone: String,
    mobile_phone: String,
    street: String,
    postal_code: String,
    city: String,
    country: String,
    short_info: String,
    notes: String,
    groups: Vec<String>,
    updated_at: String,
    deleted_at: Option<String>,
    exchange_id: Option<String>,
    exchange_change_key: Option<String>,
    exchange_last_synced_hash: Option<String>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
struct GraphDateTime {
    #[serde(default, deserialize_with = "deserialize_default_on_null")]
    date_time: String,
}

#[derive(Debug, Clone, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
struct GraphLocation {
    #[serde(default, deserialize_with = "deserialize_default_on_null")]
    display_name: String,
}

#[derive(Debug, Clone, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
struct GraphBody {
    #[serde(default, deserialize_with = "deserialize_default_on_null")]
    content: String,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
struct GraphEvent {
    id: String,
    #[serde(default, deserialize_with = "deserialize_default_on_null")]
    change_key: String,
    #[serde(default, deserialize_with = "deserialize_default_on_null")]
    last_modified_date_time: String,
    #[serde(default, deserialize_with = "deserialize_default_on_null")]
    subject: String,
    start: GraphDateTime,
    end: GraphDateTime,
    #[serde(default, deserialize_with = "deserialize_default_on_null")]
    location: GraphLocation,
    #[serde(default, deserialize_with = "deserialize_default_on_null")]
    body: GraphBody,
    #[serde(default, deserialize_with = "deserialize_default_on_null")]
    categories: Vec<String>,
    #[serde(default)]
    recurrence: Option<Value>,
    #[serde(default)]
    is_cancelled: bool,
    #[serde(default)]
    is_online_meeting: bool,
    #[serde(default)]
    is_all_day: bool,
}

fn sha256(value: &Value) -> String {
    let bytes = serde_json::to_vec(value).unwrap_or_default();
    format!("{:x}", Sha256::digest(bytes))
}

fn normalized_values(values: &[String]) -> Vec<String> {
    let mut values = values
        .iter()
        .map(|value| value.trim().to_string())
        .filter(|value| !value.is_empty())
        .collect::<Vec<_>>();
    values.sort_by_key(|value| value.to_lowercase());
    values.dedup_by(|left, right| left.eq_ignore_ascii_case(right));
    values
}

fn contact_hash(contact: &LocalContact) -> String {
    sha256(&json!({
        "firstName": contact.first_name.trim(),
        "lastName": contact.last_name.trim(),
        "displayName": contact.display_name.trim(),
        "email": contact.email.trim().to_lowercase(),
        "phone": contact.phone.trim(),
        "mobilePhone": contact.mobile_phone.trim(),
        "street": contact.street.trim(),
        "postalCode": contact.postal_code.trim(),
        "city": contact.city.trim(),
        "country": contact.country.trim(),
        "shortInfo": contact.short_info.trim(),
        "notes": contact.notes.trim(),
        "groups": normalized_values(&contact.groups),
    }))
}

fn calendar_hash(event: &ExchangeCalendarEvent) -> String {
    sha256(&json!({
        "title": event.title.trim(),
        "startsAt": normalize_calendar_datetime(&event.starts_at),
        "endsAt": normalize_calendar_datetime(&event.ends_at),
        "location": event.location.trim(),
        "description": event.description.trim(),
        "category": event.category.trim(),
        "recurrence": event.recurrence,
        "excludedDates": event.excluded_dates,
    }))
}

fn normalize_calendar_datetime(value: &str) -> String {
    let value = value.trim();
    value.get(0..16).unwrap_or(value).to_string()
}

fn graph_item_url(collection: &str, id: &str) -> String {
    format!("{GRAPH_ROOT}/me/{collection}/{}", url_encode_component(id))
}

fn graph_contact_as_local(remote: &GraphContact, existing_id: i64) -> LocalContact {
    LocalContact {
        id: existing_id,
        first_name: remote.given_name.trim().to_string(),
        last_name: remote.surname.trim().to_string(),
        display_name: remote.display_name.trim().to_string(),
        email: remote
            .email_addresses
            .first()
            .map(|entry| entry.address.trim().to_string())
            .unwrap_or_default(),
        phone: remote
            .business_phones
            .first()
            .or_else(|| remote.home_phones.first())
            .map(|value| value.trim().to_string())
            .unwrap_or_default(),
        mobile_phone: remote.mobile_phone.trim().to_string(),
        street: remote.home_address.street.trim().to_string(),
        postal_code: remote.home_address.postal_code.trim().to_string(),
        city: remote.home_address.city.trim().to_string(),
        country: remote.home_address.country_or_region.trim().to_string(),
        short_info: remote.company_name.trim().to_string(),
        notes: remote.personal_notes.trim().to_string(),
        groups: normalized_values(&remote.categories),
        updated_at: if remote.last_modified_date_time.is_empty() {
            now()
        } else {
            remote.last_modified_date_time.clone()
        },
        deleted_at: None,
        exchange_id: Some(remote.id.clone()),
        exchange_change_key: Some(remote.change_key.clone()),
        exchange_last_synced_hash: None,
    }
}

fn contact_payload(contact: &LocalContact, remote: Option<&GraphContact>) -> Value {
    let mut email_addresses = remote
        .map(|remote| {
            remote.email_addresses.iter().map(|entry| {
                json!({ "address": entry.address.trim(), "name": contact.display_name.trim() })
            }).collect::<Vec<_>>()
        })
        .unwrap_or_default();
    if contact.email.trim().is_empty() {
        email_addresses.clear();
    } else if let Some(first) = email_addresses.first_mut() {
        *first = json!({ "address": contact.email.trim(), "name": contact.display_name.trim() });
    } else {
        email_addresses
            .push(json!({ "address": contact.email.trim(), "name": contact.display_name.trim() }));
    }
    let mut business_phones = remote
        .map(|value| value.business_phones.clone())
        .unwrap_or_default();
    let mut home_phones = remote
        .map(|value| value.home_phones.clone())
        .unwrap_or_default();
    if contact.phone.trim().is_empty() {
        business_phones.clear();
        home_phones.clear();
    } else if let Some(first) = business_phones.first_mut() {
        *first = contact.phone.trim().to_string();
    } else if let Some(first) = home_phones.first_mut() {
        *first = contact.phone.trim().to_string();
    } else {
        business_phones.push(contact.phone.trim().to_string());
    }
    json!({
        "givenName": contact.first_name.trim(),
        "surname": contact.last_name.trim(),
        "displayName": contact.display_name.trim(),
        "emailAddresses": email_addresses,
        "businessPhones": business_phones,
        "homePhones": home_phones,
        "mobilePhone": contact.mobile_phone.trim(),
        "homeAddress": {
            "street": contact.street.trim(),
            "postalCode": contact.postal_code.trim(),
            "city": contact.city.trim(),
            "countryOrRegion": contact.country.trim(),
        },
        "companyName": contact.short_info.trim(),
        "personalNotes": contact.notes.trim(),
        "categories": normalized_values(&contact.groups),
    })
}

fn load_local_contacts(conn: &Connection) -> Result<Vec<LocalContact>, String> {
    let mut statement = conn
        .prepare(
            "SELECT id, first_name, last_name, display_name, email, phone, mobile_phone,
                    street, postal_code, city, country, short_info, notes, updated_at, deleted_at,
                    exchange_id, exchange_change_key, exchange_last_synced_hash
             FROM contacts",
        )
        .map_err(|error| error.to_string())?;
    let rows = statement
        .query_map([], |row| {
            Ok(LocalContact {
                id: row.get(0)?,
                first_name: row.get(1)?,
                last_name: row.get(2)?,
                display_name: row.get(3)?,
                email: row.get(4)?,
                phone: row.get(5)?,
                mobile_phone: row.get(6)?,
                street: row.get(7)?,
                postal_code: row.get(8)?,
                city: row.get(9)?,
                country: row.get(10)?,
                short_info: row.get(11)?,
                notes: row.get(12)?,
                groups: Vec::new(),
                updated_at: row.get(13)?,
                deleted_at: row.get(14)?,
                exchange_id: row.get(15)?,
                exchange_change_key: row.get(16)?,
                exchange_last_synced_hash: row.get(17)?,
            })
        })
        .map_err(|error| error.to_string())?;
    let mut contacts = rows
        .collect::<Result<Vec<_>, _>>()
        .map_err(|error| error.to_string())?;
    for contact in &mut contacts {
        let mut group_statement = conn
            .prepare(
                "SELECT g.name FROM groups g
                 JOIN contact_groups cg ON cg.group_id = g.id
                 WHERE cg.contact_id = ?1 AND g.deleted_at IS NULL ORDER BY g.name COLLATE NOCASE",
            )
            .map_err(|error| error.to_string())?;
        contact.groups = group_statement
            .query_map([contact.id], |row| row.get(0))
            .map_err(|error| error.to_string())?
            .collect::<Result<Vec<_>, _>>()
            .map_err(|error| error.to_string())?;
    }
    Ok(contacts)
}

fn ensure_group(conn: &Connection, name: &str) -> Result<i64, String> {
    let timestamp = now();
    conn.execute(
        "INSERT INTO groups (name, description, created_at, updated_at, deleted_at)
         VALUES (?1, '', ?2, ?2, NULL)
         ON CONFLICT(name) DO UPDATE SET deleted_at = NULL, updated_at = excluded.updated_at",
        params![name, timestamp],
    )
    .map_err(|error| error.to_string())?;
    conn.query_row("SELECT id FROM groups WHERE name = ?1", [name], |row| {
        row.get(0)
    })
    .map_err(|error| error.to_string())
}

fn save_remote_contact(
    conn: &Connection,
    remote: &GraphContact,
    local_id: Option<i64>,
) -> Result<i64, String> {
    let mut contact = graph_contact_as_local(remote, local_id.unwrap_or_default());
    let synced_hash = contact_hash(&contact);
    contact.exchange_last_synced_hash = Some(synced_hash.clone());
    let id = if let Some(id) = local_id {
        conn.execute(
            "UPDATE contacts SET first_name=?1, last_name=?2, display_name=?3, email=?4,
                phone=?5, mobile_phone=?6, street=?7, postal_code=?8, city=?9, country=?10,
                short_info=?11, notes=?12, updated_at=?13, deleted_at=NULL, exchange_id=?14,
                exchange_change_key=?15, exchange_last_synced_hash=?16, exchange_last_synced_at=?17
             WHERE id=?18",
            params![
                contact.first_name,
                contact.last_name,
                contact.display_name,
                contact.email,
                contact.phone,
                contact.mobile_phone,
                contact.street,
                contact.postal_code,
                contact.city,
                contact.country,
                contact.short_info,
                contact.notes,
                contact.updated_at,
                remote.id,
                remote.change_key,
                synced_hash,
                now(),
                id
            ],
        )
        .map_err(|error| error.to_string())?;
        id
    } else {
        conn.execute(
            "INSERT INTO contacts (first_name,last_name,display_name,email,phone,mobile_phone,street,
                postal_code,city,country,short_info,notes,created_at,updated_at,exchange_id,
                exchange_change_key,exchange_last_synced_hash,exchange_last_synced_at)
             VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12,?13,?13,?14,?15,?16,?13)",
            params![contact.first_name, contact.last_name, contact.display_name, contact.email,
                contact.phone, contact.mobile_phone, contact.street, contact.postal_code, contact.city,
                contact.country, contact.short_info, contact.notes, now(), remote.id, remote.change_key,
                synced_hash],
        ).map_err(|error| error.to_string())?;
        conn.last_insert_rowid()
    };
    conn.execute("DELETE FROM contact_groups WHERE contact_id=?1", [id])
        .map_err(|error| error.to_string())?;
    for group in normalized_values(&remote.categories) {
        let group_id = ensure_group(conn, &group)?;
        conn.execute(
            "INSERT OR IGNORE INTO contact_groups (contact_id, group_id) VALUES (?1, ?2)",
            params![id, group_id],
        )
        .map_err(|error| error.to_string())?;
    }
    Ok(id)
}

fn save_contact_link(
    conn: &Connection,
    id: i64,
    remote: &GraphContact,
    hash: &str,
) -> Result<(), String> {
    conn.execute(
        "UPDATE contacts SET exchange_id=?1, exchange_change_key=?2,
            exchange_last_synced_hash=?3, exchange_last_synced_at=?4 WHERE id=?5",
        params![remote.id, remote.change_key, hash, now(), id],
    )
    .map_err(|error| error.to_string())?;
    Ok(())
}

fn is_later(left: &str, right: &str) -> bool {
    match (
        DateTime::parse_from_rfc3339(left),
        DateTime::parse_from_rfc3339(right),
    ) {
        (Ok(left), Ok(right)) => left >= right,
        _ => left >= right,
    }
}

async fn graph_request<T: DeserializeOwned>(
    client: &Client,
    method: Method,
    url: &str,
    access_token: &str,
    body: Option<&Value>,
) -> Result<T, String> {
    if !url.starts_with(GRAPH_ROOT) {
        return Err("Microsoft Graph hat eine unsichere Folgeseite geliefert.".to_string());
    }
    let mut request = client
        .request(method, url)
        .bearer_auth(access_token)
        .header("Prefer", GRAPH_PREFER);
    if let Some(body) = body {
        request = request.json(body);
    }
    let response = request.send().await.map_err(|_| {
        "Microsoft Graph ist derzeit nicht erreichbar. Die lokalen Daten bleiben erhalten."
            .to_string()
    })?;
    let status = response.status();
    if !status.is_success() {
        let detail = response.text().await.unwrap_or_default();
        let detail = detail.chars().take(240).collect::<String>();
        return Err(format!(
            "Exchange-Synchronisierung wurde von Microsoft Graph abgelehnt (HTTP {}): {}",
            status.as_u16(),
            detail
        ));
    }
    response
        .json::<T>()
        .await
        .map_err(|_| "Microsoft Graph hat ungültige Synchronisierungsdaten geliefert.".to_string())
}

async fn graph_delete(client: &Client, url: &str, access_token: &str) -> Result<(), String> {
    if !url.starts_with(GRAPH_ROOT) {
        return Err("Ungültiges Microsoft-Graph-Ziel.".to_string());
    }
    let response = client
        .delete(url)
        .bearer_auth(access_token)
        .header("Prefer", GRAPH_PREFER)
        .send()
        .await
        .map_err(|_| "Microsoft Graph ist derzeit nicht erreichbar.".to_string())?;
    if response.status().is_success() || response.status() == StatusCode::NOT_FOUND {
        Ok(())
    } else {
        Err(format!(
            "Exchange-Löschung wurde von Microsoft Graph abgelehnt (HTTP {}).",
            response.status().as_u16()
        ))
    }
}

async fn graph_collection<T: DeserializeOwned>(
    client: &Client,
    initial_url: &str,
    access_token: &str,
) -> Result<Vec<T>, String> {
    let mut url = initial_url.to_string();
    let mut values = Vec::new();
    loop {
        let page =
            graph_request::<GraphPage<T>>(client, Method::GET, &url, access_token, None).await?;
        values.extend(page.value);
        let Some(next) = page.next_link else { break };
        url = next;
    }
    Ok(values)
}

async fn sync_contacts(
    app: &AppHandle,
    client: &Client,
    access_token: &str,
) -> Result<ExchangeEntitySyncSummary, String> {
    let mut summary = ExchangeEntitySyncSummary::default();
    let conn = open_db(app)?;
    let locals = load_local_contacts(&conn)?;
    let deleted_remote_ids = locals
        .iter()
        .filter(|contact| contact.deleted_at.is_some())
        .filter_map(|contact| contact.exchange_id.clone())
        .collect::<HashSet<_>>();

    for local in locals.iter().filter(|contact| contact.deleted_at.is_some()) {
        if let Some(exchange_id) = local.exchange_id.as_deref() {
            graph_delete(
                client,
                &graph_item_url("contacts", exchange_id),
                access_token,
            )
            .await?;
            summary.deleted += 1;
        }
    }

    let select = "id,changeKey,lastModifiedDateTime,givenName,surname,displayName,emailAddresses,businessPhones,homePhones,mobilePhone,homeAddress,companyName,personalNotes,categories";
    let remote_contacts = graph_collection::<GraphContact>(
        client,
        &format!("{GRAPH_ROOT}/me/contacts?$top=250&$select={select}"),
        access_token,
    )
    .await?;
    let remote_by_id = remote_contacts
        .into_iter()
        .map(|contact| (contact.id.clone(), contact))
        .collect::<HashMap<_, _>>();
    let mut claimed_remote_ids = deleted_remote_ids;

    for local in locals.iter().filter(|contact| contact.deleted_at.is_none()) {
        let local_hash = contact_hash(local);
        let linked_remote = local
            .exchange_id
            .as_ref()
            .and_then(|id| remote_by_id.get(id))
            .cloned();
        if let Some(remote) = linked_remote {
            claimed_remote_ids.insert(remote.id.clone());
            let local_changed =
                local.exchange_last_synced_hash.as_deref() != Some(local_hash.as_str());
            let remote_changed =
                local.exchange_change_key.as_deref() != Some(remote.change_key.as_str());
            if local_changed
                && (!remote_changed || is_later(&local.updated_at, &remote.last_modified_date_time))
            {
                let updated = graph_request::<GraphContact>(
                    client,
                    Method::PATCH,
                    &graph_item_url("contacts", &remote.id),
                    access_token,
                    Some(&contact_payload(local, Some(&remote))),
                )
                .await?;
                save_contact_link(&conn, local.id, &updated, &local_hash)?;
                summary.updated += 1;
                if remote_changed {
                    summary.conflicts += 1;
                }
            } else if remote_changed {
                save_remote_contact(&conn, &remote, Some(local.id))?;
                summary.downloaded += 1;
                if local_changed {
                    summary.conflicts += 1;
                }
            } else {
                save_contact_link(&conn, local.id, &remote, &local_hash)?;
            }
            continue;
        }

        if local.exchange_id.is_some()
            && local.exchange_last_synced_hash.as_deref() == Some(local_hash.as_str())
        {
            conn.execute(
                "UPDATE contacts SET deleted_at=?1, updated_at=?1 WHERE id=?2",
                params![now(), local.id],
            )
            .map_err(|error| error.to_string())?;
            summary.deleted += 1;
            continue;
        }

        let matching_id = remote_by_id
            .values()
            .filter(|remote| !claimed_remote_ids.contains(&remote.id))
            .find(|remote| {
                let remote_local = graph_contact_as_local(remote, 0);
                contact_hash(&remote_local) == local_hash
                    || (!local.email.trim().is_empty()
                        && remote_local.email.eq_ignore_ascii_case(local.email.trim()))
            })
            .map(|remote| remote.id.clone());
        if let Some(remote_id) = matching_id {
            let remote = remote_by_id
                .get(&remote_id)
                .expect("matched remote contact")
                .clone();
            claimed_remote_ids.insert(remote.id.clone());
            if is_later(&local.updated_at, &remote.last_modified_date_time) {
                let updated = graph_request::<GraphContact>(
                    client,
                    Method::PATCH,
                    &graph_item_url("contacts", &remote.id),
                    access_token,
                    Some(&contact_payload(local, Some(&remote))),
                )
                .await?;
                save_contact_link(&conn, local.id, &updated, &local_hash)?;
                summary.updated += 1;
            } else {
                save_remote_contact(&conn, &remote, Some(local.id))?;
                summary.downloaded += 1;
            }
            continue;
        }

        let created = graph_request::<GraphContact>(
            client,
            Method::POST,
            &format!("{GRAPH_ROOT}/me/contacts"),
            access_token,
            Some(&contact_payload(local, None)),
        )
        .await?;
        save_contact_link(&conn, local.id, &created, &local_hash)?;
        claimed_remote_ids.insert(created.id);
        summary.uploaded += 1;
    }

    for remote in remote_by_id.values() {
        if claimed_remote_ids.contains(&remote.id) {
            continue;
        }
        if remote.display_name.trim().is_empty()
            && remote.email_addresses.is_empty()
            && remote.business_phones.is_empty()
            && remote.mobile_phone.trim().is_empty()
        {
            continue;
        }
        save_remote_contact(&conn, remote, None)?;
        summary.downloaded += 1;
    }
    Ok(summary)
}

fn weekday_name(day: u32) -> &'static str {
    [
        "sunday",
        "monday",
        "tuesday",
        "wednesday",
        "thursday",
        "friday",
        "saturday",
    ]
    .get(day as usize)
    .copied()
    .unwrap_or("monday")
}

fn weekday_number(day: &str) -> Option<u32> {
    [
        "sunday",
        "monday",
        "tuesday",
        "wednesday",
        "thursday",
        "friday",
        "saturday",
    ]
    .iter()
    .position(|value| value.eq_ignore_ascii_case(day))
    .map(|index| index as u32)
}

fn recurrence_payload(event: &ExchangeCalendarEvent) -> Option<Value> {
    let recurrence = event.recurrence.as_ref()?;
    let interval = recurrence.interval.max(1);
    let start_date = event.starts_at.get(0..10).unwrap_or("2000-01-01");
    let pattern = match recurrence.frequency.as_str() {
        "daily" => json!({ "type": "daily", "interval": interval }),
        "weekly" => json!({
            "type": "weekly",
            "interval": interval,
            "daysOfWeek": if recurrence.days_of_week.is_empty() {
                vec!["monday"]
            } else {
                recurrence.days_of_week.iter().map(|day| weekday_name(*day)).collect::<Vec<_>>()
            },
            "firstDayOfWeek": "monday"
        }),
        "monthly" => json!({
            "type": "absoluteMonthly",
            "interval": interval,
            "dayOfMonth": recurrence.day_of_month.unwrap_or(1)
        }),
        "yearly" => json!({
            "type": "absoluteYearly",
            "interval": interval,
            "dayOfMonth": recurrence.day_of_month.unwrap_or(1),
            "month": recurrence.month_of_year.unwrap_or(1)
        }),
        _ => return None,
    };
    let range = if let Some(count) = recurrence.count {
        json!({ "type": "numbered", "startDate": start_date, "numberOfOccurrences": count.max(1), "recurrenceTimeZone": "W. Europe Standard Time" })
    } else if let Some(until) = recurrence.until.as_deref() {
        json!({ "type": "endDate", "startDate": start_date, "endDate": until, "recurrenceTimeZone": "W. Europe Standard Time" })
    } else {
        json!({ "type": "noEnd", "startDate": start_date, "recurrenceTimeZone": "W. Europe Standard Time" })
    };
    Some(json!({ "pattern": pattern, "range": range }))
}

fn recurrence_from_graph(value: &Value) -> Option<CalendarRecurrence> {
    let pattern = value.get("pattern")?;
    let range = value.get("range")?;
    let pattern_type = pattern.get("type")?.as_str()?;
    let frequency = match pattern_type {
        "daily" => "daily",
        "weekly" => "weekly",
        "absoluteMonthly" | "relativeMonthly" => "monthly",
        "absoluteYearly" | "relativeYearly" => "yearly",
        _ => return None,
    };
    let days_of_week = pattern
        .get("daysOfWeek")
        .and_then(Value::as_array)
        .map(|days| {
            days.iter()
                .filter_map(Value::as_str)
                .filter_map(weekday_number)
                .collect::<Vec<_>>()
        })
        .unwrap_or_default();
    let week_of_month = match pattern.get("index").and_then(Value::as_str) {
        Some("first") => Some(1),
        Some("second") => Some(2),
        Some("third") => Some(3),
        Some("fourth") => Some(4),
        Some("last") => Some(-1),
        _ => None,
    };
    Some(CalendarRecurrence {
        frequency: frequency.to_string(),
        interval: pattern.get("interval").and_then(Value::as_u64).unwrap_or(1) as u32,
        days_of_week,
        day_of_month: pattern
            .get("dayOfMonth")
            .and_then(Value::as_u64)
            .map(|v| v as u32),
        month_of_year: pattern
            .get("month")
            .and_then(Value::as_u64)
            .map(|v| v as u32),
        week_of_month,
        until: if range.get("type").and_then(Value::as_str) == Some("endDate") {
            range
                .get("endDate")
                .and_then(Value::as_str)
                .map(str::to_string)
        } else {
            None
        },
        count: if range.get("type").and_then(Value::as_str) == Some("numbered") {
            range
                .get("numberOfOccurrences")
                .and_then(Value::as_u64)
                .map(|v| v as u32)
        } else {
            None
        },
    })
}

fn event_payload(
    event: &ExchangeCalendarEvent,
    include_body: bool,
    include_transaction_id: bool,
    remote: Option<&GraphEvent>,
) -> Value {
    let mut categories = remote
        .map(|value| value.categories.clone())
        .unwrap_or_default();
    if event.category.trim().is_empty() {
        categories.clear();
    } else if let Some(first) = categories.first_mut() {
        *first = event.category.trim().to_string();
    } else {
        categories.push(event.category.trim().to_string());
    }
    let mut payload = json!({
        "subject": event.title.trim(),
        "start": { "dateTime": event.starts_at.trim(), "timeZone": "W. Europe Standard Time" },
        "end": { "dateTime": event.ends_at.trim(), "timeZone": "W. Europe Standard Time" },
        "location": { "displayName": event.location.trim() },
        "categories": categories,
        "recurrence": recurrence_payload(event),
        "isAllDay": event.exchange_is_all_day,
    });
    if include_body {
        payload["body"] = json!({ "contentType": "text", "content": event.description });
    }
    if include_transaction_id && Uuid::parse_str(&event.id).is_ok() {
        payload["transactionId"] = json!(event.id);
    }
    payload
}

fn graph_event_as_local(
    remote: &GraphEvent,
    existing: Option<&ExchangeCalendarEvent>,
) -> ExchangeCalendarEvent {
    let category = remote.categories.first().cloned().unwrap_or_default();
    let mut event = ExchangeCalendarEvent {
        id: existing
            .map(|event| event.id.clone())
            .unwrap_or_else(|| format!("exchange:{}", remote.id)),
        title: remote.subject.trim().to_string(),
        starts_at: remote.start.date_time.trim().to_string(),
        ends_at: remote.end.date_time.trim().to_string(),
        location: remote.location.display_name.trim().to_string(),
        description: remote.body.content.trim().to_string(),
        color: existing
            .map(|event| event.color.clone())
            .unwrap_or_else(default_calendar_color),
        category,
        source: "Microsoft Exchange".to_string(),
        recurrence: remote.recurrence.as_ref().and_then(recurrence_from_graph),
        excluded_dates: existing
            .map(|event| event.excluded_dates.clone())
            .unwrap_or_default(),
        deleted_at: None,
        updated_at: if remote.last_modified_date_time.is_empty() {
            now()
        } else {
            remote.last_modified_date_time.clone()
        },
        exchange_id: Some(remote.id.clone()),
        exchange_change_key: Some(remote.change_key.clone()),
        exchange_last_synced_hash: None,
        exchange_is_online_meeting: remote.is_online_meeting,
        exchange_is_all_day: remote.is_all_day,
    };
    event.exchange_last_synced_hash = Some(calendar_hash(&event));
    event
}

async fn sync_calendar(
    client: &Client,
    access_token: &str,
    mut active: Vec<ExchangeCalendarEvent>,
    mut deleted: Vec<ExchangeCalendarEvent>,
) -> Result<
    (
        ExchangeEntitySyncSummary,
        Vec<ExchangeCalendarEvent>,
        Vec<ExchangeCalendarEvent>,
    ),
    String,
> {
    let mut summary = ExchangeEntitySyncSummary::default();
    let deleted_remote_ids = deleted
        .iter()
        .filter_map(|event| event.exchange_id.clone())
        .collect::<HashSet<_>>();
    for event in &mut active {
        if event.updated_at.is_empty() {
            event.updated_at = now();
        }
        event.deleted_at = None;
    }
    for event in &mut deleted {
        if event.updated_at.is_empty() {
            event.updated_at = event.deleted_at.clone().unwrap_or_else(now);
        }
        if event.deleted_at.is_none() {
            event.deleted_at = Some(now());
        }
        if let Some(exchange_id) = event.exchange_id.as_deref() {
            graph_delete(client, &graph_item_url("events", exchange_id), access_token).await?;
            summary.deleted += 1;
        }
    }

    let select = "id,changeKey,lastModifiedDateTime,subject,start,end,location,body,categories,recurrence,isCancelled,isOnlineMeeting,isAllDay,type";
    let remote_events = graph_collection::<GraphEvent>(
        client,
        &format!("{GRAPH_ROOT}/me/calendar/events?$top=250&$select={select}"),
        access_token,
    )
    .await?
    .into_iter()
    .filter(|event| !event.is_cancelled)
    .collect::<Vec<_>>();
    let remote_by_id = remote_events
        .into_iter()
        .map(|event| (event.id.clone(), event))
        .collect::<HashMap<_, _>>();
    let mut claimed = deleted_remote_ids;
    let mut next_active = Vec::new();

    for local in active {
        let local_hash = calendar_hash(&local);
        let linked = local
            .exchange_id
            .as_ref()
            .and_then(|id| remote_by_id.get(id));
        if let Some(remote) = linked {
            claimed.insert(remote.id.clone());
            let local_changed =
                local.exchange_last_synced_hash.as_deref() != Some(local_hash.as_str());
            let remote_changed =
                local.exchange_change_key.as_deref() != Some(remote.change_key.as_str());
            if local_changed
                && (!remote_changed || is_later(&local.updated_at, &remote.last_modified_date_time))
            {
                let include_body = !local.exchange_is_online_meeting;
                let updated = graph_request::<GraphEvent>(
                    client,
                    Method::PATCH,
                    &graph_item_url("events", &remote.id),
                    access_token,
                    Some(&event_payload(&local, include_body, false, Some(remote))),
                )
                .await?;
                let mut linked_local = local.clone();
                linked_local.exchange_id = Some(updated.id);
                linked_local.exchange_change_key = Some(updated.change_key);
                linked_local.exchange_last_synced_hash = Some(local_hash);
                next_active.push(linked_local);
                summary.updated += 1;
                if remote_changed {
                    summary.conflicts += 1;
                }
            } else if remote_changed {
                next_active.push(graph_event_as_local(remote, Some(&local)));
                summary.downloaded += 1;
                if local_changed {
                    summary.conflicts += 1;
                }
            } else {
                let mut linked_local = local;
                linked_local.exchange_last_synced_hash = Some(local_hash);
                next_active.push(linked_local);
            }
            continue;
        }

        if local.exchange_id.is_some()
            && local.exchange_last_synced_hash.as_deref() == Some(local_hash.as_str())
        {
            let mut tombstone = local;
            tombstone.deleted_at = Some(now());
            tombstone.updated_at = tombstone.deleted_at.clone().unwrap_or_else(now);
            deleted.push(tombstone);
            summary.deleted += 1;
            continue;
        }

        let exact_match = remote_by_id.values().find(|remote| {
            !claimed.contains(&remote.id)
                && calendar_hash(&graph_event_as_local(remote, None)) == local_hash
        });
        if let Some(remote) = exact_match {
            claimed.insert(remote.id.clone());
            next_active.push(graph_event_as_local(remote, Some(&local)));
            summary.downloaded += 1;
            continue;
        }

        let created = graph_request::<GraphEvent>(
            client,
            Method::POST,
            &format!("{GRAPH_ROOT}/me/events"),
            access_token,
            Some(&event_payload(&local, true, true, None)),
        )
        .await?;
        claimed.insert(created.id.clone());
        let mut linked_local = local;
        linked_local.exchange_id = Some(created.id);
        linked_local.exchange_change_key = Some(created.change_key);
        linked_local.exchange_last_synced_hash = Some(local_hash);
        next_active.push(linked_local);
        summary.uploaded += 1;
    }

    for remote in remote_by_id.values() {
        if claimed.contains(&remote.id) {
            continue;
        }
        next_active.push(graph_event_as_local(remote, None));
        summary.downloaded += 1;
    }
    next_active.sort_by(|left, right| left.starts_at.cmp(&right.starts_at));
    deleted.sort_by(|left, right| right.deleted_at.cmp(&left.deleted_at));
    Ok((summary, next_active, deleted))
}

async fn sync_exchange_data_inner(
    app: &AppHandle,
    state: &AppState,
    request: ExchangeSyncRequest,
) -> Result<ExchangeSyncResult, String> {
    let mut access_token = m365::acquire_graph_access_token(app, state).await?;
    let client = Client::new();
    let result = async {
        let contacts = sync_contacts(app, &client, &access_token).await?;
        let (calendar, calendar_events, deleted_calendar_events) = sync_calendar(
            &client,
            &access_token,
            request.calendar_events,
            request.deleted_calendar_events,
        )
        .await?;
        Ok(ExchangeSyncResult {
            contacts,
            calendar,
            calendar_events,
            deleted_calendar_events,
            synced_at: Utc::now().to_rfc3339(),
        })
    }
    .await;
    access_token.zeroize();
    result
}

#[tauri::command]
pub async fn sync_exchange_data(
    app: AppHandle,
    state: State<'_, AppState>,
    request: ExchangeSyncRequest,
) -> Result<ExchangeSyncResult, String> {
    {
        let mut syncing = state
            .exchange_sync_in_progress
            .lock()
            .map_err(|_| "Synchronisierungsstatus konnte nicht gelesen werden.".to_string())?;
        if *syncing {
            return Err("Eine Exchange-Synchronisierung läuft bereits.".to_string());
        }
        *syncing = true;
    }
    let result = sync_exchange_data_inner(&app, &state, request).await;
    if let Ok(mut syncing) = state.exchange_sync_in_progress.lock() {
        *syncing = false;
    }
    result
}

#[cfg(test)]
mod tests {
    use super::*;

    fn sample_event() -> ExchangeCalendarEvent {
        ExchangeCalendarEvent {
            id: "11111111-1111-1111-1111-111111111111".to_string(),
            title: "Besprechung".to_string(),
            starts_at: "2026-08-10T09:00:00".to_string(),
            ends_at: "2026-08-10T10:00:00".to_string(),
            location: "Aidlingen".to_string(),
            description: "Planung".to_string(),
            color: "blue".to_string(),
            category: "DMH".to_string(),
            source: "DMH Portal".to_string(),
            recurrence: None,
            excluded_dates: Vec::new(),
            deleted_at: None,
            updated_at: "2026-08-06T10:00:00Z".to_string(),
            exchange_id: None,
            exchange_change_key: None,
            exchange_last_synced_hash: None,
            exchange_is_online_meeting: false,
            exchange_is_all_day: false,
        }
    }

    #[test]
    fn weekly_recurrence_round_trips() {
        let mut event = sample_event();
        event.recurrence = Some(CalendarRecurrence {
            frequency: "weekly".to_string(),
            interval: 2,
            days_of_week: vec![1, 4],
            day_of_month: None,
            month_of_year: None,
            week_of_month: None,
            until: Some("2026-12-31".to_string()),
            count: None,
        });
        let payload = recurrence_payload(&event).expect("recurrence payload");
        let restored = recurrence_from_graph(&payload).expect("restored recurrence");
        assert_eq!(restored.frequency, "weekly");
        assert_eq!(restored.interval, 2);
        assert_eq!(restored.days_of_week, vec![1, 4]);
        assert_eq!(restored.until.as_deref(), Some("2026-12-31"));
    }

    #[test]
    fn calendar_hash_ignores_exchange_metadata() {
        let event = sample_event();
        let mut linked = event.clone();
        linked.exchange_id = Some("graph-id".to_string());
        linked.exchange_change_key = Some("change-key".to_string());
        linked.exchange_last_synced_hash = Some("old".to_string());
        assert_eq!(calendar_hash(&event), calendar_hash(&linked));
    }

    #[test]
    fn graph_contacts_accept_common_null_fields() {
        let contact: GraphContact = serde_json::from_value(json!({
            "id": "exchange-id",
            "changeKey": "change-key",
            "lastModifiedDateTime": "2026-08-06T10:00:00Z",
            "givenName": "Anna",
            "surname": null,
            "displayName": "Anna",
            "emailAddresses": [],
            "businessPhones": null,
            "homePhones": [],
            "mobilePhone": null,
            "homeAddress": null,
            "companyName": null,
            "personalNotes": null,
            "categories": null
        }))
        .expect("nullable Graph contact");
        assert_eq!(contact.surname, "");
        assert_eq!(contact.home_address.city, "");
        assert!(contact.categories.is_empty());
    }
}
