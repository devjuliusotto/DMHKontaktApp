import { LoaderCircle, RefreshCw } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import { AppLockScreen } from "./components/AppLockScreen";
import { PortalLoginScreen } from "./components/PortalLoginScreen";
import { Sidebar, type Page } from "./components/Sidebar";
import { SettingsSubtabs } from "./components/SettingsSubtabs";
import { AdvancedSubtabs } from "./components/AdvancedSubtabs";
import { ContactsPage } from "./pages/ContactsPage";
import { ExportPage } from "./pages/ExportPage";
import { ImportPage } from "./pages/ImportPage";
import { CalendarPage } from "./pages/CalendarPage";
import { TrashPage } from "./pages/TrashPage";
import { UpdateNotifier } from "./components/UpdateNotifier";
import { SettingsPage } from "./pages/SettingsPage";
import { AppearancePage } from "./pages/AppearancePage";
import { SimpleImportPage } from "./pages/SimpleImportPage";
import { PasswordsPage } from "./pages/PasswordsPage";
import { BackupPage } from "./pages/BackupPage";
import { Microsoft365Page } from "./pages/Microsoft365Page";
import { disconnectMicrosoft365Account, getPortalSession, getVaultStatus, restorePortalSession, syncExchangeData } from "./services/db";
import type { ExchangeSyncStatus, PortalSession } from "./types/m365";
import type { VaultStatus } from "./types/vault";
import {
  applyExchangeSyncResult,
  exchangeSyncRequestedEvent,
  publishExchangeSyncStatus,
  readCalendarSyncData
} from "./utils/exchangeSync";

const browserPreviewStatus: VaultStatus = {
  protectionEnabled: false,
  unlocked: true,
  username: "",
  recoveryEmail: "",
  recoveryEmailHint: "",
  recoveryAvailable: false,
  entryCount: 0
};

const browserPreviewPortalSession: PortalSession = {
  configured: true,
  state: "authenticated",
  account: {
    id: "browser-preview",
    displayName: "Lokale Vorschau",
    email: "preview@dmh.local",
    userPrincipalName: "preview@dmh.local",
    connectedAt: new Date().toISOString(),
    tenantId: "browser-preview",
    groupIds: [],
    lastValidatedAt: new Date().toISOString()
  },
  rememberSignIn: false,
  authorizationConfigured: true,
  modules: ["privatschwestern", "edv"],
  message: ""
};

const browserLoginPreviewSession: PortalSession = {
  configured: true,
  state: "signed_out",
  account: null,
  rememberSignIn: false,
  authorizationConfigured: true,
  modules: [],
  message: ""
};

export default function App() {
  const isAdminTest = import.meta.env.VITE_APP_CHANNEL === "admin-test";
  const sourceCommit = import.meta.env.VITE_SOURCE_COMMIT?.slice(0, 8);
  const [page, setPage] = useState<Page>("contacts");
  const [portalSession, setPortalSession] = useState<PortalSession | null>(null);
  const [portalError, setPortalError] = useState("");
  const [vaultStatus, setVaultStatus] = useState<VaultStatus | null>(null);
  const [startupError, setStartupError] = useState("");
  const [exchangeSyncStatus, setExchangeSyncStatus] = useState<ExchangeSyncStatus>(() => ({
    state: "idle",
    lastSyncedAt: localStorage.getItem("agendakontakte.exchangeLastSync") ?? undefined
  }));
  const exchangeSyncRunning = useRef(false);
  const settingsAreaOpen = page === "settings" || page === "appearance" || page === "simple-import" || page === "import" || page === "export" || page === "m365" || page === "trash" || page === "backup";

  const isPortalLoginPreview = () => new URLSearchParams(window.location.search).has("portal-login-preview");
  const isBrowserPreview = () => !isPortalLoginPreview() && !("__TAURI_INTERNALS__" in window)
    && (window.location.hostname === "127.0.0.1" || window.location.hostname === "localhost");

  const loadVaultStatus = () => {
    setStartupError("");
    if (isBrowserPreview()) {
      setVaultStatus(browserPreviewStatus);
      return;
    }
    getVaultStatus()
      .then(setVaultStatus)
      .catch((error) => setStartupError(String(error)));
  };

  useEffect(() => {
    if (isPortalLoginPreview()) {
      setPortalSession(browserLoginPreviewSession);
      return;
    }
    if (isBrowserPreview()) {
      setPortalSession(browserPreviewPortalSession);
      return;
    }
    restorePortalSession()
      .then(setPortalSession)
      .catch(async (error) => {
        setPortalError(String(error));
        try {
          setPortalSession(await getPortalSession());
        } catch {
          setPortalSession({
            configured: false,
            state: "configuration_required",
            account: null,
            rememberSignIn: false,
            authorizationConfigured: false,
            modules: [],
            message: ""
          });
        }
      });
  }, []);

  const currentModuleAllowed = portalSession?.modules.includes("privatschwestern") ?? false;

  const synchronizeExchange = useCallback(async () => {
    if (isBrowserPreview() || exchangeSyncRunning.current || portalSession?.state !== "authenticated") return;
    exchangeSyncRunning.current = true;
    const syncingStatus: ExchangeSyncStatus = {
      state: "syncing",
      lastSyncedAt: localStorage.getItem("agendakontakte.exchangeLastSync") ?? undefined,
      message: "Kontakte und Kalender werden mit Exchange synchronisiert."
    };
    setExchangeSyncStatus(syncingStatus);
    publishExchangeSyncStatus(syncingStatus);
    try {
      const calendar = readCalendarSyncData();
      const result = await syncExchangeData(calendar.calendarEvents, calendar.deletedCalendarEvents);
      applyExchangeSyncResult(result);
      const syncedStatus: ExchangeSyncStatus = {
        state: "synced",
        lastSyncedAt: result.syncedAt,
        message: "Kontakte und Kalender sind mit Exchange synchronisiert.",
        result
      };
      setExchangeSyncStatus(syncedStatus);
      publishExchangeSyncStatus(syncedStatus);
    } catch (error) {
      const errorStatus: ExchangeSyncStatus = {
        state: "error",
        lastSyncedAt: localStorage.getItem("agendakontakte.exchangeLastSync") ?? undefined,
        message: String(error)
      };
      setExchangeSyncStatus(errorStatus);
      publishExchangeSyncStatus(errorStatus);
    } finally {
      exchangeSyncRunning.current = false;
    }
  }, [portalSession?.state]);

  useEffect(() => {
    if (portalSession && currentModuleAllowed) loadVaultStatus();
    else setVaultStatus(null);
  }, [portalSession, currentModuleAllowed]);

  useEffect(() => {
    if (portalSession?.state === "offline") {
      const offlineStatus: ExchangeSyncStatus = {
        state: "offline",
        lastSyncedAt: localStorage.getItem("agendakontakte.exchangeLastSync") ?? undefined,
        message: "Offline: Änderungen bleiben lokal und werden bei der nächsten Verbindung synchronisiert."
      };
      setExchangeSyncStatus(offlineStatus);
      publishExchangeSyncStatus(offlineStatus);
      return;
    }
    if (portalSession?.state !== "authenticated" || !currentModuleAllowed || isBrowserPreview()) return;
    let debounceTimer: number | undefined;
    const initialTimer = window.setTimeout(() => void synchronizeExchange(), 1_200);
    const interval = window.setInterval(() => void synchronizeExchange(), 5 * 60 * 1000);
    const requestSync = () => {
      if (debounceTimer) window.clearTimeout(debounceTimer);
      debounceTimer = window.setTimeout(() => void synchronizeExchange(), 1_500);
    };
    window.addEventListener(exchangeSyncRequestedEvent, requestSync);
    window.addEventListener("online", requestSync);
    return () => {
      window.clearTimeout(initialTimer);
      window.clearInterval(interval);
      if (debounceTimer) window.clearTimeout(debounceTimer);
      window.removeEventListener(exchangeSyncRequestedEvent, requestSync);
      window.removeEventListener("online", requestSync);
    };
  }, [currentModuleAllowed, portalSession?.state, synchronizeExchange]);

  const signOut = async () => {
    await disconnectMicrosoft365Account();
    setPage("contacts");
    setVaultStatus(null);
    setExchangeSyncStatus({ state: "idle" });
    setPortalSession(await getPortalSession());
  };

  if (!portalSession) {
    return (
      <main className="app-startup-screen">
        <img src="/dmh-kontakte-kalender.png" alt="DMH Portal" />
        <LoaderCircle className="spin" size={30} />
        <p>DMH Portal wird vorbereitet …</p>
      </main>
    );
  }

  if (!currentModuleAllowed || !["authenticated", "offline"].includes(portalSession.state)) {
    const loginSession = portalSession.state === "authenticated" || portalSession.state === "offline"
      ? { ...portalSession, state: "access_denied" as const }
      : portalSession;
    return (
      <PortalLoginScreen
        session={loginSession}
        startupError={portalError}
        onSessionChanged={(session) => {
          setPortalError("");
          setPortalSession(session);
        }}
      />
    );
  }

  if (!vaultStatus) {
    return (
      <main className="app-startup-screen">
        <img src="/dmh-kontakte-kalender.png" alt="DMH Portal" />
        {startupError ? (
          <>
            <h1>App konnte nicht sicher geöffnet werden</h1>
            <p>{startupError}</p>
            <button className="primary" type="button" onClick={loadVaultStatus}><RefreshCw size={21} /> Erneut versuchen</button>
          </>
        ) : (
          <><LoaderCircle className="spin" size={30} /><p>Lokale Daten werden vorbereitet …</p></>
        )}
      </main>
    );
  }

  if (vaultStatus.protectionEnabled && !vaultStatus.unlocked) {
    return <AppLockScreen status={vaultStatus} onUnlocked={setVaultStatus} />;
  }

  return (
    <div className={isAdminTest ? "app-channel-root admin-test-root" : "app-channel-root"}>
      {isAdminTest && (
        <div className="admin-test-banner" role="status">
          ADMIN TEST · Isolierte Testdaten · Keine offizielle Version
          {sourceCommit && <span>Commit {sourceCommit}</span>}
        </div>
      )}
      <div className="app-shell">
        <Sidebar
          activePage={page}
          account={portalSession.account}
          offline={portalSession.state === "offline"}
          exchangeSyncStatus={exchangeSyncStatus}
          onNavigate={setPage}
          onSignOut={signOut}
          onSyncExchange={synchronizeExchange}
        />
        <main className="content">
          {settingsAreaOpen && <SettingsSubtabs activePage={page} onNavigate={setPage} />}
          {(page === "import" || page === "export" || page === "m365") && <AdvancedSubtabs activePage={page} onNavigate={setPage} />}
          {page === "contacts" && <ContactsPage />}
          {page === "calendar" && <CalendarPage />}
          {page === "passwords" && <PasswordsPage status={vaultStatus} onStatusChanged={setVaultStatus} />}
          {page === "import" && <ImportPage />}
          {page === "export" && <ExportPage />}
          {page === "m365" && <Microsoft365Page syncStatus={exchangeSyncStatus} onSync={synchronizeExchange} />}
          {page === "trash" && <TrashPage />}
          {page === "settings" && <SettingsPage />}
          {page === "appearance" && <AppearancePage />}
          {page === "simple-import" && <SimpleImportPage />}
          {page === "backup" && <BackupPage />}
        </main>
        <UpdateNotifier />
      </div>
    </div>
  );
}
