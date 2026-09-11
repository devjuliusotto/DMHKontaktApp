import {
  ArchiveRestore,
  CalendarDays,
  CheckCircle2,
  Clock3,
  ContactRound,
  HardDrive,
  History,
  LoaderCircle,
  ShieldCheck
} from "lucide-react";
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
import type { RecoveryArchiveStatus, RecoveryCheckpointSummary } from "../types/contact";
import { addBrowserDataToBackup, restoreBrowserDataFromBackup } from "../utils/backup";
import { runAutomaticCalendarSync, synchronizationConfigKey } from "../utils/automaticCalendarSync";
import { enableCompleteAutomaticMicrosoft365Sync } from "../utils/microsoft365SyncConfig";
import { parseSyncConfig, type SyncConfig } from "../types/sync";

const emptyRecoveryStatus: RecoveryArchiveStatus = {
  available: false,
  latestAt: null,
  contacts: 0,
  groups: 0,
  calendarEvents: 0,
  totalCheckpoints: 0,
  totalSizeBytes: 0,
  checkpoints: []
};

function formatDate(value: string | null): string {
  if (!value) return "Noch kein Wiederherstellungspunkt vorhanden";
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? "Zeitpunkt unbekannt" : date.toLocaleString("de-DE", { dateStyle: "medium", timeStyle: "short" });
}

function formatCheckpointDay(value: string): string {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? "Unbekannt" : date.toLocaleDateString("de-DE", { day: "2-digit", month: "short", year: "numeric" });
}

function formatCheckpointTime(value: string): string {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? "--:--" : date.toLocaleTimeString("de-DE", { hour: "2-digit", minute: "2-digit" });
}

function formatStorageSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  const kilobytes = bytes / 1024;
  if (kilobytes < 1024) return `${kilobytes.toLocaleString("de-DE", { maximumFractionDigits: 0 })} KB`;
  return `${(kilobytes / 1024).toLocaleString("de-DE", { maximumFractionDigits: 1 })} MB`;
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
  const [selectedCheckpointId, setSelectedCheckpointId] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");
  const [messageType, setMessageType] = useState<"success" | "error" | "info">("info");

  const refreshStatus = async () => {
    if (!("__TAURI_INTERNALS__" in window)) {
      setStatus(emptyRecoveryStatus);
      return;
    }
    try {
      const nextStatus = await getRecoveryArchiveStatus();
      setStatus(nextStatus);
      setSelectedCheckpointId((current) =>
        current && nextStatus.checkpoints.some((checkpoint) => checkpoint.id === current)
          ? current
          : nextStatus.checkpoints[0]?.id ?? null
      );
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

  const selectedCheckpoint = status?.checkpoints.find((checkpoint) => checkpoint.id === selectedCheckpointId) ?? null;

  const restore = async () => {
    if (!selectedCheckpoint) return;
    const confirmed = window.confirm(
      `Stand vom ${formatDate(selectedCheckpoint.createdAt)} wiederherstellen?\n\n${selectedCheckpoint.contacts} Kontakte und ${selectedCheckpoint.calendarEvents} Termine werden in die App zurückgeholt. Der aktuelle Stand wird vorher zusätzlich geschützt.`
    );
    if (!confirmed) return;

    setBusy(true);
    setMessage("");
    try {
      const currentBackup = addBrowserDataToBackup(await getBackupData());
      const result = await restoreRecoveryCheckpoint(currentBackup, selectedCheckpoint.id);
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
      <header className="page-header recovery-page-header">
        <div>
          <span className="recovery-eyebrow"><ShieldCheck size={16} /> Lokaler Datenschutz</span>
          <h2>Notfall-Wiederherstellung</h2>
          <p>Frühere Datenstände prüfen und gezielt zurückholen.</p>
        </div>
        <span className="feature-development-badge"><ShieldCheck size={17} /> Nur EDV</span>
      </header>

      <StatusMessage message={message} type={messageType} />

      <section className="recovery-protection-hero" aria-labelledby="recovery-protection-title">
        <span className="recovery-protection-icon"><ShieldCheck size={34} aria-hidden="true" /></span>
        <div>
          <span className="recovery-live-badge"><i /> Schutz aktiv</span>
          <h3 id="recovery-protection-title">Ihre Daten behalten ein Gedächtnis</h3>
          <p>Neue Änderungen erzeugen automatisch kompakte Wiederherstellungspunkte. Löschungen überschreiben keinen bereits geschützten Datenstand.</p>
        </div>
        <div className="recovery-last-checkpoint">
          <small>Letzter sicherer Stand</small>
          <strong>{status?.available ? formatDate(status.latestAt) : "Wird vorbereitet"}</strong>
        </div>
      </section>

      <section className="recovery-metrics" aria-label="Übersicht des Wiederherstellungsarchivs">
        <article className="recovery-metric-card">
          <span><History size={21} /></span>
          <div><strong>{status?.totalCheckpoints ?? 0}</strong><small>Checkpoints</small></div>
        </article>
        <article className="recovery-metric-card">
          <span><ContactRound size={21} /></span>
          <div><strong>{status?.contacts ?? 0}</strong><small>Kontakte geschützt</small></div>
        </article>
        <article className="recovery-metric-card">
          <span><CalendarDays size={21} /></span>
          <div><strong>{status?.calendarEvents ?? 0}</strong><small>Termine geschützt</small></div>
        </article>
        <article className="recovery-metric-card">
          <span><HardDrive size={21} /></span>
          <div><strong>{formatStorageSize(status?.totalSizeBytes ?? 0)}</strong><small>Speicher belegt</small></div>
        </article>
      </section>

      <section className="form-panel recovery-history-panel" aria-labelledby="recovery-history-title">
        <header className="recovery-history-heading">
          <div>
            <span className="recovery-history-icon"><History size={23} /></span>
            <div><h3 id="recovery-history-title">Gesicherte Zeitpunkte</h3><p>Wählen Sie den Stand, den Sie wiederherstellen möchten.</p></div>
          </div>
          {status?.totalCheckpoints ? <span>{status.totalCheckpoints} verfügbar</span> : null}
        </header>

        {status?.checkpoints.length ? (
          <div className="recovery-timeline" role="listbox" aria-label="Wiederherstellungspunkt auswählen">
            {status.checkpoints.map((checkpoint, index) => (
              <CheckpointRow
                checkpoint={checkpoint}
                isLatest={index === 0}
                isSelected={checkpoint.id === selectedCheckpointId}
                key={checkpoint.id}
                onSelect={() => setSelectedCheckpointId(checkpoint.id)}
              />
            ))}
          </div>
        ) : (
          <div className="recovery-empty-state">
            <Clock3 size={30} />
            <div><strong>Der erste Checkpoint wird vorbereitet</strong><p>Er entsteht automatisch, sobald die installierte App gestartet wird oder Daten geändert werden.</p></div>
          </div>
        )}

        <footer className="recovery-restore-bar">
          <div>
            <small>Ausgewählter Stand</small>
            <strong>{selectedCheckpoint ? formatDate(selectedCheckpoint.createdAt) : "Noch keine Auswahl möglich"}</strong>
            {selectedCheckpoint ? <span>{selectedCheckpoint.contacts} Kontakte · {selectedCheckpoint.calendarEvents} Termine · {formatStorageSize(selectedCheckpoint.sizeBytes)}</span> : null}
          </div>
          <button className="primary large" type="button" onClick={restore} disabled={busy || !selectedCheckpoint}>
            {busy ? <LoaderCircle className="spin" size={22} /> : <ArchiveRestore size={22} />}
            {busy ? "Wird wiederhergestellt …" : "Diesen Stand wiederherstellen"}
          </button>
        </footer>
      </section>

      <section className="form-panel recovery-note">
        <CheckCircle2 size={22} aria-hidden="true" />
        <p><strong>Verlustschutz:</strong> Vor einer Löschung wird zuerst ein Sicherheits-Checkpoint angelegt. Die App behält bis zu 240 komprimierte Datenstände, mindestens die letzten 12; ältere Punkte werden bei hohem Speicherbedarf automatisch bereinigt.</p>
      </section>
    </div>
  );
}

interface CheckpointRowProps {
  checkpoint: RecoveryCheckpointSummary;
  isLatest: boolean;
  isSelected: boolean;
  onSelect: () => void;
}

function CheckpointRow({ checkpoint, isLatest, isSelected, onSelect }: CheckpointRowProps) {
  return (
    <button
      className={isSelected ? "recovery-checkpoint selected" : "recovery-checkpoint"}
      type="button"
      role="option"
      aria-selected={isSelected}
      onClick={onSelect}
    >
      <span className="recovery-checkpoint-marker"><i /></span>
      <span className="recovery-checkpoint-time">
        <strong>{formatCheckpointTime(checkpoint.createdAt)}</strong>
        <small>{formatCheckpointDay(checkpoint.createdAt)}</small>
      </span>
      <span className="recovery-checkpoint-counts">
        <span><ContactRound size={17} /> {checkpoint.contacts} Kontakte</span>
        <span><CalendarDays size={17} /> {checkpoint.calendarEvents} Termine</span>
        <span><HardDrive size={17} /> {formatStorageSize(checkpoint.sizeBytes)}</span>
      </span>
      {isLatest ? <span className="recovery-checkpoint-latest">Neuester Stand</span> : null}
      <span className="recovery-checkpoint-choice" aria-hidden="true"><i /></span>
    </button>
  );
}
