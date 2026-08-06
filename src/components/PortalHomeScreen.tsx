import { ArrowRight, CalendarDays, CloudOff, KeyRound, LogOut, Settings, ShieldCheck, UsersRound } from "lucide-react";
import { openMicrosoft365PasswordChange } from "../services/db";
import type { PortalModuleId, PortalSession } from "../types/m365";

interface PortalHomeScreenProps {
  session: PortalSession;
  onOpenModule: (module: PortalModuleId) => void;
  onSignOut: () => Promise<void>;
}

const moduleDetails: Record<PortalModuleId, {
  title: string;
  eyebrow: string;
  description: string;
  features: Array<{ icon: typeof UsersRound; label: string }>;
  icon: typeof UsersRound;
}> = {
  privatschwestern: {
    title: "Privatschwestern",
    eyebrow: "Kontakte und Organisation",
    description: "Kontakte, Kalender und geschützte Zugangsdaten der Privatschwestern verwalten.",
    icon: UsersRound,
    features: [
      { icon: UsersRound, label: "Kontakte" },
      { icon: CalendarDays, label: "Kalender" },
      { icon: KeyRound, label: "Passwörter" }
    ]
  },
  edv: {
    title: "EDV",
    eyebrow: "Portalverwaltung",
    description: "Portalstatus, Modulfreigaben und die technische Konfiguration zentral überblicken.",
    icon: Settings,
    features: [
      { icon: ShieldCheck, label: "Berechtigungen" },
      { icon: Settings, label: "Module" }
    ]
  }
};

export function PortalHomeScreen({ session, onOpenModule, onSignOut }: PortalHomeScreenProps) {
  const account = session.account;
  const modules = session.modules.filter((module): module is PortalModuleId => module in moduleDetails);

  return (
    <main className="portal-home-screen">
      <header className="portal-home-header">
        <div className="portal-home-brand">
          <img src="/dmh-kontakte-kalender.png" alt="DMH" />
          <div>
            <span>Diakonissenmutterhaus Aidlingen</span>
            <h1>DMH Portal</h1>
          </div>
        </div>
        <div className="portal-home-account">
          <span className="portal-sidebar-avatar" aria-hidden="true">
            {account?.displayName.trim().slice(0, 1).toUpperCase() || "D"}
          </span>
          <span>
            <strong>{account?.displayName}</strong>
            <small>{session.state === "offline" && <CloudOff size={14} />} {account?.userPrincipalName || account?.email}</small>
          </span>
          <div className="portal-home-account-actions">
            <button type="button" onClick={() => void openMicrosoft365PasswordChange()}><KeyRound size={18} /> Kennwort ändern</button>
            <button type="button" onClick={() => void onSignOut()}><LogOut size={18} /> Konto wechseln</button>
          </div>
        </div>
      </header>

      <section className="portal-home-content" aria-labelledby="portal-modules-title">
        <div className="portal-home-welcome">
          <span className="portal-home-kicker"><ShieldCheck size={18} /> Sicher angemeldet</span>
          <h2 id="portal-modules-title">Willkommen, {account?.displayName || "im DMH Portal"}</h2>
          <p>Wählen Sie einen der für Ihr Konto freigegebenen Bereiche.</p>
        </div>

        <div className="portal-module-grid">
          {modules.map((moduleId) => {
            const module = moduleDetails[moduleId];
            const ModuleIcon = module.icon;
            return (
              <button className={`portal-module-card ${moduleId}`} type="button" key={moduleId} onClick={() => onOpenModule(moduleId)}>
                <span className="portal-module-icon"><ModuleIcon size={31} /></span>
                <span className="portal-module-copy">
                  <small>{module.eyebrow}</small>
                  <strong>{module.title}</strong>
                  <span>{module.description}</span>
                </span>
                <span className="portal-module-features">
                  {module.features.map((feature) => {
                    const FeatureIcon = feature.icon;
                    return <span key={feature.label}><FeatureIcon size={16} /> {feature.label}</span>;
                  })}
                </span>
                <span className="portal-module-open">Öffnen <ArrowRight size={19} /></span>
              </button>
            );
          })}
        </div>
      </section>
    </main>
  );
}
