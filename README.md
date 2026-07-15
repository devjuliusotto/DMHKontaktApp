# AgendaKontakte

AgendaKontakte ist eine lokale Windows-Desktop-App zur einfachen Verwaltung von Kontakten. Die Daten bleiben auf dem PC und werden in einer lokalen SQLite-Datenbank gespeichert. Es ist kein Microsoft-Login und keine Microsoft-Graph-Integration erforderlich.

## Funktionen

- Willkommensseite mit kurzer Erklärung der wichtigsten Bereiche
- Kontakte anlegen, bearbeiten, suchen und löschen
- Gruppen erstellen und Kontakte Gruppen zuordnen
- CSV-Import mit Vorschau
- Excel-Import (`.xlsx`) mit Vorschau
- Import direkt in eine ausgewählte Gruppe
- Import aus Outlook-Datendateien (`.pst`/`.ost`) über installiertes Outlook Classic
- Duplikate werden anhand der E-Mail-Adresse vermieden
- Export für Outlook Classic, New Outlook und allgemeines CSV
- Kalendertermine aus `.ics`, `.eml`, `.pst`- und `.ost`-Dateien importieren
- E-Mail per `mailto:` öffnen
- IMAP-Konten aus Outlook Classic sicher übernehmen
- IMAP-Anmeldung testen, ohne Kennwörter an React oder SQLite zu übertragen
- E-Mail und Telefonnummer kopieren
- Kontaktliste drucken
- Automatische lokale Sicherung beim Start

## Voraussetzungen für Entwickler

- Windows 10 oder neuer
- Node.js LTS
- Rust stable
- Microsoft Visual Studio Build Tools mit C++ Desktop-Workload
- Rust-Ziele für 64-Bit- und 32-Bit-Outlook (`x86_64-pc-windows-msvc` und `i686-pc-windows-msvc`)

## Installation der Abhängigkeiten

```powershell
npm install
rustup target add i686-pc-windows-msvc
```

## Entwicklung starten

```powershell
npm run tauri:dev
```

## Windows-Installer erstellen

```powershell
npm run tauri:build
```

Die Installer-Dateien werden unter `src-tauri\target\release\bundle\` erstellt. Je nach installierter Tauri-Toolchain entstehen dort MSI- und/oder EXE-Bundles.

## Datenspeicherung

Die SQLite-Datenbank liegt im lokalen App-Datenverzeichnis von Windows. Die Anwendung legt die Datenbank und das Schema beim ersten Start automatisch an.

## Importhinweise

Beim Import erkennt AgendaKontakte typische Spaltennamen automatisch, zum Beispiel:

- `Name`
- `Vorname`
- `Nachname`
- `E-Mail`
- `Email`
- `Telefon`
- `Mobile`
- `Straße`
- `PLZ`
- `Stadt`

Vor dem Import wird eine Vorschau angezeigt. Kontakte können einzeln ausgewählt werden.

Kontakte mit erkannter E-Mail-Adresse und Kontakte ohne erkannte E-Mail-Adresse werden in getrennten Tabellen angezeigt. Beim Import kann direkt eine vorhandene Gruppe ausgewählt werden, damit die neuen Kontakte automatisch dieser Gruppe zugeordnet werden.

## Kurzanleitung für Anwender

1. Öffnen Sie `Willkommen`, um die wichtigsten Bereiche der App zu sehen.
2. Öffnen Sie `Kontakte`, um Personen anzulegen, zu bearbeiten, zu suchen oder Gruppen zu verwenden.
3. Ziehen Sie Kontakte in `Kontakte` mit der Maus auf eine Gruppe, um sie zuzuordnen.
4. Öffnen Sie `Importieren`, wählen Sie eine CSV- oder Excel-Datei aus und prüfen Sie die Tabellen mit und ohne E-Mail.
5. Wählen Sie beim Import optional eine Gruppe aus, damit Kontakte direkt einsortiert werden.
6. Öffnen Sie `Kalender`, um Termine aus Thunderbird-Exporten, E-Mail-Einladungen oder Outlook-Datendateien als `.ics`, `.eml`, `.pst` oder `.ost` zu importieren.
7. Öffnen Sie `Exportieren`, um Kontakte für Outlook Classic, New Outlook oder als allgemeine CSV-Datei zu speichern.

## Outlook-Export

Nach dem Export zeigt die App den Hinweis:

> Die Datei wurde erstellt. Öffnen Sie Outlook, gehen Sie zu Personen/Kontakte und wählen Sie Importieren.

## Outlook-IMAP-Konto übernehmen

Unter `Einstellungen` kann AgendaKontakte die IMAP-Konten des aktuellen Outlook-Classic-Profils suchen. Die Funktion unterstützt ausschließlich Outlook Classic und lokale IMAP-Konten; New Outlook und Exchange-/Microsoft-365-OAuth-Konten werden nicht importiert.

Der Build erzeugt zwei native Hilfsprogramme für Outlook 32-Bit und 64-Bit. Beim Import schreibt das passende Hilfsprogramm das gespeicherte IMAP- beziehungsweise SMTP-Kennwort direkt als `CRED_TYPE_GENERIC` mit `CRED_PERSIST_LOCAL_MACHINE` in den Windows Credential Manager. Die Tauri-Anwendung erhält nur Kontodaten und eine Credential-Referenz.

SQLite speichert Server, Ports, Verschlüsselung, Benutzernamen und Credential-Referenzen. Kennwörter werden weder in SQLite noch in React, JSON-Antworten, Logs oder Anwendungssicherungen gespeichert. Beim Entfernen eines importierten Kontos werden auch seine lokalen Credential-Manager-Einträge gelöscht.

## Sicherheit

Alle Daten bleiben lokal auf dem PC. Sicherungen sollten regelmäßig auf einem sicheren lokalen Laufwerk oder einem geschützten Netzlaufwerk abgelegt werden.

Outlook-Kennwörter bleiben an den angemeldeten Windows-Benutzer und diesen Computer gebunden. Der IMAP-Verbindungstest läuft ausschließlich über SSL/TLS, liest das Kennwort innerhalb des nativen Hilfsprogramms, löscht temporäre Kennwortpuffer anschließend und gibt nur Erfolg oder eine bereinigte Fehlermeldung zurück.
