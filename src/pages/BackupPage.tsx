import { open, save } from "@tauri-apps/plugin-dialog";
import { readTextFile, writeTextFile } from "@tauri-apps/plugin-fs";
import { ArchiveRestore, ShieldCheck } from "lucide-react";
import { useState } from "react";
import { StatusMessage } from "../components/StatusMessage";
import { t } from "../i18n";
import { getBackupData, restoreBackup } from "../services/db";
import { addBrowserDataToBackup, restoreBrowserDataFromBackup } from "../utils/backup";
import { exportBackupJson } from "../utils/exporters";

export function BackupPage() {
  const [message, setMessage] = useState("");

  const create = async () => {
    const path = await save({
      defaultPath: "DMH-Kontakte-Kalender-Sicherung.json",
      filters: [{ name: "JSON", extensions: ["json"] }]
    });
    if (!path) return;
    await writeTextFile(path, exportBackupJson(addBrowserDataToBackup(await getBackupData())));
    setMessage("Sicherung wurde erstellt.");
  };

  const restore = async () => {
    const path = await open({ multiple: false, filters: [{ name: "JSON", extensions: ["json"] }] });
    if (!path || Array.isArray(path)) return;
    if (!window.confirm("Die aktuellen Daten werden durch die Sicherung ersetzt. Fortfahren?")) return;
    const backup = JSON.parse(await readTextFile(path));
    await restoreBackup(backup);
    restoreBrowserDataFromBackup(backup);
    setMessage("Sicherung wurde wiederhergestellt. Die App wird neu geladen.");
    window.setTimeout(() => window.location.reload(), 500);
  };

  return (
    <div className="page">
      <header className="page-header">
        <div>
          <h2>{t.backup}</h2>
          <p>
            Kontakte, Gruppen, Kalender und Darstellung sichern oder wiederherstellen.
            Kennwörter und EDV-Übertragungsstatus werden nicht exportiert.
          </p>
          <p>
            Zusätzlich erstellt die App automatisch eine kumulative Sicherung in
            <code>Dokumente\DMH Kontakte und Kalender\Automatische Sicherung</code>.
            Diese Sicherung wird während der Nutzung regelmäßig und beim Schließen aktualisiert.
            Gelöschte Kontakte, Termine und Kennworteinträge bleiben dort erhalten und werden mit
            „Gelöschtes Element“ gekennzeichnet. Kennwörter werden dabei ausschließlich verschlüsselt
            gespeichert. Die Wiederherstellung dieser automatischen Sicherung ist aus Sicherheitsgründen
            nur verdeckt in den Einstellungen und zusammen mit der EDV möglich.
          </p>
        </div>
      </header>
      <StatusMessage message={message} />
      <section className="action-panel">
        <button className="primary large" type="button" onClick={create}>
          <ShieldCheck size={26} /> {t.createBackup}
        </button>
        <button className="large" type="button" onClick={restore}>
          <ArchiveRestore size={26} /> {t.restoreBackup}
        </button>
      </section>
    </div>
  );
}
