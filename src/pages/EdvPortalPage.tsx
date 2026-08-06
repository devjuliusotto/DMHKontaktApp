import { ArrowLeft, Check, CloudOff, LogOut, RefreshCw, Settings, ShieldCheck, UsersRound, Wrench } from "lucide-react";
import type { Microsoft365Account, PortalModuleId } from "../types/m365";

interface EdvPortalPageProps {
  account: Microsoft365Account;
  modules: PortalModuleId[];
  offline: boolean;
  refreshing: boolean;
  message: string;
  onBack: () => void;
  onRefreshAuthorization: () => Promise<void>;
  onSignOut: () => Promise<void>;
}

const registeredModules: Array<{ id: PortalModuleId; title: string; description: string; icon: typeof Settings }> = [
  { id: "privatschwestern", title: "Privatschwestern", description: "Kontakte, Kalender und geschützte Zugangsdaten", icon: UsersRound },
  { id: "edv", title: "EDV", description: "Technische Portalverwaltung", icon: Settings }
];

export function EdvPortalPage({ account, modules, offline, refreshing, message, onBack, onRefreshAuthorization, onSignOut }: EdvPortalPageProps) {
  return (
    <main className="edv-portal-screen">
      <header className="edv-portal-header">
        <button type="button" onClick={onBack}><ArrowLeft size={20} /> Portalübersicht</button>
        <div className="edv-portal-title">
          <span className="edv-portal-icon"><Settings size={27} /></span>
          <div><small>DMH Portal</small><h1>EDV · Portalverwaltung</h1></div>
        </div>
        <button type="button" onClick={() => void onSignOut()}><LogOut size={19} /> Abmelden</button>
      </header>

      <div className="edv-portal-content">
        <section className="edv-status-hero">
          <div>
            <span className="portal-home-kicker"><ShieldCheck size={18} /> EDV-Zugriff bestätigt</span>
            <h2>Portalstatus</h2>
            <p>Die technische Grundstruktur des DMH Portals ist aktiv. Hier entsteht die zentrale Verwaltung der Module und ihrer Microsoft-365-Gruppen.</p>
          </div>
          <div className={`edv-connection-state ${offline ? "offline" : "online"}`}>
            {offline ? <CloudOff size={24} /> : <Check size={24} />}
            <span><strong>{offline ? "Offline" : "Mit Microsoft 365 verbunden"}</strong><small>{account.userPrincipalName || account.email}</small></span>
          </div>
        </section>

        <section className="edv-dashboard-grid">
          <article className="edv-panel">
            <div className="edv-panel-heading"><UsersRound size={23} /><div><h3>Registrierte Module</h3><p>Zugriff des aktuellen Kontos</p></div></div>
            <div className="edv-module-list">
              {registeredModules.map((module) => {
                const Icon = module.icon;
                const allowed = modules.includes(module.id);
                return (
                  <div className="edv-module-row" key={module.id}>
                    <span className="edv-module-row-icon"><Icon size={21} /></span>
                    <span><strong>{module.title}</strong><small>{module.description}</small></span>
                    <span className={`edv-access-badge ${allowed ? "allowed" : "restricted"}`}>{allowed ? "Freigegeben" : "Nicht freigegeben"}</span>
                  </div>
                );
              })}
            </div>
          </article>

          <article className="edv-panel">
            <div className="edv-panel-heading"><Wrench size={23} /><div><h3>Konfiguration</h3><p>Aktueller Verwaltungsstand</p></div></div>
            <div className="edv-configuration-note">
              <strong>Gruppenzuordnung ist aktiv</strong>
              <p>Die Modulfreigaben werden derzeit aus den beim Build hinterlegten Entra-Gruppen gelesen.</p>
            </div>
            <button className="primary" type="button" disabled={offline || refreshing} onClick={() => void onRefreshAuthorization()}>
              <RefreshCw className={refreshing ? "spin" : ""} size={19} /> Gruppen erneut prüfen
            </button>
            {message && <p className="portal-login-message error" role="alert">{message}</p>}
          </article>
        </section>

        <section className="edv-next-step">
          <ShieldCheck size={24} />
          <div><strong>Nächster Ausbauschritt</strong><p>Die Gruppenzuordnung wird aus dem Installer in eine zentral verwaltete Microsoft-Konfiguration verschoben. Danach können berechtigte EDV-Benutzer Freigaben hier ändern, ohne eine neue App-Version zu bauen.</p></div>
        </section>
      </div>
    </main>
  );
}
