# Abnahmetest — DMH Portal Etappen 1 und 2

Dieser Test bestätigt die Microsoft-Anmeldung, die Entra-Autorisierung und die
Exchange-Synchronisierung im echten DMH-Mandanten. Er soll zuerst mit dem
rollenden **Admin-Test** und einem eigenen Microsoft-365-Testkonto ausgeführt
werden, nicht mit produktiven Daten einer Schwester.

## Vorbereitung

- Entra-App mit den delegierten Graph-Rechten `User.Read`,
  `Contacts.ReadWrite` und `Calendars.ReadWrite` konfigurieren.
- Administratoreinwilligung für den DMH-Mandanten erteilen.
- Ein lizenziertes Testkonto in die Gruppe `DMH-Portal-Privatschwestern`
  aufnehmen.
- Ein zweites Testkonto bewusst außerhalb dieser Gruppe lassen.
- Die GitHub-Variablen aus `docs/microsoft-365-connection.md` setzen und einen
  Admin-Test-Installer erzeugen.
- Im Testpostfach nur eindeutig bezeichnete Datensätze verwenden, zum Beispiel
  `DMH-SYNC-TEST 2026-08-06`. Nach dem Test können sie klar erkannt und entfernt
  werden.

## Etappe 1 — Anmeldung und Modulrechte

| Nr. | Test | Erwartetes Ergebnis |
|---|---|---|
| 1.1 | Mit dem autorisierten Testkonto anmelden | Das Portal öffnet das Modul Privatschwestern und zeigt Name sowie E-Mail in der Seitenleiste. |
| 1.2 | **Angemeldet bleiben** aktivieren, App schließen und neu öffnen | Das Portal erneuert die Sitzung ohne erneute Kennworteingabe, sofern MFA/Conditional Access keine Interaktion verlangt. |
| 1.3 | Abmelden, ohne **Angemeldet bleiben** anmelden, App vollständig schließen und neu öffnen | Die flüchtige Sitzung ist beendet und die Microsoft-Anmeldung wird erneut angeboten. |
| 1.4 | Mit dem Konto außerhalb der Sicherheitsgruppe anmelden | Das Konto wird erkannt, das Modul bleibt aber mit **Noch kein Modul freigegeben** geschlossen. |
| 1.5 | Das zweite Konto in die Gruppe aufnehmen und **Gruppen erneut prüfen** wählen | Nach Übernahme der Entra-Mitgliedschaft wird das Modul freigegeben. |
| 1.6 | Bei zuvor bestätigter Sitzung die Netzwerkverbindung trennen und die App öffnen | Der gekennzeichnete Offline-Zugriff funktioniert höchstens 24 Stunden; es findet keine Cloud-Übertragung statt. |

## Etappe 2 — Kontakte

| Nr. | Test | Erwartetes Ergebnis |
|---|---|---|
| 2.1 | Im Portal einen Kontakt `DMH-SYNC-TEST Kontakt A` mit E-Mail, Telefon, Adresse, Kurzinfo, Notiz und Gruppe anlegen | Das Synchronisierungssymbol wird aktiv. Der Kontakt erscheint anschließend in Outlook im Web unter **Personen**. Gruppe erscheint als Kategorie, Kurzinfo als Firma. |
| 2.2 | Den Kontakt in Outlook im Web ändern und im Portal **Jetzt synchronisieren** wählen | Die Änderung erscheint lokal, ohne einen zweiten Kontakt anzulegen. |
| 2.3 | In Outlook im Web einen neuen Kontakt `DMH-SYNC-TEST Kontakt B` anlegen | Nach dem nächsten Lauf erscheint er im Portal. |
| 2.4 | Kontakt A im Portal löschen | Er landet lokal im Papierkorb und wird aus den Exchange-Kontakten entfernt. |
| 2.5 | Kontakt A im Portal-Papierkorb wiederherstellen | Er wird erneut in Exchange angelegt und bleibt mit dem lokalen Datensatz verbunden. |
| 2.6 | Kontakt B in Outlook im Web löschen | Nach dem Lauf liegt er im lokalen Papierkorb und bleibt wiederherstellbar. |

## Etappe 2 — Kalender und Teams

| Nr. | Test | Erwartetes Ergebnis |
|---|---|---|
| 2.7 | Im Portal einen Termin `DMH-SYNC-TEST Termin A` mit Ort, Beschreibung, Kategorie und Wiederholung anlegen | Der Termin erscheint im persönlichen Outlook-/Teams-Kalender. |
| 2.8 | Den Termin in Outlook oder Teams ändern | Nach dem Lauf erscheinen die Änderungen im Portal, ohne Duplikat. |
| 2.9 | In Teams oder Outlook einen Termin `DMH-SYNC-TEST Termin B` anlegen | Nach dem Lauf erscheint er im Portal. |
| 2.10 | Eine Teams-Besprechung mit Testteilnehmer anlegen, synchronisieren und anschließend im Portal den Titel ändern | Titeländerung wird übertragen; Teams-Beitrittslink und Teilnehmer bleiben erhalten. |
| 2.11 | Termin A im Portal löschen und anschließend wiederherstellen | Die Löschung wird in Exchange übernommen; nach der Wiederherstellung wird der Termin neu angelegt. |
| 2.12 | Termin B in Outlook oder Teams löschen | Nach dem Lauf liegt er im lokalen Papierkorb. |

## Offline, zweiter Computer und Bedienbarkeit

| Nr. | Test | Erwartetes Ergebnis |
|---|---|---|
| 3.1 | Netzwerk trennen, lokal einen Kontakt und Termin anlegen | Beide bleiben sofort lokal sichtbar; die Seitenleiste meldet Offline. |
| 3.2 | Netzwerk wieder verbinden und manuell synchronisieren | Die vorgemerkten Daten erscheinen in Exchange. |
| 3.3 | Admin-Test auf einem zweiten Windows-Benutzer/Computer installieren und dasselbe Microsoft-Konto anmelden | Exchange-Kontakte und Kalender erscheinen automatisch auch dort. Passwörter noch nicht — das ist Etappe 3. |
| 3.4 | Während einer Synchronisierung navigieren, suchen und einen Dialog öffnen | Die Oberfläche bleibt bedienbar; Graph-Zugriffe laufen im Hintergrund und seitenweise. |
| 3.5 | Unter **Microsoft 365** den letzten Lauf prüfen | Zeitpunkt sowie Anzahlen für Upload, Download und Aktualisierung sind sichtbar; kein Fehlerstatus bleibt stehen. |

## Abnahmekriterium

Etappen 1 und 2 gelten im DMH-Tenant als abgenommen, wenn alle Tests 1.1 bis 3.5
erfolgreich sind und keine ungeklärten Duplikate, verlorenen Teams-Daten oder
HTTP-403-Fehler auftreten. Fehler mit Datum, Testnummer, Konto, Screenshot und
Text aus dem Microsoft-365-Status dokumentieren.
