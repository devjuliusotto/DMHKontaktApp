# DMH Portal

DMH Portal ist eine modulare Windows-Desktop-App. Das bisherige Kontakte-, Kalender- und Passwortprogramm bildet das Modul **Privatschwestern**. Der Zugang erfolgt über das dienstliche Microsoft-365-Konto und Entra-Sicherheitsgruppen. Kontakte und Kalender werden mit dem persönlichen Exchange-Postfach synchronisiert; lokale Kopien sorgen für schnelle Bedienung und Offline-Arbeit.

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
- IMAP-Anmeldung testen und das Kennwort auf ausdrücklichen Wunsch zeitlich begrenzt anzeigen
- Zeitlich begrenzte, einmalige Übergabe von IMAP-Zugangsdaten an die EDV nach ausdrücklicher Zustimmung
- E-Mail und Telefonnummer kopieren
- Kontaktliste drucken
- Automatische lokale Sicherung beim Start
- Microsoft-365-Anmeldung mit optional dauerhaft geschützter Sitzung
- Modulfreigabe über Entra-Sicherheitsgruppen
- Portalübersicht mit ausschließlich den für das Konto freigegebenen Modulen
- Eigenständiger EDV-Bereich als Grundlage der zentralen Portalverwaltung
- Automatische bidirektionale Exchange-Synchronisierung für Kontakte und Kalender
- Lokale Offline-Änderungen mit späterer Übertragung

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

Für eine vollständig getrennte lokale Admin-Test-Instanz:

```powershell
npm run tauri:dev:admin-test
```

Der vollständige Ablauf für Testkanal, Freigabe, Versionsnummern und GitHub Actions ist in
[`docs/release-channels.md`](docs/release-channels.md) beschrieben.

## Windows-Installer erstellen

```powershell
npm run tauri:build
```

Die Installer-Dateien werden unter `src-tauri\target\release\bundle\` erstellt. Je nach installierter Tauri-Toolchain entstehen dort MSI- und/oder EXE-Bundles.

## Datenspeicherung

Die SQLite-Datenbank liegt im lokalen App-Datenverzeichnis von Windows. Die Anwendung legt die Datenbank und das Schema beim ersten Start automatisch an. Kontakte werden dort zwischengespeichert; der Kalender verwendet weiterhin den lokalen WebView-Speicher. Beide Datenbereiche werden nach erfolgreicher Anmeldung mit Exchange synchronisiert.

## Importhinweise

Beim Import erkennt DMH Kontakte und Kalender typische Spaltennamen automatisch, zum Beispiel:

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

## Outlook-Daten einmalig übernehmen

Unter `Einstellungen` stehen außerdem zwei getrennte Einmalimporte für Outlook Classic bereit. `Alle Kontakte einmalig importieren` liest sämtliche erreichbaren Kontaktordner aller Stores des aktuellen Profils und legt neue lokale Kontakte an; bereits vorhandene Personen werden ausgelassen. `Alle Termine einmalig importieren` liest sämtliche erreichbaren Kalenderordner unabhängig von Konto, Ordner und Kategorie und übernimmt noch nicht vorhandene Termine in den lokalen Kalender. Die Importaktionen verändern Outlook Classic nicht. Die übernommenen Daten werden anschließend von der normalen Exchange-Synchronisierung verarbeitet.

## Outlook-IMAP-Konto übernehmen

Unter `Einstellungen` kann DMH Kontakte und Kalender die IMAP-Konten des aktuellen Outlook-Classic-Profils suchen. Die Funktion unterstützt ausschließlich Outlook Classic und lokale IMAP-Konten; New Outlook und Exchange-/Microsoft-365-OAuth-Konten werden nicht importiert.

Der Build erzeugt zwei native Hilfsprogramme für Outlook 32-Bit und 64-Bit. Beim Import schreibt das passende Hilfsprogramm das gespeicherte IMAP- beziehungsweise SMTP-Kennwort direkt als `CRED_TYPE_GENERIC` mit `CRED_PERSIST_LOCAL_MACHINE` in den Windows Credential Manager. Die Tauri-Anwendung erhält beim normalen Import nur Kontodaten und eine Credential-Referenz.

SQLite speichert Server, Ports, Verschlüsselung, Benutzernamen und Credential-Referenzen. Kennwörter werden weder in SQLite noch in Logs oder Anwendungssicherungen gespeichert. Nur nach einer ausdrücklichen Bestätigung wird das IMAP-Kennwort einmal über den lokalen Tauri-Kanal an die Oberfläche übertragen. Dort bleibt es ausschließlich im flüchtigen Seitenzustand und wird nach 60 Sekunden, beim Fensterwechsel, mit Esc oder über die Schaltfläche wieder verborgen. Eine Kopierfunktion für die Zwischenablage ist bewusst nicht vorhanden. Beim Entfernen eines importierten Kontos werden auch seine lokalen Credential-Manager-Einträge gelöscht.

Für die zeitlich begrenzte Exchange-Migration kann ein Release-Build zusätzlich mit `MIGRATION_CAPTURE_URL` konfiguriert werden. Unter `Einstellungen` ist der Bereich `E-Mail-Umstellung auf Exchange` immer sichtbar; ohne gültigen Endpunkt zeigt er einen klaren EDV-Hinweis und deaktiviert den Button, statt die Funktion zu verstecken. Erst nach dem Button und einer zweiten ausdrücklichen Bestätigung liest der native Helper die gespeicherten IMAP-Zugangsdaten. Noch auf dem Benutzer-PC werden sämtliche Kontodaten mit AES-256-GCM verschlüsselt und der Sitzungsschlüssel mit dem öffentlichen RSA-Schlüssel des Verwaltungs-PCs geschützt. Power Automate und SharePoint erhalten ausschließlich das verschlüsselte Paket. Der erfolgreiche Abschluss wird lokal in `app_settings` gespeichert; das Kennwort selbst wird dort nicht gespeichert. Der Release-Workflow bricht ab, wenn `MIGRATION_CAPTURE_URL` fehlt oder kein HTTPS-Endpunkt ist. Einrichtung, lokaler CSV-Export und spätere Deaktivierung sind in `docs/power-automate-migration-capture.md` dokumentiert.

## Sicherheit

Kontakte und Kalender werden zusätzlich im persönlichen Exchange-Postfach des angemeldeten Benutzers gespeichert. Lokale Sicherungen sollten dennoch regelmäßig auf einem geschützten Laufwerk abgelegt werden. Der Passwort-Tresor bleibt bis zur Etappe 3 ausschließlich lokal und verschlüsselt.

Außerhalb der ausdrücklich aktivierten Exchange-Migration bleiben Outlook-Kennwörter an den angemeldeten Windows-Benutzer und diesen Computer gebunden. Der IMAP-Verbindungstest läuft ausschließlich über SSL/TLS, liest das Kennwort innerhalb des nativen Hilfsprogramms, löscht temporäre Kennwortpuffer anschließend und gibt nur Erfolg oder eine bereinigte Fehlermeldung zurück. Bei der bewussten Kennwortanzeige und der bestätigten Migrationsübertragung werden native Kennwortpuffer nach ihrer Verwendung überschrieben. Während der lokalen Verschlüsselung liegt das Kennwort technisch bedingt kurzzeitig im Arbeitsspeicher; im Migrationspfad wird es jedoch niemals im Klartext an Power Automate, SharePoint oder die React-Oberfläche übertragen.
