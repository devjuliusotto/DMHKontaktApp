import { open } from "@tauri-apps/plugin-dialog";
import { readFile } from "@tauri-apps/plugin-fs";
import { CheckSquare, FileArchive, FileSpreadsheet, Plus, Square, X } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { StatusMessage } from "../components/StatusMessage";
import { t } from "../i18n";
import { importContacts, importOutlookStore, listGroups, saveGroup } from "../services/db";
import type { Group } from "../types/contact";
import { parseCsvBytes, parseXlsx, type ImportPreview } from "../utils/importers";

export function ImportPage() {
  const [fileName, setFileName] = useState("");
  const [preview, setPreview] = useState<ImportPreview | null>(null);
  const [groups, setGroups] = useState<Group[]>([]);
  const [selectedGroupId, setSelectedGroupId] = useState<number | "">("");
  const [message, setMessage] = useState("");
  const [showGroupCard, setShowGroupCard] = useState(false);
  const [newGroupName, setNewGroupName] = useState("");
  const selectedCount = preview?.contacts.filter((contact) => contact.selected).length ?? 0;
  const contactsWithEmail = useMemo(() => preview?.contacts.filter((contact) => contact.email.trim()) ?? [], [preview]);
  const contactsWithoutEmail = useMemo(() => preview?.contacts.filter((contact) => !contact.email.trim()) ?? [], [preview]);

  useEffect(() => {
    listGroups().then(setGroups).catch((error) => setMessage(`Gruppen konnten nicht geladen werden: ${error}`));
  }, []);

  const chooseFile = async (outlookStore = false) => {
    try {
      const path = await open({
        multiple: false,
        filters: [outlookStore
          ? { name: "Outlook-Datendatei", extensions: ["pst", "ost"] }
          : { name: "Kontaktdateien", extensions: ["csv", "xlsx"] }]
      });
      if (!path || Array.isArray(path)) return;
      setFileName(path);
      const lower = path.toLowerCase();
      if (lower.endsWith(".pst") || lower.endsWith(".ost")) {
        setMessage("Die vollständige Outlook-Agenda wird gelesen. Das kann einige Minuten dauern.");
        const result = await importOutlookStore(path);
        if (result.events.length) {
          const storageKey = "agendakontakte.calendarEvents";
          const existing = JSON.parse(localStorage.getItem(storageKey) ?? "[]") as typeof result.events;
          const eventsById = new Map(existing.map((event) => [event.id, event]));
          result.events.forEach((event) => eventsById.set(event.id, event));
          localStorage.setItem(storageKey, JSON.stringify(Array.from(eventsById.values())));
        }
        const contacts = result.contacts.map((contact) => ({ ...contact, selected: true }));
        setPreview({
          headers: ["Outlook PST/OST"],
          mapping: { email: "Outlook" },
          rows: [],
          contacts,
          logs: [],
          emailColumnMissing: contacts.length > 0 && contacts.every((contact) => !contact.email.trim())
        });
        setMessage(`${contactsLabel(contacts.length)} und ${result.events.length} Termine aus Outlook gefunden.`);
        return;
      }
      const bytes = await readFile(path);
      const result = lower.endsWith(".xlsx") ? parseXlsx(bytes) : parseCsvBytes(bytes);
      setPreview(result);
      setMessage(
        result.emailColumnMissing
          ? "Keine E-Mail-Spalte gefunden. Der Import ist erst möglich, wenn eine Datei mit E-Mail/Kontakt-Spalte gewählt wird."
          : `${contactsLabel(result.contacts.length)} gefunden. ${contactsLabel(result.contacts.filter((contact) => !contact.email.trim()).length)} ohne E-Mail.`
      );
    } catch (error) {
      setPreview(null);
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

  const submit = async () => {
    if (!preview) return;
    if (preview.emailColumnMissing) {
      setMessage("Keine E-Mail-Spalte gefunden. Der Import wurde nicht gestartet.");
      return;
    }
    const groupIds = selectedGroupId === "" ? [] : [selectedGroupId];
    const rows = preview.contacts
      .filter((contact) => contact.selected)
      .map(({ selected: _selected, ...contact }) => ({ ...contact, groupIds }));
    try {
      const result = await importContacts(fileName, rows);
      setMessage(`${result.imported} Kontakte importiert.`);
      setPreview(null);
    } catch (error) {
      setMessage(`Import fehlgeschlagen: ${error}`);
    }
  };

  const cancelPreview = () => {
    setPreview(null);
    setFileName("");
    setMessage("Import abgebrochen.");
  };

  return (
    <div className="page">
      <header className="page-header">
        <div>
          <h2>{t.importContacts}</h2>
          <p>Einzelne Kontaktlisten oder die vollständige Outlook-Agenda importieren.</p>
        </div>
      </header>
      <StatusMessage message={message} />
      <section className="action-panel">
        <button className="primary large" type="button" onClick={() => chooseFile(false)}>
          <FileSpreadsheet size={24} /> Datei auswählen
        </button>
        <button className="large" type="button" onClick={() => chooseFile(true)}>
          <FileArchive size={24} /> Outlook-Agenda (.pst/.ost)
        </button>
        <label className="field import-group-select">
          <span>Direkt in Gruppe importieren</span>
          <select value={selectedGroupId} onChange={(event) => setSelectedGroupId(event.target.value ? Number(event.target.value) : "")}>
            <option value="">Keine Gruppe</option>
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
      </section>
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
                <button className="primary" type="button" onClick={createGroup}>
                  Speichern
                </button>
                <button type="button" onClick={() => setShowGroupCard(false)}>
                  Abbrechen
                </button>
              </div>
            </section>
          </div>
        </div>
      )}
      {preview && (
        <section className="form-panel">
          <h3>Import prüfen</h3>
          <div className="import-summary">
            <strong>{preview.mapping.email ? `E-Mail-Spalte erkannt: ${preview.mapping.email}` : "Keine E-Mail-Spalte gefunden"}</strong>
            <span>{contactsWithEmail.length} Kontakte mit E-Mail erkannt</span>
            <span>{contactsWithoutEmail.length} Kontakte ohne E-Mail erkannt</span>
          </div>
        </section>
      )}
      {preview && contactsWithEmail.length > 0 && (
        <section className="table-panel">
          <div className="panel-heading">
            <h3>Kontakte mit E-Mail: {contactsWithEmail.length}</h3>
            <div className="button-row">
              <button className="primary" type="button" onClick={submit} disabled={!selectedCount || preview.emailColumnMissing}>
                Ausgewählte Kontakte importieren
              </button>
              <button type="button" onClick={() => toggleAll(true)}>
                <CheckSquare size={20} /> Alle auswählen
              </button>
              <button type="button" onClick={() => toggleAll(false)}>
                <Square size={20} /> Auswahl aufheben
              </button>
              <button type="button" onClick={cancelPreview}>
                <X size={20} /> Nicht importieren
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
                      <td>
                        <input type="checkbox" checked={contact.selected} onChange={() => toggleOne(originalIndex)} />
                      </td>
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
                      <td>
                        <input type="checkbox" checked={contact.selected} onChange={() => toggleOne(originalIndex)} />
                      </td>
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
    </div>
  );
}

function contactsLabel(count: number) {
  return count === 1 ? "1 Kontakt" : `${count} Kontakte`;
}
