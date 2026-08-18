import { useEffect, useMemo, useState, type KeyboardEvent as ReactKeyboardEvent } from "react";
import { save } from "@tauri-apps/plugin-dialog";
import { AlertTriangle, ArchiveRestore, CheckCircle2, ChevronDown, Download, Eye, EyeOff, FileText, Mail, RefreshCw, RotateCcw, Search, Send, ShieldCheck, Trash2, X } from "lucide-react";
import { MigrationCaptureDialog } from "../components/MigrationCaptureDialog";
import { StatusMessage } from "../components/StatusMessage";
import type { SettingsSection } from "../components/SettingsSubtabs";
import type { Page } from "../components/Sidebar";
import {
  getMigrationDiagnosticLog,
  createAutomaticBackup,
  getBackupData,
  importOutlookAccount,
  getMigrationCaptureStatus,
  listMailAccounts,
  revealMailPassword,
  removeMailAccount,
  restoreAutomaticBackup,
  resetLocalAppData,
  resetMigrationCaptureStatus,
  restartApp,
  scanOutlookAccounts,
  testMailConnection,
  writeExportFile
} from "../services/db";
import type { MailAccount, MigrationCaptureResult, MigrationCaptureStatus, OutlookAccountCandidate } from "../types/mail";
import { addBrowserDataToBackup, restoreBrowserDataFromBackup } from "../utils/backup";

interface SettingsPageProps {
  section?: SettingsSection;
  onNavigate?: (page: Page, section?: SettingsSection) => void;
}

interface SettingsSearchItem {
  id: string;
  label: string;
  description: string;
  keywords: string;
  page: Page;
  section: SettingsSection;
  targetId?: string;
}

const settingsSearchItems: SettingsSearchItem[] = [
  { id: "mail", label: "E-Mail-Konten verwalten", description: "E-Mail & Konten → Konten", keywords: "e-mail mail konto konten outlook verwalten kennwort", page: "settings", section: "mail", targetId: "settings-mail-accounts" },
  { id: "backup", label: "Sicherung öffnen", description: "Sicherung → Öffnen", keywords: "sicherung backup daten wiederherstellen export", page: "backup", section: "backup" },
  { id: "appearance", label: "Erscheinungsbild öffnen", description: "Erscheinungsbild → Darstellung", keywords: "erscheinungsbild thema farbe dunkel hell akzent", page: "appearance", section: "appearance" },
  { id: "import", label: "Import öffnen", description: "Import → Kontakte und Termine", keywords: "import outlook thunderbird kontakte termine", page: "simple-import", section: "import" },
  { id: "sync", label: "Synchronisierungen öffnen", description: "Synchronisierungen → Microsoft 365 und Datenbereiche", keywords: "synchronisierung sync microsoft 365 exchange kontakte kalender verbundene apps", page: "synchronizations", section: "sync" },
  { id: "advanced", label: "Erweiterte Funktionen öffnen", description: "Erweitert → Import, Export und Microsoft 365", keywords: "erweitert advanced import export microsoft 365", page: "import", section: "advanced" },
  { id: "trash", label: "Papierkorb öffnen", description: "Papierkorb → Gelöschte Daten", keywords: "papierkorb gelöscht wiederherstellen löschen", page: "trash", section: "trash" },
  { id: "edv", label: "Sicher an EDV senden", description: "Allgemein → Status", keywords: "edv umstellung migration sicher senden", page: "settings", section: "general", targetId: "settings-migration-status" }
];

export function SettingsPage({ section = "general", onNavigate = () => undefined }: SettingsPageProps) {
  const [accounts, setAccounts] = useState<MailAccount[]>([]);
  const [candidates, setCandidates] = useState<OutlookAccountCandidate[]>([]);
  const [busyAction, setBusyAction] = useState<string | null>(null);
  const [message, setMessage] = useState("");
  const [messageType, setMessageType] = useState<"success" | "error" | "info">("info");
  const [migrationStatus, setMigrationStatus] = useState<MigrationCaptureStatus | null>(null);
  const [migrationDialogOpen, setMigrationDialogOpen] = useState(false);
  const [automaticRestoreVisible, setAutomaticRestoreVisible] = useState(false);
  const [hiddenRestoreClicks, setHiddenRestoreClicks] = useState(0);
  const [searchQuery, setSearchQuery] = useState("");
  const [searchIndex, setSearchIndex] = useState(0);
  const [revealedPassword, setRevealedPassword] = useState<{
    accountId: number;
    accountLabel: string;
    password: string;
  } | null>(null);

  const importedIds = useMemo(
    () => new Set(accounts.map((account) => account.sourceAccountId.toLowerCase())),
    [accounts]
  );

  const searchResults = useMemo(() => {
    const query = searchQuery.trim().toLocaleLowerCase("de-DE");
    if (!query) return [];
    return settingsSearchItems.filter((item) =>
      `${item.label} ${item.description} ${item.keywords}`.toLocaleLowerCase("de-DE").includes(query)
    );
  }, [searchQuery]);

  const selectSearchItem = (item: SettingsSearchItem) => {
    setSearchQuery("");
    setSearchIndex(0);
    onNavigate(item.page, item.section);
    if (item.targetId) {
      window.setTimeout(() => document.getElementById(item.targetId ?? "")?.scrollIntoView({ behavior: "smooth", block: "center" }), 100);
    }
  };

  const refreshAccounts = async () => {
    const result = await listMailAccounts();
    setAccounts(result);
  };

  useEffect(() => {
    refreshAccounts().catch((error) => {
      setMessageType("error");
      setMessage(`Gespeicherte E-Mail-Konten konnten nicht geladen werden: ${error}`);
    });
    getMigrationCaptureStatus()
      .then(setMigrationStatus)
      .catch(() => {
        setMigrationStatus({ configured: false, completed: false, completedAt: null });
      });
  }, []);

  const migrationCompleted = (result: MigrationCaptureResult) => {
    setMigrationStatus({ configured: true, completed: true, completedAt: result.completedAt });
    setMessageType("success");
    setMessage("Die E-Mail-Konfiguration wurde verschlüsselt an die EDV übertragen.");
  };

  const migrationFailed = (error: string) => {
    setMessageType("error");
    setMessage(`EDV-Übertragung fehlgeschlagen: ${error} Exportieren Sie den Diagnosebericht unten und senden Sie ihn an die EDV.`);
  };

  const exportMigrationDiagnostic = async () => {
    setBusyAction("export-diagnostic");
    setMessage("");
    try {
      const content = await getMigrationDiagnosticLog();
      const target = await save({
        defaultPath: `DMH-EDV-Diagnose-${new Date().toISOString().slice(0, 10)}.log`,
        filters: [{ name: "Diagnosebericht", extensions: ["log", "txt"] }]
      });
      if (!target) return;
      await writeExportFile(target, content);
      setMessageType("success");
      setMessage("Der datenschutzfreundliche EDV-Diagnosebericht wurde gespeichert.");
    } catch (error) {
      setMessageType("error");
      setMessage(`Diagnosebericht konnte nicht gespeichert werden: ${error}`);
    } finally {
      setBusyAction(null);
    }
  };

  const reopenMigrationCapture = async () => {
    const confirmed = window.confirm(
      "EDV-Übertragung erneut freigeben?\n\nDer bisherige lokale Abschlussvermerk wird entfernt. Die vorhandene Übertragungs-ID bleibt erhalten, damit die EDV einen erneuten Versand möglichst als denselben Vorgang erkennen kann."
    );
    if (!confirmed) return;

    setBusyAction("reopen-migration");
    setMessage("");
    try {
      const status = await resetMigrationCaptureStatus();
      setMigrationStatus(status);
      setMessageType("success");
      setMessage("„Sicher an EDV senden“ ist wieder freigegeben.");
    } catch (error) {
      setMessageType("error");
      setMessage(`EDV-Übertragung konnte nicht erneut freigegeben werden: ${error}`);
    } finally {
      setBusyAction(null);
    }
  };

  const resetApplication = async () => {
    const confirmed = window.confirm(
      "App vollständig zurücksetzen?\n\nDabei werden unwiderruflich alle lokalen Kontakte, Gruppen, Kalender, Papierkorb-Daten, E-Mail-Konten, vom App angelegten Credential-Manager-Einträge, Passwort-Speicher-Einträge, Einstellungen, Importverläufe, interne Sicherungen und Diagnoseberichte dieses Apps gelöscht. Die externe automatische Sicherung in Dokumente bleibt erhalten.\n\nDaten in Outlook und Exchange sowie die installierte App selbst bleiben unverändert."
    );
    if (!confirmed) return;
    const typed = window.prompt(
      "Letzte Sicherheitsabfrage: Tippen Sie ZURÜCKSETZEN, um alle lokalen App-Daten zu löschen."
    );
    if (typed !== "ZURÜCKSETZEN") {
      setMessageType("info");
      setMessage("Zurücksetzen wurde abgebrochen. Es wurden keine Daten gelöscht.");
      return;
    }

    setBusyAction("reset-application");
    setMessage("");
    try {
      // Capture browser-side calendar data before localStorage is cleared.
      const backup = addBrowserDataToBackup(await getBackupData());
      await createAutomaticBackup(backup, true);
      await resetLocalAppData();
      localStorage.clear();
      await restartApp();
    } catch (error) {
      setMessageType("error");
      setMessage(`App konnte nicht vollständig zurückgesetzt werden: ${error}`);
      setBusyAction(null);
    }
  };

  const revealAutomaticRestore = () => {
    setHiddenRestoreClicks((clicks) => {
      const nextClicks = clicks + 1;
      if (nextClicks >= 7) {
        setAutomaticRestoreVisible(true);
        return 0;
      }
      return nextClicks;
    });
  };

  const restoreAutomaticArchive = async () => {
    const confirmed = window.confirm(
      "Diese Funktion ist ausschließlich für eine Wiederherstellung zusammen mit der EDV im Büro vorgesehen. Nicht selbstständig ausführen.\n\nFortfahren?"
    );
    if (!confirmed) return;

    const authorization = window.prompt(
      "Geben Sie den von der EDV vor Ort mitgeteilten Freigabecode ein (Format EDV-...)."
    );
    if (!authorization?.trim()) return;

    const finalConfirmation = window.prompt(
      "Letzte Sicherheitsabfrage: Tippen Sie WIEDERHERSTELLEN, nachdem die EDV die aktuelle Sicherung geprüft hat."
    );
    if (finalConfirmation !== "WIEDERHERSTELLEN") {
      setMessageType("info");
      setMessage("Wiederherstellung abgebrochen. Es wurden keine Daten verändert.");
      return;
    }

    setBusyAction("restore-automatic-backup");
    setMessage("");
    try {
      const result = await restoreAutomaticBackup(authorization.trim());
      restoreBrowserDataFromBackup(result);
      setMessageType("success");
      setMessage(
        result.passwordsRestored
          ? "Kontakte, Kalender und verschlüsselte Kennwort-Sicherung wurden wiederhergestellt. Die App wird neu geladen."
          : "Kontakte und Kalender wurden wiederhergestellt. Eine Kennwort-Sicherung war nicht vorhanden. Die App wird neu geladen."
      );
      window.setTimeout(() => window.location.reload(), 700);
    } catch (error) {
      setMessageType("error");
      setMessage(`Automatische Sicherung konnte nicht wiederhergestellt werden: ${error}`);
    } finally {
      setBusyAction(null);
    }
  };

  useEffect(() => {
    if (!revealedPassword) return;

    const hidePassword = () => setRevealedPassword(null);
    const hideWhenPageIsHidden = () => {
      if (document.hidden) hidePassword();
    };
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") hidePassword();
    };
    const timeout = window.setTimeout(hidePassword, 60_000);

    window.addEventListener("blur", hidePassword);
    window.addEventListener("keydown", handleKeyDown);
    document.addEventListener("visibilitychange", hideWhenPageIsHidden);
    return () => {
      window.clearTimeout(timeout);
      window.removeEventListener("blur", hidePassword);
      window.removeEventListener("keydown", handleKeyDown);
      document.removeEventListener("visibilitychange", hideWhenPageIsHidden);
    };
  }, [revealedPassword]);

  const scan = async () => {
    setBusyAction("scan");
    setMessage("");
    try {
      const result = await scanOutlookAccounts();
      setCandidates(result);
      setMessageType("success");
      setMessage(
        result.length === 0
          ? "Im aktuellen Outlook-Classic-Profil wurde kein IMAP-Konto gefunden."
          : `${result.length} ${result.length === 1 ? "IMAP-Konto" : "IMAP-Konten"} in Outlook Classic gefunden.`
      );
    } catch (error) {
      setMessageType("error");
      setMessage(`Outlook-Konten konnten nicht gelesen werden: ${error}`);
    } finally {
      setBusyAction(null);
    }
  };

  const importAccount = async (candidate: OutlookAccountCandidate) => {
    setBusyAction(`import-${candidate.sourceAccountId}`);
    setMessage("");
    try {
      await importOutlookAccount(candidate.sourceAccountId);
      await refreshAccounts();
      setMessageType("success");
      setMessage(
        `„${candidate.accountName || candidate.email}“ wurde importiert. Das Kennwort liegt ausschließlich im Windows Credential Manager.`
      );
    } catch (error) {
      setMessageType("error");
      setMessage(`IMAP-Konto konnte nicht importiert werden: ${error}`);
    } finally {
      setBusyAction(null);
    }
  };

  const testAccount = async (account: MailAccount) => {
    setBusyAction(`test-${account.id}`);
    setMessage("");
    try {
      await testMailConnection(account.id);
      setMessageType("success");
      setMessage(`IMAP-Anmeldung für „${account.accountName || account.email}“ war erfolgreich.`);
    } catch (error) {
      setMessageType("error");
      setMessage(`IMAP-Verbindung konnte nicht bestätigt werden: ${error}`);
    } finally {
      setBusyAction(null);
    }
  };

  const revealPassword = async (account: MailAccount) => {
    const accountLabel = account.accountName || account.email;
    const confirmed = window.confirm(
      `E-Mail-Kennwort aus Outlook für „${accountLabel}“ sichtbar anzeigen?\n\nAchten Sie darauf, dass niemand auf den Bildschirm schaut. Das Kennwort wird nach 60 Sekunden oder beim Verlassen des Fensters automatisch verborgen.`
    );
    if (!confirmed) return;

    setRevealedPassword(null);
    setBusyAction(`reveal-${account.id}`);
    setMessage("");
    try {
      const result = await revealMailPassword(account.id);
      if (!document.hasFocus()) {
        setMessageType("info");
        setMessage("Das Kennwort wurde nicht angezeigt, weil das App-Fenster nicht mehr aktiv war. Versuchen Sie es bei Bedarf erneut.");
        return;
      }
      setRevealedPassword({ accountId: account.id, accountLabel, password: result.password });
      setMessageType("info");
      setMessage("Das E-Mail-Kennwort wird vorübergehend angezeigt und nicht in der App-Datenbank gespeichert.");
    } catch (error) {
      setMessageType("error");
      setMessage(`E-Mail-Kennwort konnte nicht angezeigt werden: ${error}`);
    } finally {
      setBusyAction(null);
    }
  };

  const removeAccount = async (account: MailAccount) => {
    const confirmed = window.confirm(
      `„${account.accountName || account.email}“ entfernen? Dabei werden auch die zugehörigen Kennwörter aus dem Windows Credential Manager gelöscht.`
    );
    if (!confirmed) return;

    if (revealedPassword?.accountId === account.id) setRevealedPassword(null);

    setBusyAction(`remove-${account.id}`);
    setMessage("");
    try {
      await removeMailAccount(account.id);
      await refreshAccounts();
      setMessageType("success");
      setMessage("E-Mail-Konto und lokale Credential-Manager-Einträge wurden entfernt.");
    } catch (error) {
      setMessageType("error");
      setMessage(`E-Mail-Konto konnte nicht entfernt werden: ${error}`);
    } finally {
      setBusyAction(null);
    }
  };

  const handleSearchKeyDown = (event: ReactKeyboardEvent<HTMLInputElement>) => {
    if (event.key === "ArrowDown") {
      event.preventDefault();
      setSearchIndex((index) => searchResults.length === 0 ? 0 : (index + 1) % searchResults.length);
    } else if (event.key === "ArrowUp") {
      event.preventDefault();
      setSearchIndex((index) => searchResults.length === 0 ? 0 : (index - 1 + searchResults.length) % searchResults.length);
    } else if (event.key === "Enter" && searchResults[searchIndex]) {
      event.preventDefault();
      selectSearchItem(searchResults[searchIndex]);
    } else if (event.key === "Escape") {
      setSearchQuery("");
      setSearchIndex(0);
    }
  };

  const migrationSummary = (
    <>
      {migrationStatus === null && <p>Verfügbarkeit wird geprüft …</p>}
      {migrationStatus && !migrationStatus.configured && (
        <p className="settings-state error"><AlertTriangle size={16} /> Bitte EDV informieren.</p>
      )}
      {migrationStatus?.configured && !migrationStatus.completed && (
        <p className="settings-state ready"><CheckCircle2 size={16} /> Bereit zur sicheren Übertragung</p>
      )}
      {migrationStatus?.completed && (
        <p className="settings-state ready">
          <CheckCircle2 size={16} />
          {migrationStatus.completedAt
            ? `Zuletzt an die EDV gesendet: ${new Intl.DateTimeFormat("de-DE", { dateStyle: "medium", timeStyle: "short" }).format(new Date(migrationStatus.completedAt))}`
            : "Daten wurden bereits sicher an die EDV gesendet."}
        </p>
      )}
    </>
  );

  return (
    <div className="page settings-page">
      <header className="page-header settings-page-header">
        <div>
          <h2 onClick={revealAutomaticRestore}>Einstellungen</h2>
          <p>Verwalten Sie App-Einstellungen und lokale Daten.</p>
        </div>
      </header>

      <div className="settings-search-shell">
        <label className="settings-search-box" htmlFor="settings-search">
          <Search size={23} aria-hidden="true" />
          <input
            id="settings-search"
            type="search"
            value={searchQuery}
            placeholder="Suche nach einer Einstellung oder Funktion"
            autoComplete="off"
            onChange={(event) => {
              setSearchQuery(event.target.value);
              setSearchIndex(0);
            }}
            onKeyDown={handleSearchKeyDown}
            aria-expanded={searchResults.length > 0}
            aria-controls="settings-search-results"
          />
          {searchQuery && (
            <button className="settings-search-clear" type="button" onClick={() => { setSearchQuery(""); setSearchIndex(0); }} aria-label="Suche leeren">
              <X size={18} />
            </button>
          )}
        </label>
        {searchResults.length > 0 && (
          <div className="settings-search-results" id="settings-search-results" role="listbox" aria-label="Suchergebnisse">
            {searchResults.map((item, index) => (
              <button
                className={index === searchIndex ? "settings-search-result active" : "settings-search-result"}
                key={item.id}
                type="button"
                role="option"
                aria-selected={index === searchIndex}
                onMouseEnter={() => setSearchIndex(index)}
                onClick={() => selectSearchItem(item)}
              >
                <strong>{item.label}</strong>
                <span>{item.description}</span>
              </button>
            ))}
          </div>
        )}
        <div className="settings-search-chips" aria-label="Schnellsuche-Vorschläge">
          <span>Schnellsuche-Vorschläge:</span>
          <button className="settings-search-chip" type="button" onClick={() => selectSearchItem(settingsSearchItems[0])}>
            <Mail size={16} /> E-Mail-Konten verwalten
          </button>
          <button className="settings-search-chip" type="button" onClick={() => selectSearchItem(settingsSearchItems[1])}>
            <ShieldCheck size={16} /> Sicherung öffnen
          </button>
        </div>
      </div>

      <StatusMessage message={message} type={messageType} />

      {section === "general" && (
        <div className="settings-overview">
          <section className="settings-overview-section" id="settings-migration-status">
            <h3>Status</h3>
            <article className="settings-overview-card">
              <span className="settings-overview-icon"><ShieldCheck size={27} aria-hidden="true" /></span>
              <div>
                <h3>E-Mail-Umstellung</h3>
                {migrationSummary}
              </div>
              <button
                className="primary"
                type="button"
                onClick={() => setMigrationDialogOpen(true)}
                disabled={busyAction !== null || !migrationStatus?.configured || migrationStatus.completed}
              >
                <Send size={18} /> Sicher an EDV senden
              </button>
            </article>
          </section>

          <section className="settings-overview-section">
            <h3>Konten</h3>
            <article className="settings-overview-card" id="settings-mail-card">
              <span className="settings-overview-icon"><Mail size={27} aria-hidden="true" /></span>
              <div>
                <h3>{accounts.length} E-Mail-Konten eingerichtet</h3>
                <p>Outlook-Konten verwalten</p>
              </div>
              <button type="button" onClick={() => onNavigate("settings", "mail")}>
                Verwalten
              </button>
            </article>
          </section>

          <section className="settings-overview-section">
            <h3>Datensicherheit</h3>
            <article className="settings-overview-card">
              <span className="settings-overview-icon"><ArchiveRestore size={27} aria-hidden="true" /></span>
              <div>
                <h3>Sicherung</h3>
                <p>Lokale Daten sichern und wiederherstellen</p>
              </div>
              <button type="button" onClick={() => onNavigate("backup", "backup")}>Öffnen</button>
            </article>
          </section>

          {automaticRestoreVisible && (
            <section className="form-panel settings-support-panel">
              <div className="settings-task-heading">
                <ArchiveRestore size={25} aria-hidden="true" />
                <div>
                  <h3>EDV-Wiederherstellung der automatischen Sicherung</h3>
                  <p>Verdeckte Notfallfunktion. Nur zusammen mit der EDV im Büro und erst nach Prüfung der Sicherungsdatei verwenden. Kontakte, Kalender und verschlüsselte Kennwörter werden durch den Sicherungsstand ersetzt.</p>
                </div>
              </div>
              <button type="button" onClick={restoreAutomaticArchive} disabled={busyAction !== null}>
                <ArchiveRestore size={19} /> Automatische Sicherung mit EDV wiederherstellen
              </button>
            </section>
          )}

          <section className="settings-danger-zone">
            <h3>Gefahrenzone</h3>
            <section className="form-panel settings-reset-panel">
              <div className="settings-task-heading">
                <AlertTriangle size={25} aria-hidden="true" />
                <div>
                  <h3>App vollständig zurücksetzen</h3>
                  <p>Löscht sämtliche lokalen App-Daten und startet die App anschließend wie bei der ersten Verwendung. Dadurch wird auch „Sicher an EDV senden“ wieder verfügbar. Outlook und Exchange werden nicht verändert.</p>
                </div>
              </div>
              <button className="danger-button" type="button" onClick={resetApplication} disabled={busyAction !== null}>
                <Trash2 size={18} /> Alle lokalen Daten löschen und App neu starten
              </button>
            </section>
          </section>
        </div>
      )}

      {section === "mail" && (
        <div className="settings-detail-view">
          <section className="form-panel settings-migration-panel" id="settings-migration-status">
            <div className="settings-task-heading">
              <ShieldCheck size={25} aria-hidden="true" />
              <div>
                <h3>E-Mail-Umstellung</h3>
                {migrationSummary}
              </div>
            </div>
            <button className="primary settings-migration-button" type="button" onClick={() => setMigrationDialogOpen(true)} disabled={busyAction !== null || !migrationStatus?.configured || migrationStatus.completed}>
              <Send size={19} /> Sicher an EDV senden
            </button>
          </section>

          <details className="form-panel settings-support-panel">
            <summary>
              <span className="settings-summary-icon"><FileText size={24} aria-hidden="true" /></span>
              <div><h3>EDV-Diagnose und erneutes Senden</h3><p>Fehlerursache sicher eingrenzen oder die Übertragung erneut freigeben</p></div>
              <ChevronDown className="settings-summary-chevron" size={21} aria-hidden="true" />
            </summary>
            <div className="settings-support-content">
              <div className="settings-diagnostic-note"><ShieldCheck size={20} aria-hidden="true" /><p>Der Diagnosebericht enthält ausschließlich technische Schritte, Zeitangaben, Statuscodes und eine Diagnose-ID – keine Kennwörter, E-Mail-Adressen, Servernamen oder übertragenen Inhalte.</p></div>
              <div className="inline-actions">
                <button type="button" onClick={exportMigrationDiagnostic} disabled={busyAction !== null}><FileText size={18} /> Diagnosebericht speichern</button>
                <button type="button" onClick={reopenMigrationCapture} disabled={busyAction !== null || !migrationStatus?.configured}><RotateCcw size={18} /> EDV-Übertragung erneut freigeben</button>
              </div>
            </div>
          </details>

          <details className="form-panel settings-mail-panel" id="settings-mail-accounts" open>
            <summary>
              <span className="settings-summary-icon"><Mail size={24} aria-hidden="true" /></span>
              <div><h3>E-Mail-Konten</h3><p>Kennwort anzeigen oder ein Outlook-Konto hinzufügen</p></div>
              {accounts.length > 0 && <span className="settings-account-count">{accounts.length}</span>}
              <ChevronDown className="settings-summary-chevron" size={21} aria-hidden="true" />
            </summary>
            <div className="settings-mail-content">
              <button className="primary" type="button" onClick={scan} disabled={busyAction !== null}><RefreshCw size={20} className={busyAction === "scan" ? "spin" : ""} /> Konto aus Outlook hinzufügen</button>
              {candidates.length > 0 && (
                <div className="settings-found-accounts" aria-label="Gefundene Outlook-Konten">
                  <h4>In Outlook gefunden</h4>
                  {candidates.map((candidate) => {
                    const imported = importedIds.has(candidate.sourceAccountId.toLowerCase());
                    const title = candidate.accountName || candidate.email || candidate.incomingUser;
                    return <article className="settings-account-row" key={candidate.sourceAccountId}>
                      <div><strong>{title}</strong><span>{candidate.email || candidate.incomingUser}</span><small className={candidate.passwordAvailable ? "credential-available" : "credential-missing"}>{candidate.passwordAvailable ? "Kennwort gespeichert" : "Kein Kennwort gespeichert"}</small></div>
                      <button type="button" onClick={() => importAccount(candidate)} disabled={busyAction !== null || !candidate.passwordAvailable}>{imported ? <RefreshCw size={18} /> : <Download size={18} />}{imported ? "Aktualisieren" : "Hinzufügen"}</button>
                    </article>;
                  })}
                </div>
              )}
              {accounts.length > 0 && (
                <div className="settings-saved-accounts">
                  <h4>Gespeicherte Konten</h4>
                  {accounts.map((account) => <article className="settings-account-row" key={account.id}>
                    <div><strong>{account.accountName || account.email}</strong><span>{account.email}</span></div>
                    <div className="inline-actions">
                      <button type="button" onClick={() => testAccount(account)} disabled={busyAction !== null} title="Verbindung prüfen"><CheckCircle2 size={18} /> Prüfen</button>
                      <button type="button" onClick={() => revealPassword(account)} disabled={busyAction !== null}><Eye size={18} /> Kennwort anzeigen</button>
                      <button className="danger-button" type="button" onClick={() => removeAccount(account)} disabled={busyAction !== null} title="Konto entfernen"><Trash2 size={18} /> Entfernen</button>
                    </div>
                  </article>)}
                </div>
              )}
            </div>
          </details>
        </div>
      )}

      {revealedPassword && (
        <div className="modal-backdrop" role="presentation" onMouseDown={() => setRevealedPassword(null)}>
          <section
            className="form-panel modal-card password-reveal-dialog"
            role="dialog"
            aria-modal="true"
            aria-labelledby="password-reveal-title"
            onMouseDown={(event) => event.stopPropagation()}
          >
            <div className="password-reveal-heading">
              <Eye size={28} aria-hidden="true" />
              <div>
                <h3 id="password-reveal-title">E-Mail-Kennwort aus Outlook</h3>
                <p>{revealedPassword.accountLabel}</p>
              </div>
            </div>
            <div className="password-reveal-warning" role="note">
              Dies ist das in Outlook gespeicherte Kennwort für den E-Mail-Server. Schreiben Sie es bei Bedarf auf Papier ab und bewahren Sie den Zettel sicher auf.
            </div>
            <label className="password-reveal-field">
              <span>Kennwort</span>
              <input
                type="text"
                value={revealedPassword.password}
                readOnly
                autoFocus
                autoComplete="off"
                spellCheck={false}
                onFocus={(event) => event.currentTarget.select()}
              />
            </label>
            <p className="password-reveal-timeout">
              Die Anzeige schließt sich nach 60 Sekunden, beim Wechsel in ein anderes Fenster oder mit Esc. Das Kennwort wird nicht in die Zwischenablage kopiert.
            </p>
            <div className="button-row password-reveal-actions">
              <button className="primary" type="button" onClick={() => setRevealedPassword(null)}>
                <EyeOff size={19} /> Kennwort wieder verbergen
              </button>
            </div>
          </section>
        </div>
      )}

      <MigrationCaptureDialog
        open={migrationDialogOpen}
        onClose={() => setMigrationDialogOpen(false)}
        onCompleted={migrationCompleted}
        onFailed={migrationFailed}
      />
    </div>
  );
}
