# Microsoft-365-Verbindung einrichten

Die App verbindet ein dienstliches Microsoft-365-Konto unter:

`Einstellungen → Advanced → Microsoft 365`

Diese erste Integrationsstufe liest ausschließlich das Profil des angemeldeten
Benutzers. Kontakte, Kalender, Teams und der lokale Passwort-Tresor werden noch
nicht synchronisiert oder verändert.

## 1. Anwendung in Microsoft Entra ID registrieren

1. Microsoft Entra Admin Center öffnen.
2. Eine neue App-Registrierung für `DMH Kontakte und Kalender` anlegen.
3. Als Kontotyp ausschließlich Konten dieses Organisationsverzeichnisses wählen
   (Single Tenant).
4. Unter **Authentifizierung → Erweiterte Einstellungen** die Option
   **Öffentliche Clientflows zulassen** aktivieren.
5. Unter **API-Berechtigungen** nur die delegierte Microsoft-Graph-Berechtigung
   `User.Read` hinzufügen.
6. Mandanten-ID und Anwendungs-ID notieren.

Für den Device-Code-Flow ist kein Client-Secret und keine Redirect-URI
erforderlich. Ein Client-Secret darf niemals in den Desktop-Build aufgenommen
werden.

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
- Angefordert werden zunächst nur `openid`, `profile`, `offline_access` und
  `User.Read`.
- Der erneuerbare Token wird mit Windows DPAPI an den aktuellen
  Windows-Benutzer und Computer gebunden gespeichert.
- `Konto trennen` löscht den geschützten Token und das lokale Kontoprofil.
- Kontakte und Kalender erhalten später eigene, ausdrücklich freizugebende
  Berechtigungs- und Migrationsschritte.

## Fehlersuche

- **Einrichtung durch die EDV erforderlich:** `M365_CLIENT_ID` war beim Build
  nicht gesetzt oder ungültig.
- **Microsoft-Anwendung ist nicht korrekt eingerichtet:** App-Registrierung,
  Mandant und öffentliche Clientflows prüfen.
- **Kein erneuerbarer Token:** `offline_access` oder öffentliche Clientflows
  wurden vom Tenant blockiert.
- **Anmeldung abgelaufen:** Konto in der App trennen und erneut verbinden;
  zusätzlich Entra-Anmeldeprotokolle und Conditional-Access-Regeln prüfen.
