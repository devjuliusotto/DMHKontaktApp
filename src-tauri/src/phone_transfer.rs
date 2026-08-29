use chrono::{Duration as ChronoDuration, Utc};
use serde::Serialize;
use std::collections::HashMap;
use std::fs::{self, File};
use std::io::{ErrorKind, Read, Write};
use std::net::{TcpListener, TcpStream, UdpSocket};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
use std::sync::{Arc, Mutex, OnceLock};
use std::thread;
use std::time::{Duration, Instant};
use tauri::{AppHandle, Emitter, Manager};
use uuid::Uuid;

const SESSION_MINUTES: i64 = 15;
const MAX_FILE_BYTES: usize = 25 * 1024 * 1024;
const MAX_FILES_PER_SESSION: usize = 100;
const MAX_HEADER_BYTES: usize = 32 * 1024;

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PhoneTransferStatus {
    active: bool,
    url: String,
    destination: String,
    expires_at: String,
    received_files: usize,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct PhonePhotoReceived {
    name: String,
    received_files: usize,
}

struct PhoneTransferSession {
    url: String,
    destination: PathBuf,
    expires_at: chrono::DateTime<Utc>,
    running: Arc<AtomicBool>,
    received_files: Arc<AtomicUsize>,
}

static SESSION: OnceLock<Mutex<Option<PhoneTransferSession>>> = OnceLock::new();

fn session_store() -> &'static Mutex<Option<PhoneTransferSession>> {
    SESSION.get_or_init(|| Mutex::new(None))
}

#[tauri::command]
pub fn start_phone_photo_transfer(app: AppHandle) -> Result<PhoneTransferStatus, String> {
    let mut current = session_store()
        .lock()
        .map_err(|_| "Die Übertragung ist vorübergehend gesperrt.".to_string())?;
    if let Some(session) = current.as_ref() {
        if session.running.load(Ordering::Relaxed) && session.expires_at > Utc::now() {
            return Ok(status_from_session(session));
        }
        session.running.store(false, Ordering::Relaxed);
    }

    let pictures = app
        .path()
        .picture_dir()
        .map_err(|error| format!("Der Bilder-Ordner konnte nicht ermittelt werden: {error}"))?;
    let destination = pictures
        .join("DMH Handy-Übertragung")
        .join(Utc::now().format("%Y-%m-%d").to_string());
    fs::create_dir_all(&destination)
        .map_err(|error| format!("Der Zielordner konnte nicht erstellt werden: {error}"))?;

    let local_ip = local_ipv4()?;
    let listener = TcpListener::bind((local_ip.as_str(), 0)).map_err(|error| {
        format!("Die lokale Übertragung konnte nicht gestartet werden: {error}")
    })?;
    listener.set_nonblocking(true).map_err(|error| {
        format!("Die lokale Verbindung konnte nicht vorbereitet werden: {error}")
    })?;
    let port = listener
        .local_addr()
        .map_err(|error| error.to_string())?
        .port();
    let token = Uuid::new_v4().to_string();
    let url = format!("http://{local_ip}:{port}/?token={token}");
    let expires_at = Utc::now() + ChronoDuration::minutes(SESSION_MINUTES);
    let running = Arc::new(AtomicBool::new(true));
    let received_files = Arc::new(AtomicUsize::new(0));

    let session = PhoneTransferSession {
        url: url.clone(),
        destination: destination.clone(),
        expires_at,
        running: Arc::clone(&running),
        received_files: Arc::clone(&received_files),
    };
    let result = status_from_session(&session);
    *current = Some(session);

    thread::spawn(move || {
        serve_phone_transfer(
            listener,
            token,
            destination,
            running,
            received_files,
            app,
            Instant::now() + Duration::from_secs((SESSION_MINUTES * 60) as u64),
        );
    });

    Ok(result)
}

#[tauri::command]
pub fn get_phone_photo_transfer_status() -> Result<Option<PhoneTransferStatus>, String> {
    let current = session_store()
        .lock()
        .map_err(|_| "Der Übertragungsstatus ist vorübergehend gesperrt.".to_string())?;
    Ok(current.as_ref().map(status_from_session))
}

#[tauri::command]
pub fn stop_phone_photo_transfer() -> Result<(), String> {
    let mut current = session_store()
        .lock()
        .map_err(|_| "Die Übertragung ist vorübergehend gesperrt.".to_string())?;
    if let Some(session) = current.take() {
        session.running.store(false, Ordering::Relaxed);
    }
    Ok(())
}

fn status_from_session(session: &PhoneTransferSession) -> PhoneTransferStatus {
    PhoneTransferStatus {
        active: session.running.load(Ordering::Relaxed) && session.expires_at > Utc::now(),
        url: session.url.clone(),
        destination: session.destination.to_string_lossy().to_string(),
        expires_at: session.expires_at.to_rfc3339(),
        received_files: session.received_files.load(Ordering::Relaxed),
    }
}

fn local_ipv4() -> Result<String, String> {
    let socket = UdpSocket::bind("0.0.0.0:0")
        .map_err(|error| format!("Die Netzwerkadresse konnte nicht ermittelt werden: {error}"))?;
    socket
        .connect("1.1.1.1:80")
        .map_err(|_| "Keine aktive WLAN- oder LAN-Verbindung gefunden.".to_string())?;
    let address = socket.local_addr().map_err(|error| error.to_string())?;
    if address.ip().is_loopback() {
        return Err("Keine erreichbare lokale Netzwerkadresse gefunden.".to_string());
    }
    Ok(address.ip().to_string())
}

fn serve_phone_transfer(
    listener: TcpListener,
    token: String,
    destination: PathBuf,
    running: Arc<AtomicBool>,
    received_files: Arc<AtomicUsize>,
    app: AppHandle,
    deadline: Instant,
) {
    while running.load(Ordering::Relaxed) && Instant::now() < deadline {
        match listener.accept() {
            Ok((stream, _)) => {
                let _ = handle_request(stream, &token, &destination, &received_files, &app);
            }
            Err(error) if error.kind() == ErrorKind::WouldBlock => {
                thread::sleep(Duration::from_millis(80))
            }
            Err(_) => break,
        }
    }
    running.store(false, Ordering::Relaxed);
}

fn handle_request(
    mut stream: TcpStream,
    token: &str,
    destination: &Path,
    received_files: &AtomicUsize,
    app: &AppHandle,
) -> Result<(), String> {
    stream
        .set_read_timeout(Some(Duration::from_secs(30)))
        .map_err(|error| error.to_string())?;
    stream
        .set_write_timeout(Some(Duration::from_secs(30)))
        .map_err(|error| error.to_string())?;
    let (method, target, headers, initial_body) = read_request_head(&mut stream)?;
    let (path, query) = split_target(&target);
    let parameters = parse_query(query);
    if parameters.get("token").map(String::as_str) != Some(token) {
        return write_response(
            &mut stream,
            403,
            "text/plain; charset=utf-8",
            "Ungültiger oder abgelaufener QR-Code.".as_bytes(),
        );
    }

    if method == "GET" && path == "/" {
        let page = phone_page(token);
        return write_response(
            &mut stream,
            200,
            "text/html; charset=utf-8",
            page.as_bytes(),
        );
    }
    if method != "POST" || path != "/upload" {
        return write_response(
            &mut stream,
            404,
            "text/plain; charset=utf-8",
            b"Nicht gefunden.",
        );
    }
    if received_files.load(Ordering::Relaxed) >= MAX_FILES_PER_SESSION {
        return write_response(
            &mut stream,
            429,
            "text/plain; charset=utf-8",
            b"Diese Sitzung hat bereits 100 Fotos empfangen.",
        );
    }

    let content_type = headers
        .get("content-type")
        .map(String::as_str)
        .unwrap_or("");
    if !content_type.to_ascii_lowercase().starts_with("image/") {
        return write_response(
            &mut stream,
            415,
            "text/plain; charset=utf-8",
            "Es können nur Bilder übertragen werden.".as_bytes(),
        );
    }
    let content_length = headers
        .get("content-length")
        .and_then(|value| value.parse::<usize>().ok())
        .ok_or_else(|| "Die Dateigröße fehlt.".to_string())?;
    if content_length == 0 || content_length > MAX_FILE_BYTES {
        return write_response(
            &mut stream,
            413,
            "text/plain; charset=utf-8",
            "Ein Foto darf höchstens 25 MB groß sein.".as_bytes(),
        );
    }

    let requested_name = parameters
        .get("name")
        .map(String::as_str)
        .unwrap_or("Foto.jpg");
    let file_name = safe_file_name(requested_name, content_type);
    let final_path = unique_destination(destination, &file_name);
    let temporary_path = destination.join(format!(".upload-{}.part", Uuid::new_v4()));
    let result = write_request_body(&mut stream, &temporary_path, content_length, initial_body)
        .and_then(|_| fs::rename(&temporary_path, &final_path).map_err(|error| error.to_string()));
    if let Err(error) = result {
        let _ = fs::remove_file(&temporary_path);
        return Err(error);
    }

    let count = received_files.fetch_add(1, Ordering::Relaxed) + 1;
    let saved_name = final_path
        .file_name()
        .and_then(|value| value.to_str())
        .unwrap_or(&file_name)
        .to_string();
    let _ = app.emit(
        "phone-photo-received",
        PhonePhotoReceived {
            name: saved_name.clone(),
            received_files: count,
        },
    );
    let response =
        serde_json::to_vec(&serde_json::json!({ "name": saved_name, "receivedFiles": count }))
            .map_err(|error| error.to_string())?;
    write_response(
        &mut stream,
        200,
        "application/json; charset=utf-8",
        &response,
    )
}

fn read_request_head(
    stream: &mut TcpStream,
) -> Result<(String, String, HashMap<String, String>, Vec<u8>), String> {
    let mut bytes = Vec::new();
    let mut buffer = [0_u8; 8192];
    let header_end = loop {
        let read = stream
            .read(&mut buffer)
            .map_err(|error| error.to_string())?;
        if read == 0 {
            return Err("Die Verbindung wurde vorzeitig beendet.".to_string());
        }
        bytes.extend_from_slice(&buffer[..read]);
        if let Some(position) = bytes.windows(4).position(|window| window == b"\r\n\r\n") {
            break position + 4;
        }
        if bytes.len() > MAX_HEADER_BYTES {
            return Err("Die Anfrage ist zu groß.".to_string());
        }
    };

    let head = String::from_utf8_lossy(&bytes[..header_end]);
    let mut lines = head.split("\r\n");
    let request_line = lines
        .next()
        .ok_or_else(|| "Ungültige Anfrage.".to_string())?;
    let mut request_parts = request_line.split_whitespace();
    let method = request_parts.next().unwrap_or("").to_string();
    let target = request_parts.next().unwrap_or("").to_string();
    let mut headers = HashMap::new();
    for line in lines {
        if let Some((name, value)) = line.split_once(':') {
            headers.insert(name.trim().to_ascii_lowercase(), value.trim().to_string());
        }
    }
    Ok((method, target, headers, bytes[header_end..].to_vec()))
}

fn write_request_body(
    stream: &mut TcpStream,
    path: &Path,
    length: usize,
    initial: Vec<u8>,
) -> Result<(), String> {
    let mut file = File::create(path).map_err(|error| error.to_string())?;
    let initial_length = initial.len().min(length);
    file.write_all(&initial[..initial_length])
        .map_err(|error| error.to_string())?;
    let mut written = initial_length;
    let mut buffer = [0_u8; 64 * 1024];
    while written < length {
        let wanted = (length - written).min(buffer.len());
        let read = stream
            .read(&mut buffer[..wanted])
            .map_err(|error| error.to_string())?;
        if read == 0 {
            return Err("Das Foto wurde nicht vollständig übertragen.".to_string());
        }
        file.write_all(&buffer[..read])
            .map_err(|error| error.to_string())?;
        written += read;
    }
    file.sync_all().map_err(|error| error.to_string())
}

fn split_target(target: &str) -> (&str, &str) {
    target.split_once('?').unwrap_or((target, ""))
}

fn parse_query(query: &str) -> HashMap<String, String> {
    query
        .split('&')
        .filter_map(|entry| entry.split_once('='))
        .map(|(key, value)| (percent_decode(key), percent_decode(value)))
        .collect()
}

fn percent_decode(value: &str) -> String {
    let mut output = Vec::with_capacity(value.len());
    let bytes = value.as_bytes();
    let mut index = 0;
    while index < bytes.len() {
        if bytes[index] == b'%' && index + 2 < bytes.len() {
            if let (Some(high), Some(low)) =
                (hex_value(bytes[index + 1]), hex_value(bytes[index + 2]))
            {
                output.push((high << 4) | low);
                index += 3;
                continue;
            }
        }
        output.push(if bytes[index] == b'+' {
            b' '
        } else {
            bytes[index]
        });
        index += 1;
    }
    String::from_utf8_lossy(&output).to_string()
}

fn hex_value(value: u8) -> Option<u8> {
    match value {
        b'0'..=b'9' => Some(value - b'0'),
        b'a'..=b'f' => Some(value - b'a' + 10),
        b'A'..=b'F' => Some(value - b'A' + 10),
        _ => None,
    }
}

fn safe_file_name(requested: &str, content_type: &str) -> String {
    let raw_name = Path::new(requested)
        .file_name()
        .and_then(|value| value.to_str())
        .unwrap_or("Foto");
    let mut cleaned: String = raw_name
        .chars()
        .map(|character| {
            if matches!(
                character,
                '<' | '>' | ':' | '"' | '/' | '\\' | '|' | '?' | '*'
            ) || character.is_control()
            {
                '_'
            } else {
                character
            }
        })
        .collect();
    cleaned = cleaned.trim().trim_end_matches(['.', ' ']).to_string();
    if cleaned.is_empty() {
        cleaned = "Foto".to_string();
    }
    if Path::new(&cleaned).extension().is_none() {
        let extension = match content_type.split(';').next().unwrap_or("") {
            "image/png" => "png",
            "image/heic" | "image/heif" => "heic",
            "image/webp" => "webp",
            "image/gif" => "gif",
            _ => "jpg",
        };
        cleaned.push('.');
        cleaned.push_str(extension);
    }
    cleaned
}

fn unique_destination(directory: &Path, file_name: &str) -> PathBuf {
    let requested = Path::new(file_name);
    let stem = requested
        .file_stem()
        .and_then(|value| value.to_str())
        .unwrap_or("Foto");
    let extension = requested
        .extension()
        .and_then(|value| value.to_str())
        .unwrap_or("jpg");
    let direct = directory.join(file_name);
    if !direct.exists() {
        return direct;
    }
    for index in 2..10_000 {
        let candidate = directory.join(format!("{stem} ({index}).{extension}"));
        if !candidate.exists() {
            return candidate;
        }
    }
    directory.join(format!("Foto-{}.{}", Uuid::new_v4(), extension))
}

fn write_response(
    stream: &mut TcpStream,
    status: u16,
    content_type: &str,
    body: &[u8],
) -> Result<(), String> {
    let reason = match status {
        200 => "OK",
        403 => "Forbidden",
        404 => "Not Found",
        413 => "Payload Too Large",
        415 => "Unsupported Media Type",
        429 => "Too Many Requests",
        _ => "Error",
    };
    let header = format!(
        "HTTP/1.1 {status} {reason}\r\nContent-Type: {content_type}\r\nContent-Length: {}\r\nCache-Control: no-store\r\nContent-Security-Policy: default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline'; connect-src 'self'; img-src 'self' data:; base-uri 'none'; form-action 'none'; frame-ancestors 'none'\r\nReferrer-Policy: no-referrer\r\nX-Content-Type-Options: nosniff\r\nConnection: close\r\n\r\n",
        body.len()
    );
    stream
        .write_all(header.as_bytes())
        .map_err(|error| error.to_string())?;
    stream.write_all(body).map_err(|error| error.to_string())?;
    stream.flush().map_err(|error| error.to_string())
}

fn phone_page(token: &str) -> String {
    PHONE_PAGE.replace("__TOKEN__", token)
}

const PHONE_PAGE: &str = r#"<!doctype html>
<html lang="de"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Fotos zum PC senden</title><style>
:root{font-family:system-ui,-apple-system,"Segoe UI",sans-serif;color:#202124;background:#f4f4f6}*{box-sizing:border-box}body{margin:0;padding:20px}.card{background:#fff;border:1px solid #d8c1ca;border-radius:18px;box-shadow:0 12px 35px #35001617;margin:5vh auto;max-width:560px;overflow:hidden}.head{background:#640228;color:#fff;padding:24px}.head h1{font-size:1.65rem;margin:0 0 8px}.head p{font-size:1.05rem;line-height:1.45;margin:0;opacity:.9}.body{padding:24px}.choose{align-items:center;background:#891538;border-radius:12px;color:#fff;cursor:pointer;display:flex;font-size:1.15rem;font-weight:750;justify-content:center;min-height:58px;padding:14px;text-align:center}.choose input{height:1px;opacity:0;position:absolute;width:1px}.hint{color:#526565;font-size:1rem;line-height:1.5;margin:16px 0}.status{background:#f7f7f8;border:1px solid #d8c1ca;border-radius:10px;line-height:1.45;margin-top:16px;min-height:52px;padding:14px}.status.ok{background:#e7f5ed;border-color:#79b997;color:#176b45}.status.error{background:#fde8e7;border-color:#b3261e;color:#8f1d18}.files{display:grid;gap:8px;margin-top:14px}.files div{background:#f7f7f8;border-radius:8px;overflow-wrap:anywhere;padding:10px}small{color:#687078;display:block;line-height:1.4;margin-top:18px}@media(max-width:480px){body{padding:10px}.card{margin:2vh auto}.head,.body{padding:20px}}
</style></head><body><main class="card"><header class="head"><h1>Fotos zum PC senden</h1><p>Ohne Anmeldung – direkt über Ihr WLAN.</p></header><section class="body">
<label class="choose">Fotos auswählen oder aufnehmen<input id="photos" type="file" accept="image/*" multiple></label>
<p class="hint">Wählen Sie ein oder mehrere Fotos. Die Übertragung beginnt automatisch.</p><div id="status" class="status" role="status">Bereit zum Auswählen.</div><div id="files" class="files"></div>
<small>Lassen Sie diese Seite geöffnet, bis alle Fotos übertragen wurden. Handy und PC müssen im selben WLAN sein.</small></section></main>
<script>const input=document.querySelector('#photos'),status=document.querySelector('#status'),list=document.querySelector('#files');input.addEventListener('change',async()=>{const files=[...input.files];if(!files.length)return;input.disabled=true;status.className='status';let sent=0;for(const file of files){status.textContent=`Foto ${sent+1} von ${files.length} wird übertragen …`;try{const response=await fetch(`/upload?token=__TOKEN__&name=${encodeURIComponent(file.name)}`,{method:'POST',headers:{'Content-Type':file.type||'image/jpeg'},body:file});if(!response.ok)throw new Error(await response.text());const result=await response.json();sent++;const row=document.createElement('div');row.textContent=`✓ ${result.name}`;list.append(row)}catch(error){status.className='status error';status.textContent=`Übertragung fehlgeschlagen: ${error.message}`;input.disabled=false;return}}status.className='status ok';status.textContent=`${sent} Foto(s) sicher auf den PC übertragen.`;input.value='';input.disabled=false});</script></body></html>"#;

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn file_names_cannot_escape_destination() {
        assert_eq!(
            safe_file_name("../../urlaub.jpg", "image/jpeg"),
            "urlaub.jpg"
        );
        assert_eq!(safe_file_name("foto:heute", "image/png"), "foto_heute.png");
    }

    #[test]
    fn query_values_are_decoded() {
        let values = parse_query("name=Foto%20Sommer%2Ejpg&token=abc");
        assert_eq!(
            values.get("name").map(String::as_str),
            Some("Foto Sommer.jpg")
        );
    }

    #[test]
    fn mobile_page_uses_only_the_local_transfer_endpoint() {
        let page = phone_page("temporary-token");
        assert!(page.contains("token=temporary-token"));
        assert!(!page.contains("https://"));
        assert!(!page.contains("http://"));
    }
}
