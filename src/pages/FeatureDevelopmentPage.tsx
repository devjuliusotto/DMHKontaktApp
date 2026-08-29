import { FlaskConical, RotateCcw, ShieldCheck, Wrench } from "lucide-react";
import type { ReactNode } from "react";
import type { AppFeature, AppFeatureAvailability } from "../utils/featureFlags";
import { releaseFeatureDefaults } from "../utils/featureFlags";

interface FeatureDevelopmentPageProps {
  availability: AppFeatureAvailability;
  onFeatureChange: (feature: AppFeature, enabled: boolean) => void;
  onReset: () => void;
  showAdminFeatures: boolean;
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

export function FeatureDevelopmentPage({ availability, onFeatureChange, onReset, showAdminFeatures }: FeatureDevelopmentPageProps) {
  const toggleServices = () => {
    const enabled = !availability.services;
    if (enabled && !window.confirm("Dienstleistungen ist noch nicht mit Azure SQL verbunden. Nur für eine Vorführung auf diesem Computer aktivieren?")) return;
    onFeatureChange("services", enabled);
  };
  const usesReleaseDefaults = availability.authenticator === releaseFeatureDefaults.authenticator
    && (!showAdminFeatures || availability.services === releaseFeatureDefaults.services);

  return (
    <div className="page feature-development-page">
      <header className="page-header">
        <div>
          <h2>In Entwicklung</h2>
          <p>Optionale Funktionen gezielt auf diesem Computer freischalten.</p>
        </div>
        <span className="feature-development-badge"><FlaskConical size={17} /> {showAdminFeatures ? "Admin Test" : "Optional"}</span>
      </header>

      <section className="form-panel feature-development-note">
        <strong>{showAdminFeatures ? "Testfunktionen kontrolliert freigeben" : "Sie entscheiden, was Sie verwenden"}</strong>
        <p>Änderungen gelten nur auf diesem Computer. Neue Funktionen bleiben ausgeschaltet, bis sie hier aktiviert oder durch eine spätere Release allgemein freigegeben werden.</p>
      </section>

      <section className="feature-toggle-list" aria-label="Funktionen in Entwicklung">
        <FeatureToggleCard
          checked={availability.authenticator}
          description="Einmalcodes sicher auf diesem Computer speichern und erzeugen."
          descriptionId="authenticator-feature-description"
          icon={<ShieldCheck size={25} aria-hidden="true" />}
          onChange={() => onFeatureChange("authenticator", !availability.authenticator)}
          title="2FA-Authenticator"
        />
        {showAdminFeatures ? (
          <FeatureToggleCard
            checked={availability.services}
            description="Buchungen, Service-Tickets und Mahlzeiten. Noch ohne zentrale Azure-SQL-Speicherung."
            descriptionId="services-feature-description"
            icon={<Wrench size={25} aria-hidden="true" />}
            onChange={toggleServices}
            title="Dienstleistungen"
          />
        ) : null}
      </section>

      <footer className="feature-development-footer">
        <button type="button" onClick={onReset} disabled={usesReleaseDefaults}>
          <RotateCcw size={18} /> Release-Standard verwenden
        </button>
        <small>Eine spätere offizielle Release kann diese Funktion automatisch für alle aktivieren.</small>
      </footer>
    </div>
  );
}
