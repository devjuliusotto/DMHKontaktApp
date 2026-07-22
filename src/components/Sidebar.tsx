import { CalendarDays, KeyRound, Settings, UserRound } from "lucide-react";
import { t } from "../i18n";

export type Page = "contacts" | "calendar" | "passwords" | "import" | "export" | "trash" | "settings" | "appearance" | "simple-import";

const items: Array<{ page: Page; label: string; icon: typeof UserRound }> = [
  { page: "contacts", label: t.contacts, icon: UserRound },
  { page: "calendar", label: "Kalender", icon: CalendarDays },
  { page: "passwords", label: "Passwörter", icon: KeyRound }
];

const settingsPages = new Set<Page>(["settings", "appearance", "simple-import", "import", "export", "trash"]);

interface SidebarProps {
  activePage: Page;
  onNavigate: (page: Page) => void;
}

export function Sidebar({ activePage, onNavigate }: SidebarProps) {
  return (
    <aside className="sidebar">
      <div className="brand">
        <img className="brand-logo" src="/dmh-kontakte-kalender.png" alt="Logo von DMH Kontakte und Kalender" />
        <div>
          <h1>{t.appName}</h1>
          <p>Kontakte und Termine lokal</p>
        </div>
      </div>
      <nav className="nav-list" aria-label="Hauptmenü">
        {items.map((item) => {
          const Icon = item.icon;
          return (
            <button
              className={activePage === item.page ? "nav-button active" : "nav-button"}
              key={item.page}
              onClick={() => onNavigate(item.page)}
              type="button"
            >
              <Icon size={24} />
              <span>{item.label}</span>
            </button>
          );
        })}
      </nav>
      <div className="sidebar-footer">
        <button
          className={settingsPages.has(activePage) ? "nav-button active" : "nav-button"}
          onClick={() => onNavigate("settings")}
          type="button"
        >
          <Settings size={24} />
          <span>{t.settings}</span>
        </button>
      </div>
    </aside>
  );
}
