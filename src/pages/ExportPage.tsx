import { save } from "@tauri-apps/plugin-dialog";
import { Download } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { StatusMessage } from "../components/StatusMessage";
import { t } from "../i18n";
import { getBackupData, listContacts, listGroups, writeExportFile } from "../services/db";
import type { Contact, Group } from "../types/contact";
import { exportBackupJson, exportGeneralCsv, exportNewOutlookCsv, exportOutlookClassicCsv } from "../utils/exporters";

type ExportKind = "classic" | "new" | "general" | "backup";

export function ExportPage() {
  const [message, setMessage] = useState("");
  const [groups, setGroups] = useState<Group[]>([]);
  const [selectedGroupIds, setSelectedGroupIds] = useState<number[]>([]);

  useEffect(() => {
    listGroups().then(setGroups).catch((error) => setMessage(`Gruppen konnten nicht geladen werden: ${error}`));
  }, []);

  const selectedGroups = useMemo(
    () => groups.filter((group) => group.id && selectedGroupIds.includes(group.id)),
    [groups, selectedGroupIds]
  );

  const exportScopeText = selectedGroups.length
    ? `Exportiert werden nur Kontakte aus: ${selectedGroups.map((group) => group.name).join(", ")}.`
    : "Ohne Gruppenauswahl werden alle Kontakte exportiert.";

  const toggleGroup = (groupId: number) => {
    setSelectedGroupIds((current) => current.includes(groupId) ? current.filter((id) => id !== groupId) : [...current, groupId]);
  };

  const filterContactsByGroups = (contacts: Contact[]) => {
    if (!selectedGroupIds.length) return contacts;
    const selected = new Set(selectedGroupIds);
    const byId = new Map<number | string, Contact>();
    contacts
      .filter((contact) => contact.groups.some((group) => group.id && selected.has(group.id)))
      .forEach((contact, index) => byId.set(contact.id ?? `contact-${index}`, contact));
    return Array.from(byId.values());
  };

  const runExport = async (kind: ExportKind) => {
    try {
      const extension = kind === "backup" ? "json" : "csv";
      const path = await save({
        defaultPath: `AgendaKontakte-${kind}.${extension}`,
        filters: [{ name: extension.toUpperCase(), extensions: [extension] }]
      });
      if (!path) return;

      if (kind === "backup") {
        await writeExportFile(path, exportBackupJson(await getBackupData()));
        setMessage("Sicherung wurde erstellt.");
        return;
      }

      const contacts = filterContactsByGroups(await listContacts());
      const csv = kind === "classic" ? exportOutlookClassicCsv(contacts) : kind === "new" ? exportNewOutlookCsv(contacts) : exportGeneralCsv(contacts);
      await writeExportFile(path, csv);
      setMessage(
        `${selectedGroupIds.length ? `${contacts.length} Kontakte aus ausgewählten Gruppen exportiert.` : `${contacts.length} Kontakte exportiert.`} ${
          kind === "general"
            ? "CSV-Datei wurde erstellt."
            : "Öffnen Sie Outlook, gehen Sie zu Personen/Kontakte und wählen Sie Importieren."
        }`
      );
    } catch (error) {
      setMessage(`Export fehlgeschlagen: ${error}`);
    }
  };

  return (
    <div className="page">
      <header className="page-header">
        <div>
          <h2>{t.exportContacts}</h2>
          <p>Kontakte als CSV oder vollständige Sicherung speichern.</p>
        </div>
      </header>
      <StatusMessage message={message} />
      <section className="action-panel export-options">
        <div>
          <h3>Gruppen für CSV-Export</h3>
          <p>{exportScopeText}</p>
        </div>
        <div className="export-group-picker">
          {groups.map((group) => {
            if (!group.id) return null;
            return (
              <label className="checkbox-row" key={group.id}>
                <input type="checkbox" checked={selectedGroupIds.includes(group.id)} onChange={() => toggleGroup(group.id!)} />
                <span>{group.name}</span>
              </label>
            );
          })}
          {groups.length === 0 && <span className="empty-inline">Keine Gruppen angelegt.</span>}
        </div>
      </section>
      <section className="export-grid">
        <button className="export-card" type="button" onClick={() => runExport("classic")}>
          <Download size={30} />
          <strong>{t.outlookClassic}</strong>
          <span>CSV für Outlook Classic</span>
        </button>
        <button className="export-card" type="button" onClick={() => runExport("new")}>
          <Download size={30} />
          <strong>{t.newOutlook}</strong>
          <span>CSV für New Outlook</span>
        </button>
        <button className="export-card" type="button" onClick={() => runExport("general")}>
          <Download size={30} />
          <strong>Allgemeine CSV exportieren</strong>
          <span>Für Tabellenprogramme</span>
        </button>
        <button className="export-card" type="button" onClick={() => runExport("backup")}>
          <Download size={30} />
          <strong>{t.createBackup}</strong>
          <span>JSON-Sicherung aller lokalen Daten</span>
        </button>
      </section>
    </div>
  );
}
