import { ArrowLeft, CalendarDays, Check, CheckCircle2, ChevronRight, CircleAlert, Download, LoaderCircle, Send, ShieldCheck, UsersRound } from "lucide-react";
import { useEffect, useState } from "react";
import { MigrationCaptureDialog } from "../components/MigrationCaptureDialog";
import { getMigrationCaptureStatus } from "../services/db";
import type { MigrationCaptureResult, MigrationCaptureStatus } from "../types/mail";
import { easyImport, type EasyImportKind, type EasyImportPlatform } from "../utils/easyImport";

type ImportStepStatus = "idle" | "running" | "success" | "error";

interface ImportStep {
  id: "outlook-contacts" | "outlook-calendar" | "thunderbird-contacts" | "thunderbird-calendar";
  label: string;
  status: ImportStepStatus;
  detail: string;
}

const initialImportSteps: ImportStep[] = [
  { id: "outlook-contacts", label: "Outlook-Kontakte", status: "idle", detail: "Noch nicht geprüft" },
  { id: "outlook-calendar", label: "Outlook-Kalender", status: "idle", detail: "Noch nicht geprüft" },
  { id: "thunderbird-contacts", label: "Thunderbird-Kontakte", status: "idle", detail: "Noch nicht geprüft" },
  { id: "thunderbird-calendar", label: "Thunderbird-Kalender", status: "idle", detail: "Noch nicht geprüft" }
];

function formatSentAt(value: string | null): string | null {
  if (!value) return null;
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return null;
  return new Intl.DateTimeFormat("de-DE", { dateStyle: "medium", timeStyle: "short" }).format(date);
}

export function ExtrasPage() {
  const [steps, setSteps] = useState<ImportStep[]>(initialImportSteps);
  const [importViewOpen, setImportViewOpen] = useState(false);
  const [selectedPlatform, setSelectedPlatform] = useState<EasyImportPlatform | null>(null);
  const [selectedDataType, setSelectedDataType] = useState<EasyImportKind | null>(null);
  const [importBusy, setImportBusy] = useState(false);
  const [importFinished, setImportFinished] = useState(false);
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

  const updateStep = (id: ImportStep["id"], status: ImportStepStatus, detail: string) => {
    setSteps((current) => current.map((step) => step.id === id ? { ...step, status, detail } : step));
  };

  const executeStep = async (id: ImportStep["id"], task: () => Promise<string>) => {
    updateStep(id, "running", "Wird gesucht und importiert …");
    try {
      updateStep(id, "success", await task());
    } catch (error) {
      updateStep(id, "error", String(error));
    }
  };

  const startSelectedImport = async () => {
    if (!selectedPlatform || !selectedDataType) return;

    setImportBusy(true);
    setImportFinished(false);
    setSteps(initialImportSteps);

    const stepId: ImportStep["id"] = `${selectedPlatform}-${selectedDataType}`;

    await executeStep(stepId, async () => (await easyImport(selectedDataType, selectedPlatform)).detail);

    setImportBusy(false);
    setImportFinished(true);
  };

  const migrationCompleted = (result: MigrationCaptureResult) => {
    setMigrationStatus({ configured: true, completed: true, completedAt: result.completedAt });
    setMigrationStatusUnknown(false);
    setMigrationError("");
  };

  const sentAt = formatSentAt(migrationStatus?.completedAt ?? null);
  const migrationCompletedAlready = migrationStatus?.completed === true;
  const migrationDefinitelyUnavailable = migrationStatus !== null && !migrationStatus.configured;
  const selectedStepId = selectedPlatform && selectedDataType ? `${selectedPlatform}-${selectedDataType}` as ImportStep["id"] : null;
  const selectedStep = selectedStepId ? steps.find((step) => step.id === selectedStepId) : null;

  const selectPlatform = (platform: EasyImportPlatform) => {
    if (importBusy) return;
    setSelectedPlatform(platform);
    setImportFinished(false);
    setSteps(initialImportSteps);
  };

  const selectDataType = (dataType: EasyImportKind) => {
    if (importBusy) return;
    setSelectedDataType(dataType);
    setImportFinished(false);
    setSteps(initialImportSteps);
  };

  if (importViewOpen) {
    return (
      <div className="page extras-page extras-import-page">
        <header className="page-header extras-import-page-header">
          <button className="extras-back-button" type="button" onClick={() => setImportViewOpen(false)} disabled={importBusy}>
            <ArrowLeft size={21} /> Zurück zu Extras
          </button>
          <div>
            <h2>Daten importieren</h2>
            <p>Wählen Sie die Quelle und die gewünschten Daten.</p>
          </div>
        </header>

        <div className="extras-import-wizard">
          <section className="extras-choice-section" aria-labelledby="import-platform-title">
            <div className="extras-choice-heading">
              <span>1</span>
              <div>
                <h3 id="import-platform-title">Woher kommen die Daten?</h3>
                <p>Wählen Sie ein Programm.</p>
              </div>
            </div>
            <div className="extras-choice-grid">
              <button className={selectedPlatform === "outlook" ? "extras-choice active" : "extras-choice"} type="button" onClick={() => selectPlatform("outlook")} disabled={importBusy}>
                <span className="extras-choice-icon outlook"><img src="/brands/outlook.svg" alt="" aria-hidden="true" /></span>
                <span><strong>Outlook Classic</strong><small>Microsoft Outlook auf diesem PC</small></span>
                {selectedPlatform === "outlook" && <CheckCircle2 size={24} className="extras-choice-check" />}
              </button>
              <button className={selectedPlatform === "thunderbird" ? "extras-choice active" : "extras-choice"} type="button" onClick={() => selectPlatform("thunderbird")} disabled={importBusy}>
                <span className="extras-choice-icon thunderbird"><img src="/brands/thunderbird.svg" alt="" aria-hidden="true" /></span>
                <span><strong>Thunderbird</strong><small>Mozilla Thunderbird auf diesem PC</small></span>
                {selectedPlatform === "thunderbird" && <CheckCircle2 size={24} className="extras-choice-check" />}
              </button>
            </div>
          </section>

          <section className={selectedPlatform ? "extras-choice-section" : "extras-choice-section disabled"} aria-labelledby="import-data-title">
            <div className="extras-choice-heading">
              <span>2</span>
              <div>
                <h3 id="import-data-title">Was möchten Sie importieren?</h3>
                <p>Wählen Sie Kontakte oder Kalender.</p>
              </div>
            </div>
            <div className="extras-choice-grid">
              <button className={selectedDataType === "contacts" ? "extras-choice active" : "extras-choice"} type="button" onClick={() => selectDataType("contacts")} disabled={!selectedPlatform || importBusy}>
                <span className="extras-choice-icon contacts"><UsersRound size={30} /></span>
                <span><strong>Kontakte</strong><small>Adressen und Verteilerlisten</small></span>
                {selectedDataType === "contacts" && <CheckCircle2 size={24} className="extras-choice-check" />}
              </button>
              <button className={selectedDataType === "calendar" ? "extras-choice active" : "extras-choice"} type="button" onClick={() => selectDataType("calendar")} disabled={!selectedPlatform || importBusy}>
                <span className="extras-choice-icon calendar"><CalendarDays size={30} /></span>
                <span><strong>Kalender</strong><small>Termine und Besprechungen</small></span>
                {selectedDataType === "calendar" && <CheckCircle2 size={24} className="extras-choice-check" />}
              </button>
            </div>
          </section>

          <section className="extras-import-start-panel">
            <div>
              <strong>{selectedPlatform && selectedDataType
                ? `${selectedPlatform === "outlook" ? "Outlook Classic" : "Thunderbird"} → ${selectedDataType === "contacts" ? "Kontakte" : "Kalender"}`
                : "Bitte treffen Sie beide Auswahlen."}</strong>
              <small>Nichts wird aus dem gewählten Programm gelöscht.</small>
            </div>
            <button className="primary large" type="button" onClick={startSelectedImport} disabled={!selectedPlatform || !selectedDataType || importBusy}>
              {importBusy ? <LoaderCircle className="spin" size={22} /> : <Download size={22} />}
              {importBusy ? "Import läuft …" : importFinished ? "Erneut importieren" : "Import starten"}
            </button>
          </section>

          {(importBusy || importFinished) && selectedStep && (
            <div className={`extras-import-result ${selectedStep.status}`} role="status" aria-live="polite">
              {selectedStep.status === "running" && <LoaderCircle className="spin" size={25} />}
              {selectedStep.status === "success" && <CheckCircle2 size={25} />}
              {selectedStep.status === "error" && <CircleAlert size={25} />}
              <span><strong>{selectedStep.status === "running" ? "Import wird durchgeführt" : selectedStep.status === "success" ? "Import abgeschlossen" : "Import nicht möglich"}</strong><small>{selectedStep.detail}</small></span>
            </div>
          )}
        </div>
      </div>
    );
  }

  return (
    <div className="page extras-page">
      <header className="page-header">
        <div>
          <h2>Extras</h2>
          <p>Was möchten Sie tun?</p>
        </div>
      </header>

      <div className="extras-actions">
        <section className="extras-action-card extras-import-card">
          <div className="extras-action-main">
            <span className="extras-action-icon"><Download size={34} aria-hidden="true" /></span>
            <div className="extras-action-copy">
              <h3>Einfach importieren</h3>
              <p>Kontakte und Termine aus Outlook oder Thunderbird.</p>
              <div className="extras-data-pills" aria-label="Importierte Daten">
                <span><UsersRound size={17} /> Kontakte</span>
                <span><CalendarDays size={17} /> Termine</span>
              </div>
            </div>
            <button className="primary large extras-action-button" type="button" onClick={() => setImportViewOpen(true)}>
              <Download size={22} />
              <span>Import starten</span>
              <ChevronRight size={22} aria-hidden="true" />
            </button>
          </div>

          <div className="extras-reassurance">
            <span><Check size={17} /> Nichts wird gelöscht</span>
            <span><Check size={17} /> Sie wählen Quelle und Daten</span>
          </div>
        </section>

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
