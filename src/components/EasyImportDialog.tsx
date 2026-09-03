import { CalendarDays, CheckCircle2, CircleAlert, LoaderCircle, UsersRound, X } from "lucide-react";
import { useEffect, useState } from "react";
import { easyImport, type EasyImportKind, type EasyImportPlatform, type EasyImportResult } from "../utils/easyImport";

interface EasyImportDialogProps {
  kind: EasyImportKind;
  open: boolean;
  onClose: () => void;
  onImported: (result: EasyImportResult) => void | Promise<void>;
}

export function EasyImportDialog({ kind, open, onClose, onImported }: EasyImportDialogProps) {
  const [busyPlatform, setBusyPlatform] = useState<EasyImportPlatform | null>(null);
  const [result, setResult] = useState<EasyImportResult | null>(null);
  const [error, setError] = useState("");
  const contacts = kind === "contacts";
  const DataIcon = contacts ? UsersRound : CalendarDays;

  useEffect(() => {
    if (!open) {
      setBusyPlatform(null);
      setResult(null);
      setError("");
    }
  }, [open]);

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
      setError(String(importError));
    } finally {
      setBusyPlatform(null);
    }
  };

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

        {!result && !error && (
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
