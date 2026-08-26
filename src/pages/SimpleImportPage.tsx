import { AlertTriangle, Bird, CalendarDays, CalendarRange, Download, LoaderCircle, Undo2, UsersRound } from "lucide-react";
import { useState } from "react";
import { OutlookContactImportDialog } from "../components/OutlookContactImportDialog";
import { StatusMessage } from "../components/StatusMessage";
import { importOutlookClassicAppointmentsOnce, importThunderbirdCalendarsOnce, importThunderbirdContactsOnce, previewOutlookClassicAppointments, undoLastOutlookContactImport } from "../services/db";
import type { CalendarEvent, OutlookCalendarPreview } from "../types/calendar";
import type { OutlookContactImportResult } from "../types/contact";
import { calendarColorFromCategory, calendarStorageKey, mergeImportedCalendarCategories } from "../utils/calendar";
import { mergeCalendarEventsExactly } from "../utils/calendarDuplicates";

function storedCalendarEvents(): CalendarEvent[] {
  const raw = localStorage.getItem(calendarStorageKey);
  if (!raw) return [];
  const value: unknown = JSON.parse(raw);
  if (!Array.isArray(value)) throw new Error("Die lokal gespeicherten Kalenderdaten sind beschädigt.");
  return value as CalendarEvent[];
}

function formatPreviewDate(value: string): string {
  const date = new Date(value);
  return Number.isNaN(date.getTime())
    ? value
    : new Intl.DateTimeFormat("de-DE", { dateStyle: "short", timeStyle: "short" }).format(date);
}

export function SimpleImportPage() {
  const [busyAction, setBusyAction] = useState<string | null>(null);
  const [message, setMessage] = useState("");
  const [messageType, setMessageType] = useState<"success" | "error" | "info">("info");
  const [contactImportDialogOpen, setContactImportDialogOpen] = useState(false);
  const [outlookCalendarPreview, setOutlookCalendarPreview] = useState<OutlookCalendarPreview | null>(null);

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

  const previewAppointments = async () => {
    setBusyAction("preview-outlook-appointments");
    setMessageType("info");
    setMessage("Die Outlook-Kalender werden analysiert. Dies kann einige Minuten dauern …");
    try {
      const preview = await previewOutlookClassicAppointments();
      setOutlookCalendarPreview(preview);
      setMessageType("success");
      setMessage(
        `${preview.calendars.length} Outlook-Kalender mit insgesamt ${preview.totalEvents} Terminen gefunden. `
        + (preview.duplicateGroups.length > 0
          ? `${preview.duplicateGroups.length} mögliche kalenderübergreifende Duplikatgruppen müssen geprüft werden.`
          : "Es wurden keine kalenderübergreifenden Duplikate erkannt.")
      );
    } catch (error) {
      setMessageType("error");
      setMessage(`Outlook-Kalender konnten nicht analysiert werden: ${error}`);
    } finally {
      setBusyAction(null);
    }
  };

  const importAppointmentsOnce = async () => {
    if (!outlookCalendarPreview) return;
    const confirmed = window.confirm(
      `Die Vorschau zeigt ${outlookCalendarPreview.calendars.length} getrennte Outlook-Kalender mit insgesamt ${outlookCalendarPreview.totalEvents} Terminen. Diese Kalender werden getrennt als Quellen übernommen.\n\n`
      + (outlookCalendarPreview.duplicateGroups.length > 0
        ? `Es wurden ${outlookCalendarPreview.duplicateGroups.length} mögliche kalenderübergreifende Duplikatgruppen gefunden. Sie bleiben erhalten und werden nicht automatisch zusammengelegt.\n\n`
        : "Es wurden keine kalenderübergreifenden Duplikate erkannt.\n\n")
      + "Jetzt einmalig importieren? Outlook wird nicht verändert."
    );
    if (!confirmed) return;

    setBusyAction("import-outlook-appointments-once");
    setMessageType("info");
    setMessage("Die angezeigten Outlook-Kalender werden importiert. Dies kann einige Minuten dauern …");
    try {
      const result = await importOutlookClassicAppointmentsOnce();
      const existing = storedCalendarEvents();
      const normalizedIncoming = result.events.map((event) => ({
        ...event,
        color: calendarColorFromCategory(event.category, event.color)
      }));
      const merged = mergeCalendarEventsExactly(existing, normalizedIncoming);
      localStorage.setItem(calendarStorageKey, JSON.stringify(merged.events));
      const categoryResult = mergeImportedCalendarCategories(normalizedIncoming);
      const duplicates = merged.skippedSameId + merged.skippedExactDuplicates;
      setMessageType("success");
      setMessage(
        result.found === 0
          ? "In den erreichbaren Outlook-Kalendern wurden keine Termine gefunden."
          : `${merged.imported} von ${result.found} Outlook-Terminen wurden einmalig übernommen. ${categoryResult.added + categoryResult.updated} Kategorie(n) mit Farbe wurden übernommen. ${duplicates} bereits vorhandene oder in allen Feldern exakt gleiche und ${result.skippedInvalid} nicht lesbare Einträge wurden ausgelassen. Termine mit auch nur einer Abweichung bleiben erhalten.`
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
      const mergedEvents = Array.from(eventsById.values());
      localStorage.setItem(calendarStorageKey, JSON.stringify(mergedEvents));
      const categoryResult = mergeImportedCalendarCategories(result.events);
      setMessageType(result.found > 0 ? "success" : "info");
      setMessage(
        result.found === 0
          ? `In ${result.calendars} Thunderbird-Kalendern wurden keine Termine gefunden.`
          : `${imported} neue und ${updated} bereits importierte Thunderbird-Termine oder Serien wurden übernommen bzw. aktualisiert. ${categoryResult.added + categoryResult.updated} Kategorie(n) mit Farbe wurden übernommen. `
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
                <small>Vorher getrennt analysieren; Outlook bleibt unverändert.</small>
              </div>
              <button className="settings-action-button" type="button" onClick={previewAppointments} disabled={busyAction !== null}>
                {busyAction === "preview-outlook-appointments"
                  ? "Kalender werden analysiert …"
                  : outlookCalendarPreview
                    ? "Kalender erneut analysieren"
                    : "Outlook-Kalender analysieren"}
              </button>
              {outlookCalendarPreview && (
                <div className="simple-import-calendar-preview">
                  <div className="simple-import-preview-summary">
                    <strong>Vorschau vor dem Import</strong>
                    <span>{outlookCalendarPreview.calendars.length} Kalender · {outlookCalendarPreview.totalEvents} Termine</span>
                  </div>
                  <ul className="simple-import-calendar-list">
                    {outlookCalendarPreview.calendars.map((calendar) => (
                      <li key={calendar.id}>
                        <strong>{calendar.name}</strong>
                        <span>{calendar.eventCount} {calendar.eventCount === 1 ? "Termin" : "Termine"}</span>
                        <small>{calendar.folderPath || calendar.storeName}</small>
                      </li>
                    ))}
                  </ul>
                  {outlookCalendarPreview.duplicateGroups.length > 0 ? (
                    <div className="simple-import-duplicate-warning" role="alert">
                      <div className="simple-import-preview-summary">
                        <AlertTriangle size={18} aria-hidden="true" />
                        <strong>{outlookCalendarPreview.duplicateGroups.length} mögliche Duplikatgruppen</strong>
                      </div>
                      <p>Diese Termine wurden in mehreren Outlook-Kalendern gefunden. Sie werden nicht automatisch zusammengelegt.</p>
                      <ul className="simple-import-duplicate-list">
                        {outlookCalendarPreview.duplicateGroups.map((duplicate, index) => (
                          <li key={`${duplicate.startsAt}-${duplicate.title}-${index}`}>
                            <strong>{duplicate.title}</strong>
                            <span>{formatPreviewDate(duplicate.startsAt)} · {duplicate.occurrenceCount} Vorkommen</span>
                            <small>{duplicate.calendars.join(" · ")}</small>
                          </li>
                        ))}
                      </ul>
                    </div>
                  ) : (
                    <p className="simple-import-no-duplicates">Keine möglichen Duplikate zwischen verschiedenen Outlook-Kalendern erkannt.</p>
                  )}
                  <button className="settings-action-button simple-import-confirm-button" type="button" onClick={importAppointmentsOnce} disabled={busyAction !== null}>
                    {busyAction === "import-outlook-appointments-once" ? "Kalender werden importiert …" : "Vorschau bestätigen und importieren"}
                  </button>
                </div>
              )}
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
