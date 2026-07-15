# Verschlüsselte IMAP-Zugangsdatenübertragung

Diese Funktion ist ausschließlich für das zeitlich begrenzte Migrationsfenster von Outlook-IMAP zu Exchange vorgesehen. Sie ist in normalen Builds deaktiviert und wird niemals beim App-Start automatisch ausgeführt.

## Sicherheitsmodell

- Die App liest die Outlook-Zugangsdaten erst nach dem Klick auf `E-Mail-Konfiguration mit der EDV teilen` und einer zweiten ausdrücklichen Bestätigung.
- Der Klartext wird auf dem Benutzer-PC mit einem zufälligen AES-256-GCM-Schlüssel verschlüsselt.
- Der AES-Schlüssel wird mit dem administrativen RSA-3072-Schlüssel und OAEP-SHA256 verschlüsselt.
- Im SharePoint stehen nur der verschlüsselte AES-Schlüssel, Nonce, Chiffrat und nicht geheime Übertragungsmetadaten.
- Der zugehörige private RSA-Schlüssel ist nicht exportierbar und liegt ausschließlich unter `Cert:\CurrentUser\My` auf dem eingerichteten Verwaltungs-PC.
- Das Klartext-CSV entsteht ausschließlich lokal mit `scripts/IMAP-Migration-CSV-exportieren.cmd`.

Aktueller Schlüssel-Fingerabdruck:

```text
AAA9524EBD9493FD68F20AAA83CA93841592F637
```

Die im Repository gespeicherte Datei `src-tauri/migration-public-key.json` enthält nur öffentliche RSA-Parameter und darf in den Installer aufgenommen werden. Der private Schlüssel darf niemals in Git, GitHub Secrets, SharePoint, Power Automate oder den Installer gelangen.

## SharePoint-Arbeitsmappe

- Datei: `Pws.xlsx`
- Arbeitsblatt: `IMAP-Migration`
- Excel-Tabelle: `MigrationPasswords`
- Spalten: `Übertragungs-ID`, `Erfasst am`, `Computer`, `Schlüssel-ID`, `Version`, `Algorithmus`, `Verschlüsselter Schlüssel`, `Nonce`, `Verschlüsselte Daten`, `Status`

Jede Übertragung belegt genau eine Tabellenzeile. Sämtliche Konten eines PCs befinden sich gemeinsam im verschlüsselten Datenfeld. E-Mail-Adresse, IMAP-Benutzer, Server und Kennwort dürfen nicht als separate Klartextspalten angelegt werden.

Die Arbeitsmappe darf während des Schreibens durch Power Automate nicht mit einem Kennwort zum Öffnen geschützt sein. Der Excel-Online-Connector kann verschlüsselte Arbeitsmappen nicht bearbeiten. Das ist für die Vertraulichkeit der Zugangsdaten nicht erforderlich, weil deren Inhalt bereits vor der Übertragung verschlüsselt wird.

## Power-Automate-Flow

Für das verschlüsselte Format wird ausschließlich der neue v2-Flow mit seiner eigenen HTTP-URL verwendet. Ein eventuell vorhandener Klartext-Flow darf nicht für diese Funktion eingesetzt werden.

1. Einen neuen Cloud-Flow mit dem Trigger `When an HTTP request is received` erstellen.
2. Für den Request-Body dieses JSON-Schema verwenden:

```json
{
  "type": "object",
  "properties": {
    "version": { "type": "integer" },
    "submissionId": { "type": "string" },
    "capturedAt": { "type": "string" },
    "computer": { "type": "string" },
    "keyId": { "type": "string" },
    "algorithm": { "type": "string" },
    "wrappedKey": { "type": "string" },
    "nonce": { "type": "string" },
    "ciphertext": { "type": "string" },
    "status": { "type": "string" }
  },
  "required": [
    "version",
    "submissionId",
    "capturedAt",
    "computer",
    "keyId",
    "algorithm",
    "wrappedKey",
    "nonce",
    "ciphertext",
    "status"
  ]
}
```

3. Eine einzelne Aktion `Add a row into a table` des Connectors `Excel Online (Business)` verwenden. Kein `Apply to each` anlegen.
4. Die Datei `Pws.xlsx` und die Tabelle `MigrationPasswords` auswählen.
5. Die Spalten über den dynamischen Inhalt des HTTP-Triggers zuordnen. Die Namen dürfen nicht als normaler Text eingegeben werden:

| Excel-Spalte | Power-Automate-Wert |
| --- | --- |
| Übertragungs-ID | `submissionId` |
| Erfasst am | `capturedAt` |
| Computer | `computer` |
| Schlüssel-ID | `keyId` |
| Version | `version` |
| Algorithmus | `algorithm` |
| Verschlüsselter Schlüssel | `wrappedKey` |
| Nonce | `nonce` |
| Verschlüsselte Daten | `ciphertext` |
| Status | `status` |

6. Am Ende eine synchrone `Response`-Aktion mit HTTP-Status `200` und dem Body `{"ok":true}` hinzufügen. Die Response darf keine empfangenen Felder zurückgeben.
7. Die Parallelitätssteuerung des HTTP-Gatetriggers ausgeschaltet lassen. Power Automate kann eine einmal gespeicherte Parallelitätskonfiguration nicht wieder entfernen; außerdem ist sie mit dieser synchronen `Response`-Aktion nicht kompatibel.
8. Den Flow speichern und seine neue HTTPS-URL als GitHub-Repository-Secret `MIGRATION_CAPTURE_URL` hinterlegen. Der Release-Workflow verweigert die Veröffentlichung, wenn dieses Secret fehlt.

Die Flow-URL ist kein dauerhaftes Geheimnis und befindet sich während des Migrationsfensters technisch im Build. Der Flow darf deshalb ausschließlich neue Datensätze annehmen, keine gespeicherten Datensätze zurückgeben und muss nach dem Migrationsfenster deaktiviert werden.

## Verhalten der App

- Ohne `MIGRATION_CAPTURE_URL` bleibt der Bereich in den Einstellungen sichtbar, erklärt den Konfigurationsfehler und deaktiviert die Übertragung.
- Mit der URL erscheint unter `Einstellungen` der Button `E-Mail-Konfiguration mit der EDV teilen`.
- Beim Start, Update oder Öffnen der Einstellungen wird nichts übertragen.
- Nach dem Button erscheint die Frage: `Die EDV muss Ihre E-Mail-Konfiguration auf das neue Exchange-System übertragen. Möchten Sie die Zugangsdaten verschlüsselt an die EDV senden?`
- Erst nach Bestätigung werden Konten mit gespeichertem IMAP-Kennwort gelesen, lokal verschlüsselt und übertragen.
- Nach einer erfolgreichen HTTP-Antwort wird `migration_capture_v2_completed_at` lokal gesetzt und der Button deaktiviert.
- Eine stabile `Übertragungs-ID` erleichtert das Entfernen eventueller Wiederholungszeilen.

## CSV auf dem Verwaltungs-PC erzeugen

Voraussetzungen: PowerShell 7, Microsoft Excel Desktop und der private Schlüssel im Zertifikatsspeicher dieses Windows-Benutzers.

1. `Pws.xlsx` aus SharePoint herunterladen oder die synchronisierte lokale Datei verwenden.
2. `scripts/IMAP-Migration-CSV-exportieren.cmd` starten.
3. Die Arbeitsmappe und anschließend den Speicherort für `IMAP-zu-Exchange.csv` auswählen.
4. Das Skript prüft Versionsnummer, Algorithmus, GCM-Authentifizierung und Schlüssel-Fingerabdruck.
5. Die leere Ausgangszeile der Excel-Tabelle und doppelte `Übertragungs-ID`-Zeilen werden beim Export übersprungen.
6. Das erzeugte Semikolon-CSV enthält: `E-Mail-Adresse`, `IMAP-Benutzer`, `Kennwort`, `IMAP-Server`, `IMAP-Port`, `Kontoname`, `Computer`, `Erfasst am`, `Übertragungs-ID`.
7. Das CSV unmittelbar in das Exchange-Migrationssystem hochladen und anschließend löschen.

Der Leser kann mit folgendem Befehl ohne SharePoint-Daten geprüft werden:

```powershell
pwsh -NoProfile -File .\scripts\export-migration-credentials.ps1 -SelfTest
```

## Schlüsselrotation

`scripts/setup-migration-admin-key.ps1` erstellt einen neuen nicht exportierbaren Schlüssel und schreibt dessen öffentlichen Teil nach `src-tauri/migration-public-key.json`. Eine Rotation darf nur vor einem neuen Erfassungsfenster erfolgen. Bereits gespeicherte Pakete bleiben an ihren alten Fingerabdruck gebunden und müssen vorher exportiert werden.

## Nach dem Migrationsfenster

1. Power-Automate-Flow deaktivieren.
2. GitHub-Secret `MIGRATION_CAPTURE_URL` entfernen.
3. Die temporäre Prüfung `Validate encrypted migration endpoint` aus `.github/workflows/release.yml` entfernen und einen normalen Release-Build ohne diese Variable veröffentlichen.
4. Das Klartext-CSV nach erfolgreicher Übergabe aus dem Verwaltungs-PC löschen.
5. Die verschlüsselten SharePoint-Zeilen gemäß interner Aufbewahrungsvorgabe löschen oder archivieren.
6. Wenn der Schlüssel nicht mehr benötigt wird, erst nach Abschluss aller Exporte das Zertifikat mit dem dokumentierten Fingerabdruck aus `Cert:\CurrentUser\My` entfernen.
