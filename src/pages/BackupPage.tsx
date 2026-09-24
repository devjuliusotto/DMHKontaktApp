import { open, save } from "@tauri-apps/plugin-dialog";
import { readTextFile, writeTextFile } from "@tauri-apps/plugin-fs";
import { ArchiveRestore, CheckCircle2, Download, Info, ShieldCheck } from "lucide-react";
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
    <div className="page backup-page-clean">
      <header className="page-header">
        <div>
          <h2>{t.backup}</h2>
          <p>Lokale Sicherheitskopien erstellen oder wiederherstellen.</p>
        </div>
      </header>
      <StatusMessage message={message} />
      <section className="backup-status-card form-panel" title="Der lokale Sicherungsverlauf funktioniert ohne Microsoft-Konto und schützt vor versehentlichen Änderungen.">
        <span className="backup-status-icon"><CheckCircle2 size={23} aria-hidden="true" /></span>
        <div><strong>Automatischer Sicherungsverlauf aktiv</strong><small>Speichert nur Änderungen und bewahrt gelöschte Kontakte, Gruppen und Termine dauerhaft lokal auf</small></div>
      </section>
      <section className="backup-action-grid">
        <article className="form-panel backup-action-card">
          <ShieldCheck size={25} aria-hidden="true" />
          <div><h3>Sicherung erstellen</h3><p>Eine Datei zum Aufbewahren oder Übertragen erstellen.</p></div>
          <button className="primary" type="button" onClick={create}><Download size={19} /> Erstellen</button>
        </article>
        <article className="form-panel backup-action-card">
          <ArchiveRestore size={25} aria-hidden="true" />
          <div><h3>Sicherung wiederherstellen</h3><p>Daten aus einer zuvor erstellten Datei laden.</p></div>
          <button type="button" onClick={restore}><ArchiveRestore size={19} /> Datei wählen</button>
        </article>
      </section>
      <details className="form-panel backup-details">
        <summary><Info size={18} /> Was wird gesichert?</summary>
        <div>
          <p>Die manuelle Datei enthält Kontakte, Gruppen, Kalender und Darstellung. Kennwörter und der EDV-Übertragungsstatus werden nicht exportiert.</p>
          <p>Der automatische Verlauf liegt als SQLite-Datenbank im geschützten App-Bereich. Nach dem ersten Aufbau werden nur geänderte Datensätze ergänzt; normales Löschen oder Leeren des Papierkorbs entfernt sie nicht aus dem Verlauf.</p>
          <p>Kennwörter werden ausschließlich verschlüsselt gespeichert.</p>
          <p>Die automatische Sicherung benötigt kein Microsoft-Konto und keine Internetverbindung. Eine manuell exportierte Datei bleibt sinnvoll, wenn auch ein Defekt oder Verlust des Computers abgesichert werden soll.</p>
        </div>
      </details>
    </div>
  );
}
