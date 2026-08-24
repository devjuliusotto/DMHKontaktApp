use std::collections::HashMap;
use std::fs;
use std::path::{Path, PathBuf};
use std::time::SystemTime;

const STREAM_MAGIC: u32 = 0xBAADF00D;
const STREAM_MAJOR_VERSION: u32 = 12;
const MAX_STREAM_BYTES: u64 = 16 * 1024 * 1024;
const MAX_ROWS: usize = 10_000;
const MAX_PROPERTIES_PER_ROW: usize = 512;
const MAX_DYNAMIC_VALUE_BYTES: usize = 4 * 1024 * 1024;

const PR_DISPLAY_NAME: u16 = 0x3001;
const PR_EMAIL_ADDRESS: u16 = 0x3003;
const PR_SMTP_ADDRESS: u16 = 0x39FE;
const PR_NICK_NAME: u16 = 0x6001;
const PR_DROPDOWN_DISPLAY_NAME: u16 = 0x6003;
const PR_NICK_NAME_WEIGHT: u16 = 0x6004;

const PT_I2: u16 = 0x0002;
const PT_LONG: u16 = 0x0003;
const PT_R4: u16 = 0x0004;
const PT_DOUBLE: u16 = 0x0005;
const PT_CURRENCY: u16 = 0x0006;
const PT_APPTIME: u16 = 0x0007;
const PT_ERROR: u16 = 0x000A;
const PT_BOOLEAN: u16 = 0x000B;
const PT_SYSTIME: u16 = 0x0040;
const PT_I8: u16 = 0x0014;
const PT_STRING8: u16 = 0x001E;
const PT_UNICODE: u16 = 0x001F;
const PT_CLSID: u16 = 0x0048;
const PT_BINARY: u16 = 0x0102;

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct OutlookAutocompleteEntry {
    pub display_name: String,
    pub email: String,
    pub weight: u32,
}

#[derive(Debug, Default)]
pub struct OutlookAutocompleteReadResult {
    pub entries: Vec<OutlookAutocompleteEntry>,
    pub files_read: usize,
    pub warnings: Vec<String>,
}

#[derive(Debug, Default)]
struct ParsedRow {
    display_name: String,
    dropdown_display_name: String,
    nickname: String,
    email_address: String,
    smtp_address: String,
    weight: u32,
}

#[derive(Debug)]
enum PropertyValue {
    None,
    Long(u32),
    Text(String),
}

struct StreamReader<'a> {
    bytes: &'a [u8],
    offset: usize,
}

impl<'a> StreamReader<'a> {
    fn new(bytes: &'a [u8]) -> Self {
        Self { bytes, offset: 0 }
    }

    fn remaining(&self) -> usize {
        self.bytes.len().saturating_sub(self.offset)
    }

    fn read_exact(&mut self, length: usize) -> Result<&'a [u8], String> {
        let end = self
            .offset
            .checked_add(length)
            .ok_or_else(|| "Ungültige Längenangabe im Outlook-Cache.".to_string())?;
        if end > self.bytes.len() {
            return Err("Der Outlook-Autovervollständigungs-Cache ist unvollständig.".to_string());
        }
        let value = &self.bytes[self.offset..end];
        self.offset = end;
        Ok(value)
    }

    fn skip(&mut self, length: usize) -> Result<(), String> {
        self.read_exact(length).map(|_| ())
    }

    fn read_u32(&mut self) -> Result<u32, String> {
        let bytes = self.read_exact(4)?;
        Ok(u32::from_le_bytes([bytes[0], bytes[1], bytes[2], bytes[3]]))
    }

    fn read_count(&mut self, maximum: usize, label: &str) -> Result<usize, String> {
        let count = self.read_u32()? as usize;
        if count > maximum {
            return Err(format!("Der Outlook-Cache enthält zu viele {label}."));
        }
        Ok(count)
    }

    fn read_sized_bytes(&mut self) -> Result<&'a [u8], String> {
        let length = self.read_count(MAX_DYNAMIC_VALUE_BYTES, "Datenbytes")?;
        self.read_exact(length)
    }

    fn read_string8(&mut self) -> Result<String, String> {
        let bytes = self.read_sized_bytes()?;
        let content = bytes.strip_suffix(&[0]).unwrap_or(bytes);
        Ok(String::from_utf8_lossy(content).trim().to_string())
    }

    fn read_unicode(&mut self) -> Result<String, String> {
        let bytes = self.read_sized_bytes()?;
        if bytes.len() % 2 != 0 {
            return Err("Ungültiger Unicode-Text im Outlook-Cache.".to_string());
        }
        let mut values = Vec::with_capacity(bytes.len() / 2);
        for chunk in bytes.chunks_exact(2) {
            values.push(u16::from_le_bytes([chunk[0], chunk[1]]));
        }
        if values.last() == Some(&0) {
            values.pop();
        }
        Ok(String::from_utf16_lossy(&values).trim().to_string())
    }

    fn read_property(&mut self) -> Result<(u16, PropertyValue), String> {
        let tag = self.read_u32()?;
        let property_type = (tag & 0xFFFF) as u16;
        let property_id = (tag >> 16) as u16;
        self.skip(4)?;
        let value_union = self.read_exact(8)?;

        let value = match property_type {
            PT_I2 | PT_LONG | PT_R4 | PT_DOUBLE | PT_CURRENCY | PT_APPTIME | PT_ERROR
            | PT_BOOLEAN | PT_SYSTIME | PT_I8 => {
                if property_type == PT_LONG {
                    PropertyValue::Long(u32::from_le_bytes([
                        value_union[0],
                        value_union[1],
                        value_union[2],
                        value_union[3],
                    ]))
                } else {
                    PropertyValue::None
                }
            }
            PT_STRING8 => PropertyValue::Text(self.read_string8()?),
            PT_UNICODE => PropertyValue::Text(self.read_unicode()?),
            PT_CLSID => {
                self.skip(16)?;
                PropertyValue::None
            }
            PT_BINARY => {
                self.read_sized_bytes()?;
                PropertyValue::None
            }
            0x1002 => {
                let count = self.read_count(MAX_PROPERTIES_PER_ROW, "Werte")?;
                self.skip(count.saturating_mul(2))?;
                PropertyValue::None
            }
            0x1003 | 0x1004 | 0x100A | 0x100B => {
                let count = self.read_count(MAX_PROPERTIES_PER_ROW, "Werte")?;
                self.skip(count.saturating_mul(4))?;
                PropertyValue::None
            }
            0x1005 | 0x1006 | 0x1007 | 0x1014 | 0x1040 => {
                let count = self.read_count(MAX_PROPERTIES_PER_ROW, "Werte")?;
                self.skip(count.saturating_mul(8))?;
                PropertyValue::None
            }
            0x101E => {
                let count = self.read_count(MAX_PROPERTIES_PER_ROW, "Texte")?;
                for _ in 0..count {
                    self.read_string8()?;
                }
                PropertyValue::None
            }
            0x101F => {
                let count = self.read_count(MAX_PROPERTIES_PER_ROW, "Texte")?;
                for _ in 0..count {
                    self.read_unicode()?;
                }
                PropertyValue::None
            }
            0x1048 => {
                let count = self.read_count(MAX_PROPERTIES_PER_ROW, "GUIDs")?;
                self.skip(count.saturating_mul(16))?;
                PropertyValue::None
            }
            0x1102 => {
                let count = self.read_count(MAX_PROPERTIES_PER_ROW, "Binärwerte")?;
                for _ in 0..count {
                    self.read_sized_bytes()?;
                }
                PropertyValue::None
            }
            _ => {
                return Err(format!(
                    "Nicht unterstützter MAPI-Datentyp 0x{property_type:04X} im Outlook-Cache."
                ));
            }
        };

        Ok((property_id, value))
    }
}

fn looks_like_smtp_address(value: &str) -> bool {
    let value = value.trim();
    if value.is_empty() || value.chars().any(char::is_whitespace) {
        return false;
    }
    let Some((local, domain)) = value.rsplit_once('@') else {
        return false;
    };
    !local.is_empty() && domain.contains('.') && !domain.starts_with('.') && !domain.ends_with('.')
}

fn clean_display_name(value: &str, email: &str) -> String {
    let trimmed = value.trim().trim_matches('"').trim();
    if trimmed.eq_ignore_ascii_case(email) {
        return String::new();
    }
    if let Some((name, address)) = trimmed.rsplit_once('<') {
        if address
            .trim_end_matches('>')
            .trim()
            .eq_ignore_ascii_case(email)
        {
            return name.trim().trim_matches('"').trim().to_string();
        }
    }
    trimmed.to_string()
}

pub fn parse_autocomplete_stream(bytes: &[u8]) -> Result<Vec<OutlookAutocompleteEntry>, String> {
    if bytes.len() < 24 {
        return Err("Der Outlook-Autovervollständigungs-Cache ist zu klein.".to_string());
    }
    let mut reader = StreamReader::new(bytes);
    let metadata = reader.read_u32()?;
    if metadata != STREAM_MAGIC {
        return Err(
            "Der Outlook-Autovervollständigungs-Cache hat ein unbekanntes Format.".to_string(),
        );
    }
    let major_version = reader.read_u32()?;
    if major_version != STREAM_MAJOR_VERSION {
        return Err(format!(
            "Outlook-Autovervollständigung Version {major_version} wird noch nicht unterstützt."
        ));
    }
    reader.read_u32()?;
    let row_count = reader.read_count(MAX_ROWS, "Empfänger")?;
    let mut entries = Vec::new();

    for _ in 0..row_count {
        let property_count = reader.read_count(MAX_PROPERTIES_PER_ROW, "Eigenschaften")?;
        let mut row = ParsedRow::default();
        for _ in 0..property_count {
            let (property_id, value) = reader.read_property()?;
            match (property_id, value) {
                (PR_DISPLAY_NAME, PropertyValue::Text(value)) => row.display_name = value,
                (PR_EMAIL_ADDRESS, PropertyValue::Text(value)) => row.email_address = value,
                (PR_SMTP_ADDRESS, PropertyValue::Text(value)) => row.smtp_address = value,
                (PR_NICK_NAME, PropertyValue::Text(value)) => row.nickname = value,
                (PR_DROPDOWN_DISPLAY_NAME, PropertyValue::Text(value)) => {
                    row.dropdown_display_name = value
                }
                (PR_NICK_NAME_WEIGHT, PropertyValue::Long(value)) => row.weight = value,
                _ => {}
            }
        }

        let email = [row.smtp_address, row.email_address, row.nickname]
            .into_iter()
            .map(|value| value.trim().to_lowercase())
            .find(|value| looks_like_smtp_address(value));
        if let Some(email) = email {
            let display_name = [row.display_name, row.dropdown_display_name]
                .into_iter()
                .map(|value| clean_display_name(&value, &email))
                .find(|value| !value.is_empty())
                .unwrap_or_default();
            entries.push(OutlookAutocompleteEntry {
                display_name,
                email,
                weight: row.weight,
            });
        }
    }

    if reader.remaining() < 12 {
        return Err("Der Outlook-Autovervollständigungs-Cache endet unerwartet.".to_string());
    }
    let extra_information_length = reader.read_count(MAX_DYNAMIC_VALUE_BYTES, "Zusatzbytes")?;
    reader.skip(extra_information_length)?;
    reader.skip(8)?;

    Ok(entries)
}

#[cfg(target_os = "windows")]
fn autocomplete_directory() -> Option<PathBuf> {
    std::env::var_os("LOCALAPPDATA")
        .map(PathBuf::from)
        .map(|path| path.join("Microsoft").join("Outlook").join("RoamCache"))
}

#[cfg(not(target_os = "windows"))]
fn autocomplete_directory() -> Option<PathBuf> {
    None
}

fn autocomplete_files(directory: &Path) -> Result<Vec<(PathBuf, SystemTime)>, String> {
    let mut files = Vec::new();
    let entries = match fs::read_dir(directory) {
        Ok(entries) => entries,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(files),
        Err(error) => {
            return Err(format!(
                "Outlook-Autovervollständigungsordner konnte nicht gelesen werden: {error}"
            ))
        }
    };
    for entry in entries.flatten() {
        let path = entry.path();
        let Some(name) = path.file_name().and_then(|name| name.to_str()) else {
            continue;
        };
        if !name.starts_with("Stream_Autocomplete") || !name.ends_with(".dat") {
            continue;
        }
        let Ok(metadata) = entry.metadata() else {
            continue;
        };
        if !metadata.is_file() || metadata.len() == 0 || metadata.len() > MAX_STREAM_BYTES {
            continue;
        }
        files.push((path, metadata.modified().unwrap_or(SystemTime::UNIX_EPOCH)));
    }
    files.sort_by(|left, right| right.1.cmp(&left.1));
    Ok(files)
}

pub fn read_outlook_autocomplete() -> OutlookAutocompleteReadResult {
    let Some(directory) = autocomplete_directory() else {
        return OutlookAutocompleteReadResult::default();
    };
    let files = match autocomplete_files(&directory) {
        Ok(files) => files,
        Err(error) => {
            return OutlookAutocompleteReadResult {
                warnings: vec![error],
                ..OutlookAutocompleteReadResult::default()
            }
        }
    };

    let mut result = OutlookAutocompleteReadResult::default();
    let mut deduplicated: HashMap<String, OutlookAutocompleteEntry> = HashMap::new();
    for (path, _) in files {
        let bytes = match fs::read(&path) {
            Ok(bytes) => bytes,
            Err(error) => {
                result.warnings.push(format!(
                    "Outlook-Autovervollständigungsdatei konnte nicht gelesen werden: {error}"
                ));
                continue;
            }
        };
        match parse_autocomplete_stream(&bytes) {
            Ok(entries) => {
                result.files_read += 1;
                for entry in entries {
                    match deduplicated.get(&entry.email) {
                        Some(existing) if existing.weight >= entry.weight => {}
                        _ => {
                            deduplicated.insert(entry.email.clone(), entry);
                        }
                    }
                }
            }
            Err(error) => result.warnings.push(error),
        }
    }
    result.entries = deduplicated.into_values().collect();
    result.entries.sort_by(|left, right| {
        right
            .weight
            .cmp(&left.weight)
            .then_with(|| left.email.cmp(&right.email))
    });
    result
}

#[cfg(test)]
mod tests {
    use super::*;

    fn dynamic_property(tag: u32, value: &[u8]) -> Vec<u8> {
        let mut bytes = Vec::new();
        bytes.extend_from_slice(&tag.to_le_bytes());
        bytes.extend_from_slice(&0u32.to_le_bytes());
        bytes.extend_from_slice(&0u64.to_le_bytes());
        bytes.extend_from_slice(&(value.len() as u32).to_le_bytes());
        bytes.extend_from_slice(value);
        bytes
    }

    fn unicode_property(tag: u32, value: &str) -> Vec<u8> {
        let mut encoded = value.encode_utf16().collect::<Vec<_>>();
        encoded.push(0);
        let bytes = encoded
            .into_iter()
            .flat_map(u16::to_le_bytes)
            .collect::<Vec<_>>();
        dynamic_property(tag, &bytes)
    }

    #[test]
    fn parses_smtp_recipient_from_documented_stream_layout() {
        let mut stream = Vec::new();
        stream.extend_from_slice(&STREAM_MAGIC.to_le_bytes());
        stream.extend_from_slice(&STREAM_MAJOR_VERSION.to_le_bytes());
        stream.extend_from_slice(&0u32.to_le_bytes());
        stream.extend_from_slice(&1u32.to_le_bytes());
        stream.extend_from_slice(&3u32.to_le_bytes());
        stream.extend_from_slice(&unicode_property(0x3001001F, "Ada Lovelace"));
        stream.extend_from_slice(&unicode_property(0x39FE001F, "Ada@Example.com"));
        stream.extend_from_slice(&0x60040003u32.to_le_bytes());
        stream.extend_from_slice(&0u32.to_le_bytes());
        stream.extend_from_slice(&42u32.to_le_bytes());
        stream.extend_from_slice(&0u32.to_le_bytes());
        stream.extend_from_slice(&0u32.to_le_bytes());
        stream.extend_from_slice(&0u64.to_le_bytes());

        let entries = parse_autocomplete_stream(&stream).unwrap();
        assert_eq!(entries.len(), 1);
        assert_eq!(entries[0].display_name, "Ada Lovelace");
        assert_eq!(entries[0].email, "ada@example.com");
        assert_eq!(entries[0].weight, 42);
    }

    #[test]
    fn ignores_exchange_legacy_addresses_without_smtp_fallback() {
        let mut stream = Vec::new();
        stream.extend_from_slice(&STREAM_MAGIC.to_le_bytes());
        stream.extend_from_slice(&STREAM_MAJOR_VERSION.to_le_bytes());
        stream.extend_from_slice(&0u32.to_le_bytes());
        stream.extend_from_slice(&1u32.to_le_bytes());
        stream.extend_from_slice(&1u32.to_le_bytes());
        stream.extend_from_slice(&unicode_property(
            0x3003001F,
            "/o=Example/ou=Exchange Administrative Group/cn=Recipients/cn=Ada",
        ));
        stream.extend_from_slice(&0u32.to_le_bytes());
        stream.extend_from_slice(&0u64.to_le_bytes());

        assert!(parse_autocomplete_stream(&stream).unwrap().is_empty());
    }

    #[test]
    fn optionally_validates_the_installed_outlook_cache() {
        if std::env::var_os("DMH_TEST_OUTLOOK_AUTOCOMPLETE").is_none() {
            return;
        }
        let result = read_outlook_autocomplete();
        assert!(
            result.warnings.is_empty(),
            "Outlook cache warnings: {:?}",
            result.warnings
        );
        assert!(result.files_read > 0, "No Outlook autocomplete cache found");
        assert!(
            !result.entries.is_empty(),
            "Outlook autocomplete cache did not contain SMTP recipients"
        );
        eprintln!(
            "Validated {} Outlook autocomplete entries from {} cache file(s)",
            result.entries.len(),
            result.files_read
        );
    }
}
