import { ArchiveRestore, CheckCircle2, Clock3, LoaderCircle, ShieldCheck } from "lucide-react";
import { useEffect, useState } from "react";
import { StatusMessage } from "../components/StatusMessage";
import {
  getAppSetting,
  getBackupData,
  getMicrosoft365ConnectionStatus,
  getRecoveryArchiveStatus,
  restoreRecoveryCheckpoint,
  setAppSetting
} from "../services/db";
import type { RecoveryArchiveStatus } from "../types/contact";
import { addBrowserDataToBackup, restoreBrowserDataFromBackup } from "../utils/backup";
import { runAutomaticCalendarSync, synchronizationConfigKey } from "../utils/automaticCalendarSync";
import { enableCompleteAutomaticMicrosoft365Sync } from "../utils/microsoft365SyncConfig";
import { parseSyncConfig, type SyncConfig } from "../types/sync";

function formatDate(value: string | null): string {
  if (!value) return "Noch kein Wiederherstellungspunkt vorhanden";
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? "Zeitpunkt unbekannt" : date.toLocaleString("de-DE", { dateStyle: "medium", timeStyle: "short" });
}

function forceExportConfig(config: SyncConfig): SyncConfig {
  const sourceDirections = { ...config.sourceDirections };
  for (const sourceId of [...config.selectedContactSourceIds, ...config.selectedCalendarSourceIds]) {
    sourceDirections[sourceId] = "export";
  }
  return { ...config, enabled: true, paused: false, direction: "export", sourceDirections };
}

export function RecoveryPage() {
  const [status, setStatus] = useState<RecoveryArchiveStatus | null>(null);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");
  const [messageType, setMessageType] = useState<"success" | "error" | "info">("info");

  const refreshStatus = async () => {
    try {
      setStatus(await getRecoveryArchiveStatus());
    } catch (error) {
      setMessageType("error");
      setMessage(`Wiederherstellungsarchiv konnte nicht geprüft werden: ${error}`);
    }
  };

  useEffect(() => {
    void refreshStatus();
    const interval = window.setInterval(() => void refreshStatus(), 30_000);
    return () => window.clearInterval(interval);
  }, []);

  const restore = async () => {
    setBusy(true);
    setMessage("");
    try {
      const currentBackup = addBrowserDataToBackup(await getBackupData());
      const result = await restoreRecoveryCheckpoint(currentBackup);
      restoreBrowserDataFromBackup(result);

      const originalConfig = parseSyncConfig(await getAppSetting(synchronizationConfigKey));
      let recoveryConfig = forceExportConfig(originalConfig);
      const connection = await getMicrosoft365ConnectionStatus();
      let exchangeRestored = false;

      if (connection.connected) {
        const completeConfig = await enableCompleteAutomaticMicrosoft365Sync(true);
        recoveryConfig = forceExportConfig(completeConfig);
      }
      await setAppSetting(synchronizationConfigKey, JSON.stringify(recoveryConfig));

      if (connection.connected && recoveryConfig.selectedCalendarSourceIds.length > 0) {
        const syncStatus = await runAutomaticCalendarSync("change");
        if (syncStatus?.state === "success") {
          exchangeRestored = true;
          await setAppSetting(synchronizationConfigKey, JSON.stringify(originalConfig));
        }
      }

      setMessageType("success");
      setMessage(
        `${result.contacts} Kontakte, ${result.groups} Gruppen und ${result.calendarEvents} Termine wurden aus dem Stand vom ${formatDate(result.restoredAt)} wiederhergestellt.${exchangeRestored ? " Die Daten wurden auch wieder nach Exchange übertragen." : " Die App schützt die wiederhergestellten Daten jetzt im Modus App → Exchange und überträgt sie automatisch, sobald Exchange erreichbar ist."}`
      );
      window.setTimeout(() => window.location.reload(), 1_500);
    } catch (error) {
      setMessageType("error");
      setMessage(`Wiederherstellung konnte nicht abgeschlossen werden: ${error}`);
      await refreshStatus();
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="page recovery-page">
      <header className="page-header">
        <div>
          <h2>Notfall-Wiederherstellung</h2>
          <p>Nur für die EDV: Letzten sicheren Stand automatisch zurückholen.</p>
        </div>
        <span className="feature-development-badge"><ShieldCheck size={17} /> Nur EDV</span>
      </header>

      <StatusMessage message={message} type={messageType} />

      <section className="form-panel recovery-status-card">
        <span className="recovery-status-icon"><Clock3 size={25} aria-hidden="true" /></span>
        <div>
          <strong>Internes Wiederherstellungsarchiv</strong>
          <small>{status?.available ? `Letzter Punkt: ${formatDate(status.latestAt)}` : "Der erste Punkt wird im Hintergrund erstellt."}</small>
        </div>
        {status?.available && <span className="recovery-status-count">{status.contacts} Kontakte · {status.calendarEvents} Termine</span>}
      </section>

      <section className="form-panel recovery-action-card">
        <span className="recovery-action-icon"><ArchiveRestore size={31} aria-hidden="true" /></span>
        <div>
          <h3>Letzten sicheren Stand wiederherstellen</h3>
          <p>Stellt Kontakte, Gruppen, Termine, Einstellungen und die verschlüsselte Kennwort-Sicherung wieder her. Wenn Exchange verbunden ist, werden die Daten danach automatisch zurückübertragen.</p>
        </div>
        <button className="primary large" type="button" onClick={restore} disabled={busy || !status?.available}>
          {busy ? <LoaderCircle className="spin" size={22} /> : <ArchiveRestore size={22} />}
          {busy ? "Wird wiederhergestellt …" : "Jetzt wiederherstellen"}
        </button>
      </section>

      <section className="form-panel recovery-note">
        <CheckCircle2 size={22} aria-hidden="true" />
        <p>Die Sicherung läuft im Hintergrund alle fünf Minuten. Sie liegt nur im internen App-Bereich und wird nicht im normalen Menü angezeigt.</p>
      </section>
    </div>
  );
}
