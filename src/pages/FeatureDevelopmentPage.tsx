import { AlertTriangle, ArchiveRestore, Files, KeyRound, RotateCcw, ShieldCheck, Trash2 } from "lucide-react";
import { useState, type ReactNode } from "react";
import { StatusMessage } from "../components/StatusMessage";
import {
  createAutomaticBackup,
  getBackupData,
  resetLocalAppData,
  restartApp,
  restoreAutomaticBackup
} from "../services/db";
import { addBrowserDataToBackup, restoreBrowserDataFromBackup } from "../utils/backup";
import type { AppFeature, AppFeatureAvailability } from "../utils/featureFlags";
import { releaseFeatureDefaults } from "../utils/featureFlags";

interface FeatureDevelopmentPageProps {
  availability: AppFeatureAvailability;
  onFeatureChange: (feature: AppFeature, enabled: boolean) => void;
  onReset: () => void;
}

interface FeatureToggleCardProps {
  checked: boolean;
  description: string;
  descriptionId: string;
  icon: ReactNode;
  onChange: () => void;
  title: string;
}

function FeatureToggleCard({ checked, description, descriptionId, icon, onChange, title }: FeatureToggleCardProps) {
  return (
    <article className="form-panel feature-toggle-card">
      <span className="feature-toggle-icon">{icon}</span>
      <div className="feature-toggle-copy">
        <div className="feature-toggle-title">
          <h3>{title}</h3>
          <span className={checked ? "feature-status active" : "feature-status"}>
            {checked ? "Auf diesem PC aktiv" : "Nicht aktiv"}
          </span>
        </div>
        <p id={descriptionId}>{description}</p>
      </div>
      <label className="feature-switch">
        <input aria-describedby={descriptionId} checked={checked} onChange={onChange} type="checkbox" />
        <span aria-hidden="true" />
        <strong>{checked ? "Aktiv" : "Aus"}</strong>
      </label>
    </article>
  );
}

export function FeatureDevelopmentPage({ availability, onFeatureChange, onReset }: FeatureDevelopmentPageProps) {
  const [busyAction, setBusyAction] = useState<string | null>(null);
  const [message, setMessage] = useState("");
  const [messageType, setMessageType] = useState<"success" | "error" | "info">("info");

  const usesReleaseDefaults = availability.authenticator === releaseFeatureDefaults.authenticator
    && availability.passwords === releaseFeatureDefaults.passwords
    && availability.documents === releaseFeatureDefaults.documents;

  const restoreAutomaticArchive = async () => {
    const confirmed = window.confirm(
      "Automatische Sicherung wiederherstellen?\n\nKontakte, Kalender und Kennwörter werden durch den Sicherungsstand ersetzt."
    );
    if (!confirmed) return;
    const authorization = window.prompt("EDV-Freigabecode eingeben (Format EDV-...).");
    if (!authorization?.trim()) return;
    const finalConfirmation = window.prompt("Tippen Sie WIEDERHERSTELLEN, um fortzufahren.");
    if (finalConfirmation !== "WIEDERHERSTELLEN") {
      setMessageType("info");
      setMessage("Wiederherstellung wurde abgebrochen.");
      return;
    }

    setBusyAction("restore-automatic-backup");
    setMessage("");
    try {
      const result = await restoreAutomaticBackup(authorization.trim());
      restoreBrowserDataFromBackup(result);
      setMessageType("success");
      setMessage("Sicherung wurde wiederhergestellt. Die App wird neu geladen.");
      window.setTimeout(() => window.location.reload(), 700);
    } catch (error) {
      setMessageType("error");
      setMessage(`Sicherung konnte nicht wiederhergestellt werden: ${error}`);
    } finally {
      setBusyAction(null);
    }
  };

  const resetApplication = async () => {
    const confirmed = window.confirm(
      "App vollständig zurücksetzen?\n\nAlle lokalen App-Daten werden unwiderruflich gelöscht. Outlook, Exchange und die externe automatische Sicherung bleiben erhalten."
    );
    if (!confirmed) return;
    const typed = window.prompt("Tippen Sie ZURÜCKSETZEN, um alle lokalen App-Daten zu löschen.");
    if (typed !== "ZURÜCKSETZEN") {
      setMessageType("info");
      setMessage("Zurücksetzen wurde abgebrochen.");
      return;
    }

    setBusyAction("reset-application");
    setMessage("");
    try {
      const backup = addBrowserDataToBackup(await getBackupData());
      await createAutomaticBackup(backup, true);
      await resetLocalAppData();
      localStorage.clear();
      await restartApp();
    } catch (error) {
      setMessageType("error");
      setMessage(`App konnte nicht vollständig zurückgesetzt werden: ${error}`);
      setBusyAction(null);
    }
  };

  return (
    <div className="page feature-development-page">
      <header className="page-header">
        <div>
          <h2>Optionale Bereiche</h2>
          <p>Zusätzliche Bereiche auf diesem Computer freischalten.</p>
        </div>
        <span className="feature-development-badge"><ShieldCheck size={17} /> Nur EDV</span>
      </header>

      <section className="form-panel feature-development-note">
        <strong>Bereiche kontrolliert freigeben</strong>
        <p>Änderungen gelten nur auf diesem Computer. Die Bereiche bleiben verborgen, bis die EDV sie hier aktiviert.</p>
      </section>

      <section className="feature-toggle-list" aria-label="Optionale Bereiche">
        <FeatureToggleCard
          checked={availability.authenticator}
          description="Einmalcodes sicher auf diesem Computer speichern und erzeugen."
          descriptionId="authenticator-feature-description"
          icon={<ShieldCheck size={25} aria-hidden="true" />}
          onChange={() => onFeatureChange("authenticator", !availability.authenticator)}
          title="2FA-Authenticator"
        />
        <FeatureToggleCard
          checked={availability.passwords}
          description="Passwörter lokal und verschlüsselt auf diesem Computer verwalten."
          descriptionId="passwords-feature-description"
          icon={<KeyRound size={25} aria-hidden="true" />}
          onChange={() => onFeatureChange("passwords", !availability.passwords)}
          title="Passwörter"
        />
        <FeatureToggleCard
          checked={availability.documents}
          description="Dokumente aus OneDrive und SharePoint im Explorer-Stil verwalten."
          descriptionId="documents-feature-description"
          icon={<Files size={25} aria-hidden="true" />}
          onChange={() => onFeatureChange("documents", !availability.documents)}
          title="Dokumente"
        />
      </section>

      <section className="feature-admin-tools" aria-labelledby="feature-admin-tools-title">
          <div className="feature-admin-tools-heading">
            <div>
              <h2 id="feature-admin-tools-title">Admin-Werkzeuge</h2>
              <p>Nur für Wartung und Wiederherstellung.</p>
            </div>
            <span className="feature-development-badge"><ShieldCheck size={17} /> Admin</span>
          </div>

          <StatusMessage message={message} type={messageType} />

          <section className="form-panel feature-admin-card">
            <div className="settings-task-heading">
              <ArchiveRestore size={25} aria-hidden="true" />
              <div>
                <h3>Automatische Sicherung wiederherstellen</h3>
                <p>Ersetzt lokale Kontakte, Kalender und Kennwörter durch den Sicherungsstand.</p>
              </div>
            </div>
            <button type="button" onClick={restoreAutomaticArchive} disabled={busyAction !== null}>
              <ArchiveRestore size={19} /> Wiederherstellen
            </button>
          </section>

          <section className="form-panel settings-reset-panel">
            <div className="settings-task-heading">
              <AlertTriangle size={25} aria-hidden="true" />
              <div>
                <h3>App vollständig zurücksetzen</h3>
                <p>Löscht sämtliche lokalen App-Daten und startet die App neu.</p>
              </div>
            </div>
            <button className="danger-button" type="button" onClick={resetApplication} disabled={busyAction !== null}>
              <Trash2 size={18} /> App zurücksetzen
            </button>
          </section>
      </section>

      <footer className="feature-development-footer">
        <button type="button" onClick={onReset} disabled={usesReleaseDefaults}>
          <RotateCcw size={18} /> Release-Standard verwenden
        </button>
        <small>Setzt alle optionalen Bereiche wieder auf „verborgen“.</small>
      </footer>
    </div>
  );
}
