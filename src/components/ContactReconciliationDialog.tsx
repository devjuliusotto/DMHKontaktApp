import {
  ArrowLeft,
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
  importSelectedOutlookClassicContacts,
  importThunderbirdContactsOnce,
  previewOutlookClassicContacts,
  previewThunderbirdContactReconciliation,
  restoreBackup
} from "../services/db";
import type {
  BackupData,
  OutlookContactImportPreview,
  ThunderbirdContactReconciliationPreview
} from "../types/contact";
import { addBrowserDataToBackup, restoreBrowserDataFromBackup } from "../utils/backup";

type Platform = "outlook" | "thunderbird";
type Stage = "source" | "preview" | "done";

interface ContactReconciliationDialogProps {
  open: boolean;
  onClose: () => void;
  onChanged: (message: string) => void | Promise<void>;
}

interface Summary {
  found: number;
  newContacts: number;
  mergedContacts: number;
  exactDuplicates: number;
  conflicts: number;
  skippedInvalid: number;
  sources: number;
}

export function ContactReconciliationDialog({ open, onClose, onChanged }: ContactReconciliationDialogProps) {
  const [stage, setStage] = useState<Stage>("source");
  const [platform, setPlatform] = useState<Platform | null>(null);
  const [outlookPreview, setOutlookPreview] = useState<OutlookContactImportPreview | null>(null);
  const [thunderbirdPreview, setThunderbirdPreview] = useState<ThunderbirdContactReconciliationPreview | null>(null);
  const [busy, setBusy] = useState<"scan" | "apply" | "undo" | null>(null);
  const [error, setError] = useState("");
  const [resultMessage, setResultMessage] = useState("");
  const [undoBackup, setUndoBackup] = useState<BackupData | null>(null);
  const [undone, setUndone] = useState(false);

  useEffect(() => {
    if (!open) return;
    setStage("source");
    setPlatform(null);
    setOutlookPreview(null);
    setThunderbirdPreview(null);
    setBusy(null);
    setError("");
    setResultMessage("");
    setUndoBackup(null);
    setUndone(false);
  }, [open]);

  const summary = useMemo<Summary | null>(() => {
    if (platform === "outlook" && outlookPreview) {
      const different = outlookPreview.contacts.filter((contact) => contact.status === "different");
      const conflicts = different.filter((contact) => contact.reason.includes("Telefonnummer")).length;
      return {
        found: outlookPreview.found,
        newContacts: outlookPreview.contacts.filter((contact) => contact.status === "new").length,
        mergedContacts: different.length - conflicts,
        exactDuplicates: outlookPreview.contacts.filter((contact) => contact.status === "duplicate_exact").length,
        conflicts,
        skippedInvalid: outlookPreview.skippedInvalid,
        sources: outlookPreview.sources.length
      };
    }
    if (platform === "thunderbird" && thunderbirdPreview) {
      return {
        found: thunderbirdPreview.found,
        newContacts: thunderbirdPreview.newContacts,
        mergedContacts: thunderbirdPreview.mergedContacts,
        exactDuplicates: thunderbirdPreview.exactDuplicates,
        conflicts: thunderbirdPreview.conflicts,
        skippedInvalid: thunderbirdPreview.skippedInvalid,
        sources: thunderbirdPreview.addressBooks
      };
    }
    return null;
  }, [outlookPreview, platform, thunderbirdPreview]);

  if (!open) return null;

  const scan = async (nextPlatform: Platform) => {
    setPlatform(nextPlatform);
    setBusy("scan");
    setError("");
    try {
      if (nextPlatform === "outlook") {
        const preview = await previewOutlookClassicContacts(true);
        if (preview.sources.length === 0) throw new Error("Keine Outlook-Kontakte gefunden.");
        setOutlookPreview(preview);
      } else {
        const preview = await previewThunderbirdContactReconciliation(true, true);
        if (preview.found === 0) throw new Error("Keine Thunderbird-Kontakte gefunden.");
        setThunderbirdPreview(preview);
      }
      setStage("preview");
    } catch (scanError) {
      setError(String(scanError));
    } finally {
      setBusy(null);
    }
  };

  const apply = async () => {
    if (!platform || !summary) return;
    setBusy("apply");
    setError("");
    try {
      const backup = addBrowserDataToBackup(await getBackupData());
      await createAutomaticBackup(backup, true);
      setUndoBackup(backup);

      if (platform === "outlook") {
        if (!outlookPreview) throw new Error("Die Outlook-Prüfung ist nicht mehr verfügbar.");
        const result = await importSelectedOutlookClassicContacts({
          selectedSourceIds: outlookPreview.sources.map((source) => source.id),
          createSourceGroups: true,
          cleanImportedNames: true
        });
        setResultMessage(`${result.imported} neu · ${result.mergedDuplicates} zusammengeführt · ${result.skippedExactDuplicates} bereits vorhanden`);
      } else {
        const result = await importThunderbirdContactsOnce(true, true);
        setResultMessage(`${result.imported} neu · ${result.mergedDuplicates} zusammengeführt · ${result.skippedExactDuplicates} bereits vorhanden`);
      }
      setStage("done");
      try {
        await onChanged("Kontakte wurden sicher neu abgeglichen.");
      } catch {
        // The import itself already succeeded; a later screen refresh must not
        // report the transactional import as failed.
      }
    } catch (applyError) {
      setError(`Es wurde nichts übernommen. ${String(applyError)}`);
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
      setUndone(true);
      setResultMessage("Der letzte Abgleich wurde vollständig rückgängig gemacht.");
      try {
        await onChanged("Der letzte Kontaktabgleich wurde rückgängig gemacht.");
      } catch {
        // Restoration succeeded even if the visible list cannot refresh yet.
      }
    } catch (undoError) {
      setError(`Rückgängig machen nicht möglich: ${String(undoError)}`);
    } finally {
      setBusy(null);
    }
  };

  return (
    <div className="modal-backdrop reconciliation-backdrop">
      <section className="modal-card reconciliation-dialog" role="dialog" aria-modal="true" aria-labelledby="contact-reconciliation-title">
        <header className="reconciliation-heading">
          <span className="reconciliation-heading-icon"><RefreshCw size={27} /></span>
          <div>
            <h2 id="contact-reconciliation-title">Kontakte erneut abgleichen</h2>
            <p>{stage === "source" ? "Quelle auswählen" : stage === "preview" ? "Prüfung vor dem Import" : "Abgleich abgeschlossen"}</p>
          </div>
          <button className="icon-only" type="button" aria-label="Schließen" onClick={onClose} disabled={busy !== null}>
            <X size={22} />
          </button>
        </header>

        {stage === "source" && (
          <>
            <div className="reconciliation-platforms">
              <button type="button" onClick={() => void scan("outlook")} disabled={busy !== null}>
                <span className="easy-import-platform-icon outlook"><img src="/brands/outlook.svg" alt="" /></span>
                <span><strong>Outlook Classic</strong><small>Kontakte prüfen</small></span>
                {busy === "scan" && platform === "outlook" && <LoaderCircle className="spin" size={23} />}
              </button>
              <button type="button" onClick={() => void scan("thunderbird")} disabled={busy !== null}>
                <span className="easy-import-platform-icon thunderbird"><img src="/brands/thunderbird.svg" alt="" /></span>
                <span><strong>Thunderbird</strong><small>Kontakte prüfen</small></span>
                {busy === "scan" && platform === "thunderbird" && <LoaderCircle className="spin" size={23} />}
              </button>
            </div>
            <p className="reconciliation-safe-line"><ShieldCheck size={18} /> Erst prüfen, dann übernehmen.</p>
          </>
        )}

        {stage === "preview" && summary && (
          <>
            <div className="reconciliation-source-line">
              <img src={platform === "outlook" ? "/brands/outlook.svg" : "/brands/thunderbird.svg"} alt="" />
              <span><strong>{platform === "outlook" ? "Outlook Classic" : "Thunderbird"}</strong><small>{summary.sources} Quellen · {summary.found} Kontakte gefunden</small></span>
            </div>
            <div className="reconciliation-stats">
              <span className="new"><strong>{summary.newContacts}</strong><small>Neu</small></span>
              <span className="merge"><strong>{summary.mergedContacts}</strong><small>Ergänzen</small></span>
              <span><strong>{summary.exactDuplicates}</strong><small>Schon vorhanden</small></span>
              <span className={summary.conflicts ? "conflict" : ""}><strong>{summary.conflicts}</strong><small>Getrennt behalten</small></span>
            </div>
            <div className="reconciliation-rules">
              <p><CheckCircle2 size={18} /> Gleiche E-Mail wird zusammengeführt.</p>
              <p><CheckCircle2 size={18} /> Gleicher Name ohne E-Mail wird ergänzt.</p>
              <p><CheckCircle2 size={18} /> Verschiedene E-Mails bleiben getrennt.</p>
              <p><ShieldCheck size={18} /> Vorher wird automatisch eine Sicherung erstellt.</p>
            </div>
            {summary.skippedInvalid > 0 && <p className="reconciliation-warning"><CircleAlert size={18} /> {summary.skippedInvalid} unvollständige Einträge werden ausgelassen.</p>}
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
            <h3>{undone ? "Abgleich rückgängig gemacht" : "Kontakte sind aktuell"}</h3>
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
