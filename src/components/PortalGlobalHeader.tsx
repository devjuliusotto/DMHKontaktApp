import { Check, CloudOff, LoaderCircle, LogOut, RefreshCw, Search, UserRound } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import type { ExchangeSyncStatus, PortalSession } from "../types/m365";
import { PortalProfileDialog } from "./PortalProfileDialog";

interface PortalGlobalHeaderProps {
  session: PortalSession;
  exchangeSyncStatus: ExchangeSyncStatus;
  searchValue: string;
  onSearchChange: (value: string) => void;
  onSearchActivate: () => void;
  onGoHome: () => void;
  onSignOut: () => Promise<void>;
  onSyncExchange: () => Promise<void>;
}

export function PortalGlobalHeader({
  session,
  exchangeSyncStatus,
  searchValue,
  onSearchChange,
  onSearchActivate,
  onGoHome,
  onSignOut,
  onSyncExchange
}: PortalGlobalHeaderProps) {
  const account = session.account;
  const searchRef = useRef<HTMLInputElement>(null);
  const accountMenuRef = useRef<HTMLDivElement>(null);
  const [accountMenuOpen, setAccountMenuOpen] = useState(false);
  const [profileDialogOpen, setProfileDialogOpen] = useState(false);

  useEffect(() => {
    const focusSearch = (event: KeyboardEvent) => {
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "k") {
        event.preventDefault();
        onSearchActivate();
        window.requestAnimationFrame(() => searchRef.current?.focus());
      }
    };
    window.addEventListener("keydown", focusSearch);
    return () => window.removeEventListener("keydown", focusSearch);
  }, [onSearchActivate]);

  useEffect(() => {
    if (!accountMenuOpen) return;
    const closeMenu = (event: MouseEvent) => {
      if (!accountMenuRef.current?.contains(event.target as Node)) setAccountMenuOpen(false);
    };
    const closeWithEscape = (event: KeyboardEvent) => {
      if (event.key === "Escape") setAccountMenuOpen(false);
    };
    document.addEventListener("mousedown", closeMenu);
    window.addEventListener("keydown", closeWithEscape);
    return () => {
      document.removeEventListener("mousedown", closeMenu);
      window.removeEventListener("keydown", closeWithEscape);
    };
  }, [accountMenuOpen]);

  const syncTitle = exchangeSyncStatus.state === "syncing"
    ? "Exchange wird synchronisiert"
    : exchangeSyncStatus.state === "error"
      ? `Synchronisierungsfehler: ${exchangeSyncStatus.message ?? "Unbekannter Fehler"}`
      : exchangeSyncStatus.lastSyncedAt
        ? `Zuletzt synchronisiert: ${new Intl.DateTimeFormat("de-DE", { dateStyle: "short", timeStyle: "short" }).format(new Date(exchangeSyncStatus.lastSyncedAt))}`
        : "Jetzt mit Exchange synchronisieren";

  return (
    <>
      <header className="portal-dashboard-header">
        <button className="portal-dashboard-brand" type="button" aria-label="Zur Portalübersicht" title="Zur Übersicht" onClick={onGoHome}>
          <span className="portal-dashboard-logo"><img src="/dmh-kontakte-kalender.png" alt="" /></span>
          <span><strong>DMH Portal</strong><small>Diakonissenmutterhaus Aidlingen</small></span>
        </button>
        <label className="portal-dashboard-search">
          <Search size={23} aria-hidden="true" />
          <input
            ref={searchRef}
            value={searchValue}
            onFocus={onSearchActivate}
            onChange={(event) => onSearchChange(event.target.value)}
            placeholder="Suche im Portal …"
            aria-label="Module im Portal suchen"
          />
          <kbd>Ctrl + K</kbd>
        </label>
        <div className="portal-header-actions" ref={accountMenuRef}>
          <button
            className={`portal-header-sync ${exchangeSyncStatus.state}`}
            type="button"
            title={syncTitle}
            aria-label={syncTitle}
            disabled={session.state === "offline" || exchangeSyncStatus.state === "syncing"}
            onClick={() => void onSyncExchange()}
          >
            {exchangeSyncStatus.state === "syncing" ? <LoaderCircle className="spin" size={20} />
              : exchangeSyncStatus.state === "synced" ? <Check size={20} />
                : session.state === "offline" ? <CloudOff size={20} /> : <RefreshCw size={20} />}
          </button>
          <button
            className="portal-header-account"
            type="button"
            title="Microsoft-Kontomenü öffnen"
            aria-label="Microsoft-Kontomenü öffnen"
            aria-haspopup="menu"
            aria-expanded={accountMenuOpen}
            onClick={() => setAccountMenuOpen((open) => !open)}
          >
            <span className="portal-header-account-text">
              <strong>Mit Microsoft angemeldet</strong>
              <small>{session.state === "offline" && <CloudOff size={13} />} {account?.userPrincipalName || account?.email}</small>
            </span>
            <span className="portal-microsoft-mark" aria-hidden="true"><i /><i /><i /><i /></span>
            <span className="portal-header-avatar" aria-hidden="true">{account?.displayName.trim().slice(0, 1).toUpperCase() || "D"}</span>
          </button>
          {accountMenuOpen && (
            <div className="portal-account-menu" role="menu">
              <header>
                <span className="portal-account-menu-avatar" aria-hidden="true">{account?.displayName.trim().slice(0, 1).toUpperCase() || "D"}</span>
                <div><strong>{account?.displayName}</strong><small>{account?.userPrincipalName || account?.email}</small></div>
              </header>
              <button type="button" role="menuitem" onClick={() => { setAccountMenuOpen(false); setProfileDialogOpen(true); }}>
                <UserRound size={20} /><span><strong>Profil bearbeiten</strong><small>Telefon, Adresse und Büro</small></span>
              </button>
              <button
                type="button"
                role="menuitem"
                disabled={session.state === "offline" || exchangeSyncStatus.state === "syncing"}
                onClick={() => { setAccountMenuOpen(false); void onSyncExchange(); }}
              >
                {exchangeSyncStatus.state === "syncing" ? <LoaderCircle className="spin" size={20} /> : <RefreshCw size={20} />}
                <span><strong>Alle Daten synchronisieren</strong><small>Kontakte, Agenda und Microsoft 365</small></span>
              </button>
              <div className="portal-account-menu-separator" />
              <button className="portal-account-menu-signout" type="button" role="menuitem" onClick={() => void onSignOut()}>
                <LogOut size={20} /><span><strong>Abmelden</strong><small>Microsoft-Konto wechseln</small></span>
              </button>
            </div>
          )}
        </div>
      </header>
      {profileDialogOpen && account && <PortalProfileDialog account={account} onClose={() => setProfileDialogOpen(false)} />}
    </>
  );
}
