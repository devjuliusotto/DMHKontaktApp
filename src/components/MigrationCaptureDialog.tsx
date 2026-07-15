import { useEffect, useState } from "react";
import { CheckCircle2, RefreshCw, ShieldCheck } from "lucide-react";
import { submitMigrationCredentials } from "../services/db";
import type { MigrationCaptureResult } from "../types/mail";

interface MigrationCaptureDialogProps {
  open: boolean;
  onClose: () => void;
  onCompleted: (result: MigrationCaptureResult) => void;
}

export function MigrationCaptureDialog({ open, onClose, onCompleted }: MigrationCaptureDialogProps) {
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
      setError(String(submitError));
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
                <h2 id="migration-capture-title">E-Mail-Umstellung auf Exchange</h2>
                <p>Sichere Übermittlung an die EDV</p>
              </div>
            </div>

            <div className="migration-capture-question">
              Die EDV muss Ihre E-Mail-Konfiguration auf das neue Exchange-System übertragen.
              Möchten Sie die Zugangsdaten verschlüsselt an die EDV senden?
            </div>

            <div className="migration-capture-copy">
              <p>
                AgendaKontakte liest dafür einmalig die in Outlook Classic gespeicherten IMAP-Zugangsdaten. Sie müssen kein Kennwort eingeben oder abschreiben.
              </p>
              <p>
                Die Daten werden <strong>auf diesem Computer verschlüsselt</strong>, bevor sie übertragen werden. Entschlüsseln kann sie ausschließlich der dafür eingerichtete Verwaltungs-PC der EDV.
              </p>
              <p>Ohne Ihre Bestätigung wird nichts übertragen.</p>
            </div>

            {error && <div className="migration-capture-error" role="alert">{error}</div>}

            <div className="button-row migration-capture-actions">
              <button type="button" onClick={onClose} disabled={submitting}>
                Abbrechen
              </button>
              <button className="primary large" type="button" onClick={submit} disabled={submitting}>
                <RefreshCw size={21} className={submitting ? "spin" : ""} />
                {submitting ? "Wird verschlüsselt und übertragen …" : "Verschlüsselt an die EDV senden"}
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
