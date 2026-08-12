# Microsoft-365-Anmeldung für das DMH Portal einrichten

Das DMH Portal verwendet das dienstliche Microsoft-365-Konto als primäre
Anmeldung. Nach der Anmeldung werden die Entra-Sicherheitsgruppen des Benutzers
geprüft und nur die freigegebenen Module geöffnet.

Neben Profil und Gruppenmitgliedschaften synchronisiert das Modul
Privatschwestern die persönlichen Exchange-Kontakte und den primären Kalender
des angemeldeten Benutzers. Der Passwort-Tresor bleibt in dieser Etappe lokal.

## 1. Anwendung in Microsoft Entra ID registrieren

1. Microsoft Entra Admin Center öffnen.
2. Eine neue App-Registrierung für `DMH Portal` anlegen oder die vorhandene
   Registrierung von `DMH Kontakte und Kalender` weiterverwenden.
3. Als Kontotyp ausschließlich Konten dieses Organisationsverzeichnisses wählen
   (Single Tenant).
4. Unter **Authentifizierung → Plattform hinzufügen → Mobilgeräte- und
   Desktopanwendungen** die Umleitungs-URI `http://localhost` hinzufügen.
5. Unter **Authentifizierung → Erweiterte Einstellungen** die Option
   **Öffentliche Clientflows zulassen** aktivieren.
6. Unter **API-Berechtigungen** folgende delegierte Microsoft-Graph-
   Berechtigungen hinzufügen:
   - `User.Read`
   - `Contacts.ReadWrite`
   - `Calendars.ReadWrite`
   - `Sites.Selected` (für das KFZ-Modul, delegiert)
7. **Administratoreinwilligung für den DMH-Mandanten erteilen** wählen und den
   Status aller drei Berechtigungen kontrollieren.
8. Mandanten-ID und Anwendungs-ID notieren.

Der Desktop-Login verwendet den Systembrowser mit Authorization Code und PKCE.
Der Browser kehrt über eine kurzlebige lokale Adresse automatisch zum Portal
zurück; Benutzer müssen keinen Code kopieren oder eingeben. Ein Client-Secret
ist nicht erforderlich und darf niemals in den Desktop-Build aufgenommen werden.

## 2. Sicherheitsgruppen anlegen

Mindestens eine statische Sicherheitsgruppe im Microsoft Entra Admin Center
anlegen. Es ist zulässig, zunächst ausschließlich die EDV-Gruppe zu verwenden:

- `DMH-Portal-Privatschwestern`
- optional `DMH-Portal-EDV`
- optional `DMH-Portal-KFZ`

Die Benutzer den passenden Gruppen zuordnen und unter **Gruppen → Übersicht**
jeweils die **Objekt-ID** kopieren. Verwendet werden ausschließlich Objekt-IDs;
eine spätere Umbenennung der Gruppe ändert dadurch keine Berechtigung.

Verschachtelte Mitgliedschaften werden ebenfalls berücksichtigt. Normale
Exchange-Verteilerlisten sollen nicht als Sicherheitsgrenze verwendet werden.

## 3. GitHub-Variablen hinterlegen

Unter `Repository → Settings → Secrets and variables → Actions → Variables`:

| Variable | Inhalt |
|---|---|
| `M365_CLIENT_ID` | Anwendungs-ID der Entra-App |
| `M365_TENANT_ID` | Mandanten-ID des DMH-Tenants |
| `DMH_PORTAL_PRIVATSCHWESTERN_GROUP_IDS` | Optional: Objekt-ID der Gruppe für das Kontakte-/Kalender-Modul |
| `DMH_PORTAL_EDV_GROUP_IDS` | Optional: Objekt-ID der EDV-Gruppe |
| `DMH_PORTAL_KFZ_GROUP_IDS` | Optional: Objekt-ID der KFZ-Gruppe |
| `M365_EDV_CLIENT_ID` | Optional: separate Entra-App für die administrative EDV-Sitzung |

Mehrere Gruppen-IDs für dasselbe Modul werden durch Kommas getrennt. Mindestens
eine der Modulgruppen ist für Release-Builds verpflichtend. Ohne
konfigurierte Modulgruppe bleibt das Portal sicher geschlossen und zeigt einen
EDV-Hinweis.

Die Mitglieder von `DMH_PORTAL_EDV_GROUP_IDS` erhalten innerhalb des EDV-Moduls
den vollständigen Funktionsumfang. Microsoft-Entra-Rollen bleiben eine unabhängige
zweite Sicherheitsprüfung für Änderungen an Benutzern, Kennwörtern und Gruppen.

Beide Werte sind Identifikatoren, keine Kennwörter. Die Release-Workflows geben
sie beim Kompilieren an den Rust-Build weiter.

## 4. Lokal testen

Die Variablen müssen gesetzt sein, bevor Rust kompiliert wird:

```powershell
$env:M365_CLIENT_ID = "<Anwendungs-ID>"
$env:M365_TENANT_ID = "<Mandanten-ID>"
$env:DMH_PORTAL_PRIVATSCHWESTERN_GROUP_IDS = "<Objekt-ID der Sicherheitsgruppe>"
$env:DMH_PORTAL_EDV_GROUP_IDS = "<optionale Objekt-ID der EDV-Gruppe>"
$env:DMH_PORTAL_KFZ_GROUP_IDS = "<optionale Objekt-ID der KFZ-Gruppe>"
npm run tauri:dev:admin-test
```

Wenn die Werte geändert werden, die laufende Entwicklungs-App vollständig
beenden und neu bauen.

## Sicherheit und Datenspeicherung

- Die App sieht oder speichert das Microsoft-Kennwort nicht.
- Angefordert werden `openid`, `profile`, `offline_access`, `User.Read`,
  `Contacts.ReadWrite` und `Calendars.ReadWrite` als delegierte Rechte. Die App
  arbeitet damit ausschließlich im Kontext des angemeldeten Benutzers.
- Das KFZ-Modul fordert `Sites.Selected` erst beim Fuhrpark-Abgleich an. Die
  Portal-App erhält dadurch keinen pauschalen Zugriff auf andere SharePoint-Sites.
- Mit **Angemeldet bleiben** wird der erneuerbare Token mit Windows DPAPI an den
  aktuellen Windows-Benutzer und Computer gebunden gespeichert.
- Ohne **Angemeldet bleiben** verbleibt die Sitzung nur im Arbeitsspeicher und
  endet vollständig mit dem Prozess.
- Beim Start wird die Sitzung online erneuert. Ist Microsoft 365 vorübergehend
  nicht erreichbar, darf eine zuvor bestätigte Sitzung mit den zuletzt
  bestätigten Modulrechten höchstens 24 Stunden offline weiterarbeiten.
- `Konto trennen` löscht den geschützten Token und das lokale Kontoprofil.
- Lokale Änderungen bleiben bei fehlender Verbindung erhalten und werden beim
  nächsten erfolgreichen Lauf übertragen.
- Teams-Besprechungsinformationen und Teilnehmer werden bei einer Bearbeitung
  im Portal nicht überschrieben. Das Löschen eines vom Benutzer organisierten
  Besprechungstermins kann – wie in Outlook – eine Absage auslösen.

## Verhalten der Synchronisierung

- Die erste Synchronisierung startet kurz nach der Anmeldung.
- Weitere Läufe starten ungefähr alle fünf Minuten und 1,5 Sekunden nach
  lokalen Änderungen. Viele schnelle Änderungen werden dabei gebündelt.
- Über das Wolken-/Synchronisierungssymbol in der Seitenleiste oder unter
  **Einstellungen → Erweitert → Microsoft 365** kann jederzeit manuell
  synchronisiert werden.
- Kontakte bleiben im lokalen SQLite-Cache. Kalenderdaten bleiben im lokalen,
  durch die App gesicherten Browser-Speicher und werden weiterhin in die
  vorhandenen App-Sicherungen aufgenommen.
- Graph-Abfragen laufen asynchron und seitenweise. Die Oberfläche bleibt auch
  während größerer Übertragungen bedienbar.
- Neue lokale Datensätze werden in Exchange angelegt; neue Exchange-Datensätze
  werden lokal übernommen. Löschungen werden in beide Richtungen übertragen.
- Bei gleichzeitiger Änderung derselben verknüpften Version gewinnt die zuletzt
  geänderte Version. Der Lauf weist solche Konflikte in seiner Zusammenfassung
  aus.
- Lokale Kontaktgruppen werden als Exchange-Kategorien übertragen. Das Feld
  **Kurzinfo** wird mit dem Exchange-Feld **Firma** synchronisiert.
- Synchronisiert werden der Standard-Kontaktordner und der primäre persönliche
  Kalender des Benutzers. Standardserien werden unterstützt; Teams-Termine
  bleiben als Termine im Kalender sichtbar.

## Fehlersuche

- **Einrichtung durch die EDV erforderlich:** `M365_CLIENT_ID` war beim Build
  nicht gesetzt oder es wurde keine Portal-Sicherheitsgruppe konfiguriert.
- **Noch kein Modul freigegeben:** Das Konto ist gültig, gehört aber keiner der
  im Build hinterlegten Gruppen an. Gruppenmitgliedschaft prüfen und in der App
  **Gruppen erneut prüfen** wählen.
- **Microsoft-Anwendung ist nicht korrekt eingerichtet:** App-Registrierung,
  Mandant und öffentliche Clientflows prüfen.
- **Kein erneuerbarer Token:** `offline_access` oder öffentliche Clientflows
  wurden vom Tenant blockiert.
- **Anmeldung abgelaufen:** Konto in der App trennen und erneut verbinden;
  zusätzlich Entra-Anmeldeprotokolle und Conditional-Access-Regeln prüfen.
- **HTTP 403 bei der Synchronisierung:** Die delegierten Rechte
  `Contacts.ReadWrite` und `Calendars.ReadWrite` sowie die
  Administratoreinwilligung kontrollieren. Danach einmal ab- und wieder
  anmelden, damit der Token die neuen Rechte erhält.

## KFZ-Modul und SharePoint

Das KFZ-Modul liest im Pilotbetrieb ausschließlich die vorhandenen Ressourcen
im Site `dmhaidlingen.sharepoint.com/sites/DMHFuhrpark`:

- Liste `Fahrzeuge`
- Liste `Wartungen`
- Liste `Standorte`
- Dokumentbibliothek `Fahrzeugdokumente`

Neben der Entra-Einwilligung für `Sites.Selected` muss die Portal-App explizit
mit der Rolle `read` auf genau diesen Site berechtigt werden. Ohne diese
Ressourcenzuweisung bleibt das Modul geschlossen und zeigt einen verständlichen
Hinweis. Während des Piloten bietet der Client keine SharePoint-Schreibbefehle.

Die erste erfolgreiche Synchronisierung baut einen lokalen SQLite-Cache auf.
Weitere Läufe verwenden den SharePoint-Änderungszeitpunkt und laden mit zwei
Minuten Sicherheitsüberlappung nur neue oder geänderte Einträge. Ein manueller
Vollabgleich kann unter **KFZ → Einstellungen** ausgelöst werden.

## EDV-Verwaltung und Planner

Das EDV-Modul verwendet absichtlich eine zweite Microsoft-Anmeldung. Dadurch
erhält die normale Portal-Sitzung keine Verzeichnis- oder Planner-Schreibrechte.
Für die sauberste Trennung wird eine zweite öffentliche Entra-App registriert
und deren Anwendungs-ID als `M365_EDV_CLIENT_ID` hinterlegt. Ohne diese Variable
wird vorübergehend die bestehende App-Registrierung verwendet.

Für die EDV-App müssen ebenfalls die Desktop-Umleitungs-URI `http://localhost`
und **Allow public client flows** konfiguriert sein. Folgende delegierte
Microsoft-Graph-Berechtigungen werden aktiviert und per Admin Consent bestätigt:

- `User.Read`, `User.Read.All`, `User.ReadWrite.All`
- `User.EnableDisableAccount.All`
- `User-PasswordProfile.ReadWrite.All`
- `Group.Read.All`, `Group.ReadWrite.All`, `GroupMember.ReadWrite.All`
- `Tasks.ReadWrite`
- `offline_access`, `openid`, `profile`

Zusätzlich benötigt der angemeldete Mensch eine passende Entra-Rolle. Für
Gruppenänderungen ist **Groups Administrator**, für Benutzeränderungen **User
Administrator** vorgesehen. Die Portalgruppe allein verleiht keine
Microsoft-Administratorrechte.

Für Tickets wird ein **Basisplan** in Microsoft Planner angelegt. Die Plan-ID
steht in der Planner-Webadresse und wird einmalig im EDV-Modul unter **Tickets**
eingetragen. Buckets erscheinen als Spalten, Aufgaben als Karten. Planner selbst
wird den Anwendern nicht angezeigt.

Das Systeminventar und das zusätzliche Portal-Änderungsprotokoll sind in dieser
Ausbaustufe gerätebezogen in SQLite gespeichert. Entra- und Planner-Änderungen
bleiben zusätzlich in Microsoft 365 nachvollziehbar. Für ein gemeinsames
Inventar auf mehreren PCs ist als nächster Schritt eine SharePoint-Liste mit
`Sites.Selected` vorgesehen.
