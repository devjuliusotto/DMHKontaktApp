import { CalendarDays, Files, KeyRound, Mail, ShieldCheck, Trash2, UserRound } from "lucide-react";
import { t } from "../i18n";

export type Page = "contacts" | "calendar" | "documents" | "passwords" | "authenticator" | "services" | "import" | "contact-import" | "calendar-import" | "export" | "feature-development" | "m365" | "trash" | "settings" | "appearance" | "simple-import" | "backup" | "synchronizations" | "extras";

const items: Array<{ page: Page; label: string; icon: typeof UserRound; group: "main" | "tools" }> = [
  { page: "extras", label: "E-Mail-Konfig.", icon: Mail, group: "main" },
  { page: "contacts", label: t.contacts, icon: UserRound, group: "main" },
  { page: "calendar", label: "Kalender", icon: CalendarDays, group: "main" },
  { page: "passwords", label: "Passwörter", icon: KeyRound, group: "main" },
  { page: "authenticator", label: "2FA-Authenticator", icon: ShieldCheck, group: "tools" },
  { page: "documents", label: "Dokumente", icon: Files, group: "tools" }
];

const settingsPages = new Set<Page>(["settings", "appearance", "feature-development", "backup"]);

interface SidebarProps {
  activePage: Page;
  onNavigate: (page: Page) => void;
  compact?: boolean;
  authenticatorEnabled: boolean;
  documentsEnabled: boolean;
  passwordsEnabled: boolean;
}

export function Sidebar({ activePage, onNavigate, compact = false, authenticatorEnabled, documentsEnabled, passwordsEnabled }: SidebarProps) {
  const visibleItems = items.filter((item) => (
    (item.page !== "authenticator" || authenticatorEnabled)
    && (item.page !== "documents" || documentsEnabled)
    && (item.page !== "passwords" || passwordsEnabled)
  ));

  return (
    <aside className={compact ? "sidebar compact" : "sidebar"}>
      <div className="brand">
        <img className="brand-logo" src="/dmh-kontakte-kalender.png" alt="Logo von DMH Backup" />
        <div className="brand-copy">
          <h1>{t.appName}</h1>
        </div>
      </div>
      <nav className="nav-list" aria-label="Hauptmenü">
        {visibleItems.map((item, index) => {
          const Icon = item.icon;
          const startsGroup = index > 0 && visibleItems[index - 1].group !== item.group;
          const active = activePage === item.page;
          return (
            <button
              className={`${active ? "nav-button active" : "nav-button"}${startsGroup ? " nav-group-start" : ""}${item.page === "contacts" ? " nav-section-gap-small" : ""}`}
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
      <div className="sidebar-bottom">
        <button
          className={activePage === "trash" ? "nav-button active" : "nav-button"}
          onClick={() => onNavigate("trash")}
          title={compact ? "Papierkorb" : undefined}
          type="button"
        >
          <Trash2 size={24} />
          <span className="nav-label">Papierkorb</span>
        </button>
        <div className="sidebar-footer">
          <button
            className={settingsPages.has(activePage) ? "nav-button active" : "nav-button"}
            onClick={() => onNavigate("settings")}
            title={compact ? "EDV Tools · Nur für EDV" : undefined}
            type="button"
          >
            <ShieldCheck size={24} />
            <span className="nav-label">EDV Tools</span>
          </button>
        </div>
      </div>
    </aside>
  );
}
