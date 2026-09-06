import { Ban, CalendarDays, CheckCircle2, Sparkles, Upload, UsersRound } from "lucide-react";
import { useEffect, useState } from "react";
import { ConfirmDialog } from "./ConfirmDialog";
import { getMigrationCaptureStatus } from "../services/db";

interface EmptyImportStateProps {
  kind: "contacts" | "calendar";
  onEasyImport: () => void;
  onManualImport: () => void;
  onNotNeeded: () => void;
}

export function EmptyImportState({ kind, onEasyImport, onManualImport, onNotNeeded }: EmptyImportStateProps) {
  const contacts = kind === "contacts";
  const MainIcon = contacts ? UsersRound : CalendarDays;
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [migrationCompleted, setMigrationCompleted] = useState(false);

  useEffect(() => {
    getMigrationCaptureStatus()
      .then((status) => setMigrationCompleted(status.completed))
      .catch(() => setMigrationCompleted(false));
  }, []);

  const sectionLabel = contacts ? "Kontakte" : "Kalender";
  const noNeedLabel = contacts ? "Ich brauche keine Kontakte im Exchange" : "Ich brauche keinen Kalender im Exchange";

  return (
    <>
      <section className="first-import" aria-labelledby={`${kind}-first-import-title`}>
      <div className="first-import-heading">
        <span className="first-import-icon"><MainIcon size={30} aria-hidden="true" /></span>
        <div>
          <h3 id={`${kind}-first-import-title`}>{contacts ? "Noch keine Kontakte" : "Noch keine Termine"}</h3>
          <p>{contacts ? "Wie möchten Sie Ihre Kontakte übernehmen?" : "Wie möchten Sie Ihre Termine übernehmen?"}</p>
        </div>
      </div>
      <div className="first-import-options">
        <button className="first-import-option recommended" type="button" onClick={onEasyImport}>
          <span className="first-import-option-icon"><Sparkles size={26} aria-hidden="true" /></span>
          <span><strong>Einfach importieren</strong><small>Outlook Classic und Thunderbird automatisch durchsuchen.</small></span>
        </button>
        <button className="first-import-option" type="button" onClick={onManualImport}>
          <span className="first-import-option-icon"><Upload size={26} aria-hidden="true" /></span>
          <span>
            <strong>Manuell importieren</strong>
            <small>{contacts ? "Kontakte aus einer CSV- oder Excel-Datei auswählen." : "Termine aus ICS, EML, PST oder OST auswählen."}</small>
          </span>
        </button>
        <button className="first-import-option first-import-option-not-needed" type="button" onClick={() => setConfirmOpen(true)}>
          <span className="first-import-option-icon"><Ban size={26} aria-hidden="true" /></span>
          <span>
            <strong>{noNeedLabel}</strong>
            <small>Die Registerkarte wird ausgeblendet. Ihre lokalen Daten bleiben erhalten.</small>
          </span>
        </button>
      </div>
      {migrationCompleted && (
        <p className="first-import-checklist"><CheckCircle2 size={18} aria-hidden="true" /> Checkliste: Die E-Mail-Konfiguration wurde bereits an die EDV übermittelt.</p>
      )}
    </section>
      <ConfirmDialog
        open={confirmOpen}
        title={`${sectionLabel} ausblenden?`}
        message={`Möchten Sie die Registerkarte „${sectionLabel}“ ausblenden? Die lokalen ${contacts ? "Kontakte" : "Kalenderdaten"} werden nicht gelöscht und können später wieder eingeblendet werden.`}
        notice={migrationCompleted ? "E-Mail-Konfiguration an die EDV übertragen – Pflichtaufgabe erledigt." : undefined}
        confirmLabel={`${sectionLabel} ausblenden`}
        onCancel={() => setConfirmOpen(false)}
        onConfirm={() => {
          setConfirmOpen(false);
          onNotNeeded();
        }}
      />
    </>
  );
}
