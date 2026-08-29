import { CalendarDays, Files, KeyRound, Settings, ShieldCheck, UserRound, Wrench } from "lucide-react";
import { t } from "../i18n";

export type Page = "contacts" | "calendar" | "documents" | "passwords" | "authenticator" | "services" | "import" | "export" | "feature-development" | "m365" | "trash" | "settings" | "appearance" | "simple-import" | "backup" | "synchronizations";

const items: Array<{ page: Page; label: string; icon: typeof UserRound; group: "main" | "tools" }> = [
  { page: "contacts", label: t.contacts, icon: UserRound, group: "main" },
  { page: "calendar", label: "Kalender", icon: CalendarDays, group: "main" },
  { page: "passwords", label: "Passwörter", icon: KeyRound, group: "main" },
  { page: "authenticator", label: "2FA-Authenticator", icon: ShieldCheck, group: "tools" },
  { page: "documents", label: "Dokumente", icon: Files, group: "tools" },
  { page: "services", label: "Dienstleistungen", icon: Wrench, group: "tools" }
];

const settingsPages = new Set<Page>(["settings", "appearance", "simple-import", "import", "export", "feature-development", "m365", "trash", "backup", "synchronizations"]);

interface SidebarProps {
  activePage: Page;
  onNavigate: (page: Page) => void;
  compact?: boolean;
  authenticatorEnabled: boolean;
  servicesEnabled: boolean;
}

export function Sidebar({ activePage, onNavigate, compact = false, authenticatorEnabled, servicesEnabled }: SidebarProps) {
  const visibleItems = items.filter((item) => (
    (item.page !== "authenticator" || authenticatorEnabled)
    && (item.page !== "services" || servicesEnabled)
  ));

  return (
    <aside className={compact ? "sidebar compact" : "sidebar"}>
      <div className="brand">
        <img className="brand-logo" src="/dmh-kontakte-kalender.png" alt="Logo von DMH Kontakte und Kalender" />
        <div className="brand-copy">
          <h1>{t.appName}</h1>
          <p>Kontakte und Termine lokal</p>
        </div>
      </div>
      <nav className="nav-list" aria-label="Hauptmenü">
        {visibleItems.map((item, index) => {
          const Icon = item.icon;
          const startsGroup = index > 0 && visibleItems[index - 1].group !== item.group;
          return (
            <button
              className={`${activePage === item.page ? "nav-button active" : "nav-button"}${startsGroup ? " nav-group-start" : ""}`}
              key={item.page}
              onClick={() => onNavigate(item.page)}
              title={compact ? item.label : undefined}
              type="button"
            >
              <Icon size={24} />
              <span className="nav-label">{item.label}</span>
            </button>
          );
        })}
      </nav>
      <div className="sidebar-footer">
        <button
          className={settingsPages.has(activePage) ? "nav-button active" : "nav-button"}
          onClick={() => onNavigate("settings")}
          title={compact ? t.settings : undefined}
          type="button"
        >
          <Settings size={24} />
          <span className="nav-label">{t.settings}</span>
        </button>
      </div>
    </aside>
  );
}
