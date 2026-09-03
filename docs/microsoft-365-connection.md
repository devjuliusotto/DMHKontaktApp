# Microsoft-365-Verbindung einrichten

Die App verbindet ein dienstliches Microsoft-365-Konto unter:

`Synchronisierung → Verbinden`

Der Standardweg öffnet die offizielle Microsoft-Anmeldung im Standardbrowser.
Nach Eingabe von E-Mail und Kennwort kehrt die Anmeldung automatisch zu DMH
Backup zurück. Ein Gerätecode wird nur als technische Alternative angeboten,
wenn der normale Rückweg auf dem PC blockiert ist.

## 1. Anwendung in Microsoft Entra ID registrieren

1. Microsoft Entra Admin Center öffnen.
2. Eine neue App-Registrierung für `DMH Backup` anlegen.
3. Als Kontotyp ausschließlich Konten dieses Organisationsverzeichnisses wählen
   (Single Tenant).
4. Unter **Authentifizierung → Plattform hinzufügen → Mobile und
   Desktopanwendungen** die Redirect-URI `http://localhost` eintragen.
5. Unter **Authentifizierung → Erweiterte Einstellungen** die Option
   **Öffentliche Clientflows zulassen** aktivieren.
6. Unter **API-Berechtigungen** die von der App benötigten delegierten
   Microsoft-Graph-Berechtigungen eintragen: `User.Read`,
   `Contacts.ReadWrite`, `Contacts.ReadWrite.Shared`, `Calendars.ReadWrite`,
   `Calendars.ReadWrite.Shared`, `Calendars.Read.Shared`,
   `MailboxSettings.Read`, `Files.ReadWrite.All` und `Sites.Read.All`.
7. Den erforderlichen Administratoreinwilligungen des DMH-Tenants zustimmen.
8. Mandanten-ID und Anwendungs-ID notieren.

Für den Desktop-Flow mit PKCE ist kein Client-Secret erforderlich. Ein
Client-Secret darf niemals in den Desktop-Build aufgenommen werden. Die
Redirect-URI wird nur auf dem jeweiligen PC und nur während der Anmeldung
erreichbar gemacht.

## 2. GitHub-Variablen hinterlegen

Unter `Repository → Settings → Secrets and variables → Actions → Variables`:

| Variable | Inhalt |
|---|---|
| `M365_CLIENT_ID` | Anwendungs-ID der Entra-App |
| `M365_TENANT_ID` | Mandanten-ID des DMH-Tenants |

Beide Werte sind Identifikatoren, keine Kennwörter. Die Release-Workflows geben
sie beim Kompilieren an den Rust-Build weiter.

## 3. Lokal testen

Die Variablen müssen gesetzt sein, bevor Rust kompiliert wird:

```powershell
$env:M365_CLIENT_ID = "<Anwendungs-ID>"
$env:M365_TENANT_ID = "<Mandanten-ID>"
npm run tauri:dev:admin-test
```

Wenn die Werte geändert werden, die laufende Entwicklungs-App vollständig
beenden und neu bauen.

## Sicherheit und Datenspeicherung

- Die App sieht oder speichert das Microsoft-Kennwort nicht.
- Das Kennwort wird ausschließlich auf der offiziellen Microsoft-Seite
  eingegeben.
- Die Anmeldung verwendet Authorization Code Flow mit PKCE und einen zufälligen
  Sicherheitswert für jede Verbindung.
- Der erneuerbare Token wird mit Windows DPAPI an den aktuellen
  Windows-Benutzer und Computer gebunden gespeichert.
- `Konto trennen` löscht den geschützten Token und das lokale Kontoprofil.
- Kontakte und Kalender erhalten später eigene, ausdrücklich freizugebende
  Berechtigungs- und Migrationsschritte.

## Fehlersuche

- **Einrichtung durch die EDV erforderlich:** `M365_CLIENT_ID` war beim Build
  nicht gesetzt oder ungültig.
- **Microsoft-Anwendung ist nicht korrekt eingerichtet:** App-Registrierung,
  Mandant, öffentliche Clientflows und die Desktop-Redirect-URI
  `http://localhost` prüfen. Bei `AADSTS50011` fehlt oder stimmt diese
  Redirect-URI nicht.
- **Kein erneuerbarer Token:** `offline_access` oder öffentliche Clientflows
  wurden vom Tenant blockiert.
- **Anmeldung abgelaufen:** Konto in der App trennen und erneut verbinden;
  zusätzlich Entra-Anmeldeprotokolle und Conditional-Access-Regeln prüfen.
