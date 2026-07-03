import { open } from "@tauri-apps/plugin-dialog";
import { readFile } from "@tauri-apps/plugin-fs";
import { CalendarDays, CheckSquare, FileSpreadsheet, Plus, Square, UsersRound, X } from "lucide-react";
import type { CSSProperties } from "react";
import { useEffect, useMemo, useState } from "react";
import { StatusMessage } from "../components/StatusMessage";
import { t } from "../i18n";
import { importContacts, importOutlookStore, listGroups, saveGroup } from "../services/db";
import type { CalendarEvent } from "../types/calendar";
import type { Group } from "../types/contact";
import { calendarColorOptions, calendarColorValue, defaultCalendarColor, parseCalendarFile } from "../utils/calendar";
import { parseCsvBytes, parseXlsx, type ImportPreview } from "../utils/importers";

type ImportMode = "contacts" | "calendar";

const calendarStorageKey = "agendakontakte.calendarEvents";
const ungroupedLabel = "Gesammelte Adressen";
const defaultImportCategory = "Allgemein";
const suggestedCalendarCategories = ["Geburtstag", "Arbeit", "Sitzung", "Beratung", "PJT"];

export function ImportPage() {
  const [mode, setMode] = useState<ImportMode | null>(null);
  const [fileName, setFileName] = useState("");
  const [preview, setPreview] = useState<ImportPreview | null>(null);
  const [pendingEvents, setPendingEvents] = useState<CalendarEvent[]>([]);
  const [groups, setGroups] = useState<Group[]>([]);
  const [selectedGroupId, setSelectedGroupId] = useState<number | "">("");
  const [message, setMessage] = useState("");
  const [showGroupCard, setShowGroupCard] = useState(false);
  const [newGroupName, setNewGroupName] = useState("");
  const [calendarCategory, setCalendarCategory] = useState(defaultImportCategory);
  const [calendarColor, setCalendarColor] = useState(defaultCalendarColor);

  const selectedCount = preview?.contacts.filter((contact) => contact.selected).length ?? 0;
  const contactsWithEmail = useMemo(() => preview?.contacts.filter((contact) => contact.email.trim()) ?? [], [preview]);
  const contactsWithoutEmail = useMemo(() => preview?.contacts.filter((contact) => !contact.email.trim()) ?? [], [preview]);
  const canConfirm = Boolean((preview && selectedCount > 0 && !preview.emailColumnMissing) || pendingEvents.length > 0);

  useEffect(() => {
    listGroups().then(setGroups).catch((error) => setMessage(`Gruppen konnten nicht geladen werden: ${error}`));
  }, []);

  const resetImport = () => {
    setMode(null);
    setFileName("");
    setPreview(null);
    setPendingEvents([]);
    setSelectedGroupId("");
    setShowGroupCard(false);
    setNewGroupName("");
    setCalendarCategory(defaultImportCategory);
    setCalendarColor(defaultCalendarColor);
  };

  const chooseMode = (nextMode: ImportMode) => {
    resetImport();
    setMode(nextMode);
    setMessage(nextMode === "contacts" ? "Wählen Sie eine Kontaktdatei aus." : "Wählen Sie eine Kalenderdatei oder Outlook-Datendatei aus.");
  };

  const createContactPreview = (contacts: ImportPreview["contacts"]): ImportPreview => ({
    headers: ["Outlook PST/OST"],
    mapping: { email: "Outlook" },
    rows: [],
    contacts,
    logs: [],
    emailColumnMissing: contacts.length > 0 && contacts.every((contact) => !contact.email.trim())
  });

  const chooseFile = async () => {
    if (!mode) return;
    try {
      const path = await open({
        multiple: false,
        filters: [mode === "calendar"
          ? { name: "Kalenderdateien", extensions: ["ics", "eml", "pst", "ost"] }
          : { name: "Kontaktdateien", extensions: ["csv", "xlsx"] }]
      });
      if (!path || Array.isArray(path)) return;

      setFileName(path);
      setPreview(null);
      setPendingEvents([]);

      const lower = path.toLowerCase();
      if (lower.endsWith(".pst") || lower.endsWith(".ost")) {
        setMessage("Outlook-Datendatei wird gelesen. Das kann einige Minuten dauern.");
        const result = await importOutlookStore(path);
        setPendingEvents(result.events.map(normalizeCalendarEvent));
        if (mode === "contacts") {
          const contacts = result.contacts.map((contact) => ({ ...contact, selected: true }));
          setPreview(contacts.length ? createContactPreview(contacts) : null);
          setMessage(`${contactsLabel(contacts.length)} gefunden. Bitte Kontaktgruppe wählen und prüfen.`);
        } else {
          setMessage(`${eventsLabel(result.events.length)} gefunden. Bitte Kategorie wählen und bestätigen.`);
        }
        return;
      }

      const bytes = await readFile(path);
      if (mode === "calendar") {
        const importedEvents = parseCalendarFile(bytes, path).map(normalizeCalendarEvent);
        setPendingEvents(importedEvents);
        setMessage(importedEvents.length ? `${eventsLabel(importedEvents.length)} gefunden. Bitte bestätigen.` : "Keine Kalendertermine gefunden.");
        return;
      }

      const result = lower.endsWith(".xlsx") ? parseXlsx(bytes) : parseCsvBytes(bytes);
      setPreview(result);
      setMessage(
        result.emailColumnMissing
          ? "Keine E-Mail-Spalte gefunden. Der Import ist erst möglich, wenn eine Datei mit E-Mail/Kontakt-Spalte gewählt wird."
          : `${contactsLabel(result.contacts.length)} gefunden. Bitte Kontaktgruppe wählen und prüfen.`
      );
    } catch (error) {
      setPreview(null);
      setPendingEvents([]);
      setMessage(`Import fehlgeschlagen: ${error}`);
    }
  };

  const createGroup = async () => {
    if (!newGroupName.trim()) {
      setMessage("Bitte geben Sie einen Gruppennamen ein.");
      return;
    }
    const id = await saveGroup({ name: newGroupName.trim(), description: "", createdAt: "", updatedAt: "" });
    const updatedGroups = await listGroups();
    setGroups(updatedGroups);
    setSelectedGroupId(id);
    setNewGroupName("");
    setShowGroupCard(false);
    setMessage("Gruppe wurde erstellt und für den Import ausgewählt.");
  };

  const toggleAll = (selected: boolean) => {
    setPreview((current) => current && { ...current, contacts: current.contacts.map((row) => ({ ...row, selected })) });
  };

  const toggleOne = (index: number) => {
    setPreview(
      (current) =>
        current && {
          ...current,
          contacts: current.contacts.map((row, rowIndex) => (rowIndex === index ? { ...row, selected: !row.selected } : row))
        }
    );
  };

  const savePendingEvents = () => {
    if (!pendingEvents.length) return 0;
    const existing = JSON.parse(localStorage.getItem(calendarStorageKey) ?? "[]") as CalendarEvent[];
    const eventsById = new Map(existing.map((event) => [event.id, event]));
    for (const event of pendingEvents) eventsById.set(event.id, applyCalendarImportCategory(event, calendarCategory, calendarColor));
    localStorage.setItem(calendarStorageKey, JSON.stringify(Array.from(eventsById.values())));
    return pendingEvents.length;
  };

  const submit = async () => {
    if (!canConfirm) {
      setMessage("Bitte wählen Sie zuerst eine Datei mit importierbaren Daten aus.");
      return;
    }
    if (preview?.emailColumnMissing && pendingEvents.length === 0) {
      setMessage("Keine E-Mail-Spalte gefunden. Der Import wurde nicht gestartet.");
      return;
    }

    try {
      const importedEvents = savePendingEvents();
      let importedContacts = 0;

      if (preview && selectedCount > 0 && !preview.emailColumnMissing) {
        const groupIds = selectedGroupId === "" ? [] : [selectedGroupId];
        const rows = preview.contacts
          .filter((contact) => contact.selected)
          .map(({ selected: _selected, ...contact }) => ({ ...contact, groupIds }));
        const result = await importContacts(fileName, rows);
        importedContacts = result.imported;
      }

      setMessage(`${contactsLabel(importedContacts)} und ${eventsLabel(importedEvents)} importiert.`);
      resetImport();
    } catch (error) {
      setMessage(`Import fehlgeschlagen: ${error}`);
    }
  };

  const cancelPreview = () => {
    resetImport();
    setMessage("Import abgebrochen.");
  };

  return (
    <div className="page import-page">
      <header className="page-header">
        <div>
          <h2>{t.importContacts}</h2>
          <p>Wählen Sie zuerst, ob Kontakte oder Kalendertermine importiert werden sollen.</p>
        </div>
      </header>
      <StatusMessage message={message} />

      {!mode && (
        <section className="import-choice-grid" aria-label="Importart auswählen">
          <button className="import-choice-card" type="button" onClick={() => chooseMode("calendar")}>
            <CalendarDays size={34} />
            <span>
              <strong>Agenda importieren</strong>
              <small>Kalendertermine aus ICS, EML, PST oder OST übernehmen</small>
            </span>
          </button>
          <button className="import-choice-card" type="button" onClick={() => chooseMode("contacts")}>
            <UsersRound size={34} />
            <span>
              <strong>Kontakte importieren</strong>
              <small>Kontaktlisten aus CSV oder Excel übernehmen</small>
            </span>
          </button>
        </section>
      )}

      {mode && (
        <section className="form-panel import-wizard-panel">
          <div className="panel-heading">
            <div>
              <h3>{mode === "calendar" ? "Agenda importieren" : "Kontakte importieren"}</h3>
              <p className="import-step-text">1. Datei auswählen · 2. {mode === "calendar" ? "Kategorie wählen" : "Ziel wählen"} · 3. Vorschau prüfen · 4. Import bestätigen</p>
            </div>
            <button type="button" onClick={resetImport}>Andere Importart</button>
          </div>

          <div className="import-wizard-grid">
            <section className="import-step-box">
              <span className="import-step-number">1</span>
              <h4>Datei auswählen</h4>
              <p>{mode === "calendar" ? "ICS, EML, PST oder OST" : "CSV oder Excel-Datei"}</p>
              <button className="primary large" type="button" onClick={chooseFile}>
                <FileSpreadsheet size={24} /> Datei auswählen
              </button>
              {fileName && <small className="import-file-name">{fileName}</small>}
            </section>

            <section className="import-step-box">
              <span className="import-step-number">2</span>
              {mode === "calendar" ? (
                <>
                  <h4>Kategorie wählen</h4>
                  <p>Diese Kategorie und Farbe werden den importierten Terminen zugeordnet.</p>
                  <label className="field">
                    <span>Kategorie</span>
                    <input value={calendarCategory} onChange={(event) => setCalendarCategory(event.target.value)} list="calendar-import-categories" />
                  </label>
                  <datalist id="calendar-import-categories">
                    {suggestedCalendarCategories.map((category) => <option value={category} key={category} />)}
                  </datalist>
                  <label className="field">
                    <span>Farbe</span>
                    <select value={calendarColor} onChange={(event) => setCalendarColor(event.target.value)}>
                      {calendarColorOptions.map((color) => <option value={color.value} key={color.value}>{color.label}</option>)}
                    </select>
                  </label>
                  <span className="calendar-import-preview" style={{ "--event-bg": calendarColorOptions.find((color) => color.value === calendarColorValue(calendarColor))?.chip, "--event-border": calendarColorOptions.find((color) => color.value === calendarColorValue(calendarColor))?.border } as CSSProperties}>
                    {calendarCategory.trim() || defaultImportCategory}
                  </span>
                </>
              ) : (
                <>
                  <h4>Ziel wählen</h4>
                  <p>Kontakte ohne Gruppe landen in {ungroupedLabel}.</p>
                  <label className="field import-group-select">
                    <span>Kontaktgruppe</span>
                    <select value={selectedGroupId} onChange={(event) => setSelectedGroupId(event.target.value ? Number(event.target.value) : "")}>
                      <option value="">{ungroupedLabel}</option>
                      {groups.map((group) => (
                        <option key={group.id} value={group.id}>
                          {group.name}
                        </option>
                      ))}
                    </select>
                  </label>
                  <button type="button" onClick={() => setShowGroupCard(true)}>
                    <Plus size={22} /> Neue Gruppe
                  </button>
                </>
              )}
            </section>
          </div>
        </section>
      )}

      {showGroupCard && (
        <div className="modal-backdrop" role="dialog" aria-modal="true" aria-label="Neue Gruppe erstellen">
          <div className="modal-card">
            <section className="form-panel">
              <h3>Neue Gruppe erstellen</h3>
              <label className="field">
                <span>Gruppenname</span>
                <input value={newGroupName} onChange={(event) => setNewGroupName(event.target.value)} autoFocus />
              </label>
              <div className="button-row">
                <button className="primary" type="button" onClick={createGroup}>Speichern</button>
                <button type="button" onClick={() => setShowGroupCard(false)}>Abbrechen</button>
              </div>
            </section>
          </div>
        </div>
      )}

      {(preview || pendingEvents.length > 0) && (
        <section className="form-panel">
          <h3>Import prüfen</h3>
          <div className="import-summary">
            {preview && <strong>{preview.mapping.email ? `E-Mail-Spalte erkannt: ${preview.mapping.email}` : "Keine E-Mail-Spalte gefunden"}</strong>}
            {pendingEvents.length > 0 && <span>{pendingEvents.length} Kalendertermine erkannt</span>}
            {pendingEvents.length > 0 && <span>Kategorie: {calendarCategory.trim() || defaultImportCategory}</span>}
            {preview && <span>{contactsWithEmail.length} Kontakte mit E-Mail erkannt</span>}
            {preview && <span>{contactsWithoutEmail.length} Kontakte ohne E-Mail erkannt</span>}
            {preview && <span>Ziel: {selectedGroupId === "" ? ungroupedLabel : groups.find((group) => group.id === selectedGroupId)?.name ?? "Gruppe"}</span>}
          </div>
        </section>
      )}

      {preview && contactsWithEmail.length > 0 && (
        <section className="table-panel">
          <div className="panel-heading">
            <h3>Kontakte mit E-Mail: {contactsWithEmail.length}</h3>
            <div className="button-row">
              <button type="button" onClick={() => toggleAll(true)}>
                <CheckSquare size={20} /> Alle auswählen
              </button>
              <button type="button" onClick={() => toggleAll(false)}>
                <Square size={20} /> Auswahl aufheben
              </button>
            </div>
          </div>
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>Auswahl</th>
                  <th>Name</th>
                  <th>E-Mail</th>
                  <th>Telefon</th>
                  <th>Stadt</th>
                </tr>
              </thead>
              <tbody>
                {contactsWithEmail.map((contact, index) => {
                  const originalIndex = preview.contacts.indexOf(contact);
                  return (
                    <tr key={`${contact.email}-${index}`}>
                      <td><input type="checkbox" checked={contact.selected} onChange={() => toggleOne(originalIndex)} /></td>
                      <td>{contact.displayName || `${contact.firstName} ${contact.lastName}`}</td>
                      <td>{contact.email}</td>
                      <td>{contact.phone || contact.mobilePhone}</td>
                      <td>{contact.city}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </section>
      )}

      {preview && contactsWithoutEmail.length > 0 && (
        <section className="table-panel">
          <div className="panel-heading">
            <h3>Kontakte ohne E-Mail: {contactsWithoutEmail.length}</h3>
          </div>
          <p className="import-warning">Diese Personen haben keine erkannte E-Mail-Adresse. Sie können ausgewählt bleiben, werden aber ohne E-Mail importiert.</p>
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>Auswahl</th>
                  <th>Name</th>
                  <th>Telefon</th>
                  <th>Stadt</th>
                </tr>
              </thead>
              <tbody>
                {contactsWithoutEmail.map((contact, index) => {
                  const originalIndex = preview.contacts.indexOf(contact);
                  return (
                    <tr key={`${contact.displayName}-${index}`}>
                      <td><input type="checkbox" checked={contact.selected} onChange={() => toggleOne(originalIndex)} /></td>
                      <td>{contact.displayName || `${contact.firstName} ${contact.lastName}` || "Ohne Namen"}</td>
                      <td>{contact.phone || contact.mobilePhone}</td>
                      <td>{contact.city}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </section>
      )}

      {(preview || pendingEvents.length > 0) && (
        <section className="import-confirm-panel">
          <button className="primary large" type="button" onClick={submit} disabled={!canConfirm}>
            Importieren
          </button>
          <button className="large" type="button" onClick={cancelPreview}>
            <X size={20} /> Abbrechen
          </button>
        </section>
      )}
    </div>
  );
}

function normalizeCalendarEvent(event: CalendarEvent): CalendarEvent {
  return {
    ...event,
    color: calendarColorValue(event.color) || defaultCalendarColor,
    category: event.category ?? ""
  };
}

function applyCalendarImportCategory(event: CalendarEvent, category: string, color: string): CalendarEvent {
  return {
    ...event,
    category: category.trim() || defaultImportCategory,
    color: calendarColorValue(color)
  };
}

function contactsLabel(count: number) {
  return count === 1 ? "1 Kontakt" : `${count} Kontakte`;
}

function eventsLabel(count: number) {
  return count === 1 ? "1 Termin" : `${count} Termine`;
}
