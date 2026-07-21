import { useEffect, useMemo, useState } from "react";
import { AlertTriangle, CalendarDays, CheckCircle2, ChevronDown, Download, Eye, EyeOff, LoaderCircle, Mail, RefreshCw, Send, ShieldCheck, Trash2, Undo2, UsersRound } from "lucide-react";
import { MigrationCaptureDialog } from "../components/MigrationCaptureDialog";
import { OutlookContactImportDialog } from "../components/OutlookContactImportDialog";
import { StatusMessage } from "../components/StatusMessage";
import {
  importOutlookAccount,
  importOutlookClassicAppointmentsOnce,
  getMigrationCaptureStatus,
  listMailAccounts,
  revealMailPassword,
  removeMailAccount,
  scanOutlookAccounts,
  testMailConnection,
  undoLastOutlookContactImport
} from "../services/db";
import type { CalendarEvent } from "../types/calendar";
import type { OutlookContactImportResult } from "../types/contact";
import type { MailAccount, MigrationCaptureResult, MigrationCaptureStatus, OutlookAccountCandidate } from "../types/mail";

const calendarStorageKey = "agendakontakte.calendarEvents";

function storedCalendarEvents(): CalendarEvent[] {
  const raw = localStorage.getItem(calendarStorageKey);
  if (!raw) return [];
  const value: unknown = JSON.parse(raw);
  if (!Array.isArray(value)) throw new Error("Die lokal gespeicherten Kalenderdaten sind beschädigt.");
  return value as CalendarEvent[];
}

export function SettingsPage() {
  const [accounts, setAccounts] = useState<MailAccount[]>([]);
  const [candidates, setCandidates] = useState<OutlookAccountCandidate[]>([]);
  const [busyAction, setBusyAction] = useState<string | null>(null);
  const [message, setMessage] = useState("");
  const [messageType, setMessageType] = useState<"success" | "error" | "info">("info");
  const [migrationStatus, setMigrationStatus] = useState<MigrationCaptureStatus | null>(null);
  const [migrationDialogOpen, setMigrationDialogOpen] = useState(false);
  const [contactImportDialogOpen, setContactImportDialogOpen] = useState(false);
  const [revealedPassword, setRevealedPassword] = useState<{
    accountId: number;
    accountLabel: string;
    password: string;
  } | null>(null);

  const importedIds = useMemo(
    () => new Set(accounts.map((account) => account.sourceAccountId.toLowerCase())),
    [accounts]
  );

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

  const contactsImported = (result: OutlookContactImportResult, source: "classic" | "csv") => {
    setMessageType("success");
    setMessage(
      `${result.imported} Kontakte aus ${source === "classic" ? "Outlook Classic" : "dem neuen Outlook"} wurden einmalig übernommen. `
      + `${result.skippedExactDuplicates} bereits vorhandene und ${result.skippedConflicts} nicht ausgewählte Konflikte wurden ausgelassen. Es besteht keine Synchronisierung.`
    );
  };

  const undoOutlookContactImport = async () => {
    const confirmed = window.confirm(
      "Den letzten Outlook-Kontaktimport rückgängig machen? Nur Kontakte aus diesem Importvorgang werden entfernt."
    );
    if (!confirmed) return;
    setBusyAction("undo-outlook-contact-import");
    setMessageType("info");
    setMessage("Letzter Outlook-Kontaktimport wird rückgängig gemacht …");
    try {
      const deleted = await undoLastOutlookContactImport();
      setMessageType(deleted > 0 ? "success" : "info");
      setMessage(deleted > 0
        ? `${deleted} Kontakte aus dem letzten Outlook-Import wurden entfernt.`
        : "Es wurde kein Outlook-Kontaktimport gefunden, der rückgängig gemacht werden kann.");
    } catch (error) {
      setMessageType("error");
      setMessage(`Der letzte Outlook-Kontaktimport konnte nicht rückgängig gemacht werden: ${error}`);
    } finally {
      setBusyAction(null);
    }
  };

  const importAppointmentsOnce = async () => {
    const confirmed = window.confirm(
      "Alle Termine aus allen erreichbaren Kalenderordnern des aktuellen Outlook-Classic-Profils einmalig in DMH Kontakte und Kalender kopieren?\n\nOutlook wird nicht verändert und es wird keine automatische Synchronisierung eingerichtet. Bereits importierte Termine werden ausgelassen."
    );
    if (!confirmed) return;

    setBusyAction("import-outlook-appointments-once");
    setMessageType("info");
    setMessage("Alle erreichbaren Outlook-Kalender werden gelesen. Dies kann einige Minuten dauern …");
    try {
      const result = await importOutlookClassicAppointmentsOnce();
      const existing = storedCalendarEvents();
      const eventsById = new Map(existing.map((event) => [event.id, event]));
      let imported = 0;
      for (const event of result.events) {
        if (eventsById.has(event.id)) continue;
        eventsById.set(event.id, event);
        imported += 1;
      }
      localStorage.setItem(calendarStorageKey, JSON.stringify(Array.from(eventsById.values())));
      const duplicates = result.events.length - imported;
      setMessageType("success");
      setMessage(
        result.found === 0
          ? "In den erreichbaren Outlook-Kalendern wurden keine Termine gefunden."
          : `${imported} von ${result.found} Outlook-Terminen wurden einmalig übernommen. ${duplicates} bereits vorhandene und ${result.skippedInvalid} nicht lesbare Einträge wurden ausgelassen. Es besteht keine Synchronisierung.`
      );
    } catch (error) {
      setMessageType("error");
      setMessage(`Outlook-Termine konnten nicht importiert werden: ${error}`);
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

  return (
    <div className="page settings-page">
      <header className="page-header">
        <div>
          <h2>Einstellungen</h2>
          <p>Outlook-Daten übernehmen und E-Mail-Zugänge verwalten.</p>
        </div>
      </header>

      <StatusMessage message={message} type={messageType} />

      <section className="form-panel settings-task-panel">
        <div className="settings-task-heading">
          <Download size={25} aria-hidden="true" />
          <div>
            <h3>Aus Outlook übernehmen</h3>
            <p>Einmalig kopieren. Outlook bleibt unverändert.</p>
          </div>
        </div>
        <div className="settings-action-grid">
          <button className="settings-action-button" type="button" onClick={() => setContactImportDialogOpen(true)} disabled={busyAction !== null}>
            <UsersRound size={25} />
            <span>
              <strong>Kontakte suchen und importieren</strong>
              <small>Quellen und mögliche Duplikate vorher prüfen</small>
            </span>
          </button>
          <button className="settings-action-button" type="button" onClick={importAppointmentsOnce} disabled={busyAction !== null}>
            {busyAction === "import-outlook-appointments-once" ? <LoaderCircle className="spin" size={25} /> : <CalendarDays size={25} />}
            <span>
              <strong>{busyAction === "import-outlook-appointments-once" ? "Kalender werden gelesen …" : "Termine importieren"}</strong>
              <small>Aus allen Outlook-Kalendern</small>
            </span>
          </button>
        </div>
        <button className="settings-undo-import" type="button" onClick={undoOutlookContactImport} disabled={busyAction !== null}>
          {busyAction === "undo-outlook-contact-import" ? <LoaderCircle className="spin" size={17} /> : <Undo2 size={17} />}
          Letzten Outlook-Kontaktimport rückgängig machen
        </button>
      </section>

      <section className="form-panel settings-migration-panel">
        <div className="settings-task-heading">
          <ShieldCheck size={25} aria-hidden="true" />
          <div>
            <h3>E-Mail-Umstellung</h3>
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
          </div>
        </div>
        <button
          className="primary settings-migration-button"
          type="button"
          onClick={() => setMigrationDialogOpen(true)}
          disabled={busyAction !== null || !migrationStatus?.configured || migrationStatus.completed}
        >
          <Send size={19} /> Sicher an EDV senden
        </button>
      </section>

      <details className="form-panel settings-mail-panel">
        <summary>
          <span className="settings-summary-icon"><Mail size={24} aria-hidden="true" /></span>
          <div>
            <h3>E-Mail-Konten</h3>
            <p>Kennwort anzeigen oder ein Outlook-Konto hinzufügen</p>
          </div>
          {accounts.length > 0 && <span className="settings-account-count">{accounts.length}</span>}
          <ChevronDown className="settings-summary-chevron" size={21} aria-hidden="true" />
        </summary>

        <div className="settings-mail-content">
          <button className="primary" type="button" onClick={scan} disabled={busyAction !== null}>
            <RefreshCw size={20} className={busyAction === "scan" ? "spin" : ""} />
            Konto aus Outlook hinzufügen
          </button>

          {candidates.length > 0 && (
            <div className="settings-found-accounts" aria-label="Gefundene Outlook-Konten">
              <h4>In Outlook gefunden</h4>
              {candidates.map((candidate) => {
                const imported = importedIds.has(candidate.sourceAccountId.toLowerCase());
                const title = candidate.accountName || candidate.email || candidate.incomingUser;
                return (
                  <article className="settings-account-row" key={candidate.sourceAccountId}>
                    <div>
                      <strong>{title}</strong>
                      <span>{candidate.email || candidate.incomingUser}</span>
                      <small className={candidate.passwordAvailable ? "credential-available" : "credential-missing"}>
                        {candidate.passwordAvailable ? "Kennwort gespeichert" : "Kein Kennwort gespeichert"}
                      </small>
                    </div>
                    <button type="button" onClick={() => importAccount(candidate)} disabled={busyAction !== null || !candidate.passwordAvailable}>
                      {imported ? <RefreshCw size={18} /> : <Download size={18} />}
                      {imported ? "Aktualisieren" : "Hinzufügen"}
                    </button>
                  </article>
                );
              })}
            </div>
          )}

          {accounts.length > 0 && (
            <div className="settings-saved-accounts">
              <h4>Gespeicherte Konten</h4>
              {accounts.map((account) => (
                <article className="settings-account-row" key={account.id}>
                  <div>
                    <strong>{account.accountName || account.email}</strong>
                    <span>{account.email}</span>
                  </div>
                  <div className="inline-actions">
                    <button type="button" onClick={() => testAccount(account)} disabled={busyAction !== null} title="Verbindung prüfen">
                      <CheckCircle2 size={18} /> Prüfen
                    </button>
                    <button type="button" onClick={() => revealPassword(account)} disabled={busyAction !== null}>
                      <Eye size={18} /> Kennwort anzeigen
                    </button>
                    <button className="danger-button" type="button" onClick={() => removeAccount(account)} disabled={busyAction !== null} title="Konto entfernen">
                      <Trash2 size={18} /> Entfernen
                    </button>
                  </div>
                </article>
              ))}
            </div>
          )}
        </div>
      </details>

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
      />
      <OutlookContactImportDialog
        open={contactImportDialogOpen}
        onClose={() => setContactImportDialogOpen(false)}
        onImported={contactsImported}
      />
    </div>
  );
}
