import {
  ArrowRight,
  CalendarDays,
  CheckCircle2,
  ChevronLeft,
  ChevronRight,
  ContactRound,
  Clock3,
  FileText,
  FolderOpen,
  Home,
  Info,
  KeyRound,
  LayoutGrid,
  LockKeyhole,
  MonitorCog,
  MapPin,
  Settings,
  UsersRound
} from "lucide-react";
import { useEffect, useMemo, useState, type ReactNode } from "react";
import type { ExchangeSyncStatus, PortalModuleId, PortalSession } from "../types/m365";
import type { CalendarEvent } from "../types/calendar";
import { calendarColorStyle, calendarStorageKey, expandCalendarEvents, parseCalendarDate } from "../utils/calendar";
import { exchangeSyncCompletedEvent } from "../utils/exchangeSync";
import { PortalGlobalHeader } from "./PortalGlobalHeader";

export type PortalPage = "overview" | "modules" | "contacts" | "calendar" | "passwords" | "settings";

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
  id: PortalModuleId;
  title: string;
  tag: string;
  description: string;
  icon: typeof UsersRound;
  accessModule: PortalModuleId;
  tone: "berry" | "teal";
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
  }
];

const sidebarEntries: Array<{
  id: PortalPage | "documents" | "information";
  label: string;
  icon: typeof Home;
  future?: boolean;
}> = [
  { id: "overview", label: "Übersicht", icon: Home },
  { id: "modules", label: "Module", icon: LayoutGrid },
  { id: "passwords", label: "Passwörter", icon: KeyRound },
  { id: "contacts", label: "Kontakte", icon: UsersRound },
  { id: "calendar", label: "Agenda", icon: CalendarDays },
  { id: "documents", label: "Dokumente", icon: FolderOpen, future: true },
  { id: "information", label: "Informationen", icon: Info, future: true },
  { id: "settings", label: "Einstellungen", icon: Settings }
];

const pageTitles: Record<Exclude<PortalPage, "overview">, { title: string; description: string }> = {
  modules: { title: "Module", description: "Ihre freigegebenen Fachmodule auf einen Blick." },
  passwords: { title: "Passwörter", description: "Persönliche Zugangsdaten sicher verwalten." },
  contacts: { title: "Kontakte", description: "Ihre Kontakte und Verteiler zentral organisieren." },
  calendar: { title: "Agenda", description: "Termine und Kalender übersichtlich verwalten." },
  settings: { title: "Einstellungen", description: "Das DMH Portal und die übernommenen Funktionen konfigurieren." }
};

function startOfDay(date: Date) {
  return new Date(date.getFullYear(), date.getMonth(), date.getDate());
}

function addDays(date: Date, days: number) {
  return new Date(date.getFullYear(), date.getMonth(), date.getDate() + days);
}

function isSameDay(left: Date, right: Date) {
  return left.getFullYear() === right.getFullYear()
    && left.getMonth() === right.getMonth()
    && left.getDate() === right.getDate();
}

function loadOverviewEvents(): CalendarEvent[] {
  try {
    const saved = localStorage.getItem(calendarStorageKey);
    return saved ? JSON.parse(saved) as CalendarEvent[] : [];
  } catch {
    return [];
  }
}

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
  const [search, setSearch] = useState("");
  const [notice, setNotice] = useState("");
  const [overviewDate, setOverviewDate] = useState(() => startOfDay(new Date()));
  const [overviewEvents, setOverviewEvents] = useState<CalendarEvent[]>(loadOverviewEvents);

  useEffect(() => {
    const reloadOverviewEvents = () => setOverviewEvents(loadOverviewEvents());
    if (activePage === "overview") reloadOverviewEvents();
    window.addEventListener(exchangeSyncCompletedEvent, reloadOverviewEvents);
    window.addEventListener("storage", reloadOverviewEvents);
    return () => {
      window.removeEventListener(exchangeSyncCompletedEvent, reloadOverviewEvents);
      window.removeEventListener("storage", reloadOverviewEvents);
    };
  }, [activePage]);

  const visibleModules = useMemo(() => {
    const availableModules = moduleCatalog.filter((module) => session.modules.includes(module.accessModule));
    const term = search.trim().toLocaleLowerCase("de-DE");
    if (!term) return availableModules;
    return availableModules.filter((module) =>
      `${module.title} ${module.tag} ${module.description}`.toLocaleLowerCase("de-DE").includes(term)
    );
  }, [search, session.modules]);

  const selectedDayEvents = useMemo(() => {
    const dayStart = startOfDay(overviewDate);
    return expandCalendarEvents(overviewEvents, dayStart, addDays(dayStart, 1));
  }, [overviewDate, overviewEvents]);

  const overviewIsToday = isSameDay(overviewDate, new Date());
  const overviewDayLabel = overviewIsToday
    ? "Heute"
    : new Intl.DateTimeFormat("de-DE", { weekday: "long" }).format(overviewDate);
  const overviewDateLabel = new Intl.DateTimeFormat("de-DE", {
    day: "2-digit",
    month: "long",
    year: overviewDate.getFullYear() === new Date().getFullYear() ? undefined : "numeric"
  }).format(overviewDate);

  const showLockedMessage = (message: string) => {
    setNotice(message);
    window.setTimeout(() => setNotice(""), 5000);
  };

  const openCatalogModule = (module: ModuleCatalogEntry) => {
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

  return (
    <main className="portal-home-screen portal-dashboard">
      <PortalGlobalHeader
        session={session}
        exchangeSyncStatus={exchangeSyncStatus}
        searchValue={activePage === "modules" ? search : ""}
        onSearchActivate={() => { if (activePage !== "modules") onNavigate("modules"); }}
        onSearchChange={setSearch}
        onGoHome={() => { setSearch(""); onNavigate("overview"); }}
        onSignOut={onSignOut}
        onSyncExchange={onSyncExchange}
      />

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

      </aside>

      <section className={`portal-dashboard-main ${activePage === "overview" ? "" : "portal-dashboard-feature-main"}`} aria-labelledby={activePage === "overview" ? "portal-today-title" : "portal-feature-title"}>
        {notice && <div className="portal-dashboard-notice" role="status"><LockKeyhole size={19} /> {notice}</div>}
        {activePage === "overview" ? (
          <>
            {/* Hero de boas-vindas temporariamente desativado para deixar a Übersicht mais limpa.
            <div className="portal-dashboard-hero">
              <div>
                <h1 id="portal-welcome-title">Willkommen zurück,<br /><strong>{account?.displayName || "im DMH Portal"}!</strong></h1>
              </div>
            </div>
            */}

            <section className="portal-overview" aria-labelledby="portal-today-title">
              <div className="portal-overview-day-navigation">
                <button type="button" aria-label="Vorheriger Tag" title="Vorheriger Tag" onClick={() => setOverviewDate((date) => addDays(date, -1))}>
                  <ChevronLeft size={25} />
                </button>
                <div>
                  <small id="portal-today-title">{overviewDayLabel}</small>
                  <strong>{overviewDateLabel}</strong>
                </div>
                <button type="button" aria-label="Nächster Tag" title="Nächster Tag" onClick={() => setOverviewDate((date) => addDays(date, 1))}>
                  <ChevronRight size={25} />
                </button>
                {!overviewIsToday && <button className="portal-overview-today-button" type="button" onClick={() => setOverviewDate(startOfDay(new Date()))}>Heute</button>}
              </div>
              <div className="portal-overview-grid">
                <article className="portal-overview-card">
                  <header><span><CheckCircle2 size={24} /></span><h3>Aufgaben</h3></header>
                  <div className="portal-overview-placeholder">
                    <strong>Alles Wichtige im Blick</strong>
                    <p>Offene Aufgaben erscheinen künftig hier. Überfälliges bleibt unter „Heute“ sichtbar.</p>
                  </div>
                </article>
                <article className="portal-overview-card">
                  <header><span><CalendarDays size={24} /></span><h3>Termine</h3><small>{selectedDayEvents.length}</small></header>
                  {selectedDayEvents.length > 0 ? (
                    <div className="portal-overview-event-list">
                      {selectedDayEvents.map((event) => {
                        const startsAt = parseCalendarDate(event.startsAt);
                        const time = event.exchangeIsAllDay
                          ? "Ganztägig"
                          : startsAt ? new Intl.DateTimeFormat("de-DE", { hour: "2-digit", minute: "2-digit" }).format(startsAt) : "";
                        return (
                          <article className="portal-overview-event" style={calendarColorStyle(event.color)} key={event.id}>
                            <span className="portal-overview-event-time"><Clock3 size={16} /> {time}</span>
                            <strong>{event.title || "Ohne Titel"}</strong>
                            {event.location && <small><MapPin size={14} /> {event.location}</small>}
                          </article>
                        );
                      })}
                    </div>
                  ) : (
                    <div className="portal-overview-placeholder">
                      <strong>Keine Termine</strong>
                      <p>Für diesen Tag sind keine Termine eingetragen.</p>
                    </div>
                  )}
                </article>
              </div>
            </section>
          </>
        ) : activePage === "modules" ? (
          <>
            <header className="portal-dashboard-feature-header">
              <small>DMH PORTAL</small>
              <h1 id="portal-feature-title">{pageTitles.modules.title}</h1>
              <p>{pageTitles.modules.description}</p>
            </header>
            <div className="portal-dashboard-section-title">
              <span><h2>Freigegeben</h2><i /></span>
              <small>{visibleModules.length} {visibleModules.length === 1 ? "Modul" : "Module"}</small>
            </div>
            <div className="portal-dashboard-modules">
              {visibleModules.map((module) => {
                const Icon = module.icon;
                return (
                  <article className={`portal-dashboard-module tone-${module.tone} enabled`} key={module.id}>
                    <div className="portal-dashboard-module-top">
                      <span className="portal-dashboard-module-icon"><Icon size={27} /></span>
                      <span><h3>{module.title}</h3></span>
                    </div>
                    <footer>
                      <span className="portal-dashboard-tag">{module.tag}</span>
                      <button type="button" onClick={() => openCatalogModule(module)}>Öffnen <ArrowRight size={20} /></button>
                    </footer>
                  </article>
                );
              })}
            </div>
            {visibleModules.length === 0 && (
              <div className="portal-dashboard-empty">
                <FileText size={35} />
                <strong>{search ? "Kein Modul gefunden" : "Noch keine Module freigegeben"}</strong>
                <p>{search ? "Versuchen Sie einen anderen Suchbegriff." : "Ihre EDV kann Ihnen hier Module freigeben."}</p>
              </div>
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
