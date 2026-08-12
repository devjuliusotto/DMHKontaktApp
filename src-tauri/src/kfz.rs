use crate::{m365, open_db, AppState};
use chrono::{DateTime, Duration as ChronoDuration, Utc};
use rusqlite::{params, OptionalExtension};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use tauri::{AppHandle, State};
use url::Url;
use zeroize::Zeroize;

const SHAREPOINT_HOST: &str = "dmhaidlingen.sharepoint.com";
const SHAREPOINT_SITE_PATH: &str = "/sites/DMHFuhrpark";

#[derive(Debug, Serialize, Deserialize, Clone, Default)]
#[serde(rename_all = "camelCase")]
pub struct KfzVehicle {
    pub id: String,
    pub etag: String,
    pub kennzeichen: String,
    pub spitzname: String,
    pub farbe: String,
    pub aktiv: bool,
    pub fahrzeugtyp: String,
    pub hersteller: String,
    pub lackcode: String,
    pub vin: String,
    pub erstzulassung: Option<String>,
    pub baujahr: Option<i64>,
    pub motorkennbuchstabe: String,
    pub hubraum_ccm: Option<i64>,
    pub leistung_kw: Option<i64>,
    pub kilometerstand: Option<i64>,
    pub standort_id: String,
    pub standort_label: String,
    pub legacy_standort_text: String,
    pub legacy_verantwortliche: String,
    pub tankkarte: bool,
    pub versicherung: String,
    pub oeltyp: String,
    pub naechster_tuev: Option<String>,
    pub naechste_au: Option<String>,
    pub naechste_inspektion: Option<String>,
    pub naechste_inspektion_km: Option<i64>,
    pub naechster_sommercheck: Option<String>,
    pub naechster_wintercheck: Option<String>,
    pub kaufdatum: Option<String>,
    pub verkaufsdatum: Option<String>,
    pub legacy_kennzeichen: String,
    pub legacy_import_id: String,
    pub modified_at: Option<String>,
}

#[derive(Debug, Serialize, Deserialize, Clone, Default)]
#[serde(rename_all = "camelCase")]
pub struct KfzMaintenance {
    pub id: String,
    pub etag: String,
    pub title: String,
    pub fahrzeug_id: String,
    pub fahrzeug_label: String,
    pub legacy_kennzeichen: String,
    pub datum: Option<String>,
    pub kilometerstand: Option<i64>,
    pub kategorie: String,
    pub beschreibung: String,
    pub arbeiten: String,
    pub status: String,
    pub werkstatt: String,
    pub kosten: Option<f64>,
    pub naechster_termin: Option<String>,
    pub naechster_kilometerstand: Option<i64>,
    pub legacy_wartungs_id: Option<i64>,
    pub modified_at: Option<String>,
}

#[derive(Debug, Serialize, Deserialize, Clone, Default)]
#[serde(rename_all = "camelCase")]
pub struct KfzLocation {
    pub id: String,
    pub etag: String,
    pub name: String,
    pub aktiv: bool,
    pub code: String,
    pub adresse: String,
    pub legacy_einsatzort_id: Option<i64>,
    pub modified_at: Option<String>,
}

#[derive(Debug, Serialize, Deserialize, Clone, Default)]
#[serde(rename_all = "camelCase")]
pub struct KfzDocument {
    pub id: String,
    pub drive_item_id: String,
    pub file_name: String,
    pub web_url: String,
    pub fahrzeug_id: String,
    pub wartung_id: String,
    pub legacy_kennzeichen: String,
    pub dokumenttyp: String,
    pub dokumentdatum: Option<String>,
    pub beschreibung: String,
    pub betrag: Option<f64>,
    pub aktiv: bool,
    pub uploaded_by: String,
    pub uploaded_at: Option<String>,
    pub modified_at: Option<String>,
}

#[derive(Debug, Serialize, Deserialize, Clone, Default)]
#[serde(rename_all = "camelCase")]
pub struct KfzSnapshot {
    pub vehicles: Vec<KfzVehicle>,
    pub maintenance: Vec<KfzMaintenance>,
    pub locations: Vec<KfzLocation>,
    pub documents: Vec<KfzDocument>,
    pub last_synced_at: Option<String>,
    pub cache_ready: bool,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct KfzSyncResult {
    pub snapshot: KfzSnapshot,
    pub downloaded: usize,
    pub full_sync: bool,
    pub synced_at: String,
}

#[derive(Debug, Deserialize)]
struct GraphPage {
    #[serde(default)]
    value: Vec<Value>,
    #[serde(rename = "@odata.nextLink")]
    next_link: Option<String>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct GraphSite {
    id: String,
}

#[derive(Clone, Copy)]
enum Resource {
    Vehicles,
    Maintenance,
    Locations,
    Documents,
}

impl Resource {
    fn list_name(self) -> &'static str {
        match self {
            Self::Vehicles => "Fahrzeuge",
            Self::Maintenance => "Wartungen",
            Self::Locations => "Standorte",
            Self::Documents => "Fahrzeugdokumente",
        }
    }

    fn cache_key(self) -> &'static str {
        match self {
            Self::Vehicles => "vehicle",
            Self::Maintenance => "maintenance",
            Self::Locations => "location",
            Self::Documents => "document",
        }
    }
}

fn text(fields: &Value, names: &[&str]) -> String {
    names
        .iter()
        .find_map(|name| {
            fields.get(*name).and_then(|value| match value {
                Value::String(value) => Some(value.clone()),
                Value::Number(value) => Some(value.to_string()),
                _ => None,
            })
        })
        .unwrap_or_default()
}

fn boolean(fields: &Value, names: &[&str], default: bool) -> bool {
    names
        .iter()
        .find_map(|name| fields.get(*name))
        .and_then(|value| match value {
            Value::Bool(value) => Some(*value),
            Value::Number(value) => value.as_i64().map(|value| value != 0),
            Value::String(value) => match value.trim().to_ascii_lowercase().as_str() {
                "true" | "yes" | "ja" | "1" => Some(true),
                "false" | "no" | "nein" | "0" => Some(false),
                _ => None,
            },
            _ => None,
        })
        .unwrap_or(default)
}

fn integer(fields: &Value, names: &[&str]) -> Option<i64> {
    names
        .iter()
        .find_map(|name| fields.get(*name))
        .and_then(|value| match value {
            Value::Number(value) => value
                .as_i64()
                .or_else(|| value.as_f64().map(|value| value.round() as i64)),
            Value::String(value) => value.trim().parse().ok(),
            _ => None,
        })
}

fn decimal(fields: &Value, names: &[&str]) -> Option<f64> {
    names
        .iter()
        .find_map(|name| fields.get(*name))
        .and_then(|value| match value {
            Value::Number(value) => value.as_f64(),
            Value::String(value) => value.trim().replace(',', ".").parse().ok(),
            _ => None,
        })
}

fn date(fields: &Value, names: &[&str]) -> Option<String> {
    let value = text(fields, names);
    (!value.is_empty()).then_some(value)
}

fn item_id(item: &Value) -> String {
    text(item, &["id"])
}
fn item_etag(item: &Value) -> String {
    text(item, &["eTag", "@odata.etag"])
}
fn modified(item: &Value) -> Option<String> {
    date(item, &["lastModifiedDateTime"])
}
fn item_fields(item: &Value) -> &Value {
    item.get("fields").unwrap_or(&Value::Null)
}

fn map_vehicle(item: &Value) -> KfzVehicle {
    let fields = item_fields(item);
    KfzVehicle {
        id: item_id(item),
        etag: item_etag(item),
        kennzeichen: text(fields, &["Kennzeichen", "Title"]),
        spitzname: text(fields, &["Spitzname"]),
        farbe: text(fields, &["Farbe"]),
        aktiv: boolean(fields, &["Aktiv"], true),
        fahrzeugtyp: text(fields, &["Fahrzeugtyp"]),
        hersteller: text(fields, &["Hersteller"]),
        lackcode: text(fields, &["Lackcode"]),
        vin: text(fields, &["VIN"]),
        erstzulassung: date(fields, &["Erstzulassung"]),
        baujahr: integer(fields, &["Baujahr"]),
        motorkennbuchstabe: text(fields, &["Motorkennbuchstabe"]),
        hubraum_ccm: integer(fields, &["HubraumCcm"]),
        leistung_kw: integer(fields, &["LeistungKw"]),
        kilometerstand: integer(fields, &["Kilometerstand"]),
        standort_id: text(fields, &["StandortLookupId"]),
        standort_label: text(fields, &["Standort"]),
        legacy_standort_text: text(fields, &["LegacyStandortText"]),
        legacy_verantwortliche: text(fields, &["LegacyVerantwortliche"]),
        tankkarte: boolean(fields, &["Tankkarte"], false),
        versicherung: text(fields, &["Versicherung"]),
        oeltyp: text(fields, &["Oeltyp"]),
        naechster_tuev: date(fields, &["NaechsterTuev"]),
        naechste_au: date(fields, &["NaechsteAu"]),
        naechste_inspektion: date(fields, &["NaechsteInspektion"]),
        naechste_inspektion_km: integer(fields, &["NaechsteInspektionKm"]),
        naechster_sommercheck: date(fields, &["NaechsterSommercheck"]),
        naechster_wintercheck: date(fields, &["NaechsterWintercheck"]),
        kaufdatum: date(fields, &["Kaufdatum"]),
        verkaufsdatum: date(fields, &["Verkaufsdatum"]),
        legacy_kennzeichen: text(fields, &["LegacyKennzeichen"]),
        legacy_import_id: text(fields, &["LegacyImportId"]),
        modified_at: modified(item),
    }
}

fn map_maintenance(item: &Value) -> KfzMaintenance {
    let fields = item_fields(item);
    KfzMaintenance {
        id: item_id(item),
        etag: item_etag(item),
        title: text(fields, &["Title", "Titel"]),
        fahrzeug_id: text(fields, &["FahrzeugLookupId"]),
        fahrzeug_label: text(fields, &["Fahrzeug"]),
        legacy_kennzeichen: text(fields, &["LegacyKennzeichen"]),
        datum: date(fields, &["Datum"]),
        kilometerstand: integer(fields, &["Kilometerstand"]),
        kategorie: text(fields, &["Kategorie"]),
        beschreibung: text(fields, &["Beschreibung"]),
        arbeiten: text(fields, &["Arbeiten"]),
        status: text(fields, &["Status"]),
        werkstatt: text(fields, &["Werkstatt"]),
        kosten: decimal(fields, &["Kosten"]),
        naechster_termin: date(fields, &["NaechsterTermin"]),
        naechster_kilometerstand: integer(fields, &["NaechsterKilometerstand"]),
        legacy_wartungs_id: integer(fields, &["LegacyWartungsId"]),
        modified_at: modified(item),
    }
}

fn map_location(item: &Value) -> KfzLocation {
    let fields = item_fields(item);
    KfzLocation {
        id: item_id(item),
        etag: item_etag(item),
        name: text(fields, &["Title", "Standort"]),
        aktiv: boolean(fields, &["Aktiv"], true),
        code: text(fields, &["Code"]),
        adresse: text(fields, &["Adresse"]),
        legacy_einsatzort_id: integer(fields, &["LegacyEinsatzortId"]),
        modified_at: modified(item),
    }
}

fn map_document(item: &Value) -> KfzDocument {
    let fields = item_fields(item);
    let drive = item.get("driveItem").unwrap_or(&Value::Null);
    let created_by = item.pointer("/createdBy/user").unwrap_or(&Value::Null);
    KfzDocument {
        id: item_id(item),
        drive_item_id: text(drive, &["id"]),
        file_name: text(drive, &["name"]),
        web_url: text(drive, &["webUrl"]),
        fahrzeug_id: text(fields, &["FahrzeugLookupId"]),
        wartung_id: text(fields, &["WartungLookupId"]),
        legacy_kennzeichen: text(fields, &["LegacyKennzeichen"]),
        dokumenttyp: text(fields, &["Dokumenttyp"]),
        dokumentdatum: date(fields, &["Dokumentdatum"]),
        beschreibung: text(fields, &["Beschreibung"]),
        betrag: decimal(fields, &["Betrag"]),
        aktiv: boolean(fields, &["Aktiv"], true),
        uploaded_by: text(created_by, &["displayName"]),
        uploaded_at: date(item, &["createdDateTime"]),
        modified_at: modified(item),
    }
}

fn map_resource(resource: Resource, item: &Value) -> Result<String, String> {
    match resource {
        Resource::Vehicles => serde_json::to_string(&map_vehicle(item)),
        Resource::Maintenance => serde_json::to_string(&map_maintenance(item)),
        Resource::Locations => serde_json::to_string(&map_location(item)),
        Resource::Documents => serde_json::to_string(&map_document(item)),
    }
    .map_err(|error| error.to_string())
}

async fn graph_json<T: for<'de> Deserialize<'de>>(
    client: &reqwest::Client,
    token: &str,
    url: &str,
) -> Result<T, String> {
    let response = client
        .get(url)
        .bearer_auth(token)
        .send()
        .await
        .map_err(|_| "Microsoft Graph ist derzeit nicht erreichbar.".to_string())?;
    if !response.status().is_success() {
        let status = response.status();
        let body = response.text().await.unwrap_or_default();
        let detail = serde_json::from_str::<Value>(&body)
            .ok()
            .and_then(|value| {
                value
                    .pointer("/error/message")
                    .and_then(Value::as_str)
                    .map(str::to_string)
            })
            .unwrap_or_default();
        return Err(if status.as_u16() == 403 {
            "Die Portal-App hat noch keinen Lesezugriff auf den Fuhrpark-SharePoint. Die EDV muss Sites.Selected für diesen Site freigeben.".to_string()
        } else if detail.is_empty() {
            format!("Microsoft Graph antwortete mit HTTP {}.", status.as_u16())
        } else {
            format!("Microsoft Graph: {detail}")
        });
    }
    response
        .json::<T>()
        .await
        .map_err(|_| "Microsoft Graph hat ungültige Fuhrparkdaten geliefert.".to_string())
}

async fn list_items(
    client: &reqwest::Client,
    token: &str,
    site_id: &str,
    list_id: &str,
    resource: Resource,
    since: Option<&str>,
) -> Result<Vec<Value>, String> {
    let mut url = Url::parse(&format!(
        "https://graph.microsoft.com/v1.0/sites/{site_id}/lists/{list_id}/items"
    ))
    .map_err(|error| error.to_string())?;
    {
        let mut query = url.query_pairs_mut();
        query.append_pair("$top", "200");
        query.append_pair(
            "$expand",
            if matches!(resource, Resource::Documents) {
                "fields,driveItem"
            } else {
                "fields"
            },
        );
        if let Some(since) = since {
            query.append_pair("$filter", &format!("lastModifiedDateTime ge {since}"));
        }
    }
    let mut next = Some(url.to_string());
    let mut items = Vec::new();
    while let Some(page_url) = next {
        let page: GraphPage = graph_json(client, token, &page_url).await?;
        items.extend(page.value);
        next = page.next_link;
    }
    Ok(items)
}

fn load_snapshot(app: &AppHandle) -> Result<KfzSnapshot, String> {
    let conn = open_db(app)?;
    fn load<T: for<'de> Deserialize<'de>>(
        conn: &rusqlite::Connection,
        kind: &str,
    ) -> Result<Vec<T>, String> {
        let mut statement = conn
            .prepare("SELECT payload FROM kfz_cache WHERE entity_type = ?1 ORDER BY remote_id")
            .map_err(|error| error.to_string())?;
        let values = statement
            .query_map([kind], |row| row.get::<_, String>(0))
            .map_err(|error| error.to_string())?
            .map(|row| {
                row.map_err(|error| error.to_string())
                    .and_then(|json| serde_json::from_str(&json).map_err(|error| error.to_string()))
            })
            .collect();
        values
    }
    let last_synced_at = conn
        .query_row(
            "SELECT last_synced_at FROM kfz_sync_state WHERE resource = 'all'",
            [],
            |row| row.get(0),
        )
        .optional()
        .map_err(|error| error.to_string())?;
    Ok(KfzSnapshot {
        vehicles: load(&conn, "vehicle")?,
        maintenance: load(&conn, "maintenance")?,
        locations: load(&conn, "location")?,
        documents: load(&conn, "document")?,
        cache_ready: last_synced_at.is_some(),
        last_synced_at,
    })
}

#[tauri::command]
pub fn get_kfz_snapshot(app: AppHandle) -> Result<KfzSnapshot, String> {
    load_snapshot(&app)
}

#[tauri::command]
pub async fn sync_kfz_data(
    app: AppHandle,
    state: State<'_, AppState>,
    force_full: bool,
) -> Result<KfzSyncResult, String> {
    let previous_sync = open_db(&app)?
        .query_row(
            "SELECT last_synced_at FROM kfz_sync_state WHERE resource = 'all'",
            [],
            |row| row.get::<_, String>(0),
        )
        .optional()
        .map_err(|error| error.to_string())?;
    let full_sync = force_full || previous_sync.is_none();
    let since = if full_sync {
        None
    } else {
        previous_sync
            .as_ref()
            .and_then(|value| DateTime::parse_from_rfc3339(value).ok())
            .map(|value| (value.with_timezone(&Utc) - ChronoDuration::minutes(2)).to_rfc3339())
    };
    let mut token = m365::acquire_kfz_graph_access_token(&app, &state).await?;
    let client = reqwest::Client::new();
    let site: GraphSite = graph_json(&client, &token, &format!("https://graph.microsoft.com/v1.0/sites/{SHAREPOINT_HOST}:{SHAREPOINT_SITE_PATH}?$select=id")).await?;
    let lists: GraphPage = graph_json(
        &client,
        &token,
        &format!(
            "https://graph.microsoft.com/v1.0/sites/{}/lists?$select=id,displayName&$top=200",
            site.id
        ),
    )
    .await?;
    let resources = [
        Resource::Vehicles,
        Resource::Maintenance,
        Resource::Locations,
        Resource::Documents,
    ];
    let mut downloaded = 0usize;
    let mut batches = Vec::new();
    for resource in resources {
        let list_id = lists
            .value
            .iter()
            .find(|list| text(list, &["displayName"]).eq_ignore_ascii_case(resource.list_name()))
            .map(item_id)
            .filter(|id| !id.is_empty())
            .ok_or_else(|| {
                format!(
                    "Die SharePoint-Liste '{}' wurde nicht gefunden.",
                    resource.list_name()
                )
            })?;
        let items = list_items(
            &client,
            &token,
            &site.id,
            &list_id,
            resource,
            since.as_deref(),
        )
        .await?;
        downloaded += items.len();
        batches.push((resource, items));
    }
    token.zeroize();
    let synced_at = Utc::now().to_rfc3339();
    let mut conn = open_db(&app)?;
    let tx = conn.transaction().map_err(|error| error.to_string())?;
    if full_sync {
        tx.execute("DELETE FROM kfz_cache", [])
            .map_err(|error| error.to_string())?;
    }
    for (resource, items) in batches {
        for item in items {
            let id = item_id(&item);
            if id.is_empty() {
                continue;
            }
            tx.execute("INSERT INTO kfz_cache (entity_type, remote_id, modified_at, etag, payload) VALUES (?1, ?2, ?3, ?4, ?5) ON CONFLICT(entity_type, remote_id) DO UPDATE SET modified_at=excluded.modified_at, etag=excluded.etag, payload=excluded.payload",
                params![resource.cache_key(), id, modified(&item), item_etag(&item), map_resource(resource, &item)?]).map_err(|error| error.to_string())?;
        }
    }
    tx.execute("INSERT INTO kfz_sync_state (resource, last_synced_at, last_error) VALUES ('all', ?1, '') ON CONFLICT(resource) DO UPDATE SET last_synced_at=excluded.last_synced_at, last_error=''", [&synced_at]).map_err(|error| error.to_string())?;
    tx.commit().map_err(|error| error.to_string())?;
    Ok(KfzSyncResult {
        snapshot: load_snapshot(&app)?,
        downloaded,
        full_sync,
        synced_at,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn vehicle_mapping_accepts_existing_sharepoint_field_names() {
        let vehicle = map_vehicle(&json!({
            "id": "42",
            "eTag": "etag-1",
            "lastModifiedDateTime": "2026-08-12T10:00:00Z",
            "fields": {
                "Kennzeichen": "BB-DM 42",
                "Aktiv": true,
                "Kilometerstand": 12345,
                "StandortLookupId": "7",
                "Standort": "Aidlingen",
                "NaechsterTuev": "2026-10-01"
            }
        }));
        assert_eq!(vehicle.id, "42");
        assert_eq!(vehicle.kennzeichen, "BB-DM 42");
        assert_eq!(vehicle.kilometerstand, Some(12345));
        assert_eq!(vehicle.standort_id, "7");
        assert_eq!(vehicle.naechster_tuev.as_deref(), Some("2026-10-01"));
    }

    #[test]
    fn maintenance_mapping_keeps_vehicle_lookup_and_cost() {
        let maintenance = map_maintenance(&json!({
            "id": "8",
            "fields": {
                "Title": "Inspektion",
                "FahrzeugLookupId": "42",
                "Status": "Geplant",
                "Kosten": 349.5
            }
        }));
        assert_eq!(maintenance.title, "Inspektion");
        assert_eq!(maintenance.fahrzeug_id, "42");
        assert_eq!(maintenance.status, "Geplant");
        assert_eq!(maintenance.kosten, Some(349.5));
    }
}
