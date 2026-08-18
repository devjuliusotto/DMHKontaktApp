import { CalendarDays, KeyRound, Settings, UserRound } from "lucide-react";
import { t } from "../i18n";

export type Page = "contacts" | "calendar" | "passwords" | "import" | "export" | "m365" | "trash" | "settings" | "appearance" | "simple-import" | "backup" | "synchronizations";

const items: Array<{ page: Page; label: string; icon: typeof UserRound }> = [
  { page: "contacts", label: t.contacts, icon: UserRound },
  { page: "calendar", label: "Kalender", icon: CalendarDays },
  { page: "passwords", label: "Passwörter", icon: KeyRound }
];

const settingsPages = new Set<Page>(["settings", "appearance", "simple-import", "import", "export", "m365", "trash", "backup", "synchronizations"]);

interface SidebarProps {
  activePage: Page;
  onNavigate: (page: Page) => void;
  compact?: boolean;
}

export function Sidebar({ activePage, onNavigate, compact = false }: SidebarProps) {
  return (
    <aside className={compact ? "sidebar compact" : "sidebar"}>
      <div className="brand">
        <img className="brand-logo" src="/dmh-kontakte-kalender.png" alt="Logo von DMH Kontakte und Kalender" />
        {!compact && <div>
          <h1>{t.appName}</h1>
          <p>Kontakte und Termine lokal</p>
        </div>}
      </div>
      <nav className="nav-list" aria-label="Hauptmenü">
        {items.map((item) => {
          const Icon = item.icon;
          return (
            <button
              className={activePage === item.page ? "nav-button active" : "nav-button"}
              key={item.page}
              onClick={() => onNavigate(item.page)}
              title={compact ? item.label : undefined}
              type="button"
            >
              <Icon size={24} />
              {!compact && <span>{item.label}</span>}
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
          {!compact && <span>{t.settings}</span>}
        </button>
      </div>
    </aside>
  );
}
