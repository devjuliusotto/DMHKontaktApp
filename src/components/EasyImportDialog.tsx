import { ArrowLeft, CalendarDays, CheckCircle2, CircleAlert, CloudCog, LoaderCircle, LockKeyhole, RefreshCw, UsersRound, X } from "lucide-react";
import { useEffect, useState } from "react";
import { detectConnectedCalendarSources } from "../services/db";
import type { DetectedCalendarSourcesResult } from "../types/calendar";
import { easyImport, type EasyImportKind, type EasyImportPlatform, type EasyImportResult } from "../utils/easyImport";

interface EasyImportDialogProps {
  kind: EasyImportKind;
  open: boolean;
  onClose: () => void;
  onImported: (result: EasyImportResult) => void | Promise<void>;
  onManageSync?: () => void;
  initialConnectedMode?: boolean;
}

function importErrorMessage(error: unknown): string {
  const raw = String(error);
  if (raw.includes("QuotaExceededError") || raw.includes("exceeded the quota")) {
    return "Der alte Zwischenspeicher dieses PCs ist voll. Bitte installieren Sie die aktuelle DMH-Backup-Version; große Kalender werden dort sicher in der lokalen Datenbank gespeichert.";
  }
  return "Der Import konnte nicht abgeschlossen werden. Ihre vorhandenen Daten wurden nicht verändert. Bitte versuchen Sie es erneut; bleibt das Problem bestehen, informieren Sie die EDV.";
}

export function EasyImportDialog({ kind, open, onClose, onImported, onManageSync, initialConnectedMode = false }: EasyImportDialogProps) {
  const [busyPlatform, setBusyPlatform] = useState<EasyImportPlatform | null>(null);
  const [result, setResult] = useState<EasyImportResult | null>(null);
  const [error, setError] = useState("");
  const [connectedMode, setConnectedMode] = useState(false);
  const [discovery, setDiscovery] = useState<DetectedCalendarSourcesResult | null>(null);
  const [discoveryBusy, setDiscoveryBusy] = useState(false);
  const [discoveryError, setDiscoveryError] = useState("");
  const contacts = kind === "contacts";
  const DataIcon = contacts ? UsersRound : CalendarDays;

  useEffect(() => {
    if (!open) {
      setBusyPlatform(null);
      setResult(null);
      setError("");
      setConnectedMode(false);
      setDiscovery(null);
      setDiscoveryBusy(false);
      setDiscoveryError("");
    }
  }, [open]);

  useEffect(() => {
    if (!open || !initialConnectedMode || contacts) return;
    setConnectedMode(true);
    setDiscoveryBusy(true);
    setDiscoveryError("");
    void detectConnectedCalendarSources()
      .then(setDiscovery)
      .catch(() => setDiscoveryError("Die verbundenen Kalender konnten nicht geprüft werden. Ihre vorhandenen Daten wurden nicht verändert."))
      .finally(() => setDiscoveryBusy(false));
  }, [contacts, initialConnectedMode, open]);

  if (!open) return null;

  const startImport = async (platform: EasyImportPlatform) => {
    setBusyPlatform(platform);
    setResult(null);
    setError("");
    try {
      const imported = await easyImport(kind, platform);
      setResult(imported);
      await onImported(imported);
    } catch (importError) {
      setError(importErrorMessage(importError));
    } finally {
      setBusyPlatform(null);
    }
  };

  const scanConnectedCalendars = async () => {
    setConnectedMode(true);
    setDiscoveryBusy(true);
    setDiscoveryError("");
    try {
      setDiscovery(await detectConnectedCalendarSources());
    } catch {
      setDiscoveryError("Die verbundenen Kalender konnten nicht geprüft werden. Ihre vorhandenen Daten wurden nicht verändert.");
    } finally {
      setDiscoveryBusy(false);
    }
  };

  const importClients = new Set(discovery?.sources.filter((source) => source.canImportNow).map((source) => source.client) ?? []);

  return (
    <div className="modal-backdrop easy-import-backdrop">
      <section className="modal-card easy-import-dialog" role="dialog" aria-modal="true" aria-labelledby={`${kind}-easy-import-title`}>
        <div className="easy-import-dialog-heading">
          <span><DataIcon size={29} aria-hidden="true" /></span>
          <div>
            <h2 id={`${kind}-easy-import-title`}>{contacts ? "Kontakte einfach importieren" : "Kalender einfach importieren"}</h2>
            <p>{contacts ? "Woher sollen die Kontakte kommen?" : "Woher sollen die Termine kommen?"}</p>
          </div>
          <button className="icon-only" type="button" aria-label="Schließen" onClick={onClose} disabled={busyPlatform !== null}>
            <X size={22} />
          </button>
        </div>

        {!result && !error && !connectedMode && (
          <>
            <div className="easy-import-platforms">
              <button type="button" onClick={() => startImport("outlook")} disabled={busyPlatform !== null}>
                <span className="easy-import-platform-icon outlook"><img src="/brands/outlook.svg" alt="" aria-hidden="true" /></span>
                <span><strong>Outlook Classic</strong><small>{busyPlatform === "outlook" ? "Wird importiert …" : "Auf diesem PC suchen"}</small></span>
                {busyPlatform === "outlook" && <LoaderCircle className="spin" size={23} />}
              </button>
              <button type="button" onClick={() => startImport("thunderbird")} disabled={busyPlatform !== null}>
                <span className="easy-import-platform-icon thunderbird"><img src="/brands/thunderbird.svg" alt="" aria-hidden="true" /></span>
                <span><strong>Thunderbird</strong><small>{busyPlatform === "thunderbird" ? "Wird importiert …" : "Auf diesem PC suchen"}</small></span>
                {busyPlatform === "thunderbird" && <LoaderCircle className="spin" size={23} />}
              </button>
            </div>
            <p className="easy-import-safe-note">Ein Klick startet den Import. Es wird nichts gelöscht.</p>
          </>
        )}

        {!result && !error && connectedMode && (
          <div className="connected-calendar-discovery">
            <button className="connected-calendar-back" type="button" onClick={() => setConnectedMode(false)} disabled={discoveryBusy || busyPlatform !== null}>
              <ArrowLeft size={18} /> Zurück
            </button>
            {discoveryBusy && (
              <div className="connected-calendar-loading" role="status">
                <LoaderCircle className="spin" size={30} />
                <strong>Verbundene Kalender werden gesucht …</strong>
                <span>Es werden nur Konten und Kalendernamen gelesen, keine Passwörter.</span>
              </div>
            )}
            {discoveryError && (
              <div className="connected-calendar-empty error" role="alert">
                <CircleAlert size={28} /><strong>Prüfung nicht möglich</strong><span>{discoveryError}</span>
                <button type="button" onClick={() => void scanConnectedCalendars()}><RefreshCw size={17} /> Erneut prüfen</button>
              </div>
            )}
            {discovery && !discoveryBusy && (
              <>
                <div className="connected-calendar-summary">
                  <div><strong>{discovery.sources.length} verbundene Kalender gefunden</strong><span>Termine können übernommen werden. Für die dauerhafte Verbindung ist je Anbieter einmalig eine sichere Anmeldung nötig.</span></div>
                  <LockKeyhole size={24} aria-hidden="true" />
                </div>
                {discovery.sources.length > 0 ? (
                  <ul className="connected-calendar-list">
                    {discovery.sources.map((source) => (
                      <li key={source.id}>
                        <span className={`connected-calendar-provider ${source.provider}`}><CloudCog size={20} /></span>
                        <span className="connected-calendar-name"><strong>{source.name}</strong><small>{source.providerLabel}{source.account ? ` · ${source.account}` : source.location ? ` · ${source.location}` : ""}</small></span>
                        <span className={`connected-calendar-mode ${source.connectionMode}`}>{source.connectionMode === "bidirectional" ? "Beide Richtungen" : source.connectionMode === "readOnly" ? "Nur lesen" : "Lokal"}</span>
                        <small className="connected-calendar-client">in {source.client === "outlook" ? "Outlook" : "Thunderbird"}</small>
                      </li>
                    ))}
                  </ul>
                ) : (
                  <div className="connected-calendar-empty"><CalendarDays size={28} /><strong>Keine Kalenderverbindung gefunden</strong><span>Sie können Outlook oder Thunderbird weiterhin direkt importieren.</span></div>
                )}
                {discovery.warnings.length > 0 && <p className="connected-calendar-warning">Ein nicht eingerichtetes Programm wurde übersprungen. Die gefundenen Kalender können trotzdem übernommen werden.</p>}
                <div className="connected-calendar-actions">
                  {importClients.has("outlook") && <button className="primary" type="button" onClick={() => void startImport("outlook")} disabled={busyPlatform !== null}>{busyPlatform === "outlook" ? <LoaderCircle className="spin" size={18} /> : null} Outlook-Kalender übernehmen</button>}
                  {importClients.has("thunderbird") && <button className="primary" type="button" onClick={() => void startImport("thunderbird")} disabled={busyPlatform !== null}>{busyPlatform === "thunderbird" ? <LoaderCircle className="spin" size={18} /> : null} Thunderbird-Kalender übernehmen</button>}
                  {onManageSync && discovery.sources.some((source) => source.provider === "microsoft365") && <button type="button" onClick={onManageSync} disabled={busyPlatform !== null}><CloudCog size={18} /> Exchange-Automatik verwalten</button>}
                </div>
                <p className="connected-calendar-privacy"><LockKeyhole size={15} /> Gespeicherte Passwörter, OAuth-Sitzungen und geheime Kalender-Links werden niemals angezeigt oder unbemerkt kopiert.</p>
              </>
            )}
          </div>
        )}

        {result && (
          <div className="easy-import-finished success" role="status">
            <CheckCircle2 size={42} />
            <h3>Import abgeschlossen</h3>
            <p>{result.detail}</p>
            <button className="primary large" type="button" onClick={onClose}>Fertig</button>
          </div>
        )}

        {error && (
          <div className="easy-import-finished error" role="alert">
            <CircleAlert size={42} />
            <h3>Import nicht möglich</h3>
            <p>{error}</p>
            <div className="button-row">
              <button className="primary" type="button" onClick={() => setError("")}>Erneut versuchen</button>
              <button type="button" onClick={onClose}>Abbrechen</button>
            </div>
          </div>
        )}
      </section>
    </div>
  );
}
