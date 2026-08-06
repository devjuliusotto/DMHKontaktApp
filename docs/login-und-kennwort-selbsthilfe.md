# Anmeldung und Kennwort-Selbsthilfe

## Ziel

Die Anwender sollen das DMH Portal normalerweise mit einem einzigen Klick öffnen
und ein vergessenes Microsoft-Kennwort ohne Unterstützung der EDV zurücksetzen
können. Das Portal liest, verarbeitet und speichert das Microsoft-Kennwort nicht.

## Im Portal implementiert

- **Angemeldet bleiben** ist standardmäßig aktiv. Der Refresh-Token wird mit
  Windows DPAPI an Windows-Benutzer und Computer gebunden.
- Die Loginseite besitzt einen großen Bereich **Hilfe mit Anmeldung oder
  Kennwort**.
- **Kennwort vergessen** öffnet direkt `https://aka.ms/sspr`.
- **Kennwort ändern** öffnet direkt die Microsoft-Seite zur Kennwortänderung.
- **Wiederherstellung einrichten** öffnet direkt `https://aka.ms/ssprsetup`.
- Nach der Rückkehr erklärt das Portal in drei Schritten, wie die Anmeldung mit
  dem neuen Kennwort fortgesetzt wird.
- In der Modulauswahl sind **Kennwort ändern** und **Konto wechseln** als
  ausgeschriebene Schaltflächen sichtbar.
- Innerhalb jedes Moduls führt **Portalübersicht** zurück zur Modulauswahl, ohne
  die Microsoft-Sitzung zu beenden.

## Einmalige Einrichtung im Microsoft Entra Admin Center

1. **Entra ID → Password reset → Properties** öffnen.
2. Self-Service Password Reset zunächst für eine Testgruppe, nach erfolgreichem
   Pilotbetrieb für **All** aktivieren.
3. In der aktuellen **Authentication methods policy** mindestens eine für die
   Zielgruppe realistisch nutzbare Methode aktivieren. Für die DMH-Anwender sind
   Mobiltelefon/SMS und Microsoft Authenticator geeignete Optionen. Eine zweite
   Methode reduziert spätere Aussperrungen.
4. Registrierung der Sicherheitsinformationen beim nächsten interaktiven Login
   verlangen und eine erneute Bestätigung nach 180 Tagen konfigurieren.
5. Benachrichtigungen bei Kennwortänderungen aktivieren.
6. Branding und Hilfelink des DMH im Kennwort-Reset konfigurieren, damit die
   Microsoft-Seite für die Anwender vertrauenswürdig erkennbar ist.
7. Den vollständigen Ablauf mit einem normalen Testbenutzer prüfen:
   `https://aka.ms/ssprsetup` und danach `https://aka.ms/sspr`.

Microsoft 365 Business Standard enthält die grundlegenden SSPR-Funktionen für
Cloud-Benutzer. Bei synchronisierten lokalen AD-Konten muss zusätzlich Password
Writeback passend lizenziert und eingerichtet werden.

## Empfohlener nächster Ausbau: Windows-SSO

Der aktuelle Gerätecodefluss ist robust und sicher, verlangt beim ersten Mal
aber einen Browserwechsel. Für die endgültige Senioren-Version soll die
Anmeldung auf **MSAL.NET mit Windows Web Account Manager (WAM)** umgestellt
werden. WAM kann die bereits in Windows bekannte Geschäftsaccount-Sitzung,
Windows Hello, Passkeys und Conditional Access verwenden. Dadurch wird die
normale Anmeldung häufig zu: Konto anklicken → Portal öffnet sich.

Diese Umstellung benötigt einen kleinen signierten Windows-Authentifizierungs-
Helper und einen eigenen Testzyklus. Sie sollte getrennt von der jetzt
implementierten SSPR-Selbsthilfe veröffentlicht werden.
