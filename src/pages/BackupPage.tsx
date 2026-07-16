import { open, save } from "@tauri-apps/plugin-dialog";
import { readTextFile, writeTextFile } from "@tauri-apps/plugin-fs";
import { ArchiveRestore, ShieldCheck } from "lucide-react";
import { useState } from "react";
import { StatusMessage } from "../components/StatusMessage";
import { t } from "../i18n";
import { getBackupData, restoreBackup } from "../services/db";
import { exportBackupJson } from "../utils/exporters";

export function BackupPage() {
  const [message, setMessage] = useState("");

  const create = async () => {
    const path = await save({
      defaultPath: "DMH-Kontakte-Kalender-Sicherung.json",
      filters: [{ name: "JSON", extensions: ["json"] }]
    });
    if (!path) return;
    await writeTextFile(path, exportBackupJson(await getBackupData()));
    setMessage("Sicherung wurde erstellt.");
  };

  const restore = async () => {
    const path = await open({ multiple: false, filters: [{ name: "JSON", extensions: ["json"] }] });
    if (!path || Array.isArray(path)) return;
    if (!window.confirm("Die aktuellen Daten werden durch die Sicherung ersetzt. Fortfahren?")) return;
    const backup = JSON.parse(await readTextFile(path));
    await restoreBackup(backup);
    setMessage("Sicherung wurde wiederhergestellt.");
  };

  return (
    <div className="page">
      <header className="page-header">
        <div>
          <h2>{t.backup}</h2>
          <p>Erstellen oder laden Sie eine vollständige lokale Sicherung.</p>
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
