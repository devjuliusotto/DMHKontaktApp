import { Bird, CalendarDays, CalendarRange, Download, LoaderCircle, Undo2, UsersRound } from "lucide-react";
import { useState } from "react";
import { OutlookContactImportDialog } from "../components/OutlookContactImportDialog";
import { StatusMessage } from "../components/StatusMessage";
import { importOutlookClassicAppointmentsOnce, importThunderbirdCalendarsOnce, importThunderbirdContactsOnce, undoLastOutlookContactImport } from "../services/db";
import type { CalendarEvent } from "../types/calendar";
import type { OutlookContactImportResult } from "../types/contact";
import { calendarColorFromCategory, calendarStorageKey } from "../utils/calendar";
import { mergeCalendarEventsExactly } from "../utils/calendarDuplicates";

function storedCalendarEvents(): CalendarEvent[] {
  const raw = localStorage.getItem(calendarStorageKey);
  if (!raw) return [];
  const value: unknown = JSON.parse(raw);
  if (!Array.isArray(value)) throw new Error("Die lokal gespeicherten Kalenderdaten sind beschädigt.");
  return value as CalendarEvent[];
}

export function SimpleImportPage() {
  const [busyAction, setBusyAction] = useState<string | null>(null);
  const [message, setMessage] = useState("");
  const [messageType, setMessageType] = useState<"success" | "error" | "info">("info");
  const [contactImportDialogOpen, setContactImportDialogOpen] = useState(false);

  const contactsImported = (result: OutlookContactImportResult, source: "classic" | "csv") => {
    setMessageType("success");
    setMessage(
      `${result.imported} Kontakte aus ${source === "classic" ? "Outlook Classic" : "dem neuen Outlook"} wurden einmalig übernommen. `
      + `${result.skippedExactDuplicates} in allen Feldern exakt gleiche Kontakte wurden ausgelassen. Kontakte mit mindestens einer Abweichung wurden erhalten. Es besteht keine Synchronisierung.`
    );
  };

  const undoOutlookContactImport = async () => {
    const confirmed = window.confirm(
      "Den letzten Outlook-Kontaktimport rückgängig machen? Nur Kontakte aus diesem Importvorgang werden entfernt."
    );
    if (!confirmed) return;
    setBusyAction("undo-outlook-contact-import");
    setMessageType("info");
    setMessage("Letzter Outlook-Kontaktimport wird rückgängig gemacht …");
    try {
      const deleted = await undoLastOutlookContactImport();
      setMessageType(deleted > 0 ? "success" : "info");
      setMessage(deleted > 0
        ? `${deleted} Kontakte aus dem letzten Outlook-Import wurden entfernt.`
        : "Es wurde kein Outlook-Kontaktimport gefunden, der rückgängig gemacht werden kann.");
    } catch (error) {
      setMessageType("error");
      setMessage(`Der letzte Outlook-Kontaktimport konnte nicht rückgängig gemacht werden: ${error}`);
    } finally {
      setBusyAction(null);
    }
  };

  const importAppointmentsOnce = async () => {
    const confirmed = window.confirm(
      "Alle Termine aus allen erreichbaren Kalenderordnern des aktuellen Outlook-Classic-Profils einmalig in DMH Kontakte und Kalender kopieren?\n\nOutlook wird nicht verändert und es wird keine automatische Synchronisierung eingerichtet. Bereits importierte Termine werden ausgelassen."
    );
    if (!confirmed) return;

    setBusyAction("import-outlook-appointments-once");
    setMessageType("info");
    setMessage("Alle erreichbaren Outlook-Kalender werden gelesen. Dies kann einige Minuten dauern …");
    try {
      const result = await importOutlookClassicAppointmentsOnce();
      const existing = storedCalendarEvents();
      const normalizedIncoming = result.events.map((event) => ({
        ...event,
        color: calendarColorFromCategory(event.category, event.color)
      }));
      const merged = mergeCalendarEventsExactly(existing, normalizedIncoming);
      localStorage.setItem(calendarStorageKey, JSON.stringify(merged.events));
      const duplicates = merged.skippedSameId + merged.skippedExactDuplicates;
      setMessageType("success");
      setMessage(
        result.found === 0
          ? "In den erreichbaren Outlook-Kalendern wurden keine Termine gefunden."
          : `${merged.imported} von ${result.found} Outlook-Terminen wurden einmalig übernommen. ${duplicates} bereits vorhandene oder in allen Feldern exakt gleiche und ${result.skippedInvalid} nicht lesbare Einträge wurden ausgelassen. Termine mit auch nur einer Abweichung bleiben erhalten.`
      );
    } catch (error) {
      setMessageType("error");
      setMessage(`Outlook-Termine konnten nicht importiert werden: ${error}`);
    } finally {
      setBusyAction(null);
    }
  };

  const importThunderbirdContacts = async () => {
    const confirmed = window.confirm(
      "Alle Kontakte aus dem aktiven Thunderbird-Profil einmalig übernehmen?\n\nAdressbücher und darin enthaltene Verteilerlisten werden automatisch als Gruppen angelegt. Bereits vorhandene Kontakte mit derselben E-Mail-Adresse werden nicht doppelt angelegt, sondern den passenden Gruppen zugeordnet. Thunderbird wird nicht verändert."
    );
    if (!confirmed) return;

    setBusyAction("import-thunderbird-contacts");
    setMessageType("info");
    setMessage("Thunderbird-Adressbücher und Listen werden gelesen …");
    try {
      const result = await importThunderbirdContactsOnce();
      setMessageType(result.found > 0 ? "success" : "info");
      setMessage(
        result.found === 0
          ? `In ${result.addressBooks} Thunderbird-Adressbüchern wurden keine Kontakte gefunden.`
          : `${result.imported} neue Thunderbird-Kontakte wurden importiert. `
            + `${result.linkedExisting} bereits vorhandene Kontakte wurden den passenden Gruppen zugeordnet. `
            + `${result.addressBooks} Adressbücher und insgesamt ${result.groupsUsed} Gruppen oder Listen wurden berücksichtigt. `
            + `${result.skippedInvalid} nicht lesbare Einträge wurden ausgelassen.`
      );
    } catch (error) {
      setMessageType("error");
      setMessage(`Thunderbird-Kontakte konnten nicht importiert werden: ${error}`);
    } finally {
      setBusyAction(null);
    }
  };

  const importThunderbirdCalendars = async () => {
    const confirmed = window.confirm(
      "Alle Termine aus allen im aktiven Thunderbird-Profil gespeicherten Kalendern einmalig übernehmen?\n\nSerien, Ausnahmen, Kategorien und Kalenderfarben werden soweit möglich beibehalten. Bereits importierte Thunderbird-Termine werden aktualisiert und nicht doppelt angelegt. Thunderbird wird nicht verändert."
    );
    if (!confirmed) return;

    setBusyAction("import-thunderbird-calendars");
    setMessageType("info");
    setMessage("Thunderbird-Kalender, Terminserien und Ausnahmen werden gelesen …");
    try {
      const result = await importThunderbirdCalendarsOnce();
      const existing = storedCalendarEvents();
      const eventsById = new Map(existing.map((event) => [event.id, event]));
      let imported = 0;
      let updated = 0;
      for (const event of result.events) {
        if (eventsById.has(event.id)) updated += 1;
        else imported += 1;
        eventsById.set(event.id, {
          ...event,
          color: calendarColorFromCategory(event.category, event.color)
        });
      }
      localStorage.setItem(calendarStorageKey, JSON.stringify(Array.from(eventsById.values())));
      setMessageType(result.found > 0 ? "success" : "info");
      setMessage(
        result.found === 0
          ? `In ${result.calendars} Thunderbird-Kalendern wurden keine Termine gefunden.`
          : `${imported} neue und ${updated} bereits importierte Thunderbird-Termine oder Serien wurden übernommen bzw. aktualisiert. `
            + `${result.calendars} Kalender wurden berücksichtigt; ${result.skippedInvalid} nicht unterstützte oder beschädigte Einträge wurden ausgelassen.`
      );
    } catch (error) {
      setMessageType("error");
      setMessage(`Thunderbird-Kalender konnten nicht importiert werden: ${error}`);
    } finally {
      setBusyAction(null);
    }
  };

  return (
    <div className="page simple-import-page">
      <header className="page-header">
        <div>
          <h2>Einfach importieren</h2>
          <p>Wählen Sie zuerst die Quelle und danach den Datenbereich aus.</p>
        </div>
      </header>

      <StatusMessage message={message} type={messageType} />

      <div className="simple-import-source-list">
        <section className="simple-import-source-card">
          <header>
            <span className="simple-import-source-icon"><Download size={23} aria-hidden="true" /></span>
            <div>
              <h3>Outlook</h3>
              <p>Outlook Classic und neues Outlook</p>
            </div>
          </header>
          <div className="simple-import-data-grid">
            <article className="simple-import-data-card">
              <UsersRound size={24} aria-hidden="true" />
              <div>
                <h4>Kontakte</h4>
                <p>Kontakte aus Outlook prüfen und einmalig in die App übernehmen.</p>
                <small>Quellen und mögliche Duplikate werden vorher angezeigt.</small>
              </div>
              <button className="settings-action-button" type="button" onClick={() => setContactImportDialogOpen(true)} disabled={busyAction !== null}>
                Kontakte prüfen und importieren
              </button>
            </article>
            <article className="simple-import-data-card">
              {busyAction === "import-outlook-appointments-once" ? <LoaderCircle className="spin" size={24} aria-hidden="true" /> : <CalendarDays size={24} aria-hidden="true" />}
              <div>
                <h4>Kalender</h4>
                <p>Termine aus allen erreichbaren Outlook-Kalendern übernehmen.</p>
                <small>Einmalige Kopie aus Outlook Classic; Outlook bleibt unverändert.</small>
              </div>
              <button className="settings-action-button" type="button" onClick={importAppointmentsOnce} disabled={busyAction !== null}>
                {busyAction === "import-outlook-appointments-once" ? "Kalender werden gelesen …" : "Outlook-Kalender importieren"}
              </button>
            </article>
          </div>
          <div className="simple-import-undo">
            <button className="settings-undo-import" type="button" onClick={undoOutlookContactImport} disabled={busyAction !== null}>
              {busyAction === "undo-outlook-contact-import" ? <LoaderCircle className="spin" size={17} /> : <Undo2 size={17} />}
              Letzten Outlook-Kontaktimport rückgängig machen
            </button>
          </div>
        </section>

        <section className="simple-import-source-card">
          <header>
            <span className="simple-import-source-icon"><Bird size={23} aria-hidden="true" /></span>
            <div>
              <h3>Thunderbird</h3>
              <p>Das aktive lokale Thunderbird-Profil</p>
            </div>
          </header>
          <div className="simple-import-data-grid">
            <article className="simple-import-data-card">
              {busyAction === "import-thunderbird-contacts" ? <LoaderCircle className="spin" size={24} aria-hidden="true" /> : <UsersRound size={24} aria-hidden="true" />}
              <div>
                <h4>Kontakte</h4>
                <p>Kontakte aus allen Thunderbird-Adressbüchern übernehmen.</p>
                <small>Adressbücher und Verteilerlisten werden als Gruppen angelegt.</small>
              </div>
              <button className="settings-action-button" type="button" onClick={importThunderbirdContacts} disabled={busyAction !== null}>
                {busyAction === "import-thunderbird-contacts" ? "Thunderbird wird gelesen …" : "Thunderbird-Kontakte importieren"}
              </button>
            </article>
            <article className="simple-import-data-card">
              {busyAction === "import-thunderbird-calendars" ? <LoaderCircle className="spin" size={24} aria-hidden="true" /> : <CalendarRange size={24} aria-hidden="true" />}
              <div>
                <h4>Kalender</h4>
                <p>Termine aus allen Thunderbird-Kalendern übernehmen.</p>
                <small>Kalender, Serien, Ausnahmen, Kategorien und Farben werden berücksichtigt.</small>
              </div>
              <button className="settings-action-button" type="button" onClick={importThunderbirdCalendars} disabled={busyAction !== null}>
                {busyAction === "import-thunderbird-calendars" ? "Kalender werden gelesen …" : "Thunderbird-Kalender importieren"}
              </button>
            </article>
          </div>
        </section>
      </div>

      <p className="simple-import-note">
        Alle Aktionen auf dieser Seite sind einmalige Übernahmen. Die Originaldaten in Outlook und Thunderbird werden nicht verändert und es wird keine Synchronisierung eingerichtet.
      </p>

      <OutlookContactImportDialog
        open={contactImportDialogOpen}
        onClose={() => setContactImportDialogOpen(false)}
        onImported={contactsImported}
      />
    </div>
  );
}
