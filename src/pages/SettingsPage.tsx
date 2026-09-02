import { useEffect, useMemo, useState, type KeyboardEvent as ReactKeyboardEvent } from "react";
import { AlertTriangle, CheckCircle2, ChevronDown, Download, Eye, EyeOff, Mail, RefreshCw, Search, Sparkles, Trash2, X } from "lucide-react";
import { PrinterSettings } from "../components/PrinterSettings";
import { StatusMessage } from "../components/StatusMessage";
import type { SettingsSection } from "../components/SettingsSubtabs";
import type { Page } from "../components/Sidebar";
import {
  getAppSetting,
  importOutlookAccount,
  listMailAccounts,
  revealMailPassword,
  removeMailAccount,
  scanOutlookAccounts,
  setAppSetting,
  testMailConnection
} from "../services/db";
import type { MailAccount, OutlookAccountCandidate } from "../types/mail";
import { deletionConfirmationSettingKey } from "../utils/settings";

interface SettingsPageProps {
  section?: SettingsSection;
  onNavigate?: (page: Page, section?: SettingsSection) => void;
  onStartOnboarding?: () => void;
}

interface SettingsSearchItem {
  id: string;
  label: string;
  description: string;
  keywords: string;
  page: Page;
  section: SettingsSection;
  targetId?: string;
  adminOnly?: boolean;
}

const settingsSearchItems: SettingsSearchItem[] = [
  { id: "mail", label: "E-Mail-Konten verwalten", description: "E-Mail & Konten → Konten", keywords: "e-mail mail konto konten outlook verwalten kennwort", page: "settings", section: "mail", targetId: "settings-mail-accounts" },
  { id: "printer", label: "Drucker hinzufügen", description: "Drucker → Netzwerkdrucker", keywords: "drucker printer netzwerk freigabe ip hinzufügen", page: "settings", section: "printer" },
  { id: "backup", label: "Sicherung öffnen", description: "Sicherung → Öffnen", keywords: "sicherung backup daten wiederherstellen export", page: "backup", section: "backup" },
  { id: "appearance", label: "Erscheinungsbild öffnen", description: "Erscheinungsbild → Darstellung", keywords: "erscheinungsbild thema farbe dunkel hell akzent", page: "appearance", section: "appearance" },
  { id: "advanced", label: "Optionale Bereiche", description: "Erweitert → optionale Bereiche", keywords: "erweitert optional 2fa passwörter dokumente", page: "feature-development", section: "advanced" },
  { id: "admin-tools", label: "Admin-Werkzeuge", description: "Erweitert → Wartung und Wiederherstellung", keywords: "admin zurücksetzen wiederherstellen wartung app löschen", page: "feature-development", section: "advanced", adminOnly: true }
];

export function SettingsPage({ section = "general", onNavigate = () => undefined, onStartOnboarding = () => undefined }: SettingsPageProps) {
  const administrativeToolsVisible = true;
  const [accounts, setAccounts] = useState<MailAccount[]>([]);
  const [candidates, setCandidates] = useState<OutlookAccountCandidate[]>([]);
  const [busyAction, setBusyAction] = useState<string | null>(null);
  const [message, setMessage] = useState("");
  const [messageType, setMessageType] = useState<"success" | "error" | "info">("info");
  const [searchQuery, setSearchQuery] = useState("");
  const [searchIndex, setSearchIndex] = useState(0);
  const [confirmDeletions, setConfirmDeletions] = useState(true);
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
      (!item.adminOnly || administrativeToolsVisible)
      && `${item.label} ${item.description} ${item.keywords}`.toLocaleLowerCase("de-DE").includes(query)
    );
  }, [administrativeToolsVisible, searchQuery]);

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
    getAppSetting(deletionConfirmationSettingKey)
      .then((value) => setConfirmDeletions(value !== "false"))
      .catch(() => setConfirmDeletions(true));
  }, []);

  const updateDeletionConfirmation = async (enabled: boolean) => {
    const previous = confirmDeletions;
    setConfirmDeletions(enabled);
    setBusyAction("confirm-deletions");
    try {
      await setAppSetting(deletionConfirmationSettingKey, enabled ? "true" : "false");
      setMessageType("success");
      setMessage(enabled ? "Löschbestätigungen wurden aktiviert." : "Löschbestätigungen wurden deaktiviert.");
    } catch (error) {
      setConfirmDeletions(previous);
      setMessageType("error");
      setMessage(`Einstellung konnte nicht gespeichert werden: ${error}`);
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

  return (
    <div className="page settings-page">
      <header className="page-header settings-page-header">
        <div>
          <h2>EDV Tools</h2>
          <p>Geschützter Bereich – Zugriff ausschließlich für die EDV.</p>
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
      </div>

      <StatusMessage message={message} type={messageType} />

      {section === "general" && (
        <div className="settings-overview">
          <section className="settings-overview-section">
            <h3>Bedienung</h3>
            <article className="settings-overview-card settings-preference-card">
              <span className="settings-overview-icon"><AlertTriangle size={27} aria-hidden="true" /></span>
              <div>
                <h3>Löschbestätigungen</h3>
                <p>Vor dem Löschen von Kontakten, Gruppen und Passwörtern nachfragen.</p>
              </div>
              <label className="settings-toggle" title="Löschbestätigungen ein- oder ausschalten">
                <input
                  type="checkbox"
                  checked={confirmDeletions}
                  disabled={busyAction === "confirm-deletions"}
                  onChange={(event) => void updateDeletionConfirmation(event.target.checked)}
                />
                <span>{confirmDeletions ? "Ein" : "Aus"}</span>
              </label>
            </article>
            <article className="settings-overview-card settings-preference-card">
              <span className="settings-overview-icon"><Sparkles size={27} aria-hidden="true" /></span>
              <div>
                <h3>Einführung und Datenübernahme</h3>
                <p>Die kurze Einführung erneut ansehen oder vorhandene Daten automatisch suchen.</p>
              </div>
              <button type="button" onClick={onStartOnboarding}><Sparkles size={18} /> Einführung starten</button>
            </article>
          </section>

        </div>
      )}

      {section === "mail" && (
        <div className="settings-detail-view">
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

      {section === "printer" && <PrinterSettings />}

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

    </div>
  );
}
