import { CalendarDays, Check, CloudOff, KeyRound, LayoutGrid, LoaderCircle, LogOut, RefreshCw, Settings, UserRound } from "lucide-react";
import { t } from "../i18n";
import type { Microsoft365Account } from "../types/m365";
import type { ExchangeSyncStatus } from "../types/m365";

export type Page = "contacts" | "calendar" | "passwords" | "import" | "export" | "m365" | "trash" | "settings" | "appearance" | "simple-import" | "backup";

const items: Array<{ page: Page; label: string; icon: typeof UserRound }> = [
  { page: "contacts", label: t.contacts, icon: UserRound },
  { page: "calendar", label: "Kalender", icon: CalendarDays },
  { page: "passwords", label: "Passwörter", icon: KeyRound }
];

const settingsPages = new Set<Page>(["settings", "appearance", "simple-import", "import", "export", "m365", "trash", "backup"]);

interface SidebarProps {
  activePage: Page;
  account: Microsoft365Account | null;
  offline: boolean;
  exchangeSyncStatus: ExchangeSyncStatus;
  onNavigate: (page: Page) => void;
  onOpenPortal: () => void;
  onSignOut: () => Promise<void>;
  onSyncExchange: () => Promise<void>;
}

export function Sidebar({ activePage, account, offline, exchangeSyncStatus, onNavigate, onOpenPortal, onSignOut, onSyncExchange }: SidebarProps) {
  const syncTitle = exchangeSyncStatus.state === "syncing"
    ? "Exchange wird synchronisiert"
    : exchangeSyncStatus.state === "error"
      ? `Synchronisierungsfehler: ${exchangeSyncStatus.message ?? "Unbekannter Fehler"}`
      : exchangeSyncStatus.state === "offline"
        ? "Offline – Änderungen werden später synchronisiert"
        : exchangeSyncStatus.lastSyncedAt
          ? `Zuletzt synchronisiert: ${new Intl.DateTimeFormat("de-DE", { dateStyle: "short", timeStyle: "short" }).format(new Date(exchangeSyncStatus.lastSyncedAt))}`
          : "Jetzt mit Exchange synchronisieren";
  return (
    <aside className="sidebar">
      <div className="brand">
        <img className="brand-logo" src="/dmh-kontakte-kalender.png" alt="Logo von DMH Kontakte und Kalender" />
        <div>
          <h1>DMH Portal</h1>
          <p>Privatschwestern</p>
        </div>
      </div>
      <button className="portal-overview-button" type="button" onClick={onOpenPortal}>
        <LayoutGrid size={20} />
        <span>Portalübersicht</span>
      </button>
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
        {account && (
          <div className="portal-sidebar-account">
            <span className="portal-sidebar-avatar" aria-hidden="true">
              {account.displayName.trim().slice(0, 1).toUpperCase() || "D"}
            </span>
            <span className="portal-sidebar-identity">
              <strong>{account.displayName}</strong>
              <small>{offline && <CloudOff size={14} />} {offline ? "Offline" : account.userPrincipalName || account.email}</small>
            </span>
            <button
              className={`icon-only compact exchange-sync-button ${exchangeSyncStatus.state}`}
              type="button"
              title={syncTitle}
              aria-label={syncTitle}
              disabled={offline || exchangeSyncStatus.state === "syncing"}
              onClick={() => void onSyncExchange()}
            >
              {exchangeSyncStatus.state === "syncing" ? <LoaderCircle className="spin" size={18} />
                : exchangeSyncStatus.state === "synced" ? <Check size={18} />
                  : offline ? <CloudOff size={18} /> : <RefreshCw size={18} />}
            </button>
            <button className="icon-only compact" type="button" title="Abmelden" onClick={() => void onSignOut()}>
              <LogOut size={18} />
            </button>
          </div>
        )}
      </div>
    </aside>
  );
}
