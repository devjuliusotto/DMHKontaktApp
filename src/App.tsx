import { LoaderCircle, RefreshCw } from "lucide-react";
import { useEffect, useState } from "react";
import { AppLockScreen } from "./components/AppLockScreen";
import { Sidebar, type Page } from "./components/Sidebar";
import { SettingsSubtabs } from "./components/SettingsSubtabs";
import { ContactsPage } from "./pages/ContactsPage";
import { ExportPage } from "./pages/ExportPage";
import { ImportPage } from "./pages/ImportPage";
import { CalendarPage } from "./pages/CalendarPage";
import { TrashPage } from "./pages/TrashPage";
import { UpdateNotifier } from "./components/UpdateNotifier";
import { SettingsPage } from "./pages/SettingsPage";
import { PasswordsPage } from "./pages/PasswordsPage";
import { getVaultStatus } from "./services/db";
import type { VaultStatus } from "./types/vault";

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
  const [page, setPage] = useState<Page>("contacts");
  const [vaultStatus, setVaultStatus] = useState<VaultStatus | null>(null);
  const [startupError, setStartupError] = useState("");
  const settingsAreaOpen = page === "settings" || page === "import" || page === "export" || page === "trash";

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
    <div className="app-shell">
      <Sidebar activePage={page} onNavigate={setPage} />
      <main className="content">
        {settingsAreaOpen && <SettingsSubtabs activePage={page} onNavigate={setPage} />}
        {page === "contacts" && <ContactsPage />}
        {page === "calendar" && <CalendarPage />}
        {page === "passwords" && <PasswordsPage status={vaultStatus} onStatusChanged={setVaultStatus} />}
        {page === "import" && <ImportPage />}
        {page === "export" && <ExportPage />}
        {page === "trash" && <TrashPage />}
        {page === "settings" && <SettingsPage />}
      </main>
      <UpdateNotifier />
    </div>
  );
}
