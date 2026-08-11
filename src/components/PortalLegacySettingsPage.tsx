import { ArchiveRestore } from "lucide-react";
import { useState } from "react";
import { AppearancePage } from "../pages/AppearancePage";
import { BackupPage } from "../pages/BackupPage";
import { ExportPage } from "../pages/ExportPage";
import { ImportPage } from "../pages/ImportPage";
import { Microsoft365Page } from "../pages/Microsoft365Page";
import { SettingsPage } from "../pages/SettingsPage";
import { SimpleImportPage } from "../pages/SimpleImportPage";
import { TrashPage } from "../pages/TrashPage";
import type { ExchangeSyncStatus } from "../types/m365";
import { AdvancedSubtabs } from "./AdvancedSubtabs";
import type { Page } from "./Sidebar";
import { SettingsSubtabs } from "./SettingsSubtabs";

type LegacySettingsPage = Exclude<Page, "contacts" | "calendar" | "passwords">;

interface PortalLegacySettingsPageProps {
  exchangeSyncStatus: ExchangeSyncStatus;
  onSyncExchange: () => Promise<void>;
}

export function PortalLegacySettingsPage({ exchangeSyncStatus, onSyncExchange }: PortalLegacySettingsPageProps) {
  const [activePage, setActivePage] = useState<LegacySettingsPage>("settings");
  const advancedOpen = activePage === "import" || activePage === "export" || activePage === "m365";

  const navigate = (page: Page) => {
    if (page !== "contacts" && page !== "calendar" && page !== "passwords") setActivePage(page);
  };

  return (
    <section className="portal-legacy-settings" aria-labelledby="legacy-settings-title">
      <header className="portal-legacy-settings-header">
        <span className="portal-legacy-settings-icon"><ArchiveRestore size={25} /></span>
        <span>
          <small>ÜBERNOMMENE EINSTELLUNGEN</small>
          <h2 id="legacy-settings-title">Altes Modul</h2>
          <p>Alle bisherigen Einstellungen, Importe, Sicherungen und Microsoft-365-Werkzeuge bleiben hier vollständig erhalten.</p>
        </span>
      </header>

      <SettingsSubtabs activePage={activePage} onNavigate={navigate} />
      {advancedOpen && <AdvancedSubtabs activePage={activePage} onNavigate={navigate} />}

      <div className="portal-legacy-settings-content">
        {activePage === "settings" && <SettingsPage />}
        {activePage === "appearance" && <AppearancePage />}
        {activePage === "simple-import" && <SimpleImportPage />}
        {activePage === "backup" && <BackupPage />}
        {activePage === "import" && <ImportPage />}
        {activePage === "export" && <ExportPage />}
        {activePage === "m365" && <Microsoft365Page syncStatus={exchangeSyncStatus} onSync={onSyncExchange} />}
        {activePage === "trash" && <TrashPage />}
      </div>
    </section>
  );
}
