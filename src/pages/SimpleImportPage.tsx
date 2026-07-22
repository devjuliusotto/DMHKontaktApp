import { Bird, CalendarDays, CalendarRange, Download, LoaderCircle, Undo2, UsersRound } from "lucide-react";
import { useState } from "react";
import { OutlookContactImportDialog } from "../components/OutlookContactImportDialog";
import { StatusMessage } from "../components/StatusMessage";
import { importOutlookClassicAppointmentsOnce, importThunderbirdCalendarsOnce, importThunderbirdContactsOnce, undoLastOutlookContactImport } from "../services/db";
import type { CalendarEvent } from "../types/calendar";
import type { OutlookContactImportResult } from "../types/contact";
import { calendarColorFromCategory, calendarStorageKey } from "../utils/calendar";

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
      + `${result.skippedExactDuplicates} bereits vorhandene und ${result.skippedConflicts} nicht ausgewählte Konflikte wurden ausgelassen. Es besteht keine Synchronisierung.`
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
      setMessageType("success");
      setMessage(
        result.found === 0
          ? "In den erreichbaren Outlook-Kalendern wurden keine Termine gefunden."
          : `${imported} neue und ${updated} bereits vorhandene Outlook-Termine oder Serien wurden einmalig übernommen bzw. aktualisiert. ${result.skippedInvalid} nicht lesbare Einträge wurden ausgelassen. Es besteht noch keine automatische Synchronisierung.`
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
          <p>Kontakte und Termine mit wenigen Schritten aus Outlook übernehmen.</p>
        </div>
      </header>

      <StatusMessage message={message} type={messageType} />

      <section className="form-panel settings-task-panel">
        <div className="settings-task-heading">
          <Download size={25} aria-hidden="true" />
          <div>
            <h3>Einfach übernehmen</h3>
            <p>Einmalig kopieren. Outlook und Thunderbird bleiben unverändert.</p>
          </div>
        </div>
        <div className="settings-action-grid">
          <button className="settings-action-button" type="button" onClick={() => setContactImportDialogOpen(true)} disabled={busyAction !== null}>
            <UsersRound size={25} />
            <span>
              <strong>Kontakte suchen und importieren</strong>
              <small>Quellen und mögliche Duplikate vorher prüfen</small>
            </span>
          </button>
          <button className="settings-action-button" type="button" onClick={importAppointmentsOnce} disabled={busyAction !== null}>
            {busyAction === "import-outlook-appointments-once" ? <LoaderCircle className="spin" size={25} /> : <CalendarDays size={25} />}
            <span>
              <strong>{busyAction === "import-outlook-appointments-once" ? "Kalender werden gelesen …" : "Outlook-Termine importieren"}</strong>
              <small>Aus allen Outlook-Kalendern</small>
            </span>
          </button>
          <button className="settings-action-button" type="button" onClick={importThunderbirdContacts} disabled={busyAction !== null}>
            {busyAction === "import-thunderbird-contacts" ? <LoaderCircle className="spin" size={25} /> : <Bird size={25} />}
            <span>
              <strong>{busyAction === "import-thunderbird-contacts" ? "Thunderbird wird gelesen …" : "Thunderbird-Kontakte importieren"}</strong>
              <small>Adressbücher und Listen automatisch als Gruppen übernehmen</small>
            </span>
          </button>
          <button className="settings-action-button" type="button" onClick={importThunderbirdCalendars} disabled={busyAction !== null}>
            {busyAction === "import-thunderbird-calendars" ? <LoaderCircle className="spin" size={25} /> : <CalendarRange size={25} />}
            <span>
              <strong>{busyAction === "import-thunderbird-calendars" ? "Thunderbird-Kalender werden gelesen …" : "Thunderbird-Kalender importieren"}</strong>
              <small>Alle Kalender, Terminserien und Ausnahmen übernehmen</small>
            </span>
          </button>
        </div>
        <button className="settings-undo-import" type="button" onClick={undoOutlookContactImport} disabled={busyAction !== null}>
          {busyAction === "undo-outlook-contact-import" ? <LoaderCircle className="spin" size={17} /> : <Undo2 size={17} />}
          Letzten Outlook-Kontaktimport rückgängig machen
        </button>
      </section>

      <OutlookContactImportDialog
        open={contactImportDialogOpen}
        onClose={() => setContactImportDialogOpen(false)}
        onImported={contactsImported}
      />
    </div>
  );
}
