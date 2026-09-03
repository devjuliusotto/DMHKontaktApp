import {
  ArrowLeft,
  CalendarCheck2,
  CheckCircle2,
  CircleAlert,
  LoaderCircle,
  RefreshCw,
  ShieldCheck,
  X
} from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import {
  createAutomaticBackup,
  getBackupData,
  importOutlookClassicAppointmentsOnce,
  importThunderbirdCalendarsOnce,
  restoreBackup
} from "../services/db";
import type { BackupData } from "../types/contact";
import type { CalendarEvent } from "../types/calendar";
import { calendarColorFromCategory, calendarStorageKey, mergeImportedCalendarCategories, parseCalendarDate } from "../utils/calendar";
import {
  applyCalendarReconciliation,
  compareCalendars,
  readCalendarReconciliationBaseline,
  writeCalendarReconciliationBaseline,
  type CalendarReconciliationPreview
} from "../utils/calendarReconciliation";
import { addBrowserDataToBackup, restoreBrowserDataFromBackup } from "../utils/backup";

type Platform = "outlook" | "thunderbird";
type Stage = "source" | "preview" | "done";

interface CalendarReconciliationDialogProps {
  open: boolean;
  events: CalendarEvent[];
  onClose: () => void;
  onChanged: (events: CalendarEvent[], message: string) => void | Promise<void>;
}

function platformName(platform: Platform): string {
  return platform === "outlook" ? "Outlook Classic" : "Thunderbird";
}

function formatEventDate(event: CalendarEvent): string {
  const starts = parseCalendarDate(event.startsAt);
  const ends = parseCalendarDate(event.endsAt || event.startsAt);
  if (!starts) return event.startsAt;
  const date = new Intl.DateTimeFormat("de-DE", { weekday: "short", day: "2-digit", month: "2-digit", year: "numeric" }).format(starts);
  const time = new Intl.DateTimeFormat("de-DE", { hour: "2-digit", minute: "2-digit" });
  return `${date} · ${time.format(starts)}–${ends ? time.format(ends) : ""}`;
}

export function CalendarReconciliationDialog({ open, events, onClose, onChanged }: CalendarReconciliationDialogProps) {
  const [stage, setStage] = useState<Stage>("source");
  const [platform, setPlatform] = useState<Platform | null>(null);
  const [incoming, setIncoming] = useState<CalendarEvent[]>([]);
  const [preview, setPreview] = useState<CalendarReconciliationPreview | null>(null);
  const [sourceCount, setSourceCount] = useState(0);
  const [conflictChoices, setConflictChoices] = useState<Record<string, "local" | "external">>({});
  const [busy, setBusy] = useState<"scan" | "apply" | "undo" | null>(null);
  const [error, setError] = useState("");
  const [resultMessage, setResultMessage] = useState("");
  const [undoBackup, setUndoBackup] = useState<BackupData | null>(null);
  const [undone, setUndone] = useState(false);

  useEffect(() => {
    if (!open) return;
    setStage("source");
    setPlatform(null);
    setIncoming([]);
    setPreview(null);
    setSourceCount(0);
    setConflictChoices({});
    setBusy(null);
    setError("");
    setResultMessage("");
    setUndoBackup(null);
    setUndone(false);
  }, [open]);

  const conflicts = useMemo(
    () => preview?.items.filter((item) => item.status === "conflict") ?? [],
    [preview]
  );

  if (!open) return null;

  const scan = async (nextPlatform: Platform) => {
    setPlatform(nextPlatform);
    setBusy("scan");
    setError("");
    try {
      let nextIncoming: CalendarEvent[];
      let nextSourceCount: number;
      if (nextPlatform === "outlook") {
        const result = await importOutlookClassicAppointmentsOnce();
        nextIncoming = result.events;
        nextSourceCount = new Set(result.events.map((event) => event.source).filter(Boolean)).size;
      } else {
        const result = await importThunderbirdCalendarsOnce();
        nextIncoming = result.events;
        nextSourceCount = result.calendars;
      }
      nextIncoming = nextIncoming.map((event) => ({
        ...event,
        color: calendarColorFromCategory(event.category, event.color)
      }));
      if (nextIncoming.length === 0) throw new Error(`Keine Termine in ${platformName(nextPlatform)} gefunden.`);
      const nextPreview = compareCalendars(
        events,
        nextIncoming,
        readCalendarReconciliationBaseline(nextPlatform)
      );
      setIncoming(nextIncoming);
      setSourceCount(nextSourceCount);
      setPreview(nextPreview);
      setConflictChoices(Object.fromEntries(
        nextPreview.items.filter((item) => item.status === "conflict").map((item) => [item.key, "local"])
      ));
      setStage("preview");
    } catch (scanError) {
      setError(String(scanError));
    } finally {
      setBusy(null);
    }
  };

  const apply = async () => {
    if (!platform || !preview) return;
    setBusy("apply");
    setError("");
    let backup: BackupData | null = null;
    try {
      backup = addBrowserDataToBackup(await getBackupData());
      await createAutomaticBackup(backup, true);
      setUndoBackup(backup);

      const nextEvents = applyCalendarReconciliation(events, preview, conflictChoices);
      localStorage.setItem(calendarStorageKey, JSON.stringify(nextEvents));
      mergeImportedCalendarCategories(nextEvents);
      writeCalendarReconciliationBaseline(platform, incoming);

      const externalChoices = conflicts.filter((item) => conflictChoices[item.key] === "external").length;
      const changed = preview.newEvents + preview.updates + externalChoices;
      setResultMessage(`${preview.newEvents} neu · ${preview.updates + externalChoices} aktualisiert · ${preview.exact} bereits vorhanden`);
      setStage("done");
      try {
        await onChanged(nextEvents, `${changed} Kalenderänderungen wurden sicher übernommen.`);
      } catch {
        // Storage already contains the completed reconciliation.
      }
    } catch (applyError) {
      let restored = false;
      if (backup) {
        try {
          await restoreBackup(backup);
          restoreBrowserDataFromBackup(backup);
          restored = true;
        } catch {
          // The automatic snapshot remains available to EDV even if this rollback fails.
        }
      }
      setError(restored
        ? `Es wurde nichts übernommen. ${String(applyError)}`
        : `Der Abgleich wurde unterbrochen. Die automatische Sicherung bleibt für die EDV verfügbar. ${String(applyError)}`);
    } finally {
      setBusy(null);
    }
  };

  const undo = async () => {
    if (!undoBackup) return;
    setBusy("undo");
    setError("");
    try {
      await restoreBackup(undoBackup);
      restoreBrowserDataFromBackup(undoBackup);
      const restored = JSON.parse(localStorage.getItem(calendarStorageKey) ?? "[]") as CalendarEvent[];
      setUndone(true);
      setResultMessage("Der letzte Kalenderabgleich wurde vollständig rückgängig gemacht.");
      try {
        await onChanged(restored, "Der letzte Kalenderabgleich wurde rückgängig gemacht.");
      } catch {
        // Restoration succeeded even if the visible calendar cannot refresh yet.
      }
    } catch (undoError) {
      setError(`Rückgängig machen nicht möglich: ${String(undoError)}`);
    } finally {
      setBusy(null);
    }
  };

  return (
    <div className="modal-backdrop reconciliation-backdrop">
      <section className="modal-card reconciliation-dialog calendar-reconciliation-dialog" role="dialog" aria-modal="true" aria-labelledby="calendar-reconciliation-title">
        <header className="reconciliation-heading">
          <span className="reconciliation-heading-icon"><CalendarCheck2 size={27} /></span>
          <div>
            <h2 id="calendar-reconciliation-title">Kalender erneut abgleichen</h2>
            <p>{stage === "source" ? "Quelle auswählen" : stage === "preview" ? "Unterschiede prüfen" : "Abgleich abgeschlossen"}</p>
          </div>
          <button className="icon-only" type="button" aria-label="Schließen" onClick={onClose} disabled={busy !== null}><X size={22} /></button>
        </header>

        {stage === "source" && (
          <>
            <div className="reconciliation-platforms">
              <button type="button" onClick={() => void scan("outlook")} disabled={busy !== null}>
                <span className="easy-import-platform-icon outlook"><img src="/brands/outlook.svg" alt="" /></span>
                <span><strong>Outlook Classic</strong><small>Kalender vergleichen</small></span>
                {busy === "scan" && platform === "outlook" && <LoaderCircle className="spin" size={23} />}
              </button>
              <button type="button" onClick={() => void scan("thunderbird")} disabled={busy !== null}>
                <span className="easy-import-platform-icon thunderbird"><img src="/brands/thunderbird.svg" alt="" /></span>
                <span><strong>Thunderbird</strong><small>Kalender vergleichen</small></span>
                {busy === "scan" && platform === "thunderbird" && <LoaderCircle className="spin" size={23} />}
              </button>
            </div>
            <p className="reconciliation-safe-line"><ShieldCheck size={18} /> Vergleichen ändert noch nichts.</p>
          </>
        )}

        {stage === "preview" && preview && platform && (
          <>
            <div className="reconciliation-source-line">
              <img src={platform === "outlook" ? "/brands/outlook.svg" : "/brands/thunderbird.svg"} alt="" />
              <span><strong>{platformName(platform)}</strong><small>{sourceCount} Kalender · {incoming.length} Termine gefunden</small></span>
            </div>
            <div className="reconciliation-stats">
              <span className="new"><strong>{preview.newEvents}</strong><small>Neu</small></span>
              <span className="merge"><strong>{preview.updates}</strong><small>Aktualisieren</small></span>
              <span><strong>{preview.exact}</strong><small>Unverändert</small></span>
              <span className={preview.conflicts ? "conflict" : ""}><strong>{preview.conflicts}</strong><small>Entscheiden</small></span>
            </div>
            <div className="reconciliation-rules calendar-reconciliation-rules">
              <p><CheckCircle2 size={18} /> {preview.localOnly} Termine gibt es nur im App und bleiben erhalten.</p>
              <p><CheckCircle2 size={18} /> {preview.localChanges} Änderungen aus dem App werden nicht überschrieben.</p>
              <p><ShieldCheck size={18} /> Nichts wird automatisch gelöscht.</p>
            </div>

            {conflicts.length > 0 && (
              <div className="calendar-reconciliation-conflicts">
                <div className="calendar-reconciliation-conflict-heading">
                  <div><strong>Bitte entscheiden</strong><small>Im Zweifel: Version im App behalten.</small></div>
                  <button type="button" onClick={() => setConflictChoices(Object.fromEntries(conflicts.map((item) => [item.key, "local"])))}>Alle im App behalten</button>
                </div>
                {conflicts.map((item) => (
                  <article key={item.key} className="calendar-reconciliation-conflict">
                    <div>
                      <strong>{item.incoming.title || "Ohne Titel"}</strong>
                      <small>Unterschied gefunden</small>
                    </div>
                    <div className="calendar-reconciliation-choice" role="group" aria-label={`Version für ${item.incoming.title || "Termin"} wählen`}>
                      <button className={conflictChoices[item.key] !== "external" ? "selected" : ""} type="button" onClick={() => setConflictChoices((current) => ({ ...current, [item.key]: "local" }))}>
                        <strong>Im App behalten</strong>
                        <small>{item.existing ? formatEventDate(item.existing) : "Keine App-Version"}</small>
                        {item.existing?.location && <small>{item.existing.location}</small>}
                        {item.existing?.category && <small>{item.existing.category}</small>}
                      </button>
                      <button className={conflictChoices[item.key] === "external" ? "selected" : ""} type="button" onClick={() => setConflictChoices((current) => ({ ...current, [item.key]: "external" }))}>
                        <strong>Aus {platformName(platform)}</strong>
                        <small>{formatEventDate(item.incoming)}</small>
                        {item.incoming.location && <small>{item.incoming.location}</small>}
                        {item.incoming.category && <small>{item.incoming.category}</small>}
                      </button>
                    </div>
                  </article>
                ))}
              </div>
            )}

            <div className="button-row reconciliation-actions">
              <button type="button" onClick={() => { setStage("source"); setError(""); }} disabled={busy !== null}><ArrowLeft size={18} /> Zurück</button>
              <button className="primary" type="button" onClick={() => void apply()} disabled={busy !== null}>
                {busy === "apply" ? <LoaderCircle className="spin" size={20} /> : <RefreshCw size={20} />}
                {busy === "apply" ? "Wird abgeglichen …" : "Abgleich starten"}
              </button>
            </div>
          </>
        )}

        {stage === "done" && (
          <div className="reconciliation-finished" role="status">
            <CheckCircle2 size={44} />
            <h3>{undone ? "Abgleich rückgängig gemacht" : "Kalender sind abgeglichen"}</h3>
            <p>{resultMessage}</p>
            <div className="button-row">
              {!undone && undoBackup && <button type="button" onClick={() => void undo()} disabled={busy !== null}>{busy === "undo" ? "Wird zurückgesetzt …" : "Letzten Abgleich rückgängig"}</button>}
              <button className="primary" type="button" onClick={onClose} disabled={busy !== null}>Fertig</button>
            </div>
          </div>
        )}

        {error && <div className="reconciliation-error" role="alert"><CircleAlert size={20} /><span>{error}</span></div>}
      </section>
    </div>
  );
}
