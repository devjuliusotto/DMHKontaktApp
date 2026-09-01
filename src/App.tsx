import { LoaderCircle, RefreshCw } from "lucide-react";
import { lazy, Suspense, useCallback, useEffect, useRef, useState } from "react";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { AppLockScreen } from "./components/AppLockScreen";
import { WelcomeSignIn } from "./components/WelcomeSignIn";
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
import { DienstleistungenPage } from "./pages/DienstleistungenPage";
import { FeatureDevelopmentPage } from "./pages/FeatureDevelopmentPage";
import { createAutomaticBackup, createAutomaticPasswordBackup, getAppSetting, getBackupData, getVaultStatus, setAppSetting, syncOfflineDocuments } from "./services/db";
import type { VaultStatus } from "./types/vault";
import { addBrowserDataToBackup } from "./utils/backup";
import {
  canManageDevelopmentFeatures,
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
import { readActiveLocalSession, type LocalAccountSession } from "./utils/localAuth";

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

export default function App() {
  const isAdminTest = import.meta.env.VITE_APP_CHANNEL === "admin-test";
  const developmentControlsVisible = canManageDevelopmentFeatures();
  const sourceCommit = import.meta.env.VITE_SOURCE_COMMIT?.slice(0, 8);
  const [page, setPage] = useState<Page>("contacts");
  const [settingsSection, setSettingsSection] = useState<SettingsSection>("general");
  const [featureAvailability, setFeatureAvailability] = useState(readFeatureAvailability);
  const [vaultStatus, setVaultStatus] = useState<VaultStatus | null>(null);
  const [startupError, setStartupError] = useState("");
  const [onboardingOpen, setOnboardingOpen] = useState(false);
  const [signedInAccount, setSignedInAccount] = useState<LocalAccountSession | null>(readActiveLocalSession);
  const [newAccountNeedsOnboarding, setNewAccountNeedsOnboarding] = useState(false);
  const automaticBackupPromise = useRef<Promise<void> | null>(null);
  const documentSyncPromise = useRef<Promise<void> | null>(null);
  const calendarSyncPromise = useRef<Promise<void> | null>(null);
  const queuedCalendarSyncTrigger = useRef<"open" | "change" | "poll" | null>(null);
  const closing = useRef(false);
  const settingsAreaOpen = page === "settings" || page === "appearance" || page === "simple-import" || page === "import" || page === "export" || page === "feature-development" || page === "m365" || page === "trash" || page === "backup" || page === "synchronizations";

  const navigate = (nextPage: Page, nextSection?: SettingsSection) => {
    if (nextPage === "services" && !featureAvailability.services) return;
    if (nextPage === "authenticator" && !featureAvailability.authenticator) return;
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
    if (!signedInAccount || !vaultStatus || (vaultStatus.protectionEnabled && !vaultStatus.unlocked)) return;
    if (newAccountNeedsOnboarding) {
      setOnboardingOpen(true);
      return;
    }
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
  }, [newAccountNeedsOnboarding, signedInAccount, vaultStatus]);

  const completeOnboarding = async () => {
    const localBrowserPreview = !("__TAURI_INTERNALS__" in window)
      && (window.location.hostname === "127.0.0.1" || window.location.hostname === "localhost");
    if (localBrowserPreview) localStorage.setItem(onboardingCompletedSettingKey, "true");
    else await setAppSetting(onboardingCompletedSettingKey, "true");
    setNewAccountNeedsOnboarding(false);
    setOnboardingOpen(false);
  };

  const finishAuthentication = (session: LocalAccountSession, isNewAccount: boolean) => {
    setSignedInAccount(session);
    setNewAccountNeedsOnboarding(isNewAccount);
    if (isNewAccount) setOnboardingOpen(true);
  };

  useEffect(() => {
    if (!("__TAURI_INTERNALS__" in window) || !vaultStatus || (vaultStatus.protectionEnabled && !vaultStatus.unlocked)) return;
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
  }, [runCalendarSync, vaultStatus]);

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

  if (!signedInAccount) {
    return <WelcomeSignIn onAuthenticated={finishAuthentication} />;
  }

  if (!vaultStatus) {
    return (
      <main className="app-startup-screen">
        <img src="/dmh-kontakte-kalender.png" alt="DMH Portal - Privat" />
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
      <div className={settingsAreaOpen ? "app-shell settings-app-shell" : "app-shell"}>
        <Sidebar
          activePage={page}
          authenticatorEnabled={featureAvailability.authenticator}
          compact={settingsAreaOpen}
          onNavigate={navigate}
          servicesEnabled={featureAvailability.services}
        />
        {settingsAreaOpen && <SettingsSubtabs activePage={page} activeSection={settingsSection} onNavigate={navigate} />}
        <main className="content">
          {page === "contacts" && <ContactsPage />}
          {page === "calendar" && <CalendarPage />}
          {page === "documents" && <DocumentsPage />}
          {page === "services" && featureAvailability.services && <DienstleistungenPage />}
          {page === "passwords" && <PasswordsPage status={vaultStatus} onStatusChanged={setVaultStatus} />}
          {page === "authenticator" && featureAvailability.authenticator && <AuthenticatorPage />}
          {page === "feature-development" && (
            <FeatureDevelopmentPage
              availability={featureAvailability}
              onFeatureChange={changeFeatureAvailability}
              onReset={() => setFeatureAvailability(clearFeatureOverrides())}
              showAdminFeatures={developmentControlsVisible}
            />
          )}
          {page === "m365" && <Microsoft365Page />}
          {page === "trash" && <TrashPage />}
          {page === "settings" && <SettingsPage section={settingsSection} onNavigate={navigate} onStartOnboarding={() => setOnboardingOpen(true)} />}
          {page === "appearance" && <AppearancePage />}
          {page === "simple-import" && (
            <Suspense fallback={<div className="page-loading"><LoaderCircle className="spin" size={28} /> Datenbereich wird geöffnet …</div>}>
              <DataTransferPage />
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
            authenticatorEnabled={featureAvailability.authenticator}
            servicesEnabled={featureAvailability.services}
            onComplete={completeOnboarding}
          />
        </Suspense>
      )}
    </div>
  );
}
