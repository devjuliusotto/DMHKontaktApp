import { useEffect, useMemo, useState } from "react";
import { CheckCircle2, Download, RefreshCw, ShieldCheck, Trash2 } from "lucide-react";
import { StatusMessage } from "../components/StatusMessage";
import { sqliteSchema } from "../db/schema";
import {
  importOutlookAccount,
  listMailAccounts,
  removeMailAccount,
  scanOutlookAccounts,
  testMailConnection
} from "../services/db";
import type { MailAccount, OutlookAccountCandidate } from "../types/mail";

export function SettingsPage() {
  const [accounts, setAccounts] = useState<MailAccount[]>([]);
  const [candidates, setCandidates] = useState<OutlookAccountCandidate[]>([]);
  const [busyAction, setBusyAction] = useState<string | null>(null);
  const [message, setMessage] = useState("");
  const [messageType, setMessageType] = useState<"success" | "error" | "info">("info");

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
  }, []);

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

  const removeAccount = async (account: MailAccount) => {
    const confirmed = window.confirm(
      `„${account.accountName || account.email}“ entfernen? Dabei werden auch die zugehörigen Kennwörter aus dem Windows Credential Manager gelöscht.`
    );
    if (!confirmed) return;

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
          <p>AgendaKontakte speichert alle Daten lokal auf diesem PC.</p>
        </div>
      </header>

      <StatusMessage message={message} type={messageType} />

      <section className="form-panel mail-settings-panel">
        <div className="panel-heading">
          <div>
            <h3>Outlook Classic – IMAP-Konto</h3>
            <p>
              Liest ausschließlich IMAP-Konten aus dem aktuellen Outlook-Classic-Profil. Kennwörter werden nie an die Oberfläche übertragen.
            </p>
          </div>
          <button className="primary" type="button" onClick={scan} disabled={busyAction !== null}>
            <RefreshCw size={20} className={busyAction === "scan" ? "spin" : ""} />
            Outlook-Konten suchen
          </button>
        </div>

        {candidates.length > 0 && (
          <div className="mail-account-grid" aria-label="Gefundene Outlook-Konten">
            {candidates.map((candidate) => {
              const imported = importedIds.has(candidate.sourceAccountId.toLowerCase());
              const title = candidate.accountName || candidate.email || candidate.incomingUser;
              return (
                <article className="mail-account-card" key={candidate.sourceAccountId}>
                  <div className="mail-account-title">
                    <ShieldCheck size={26} />
                    <div>
                      <h4>{title}</h4>
                      <span>{candidate.email || candidate.incomingUser}</span>
                    </div>
                  </div>
                  <dl className="mail-account-details">
                    <div>
                      <dt>Eingang</dt>
                      <dd>{candidate.incomingServer}:{candidate.incomingPort} · {candidate.incomingSecurity === "ssl" ? "SSL/TLS" : "ohne TLS"}</dd>
                    </div>
                    <div>
                      <dt>Ausgang</dt>
                      <dd>{candidate.outgoingServer}:{candidate.outgoingPort} · {candidate.outgoingSecurity.toUpperCase()}</dd>
                    </div>
                    <div>
                      <dt>IMAP-Kennwort</dt>
                      <dd className={candidate.passwordAvailable ? "credential-available" : "credential-missing"}>
                        {candidate.passwordAvailable ? "in Outlook gespeichert" : "nicht gespeichert"}
                      </dd>
                    </div>
                  </dl>
                  <button
                    type="button"
                    onClick={() => importAccount(candidate)}
                    disabled={busyAction !== null || !candidate.passwordAvailable}
                  >
                    {imported ? <RefreshCw size={19} /> : <Download size={19} />}
                    {imported ? "Import aktualisieren" : "Sicher importieren"}
                  </button>
                </article>
              );
            })}
          </div>
        )}
      </section>

      <section className="form-panel mail-settings-panel">
        <div className="panel-heading">
          <div>
            <h3>Importierte E-Mail-Konten</h3>
            <p>SQLite enthält nur Serverdaten und Credential-Referenzen. Die Kennwörter bleiben im Windows Credential Manager.</p>
          </div>
        </div>
        {accounts.length === 0 ? (
          <p className="empty-inline">Noch kein Outlook-IMAP-Konto importiert.</p>
        ) : (
          <div className="mail-account-list">
            {accounts.map((account) => (
              <article className="mail-account-row" key={account.id}>
                <div>
                  <strong>{account.accountName || account.email}</strong>
                  <span>{account.email} · {account.incomingServer}:{account.incomingPort}</span>
                </div>
                <div className="inline-actions">
                  <button type="button" onClick={() => testAccount(account)} disabled={busyAction !== null}>
                    <CheckCircle2 size={19} /> IMAP testen
                  </button>
                  <button className="danger-button" type="button" onClick={() => removeAccount(account)} disabled={busyAction !== null}>
                    <Trash2 size={19} /> Entfernen
                  </button>
                </div>
              </article>
            ))}
          </div>
        )}
      </section>

      <section className="form-panel">
        <h3>Sprache</h3>
        <p>Deutsch ist aktuell als Standardsprache aktiv. Die Struktur ist für spätere Übersetzungen vorbereitet.</p>
      </section>
      <section className="form-panel">
        <h3>Datenbank</h3>
        <pre className="schema">{sqliteSchema}</pre>
      </section>
    </div>
  );
}
