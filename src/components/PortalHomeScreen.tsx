import {
  ArrowRight,
  BarChart3,
  CalendarDays,
  Check,
  CloudOff,
  ContactRound,
  Euro,
  FileText,
  FolderOpen,
  Home,
  Info,
  KeyRound,
  LockKeyhole,
  LoaderCircle,
  LogOut,
  MessageCircle,
  MonitorCog,
  RefreshCw,
  Search,
  Settings,
  ShieldCheck,
  Sparkles,
  UserRound,
  UsersRound
} from "lucide-react";
import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import type { ExchangeSyncStatus, PortalModuleId, PortalSession } from "../types/m365";

export type PortalPage = "overview" | "contacts" | "calendar" | "passwords" | "settings";
type CatalogModuleId = PortalModuleId | "personal" | "finances" | "communication" | "reports" | "quality";

interface PortalHomeScreenProps {
  session: PortalSession;
  activePage: PortalPage;
  exchangeSyncStatus: ExchangeSyncStatus;
  children?: ReactNode;
  onNavigate: (page: PortalPage) => void;
  onOpenModule: (module: PortalModuleId) => void;
  onSignOut: () => Promise<void>;
  onSyncExchange: () => Promise<void>;
}

interface ModuleCatalogEntry {
  id: CatalogModuleId;
  title: string;
  tag: string;
  description: string;
  icon: typeof UsersRound;
  accessModule?: PortalModuleId;
  tone: "berry" | "blue" | "green" | "teal" | "ink";
}

const moduleCatalog: ModuleCatalogEntry[] = [
  {
    id: "privatschwestern",
    title: "Altes Modul",
    tag: "Archiv",
    description: "Den bisherigen Bereich der Privatschwestern bei Bedarf weiterhin öffnen.",
    icon: ContactRound,
    accessModule: "privatschwestern",
    tone: "berry"
  },
  {
    id: "edv",
    title: "EDV",
    tag: "System",
    description: "Portalstatus, Modulfreigaben, Benutzer, Tickets und technische Systeme verwalten.",
    icon: MonitorCog,
    accessModule: "edv",
    tone: "teal"
  },
  {
    id: "personal",
    title: "Personal",
    tag: "Personal",
    description: "Mitarbeiterdaten, Abwesenheiten und Personalprozesse an einem Ort.",
    icon: UserRound,
    tone: "blue"
  },
  {
    id: "finances",
    title: "Finanzen",
    tag: "Finanzen",
    description: "Buchhaltung, Budgets und Finanzberichte übersichtlich bereitstellen.",
    icon: Euro,
    tone: "green"
  },
  {
    id: "communication",
    title: "Kommunikation",
    tag: "Kommunikation",
    description: "Mitteilungen, Newsletter und interne Kommunikation koordinieren.",
    icon: MessageCircle,
    tone: "berry"
  },
  {
    id: "reports",
    title: "Berichte & Auswertungen",
    tag: "Berichte",
    description: "Daten auswerten und verständliche Berichte zentral verfügbar machen.",
    icon: BarChart3,
    tone: "ink"
  },
  {
    id: "quality",
    title: "Qualitätsmanagement",
    tag: "Qualität",
    description: "Qualitätsstandards, Prozesse und Dokumentationen gemeinsam verwalten.",
    icon: ShieldCheck,
    tone: "teal"
  }
];

const sidebarEntries: Array<{
  id: PortalPage | "documents" | "information";
  label: string;
  icon: typeof Home;
  future?: boolean;
}> = [
  { id: "overview", label: "Übersicht", icon: Home },
  { id: "passwords", label: "Passwörter", icon: KeyRound },
  { id: "contacts", label: "Kontakte", icon: UsersRound },
  { id: "calendar", label: "Agenda", icon: CalendarDays },
  { id: "documents", label: "Dokumente", icon: FolderOpen, future: true },
  { id: "information", label: "Informationen", icon: Info, future: true },
  { id: "settings", label: "Einstellungen", icon: Settings }
];

const pageTitles: Record<Exclude<PortalPage, "overview">, { title: string; description: string }> = {
  passwords: { title: "Passwörter", description: "Persönliche Zugangsdaten sicher verwalten." },
  contacts: { title: "Kontakte", description: "Ihre Kontakte und Verteiler zentral organisieren." },
  calendar: { title: "Agenda", description: "Termine und Kalender übersichtlich verwalten." },
  settings: { title: "Einstellungen", description: "Das DMH Portal und die übernommenen Funktionen konfigurieren." }
};

export function PortalHomeScreen({
  session,
  activePage,
  exchangeSyncStatus,
  children,
  onNavigate,
  onOpenModule,
  onSignOut,
  onSyncExchange
}: PortalHomeScreenProps) {
  const account = session.account;
  const searchRef = useRef<HTMLInputElement>(null);
  const [search, setSearch] = useState("");
  const [notice, setNotice] = useState("");

  useEffect(() => {
    const focusSearch = (event: KeyboardEvent) => {
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "k") {
        event.preventDefault();
        searchRef.current?.focus();
      }
    };
    window.addEventListener("keydown", focusSearch);
    return () => window.removeEventListener("keydown", focusSearch);
  }, []);

  const visibleModules = useMemo(() => {
    const term = search.trim().toLocaleLowerCase("de-DE");
    if (!term) return moduleCatalog;
    return moduleCatalog.filter((module) =>
      `${module.title} ${module.tag} ${module.description}`.toLocaleLowerCase("de-DE").includes(term)
    );
  }, [search]);

  const showLockedMessage = (message: string) => {
    setNotice(message);
    window.setTimeout(() => setNotice(""), 5000);
  };

  const openCatalogModule = (module: ModuleCatalogEntry) => {
    if (!module.accessModule) {
      showLockedMessage(`${module.title} wird derzeit vorbereitet und ist noch nicht verfügbar.`);
      return;
    }
    if (!session.modules.includes(module.accessModule)) {
      showLockedMessage(`Ihre EDV hat das Modul ${module.title} für Ihr Konto noch nicht freigegeben.`);
      return;
    }
    onOpenModule(module.accessModule);
  };

  const openSidebarEntry = (entry: (typeof sidebarEntries)[number]) => {
    if (entry.future) {
      showLockedMessage(`${entry.label} wird derzeit für das DMH Portal vorbereitet.`);
      return;
    }
    setSearch("");
    onNavigate(entry.id as PortalPage);
  };

  const syncTitle = exchangeSyncStatus.state === "syncing"
    ? "Exchange wird synchronisiert"
    : exchangeSyncStatus.state === "error"
      ? `Synchronisierungsfehler: ${exchangeSyncStatus.message ?? "Unbekannter Fehler"}`
      : exchangeSyncStatus.lastSyncedAt
        ? `Zuletzt synchronisiert: ${new Intl.DateTimeFormat("de-DE", { dateStyle: "short", timeStyle: "short" }).format(new Date(exchangeSyncStatus.lastSyncedAt))}`
        : "Jetzt mit Exchange synchronisieren";

  return (
    <main className="portal-home-screen portal-dashboard">
      <header className="portal-dashboard-header">
        <div className="portal-dashboard-brand">
          <span className="portal-dashboard-logo"><img src="/dmh-kontakte-kalender.png" alt="" /></span>
          <span><strong>DMH Portal</strong><small>Diakonissenmutterhaus Aidlingen</small></span>
        </div>
        <label className="portal-dashboard-search">
          <Search size={23} aria-hidden="true" />
          <input
            ref={searchRef}
            value={activePage === "overview" ? search : ""}
            onChange={(event) => {
              if (activePage !== "overview") onNavigate("overview");
              setSearch(event.target.value);
            }}
            placeholder="Suche im Portal …"
            aria-label="Module im Portal suchen"
          />
          <kbd>Ctrl + K</kbd>
        </label>
      </header>

      <aside className="portal-dashboard-sidebar">
        <nav aria-label="Portalbereiche">
          {sidebarEntries.map((entry) => {
            const Icon = entry.icon;
            const locked = Boolean(entry.future);
            return (
              <button
                className={entry.id === activePage ? "active" : ""}
                type="button"
                key={entry.id}
                onClick={() => openSidebarEntry(entry)}
                aria-label={locked ? `${entry.label}, noch nicht freigegeben` : entry.label}
              >
                <Icon size={25} />
                <span>{entry.label}</span>
                {locked && <LockKeyhole className="portal-sidebar-lock" size={15} />}
              </button>
            );
          })}
        </nav>

        <div className="portal-dashboard-account">
          <div className="portal-dashboard-identity">
            <span className="portal-sidebar-avatar" aria-hidden="true">
              {account?.displayName.trim().slice(0, 1).toUpperCase() || "D"}
            </span>
            <span>
              <strong>Mit Microsoft angemeldet</strong>
              <small>{session.state === "offline" && <CloudOff size={13} />} {account?.userPrincipalName || account?.email}</small>
            </span>
            <span className="portal-microsoft-mark" aria-label="Microsoft"><i /><i /><i /><i /></span>
          </div>
          <button type="button" onClick={() => void onSignOut()}><LogOut size={18} /> Konto wechseln</button>
          <button
            className={`portal-dashboard-sync ${exchangeSyncStatus.state}`}
            type="button"
            title={syncTitle}
            disabled={session.state === "offline" || exchangeSyncStatus.state === "syncing"}
            onClick={() => void onSyncExchange()}
          >
            {exchangeSyncStatus.state === "syncing" ? <LoaderCircle className="spin" size={18} />
              : exchangeSyncStatus.state === "synced" ? <Check size={18} />
                : session.state === "offline" ? <CloudOff size={18} /> : <RefreshCw size={18} />}
            {exchangeSyncStatus.state === "syncing" ? "Synchronisieren …" : "Exchange synchronisieren"}
          </button>
        </div>
      </aside>

      <section className={`portal-dashboard-main ${activePage === "overview" ? "" : "portal-dashboard-feature-main"}`} aria-labelledby={activePage === "overview" ? "portal-welcome-title" : "portal-feature-title"}>
        {notice && <div className="portal-dashboard-notice" role="status"><LockKeyhole size={19} /> {notice}</div>}
        {activePage === "overview" ? (
          <>
        <div className="portal-dashboard-hero">
          <div>
            <span className="portal-dashboard-kicker"><Sparkles size={17} /> Ihr persönliches Portal</span>
            <h1 id="portal-welcome-title">Willkommen zurück,<br /><strong>{account?.displayName || "im DMH Portal"}!</strong></h1>
            <p>Hier finden Sie alle wichtigen Fachmodule und Informationen auf einen Blick.</p>
          </div>
        </div>
        <div className="portal-dashboard-section-title">
          <span><h2>Fachmodule</h2><i /></span>
          <small>{visibleModules.length} {visibleModules.length === 1 ? "Modul" : "Module"}</small>
        </div>

        <div className="portal-dashboard-modules">
          {visibleModules.map((module) => {
            const Icon = module.icon;
            const enabled = module.accessModule ? session.modules.includes(module.accessModule) : false;
            const future = !module.accessModule;
            return (
              <article className={`portal-dashboard-module tone-${module.tone} ${enabled ? "enabled" : "locked"}`} key={module.id}>
                <div className="portal-dashboard-module-top">
                  <span className="portal-dashboard-module-icon"><Icon size={31} /></span>
                  <span><h3>{module.title}</h3><p>{module.description}</p></span>
                </div>
                <footer>
                  <span className="portal-dashboard-tag">{module.tag}</span>
                  <button type="button" onClick={() => openCatalogModule(module)}>
                    {enabled ? "Öffnen" : future ? "In Vorbereitung" : "Nicht freigegeben"}
                    {enabled ? <ArrowRight size={20} /> : <LockKeyhole size={17} />}
                  </button>
                </footer>
              </article>
            );
          })}
        </div>

        {visibleModules.length === 0 && (
          <div className="portal-dashboard-empty"><FileText size={35} /><strong>Kein Modul gefunden</strong><p>Versuchen Sie einen anderen Suchbegriff.</p></div>
        )}
          </>
        ) : (
          <>
            <header className="portal-dashboard-feature-header">
              <small>DMH PORTAL</small>
              <h1 id="portal-feature-title">{pageTitles[activePage].title}</h1>
              <p>{pageTitles[activePage].description}</p>
            </header>
            <div className="portal-dashboard-feature-content">{children}</div>
          </>
        )}
      </section>
    </main>
  );
}
