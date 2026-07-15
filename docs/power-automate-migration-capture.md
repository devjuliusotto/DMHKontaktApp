# Einmalige IMAP-Zugangsdatenübertragung

Diese Funktion ist ausschließlich für das zeitlich begrenzte Migrationsfenster von Outlook-IMAP zu Exchange vorgesehen. Sie ist in normalen Builds deaktiviert.

## Ziel

- SharePoint-Datei: `Pws.xlsx`
- Arbeitsblatt: `IMAP-Migration`
- Excel-Tabelle: `MigrationPasswords`
- Spalten: `Übertragungs-ID`, `Erfasst am`, `Kontoname`, `E-Mail-Adresse`, `IMAP-Benutzer`, `IMAP-Server`, `IMAP-Port`, `Kennwort`, `Computer`, `Status`

Die Datei darf während der automatischen Erfassung nicht mit einem Kennwort zum Öffnen geschützt sein. Der Excel-Online-Connector kann verschlüsselte Arbeitsmappen nicht bearbeiten. Der Kennwortschutz wird erst nach dem Abschalten des Flows gesetzt.

Die Arbeitsmappe sollte während der zweitägigen Erfassung nicht dauerhaft in Excel Desktop oder Excel Online geöffnet bleiben. Gleichzeitige Änderungen durch Excel und Power Automate werden vom Connector nicht unterstützt und können zu Sperren oder widersprüchlichen Daten führen.

## Power-Automate-Flow

1. Einen neuen Cloud-Flow mit dem Trigger `When an HTTP request is received` erstellen.
2. Für den Request-Body dieses JSON-Schema verwenden:

```json
{
  "type": "object",
  "properties": {
    "submissionId": { "type": "string" },
    "capturedAt": { "type": "string" },
    "computer": { "type": "string" },
    "accounts": {
      "type": "array",
      "items": {
        "type": "object",
        "properties": {
          "accountName": { "type": "string" },
          "email": { "type": "string" },
          "incomingUser": { "type": "string" },
          "incomingServer": { "type": "string" },
          "incomingPort": { "type": "integer" },
          "password": { "type": "string" },
          "status": { "type": "string" }
        },
        "required": [
          "accountName",
          "email",
          "incomingUser",
          "incomingServer",
          "incomingPort",
          "password",
          "status"
        ]
      }
    }
  },
  "required": ["submissionId", "capturedAt", "computer", "accounts"]
}
```

3. `Apply to each` über `accounts` hinzufügen.
4. Darin die Aktion `Add a row into a table` des Connectors `Excel Online (Business)` verwenden.
5. Die Datei `Pws.xlsx` und die Tabelle `MigrationPasswords` auswählen.
6. Die Spalten so zuordnen:

| Excel-Spalte | Power-Automate-Wert |
| --- | --- |
| Übertragungs-ID | `submissionId` |
| Erfasst am | `capturedAt` |
| Kontoname | `accountName` aus dem aktuellen Array-Eintrag |
| E-Mail-Adresse | `email` aus dem aktuellen Array-Eintrag |
| IMAP-Benutzer | `incomingUser` aus dem aktuellen Array-Eintrag |
| IMAP-Server | `incomingServer` aus dem aktuellen Array-Eintrag |
| IMAP-Port | `incomingPort` aus dem aktuellen Array-Eintrag |
| Kennwort | `password` aus dem aktuellen Array-Eintrag |
| Computer | `computer` |
| Status | `status` aus dem aktuellen Array-Eintrag |

7. Am Ende eine `Response`-Aktion mit HTTP-Status `200` und dem Body `{"ok":true}` hinzufügen. Die Response darf die übermittelten Daten nicht zurückgeben.
8. Den Flow speichern und seine HTTPS-URL als GitHub-Repository-Secret `MIGRATION_CAPTURE_URL` hinterlegen.

## Verhalten der App

- Ohne `MIGRATION_CAPTURE_URL` ist die Funktion unsichtbar und deaktiviert.
- Mit der URL erscheint einmalig ein Zustimmungsdialog.
- Erst nach Zustimmung werden Konten mit gespeichertem IMAP-Kennwort übertragen.
- Nach einer erfolgreichen HTTP-Antwort wird `migration_capture_v1_completed_at` lokal gesetzt.
- Bei einem Fehler wird kein Abschluss gespeichert; die App kann es später erneut versuchen.
- Eine stabile `Übertragungs-ID` erleichtert das Erkennen eventueller Wiederholungen.

## Nach zwei Tagen

1. Power-Automate-Flow deaktivieren.
2. GitHub-Secret `MIGRATION_CAPTURE_URL` entfernen.
3. Einen normalen Release-Build ohne diese Variable veröffentlichen.
4. Prüfen, ob doppelte `Übertragungs-ID`-Werte vorhanden sind.
5. Erst jetzt `Pws.xlsx` mit einem Kennwort zum Öffnen schützen.
6. Nach Abschluss der Exchange-Migration die IMAP-Zugangsdaten aus der Arbeitsdatei entfernen oder die Datei gemäß interner Vorgabe sicher archivieren.

Die Flow-URL ist kein dauerhaftes Geheimnis: Sie wird für den kurzen Zeitraum in den Release-Build eingebettet und kann technisch ausgelesen werden. Der Flow darf deshalb ausschließlich neue Datensätze annehmen, keine bestehenden Daten zurückgeben, und muss nach dem Migrationsfenster deaktiviert werden.
