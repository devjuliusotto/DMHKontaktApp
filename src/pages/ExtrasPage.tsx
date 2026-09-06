import { CalendarDays, CheckCircle2, ChevronRight, Circle, CircleAlert, RotateCcw, Send, ShieldCheck, UsersRound } from "lucide-react";
import { useEffect, useState } from "react";
import { MigrationCaptureDialog } from "../components/MigrationCaptureDialog";
import { getMigrationCaptureStatus } from "../services/db";
import type { MigrationCaptureResult, MigrationCaptureStatus } from "../types/mail";
import { dataSectionVisibilityChangedEventName, readHiddenDataSections, setDataSectionHidden, type DataSection } from "../utils/dataSectionVisibility";

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
  const [hiddenDataSections, setHiddenDataSections] = useState<DataSection[]>(readHiddenDataSections);

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

  useEffect(() => {
    const updateHiddenSections = () => setHiddenDataSections(readHiddenDataSections());
    window.addEventListener(dataSectionVisibilityChangedEventName, updateHiddenSections);
    return () => window.removeEventListener(dataSectionVisibilityChangedEventName, updateHiddenSections);
  }, []);

  const migrationCompleted = (result: MigrationCaptureResult) => {
    setMigrationStatus({ configured: true, completed: true, completedAt: result.completedAt });
    setMigrationStatusUnknown(false);
    setMigrationError("");
  };

  const sentAt = formatSentAt(migrationStatus?.completedAt ?? null);
  const migrationCompletedAlready = migrationStatus?.completed === true;
  const migrationDefinitelyUnavailable = migrationStatus !== null && !migrationStatus.configured;
  const checklistItems = [
    { label: "E-Mail-Konfiguration an die EDV übertragen", completed: migrationCompletedAlready },
    ...hiddenDataSections.map((section) => ({
      label: section === "contacts" ? "Kontakte im Exchange nicht benötigt" : "Kalender im Exchange nicht benötigt",
      completed: true
    }))
  ];
  const checklistComplete = checklistItems.length > 1 && checklistItems.every((item) => item.completed);
  const sectionDetails = [
    { key: "contacts" as const, label: "Kontakte", icon: UsersRound },
    { key: "calendar" as const, label: "Kalender", icon: CalendarDays }
  ];
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

      {hiddenDataSections.length > 0 && (
        <section className="extras-checklist-card form-panel" aria-labelledby="extras-checklist-title">
          <div className="extras-checklist-heading">
            <div>
              <h3 id="extras-checklist-title">Abschluss-Checkliste</h3>
              <p>Die für diese Auswahl nötigen Aufgaben werden hier dokumentiert.</p>
            </div>
            {checklistComplete && <span className="extras-checklist-complete"><CheckCircle2 size={18} /> Erledigt</span>}
          </div>
          <ul className="extras-checklist-list">
            {checklistItems.map((item) => (
              <li className={item.completed ? "completed" : ""} key={item.label}>
                {item.completed ? <CheckCircle2 size={18} aria-hidden="true" /> : <Circle size={18} aria-hidden="true" />}
                <span>{item.label}</span>
              </li>
            ))}
          </ul>
          <div className="extras-hidden-sections">
            <strong>Ausgeblendete Registerkarten</strong>
            {sectionDetails.filter((section) => hiddenDataSections.includes(section.key)).map(({ key, label, icon: Icon }) => (
              <div className="extras-hidden-section" key={key}>
                <span><Icon size={17} /> {label}</span>
                <button type="button" onClick={() => setDataSectionHidden(key, false)}><RotateCcw size={16} /> Wieder einblenden</button>
              </div>
            ))}
          </div>
        </section>
      )}

      <MigrationCaptureDialog
        open={migrationDialogOpen}
        onClose={() => setMigrationDialogOpen(false)}
        onCompleted={migrationCompleted}
        onFailed={(error) => setMigrationError(`Übertragung fehlgeschlagen: ${error}`)}
      />
    </div>
  );
}
