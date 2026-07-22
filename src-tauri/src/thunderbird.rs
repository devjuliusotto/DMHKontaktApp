use super::{now, open_db, ContactInput};
use chrono::{DateTime, SecondsFormat, Utc};
use rusqlite::types::ValueRef;
use rusqlite::{params, Connection, OpenFlags, Row, Transaction};
use serde::Serialize;
use std::collections::{HashMap, HashSet};
use std::env;
use std::fs;
use std::path::{Path, PathBuf};
use std::time::Duration;
use tauri::AppHandle;

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ThunderbirdContactImportResult {
    pub found: usize,
    pub imported: usize,
    pub linked_existing: usize,
    pub skipped_invalid: usize,
    pub address_books: usize,
    pub groups_used: usize,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ThunderbirdCalendarImportResult {
    pub found: usize,
    pub skipped_invalid: usize,
    pub calendars: usize,
    pub events: Vec<ThunderbirdCalendarEvent>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ThunderbirdCalendarEvent {
    pub id: String,
    pub title: String,
    pub starts_at: String,
    pub ends_at: String,
    pub location: String,
    pub description: String,
    pub color: String,
    pub category: String,
    pub source: String,
    pub recurrence: Option<ThunderbirdCalendarRecurrence>,
    pub excluded_dates: Vec<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub recurrence_master_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub recurrence_id: Option<String>,
}

#[derive(Debug, Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct ThunderbirdCalendarRecurrence {
    pub frequency: String,
    pub interval: u32,
    #[serde(skip_serializing_if = "Vec::is_empty")]
    pub days_of_week: Vec<u32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub day_of_month: Option<i32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub month_of_year: Option<u32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub week_of_month: Option<i32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub until: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub count: Option<u32>,
}

#[derive(Debug, Default, Clone)]
struct ThunderbirdCalendarSettings {
    name: String,
    color: String,
}

#[derive(Debug)]
struct ThunderbirdEventRow {
    calendar_id: String,
    item_id: String,
    title: String,
    status: String,
    flags: i64,
    starts_at: Option<i64>,
    ends_at: Option<i64>,
    start_timezone: String,
    end_timezone: String,
    recurrence_id: Option<i64>,
    recurrence_timezone: String,
}

#[derive(Debug)]
struct ThunderbirdBook {
    name: String,
    lists: HashMap<String, String>,
    contacts: Vec<ThunderbirdContact>,
}

#[derive(Debug)]
struct ThunderbirdContact {
    input: ContactInput,
    list_ids: Vec<String>,
}

#[derive(Default)]
struct VCardData {
    first_name: String,
    last_name: String,
    display_name: String,
    emails: Vec<(bool, String)>,
    work_phone: String,
    home_phone: String,
    mobile_phone: String,
    street: String,
    city: String,
    postal_code: String,
    country: String,
    organization: String,
    title: String,
    notes: String,
}

fn parse_ini_default_path(contents: &str) -> Option<String> {
    contents.lines().find_map(|line| {
        let (key, value) = line.trim().split_once('=')?;
        (key.eq_ignore_ascii_case("Default") && !value.trim().is_empty())
            .then(|| value.trim().replace('/', "\\"))
    })
}

fn parse_profiles_ini_default_path(contents: &str) -> Option<String> {
    let mut current_path: Option<String> = None;
    let mut first_path: Option<String> = None;
    for line in contents.lines() {
        let trimmed = line.trim();
        if trimmed.starts_with('[') {
            current_path = None;
            continue;
        }
        let Some((key, value)) = trimmed.split_once('=') else {
            continue;
        };
        if key.eq_ignore_ascii_case("Path") && !value.trim().is_empty() {
            let path = value.trim().replace('/', "\\");
            first_path.get_or_insert_with(|| path.clone());
            current_path = Some(path);
        } else if key.eq_ignore_ascii_case("Default") && value.trim() == "1" {
            if let Some(path) = current_path.clone() {
                return Some(path);
            }
        }
    }
    first_path
}

fn thunderbird_profile_path() -> Result<PathBuf, String> {
    let app_data = env::var_os("APPDATA")
        .ok_or_else(|| "Der Windows-Profilordner konnte nicht gefunden werden.".to_string())?;
    let thunderbird_root = PathBuf::from(app_data).join("Thunderbird");
    if !thunderbird_root.exists() {
        return Err(
            "Es wurde keine Thunderbird-Installation für diesen Windows-Benutzer gefunden."
                .to_string(),
        );
    }

    let installs_path = thunderbird_root.join("installs.ini");
    if let Ok(contents) = fs::read_to_string(&installs_path) {
        if let Some(relative) = parse_ini_default_path(&contents) {
            let path = thunderbird_root.join(relative);
            if path.is_dir() {
                return Ok(path);
            }
        }
    }

    let profiles_path = thunderbird_root.join("profiles.ini");
    let contents = fs::read_to_string(&profiles_path)
        .map_err(|err| format!("Das Thunderbird-Profil konnte nicht bestimmt werden: {err}"))?;
    if let Some(relative) = parse_profiles_ini_default_path(&contents) {
        let path = thunderbird_root.join(relative);
        if path.is_dir() {
            return Ok(path);
        }
    }

    Err("Das aktive Thunderbird-Profil wurde nicht gefunden.".to_string())
}

fn parse_pref_string(line: &str) -> Option<(String, String)> {
    let trimmed = line.trim();
    let rest = trimmed.strip_prefix("user_pref(\"")?;
    let (key, raw_value) = rest.split_once("\", ")?;
    let raw_value = raw_value.strip_suffix(");")?.trim();
    let value = serde_json::from_str::<String>(raw_value).ok()?;
    Some((key.to_string(), value))
}

fn address_book_names(profile: &Path) -> HashMap<String, String> {
    let mut names = HashMap::new();
    names.insert(
        "abook.sqlite".to_string(),
        "Persönliches Adressbuch".to_string(),
    );
    names.insert(
        "history.sqlite".to_string(),
        "Gesammelte Adressen".to_string(),
    );

    let Ok(contents) = fs::read_to_string(profile.join("prefs.js")) else {
        return names;
    };
    let mut servers: HashMap<String, HashMap<String, String>> = HashMap::new();
    for line in contents.lines() {
        let Some((key, value)) = parse_pref_string(line) else {
            continue;
        };
        let Some(rest) = key.strip_prefix("ldap_2.servers.") else {
            continue;
        };
        let Some((server, property)) = rest.rsplit_once('.') else {
            continue;
        };
        if property == "filename" || property == "description" {
            servers
                .entry(server.to_string())
                .or_default()
                .insert(property.to_string(), value);
        }
    }
    for values in servers.values() {
        let (Some(filename), Some(description)) =
            (values.get("filename"), values.get("description"))
        else {
            continue;
        };
        let safe_filename = Path::new(filename)
            .file_name()
            .map(|value| value.to_string_lossy().to_string())
            .unwrap_or_default();
        if !safe_filename.is_empty() && !description.trim().is_empty() {
            names.insert(safe_filename, description.trim().to_string());
        }
    }
    names
}

fn address_book_paths(
    profile: &Path,
    configured: &HashMap<String, String>,
) -> Result<Vec<PathBuf>, String> {
    let mut paths = Vec::new();
    let entries = fs::read_dir(profile)
        .map_err(|err| format!("Das Thunderbird-Profil konnte nicht gelesen werden: {err}"))?;
    for entry in entries {
        let entry = entry.map_err(|err| err.to_string())?;
        let path = entry.path();
        if !path.is_file() {
            continue;
        }
        let filename = entry.file_name().to_string_lossy().to_string();
        let lower = filename.to_lowercase();
        let is_address_book = configured.contains_key(&filename)
            || lower == "abook.sqlite"
            || lower == "history.sqlite"
            || (lower.starts_with("abook-") && lower.ends_with(".sqlite"));
        if is_address_book {
            paths.push(path);
        }
    }
    paths.sort();
    paths.dedup();
    Ok(paths)
}

fn fallback_book_name(path: &Path) -> String {
    let filename = path
        .file_stem()
        .map(|value| value.to_string_lossy().to_string())
        .unwrap_or_else(|| "Adressbuch".to_string());
    format!("Adressbuch {filename}")
}

fn split_escaped(value: &str, separator: char) -> Vec<String> {
    let mut parts = Vec::new();
    let mut current = String::new();
    let mut escaped = false;
    for character in value.chars() {
        if escaped {
            current.push('\\');
            current.push(character);
            escaped = false;
        } else if character == '\\' {
            escaped = true;
        } else if character == separator {
            parts.push(current);
            current = String::new();
        } else {
            current.push(character);
        }
    }
    if escaped {
        current.push('\\');
    }
    parts.push(current);
    parts
}

fn decode_vcard_text(value: &str) -> String {
    value
        .replace("\\n", "\n")
        .replace("\\N", "\n")
        .replace("\\,", ",")
        .replace("\\;", ";")
        .replace("\\\\", "\\")
        .trim()
        .to_string()
}

fn unfolded_vcard_lines(value: &str) -> Vec<String> {
    let mut lines: Vec<String> = Vec::new();
    for raw_line in value.replace("\r\n", "\n").replace('\r', "\n").split('\n') {
        if (raw_line.starts_with(' ') || raw_line.starts_with('\t')) && !lines.is_empty() {
            lines.last_mut().unwrap().push_str(raw_line.trim_start());
        } else {
            lines.push(raw_line.to_string());
        }
    }
    lines
}

fn parse_vcard(value: &str) -> VCardData {
    let mut data = VCardData::default();
    for line in unfolded_vcard_lines(value) {
        let Some((descriptor, raw_value)) = line.split_once(':') else {
            continue;
        };
        let descriptor_upper = descriptor.to_uppercase();
        let property_with_group = descriptor_upper.split(';').next().unwrap_or("");
        let property = property_with_group
            .rsplit('.')
            .next()
            .unwrap_or(property_with_group);
        let decoded = decode_vcard_text(raw_value);
        match property {
            "FN" if data.display_name.is_empty() => data.display_name = decoded,
            "N" => {
                let parts = split_escaped(raw_value, ';');
                if data.last_name.is_empty() {
                    data.last_name = parts
                        .first()
                        .map(|part| decode_vcard_text(part))
                        .unwrap_or_default();
                }
                if data.first_name.is_empty() {
                    data.first_name = parts
                        .get(1)
                        .map(|part| decode_vcard_text(part))
                        .unwrap_or_default();
                }
            }
            "EMAIL" if !decoded.is_empty() => {
                let preferred =
                    descriptor_upper.contains("PREF=1") || descriptor_upper.contains(";PREF;");
                data.emails
                    .push((preferred, decoded.trim_start_matches("mailto:").to_string()));
            }
            "TEL" if !decoded.is_empty() => {
                let phone = decoded.trim_start_matches("tel:").to_string();
                if descriptor_upper.contains("CELL") {
                    if data.mobile_phone.is_empty() {
                        data.mobile_phone = phone;
                    }
                } else if descriptor_upper.contains("HOME") {
                    if data.home_phone.is_empty() {
                        data.home_phone = phone;
                    }
                } else if data.work_phone.is_empty() {
                    data.work_phone = phone;
                }
            }
            "ADR" if data.street.is_empty() => {
                let parts = split_escaped(raw_value, ';');
                let extended = parts
                    .get(1)
                    .map(|part| decode_vcard_text(part))
                    .unwrap_or_default();
                let street = parts
                    .get(2)
                    .map(|part| decode_vcard_text(part))
                    .unwrap_or_default();
                data.street = [street, extended]
                    .into_iter()
                    .filter(|part| !part.is_empty())
                    .collect::<Vec<_>>()
                    .join("\n");
                data.city = parts
                    .get(3)
                    .map(|part| decode_vcard_text(part))
                    .unwrap_or_default();
                data.postal_code = parts
                    .get(5)
                    .map(|part| decode_vcard_text(part))
                    .unwrap_or_default();
                data.country = parts
                    .get(6)
                    .map(|part| decode_vcard_text(part))
                    .unwrap_or_default();
            }
            "ORG" if data.organization.is_empty() => {
                data.organization = split_escaped(raw_value, ';')
                    .into_iter()
                    .map(|part| decode_vcard_text(&part))
                    .filter(|part| !part.is_empty())
                    .collect::<Vec<_>>()
                    .join(" · ");
            }
            "TITLE" if data.title.is_empty() => data.title = decoded,
            "NOTE" if data.notes.is_empty() => data.notes = decoded,
            _ => {}
        }
    }
    data
}

fn property(properties: &HashMap<String, String>, name: &str) -> String {
    properties
        .get(name)
        .map(|value| value.trim().to_string())
        .unwrap_or_default()
}

fn first_non_empty(values: impl IntoIterator<Item = String>) -> String {
    values
        .into_iter()
        .find(|value| !value.trim().is_empty())
        .unwrap_or_default()
}

fn properties_to_contact(properties: &HashMap<String, String>) -> ContactInput {
    let vcard = parse_vcard(properties.get("_vCard").map(String::as_str).unwrap_or(""));
    let first_name = first_non_empty([property(properties, "FirstName"), vcard.first_name]);
    let last_name = first_non_empty([property(properties, "LastName"), vcard.last_name]);
    let display_name = first_non_empty([
        property(properties, "DisplayName"),
        vcard.display_name,
        format!("{} {}", first_name.trim(), last_name.trim())
            .trim()
            .to_string(),
    ]);
    let preferred_vcard_email = vcard
        .emails
        .iter()
        .find(|(preferred, _)| *preferred)
        .map(|(_, value)| value.clone());
    let first_vcard_email = vcard.emails.first().map(|(_, value)| value.clone());
    let email = first_non_empty([
        property(properties, "PrimaryEmail"),
        preferred_vcard_email.unwrap_or_default(),
        first_vcard_email.unwrap_or_default(),
        property(properties, "SecondEmail"),
    ])
    .to_lowercase();
    let phone = first_non_empty([
        property(properties, "WorkPhone"),
        property(properties, "HomePhone"),
        vcard.work_phone,
        vcard.home_phone,
    ]);
    let mobile_phone =
        first_non_empty([property(properties, "CellularNumber"), vcard.mobile_phone]);
    let work_street = [
        property(properties, "WorkAddress"),
        property(properties, "WorkAddress2"),
    ]
    .into_iter()
    .filter(|value| !value.is_empty())
    .collect::<Vec<_>>()
    .join("\n");
    let home_street = [
        property(properties, "HomeAddress"),
        property(properties, "HomeAddress2"),
    ]
    .into_iter()
    .filter(|value| !value.is_empty())
    .collect::<Vec<_>>()
    .join("\n");
    let street = first_non_empty([work_street, home_street, vcard.street]);
    let postal_code = first_non_empty([
        property(properties, "WorkZipCode"),
        property(properties, "HomeZipCode"),
        vcard.postal_code,
    ]);
    let city = first_non_empty([
        property(properties, "WorkCity"),
        property(properties, "HomeCity"),
        vcard.city,
    ]);
    let country = first_non_empty([
        property(properties, "WorkCountry"),
        property(properties, "HomeCountry"),
        vcard.country,
    ]);
    let short_info = [
        first_non_empty([property(properties, "Company"), vcard.organization]),
        first_non_empty([property(properties, "JobTitle"), vcard.title]),
    ]
    .into_iter()
    .filter(|value| !value.is_empty())
    .collect::<Vec<_>>()
    .join(" · ");
    let mut notes = first_non_empty([property(properties, "Notes"), vcard.notes]);
    let primary_email_lower = email.to_lowercase();
    let mut additional_emails: Vec<String> = vcard
        .emails
        .into_iter()
        .map(|(_, value)| value)
        .chain(std::iter::once(property(properties, "SecondEmail")))
        .filter(|value| !value.is_empty() && value.to_lowercase() != primary_email_lower)
        .collect::<HashSet<_>>()
        .into_iter()
        .collect();
    additional_emails.sort_by_key(|value| value.to_lowercase());
    if !additional_emails.is_empty() {
        if !notes.is_empty() {
            notes.push_str("\n\n");
        }
        notes.push_str(&format!(
            "Weitere E-Mail-Adressen: {}",
            additional_emails.join(", ")
        ));
    }

    ContactInput {
        id: None,
        first_name,
        last_name,
        display_name,
        email,
        phone,
        mobile_phone,
        street,
        postal_code,
        city,
        country,
        short_info,
        notes,
        group_ids: Vec::new(),
    }
}

fn read_book(path: &Path, name: String) -> Result<ThunderbirdBook, String> {
    let connection = Connection::open_with_flags(
        path,
        OpenFlags::SQLITE_OPEN_READ_ONLY | OpenFlags::SQLITE_OPEN_NO_MUTEX,
    )
    .map_err(|err| {
        format!("Thunderbird-Adressbuch „{name}“ konnte nicht geöffnet werden: {err}")
    })?;
    connection
        .busy_timeout(Duration::from_secs(5))
        .map_err(|err| err.to_string())?;

    let mut properties_by_card: HashMap<String, HashMap<String, String>> = HashMap::new();
    let mut statement = connection
        .prepare("SELECT card, name, value FROM properties")
        .map_err(|err| {
            format!("Thunderbird-Adressbuch „{name}“ hat ein unbekanntes Format: {err}")
        })?;
    let rows = statement
        .query_map([], |row| {
            Ok((
                row.get::<_, String>(0)?,
                row.get::<_, String>(1)?,
                row.get::<_, String>(2)?,
            ))
        })
        .map_err(|err| err.to_string())?;
    for row in rows {
        let (card, property_name, value) = row.map_err(|err| err.to_string())?;
        properties_by_card
            .entry(card)
            .or_default()
            .insert(property_name, value);
    }
    drop(statement);

    let mut lists = HashMap::new();
    if let Ok(mut statement) = connection.prepare("SELECT uid, name FROM lists") {
        let rows = statement
            .query_map([], |row| {
                Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?))
            })
            .map_err(|err| err.to_string())?;
        for row in rows {
            let (uid, list_name) = row.map_err(|err| err.to_string())?;
            if !list_name.trim().is_empty() {
                lists.insert(uid, list_name.trim().to_string());
            }
        }
    }

    let mut card_lists: HashMap<String, Vec<String>> = HashMap::new();
    if let Ok(mut statement) = connection.prepare("SELECT list, card FROM list_cards") {
        let rows = statement
            .query_map([], |row| {
                Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?))
            })
            .map_err(|err| err.to_string())?;
        for row in rows {
            let (list, card) = row.map_err(|err| err.to_string())?;
            card_lists.entry(card).or_default().push(list);
        }
    }

    let contacts = properties_by_card
        .into_iter()
        .map(|(card, properties)| ThunderbirdContact {
            input: properties_to_contact(&properties),
            list_ids: card_lists.remove(&card).unwrap_or_default(),
        })
        .collect();

    Ok(ThunderbirdBook {
        name,
        lists,
        contacts,
    })
}

fn read_thunderbird_books() -> Result<Vec<ThunderbirdBook>, String> {
    let profile = thunderbird_profile_path()?;
    let configured_names = address_book_names(&profile);
    let paths = address_book_paths(&profile, &configured_names)?;
    if paths.is_empty() {
        return Err(
            "Im aktiven Thunderbird-Profil wurden keine lokalen Adressbücher gefunden.".to_string(),
        );
    }
    paths
        .into_iter()
        .map(|path| {
            let filename = path
                .file_name()
                .map(|value| value.to_string_lossy().to_string())
                .unwrap_or_default();
            let name = configured_names
                .get(&filename)
                .cloned()
                .unwrap_or_else(|| fallback_book_name(&path));
            read_book(&path, name)
        })
        .collect()
}

fn normalized_phone(value: &str) -> String {
    value
        .chars()
        .filter(|character| character.is_ascii_digit())
        .collect()
}

fn no_email_key(contact: &ContactInput) -> Option<String> {
    let name = contact.display_name.trim().to_lowercase();
    let phone = first_non_empty([
        normalized_phone(&contact.mobile_phone),
        normalized_phone(&contact.phone),
    ]);
    (!name.is_empty() && !phone.is_empty()).then(|| format!("{name}|{phone}"))
}

fn existing_contact_indexes(
    tx: &Transaction<'_>,
) -> Result<(HashMap<String, i64>, HashMap<String, i64>), String> {
    let mut emails = HashMap::new();
    let mut without_email = HashMap::new();
    let mut statement = tx.prepare(
        "SELECT id, display_name, email, phone, mobile_phone FROM contacts WHERE deleted_at IS NULL"
    ).map_err(|err| err.to_string())?;
    let rows = statement
        .query_map([], |row| {
            Ok((
                row.get::<_, i64>(0)?,
                row.get::<_, String>(1)?,
                row.get::<_, String>(2)?,
                row.get::<_, String>(3)?,
                row.get::<_, String>(4)?,
            ))
        })
        .map_err(|err| err.to_string())?;
    for row in rows {
        let (id, display_name, email, phone, mobile_phone) = row.map_err(|err| err.to_string())?;
        if !email.trim().is_empty() {
            emails.entry(email.trim().to_lowercase()).or_insert(id);
        } else {
            let key_contact = ContactInput {
                id: None,
                first_name: String::new(),
                last_name: String::new(),
                display_name,
                email,
                phone,
                mobile_phone,
                street: String::new(),
                postal_code: String::new(),
                city: String::new(),
                country: String::new(),
                short_info: String::new(),
                notes: String::new(),
                group_ids: Vec::new(),
            };
            if let Some(key) = no_email_key(&key_contact) {
                without_email.entry(key).or_insert(id);
            }
        }
    }
    Ok((emails, without_email))
}

fn ensure_group(
    tx: &Transaction<'_>,
    groups: &mut HashMap<String, i64>,
    name: &str,
    description: &str,
    timestamp: &str,
) -> Result<i64, String> {
    if let Some(id) = groups.get(name) {
        return Ok(*id);
    }
    tx.execute(
        "INSERT INTO groups (name, description, created_at, updated_at, deleted_at)
         VALUES (?, ?, ?, ?, NULL)
         ON CONFLICT(name) DO UPDATE SET updated_at = excluded.updated_at, deleted_at = NULL",
        params![name, description, timestamp, timestamp],
    )
    .map_err(|err| err.to_string())?;
    let id = tx
        .query_row(
            "SELECT id FROM groups WHERE name = ?",
            params![name],
            |row| row.get(0),
        )
        .map_err(|err| err.to_string())?;
    groups.insert(name.to_string(), id);
    Ok(id)
}

#[tauri::command]
pub fn import_thunderbird_contacts_once(
    app: AppHandle,
) -> Result<ThunderbirdContactImportResult, String> {
    let books = read_thunderbird_books()?;
    let found = books.iter().map(|book| book.contacts.len()).sum();
    let address_books = books.len();
    let mut connection = open_db(&app)?;
    let tx = connection.transaction().map_err(|err| err.to_string())?;
    let timestamp = now();
    let batch_id = format!("thunderbird-import-{}", Utc::now().timestamp_millis());
    let (mut emails, mut without_email) = existing_contact_indexes(&tx)?;
    let mut groups = HashMap::new();
    let mut imported = 0usize;
    let mut linked_existing_ids = HashSet::new();
    let mut skipped_invalid = 0usize;

    for book in books {
        let book_group_name = format!("Thunderbird – {}", book.name);
        let book_group_id = ensure_group(
            &tx,
            &mut groups,
            &book_group_name,
            &format!(
                "Automatisch aus dem Thunderbird-Adressbuch „{}“ übernommen.",
                book.name
            ),
            &timestamp,
        )?;
        let mut list_group_ids = HashMap::new();
        for (list_id, list_name) in &book.lists {
            let group_name = format!("{book_group_name} / {list_name}");
            let id = ensure_group(
                &tx,
                &mut groups,
                &group_name,
                &format!(
                    "Thunderbird-Liste „{list_name}“ im Adressbuch „{}“.",
                    book.name
                ),
                &timestamp,
            )?;
            list_group_ids.insert(list_id.clone(), id);
        }

        for mut source_contact in book.contacts {
            let contact = &mut source_contact.input;
            if contact.display_name.trim().is_empty()
                && contact.email.trim().is_empty()
                && contact.phone.trim().is_empty()
                && contact.mobile_phone.trim().is_empty()
            {
                skipped_invalid += 1;
                continue;
            }
            let email_key = contact.email.trim().to_lowercase();
            let no_email = no_email_key(contact);
            let existing_id = if !email_key.is_empty() {
                emails.get(&email_key).copied()
            } else {
                no_email
                    .as_ref()
                    .and_then(|key| without_email.get(key).copied())
            };
            let contact_id = if let Some(id) = existing_id {
                linked_existing_ids.insert(id);
                id
            } else {
                tx.execute(
                    "INSERT INTO contacts (
                        first_name, last_name, display_name, email, phone, mobile_phone, street,
                        postal_code, city, country, short_info, notes, import_batch_id, created_at, updated_at
                     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
                    params![
                        contact.first_name, contact.last_name, contact.display_name, contact.email,
                        contact.phone, contact.mobile_phone, contact.street, contact.postal_code,
                        contact.city, contact.country, contact.short_info, contact.notes,
                        batch_id, timestamp, timestamp,
                    ],
                ).map_err(|err| err.to_string())?;
                let id = tx.last_insert_rowid();
                if !email_key.is_empty() {
                    emails.insert(email_key.clone(), id);
                }
                if let Some(key) = no_email {
                    without_email.insert(key, id);
                }
                imported += 1;
                id
            };

            tx.execute(
                "INSERT OR IGNORE INTO contact_groups (contact_id, group_id) VALUES (?, ?)",
                params![contact_id, book_group_id],
            )
            .map_err(|err| err.to_string())?;
            for list_id in source_contact.list_ids {
                if let Some(group_id) = list_group_ids.get(&list_id) {
                    tx.execute(
                        "INSERT OR IGNORE INTO contact_groups (contact_id, group_id) VALUES (?, ?)",
                        params![contact_id, group_id],
                    )
                    .map_err(|err| err.to_string())?;
                }
            }
        }
    }

    if imported > 0 {
        tx.execute(
            "INSERT INTO import_history (batch_id, source_file, imported_count, skipped_count, created_at)
             VALUES (?, ?, ?, ?, ?)",
            params![batch_id, "Thunderbird (automatischer Kontaktimport)", imported as i64, skipped_invalid as i64, timestamp],
        ).map_err(|err| err.to_string())?;
    }
    tx.commit().map_err(|err| err.to_string())?;

    Ok(ThunderbirdContactImportResult {
        found,
        imported,
        linked_existing: linked_existing_ids.len(),
        skipped_invalid,
        address_books,
        groups_used: groups.len(),
    })
}

fn calendar_settings(profile: &Path) -> HashMap<String, ThunderbirdCalendarSettings> {
    let Ok(contents) = fs::read_to_string(profile.join("prefs.js")) else {
        return HashMap::new();
    };
    let mut calendars: HashMap<String, ThunderbirdCalendarSettings> = HashMap::new();
    for line in contents.lines() {
        let Some((key, value)) = parse_pref_string(line) else {
            continue;
        };
        let Some(rest) = key.strip_prefix("calendar.registry.") else {
            continue;
        };
        let Some((calendar_id, property_name)) = rest.rsplit_once('.') else {
            continue;
        };
        let settings = calendars.entry(calendar_id.to_string()).or_default();
        match property_name {
            "name" => settings.name = value.trim().to_string(),
            "color" => settings.color = value.trim().to_string(),
            _ => {}
        }
    }
    calendars
}

fn normalized_category_key(value: &str) -> String {
    value
        .chars()
        .flat_map(char::to_lowercase)
        .filter(|character| character.is_alphanumeric())
        .collect()
}

fn calendar_category_colors(profile: &Path) -> HashMap<String, String> {
    let Ok(contents) = fs::read_to_string(profile.join("prefs.js")) else {
        return HashMap::new();
    };
    contents
        .lines()
        .filter_map(parse_pref_string)
        .filter_map(|(key, value)| {
            let category = key.strip_prefix("calendar.category.color.")?;
            let normalized = normalized_category_key(category);
            (!normalized.is_empty()).then_some((normalized, value))
        })
        .collect()
}

fn sqlite_text(row: &Row<'_>, index: usize) -> rusqlite::Result<String> {
    Ok(match row.get_ref(index)? {
        ValueRef::Null => String::new(),
        ValueRef::Text(value) | ValueRef::Blob(value) => String::from_utf8_lossy(value).to_string(),
        ValueRef::Integer(value) => value.to_string(),
        ValueRef::Real(value) => value.to_string(),
    })
}

fn read_thunderbird_event_rows(
    connection: &Connection,
) -> Result<Vec<ThunderbirdEventRow>, String> {
    let mut statement = connection
        .prepare(
            "SELECT cal_id, id, title, ical_status, flags, event_start, event_end,
                    event_start_tz, event_end_tz, recurrence_id, recurrence_id_tz
             FROM cal_events
             WHERE COALESCE(offline_journal, 0) != 3",
        )
        .map_err(|err| format!("Thunderbird-Kalender haben ein unbekanntes Format: {err}"))?;
    let rows = statement
        .query_map([], |row| {
            Ok(ThunderbirdEventRow {
                calendar_id: row.get(0)?,
                item_id: row.get(1)?,
                title: row.get::<_, Option<String>>(2)?.unwrap_or_default(),
                status: row.get::<_, Option<String>>(3)?.unwrap_or_default(),
                flags: row.get::<_, Option<i64>>(4)?.unwrap_or_default(),
                starts_at: row.get(5)?,
                ends_at: row.get(6)?,
                start_timezone: row.get::<_, Option<String>>(7)?.unwrap_or_default(),
                end_timezone: row.get::<_, Option<String>>(8)?.unwrap_or_default(),
                recurrence_id: row.get(9)?,
                recurrence_timezone: row.get::<_, Option<String>>(10)?.unwrap_or_default(),
            })
        })
        .map_err(|err| err.to_string())?;
    rows.collect::<Result<Vec<_>, _>>()
        .map_err(|err| err.to_string())
}

type CalendarPropertyKey = (String, String, Option<i64>);

fn read_thunderbird_calendar_properties(
    connection: &Connection,
) -> Result<HashMap<CalendarPropertyKey, HashMap<String, String>>, String> {
    let mut properties: HashMap<CalendarPropertyKey, HashMap<String, String>> = HashMap::new();
    let mut statement = connection
        .prepare("SELECT cal_id, item_id, recurrence_id, key, value FROM cal_properties")
        .map_err(|err| err.to_string())?;
    let rows = statement
        .query_map([], |row| {
            Ok((
                row.get::<_, String>(0)?,
                row.get::<_, String>(1)?,
                row.get::<_, Option<i64>>(2)?,
                row.get::<_, String>(3)?,
                sqlite_text(row, 4)?,
            ))
        })
        .map_err(|err| err.to_string())?;
    for row in rows {
        let (calendar_id, item_id, recurrence_id, key, value) =
            row.map_err(|err| err.to_string())?;
        properties
            .entry((calendar_id, item_id, recurrence_id))
            .or_default()
            .insert(key.to_uppercase(), value);
    }
    Ok(properties)
}

fn read_thunderbird_recurrences(
    connection: &Connection,
) -> Result<HashMap<(String, String), Vec<String>>, String> {
    let mut recurrences: HashMap<(String, String), Vec<String>> = HashMap::new();
    let mut statement = connection
        .prepare("SELECT cal_id, item_id, icalString FROM cal_recurrence")
        .map_err(|err| err.to_string())?;
    let rows = statement
        .query_map([], |row| {
            Ok((
                row.get::<_, String>(0)?,
                row.get::<_, String>(1)?,
                row.get::<_, String>(2)?,
            ))
        })
        .map_err(|err| err.to_string())?;
    for row in rows {
        let (calendar_id, item_id, ical_string) = row.map_err(|err| err.to_string())?;
        recurrences
            .entry((calendar_id, item_id))
            .or_default()
            .push(ical_string);
    }
    Ok(recurrences)
}

fn native_time_to_iso(value: i64, timezone: &str, all_day: bool) -> Option<String> {
    let date = DateTime::<Utc>::from_timestamp_micros(value)?;
    if all_day || timezone.eq_ignore_ascii_case("floating") {
        Some(date.format("%Y-%m-%dT%H:%M:%S").to_string())
    } else {
        Some(date.to_rfc3339_opts(SecondsFormat::Secs, true))
    }
}

fn ical_date_key(value: &str) -> Option<String> {
    let digits: String = value
        .chars()
        .filter(|character| character.is_ascii_digit())
        .collect();
    if digits.len() < 8 {
        return None;
    }
    Some(format!(
        "{}-{}-{}",
        &digits[0..4],
        &digits[4..6],
        &digits[6..8]
    ))
}

fn recurrence_property_value(line: &str) -> &str {
    line.split_once(':').map(|(_, value)| value).unwrap_or(line)
}

fn parse_thunderbird_recurrence(lines: &[String]) -> Option<ThunderbirdCalendarRecurrence> {
    let rrule = lines.iter().find(|line| {
        line.trim_start().to_uppercase().starts_with("RRULE:")
            || line.trim_start().to_uppercase().starts_with("RRULE;")
    })?;
    let values: HashMap<String, String> = recurrence_property_value(rrule)
        .split(';')
        .filter_map(|part| part.split_once('='))
        .map(|(key, value)| (key.to_uppercase(), value.to_string()))
        .collect();
    let frequency = values.get("FREQ")?.to_lowercase();
    if !matches!(
        frequency.as_str(),
        "daily" | "weekly" | "monthly" | "yearly"
    ) {
        return None;
    }
    let by_day: Vec<&str> = values
        .get("BYDAY")
        .map(|value| value.split(',').filter(|entry| !entry.is_empty()).collect())
        .unwrap_or_default();
    let weekday_number = |value: &str| match value {
        "SU" => Some(0),
        "MO" => Some(1),
        "TU" => Some(2),
        "WE" => Some(3),
        "TH" => Some(4),
        "FR" => Some(5),
        "SA" => Some(6),
        _ => None,
    };
    let days_of_week = by_day
        .iter()
        .filter_map(|entry| {
            let code = entry.get(entry.len().saturating_sub(2)..)?.to_uppercase();
            weekday_number(&code)
        })
        .collect();
    let ordinal = by_day.first().and_then(|entry| {
        entry
            .get(..entry.len().saturating_sub(2))
            .filter(|value| !value.is_empty())
            .and_then(|value| value.parse::<i32>().ok())
    });
    let number = |key: &str| values.get(key).and_then(|value| value.parse::<u32>().ok());
    let signed_number = |key: &str| values.get(key).and_then(|value| value.parse::<i32>().ok());
    Some(ThunderbirdCalendarRecurrence {
        frequency,
        interval: number("INTERVAL").unwrap_or(1).max(1),
        days_of_week,
        day_of_month: signed_number("BYMONTHDAY"),
        month_of_year: number("BYMONTH"),
        week_of_month: signed_number("BYSETPOS").or(ordinal),
        until: values.get("UNTIL").and_then(|value| ical_date_key(value)),
        count: number("COUNT"),
    })
}

fn recurrence_excluded_dates(lines: &[String]) -> HashSet<String> {
    lines
        .iter()
        .filter(|line| {
            let upper = line.trim_start().to_uppercase();
            upper.starts_with("EXDATE:") || upper.starts_with("EXDATE;")
        })
        .flat_map(|line| recurrence_property_value(line).split(','))
        .filter_map(ical_date_key)
        .collect()
}

fn calendar_color_name(hex: &str) -> String {
    let value = hex.trim().trim_start_matches('#');
    if value.len() < 6 {
        return "blue".to_string();
    }
    let Ok(rgb) = u32::from_str_radix(&value[..6], 16) else {
        return "blue".to_string();
    };
    let red = ((rgb >> 16) & 255) as i64;
    let green = ((rgb >> 8) & 255) as i64;
    let blue = (rgb & 255) as i64;
    let candidates = [
        ("blue", 0x25, 0x63, 0xeb),
        ("green", 0x15, 0x80, 0x3d),
        ("yellow", 0xca, 0x8a, 0x04),
        ("red", 0xdc, 0x26, 0x26),
        ("purple", 0x7c, 0x3a, 0xed),
        ("gray", 0x64, 0x74, 0x8b),
    ];
    candidates
        .into_iter()
        .min_by_key(|(_, target_red, target_green, target_blue)| {
            (red - target_red).pow(2) + (green - target_green).pow(2) + (blue - target_blue).pow(2)
        })
        .map(|(name, _, _, _)| name.to_string())
        .unwrap_or_else(|| "blue".to_string())
}

fn calendar_event_id(calendar_id: &str, item_id: &str) -> String {
    format!("thunderbird:{calendar_id}:{item_id}")
}

fn combined_property(
    properties: &HashMap<CalendarPropertyKey, HashMap<String, String>>,
    row: &ThunderbirdEventRow,
    key: &str,
) -> String {
    properties
        .get(&(
            row.calendar_id.clone(),
            row.item_id.clone(),
            row.recurrence_id,
        ))
        .and_then(|values| values.get(key))
        .or_else(|| {
            properties
                .get(&(row.calendar_id.clone(), row.item_id.clone(), None))
                .and_then(|values| values.get(key))
        })
        .cloned()
        .unwrap_or_default()
}

fn event_from_thunderbird_row(
    row: &ThunderbirdEventRow,
    settings: &ThunderbirdCalendarSettings,
    properties: &HashMap<CalendarPropertyKey, HashMap<String, String>>,
    category_colors: &HashMap<String, String>,
    recurrence: Option<ThunderbirdCalendarRecurrence>,
    excluded_dates: Vec<String>,
    recurrence_master_id: Option<String>,
    recurrence_id: Option<String>,
) -> Option<ThunderbirdCalendarEvent> {
    let all_day = row.flags & 8 == 8;
    let starts_at = native_time_to_iso(row.starts_at?, &row.start_timezone, all_day)?;
    let ends_at = native_time_to_iso(
        row.ends_at.unwrap_or(row.starts_at?),
        &row.end_timezone,
        all_day,
    )?;
    let calendar_name = if settings.name.trim().is_empty() {
        "Thunderbird-Kalender"
    } else {
        settings.name.trim()
    };
    let raw_category = combined_property(properties, row, "CATEGORIES");
    let category = raw_category
        .split(',')
        .map(str::trim)
        .find(|value| !value.is_empty())
        .unwrap_or(calendar_name)
        .to_string();
    let title = if row.title.trim().is_empty() {
        "Ohne Titel".to_string()
    } else {
        row.title.trim().to_string()
    };
    Some(ThunderbirdCalendarEvent {
        id: recurrence_id
            .as_ref()
            .map(|value| {
                format!(
                    "{}::{value}",
                    calendar_event_id(&row.calendar_id, &row.item_id)
                )
            })
            .unwrap_or_else(|| calendar_event_id(&row.calendar_id, &row.item_id)),
        title,
        starts_at,
        ends_at,
        location: combined_property(properties, row, "LOCATION"),
        description: combined_property(properties, row, "DESCRIPTION"),
        color: calendar_color_name(
            category_colors
                .get(&normalized_category_key(&category))
                .map(String::as_str)
                .unwrap_or(&settings.color),
        ),
        category,
        source: format!("Thunderbird – {calendar_name}"),
        recurrence,
        excluded_dates,
        recurrence_master_id,
        recurrence_id,
    })
}

fn read_thunderbird_calendar_data() -> Result<ThunderbirdCalendarImportResult, String> {
    let profile = thunderbird_profile_path()?;
    let database_path = profile.join("calendar-data").join("local.sqlite");
    if !database_path.is_file() {
        return Err(
            "Im aktiven Thunderbird-Profil wurde keine Kalenderdatenbank gefunden.".to_string(),
        );
    }
    let connection = Connection::open_with_flags(
        &database_path,
        OpenFlags::SQLITE_OPEN_READ_ONLY | OpenFlags::SQLITE_OPEN_NO_MUTEX,
    )
    .map_err(|err| {
        format!("Die Thunderbird-Kalenderdatenbank konnte nicht geöffnet werden: {err}")
    })?;
    connection
        .busy_timeout(Duration::from_secs(5))
        .map_err(|err| err.to_string())?;
    let rows = read_thunderbird_event_rows(&connection)?;
    let found = rows.len();
    let properties = read_thunderbird_calendar_properties(&connection)?;
    let recurrence_lines = read_thunderbird_recurrences(&connection)?;
    let configured_calendars = calendar_settings(&profile);
    let category_colors = calendar_category_colors(&profile);
    let calendar_ids: HashSet<String> = rows.iter().map(|row| row.calendar_id.clone()).collect();
    let master_keys: HashSet<(String, String)> = rows
        .iter()
        .filter(|row| row.recurrence_id.is_none())
        .map(|row| (row.calendar_id.clone(), row.item_id.clone()))
        .collect();
    let mut exclusions: HashMap<(String, String), HashSet<String>> = HashMap::new();
    for (key, lines) in &recurrence_lines {
        exclusions
            .entry(key.clone())
            .or_default()
            .extend(recurrence_excluded_dates(lines));
    }
    for row in rows.iter().filter(|row| row.recurrence_id.is_some()) {
        let Some(recurrence_id) = row.recurrence_id.and_then(|value| {
            native_time_to_iso(value, &row.recurrence_timezone, row.flags & 512 == 512)
        }) else {
            continue;
        };
        exclusions
            .entry((row.calendar_id.clone(), row.item_id.clone()))
            .or_default()
            .insert(recurrence_id[..10].to_string());
    }

    let mut skipped_invalid = 0usize;
    let mut events = Vec::new();
    let mut supported_recurrence_masters = HashSet::new();
    for row in rows.iter().filter(|row| row.recurrence_id.is_none()) {
        if row.status.eq_ignore_ascii_case("CANCELLED") {
            continue;
        }
        let key = (row.calendar_id.clone(), row.item_id.clone());
        let recurrence = recurrence_lines
            .get(&key)
            .and_then(|lines| parse_thunderbird_recurrence(lines));
        if recurrence.is_some() {
            supported_recurrence_masters.insert(key.clone());
        } else if recurrence_lines.contains_key(&key) {
            skipped_invalid += 1;
        }
        let settings = configured_calendars
            .get(&row.calendar_id)
            .cloned()
            .unwrap_or_default();
        let excluded_dates = exclusions
            .get(&key)
            .map(|dates| {
                let mut values: Vec<String> = dates.iter().cloned().collect();
                values.sort();
                values
            })
            .unwrap_or_default();
        if let Some(event) = event_from_thunderbird_row(
            row,
            &settings,
            &properties,
            &category_colors,
            recurrence,
            excluded_dates,
            None,
            None,
        ) {
            events.push(event);
        } else {
            skipped_invalid += 1;
        }
    }

    for row in rows.iter().filter(|row| row.recurrence_id.is_some()) {
        let key = (row.calendar_id.clone(), row.item_id.clone());
        if row.status.eq_ignore_ascii_case("CANCELLED") {
            continue;
        }
        if !master_keys.contains(&key) || !supported_recurrence_masters.contains(&key) {
            skipped_invalid += 1;
            continue;
        }
        let Some(recurrence_id) = row.recurrence_id.and_then(|value| {
            native_time_to_iso(value, &row.recurrence_timezone, row.flags & 512 == 512)
        }) else {
            skipped_invalid += 1;
            continue;
        };
        let settings = configured_calendars
            .get(&row.calendar_id)
            .cloned()
            .unwrap_or_default();
        if let Some(event) = event_from_thunderbird_row(
            row,
            &settings,
            &properties,
            &category_colors,
            None,
            Vec::new(),
            Some(calendar_event_id(&row.calendar_id, &row.item_id)),
            Some(recurrence_id),
        ) {
            events.push(event);
        } else {
            skipped_invalid += 1;
        }
    }
    events.sort_by(|left, right| left.starts_at.cmp(&right.starts_at));
    Ok(ThunderbirdCalendarImportResult {
        found,
        skipped_invalid,
        calendars: calendar_ids.len().max(configured_calendars.len()),
        events,
    })
}

#[tauri::command]
pub fn import_thunderbird_calendars_once() -> Result<ThunderbirdCalendarImportResult, String> {
    read_thunderbird_calendar_data()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_modern_vcard_fields() {
        let card = "BEGIN:VCARD\r\nVERSION:4.0\r\nN:Mustermann;Erika;;;\r\nFN:Erika Mustermann\r\nEMAIL;PREF=1:erika@example.org\r\nTEL;TYPE=cell:+49 170 123456\r\nADR;TYPE=work:;;Hauptstr. 1;Aidlingen;;71134;Deutschland\r\nORG:DMH;Verwaltung\r\nEND:VCARD";
        let parsed = parse_vcard(card);
        assert_eq!(parsed.first_name, "Erika");
        assert_eq!(parsed.last_name, "Mustermann");
        assert_eq!(parsed.emails[0].1, "erika@example.org");
        assert_eq!(parsed.mobile_phone, "+49 170 123456");
        assert_eq!(parsed.city, "Aidlingen");
        assert_eq!(parsed.organization, "DMH · Verwaltung");
    }

    #[test]
    fn finds_default_profile_path() {
        let profiles = "[Profile1]\nName=default\nIsRelative=1\nPath=Profiles/default\nDefault=1\n\n[Profile0]\nPath=Profiles/release";
        assert_eq!(
            parse_profiles_ini_default_path(profiles).as_deref(),
            Some("Profiles\\default")
        );
    }

    #[test]
    fn parses_thunderbird_recurrence_rules_and_exclusions() {
        let lines = vec![
            "RRULE:FREQ=MONTHLY;INTERVAL=6;BYDAY=2TU;COUNT=8".to_string(),
            "EXDATE;TZID=Europe/Berlin:20270112T090000,20270713T090000".to_string(),
        ];
        let recurrence = parse_thunderbird_recurrence(&lines).unwrap();
        assert_eq!(recurrence.frequency, "monthly");
        assert_eq!(recurrence.interval, 6);
        assert_eq!(recurrence.days_of_week, vec![2]);
        assert_eq!(recurrence.week_of_month, Some(2));
        assert_eq!(recurrence.count, Some(8));
        let exclusions = recurrence_excluded_dates(&lines);
        assert!(exclusions.contains("2027-01-12"));
        assert!(exclusions.contains("2027-07-13"));
    }
}
