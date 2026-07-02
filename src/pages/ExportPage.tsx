import { save } from "@tauri-apps/plugin-dialog";
import { Download } from "lucide-react";
import { useState } from "react";
import { StatusMessage } from "../components/StatusMessage";
import { t } from "../i18n";
import { getBackupData, listContacts, writeExportFile } from "../services/db";
import { exportBackupJson, exportGeneralCsv, exportNewOutlookCsv, exportOutlookClassicCsv } from "../utils/exporters";

type ExportKind = "classic" | "new" | "general" | "backup";

export function ExportPage() {
  const [message, setMessage] = useState("");

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

      const contacts = await listContacts();
      const csv = kind === "classic" ? exportOutlookClassicCsv(contacts) : kind === "new" ? exportNewOutlookCsv(contacts) : exportGeneralCsv(contacts);
      await writeExportFile(path, csv);
      setMessage(
        kind === "general"
          ? "CSV-Datei wurde erstellt."
          : "Die Datei wurde erstellt. Öffnen Sie Outlook, gehen Sie zu Personen/Kontakte und wählen Sie Importieren."
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
