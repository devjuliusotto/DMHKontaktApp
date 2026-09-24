import { open } from "@tauri-apps/plugin-dialog";
import { readFile } from "@tauri-apps/plugin-fs";
import { listen } from "@tauri-apps/api/event";
import { CalendarDays, CheckSquare, FileSpreadsheet, Pause, Plus, Square, UsersRound, X } from "lucide-react";
import type { CSSProperties } from "react";
import { useEffect, useMemo, useState } from "react";
import { StatusMessage } from "../components/StatusMessage";
import { ActionResultDialog, type ActionResult } from "../components/ActionResultDialog";
import { t } from "../i18n";
import { cancelCalendarFileImport, discardCalendarFileImport, getPendingCalendarFileImport, importContacts, importOutlookStore, listGroups, mergeCalendarEvents, prepareCalendarFileImport, runCalendarFileImport, saveGroup } from "../services/db";
import type { CalendarEvent, CalendarFileImportStatus } from "../types/calendar";
import type { Group } from "../types/contact";
import { contactEmails } from "../utils/contact";
import { calendarColorFromCategory, calendarColorOptions, calendarColorValue, defaultCalendarColor, mergeImportedCalendarCategories, mergeImportedCalendarCategoryDefinitions } from "../utils/calendar";
import { type ImportPreview } from "../utils/importers";
import { parseContactFileInWorker } from "../utils/importParserWorker";

type ImportMode = "contacts" | "calendar";

const ungroupedLabel = "Gesammelte Adressen";
const defaultImportCategory = "Allgemein";
const suggestedCalendarCategories = ["Geburtstag", "Arbeit", "Sitzung", "Beratung", "PJT"];

interface ImportPageProps {
  embedded?: boolean;
  initialMode?: ImportMode;
}

export function ImportPage({ embedded = false, initialMode }: ImportPageProps) {
  const [mode, setMode] = useState<ImportMode | null>(initialMode ?? null);
  const [fileName, setFileName] = useState("");
  const [preview, setPreview] = useState<ImportPreview | null>(null);
  const [pendingEvents, setPendingEvents] = useState<CalendarEvent[]>([]);
  const [nativeCalendarImport, setNativeCalendarImport] = useState<CalendarFileImportStatus | null>(null);
  const [calendarImportBusy, setCalendarImportBusy] = useState(false);
  const [groups, setGroups] = useState<Group[]>([]);
  const [selectedGroupId, setSelectedGroupId] = useState<number | "">("");
  const [message, setMessage] = useState("");
  const [actionResult, setActionResult] = useState<ActionResult | null>(null);
  const [showGroupCard, setShowGroupCard] = useState(false);
  const [newGroupName, setNewGroupName] = useState("");
  const [calendarCategory, setCalendarCategory] = useState(defaultImportCategory);
  const [calendarColor, setCalendarColor] = useState(defaultCalendarColor);

  const selectedCount = preview?.contacts.filter((contact) => contact.selected).length ?? 0;
  const contactsWithEmail = useMemo(() => preview?.contacts.filter((contact) => contactEmails(contact).length > 0) ?? [], [preview]);
  const contactsWithoutEmail = useMemo(() => preview?.contacts.filter((contact) => contactEmails(contact).length === 0) ?? [], [preview]);
  const canConfirm = Boolean((preview && selectedCount > 0 && !preview.emailColumnMissing) || pendingEvents.length > 0 || nativeCalendarImport);

  useEffect(() => {
    if (!("__TAURI_INTERNALS__" in window)) return;
    listGroups().then(setGroups).catch((error) => setMessage(`Gruppen konnten nicht geladen werden: ${error}`));
  }, []);

  useEffect(() => {
    if (!("__TAURI_INTERNALS__" in window)) return;
    let disposed = false;
    let unlisten: (() => void) | undefined;
    listen<CalendarFileImportStatus>("calendar-file-import-progress", (event) => {
      if (!disposed) setNativeCalendarImport(event.payload);
    }).then((cleanup) => { unlisten = cleanup; });
    return () => {
      disposed = true;
      unlisten?.();
    };
  }, []);

  useEffect(() => {
    if (mode !== "calendar" || nativeCalendarImport || !("__TAURI_INTERNALS__" in window)) return;
    getPendingCalendarFileImport().then((job) => {
      if (!job) return;
      setNativeCalendarImport(job);
      setFileName(job.filePath);
      setCalendarCategory(job.fallbackCategory || defaultImportCategory);
      setCalendarColor(job.fallbackColor || defaultCalendarColor);
      setMessage(job.byteOffset > 0 ? "Ein unterbrochener Kalenderimport kann sicher fortgesetzt werden." : "Kalenderdatei ist für den Import bereit.");
    }).catch(() => undefined);
  }, [mode, nativeCalendarImport]);

  const resetImport = () => {
    setMode(null);
    setFileName("");
    setPreview(null);
    setPendingEvents([]);
    setNativeCalendarImport(null);
    setCalendarImportBusy(false);
    setSelectedGroupId("");
    setShowGroupCard(false);
    setNewGroupName("");
    setCalendarCategory(defaultImportCategory);
    setCalendarColor(defaultCalendarColor);
  };

  const chooseMode = (nextMode: ImportMode) => {
    resetImport();
    setActionResult(null);
    setMode(nextMode);
    setMessage(nextMode === "contacts" ? "Wählen Sie eine Kontaktdatei aus." : "Wählen Sie eine Kalenderdatei oder Outlook-Datendatei aus.");
  };

  const createContactPreview = (contacts: ImportPreview["contacts"]): ImportPreview => ({
    headers: ["Outlook PST/OST"],
    mapping: { email: "Outlook" },
    rows: [],
    contacts,
    logs: [],
    emailColumnMissing: contacts.length > 0 && contacts.every((contact) => contactEmails(contact).length === 0)
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
      setNativeCalendarImport(null);

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
          setMessage(`${eventsLabel(result.events.length)} gefunden. Originalkategorien werden beibehalten; bitte Ersatzkategorie prüfen und bestätigen.`);
        }
        return;
      }

      if (mode === "calendar") {
        setMessage("Kalenderdatei wird für den sicheren Import vorbereitet …");
        const job = await prepareCalendarFileImport(path, calendarCategory.trim() || defaultImportCategory, calendarColor);
        setNativeCalendarImport(job);
        setMessage(job.byteOffset > 0 ? "Der frühere Importstand wurde gefunden und kann fortgesetzt werden." : "Datei ist bereit. Der Import erfolgt speicherschonend in sicheren Blöcken.");
        return;
      }

      const bytes = await readFile(path);
      setMessage("Kontaktdatei wird im Hintergrund verarbeitet …");
      const result = await parseContactFileInWorker(bytes, lower.endsWith(".xlsx"));
      setPreview(result);
      setMessage(
        result.emailColumnMissing
          ? "Keine E-Mail-Spalte gefunden. Der Import ist erst möglich, wenn eine Datei mit E-Mail/Kontakt-Spalte gewählt wird."
          : `${contactsLabel(result.contacts.length)} gefunden. Bitte Kontaktgruppe wählen und prüfen.`
      );
    } catch (error) {
      setPreview(null);
      setPendingEvents([]);
      setNativeCalendarImport(null);
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

  const savePendingEvents = async () => {
    if (!pendingEvents.length) return { imported: 0, skipped: 0, categories: 0 };
    const incoming = pendingEvents.map((event) => applyCalendarImportCategory(event, calendarCategory, calendarColor));
    const merged = await mergeCalendarEvents(incoming);
    const categoryResult = mergeImportedCalendarCategories(incoming);
    return {
      imported: merged.imported,
      skipped: merged.skippedSameId + merged.skippedExactDuplicates,
      categories: categoryResult.added + categoryResult.updated
    };
  };

  const submit = async () => {
    if (!canConfirm) {
      setMessage("Bitte wählen Sie zuerst eine Datei mit importierbaren Daten aus.");
      return;
    }
    if (preview?.emailColumnMissing && pendingEvents.length === 0 && !nativeCalendarImport) {
      setMessage("Keine E-Mail-Spalte gefunden. Der Import wurde nicht gestartet.");
      return;
    }

    try {
      setCalendarImportBusy(Boolean(nativeCalendarImport));
      let calendarResult = await savePendingEvents();
      if (nativeCalendarImport) {
        const result = await runCalendarFileImport(
          nativeCalendarImport.jobId,
          calendarCategory.trim() || defaultImportCategory,
          calendarColor
        );
        setNativeCalendarImport(result);
        if (result.status !== "completed") {
          setMessage("Import wurde sicher pausiert. Sie können ihn später an derselben Stelle fortsetzen.");
          return;
        }
        const categoryResult = mergeImportedCalendarCategoryDefinitions(result.categories);
        calendarResult = {
          imported: result.imported,
          skipped: result.skippedSameId + result.skippedExactDuplicates + result.skippedInvalid,
          categories: categoryResult.added + categoryResult.updated
        };
      }
      let importedContacts = 0;
      let skippedContactDuplicates = 0;

      if (preview && selectedCount > 0 && !preview.emailColumnMissing) {
        const groupIds = selectedGroupId === "" ? [] : [selectedGroupId];
        const rows = preview.contacts
          .filter((contact) => contact.selected)
          .map(({ selected: _selected, ...contact }) => ({ ...contact, groupIds }));
        const result = await importContacts(fileName, rows);
        importedContacts = result.imported;
        skippedContactDuplicates = result.skippedDuplicates;
      }

      resetImport();
      setMessage("");
      setActionResult({
        title: "Import abgeschlossen",
        summary: `${contactsLabel(importedContacts)} und ${eventsLabel(calendarResult.imported)} wurden importiert.`,
        tone: "success",
        details: [
          skippedContactDuplicates > 0 ? `${contactsLabel(skippedContactDuplicates)} mit exakt gleichem Inhalt wurden sicher ausgelassen.` : "Keine exakt gleichen Kontaktkopien wurden zusätzlich angelegt.",
          calendarResult.skipped > 0 ? `${eventsLabel(calendarResult.skipped)} mit gleicher ID oder exakt gleichen Feldern wurden sicher ausgelassen.` : "Keine exakt gleichen Kalenderkopien wurden zusätzlich angelegt.",
          calendarResult.categories > 0 ? `${calendarResult.categories} Kategorie(n) mit Farbe wurden übernommen.` : "Es mussten keine zusätzlichen Kategorien angelegt werden."
        ]
      });
    } catch (error) {
      setMessage("");
      setActionResult({
        title: "Import fehlgeschlagen",
        summary: String(error),
        tone: "error",
        details: ["Bereits vorhandene Daten wurden nicht gelöscht.", "Sie können den Import nach der Prüfung erneut starten."]
      });
    } finally {
      setCalendarImportBusy(false);
    }
  };

  const pauseNativeImport = async () => {
    if (!nativeCalendarImport) return;
    await cancelCalendarFileImport(nativeCalendarImport.jobId);
    setMessage("Der Import wird nach dem aktuellen sicheren Block pausiert …");
  };

  const cancelPreview = async () => {
    if (nativeCalendarImport) {
      try {
        await discardCalendarFileImport(nativeCalendarImport.jobId);
      } catch (error) {
        setMessage(String(error));
        return;
      }
    }
    resetImport();
    setMessage("Import abgebrochen.");
  };

  return (
    <div className="page import-page">
      {!embedded && (
        <header className="page-header">
          <div>
            <h2>{t.importContacts}</h2>
            <p>Wählen Sie zuerst, ob Kontakte oder Kalendertermine importiert werden sollen.</p>
          </div>
        </header>
      )}
      <StatusMessage message={actionResult ? "" : message} />
      <ActionResultDialog result={actionResult} onClose={() => setActionResult(null)} />

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
              <p className="import-step-text">1. Datei auswählen · 2. {mode === "calendar" ? "Ersatzkategorie prüfen" : "Ziel wählen"} · 3. Vorschau prüfen · 4. Import bestätigen</p>
            </div>
            <button type="button" onClick={resetImport} disabled={calendarImportBusy}>Andere Importart</button>
          </div>

          <div className="import-wizard-grid">
            <section className="import-step-box">
              <span className="import-step-number">1</span>
              <h4>Datei auswählen</h4>
              <p>{mode === "calendar" ? "ICS, EML, PST oder OST" : "CSV oder Excel-Datei"}</p>
              <button className="primary large" type="button" onClick={chooseFile} disabled={calendarImportBusy}>
                <FileSpreadsheet size={24} /> Datei auswählen
              </button>
              {fileName && <small className="import-file-name">{fileName}</small>}
            </section>

            <section className="import-step-box">
              <span className="import-step-number">2</span>
              {mode === "calendar" ? (
                <>
                  <h4>Ersatzkategorie wählen</h4>
                  <p>Vorhandene Kategorien und Farben bleiben erhalten. Diese Auswahl gilt nur für Termine, bei denen die Quelldatei keine Kategorie oder Farbe enthält.</p>
                  <label className="field">
                    <span>Kategorie</span>
                    <input value={calendarCategory} onChange={(event) => setCalendarCategory(event.target.value)} list="calendar-import-categories" disabled={calendarImportBusy || Boolean(nativeCalendarImport?.byteOffset)} />
                  </label>
                  <datalist id="calendar-import-categories">
                    {suggestedCalendarCategories.map((category) => <option value={category} key={category} />)}
                  </datalist>
                  <label className="field">
                    <span>Farbe</span>
                    <select value={calendarColor} onChange={(event) => setCalendarColor(event.target.value)} disabled={calendarImportBusy || Boolean(nativeCalendarImport?.byteOffset)}>
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

      {nativeCalendarImport && (
        <section className="form-panel calendar-native-import" aria-live="polite">
          <div className="panel-heading">
            <div>
              <h3>{calendarImportBusy ? "Kalender wird importiert" : nativeCalendarImport.status === "paused" ? "Import pausiert" : "Sicherer Kalenderimport"}</h3>
              <p>{nativeCalendarImport.fileName}</p>
            </div>
            <strong>{nativeCalendarImport.progressPercent.toLocaleString("de-DE", { maximumFractionDigits: 1 })} %</strong>
          </div>
          <div className="calendar-native-import-track" role="progressbar" aria-valuemin={0} aria-valuemax={100} aria-valuenow={nativeCalendarImport.progressPercent}>
            <span style={{ width: `${nativeCalendarImport.progressPercent}%` }} />
          </div>
          <div className="calendar-native-import-stats">
            <span><strong>{nativeCalendarImport.processed.toLocaleString("de-DE")}</strong> geprüft</span>
            <span><strong>{nativeCalendarImport.imported.toLocaleString("de-DE")}</strong> importiert</span>
            <span><strong>{(nativeCalendarImport.skippedSameId + nativeCalendarImport.skippedExactDuplicates).toLocaleString("de-DE")}</strong> Duplikate ausgelassen</span>
            <span><strong>{nativeCalendarImport.skippedInvalid.toLocaleString("de-DE")}</strong> ungültig</span>
          </div>
          {nativeCalendarImport.lastError && <p className="import-warning">{nativeCalendarImport.lastError}</p>}
          {calendarImportBusy && (
            <button type="button" onClick={pauseNativeImport}>
              <Pause size={20} /> Sicher pausieren
            </button>
          )}
        </section>
      )}

      {(preview || pendingEvents.length > 0 || nativeCalendarImport) && (
        <section className="form-panel">
          <h3>Import prüfen</h3>
          <div className="import-summary">
            {preview && <strong>{preview.mapping.email ? `E-Mail-Spalte erkannt: ${preview.mapping.email}` : "Keine E-Mail-Spalte gefunden"}</strong>}
            {pendingEvents.length > 0 && <span>{pendingEvents.length} Kalendertermine erkannt</span>}
            {pendingEvents.length > 0 && <span>Ersatzkategorie: {calendarCategory.trim() || defaultImportCategory}</span>}
            {nativeCalendarImport && <span>Die Datei wird direkt vom Datenträger gelesen; Termine werden nicht vollständig in den Arbeitsspeicher geladen.</span>}
            {nativeCalendarImport && <span>Ersatzkategorie: {calendarCategory.trim() || defaultImportCategory}</span>}
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
                      <td>{contactEmails(contact)[0] ?? "-"}</td>
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

      {(preview || pendingEvents.length > 0 || nativeCalendarImport) && (
        <section className="import-confirm-panel">
          <button className="primary large" type="button" onClick={submit} disabled={!canConfirm || calendarImportBusy}>
            {nativeCalendarImport?.byteOffset ? "Import fortsetzen" : "Importieren"}
          </button>
          <button className="large" type="button" onClick={cancelPreview} disabled={calendarImportBusy}>
            <X size={20} /> Abbrechen
          </button>
        </section>
      )}
    </div>
  );
}

function normalizeCalendarEvent(event: CalendarEvent): CalendarEvent {
  const category = event.category?.trim() ?? "";
  return {
    ...event,
    color: calendarColorFromCategory(category, event.color),
    category
  };
}

function applyCalendarImportCategory(event: CalendarEvent, category: string, color: string): CalendarEvent {
  const importedCategory = event.category.trim();
  return {
    ...event,
    category: importedCategory || category.trim() || defaultImportCategory,
    color: importedCategory || calendarColorValue(event.color) !== defaultCalendarColor
      ? calendarColorFromCategory(importedCategory, event.color)
      : calendarColorValue(color)
  };
}

function contactsLabel(count: number) {
  return count === 1 ? "1 Kontakt" : `${count} Kontakte`;
}

function eventsLabel(count: number) {
  return count === 1 ? "1 Termin" : `${count} Termine`;
}
