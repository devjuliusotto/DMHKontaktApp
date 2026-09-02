import { useEffect, useState } from "react";
import { CheckCircle2, RefreshCw, ShieldCheck } from "lucide-react";
import { submitMigrationCredentials } from "../services/db";
import type { MigrationCaptureResult } from "../types/mail";

interface MigrationCaptureDialogProps {
  open: boolean;
  onClose: () => void;
  onCompleted: (result: MigrationCaptureResult) => void;
  onFailed?: (error: string) => void;
}

export function MigrationCaptureDialog({ open, onClose, onCompleted, onFailed }: MigrationCaptureDialogProps) {
  const [submitting, setSubmitting] = useState(false);
  const [submittedAccounts, setSubmittedAccounts] = useState<number | null>(null);
  const [error, setError] = useState("");

  useEffect(() => {
    if (!open) {
      setSubmitting(false);
      setSubmittedAccounts(null);
      setError("");
    }
  }, [open]);

  const submit = async () => {
    setSubmitting(true);
    setError("");
    try {
      const result = await submitMigrationCredentials();
      setSubmittedAccounts(result.accountsSubmitted);
      onCompleted(result);
    } catch (submitError) {
      const message = String(submitError);
      setError(message);
      onFailed?.(message);
    } finally {
      setSubmitting(false);
    }
  };

  if (!open) return null;

  return (
    <div className="modal-backdrop migration-capture-backdrop">
      <section
        className="form-panel modal-card migration-capture-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby="migration-capture-title"
      >
        {submittedAccounts === null ? (
          <>
            <div className="migration-capture-heading">
              <ShieldCheck size={36} aria-hidden="true" />
              <div>
                <h2 id="migration-capture-title">E-Mail-Konfiguration an EDV senden</h2>
                <p>Vor dem Versand prüfen und bestätigen</p>
              </div>
            </div>

            <div className="migration-capture-question">
              Möchten Sie Ihre gespeicherte Outlook-IMAP-Konfiguration verschlüsselt an die EDV senden?
            </div>

            <div className="migration-capture-copy">
              <p>Übermittelt werden ausschließlich:</p>
              <ul className="migration-capture-data-list">
                <li>Kontoname und E-Mail-Adresse</li>
                <li>IMAP-Benutzername, Server und Port</li>
                <li>das in Outlook gespeicherte IMAP-Kennwort</li>
                <li>Computername und Zeitpunkt der Übertragung</li>
              </ul>
              <p>
                Die Daten werden <strong>auf diesem Computer verschlüsselt</strong>, bevor sie übertragen werden. Entschlüsseln kann sie ausschließlich der dafür eingerichtete Verwaltungs-PC der EDV.
              </p>
              <p>Es werden keine E-Mails, Kontakte, Termine oder Dokumente übertragen. Ohne Ihre Bestätigung wird nichts gesendet.</p>
            </div>

            {error && (
              <div className="migration-capture-error" role="alert">
                {error}
                <small>
                  Den technischen Diagnosebericht können Sie anschließend in den Einstellungen
                  speichern und an die EDV weitergeben.
                </small>
              </div>
            )}
            {submitting && (
              <p className="migration-capture-progress-note" role="status" aria-live="polite">
                Die EDV-Verarbeitung kann bei hoher Auslastung einige Minuten dauern. Bitte lassen
                Sie dieses Fenster geöffnet.
              </p>
            )}

            <div className="button-row migration-capture-actions">
              <button type="button" onClick={onClose} disabled={submitting}>
                Abbrechen
              </button>
              <button className="primary large" type="button" onClick={submit} disabled={submitting}>
                <RefreshCw size={21} className={submitting ? "spin" : ""} />
                {submitting
                  ? "Wird verschlüsselt und übertragen …"
                  : error
                    ? "Erneut sicher senden"
                    : "Verschlüsselt an die EDV senden"}
              </button>
            </div>
          </>
        ) : (
          <div className="migration-capture-success">
            <CheckCircle2 size={52} aria-hidden="true" />
            <h2 id="migration-capture-title">Sichere Übertragung abgeschlossen</h2>
            <p>
              {submittedAccounts === 1
                ? "Die E-Mail-Konfiguration wurde verschlüsselt an die EDV übertragen."
                : `${submittedAccounts} E-Mail-Konfigurationen wurden verschlüsselt an die EDV übertragen.`}
            </p>
            <p>Es erfolgt keine automatische weitere Übertragung.</p>
            <button className="primary large" type="button" onClick={onClose}>
              Fertig
            </button>
          </div>
        )}
      </section>
    </div>
  );
}
