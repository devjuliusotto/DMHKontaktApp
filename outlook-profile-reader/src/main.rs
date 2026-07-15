use native_tls::TlsConnector;
use outlook_mapi::{
    sys::{
        CLSID_OlkAccountManager, CLSID_OlkIMAP4Account, CLSID_OlkMail, IOlkAccount,
        IOlkAccountHelper, IOlkAccountHelper_Impl, IOlkAccountManager,
        ACCT_INIT_NOSYNCH_MAPI_ACCTS, ACCT_VARIANT, E_ACCT_NOT_FOUND, OLK_ACCOUNT_NO_FLAGS,
        PROP_ACCT_ID, PROP_ACCT_MINI_UID, PROP_ACCT_NAME, PROP_ACCT_USER_EMAIL_ADDR,
        PROP_INET_PASSWORD, PROP_INET_PORT, PROP_INET_SERVER, PROP_INET_SSL, PROP_INET_USER,
        PROP_INET_USE_SPA, PROP_SMTP_AUTH_METHOD, PROP_SMTP_PASSWORD, PROP_SMTP_PORT,
        PROP_SMTP_SECURE_CONNECTION, PROP_SMTP_SERVER, PROP_SMTP_USER, PROP_SMTP_USE_AUTH, PT_LONG,
        PT_UNICODE,
    },
    Initialize, Logon, LogonFlags,
};
use serde::Serialize;
use std::{
    env,
    ffi::c_void,
    io::{self, BufRead, BufReader, Read, Write},
    net::{TcpStream, ToSocketAddrs},
    ptr,
    sync::Arc,
    time::Duration,
};
use windows::Win32::{
    Security::Credentials::{
        CredDeleteW, CredFree, CredReadW, CredWriteW, CREDENTIALW, CRED_PERSIST_LOCAL_MACHINE,
        CRED_TYPE_GENERIC,
    },
    System::Com::{
        CoCreateInstance, CoInitializeEx, CoUninitialize, CLSCTX_INPROC_SERVER,
        COINIT_APARTMENTTHREADED,
    },
};
use windows_core::{implement, Error as WindowsError, IUnknown, Interface, HRESULT, PCWSTR, PWSTR};
use zeroize::{Zeroize, Zeroizing};

const ACCT_INIT_NO_STORES_CHECK: u32 = 0x0000_0002;
const ACCT_INIT_NO_NOTIFICATIONS: u32 = 0x0000_0004;
const SMTP_AUTH_SAME_AS_INCOMING: u32 = 0;
const SECURE_FLAG: u32 = 0x0000_8000;
const PROP_INET_PASSWORD_SECURE: u32 = PROP_INET_PASSWORD | SECURE_FLAG;
const PROP_SMTP_PASSWORD_SECURE: u32 = PROP_SMTP_PASSWORD | SECURE_FLAG;

type AppResult<T> = Result<T, String>;

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct OutlookAccountCandidate {
    source_account_id: String,
    account_name: String,
    email: String,
    account_type: String,
    incoming_server: String,
    incoming_user: String,
    incoming_port: u16,
    incoming_security: String,
    incoming_use_spa: bool,
    outgoing_server: String,
    outgoing_user: String,
    outgoing_port: u16,
    outgoing_security: String,
    outgoing_use_auth: bool,
    outgoing_auth_method: u32,
    password_available: bool,
    smtp_password_available: bool,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct ImportedOutlookAccount {
    #[serde(flatten)]
    account: OutlookAccountCandidate,
    incoming_credential_reference: String,
    outgoing_credential_reference: Option<String>,
}

#[derive(Serialize)]
struct ErrorEnvelope<'a> {
    error: &'a str,
}

#[derive(Serialize)]
struct SecretEnvelope<'a> {
    password: &'a str,
}

enum HelperOutput {
    Json(serde_json::Value),
    Secret(Zeroizing<String>),
}

#[implement(IOlkAccountHelper)]
struct AccountHelper {
    profile_name: Vec<u16>,
    session: IUnknown,
}

impl IOlkAccountHelper_Impl for AccountHelper_Impl {
    fn PlaceHolder1(&self, _value: *mut c_void) -> windows_core::Result<()> {
        Err(WindowsError::from_hresult(HRESULT(0x8000_4001u32 as i32)))
    }

    fn GetIdentity(&self, output: &PCWSTR, length: *mut u32) -> windows_core::Result<()> {
        if length.is_null() {
            return Err(WindowsError::from_hresult(HRESULT(0x8007_0057u32 as i32)));
        }

        let required = self.profile_name.len().saturating_add(1) as u32;
        unsafe {
            let available = *length;
            *length = required;
            if output.0.is_null() || available < required {
                return Err(WindowsError::from_hresult(HRESULT(0x8007_000Eu32 as i32)));
            }

            let destination = output.0 as *mut u16;
            ptr::copy_nonoverlapping(
                self.profile_name.as_ptr(),
                destination,
                self.profile_name.len(),
            );
            destination.add(self.profile_name.len()).write(0);
        }
        Ok(())
    }

    fn GetMapiSession(&self) -> windows_core::Result<IUnknown> {
        Ok(self.session.clone())
    }

    fn HandsOffSession(&self) -> windows_core::Result<()> {
        Ok(())
    }
}

struct ComApartment;

impl ComApartment {
    fn initialize() -> AppResult<Self> {
        unsafe { CoInitializeEx(None, COINIT_APARTMENTTHREADED) }
            .ok()
            .map_err(|error| format!("COM konnte nicht initialisiert werden: {error}"))?;
        Ok(Self)
    }
}

impl Drop for ComApartment {
    fn drop(&mut self) {
        unsafe { CoUninitialize() };
    }
}

struct OutlookAccounts {
    _com: ComApartment,
    _initialized: Arc<Initialize>,
    _logon: Logon,
    manager: IOlkAccountManager,
}

impl OutlookAccounts {
    fn open(profile_name: &str) -> AppResult<Self> {
        let com = ComApartment::initialize()?;
        let initialized = Initialize::new(Default::default())
            .map_err(|error| format!("Outlook MAPI konnte nicht initialisiert werden: {error}"))?;
        let logon = Logon::new(
            initialized.clone(),
            Default::default(),
            Some(profile_name),
            None,
            LogonFlags {
                extended: true,
                explicit_profile: true,
                new_session: true,
                ..Default::default()
            },
        )
        .map_err(|error| {
            format!("Das aktuelle Outlook-Classic-Profil konnte nicht geöffnet werden: {error}")
        })?;

        let helper: IOlkAccountHelper = AccountHelper {
            profile_name: profile_name.encode_utf16().collect(),
            session: logon
                .session
                .cast()
                .map_err(|error| format!("MAPI-Sitzung konnte nicht verwendet werden: {error}"))?,
        }
        .into();

        let manager: IOlkAccountManager = unsafe {
            CoCreateInstance(
                &CLSID_OlkAccountManager,
                None,
                CLSCTX_INPROC_SERVER,
            )
        }
        .map_err(|error| {
            format!(
                "Die Outlook Account Management API ist für diese Architektur nicht verfügbar: {error}"
            )
        })?;

        unsafe {
            manager.Init(
                &helper,
                ACCT_INIT_NOSYNCH_MAPI_ACCTS
                    | ACCT_INIT_NO_STORES_CHECK
                    | ACCT_INIT_NO_NOTIFICATIONS,
            )
        }
        .map_err(|error| format!("Outlook-Konten konnten nicht initialisiert werden: {error}"))?;

        Ok(Self {
            _com: com,
            _initialized: initialized,
            _logon: logon,
            manager,
        })
    }

    fn enumerate(&self, include_secrets: bool) -> AppResult<Vec<AccountRecord>> {
        let accounts = unsafe {
            self.manager.EnumerateAccounts(
                &CLSID_OlkMail,
                &CLSID_OlkIMAP4Account,
                OLK_ACCOUNT_NO_FLAGS,
            )
        }
        .map_err(|error| format!("IMAP-Konten konnten nicht gelesen werden: {error}"))?;

        let mut count = 0;
        unsafe { accounts.GetCount(&mut count) }
            .map_err(|error| format!("IMAP-Konten konnten nicht gezählt werden: {error}"))?;
        unsafe { accounts.Reset() }
            .map_err(|error| format!("IMAP-Konten konnten nicht gelesen werden: {error}"))?;

        let mut result = Vec::with_capacity(count as usize);
        for _ in 0..count {
            let unknown = unsafe { accounts.GetNext() }
                .map_err(|error| format!("Ein IMAP-Konto konnte nicht gelesen werden: {error}"))?;
            let account: IOlkAccount = unknown
                .cast()
                .map_err(|error| format!("Ein Outlook-Konto ist nicht lesbar: {error}"))?;
            result.push(AccountRecord::read(&account, include_secrets)?);
        }
        Ok(result)
    }
}

struct AccountRecord {
    source_account_id: String,
    account_name: String,
    email: String,
    incoming_server: String,
    incoming_user: String,
    incoming_port: u16,
    incoming_ssl: bool,
    incoming_use_spa: bool,
    outgoing_server: String,
    outgoing_user: String,
    outgoing_port: u16,
    outgoing_security: u32,
    outgoing_use_auth: bool,
    outgoing_auth_method: u32,
    password_available: bool,
    smtp_password_available: bool,
    incoming_password: Option<Zeroizing<Vec<u16>>>,
    outgoing_password: Option<Zeroizing<Vec<u16>>>,
}

impl AccountRecord {
    fn read(account: &IOlkAccount, include_secrets: bool) -> AppResult<Self> {
        let account_id = read_long(account, PROP_ACCT_MINI_UID)?
            .or(read_long(account, PROP_ACCT_ID)?)
            .ok_or_else(|| "Ein Outlook-IMAP-Konto hat keine stabile Konto-ID.".to_string())?;
        let incoming_ssl = read_long(account, PROP_INET_SSL)?.unwrap_or_default() != 0;
        let outgoing_security =
            read_long(account, PROP_SMTP_SECURE_CONNECTION)?.unwrap_or_default();
        let incoming_port = read_long(account, PROP_INET_PORT)?
            .and_then(|value| u16::try_from(value).ok())
            .unwrap_or(if incoming_ssl { 993 } else { 143 });
        let outgoing_port = read_long(account, PROP_SMTP_PORT)?
            .and_then(|value| u16::try_from(value).ok())
            .unwrap_or(match outgoing_security {
                1 => 465,
                2 => 587,
                _ => 25,
            });

        let outgoing_use_auth = read_long(account, PROP_SMTP_USE_AUTH)?.unwrap_or_default() != 0;
        let outgoing_auth_method = read_long(account, PROP_SMTP_AUTH_METHOD)?.unwrap_or_default();
        let mut incoming_password =
            read_secret(account, PROP_INET_PASSWORD_SECURE)?.filter(|value| !value.is_empty());
        let mut outgoing_password =
            read_secret(account, PROP_SMTP_PASSWORD_SECURE)?.filter(|value| !value.is_empty());
        let password_available = incoming_password.is_some();
        let smtp_password_available = outgoing_password.is_some()
            || (outgoing_use_auth
                && outgoing_auth_method == SMTP_AUTH_SAME_AS_INCOMING
                && password_available);
        if !include_secrets {
            incoming_password = None;
            outgoing_password = None;
        }

        Ok(Self {
            source_account_id: format!("{account_id:08X}"),
            account_name: read_string(account, PROP_ACCT_NAME)?.unwrap_or_default(),
            email: read_string(account, PROP_ACCT_USER_EMAIL_ADDR)?.unwrap_or_default(),
            incoming_server: read_string(account, PROP_INET_SERVER)?.unwrap_or_default(),
            incoming_user: read_string(account, PROP_INET_USER)?.unwrap_or_default(),
            incoming_port,
            incoming_ssl,
            incoming_use_spa: read_long(account, PROP_INET_USE_SPA)?.unwrap_or_default() != 0,
            outgoing_server: read_string(account, PROP_SMTP_SERVER)?.unwrap_or_default(),
            outgoing_user: read_string(account, PROP_SMTP_USER)?.unwrap_or_default(),
            outgoing_port,
            outgoing_security,
            outgoing_use_auth,
            outgoing_auth_method,
            password_available,
            smtp_password_available,
            incoming_password,
            outgoing_password,
        })
    }

    fn candidate(&self) -> OutlookAccountCandidate {
        OutlookAccountCandidate {
            source_account_id: self.source_account_id.clone(),
            account_name: self.account_name.clone(),
            email: self.email.clone(),
            account_type: "imap".to_string(),
            incoming_server: self.incoming_server.clone(),
            incoming_user: self.incoming_user.clone(),
            incoming_port: self.incoming_port,
            incoming_security: if self.incoming_ssl { "ssl" } else { "none" }.to_string(),
            incoming_use_spa: self.incoming_use_spa,
            outgoing_server: self.outgoing_server.clone(),
            outgoing_user: self.outgoing_user.clone(),
            outgoing_port: self.outgoing_port,
            outgoing_security: match self.outgoing_security {
                1 => "ssl",
                2 => "starttls",
                3 => "auto",
                _ => "none",
            }
            .to_string(),
            outgoing_use_auth: self.outgoing_use_auth,
            outgoing_auth_method: self.outgoing_auth_method,
            password_available: self.password_available,
            smtp_password_available: self.smtp_password_available,
        }
    }
}

fn is_property_missing(error: &WindowsError) -> bool {
    error.code().0 as u32 == E_ACCT_NOT_FOUND
}

fn read_long(account: &IOlkAccount, property: u32) -> AppResult<Option<u32>> {
    let mut value = ACCT_VARIANT::default();
    match unsafe { account.GetPropA(property, &mut value) } {
        Ok(()) => {
            if value.dwType != PT_LONG {
                return Err(format!(
                    "Outlook-Eigenschaft {property:#010X} hat einen unerwarteten Typ."
                ));
            }
            Ok(Some(unsafe { value.Val.dw }))
        }
        Err(error) if is_property_missing(&error) => Ok(None),
        Err(error) => Err(format!(
            "Outlook-Eigenschaft {property:#010X} konnte nicht gelesen werden: {error}"
        )),
    }
}

fn read_string(account: &IOlkAccount, property: u32) -> AppResult<Option<String>> {
    let Some(mut value) = read_utf16(account, property, false)? else {
        return Ok(None);
    };
    let result = String::from_utf16(&value)
        .map_err(|_| format!("Outlook-Eigenschaft {property:#010X} enthält ungültigen Text."));
    value.zeroize();
    result.map(Some)
}

fn read_secret(account: &IOlkAccount, property: u32) -> AppResult<Option<Zeroizing<Vec<u16>>>> {
    read_utf16(account, property, true).map(|value| value.map(Zeroizing::new))
}

fn read_utf16(account: &IOlkAccount, property: u32, secret: bool) -> AppResult<Option<Vec<u16>>> {
    let mut value = ACCT_VARIANT::default();
    match unsafe { account.GetPropA(property, &mut value) } {
        Ok(()) => {}
        Err(error) if is_property_missing(&error) => return Ok(None),
        Err(error) => {
            return Err(format!(
                "Outlook-Eigenschaft {property:#010X} konnte nicht gelesen werden: {error}"
            ))
        }
    }
    if value.dwType != PT_UNICODE && value.dwType != (PT_UNICODE | SECURE_FLAG) {
        return Err(format!(
            "Outlook-Eigenschaft {property:#010X} hat einen unerwarteten Typ."
        ));
    }

    let pointer = unsafe { value.Val.pwsz.0 };
    if pointer.is_null() {
        return Ok(None);
    }

    let mut length = 0usize;
    unsafe {
        while pointer.add(length).read() != 0 {
            length += 1;
        }
    }
    let mut result = unsafe { std::slice::from_raw_parts(pointer, length) }.to_vec();

    if secret {
        unsafe {
            for index in 0..length {
                pointer.add(index).write_volatile(0);
            }
        }
    }
    if let Err(error) = unsafe { account.FreeMemory(pointer as *mut u8) } {
        if secret {
            result.zeroize();
        }
        return Err(format!(
            "Outlook-Speicher konnte nicht freigegeben werden: {error}"
        ));
    }
    Ok(Some(result))
}

fn write_credential(target: &str, username: &str, password: &[u16]) -> AppResult<()> {
    if password.is_empty() {
        return Err("Das Outlook-Konto enthält kein gespeichertes IMAP-Kennwort.".to_string());
    }

    let mut target_wide: Vec<u16> = target.encode_utf16().chain(Some(0)).collect();
    let mut username_wide: Vec<u16> = username.encode_utf16().chain(Some(0)).collect();
    let mut credential = CREDENTIALW::default();
    credential.Type = CRED_TYPE_GENERIC;
    credential.TargetName = PWSTR(target_wide.as_mut_ptr());
    credential.CredentialBlobSize = u32::try_from(password.len().saturating_mul(2))
        .map_err(|_| "Das Kennwort ist zu lang für den Windows Credential Manager.".to_string())?;
    credential.CredentialBlob = password.as_ptr() as *mut u8;
    credential.Persist = CRED_PERSIST_LOCAL_MACHINE;
    credential.UserName = PWSTR(username_wide.as_mut_ptr());

    unsafe { CredWriteW(&credential, 0) }.map_err(|error| {
        format!("Kennwort konnte nicht im Windows Credential Manager gespeichert werden: {error}")
    })
}

fn delete_credential(target: &str) -> AppResult<()> {
    let target_wide: Vec<u16> = target.encode_utf16().chain(Some(0)).collect();
    match unsafe { CredDeleteW(PCWSTR(target_wide.as_ptr()), CRED_TYPE_GENERIC, None) } {
        Ok(()) => Ok(()),
        Err(error) if error.code().0 as u32 == 0x8007_0490 => Ok(()),
        Err(error) => Err(format!(
            "Kennwort konnte nicht aus dem Windows Credential Manager entfernt werden: {error}"
        )),
    }
}

fn read_credential(target: &str) -> AppResult<Zeroizing<Vec<u16>>> {
    let target_wide: Vec<u16> = target.encode_utf16().chain(Some(0)).collect();
    let mut pointer = ptr::null_mut();
    unsafe {
        CredReadW(
            PCWSTR(target_wide.as_ptr()),
            CRED_TYPE_GENERIC,
            None,
            &mut pointer,
        )
    }
    .map_err(|_| {
        "Gespeichertes Kennwort wurde im Windows Credential Manager nicht gefunden.".to_string()
    })?;
    if pointer.is_null() {
        return Err(
            "Gespeichertes Kennwort wurde im Windows Credential Manager nicht gefunden."
                .to_string(),
        );
    }

    let credential = unsafe { &mut *pointer };
    let byte_length = credential.CredentialBlobSize as usize;
    if byte_length == 0 || byte_length % 2 != 0 || credential.CredentialBlob.is_null() {
        if byte_length > 0 && !credential.CredentialBlob.is_null() {
            unsafe {
                std::slice::from_raw_parts_mut(credential.CredentialBlob, byte_length).zeroize()
            };
        }
        unsafe { CredFree(pointer as *const c_void) };
        return Err("Gespeichertes Kennwort ist ungültig.".to_string());
    }

    let bytes = unsafe { std::slice::from_raw_parts_mut(credential.CredentialBlob, byte_length) };
    let mut password = Zeroizing::new(Vec::with_capacity(byte_length / 2));
    for pair in bytes.chunks_exact(2) {
        password.push(u16::from_le_bytes([pair[0], pair[1]]));
    }
    bytes.zeroize();
    unsafe { CredFree(pointer as *const c_void) };
    Ok(password)
}

trait ReadWrite: Read + Write {}
impl<T: Read + Write> ReadWrite for T {}

fn push_quoted_imap(output: &mut String, value: &str) {
    output.push('"');
    for character in value.chars() {
        if matches!(character, '\\' | '"') {
            output.push('\\');
        }
        output.push(character);
    }
    output.push('"');
}

fn test_imap_connection(
    server: &str,
    port: u16,
    security: &str,
    username: &str,
    credential_reference: &str,
) -> AppResult<()> {
    if server.trim().is_empty() || username.trim().is_empty() {
        return Err("IMAP-Server oder Benutzername fehlt.".to_string());
    }
    if security != "ssl" {
        return Err(
            "Der IMAP-Test überträgt Kennwörter ausschließlich über SSL/TLS. Aktivieren Sie SSL/TLS für dieses Konto in Outlook Classic."
                .to_string(),
        );
    }

    let password_wide = read_credential(credential_reference)?;
    let password = Zeroizing::new(
        String::from_utf16(&password_wide)
            .map_err(|_| "Gespeichertes Kennwort ist ungültig.".to_string())?,
    );

    let address = (server, port)
        .to_socket_addrs()
        .map_err(|_| "IMAP-Servername konnte nicht aufgelöst werden.".to_string())?
        .next()
        .ok_or_else(|| "IMAP-Servername konnte nicht aufgelöst werden.".to_string())?;
    let tcp = TcpStream::connect_timeout(&address, Duration::from_secs(10))
        .map_err(|_| "Verbindung zum IMAP-Server konnte nicht hergestellt werden.".to_string())?;
    tcp.set_read_timeout(Some(Duration::from_secs(10))).ok();
    tcp.set_write_timeout(Some(Duration::from_secs(10))).ok();

    let stream: Box<dyn ReadWrite> = match security {
        "ssl" => Box::new(
            TlsConnector::new()
                .map_err(|_| "TLS konnte nicht initialisiert werden.".to_string())?
                .connect(server, tcp)
                .map_err(|_| {
                    "Die TLS-Verbindung zum IMAP-Server ist fehlgeschlagen.".to_string()
                })?,
        ),
        _ => return Err("Unbekannte IMAP-Verschlüsselung.".to_string()),
    };

    let mut reader = BufReader::new(stream);
    let mut line = String::new();
    reader
        .read_line(&mut line)
        .map_err(|_| "Der IMAP-Server hat nicht geantwortet.".to_string())?;
    if !line.to_ascii_uppercase().starts_with("* OK") {
        return Err("Der IMAP-Server hat die Verbindung nicht akzeptiert.".to_string());
    }

    let mut command = Zeroizing::new(String::with_capacity(username.len() + password.len() + 24));
    command.push_str("A1 LOGIN ");
    push_quoted_imap(&mut command, username);
    command.push(' ');
    push_quoted_imap(&mut command, &password);
    command.push_str("\r\n");
    reader
        .get_mut()
        .write_all(command.as_bytes())
        .and_then(|_| reader.get_mut().flush())
        .map_err(|_| "IMAP-Anmeldung konnte nicht gesendet werden.".to_string())?;
    command.zeroize();

    loop {
        line.clear();
        let bytes = reader
            .read_line(&mut line)
            .map_err(|_| "Der IMAP-Server hat die Anmeldung nicht beantwortet.".to_string())?;
        if bytes == 0 {
            return Err("Der IMAP-Server hat die Verbindung beendet.".to_string());
        }
        let upper = line.to_ascii_uppercase();
        if upper.starts_with("A1 OK") {
            let _ = reader.get_mut().write_all(b"A2 LOGOUT\r\n");
            let _ = reader.get_mut().flush();
            return Ok(());
        }
        if upper.starts_with("A1 NO") || upper.starts_with("A1 BAD") {
            return Err(
                "IMAP-Anmeldung wurde abgelehnt. Benutzername oder Kennwort prüfen.".to_string(),
            );
        }
    }
}

fn scan(profile_name: &str) -> AppResult<Vec<OutlookAccountCandidate>> {
    let outlook = OutlookAccounts::open(profile_name)?;
    outlook
        .enumerate(false)?
        .iter()
        .map(|account| {
            if account.incoming_server.trim().is_empty() {
                Err("Ein Outlook-IMAP-Konto enthält keinen Eingangsserver.".to_string())
            } else {
                Ok(account.candidate())
            }
        })
        .collect()
}

fn import_account(
    profile_name: &str,
    account_id: &str,
    incoming_reference: &str,
    outgoing_reference: &str,
) -> AppResult<ImportedOutlookAccount> {
    let outlook = OutlookAccounts::open(profile_name)?;
    let mut account = outlook
        .enumerate(true)?
        .into_iter()
        .find(|account| account.source_account_id.eq_ignore_ascii_case(account_id))
        .ok_or_else(|| {
            "Das ausgewählte Outlook-IMAP-Konto wurde nicht mehr gefunden.".to_string()
        })?;

    let incoming_password = account.incoming_password.take().ok_or_else(|| {
        "Für dieses Outlook-IMAP-Konto ist kein Kennwort gespeichert.".to_string()
    })?;
    write_credential(
        incoming_reference,
        &account.incoming_user,
        &incoming_password,
    )?;

    let outgoing_password = if account.outgoing_use_auth {
        account.outgoing_password.take().or_else(|| {
            if account.outgoing_auth_method == SMTP_AUTH_SAME_AS_INCOMING {
                Some(Zeroizing::new(incoming_password.to_vec()))
            } else {
                None
            }
        })
    } else {
        None
    };

    let outgoing_credential_reference = if let Some(password) = outgoing_password {
        let outgoing_user = if account.outgoing_user.trim().is_empty() {
            account.incoming_user.as_str()
        } else {
            account.outgoing_user.as_str()
        };
        if let Err(error) = write_credential(outgoing_reference, outgoing_user, &password) {
            let _ = delete_credential(incoming_reference);
            return Err(error);
        }
        Some(outgoing_reference.to_string())
    } else {
        if let Err(error) = delete_credential(outgoing_reference) {
            let _ = delete_credential(incoming_reference);
            return Err(error);
        }
        None
    };

    Ok(ImportedOutlookAccount {
        account: account.candidate(),
        incoming_credential_reference: incoming_reference.to_string(),
        outgoing_credential_reference,
    })
}

fn required_arg(args: &mut impl Iterator<Item = String>, name: &str) -> AppResult<String> {
    args.next()
        .ok_or_else(|| format!("Interner Aufruffehler: Argument {name} fehlt."))
}

fn run() -> AppResult<HelperOutput> {
    let mut args = env::args().skip(1);
    match required_arg(&mut args, "Befehl")?.as_str() {
        "scan" => {
            let profile = required_arg(&mut args, "Profil")?;
            serde_json::to_value(scan(&profile)?)
                .map(HelperOutput::Json)
                .map_err(|error| error.to_string())
        }
        "import" => {
            let profile = required_arg(&mut args, "Profil")?;
            let account_id = required_arg(&mut args, "Konto-ID")?;
            let incoming_reference = required_arg(&mut args, "IMAP-Credential")?;
            let outgoing_reference = required_arg(&mut args, "SMTP-Credential")?;
            serde_json::to_value(import_account(
                &profile,
                &account_id,
                &incoming_reference,
                &outgoing_reference,
            )?)
            .map(HelperOutput::Json)
            .map_err(|error| error.to_string())
        }
        "test" => {
            let server = required_arg(&mut args, "Server")?;
            let port = required_arg(&mut args, "Port")?
                .parse::<u16>()
                .map_err(|_| "Interner Aufruffehler: ungültiger Port.".to_string())?;
            let security = required_arg(&mut args, "Verschlüsselung")?;
            let username = required_arg(&mut args, "Benutzer")?;
            let credential_reference = required_arg(&mut args, "Credential")?;
            test_imap_connection(&server, port, &security, &username, &credential_reference)?;
            Ok(HelperOutput::Json(serde_json::json!({ "ok": true })))
        }
        "reveal" => {
            let credential_reference = required_arg(&mut args, "Credential")?;
            let password_wide = read_credential(&credential_reference)?;
            let password = Zeroizing::new(
                String::from_utf16(&password_wide)
                    .map_err(|_| "Gespeichertes Kennwort ist ungültig.".to_string())?,
            );
            Ok(HelperOutput::Secret(password))
        }
        "delete" => {
            for reference in args.filter(|value| !value.is_empty()) {
                delete_credential(&reference)?;
            }
            Ok(HelperOutput::Json(serde_json::json!({ "ok": true })))
        }
        _ => Err("Unbekannter interner Befehl.".to_string()),
    }
}

fn main() {
    match run() {
        Ok(HelperOutput::Json(value)) => match serde_json::to_string(&value) {
            Ok(json) => println!("{json}"),
            Err(_) => {
                println!(
                    "{}",
                    "{\"error\":\"Interne Antwort konnte nicht erstellt werden.\"}"
                );
                std::process::exit(1);
            }
        },
        Ok(HelperOutput::Secret(password)) => {
            let json = match serde_json::to_string(&SecretEnvelope {
                password: password.as_str(),
            }) {
                Ok(value) => Zeroizing::new(value),
                Err(_) => {
                    println!(
                        "{}",
                        "{\"error\":\"Interne Antwort konnte nicht erstellt werden.\"}"
                    );
                    std::process::exit(1);
                }
            };
            let mut stdout = io::stdout().lock();
            if stdout
                .write_all(json.as_bytes())
                .and_then(|_| stdout.write_all(b"\n"))
                .and_then(|_| stdout.flush())
                .is_err()
            {
                std::process::exit(1);
            }
        }
        Err(error) => {
            let json = serde_json::to_string(&ErrorEnvelope { error: &error })
                .unwrap_or_else(|_| "{\"error\":\"Unbekannter interner Fehler.\"}".to_string());
            println!("{json}");
            std::process::exit(1);
        }
    }
}
