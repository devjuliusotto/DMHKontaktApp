import {
  ArchiveRestore,
  CalendarDays,
  CheckCircle2,
  ChevronLeft,
  ChevronRight,
  ContactRound,
  DatabaseBackup,
  FolderTree,
  HardDrive,
  History,
  LoaderCircle,
  Search,
  ShieldCheck,
  Trash2
} from "lucide-react";
import { useEffect, useState, type ReactNode } from "react";
import { StatusMessage } from "../components/StatusMessage";
import {
  getRecoveryArchiveStatus,
  previewRecoveryArchive,
  restoreRecoveryArchive
} from "../services/db";
import type {
  RecoveryArchivePreview,
  RecoveryArchiveSource,
  RecoveryArchiveStatus,
  RecoveryCheckpointSummary
} from "../types/contact";

const pageSize = 100;

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
  if (!value) return "Noch kein Backup vorhanden";
  const date = new Date(value);
  return Number.isNaN(date.getTime())
    ? "Zeitpunkt unbekannt"
    : date.toLocaleString("de-DE", { dateStyle: "medium", timeStyle: "short" });
}

function sourceTitle(source: RecoveryArchiveSource): string {
  return source === "closing" ? "Abschlussarchiv" : "Laufender Schutz";
}

export function RecoveryPage() {
  const [status, setStatus] = useState<RecoveryArchiveStatus | null>(null);
  const [source, setSource] = useState<RecoveryArchiveSource>("background");
  const [selectedCheckpointId, setSelectedCheckpointId] = useState<string | null>(null);
  const [preview, setPreview] = useState<RecoveryArchivePreview | null>(null);
  const [previewBusy, setPreviewBusy] = useState(false);
  const [restoreBusy, setRestoreBusy] = useState(false);
  const [query, setQuery] = useState("");
  const [offset, setOffset] = useState(0);
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

  useEffect(() => {
    if (!("__TAURI_INTERNALS__" in window)) return;
    if (source === "background" && !selectedCheckpointId) return;
    let cancelled = false;
    const timer = window.setTimeout(async () => {
      setPreviewBusy(true);
      try {
        const nextPreview = await previewRecoveryArchive(
          source,
          source === "background" ? selectedCheckpointId ?? undefined : undefined,
          query,
          offset,
          pageSize
        );
        if (!cancelled) {
          setPreview(nextPreview);
          setMessage("");
        }
      } catch (error) {
        if (!cancelled) {
          setPreview(null);
          setMessageType("error");
          setMessage(`${sourceTitle(source)} konnte nicht gelesen werden: ${error}`);
        }
      } finally {
        if (!cancelled) setPreviewBusy(false);
      }
    }, query ? 250 : 0);
    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, [source, selectedCheckpointId, query, offset]);

  const selectSource = (nextSource: RecoveryArchiveSource) => {
    setSource(nextSource);
    setOffset(0);
    setQuery("");
    setMessage("");
  };

  const selectCheckpoint = (checkpoint: RecoveryCheckpointSummary) => {
    setSelectedCheckpointId(checkpoint.id);
    setOffset(0);
  };

  const restore = async () => {
    if (!preview || preview.totalItems === 0) return;
    const confirmed = window.confirm(
      `${preview.sourceLabel} vom ${formatDate(preview.createdAt)} verwenden?\n\n` +
      `${preview.activeContacts} Kontakte, ${preview.activeCalendarEvents} Termine und ${preview.groupsToCreate} Gruppen werden aktiv zurückgebracht. ` +
      `${preview.trashContacts + preview.trashCalendarEvents} bereits früher gelöschte Elemente werden sicher in den Papierkorb gelegt.\n\n` +
      "Vorher wird ein zusätzlicher Sicherheitsstand erstellt. Vorhandene Daten werden nicht ersetzt oder gelöscht."
    );
    if (!confirmed) return;

    setRestoreBusy(true);
    setMessage("");
    try {
      const result = await restoreRecoveryArchive(
        source,
        source === "background" ? selectedCheckpointId ?? undefined : undefined
      );
      setMessageType("success");
      setMessage(
        `${result.activeContacts} Kontakte und ${result.activeCalendarEvents} Termine wurden aktiv wiederhergestellt. ` +
        `${result.trashContacts + result.trashCalendarEvents} historische Elemente liegen im Papierkorb. ` +
        `${result.groups} Gruppen wurden ergänzt oder wieder aktiviert.`
      );
      window.setTimeout(() => window.location.reload(), 2_000);
    } catch (error) {
      setMessageType("error");
      setMessage(`Wiederherstellung konnte nicht abgeschlossen werden: ${error}`);
    } finally {
      setRestoreBusy(false);
    }
  };

  return (
    <div className="page recovery-page">
      <header className="page-header recovery-page-header">
        <div>
          <span className="recovery-eyebrow"><ShieldCheck size={16} /> Lokaler Datenschutz</span>
          <h2>Backups wiederherstellen</h2>
          <p>Zwei voneinander unabhängige Sicherungen prüfen und fehlende Daten ohne Überschreiben zurückholen.</p>
        </div>
        <span className="feature-development-badge"><ShieldCheck size={17} /> Nur EDV</span>
      </header>

      <StatusMessage message={message} type={messageType} />

      <section className="recovery-source-grid" aria-label="Backup auswählen">
        <button className={source === "closing" ? "recovery-source-card selected" : "recovery-source-card"} type="button" onClick={() => selectSource("closing")}>
          <span className="recovery-source-icon"><DatabaseBackup size={28} /></span>
          <span><strong>1. Abschlussarchiv</strong><small>Wird beim Schließen fortgeschrieben. Neue Kontakte und Termine kommen hinzu; normale Löschungen entfernen nichts aus dem Archiv.</small></span>
          <i aria-hidden="true" />
        </button>
        <button className={source === "background" ? "recovery-source-card selected" : "recovery-source-card"} type="button" onClick={() => selectSource("background")}>
          <span className="recovery-source-icon"><ShieldCheck size={28} /></span>
          <span><strong>2. Laufender Schutz</strong><small>Speichert Änderungen automatisch im Hintergrund. Frühere aktive Daten bleiben unabhängig erhalten.</small></span>
          <i aria-hidden="true" />
        </button>
      </section>

      {source === "background" && status?.checkpoints.length ? (
        <section className="form-panel recovery-checkpoint-picker">
          <header><History size={21} /><div><h3>Zeitpunkt wählen</h3><p>Der neueste Stand ist bereits ausgewählt.</p></div></header>
          <div className="recovery-checkpoint-chips">
            {status.checkpoints.slice(0, 24).map((checkpoint, index) => (
              <button className={checkpoint.id === selectedCheckpointId ? "selected" : ""} key={checkpoint.id} type="button" onClick={() => selectCheckpoint(checkpoint)}>
                <strong>{index === 0 ? "Neuester" : formatDate(checkpoint.createdAt)}</strong>
                <small>{checkpoint.contacts} Kontakte · {checkpoint.calendarEvents} Termine</small>
              </button>
            ))}
          </div>
        </section>
      ) : null}

      <section className="recovery-metrics" aria-label="Vorschau der Wiederherstellung">
        <Metric icon={<ContactRound size={21} />} value={preview?.activeContacts ?? 0} label="in Kontakte" />
        <Metric icon={<CalendarDays size={21} />} value={preview?.activeCalendarEvents ?? 0} label="in Kalender" />
        <Metric icon={<Trash2 size={21} />} value={(preview?.trashContacts ?? 0) + (preview?.trashCalendarEvents ?? 0)} label="in Papierkorb" />
        <Metric icon={<FolderTree size={21} />} value={preview?.groupsToCreate ?? 0} label="Gruppen ergänzen" />
      </section>

      <section className="form-panel recovery-preview-panel">
        <header className="recovery-preview-heading">
          <div>
            <span className="recovery-history-icon"><ArchiveRestore size={23} /></span>
            <div><h3>Genaue Vorschau</h3><p>{preview ? `${preview.totalItems.toLocaleString("de-DE")} fehlende Elemente aus ${preview.sourceLabel} · ${formatDate(preview.createdAt)}` : "Backup wird geprüft …"}</p></div>
          </div>
          <label className="recovery-search"><Search size={18} /><input value={query} onChange={(event) => { setQuery(event.target.value); setOffset(0); }} placeholder="Name, Termin oder Gruppe suchen" /></label>
        </header>

        {previewBusy ? (
          <div className="recovery-loading"><LoaderCircle className="spin" size={28} /><span>Backup wird sicher verglichen …</span></div>
        ) : preview?.items.length ? (
          <div className="recovery-preview-list">
            {preview.items.map((item) => (
              <article className="recovery-preview-item" key={`${item.kind}-${item.id}-${item.title}`}>
                <span className="recovery-preview-item-icon">{item.kind === "contact" ? <ContactRound size={20} /> : <CalendarDays size={20} />}</span>
                <div><strong>{item.title}</strong><small>{item.detail}</small>{item.groups.length ? <em>{item.groups.join(" · ")}</em> : null}</div>
                <span className={`recovery-destination ${item.destination}`}>{item.destination === "trash" ? "Papierkorb" : item.destination === "contacts" ? "Kontakte" : "Kalender"}</span>
              </article>
            ))}
          </div>
        ) : (
          <div className="recovery-empty-state"><CheckCircle2 size={30} /><div><strong>{preview?.totalItems === 0 ? "Alles bereits vorhanden" : preview?.groupsToCreate && !query ? "Nur Gruppen werden ergänzt" : "Keine passenden Elemente"}</strong><p>{preview?.totalItems === 0 ? "Dieses Backup enthält nichts, das im App-Bestand fehlt." : preview?.groupsToCreate && !query ? "Die betroffenen Gruppen stehen in der Übersicht darunter." : "Ändern Sie den Suchbegriff."}</p></div></div>
        )}

        {preview && preview.matchingItems > pageSize ? (
          <footer className="recovery-preview-pagination">
            <span>{preview.offset + 1}–{Math.min(preview.offset + preview.items.length, preview.matchingItems)} von {preview.matchingItems.toLocaleString("de-DE")}</span>
            <div><button type="button" onClick={() => setOffset(Math.max(0, offset - pageSize))} disabled={offset === 0}><ChevronLeft size={18} /> Zurück</button><button type="button" onClick={() => setOffset(offset + pageSize)} disabled={!preview.hasMore}>Weiter <ChevronRight size={18} /></button></div>
          </footer>
        ) : null}
      </section>

      {preview?.groups.length ? (
        <section className="form-panel recovery-group-preview">
          <header><FolderTree size={21} /><div><h3>Kontaktgruppen</h3><p>So viele wiederherzustellende Kontakte gehören jeweils zur Gruppe.</p></div></header>
          <div>{preview.groups.map((group) => <span key={group.name}><strong>{group.name}</strong><small>{group.contacts} Kontakte{group.willBeCreated ? " · wird angelegt" : ""}</small></span>)}</div>
        </section>
      ) : null}

      <section className="form-panel recovery-restore-bar recovery-additive-note">
        <div><small>Sichere, additive Wiederherstellung</small><strong>Vorhandene Kontakte und Termine bleiben unverändert.</strong><span>Fehlende aktive Daten kommen zurück; historische Löschungen landen zuerst im Papierkorb.</span></div>
        <button className="primary large" type="button" onClick={restore} disabled={restoreBusy || previewBusy || !preview?.totalItems}>{restoreBusy ? <LoaderCircle className="spin" size={22} /> : <ArchiveRestore size={22} />}{restoreBusy ? "Wird wiederhergestellt …" : "Vorschau wiederherstellen"}</button>
      </section>

      <section className="form-panel recovery-note"><HardDrive size={22} aria-hidden="true" /><p><strong>Wichtig:</strong> Weder normales Löschen noch das Leeren des Papierkorbs entfernt Kontakte, Gruppen oder Termine aus diesen beiden Archiven. Dadurch bleibt auch nach einer versehentlichen Massenlöschung eine Rückkehr möglich.</p></section>
    </div>
  );
}

function Metric({ icon, value, label }: { icon: ReactNode; value: number; label: string }) {
  return <article className="recovery-metric-card"><span>{icon}</span><div><strong>{value.toLocaleString("de-DE")}</strong><small>{label}</small></div></article>;
}
