import { LoaderCircle, RefreshCw } from "lucide-react";
import { lazy, Suspense, useCallback, useEffect, useRef, useState } from "react";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { EdvAccessDialog } from "./components/EdvAccessDialog";
import { Sidebar, type Page } from "./components/Sidebar";
import { SettingsSubtabs, type SettingsSection } from "./components/SettingsSubtabs";
import { ContactsPage } from "./pages/ContactsPage";
import { CalendarPage } from "./pages/CalendarPage";
import { TrashPage } from "./pages/TrashPage";
import { UpdateNotifier } from "./components/UpdateNotifier";
import { SettingsPage } from "./pages/SettingsPage";
import { AppearancePage } from "./pages/AppearancePage";
import { PasswordsPage } from "./pages/PasswordsPage";
import { AuthenticatorPage } from "./pages/AuthenticatorPage";
import { BackupPage } from "./pages/BackupPage";
import { Microsoft365Page } from "./pages/Microsoft365Page";
import { SynchronizationsPage } from "./pages/SynchronizationsPage";
import { DocumentsPage } from "./pages/DocumentsPage";
import { FeatureDevelopmentPage } from "./pages/FeatureDevelopmentPage";
import { ExtrasPage } from "./pages/ExtrasPage";
import { createAutomaticBackup, createAutomaticPasswordBackup, getAppSetting, getBackupData, getVaultStatus, setAppSetting, syncOfflineDocuments } from "./services/db";
import type { VaultStatus } from "./types/vault";
import { addBrowserDataToBackup } from "./utils/backup";
import {
  clearFeatureOverrides,
  readFeatureAvailability,
  setFeatureOverride,
  type AppFeature
} from "./utils/featureFlags";
import {
  calendarAutomaticSyncStatusEventName,
  calendarChangedEventName,
  runAutomaticCalendarSync as performAutomaticCalendarSync,
  type CalendarAutomaticSyncStatus
} from "./utils/automaticCalendarSync";
import { onboardingCompletedSettingKey } from "./utils/settings";

const OnboardingDialog = lazy(() =>
  import("./components/OnboardingDialog").then((module) => ({ default: module.OnboardingDialog }))
);
const DataTransferPage = lazy(() =>
  import("./pages/DataTransferPage").then((module) => ({ default: module.DataTransferPage }))
);

const browserPreviewStatus: VaultStatus = {
  protectionEnabled: false,
  unlocked: true,
  username: "",
  recoveryEmail: "",
  recoveryEmailHint: "",
  recoveryAvailable: false,
  entryCount: 0
};

const edvPages = new Set<Page>(["settings", "appearance", "feature-development", "backup"]);

export default function App() {
  const isAdminTest = import.meta.env.VITE_APP_CHANNEL === "admin-test";
  const sourceCommit = import.meta.env.VITE_SOURCE_COMMIT?.slice(0, 8);
  const [page, setPage] = useState<Page>("contacts");
  const [settingsSection, setSettingsSection] = useState<SettingsSection>("general");
  const [featureAvailability, setFeatureAvailability] = useState(readFeatureAvailability);
  const [vaultStatus, setVaultStatus] = useState<VaultStatus | null>(null);
  const [startupError, setStartupError] = useState("");
  const [onboardingOpen, setOnboardingOpen] = useState(false);
  const [edvUnlocked, setEdvUnlocked] = useState(false);
  const [pendingEdvNavigation, setPendingEdvNavigation] = useState<{ page: Page; section?: SettingsSection } | null>(null);
  const automaticBackupPromise = useRef<Promise<void> | null>(null);
  const documentSyncPromise = useRef<Promise<void> | null>(null);
  const calendarSyncPromise = useRef<Promise<void> | null>(null);
  const queuedCalendarSyncTrigger = useRef<"open" | "change" | "poll" | null>(null);
  const closing = useRef(false);
  const settingsAreaOpen = page === "settings" || page === "appearance" || page === "feature-development" || page === "backup";

  const applyNavigation = (nextPage: Page, nextSection?: SettingsSection) => {
    if (nextPage === "services") return;
    if (nextPage === "authenticator" && !featureAvailability.authenticator) return;
    if (nextPage === "passwords" && !featureAvailability.passwords) return;
    if (nextPage === "documents" && !featureAvailability.documents) return;
    if (!edvPages.has(nextPage)) setEdvUnlocked(false);
    setPage(nextPage);
    if (nextSection) {
      setSettingsSection(nextSection);
      return;
    }
    if (nextPage === "settings") setSettingsSection("general");
    else if (nextPage === "appearance") setSettingsSection("appearance");
    else if (nextPage === "simple-import") setSettingsSection("import");
    else if (nextPage === "backup") setSettingsSection("backup");
    else if (nextPage === "synchronizations" || nextPage === "m365") setSettingsSection("sync");
    else if (nextPage === "trash") setSettingsSection("trash");
    else if (nextPage === "import" || nextPage === "export" || nextPage === "feature-development") setSettingsSection("advanced");
  };

  const navigate = (nextPage: Page, nextSection?: SettingsSection) => {
    if (edvPages.has(nextPage) && !edvUnlocked) {
      setPendingEdvNavigation({ page: nextPage, section: nextSection });
      return;
    }
    applyNavigation(nextPage, nextSection);
  };

  const unlockEdvTools = () => {
    const destination = pendingEdvNavigation ?? { page: "settings" as Page, section: "general" as SettingsSection };
    setEdvUnlocked(true);
    setPendingEdvNavigation(null);
    applyNavigation(destination.page, destination.section);
  };

  const changeFeatureAvailability = (feature: AppFeature, enabled: boolean) => {
    setFeatureAvailability(setFeatureOverride(feature, enabled));
  };

  const runAutomaticBackup = useCallback(async (snapshot = false): Promise<void> => {
    const isTauri = "__TAURI_INTERNALS__" in window;
    if (!isTauri) return;
    if (automaticBackupPromise.current) {
      await automaticBackupPromise.current;
      if (!snapshot) return;
    }

    const promise = (async () => {
      const backup = addBrowserDataToBackup(await getBackupData());
      await createAutomaticBackup(backup, snapshot);
      await createAutomaticPasswordBackup(snapshot);
    })();
    automaticBackupPromise.current = promise;
    try {
      await promise;
    } finally {
      if (automaticBackupPromise.current === promise) automaticBackupPromise.current = null;
    }
  }, []);

  const runDocumentSync = useCallback(async (): Promise<void> => {
    if (!("__TAURI_INTERNALS__" in window)) return;
    if (documentSyncPromise.current) return documentSyncPromise.current;
    const promise = syncOfflineDocuments().then(() => undefined);
    documentSyncPromise.current = promise;
    try { await promise; }
    finally { if (documentSyncPromise.current === promise) documentSyncPromise.current = null; }
  }, []);

  const runCalendarSync = useCallback(async (trigger: "open" | "change" | "poll"): Promise<void> => {
    if (!("__TAURI_INTERNALS__" in window)) return;
    if (calendarSyncPromise.current) {
      if (trigger === "change" || queuedCalendarSyncTrigger.current === null) queuedCalendarSyncTrigger.current = trigger;
      return;
    }
    const promise = (async () => {
      let nextTrigger: "open" | "change" | "poll" | null = trigger;
      while (nextTrigger) {
        const currentTrigger = nextTrigger;
        queuedCalendarSyncTrigger.current = null;
        try {
          const status = await performAutomaticCalendarSync(currentTrigger);
          if (status) {
            window.dispatchEvent(new CustomEvent<CalendarAutomaticSyncStatus>(calendarAutomaticSyncStatusEventName, { detail: status }));
          }
        } catch (error) {
          window.dispatchEvent(new CustomEvent<CalendarAutomaticSyncStatus>(calendarAutomaticSyncStatusEventName, {
            detail: {
              state: "error",
              message: `Automatische Microsoft-365-Synchronisierung fehlgeschlagen: ${error}`
            }
          }));
        }
        nextTrigger = queuedCalendarSyncTrigger.current;
      }
    })();
    calendarSyncPromise.current = promise;
    try {
      await promise;
    } finally {
      if (calendarSyncPromise.current === promise) calendarSyncPromise.current = null;
    }
  }, []);

  const loadVaultStatus = () => {
    setStartupError("");
    const localBrowserPreview = !("__TAURI_INTERNALS__" in window)
      && (window.location.hostname === "127.0.0.1" || window.location.hostname === "localhost");
    if (localBrowserPreview) {
      setVaultStatus(browserPreviewStatus);
      return;
    }
    getVaultStatus()
      .then(setVaultStatus)
      .catch((error) => setStartupError(String(error)));
  };

  useEffect(() => {
    loadVaultStatus();
  }, []);

  useEffect(() => {
    if (!vaultStatus) return;
    let cancelled = false;
    const localBrowserPreview = !("__TAURI_INTERNALS__" in window)
      && (window.location.hostname === "127.0.0.1" || window.location.hostname === "localhost");
    if (localBrowserPreview) {
      setOnboardingOpen(localStorage.getItem(onboardingCompletedSettingKey) !== "true");
      return;
    }
    getAppSetting(onboardingCompletedSettingKey)
      .then((value) => { if (!cancelled) setOnboardingOpen(value !== "true"); })
      .catch(() => { if (!cancelled) setOnboardingOpen(false); });
    return () => { cancelled = true; };
  }, [vaultStatus]);

  const completeOnboarding = async () => {
    const localBrowserPreview = !("__TAURI_INTERNALS__" in window)
      && (window.location.hostname === "127.0.0.1" || window.location.hostname === "localhost");
    if (localBrowserPreview) localStorage.setItem(onboardingCompletedSettingKey, "true");
    else await setAppSetting(onboardingCompletedSettingKey, "true");
    setOnboardingOpen(false);
  };

  useEffect(() => {
    if (!("__TAURI_INTERNALS__" in window)) return;
    let debounceTimer: number | undefined;
    const queueChangedCalendarSync = () => {
      if (debounceTimer !== undefined) window.clearTimeout(debounceTimer);
      debounceTimer = window.setTimeout(() => void runCalendarSync("change"), 1_200);
    };
    const startupTimer = window.setTimeout(() => void runCalendarSync("open"), 2_500);
    const pollingTimer = window.setInterval(() => {
      if (!document.hidden) void runCalendarSync("poll");
    }, 30_000);
    const syncWhenVisible = () => {
      if (!document.hidden) void runCalendarSync("poll");
    };
    window.addEventListener(calendarChangedEventName, queueChangedCalendarSync);
    document.addEventListener("visibilitychange", syncWhenVisible);
    return () => {
      window.removeEventListener(calendarChangedEventName, queueChangedCalendarSync);
      document.removeEventListener("visibilitychange", syncWhenVisible);
      window.clearTimeout(startupTimer);
      window.clearInterval(pollingTimer);
      if (debounceTimer !== undefined) window.clearTimeout(debounceTimer);
    };
  }, [runCalendarSync]);

  useEffect(() => {
    if (!("__TAURI_INTERNALS__" in window)) return;

    const interval = window.setInterval(() => {
      void runAutomaticBackup().catch(() => {
        // Backup failures must not interrupt normal contact/calendar work.
      });
    }, 15_000);
    const documentSyncInterval = window.setInterval(() => {
      void runDocumentSync().catch(() => {
        // Offline changes remain queued and are retried when the connection returns.
      });
    }, 45_000);
    void runAutomaticBackup().catch(() => {
      // The next interval or the close handler will retry automatically.
    });
    void runDocumentSync().catch(() => {
      // A missing connection is expected while the device is offline.
    });

    const appWindow = getCurrentWindow();
    const unlisten = appWindow.onCloseRequested(async (event) => {
      event.preventDefault();
      if (closing.current) return;
      closing.current = true;
      const closingTasks = Promise.allSettled([
        runDocumentSync(),
        runAutomaticBackup(true)
      ]);
      await Promise.race([
        closingTasks,
        new Promise<void>((resolve) => window.setTimeout(resolve, 4_000))
      ]);
      try {
        await appWindow.destroy();
      } catch (error) {
        closing.current = false;
        window.alert(`Die App konnte nicht geschlossen werden: ${error}`);
      }
    });

    return () => {
      window.clearInterval(interval);
      window.clearInterval(documentSyncInterval);
      void unlisten.then((dispose) => dispose());
    };
  }, [runAutomaticBackup, runDocumentSync]);

  if (!vaultStatus) {
    return (
      <main className="app-startup-screen">
        <img src="/dmh-kontakte-kalender.png" alt="DMH Backup" />
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

  return (
    <div className={isAdminTest ? "app-channel-root admin-test-root" : "app-channel-root"}>
      {isAdminTest && (
        <div className="admin-test-banner" role="status">
          ADMIN TEST · Isolierte Testdaten · Keine offizielle Version
          {sourceCommit && <span>Commit {sourceCommit}</span>}
        </div>
      )}
      <div className={settingsAreaOpen ? "app-shell settings-app-shell" : "app-shell"}>
        <Sidebar
          activePage={page}
          authenticatorEnabled={featureAvailability.authenticator}
          compact={settingsAreaOpen}
          documentsEnabled={featureAvailability.documents}
          onNavigate={navigate}
          passwordsEnabled={featureAvailability.passwords}
        />
        {settingsAreaOpen && <SettingsSubtabs activePage={page} activeSection={settingsSection} onNavigate={navigate} />}
        <main className="content">
          {page === "contacts" && <ContactsPage onNavigate={navigate} />}
          {page === "calendar" && <CalendarPage onNavigate={navigate} />}
          {page === "documents" && featureAvailability.documents && <DocumentsPage />}
          {page === "passwords" && featureAvailability.passwords && <PasswordsPage status={vaultStatus} onStatusChanged={setVaultStatus} />}
          {page === "authenticator" && featureAvailability.authenticator && <AuthenticatorPage />}
          {page === "feature-development" && (
            <FeatureDevelopmentPage
              availability={featureAvailability}
              onFeatureChange={changeFeatureAvailability}
              onReset={() => setFeatureAvailability(clearFeatureOverrides())}
            />
          )}
          {page === "m365" && <Microsoft365Page />}
          {page === "trash" && <TrashPage />}
          {page === "extras" && <ExtrasPage />}
          {page === "settings" && <SettingsPage section={settingsSection} onNavigate={navigate} onStartOnboarding={() => setOnboardingOpen(true)} />}
          {page === "appearance" && <AppearancePage />}
          {(page === "simple-import" || page === "import" || page === "contact-import" || page === "calendar-import" || page === "export") && (
            <Suspense fallback={<div className="page-loading"><LoaderCircle className="spin" size={28} /> Datenbereich wird geöffnet …</div>}>
              <DataTransferPage
                initialView={page === "export" ? "export" : page === "import" || page === "contact-import" || page === "calendar-import" ? "file-import" : "overview"}
                initialFileImportMode={page === "contact-import" ? "contacts" : page === "calendar-import" ? "calendar" : undefined}
              />
            </Suspense>
          )}
          {page === "backup" && <BackupPage />}
          {page === "synchronizations" && <SynchronizationsPage onNavigate={navigate} />}
        </main>
        <UpdateNotifier />
      </div>
      {onboardingOpen && (
        <Suspense fallback={null}>
          <OnboardingDialog
            onComplete={completeOnboarding}
          />
        </Suspense>
      )}
      {pendingEdvNavigation && <EdvAccessDialog onCancel={() => setPendingEdvNavigation(null)} onUnlocked={unlockEdvTools} />}
    </div>
  );
}
