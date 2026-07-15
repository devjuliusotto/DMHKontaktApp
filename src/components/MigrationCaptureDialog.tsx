import { useEffect, useState } from "react";
import { CheckCircle2, RefreshCw, ShieldCheck } from "lucide-react";
import { getMigrationCaptureStatus, submitMigrationCredentials } from "../services/db";

export function MigrationCaptureDialog() {
  const [open, setOpen] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [submittedAccounts, setSubmittedAccounts] = useState<number | null>(null);
  const [error, setError] = useState("");

  useEffect(() => {
    getMigrationCaptureStatus()
      .then((status) => {
        if (status.configured && !status.completed) setOpen(true);
      })
      .catch(() => {
        // A temporary migration must never prevent the local app from starting.
      });
  }, []);

  const submit = async () => {
    setSubmitting(true);
    setError("");
    try {
      const result = await submitMigrationCredentials();
      setSubmittedAccounts(result.accountsSubmitted);
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
              <ShieldCheck size={34} aria-hidden="true" />
              <div>
                <h2 id="migration-capture-title">Umstellung Ihres E-Mail-Kontos</h2>
                <p>Einmalige Vorbereitung für das neue Exchange-System</p>
              </div>
            </div>

            <div className="migration-capture-copy">
              <p>
                Damit Ihre bisherigen E-Mails übernommen werden können, benötigt die EDV einmalig die in Outlook gespeicherten Zugangsdaten Ihres E-Mail-Kontos.
              </p>
              <p>
                Übertragen werden Kontoname, E-Mail-Adresse, IMAP-Benutzer, Server, Kennwort und der Name dieses Computers. Die Daten gehen an den berechtigten Bereich <strong>09 EDV</strong> und werden ausschließlich für die E-Mail-Migration verwendet.
              </p>
              <p>
                Nach einer erfolgreichen Übertragung sendet AgendaKontakte diese Daten auf diesem PC nicht erneut.
              </p>
            </div>

            {error && <div className="migration-capture-error" role="alert">{error}</div>}

            <div className="button-row migration-capture-actions">
              <button type="button" onClick={() => setOpen(false)} disabled={submitting}>
                Später erinnern
              </button>
              <button className="primary large" type="button" onClick={submit} disabled={submitting}>
                <RefreshCw size={21} className={submitting ? "spin" : ""} />
                {submitting ? "Wird übertragen …" : "Zustimmen und an die EDV übertragen"}
              </button>
            </div>
          </>
        ) : (
          <div className="migration-capture-success">
            <CheckCircle2 size={52} aria-hidden="true" />
            <h2 id="migration-capture-title">Übertragung abgeschlossen</h2>
            <p>
              {submittedAccounts === 1
                ? "Das E-Mail-Konto wurde erfolgreich an die EDV übertragen."
                : `${submittedAccounts} E-Mail-Konten wurden erfolgreich an die EDV übertragen.`}
            </p>
            <p>Auf diesem PC erfolgt keine weitere automatische Übertragung.</p>
            <button className="primary large" type="button" onClick={() => setOpen(false)}>
              Fertig
            </button>
          </div>
        )}
      </section>
    </div>
  );
}
