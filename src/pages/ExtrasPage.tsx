import { CheckCircle2, ChevronRight, CircleAlert, Send, ShieldCheck } from "lucide-react";
import { useEffect, useState } from "react";
import { MigrationCaptureDialog } from "../components/MigrationCaptureDialog";
import { getMigrationCaptureStatus } from "../services/db";
import type { MigrationCaptureResult, MigrationCaptureStatus } from "../types/mail";

function formatSentAt(value: string | null): string | null {
  if (!value) return null;
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return null;
  return new Intl.DateTimeFormat("de-DE", { dateStyle: "medium", timeStyle: "short" }).format(date);
}

export function ExtrasPage() {
  const [migrationStatus, setMigrationStatus] = useState<MigrationCaptureStatus | null>(null);
  const [migrationStatusUnknown, setMigrationStatusUnknown] = useState(false);
  const [migrationDialogOpen, setMigrationDialogOpen] = useState(false);
  const [migrationError, setMigrationError] = useState("");

  useEffect(() => {
    getMigrationCaptureStatus()
      .then((status) => {
        setMigrationStatus(status);
        setMigrationStatusUnknown(false);
      })
      .catch(() => {
        setMigrationStatus(null);
        setMigrationStatusUnknown(true);
      });
  }, []);

  const migrationCompleted = (result: MigrationCaptureResult) => {
    setMigrationStatus({ configured: true, completed: true, completedAt: result.completedAt });
    setMigrationStatusUnknown(false);
    setMigrationError("");
  };

  const sentAt = formatSentAt(migrationStatus?.completedAt ?? null);
  const migrationCompletedAlready = migrationStatus?.completed === true;
  const migrationDefinitelyUnavailable = migrationStatus !== null && !migrationStatus.configured;
  return (
    <div className="page extras-page">
      <header className="page-header">
        <div>
          <h2>E-Mail-Konfiguration</h2>
          <p>E-Mail-Zugang sicher an die EDV senden.</p>
        </div>
      </header>

      <div className="extras-actions">
        <section className="extras-action-card extras-edv-card">
          <div className="extras-action-main">
            <span className="extras-action-icon secure"><ShieldCheck size={34} aria-hidden="true" /></span>
            <div className="extras-action-copy">
              <h3>E-Mail-Zugang an die EDV senden</h3>
              <p>Sicher verschlüsselt. Sie bestätigen vor dem Versand.</p>
              {migrationCompletedAlready && (
                <p className="extras-send-state success"><CheckCircle2 size={18} /> {sentAt ? `Gesendet am ${sentAt}` : "Erfolgreich gesendet"}</p>
              )}
              {!migrationCompletedAlready && migrationStatus === null && !migrationStatusUnknown && (
                <p className="extras-send-state">Status wird geprüft …</p>
              )}
              {migrationStatusUnknown && (
                <p className="extras-send-state">Erneuter Versand ist möglich.</p>
              )}
              {migrationDefinitelyUnavailable && (
                <p className="extras-send-state error"><CircleAlert size={18} /> Nicht eingerichtet</p>
              )}
            </div>
            <button
              className="primary large extras-action-button"
              type="button"
              onClick={() => setMigrationDialogOpen(true)}
              disabled={migrationCompletedAlready || migrationDefinitelyUnavailable}
            >
              {migrationCompletedAlready ? <CheckCircle2 size={22} /> : <Send size={22} />}
              <span>{migrationCompletedAlready ? "Bereits gesendet" : "Sicher senden"}</span>
              {!migrationCompletedAlready && <ChevronRight size={22} aria-hidden="true" />}
            </button>
          </div>

          {migrationError && <p className="extras-inline-error" role="alert">{migrationError}</p>}
        </section>
      </div>

      <MigrationCaptureDialog
        open={migrationDialogOpen}
        onClose={() => setMigrationDialogOpen(false)}
        onCompleted={migrationCompleted}
        onFailed={(error) => setMigrationError(`Übertragung fehlgeschlagen: ${error}`)}
      />
    </div>
  );
}
