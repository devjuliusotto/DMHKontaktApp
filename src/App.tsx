import { LoaderCircle, RefreshCw } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { AppLockScreen } from "./components/AppLockScreen";
import { Sidebar, type Page } from "./components/Sidebar";
import { SettingsSubtabs, type SettingsSection } from "./components/SettingsSubtabs";
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
import { AuthenticatorPage } from "./pages/AuthenticatorPage";
import { BackupPage } from "./pages/BackupPage";
import { Microsoft365Page } from "./pages/Microsoft365Page";
import { SynchronizationsPage } from "./pages/SynchronizationsPage";
import { DocumentsPage } from "./pages/DocumentsPage";
import { DienstleistungenPage } from "./pages/DienstleistungenPage";
import { createAutomaticBackup, createAutomaticPasswordBackup, getBackupData, getVaultStatus } from "./services/db";
import type { VaultStatus } from "./types/vault";
import { addBrowserDataToBackup } from "./utils/backup";

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
  const sourceCommit = import.meta.env.VITE_SOURCE_COMMIT?.slice(0, 8);
  const [page, setPage] = useState<Page>("contacts");
  const [settingsSection, setSettingsSection] = useState<SettingsSection>("general");
  const [vaultStatus, setVaultStatus] = useState<VaultStatus | null>(null);
  const [startupError, setStartupError] = useState("");
  const automaticBackupPromise = useRef<Promise<void> | null>(null);
  const closing = useRef(false);
  const settingsAreaOpen = page === "settings" || page === "appearance" || page === "simple-import" || page === "import" || page === "export" || page === "m365" || page === "trash" || page === "backup" || page === "synchronizations";

  const navigate = (nextPage: Page, nextSection?: SettingsSection) => {
    setPage(nextPage);
    if (nextSection) {
      setSettingsSection(nextSection);
      return;
    }
    if (nextPage === "settings") setSettingsSection("general");
    else if (nextPage === "appearance") setSettingsSection("appearance");
    else if (nextPage === "simple-import") setSettingsSection("import");
    else if (nextPage === "backup") setSettingsSection("backup");
    else if (nextPage === "synchronizations") setSettingsSection("sync");
    else if (nextPage === "trash") setSettingsSection("trash");
    else if (nextPage === "import" || nextPage === "export" || nextPage === "m365") setSettingsSection("advanced");
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
    if (!("__TAURI_INTERNALS__" in window)) return;

    const interval = window.setInterval(() => {
      void runAutomaticBackup().catch(() => {
        // Backup failures must not interrupt normal contact/calendar work.
      });
    }, 15_000);
    void runAutomaticBackup().catch(() => {
      // The next interval or the close handler will retry automatically.
    });

    const appWindow = getCurrentWindow();
    const unlisten = appWindow.onCloseRequested(async (event) => {
      if (closing.current) return;
      event.preventDefault();
      closing.current = true;
      window.clearInterval(interval);
      try {
        await runAutomaticBackup(true);
      } catch (error) {
        closing.current = false;
        const details = String(error).trim();
        window.alert(
          `Die interne automatische Sicherung konnte nicht abgeschlossen werden. Das App-Fenster bleibt geöffnet.${details ? `\n\nDetails: ${details}` : ""}`
        );
        return;
      }
      try {
        await appWindow.close();
      } catch {
        closing.current = false;
      }
    });

    return () => {
      window.clearInterval(interval);
      void unlisten.then((dispose) => dispose());
    };
  }, [runAutomaticBackup]);

  if (!vaultStatus) {
    return (
      <main className="app-startup-screen">
        <img src="/dmh-kontakte-kalender.png" alt="DMH Kontakte und Kalender" />
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
        <Sidebar activePage={page} onNavigate={navigate} compact={settingsAreaOpen} />
        {settingsAreaOpen && <SettingsSubtabs activePage={page} activeSection={settingsSection} onNavigate={navigate} />}
        <main className="content">
          {(page === "import" || page === "export" || page === "m365") && <AdvancedSubtabs activePage={page} onNavigate={navigate} />}
          {page === "contacts" && <ContactsPage />}
          {page === "calendar" && <CalendarPage />}
          {page === "documents" && <DocumentsPage onNavigate={navigate} />}
          {page === "services" && <DienstleistungenPage />}
          {page === "passwords" && <PasswordsPage status={vaultStatus} onStatusChanged={setVaultStatus} />}
          {page === "authenticator" && <AuthenticatorPage />}
          {page === "import" && <ImportPage />}
          {page === "export" && <ExportPage />}
          {page === "m365" && <Microsoft365Page />}
          {page === "trash" && <TrashPage />}
          {page === "settings" && <SettingsPage section={settingsSection} onNavigate={navigate} />}
          {page === "appearance" && <AppearancePage />}
          {page === "simple-import" && <SimpleImportPage />}
          {page === "backup" && <BackupPage />}
          {page === "synchronizations" && <SynchronizationsPage onNavigate={navigate} />}
        </main>
        <UpdateNotifier />
      </div>
    </div>
  );
}
