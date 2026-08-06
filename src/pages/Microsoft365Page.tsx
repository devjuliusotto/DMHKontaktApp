import { useEffect, useRef, useState } from "react";
import {
  CalendarDays,
  CheckCircle2,
  Cloud,
  ContactRound,
  Copy,
  ExternalLink,
  KeyRound,
  LoaderCircle,
  LogOut,
  RefreshCw,
  ShieldCheck,
  X
} from "lucide-react";
import { writeText } from "@tauri-apps/plugin-clipboard-manager";
import { StatusMessage } from "../components/StatusMessage";
import {
  cancelMicrosoft365Connection,
  disconnectMicrosoft365Account,
  getMicrosoft365ConnectionStatus,
  openMicrosoft365SignIn,
  pollMicrosoft365Connection,
  startMicrosoft365Connection,
  testMicrosoft365Connection
} from "../services/db";
import type {
  Microsoft365ConnectionStatus,
  Microsoft365DeviceCode,
  ExchangeSyncStatus
} from "../types/m365";

interface Microsoft365PageProps {
  syncStatus: ExchangeSyncStatus;
  onSync: () => Promise<void>;
}

const emptyStatus: Microsoft365ConnectionStatus = {
  configured: false,
  connected: false,
  account: null,
  rememberSignIn: false
};

export function Microsoft365Page({ syncStatus, onSync }: Microsoft365PageProps) {
  const [status, setStatus] = useState<Microsoft365ConnectionStatus | null>(null);
  const [deviceCode, setDeviceCode] = useState<Microsoft365DeviceCode | null>(null);
  const [busyAction, setBusyAction] = useState<string | null>(null);
  const [message, setMessage] = useState("");
  const [messageType, setMessageType] = useState<"success" | "error" | "info">("info");
  const pollingRef = useRef(false);

  const loadStatus = async () => {
    try {
      setStatus(await getMicrosoft365ConnectionStatus());
    } catch (error) {
      setStatus(emptyStatus);
      setMessageType("error");
      setMessage(`Microsoft-365-Status konnte nicht geladen werden: ${error}`);
    }
  };

  useEffect(() => {
    loadStatus();
    return () => {
      pollingRef.current = false;
    };
  }, []);

  useEffect(() => {
    if (!deviceCode) return;
    pollingRef.current = true;
    let timeout: number | undefined;

    const poll = async () => {
      if (!pollingRef.current) return;
      try {
        const result = await pollMicrosoft365Connection();
        if (result.state === "connected") {
          pollingRef.current = false;
          setDeviceCode(null);
          setBusyAction(null);
          setStatus({ configured: true, connected: true, account: result.account, rememberSignIn: true });
          setMessageType("success");
          setMessage("Microsoft-365-Konto wurde sicher verbunden. Kontakte und Kalender werden automatisch synchronisiert.");
          return;
        }
        timeout = window.setTimeout(
          poll,
          Math.max(3, result.intervalSeconds || deviceCode.intervalSeconds) * 1000
        );
      } catch (error) {
        pollingRef.current = false;
        setDeviceCode(null);
        setBusyAction(null);
        setMessageType("error");
        setMessage(`Microsoft-365-Anmeldung wurde nicht abgeschlossen: ${error}`);
      }
    };

    timeout = window.setTimeout(poll, Math.max(2, deviceCode.intervalSeconds) * 1000);
    return () => {
      pollingRef.current = false;
      if (timeout) window.clearTimeout(timeout);
    };
  }, [deviceCode]);

  const connect = async () => {
    setBusyAction("connect");
    setMessage("");
    try {
      const code = await startMicrosoft365Connection();
      setDeviceCode(code);
      setMessageType("info");
      setMessage("Öffnen Sie die Microsoft-Anmeldung und geben Sie den angezeigten Code ein.");
      await openMicrosoft365SignIn();
    } catch (error) {
      setBusyAction(null);
      setMessageType("error");
      setMessage(`Microsoft-365-Anmeldung konnte nicht gestartet werden: ${error}`);
    }
  };

  const cancelConnection = async () => {
    pollingRef.current = false;
    setDeviceCode(null);
    setBusyAction(null);
    try {
      await cancelMicrosoft365Connection();
    } catch {
      // The short-lived code expires on its own; cancellation remains safe locally.
    }
    setMessageType("info");
    setMessage("Anmeldung wurde abgebrochen.");
  };

  const copyCode = async () => {
    if (!deviceCode) return;
    try {
      await writeText(deviceCode.userCode);
      setMessageType("success");
      setMessage("Anmeldecode wurde kopiert.");
    } catch (error) {
      setMessageType("error");
      setMessage(`Anmeldecode konnte nicht kopiert werden: ${error}`);
    }
  };

  const testConnection = async () => {
    setBusyAction("test");
    setMessage("");
    try {
      const refreshed = await testMicrosoft365Connection();
      setStatus(refreshed);
      setMessageType("success");
      setMessage("Verbindung zu Microsoft 365 wurde erfolgreich geprüft.");
    } catch (error) {
      setMessageType("error");
      setMessage(`Microsoft-365-Verbindung konnte nicht bestätigt werden: ${error}`);
    } finally {
      setBusyAction(null);
    }
  };

  const disconnect = async () => {
    if (!window.confirm("Microsoft-365-Konto von dieser App trennen?\n\nKontakte, Kalender und Daten in Microsoft 365 werden dadurch nicht gelöscht.")) {
      return;
    }
    setBusyAction("disconnect");
    setMessage("");
    try {
      await disconnectMicrosoft365Account();
      setStatus({ configured: status?.configured ?? true, connected: false, account: null, rememberSignIn: false });
      setMessageType("success");
      setMessage("Microsoft-365-Konto wurde von dieser App getrennt.");
      window.location.reload();
    } catch (error) {
      setMessageType("error");
      setMessage(`Microsoft-365-Konto konnte nicht getrennt werden: ${error}`);
    } finally {
      setBusyAction(null);
    }
  };

  if (!status) {
    return (
      <div className="page m365-page">
        <section className="form-panel m365-loading">
          <LoaderCircle className="spin" size={28} />
          <p>Microsoft-365-Verbindung wird geprüft …</p>
        </section>
      </div>
    );
  }

  return (
    <div className="page m365-page">
      <header className="page-header">
        <div>
          <h2>Microsoft 365</h2>
          <p>Geschäftskonto, Exchange-Synchronisierung und lokalen Offline-Cache verwalten.</p>
        </div>
      </header>

      <StatusMessage message={message} type={messageType} />

      {!status.configured && (
        <section className="form-panel m365-configuration-card">
          <div className="m365-card-icon"><ShieldCheck size={28} /></div>
          <div>
            <h3>Einrichtung durch die EDV erforderlich</h3>
            <p>
              Die Microsoft-Anwendung ist in diesem Build noch nicht hinterlegt. Die EDV muss
              einmalig Mandanten-ID und Anwendungs-ID für DMH Kontakte und Kalender eintragen.
              Lokale Funktionen bleiben vollständig verfügbar.
            </p>
          </div>
        </section>
      )}

      {status.configured && !status.connected && !deviceCode && (
        <section className="form-panel m365-connect-card">
          <div className="m365-hero">
            <div className="m365-card-icon microsoft"><Cloud size={30} /></div>
            <div>
              <h3>Mit Microsoft 365 verbinden</h3>
              <p>
                Melden Sie sich mit Ihrem dienstlichen Microsoft-Konto an. Das Portal synchronisiert
                anschließend Ihre Kontakte und Ihren Kalender mit Exchange.
              </p>
            </div>
          </div>
          <div className="m365-privacy-note">
            <ShieldCheck size={21} />
            <p>
              Die App verwendet delegierte Zugriffe auf Ihre eigenen Exchange-Kontakte und Ihren
              Kalender. Ihr Microsoft-Kennwort wird niemals von dieser App gelesen oder gespeichert.
            </p>
          </div>
          <button className="primary large m365-connect-button" type="button" onClick={connect} disabled={busyAction !== null}>
            {busyAction === "connect" ? <LoaderCircle className="spin" size={22} /> : <Cloud size={22} />}
            Mit Microsoft 365 verbinden
          </button>
        </section>
      )}

      {deviceCode && (
        <section className="form-panel m365-device-card" aria-live="polite">
          <div className="m365-hero">
            <div className="m365-card-icon microsoft"><KeyRound size={29} /></div>
            <div>
              <h3>Microsoft-Anmeldung abschließen</h3>
              <p>Geben Sie diesen einmaligen Code im geöffneten Microsoft-Fenster ein.</p>
            </div>
          </div>
          <div className="m365-device-code-row">
            <strong>{deviceCode.userCode}</strong>
            <button type="button" onClick={copyCode}><Copy size={19} /> Code kopieren</button>
          </div>
          <div className="m365-device-actions">
            <button className="primary" type="button" onClick={openMicrosoft365SignIn}>
              <ExternalLink size={19} /> Microsoft-Anmeldung öffnen
            </button>
            <button type="button" onClick={cancelConnection}><X size={19} /> Abbrechen</button>
          </div>
          <p className="m365-waiting">
            <LoaderCircle className="spin" size={19} />
            Die App wartet auf Ihre Bestätigung. Dieses Fenster kann geöffnet bleiben.
          </p>
        </section>
      )}

      {status.connected && status.account && (
        <>
          <section className="form-panel m365-account-card">
            <div className="m365-account-summary">
              <div className="m365-avatar" aria-hidden="true">
                {status.account.displayName.trim().slice(0, 1).toUpperCase() || "M"}
              </div>
              <div>
                <span className="m365-connected-label"><CheckCircle2 size={17} /> Verbunden</span>
                <h3>{status.account.displayName}</h3>
                <p>{status.account.userPrincipalName || status.account.email}</p>
              </div>
            </div>
            <div className="inline-actions">
              <button type="button" onClick={testConnection} disabled={busyAction !== null}>
                <RefreshCw className={busyAction === "test" ? "spin" : ""} size={19} /> Verbindung prüfen
              </button>
              <button type="button" onClick={() => void onSync()} disabled={syncStatus.state === "syncing"}>
                {syncStatus.state === "syncing" ? <LoaderCircle className="spin" size={19} /> : <RefreshCw size={19} />}
                Jetzt synchronisieren
              </button>
              <button className="danger-button" type="button" onClick={disconnect} disabled={busyAction !== null}>
                <LogOut size={19} /> Konto trennen
              </button>
            </div>
          </section>

          <section className="form-panel m365-roadmap-card">
            <h3>Automatische Exchange-Synchronisierung</h3>
            <p>
              {syncStatus.state === "error"
                ? `Letzter Versuch fehlgeschlagen: ${syncStatus.message}`
                : syncStatus.state === "offline"
                  ? "Offline-Änderungen bleiben lokal vorgemerkt und werden bei der nächsten Verbindung übertragen."
                  : syncStatus.lastSyncedAt
                    ? `Zuletzt erfolgreich synchronisiert: ${new Intl.DateTimeFormat("de-DE", { dateStyle: "medium", timeStyle: "short" }).format(new Date(syncStatus.lastSyncedAt))}`
                    : "Die erste Synchronisierung startet automatisch nach der Anmeldung."}
            </p>
            <div className="m365-capabilities">
              <article>
                <ContactRound size={24} />
                <div><strong>Kontakte</strong><span>Private Exchange-Kontakte</span></div>
                <small>Aktiv</small>
              </article>
              <article>
                <CalendarDays size={24} />
                <div><strong>Kalender & Teams</strong><span>Termine und Onlinebesprechungen</span></div>
                <small>Aktiv</small>
              </article>
              <article>
                <KeyRound size={24} />
                <div><strong>Passwörter</strong><span>Bleiben sicher im lokalen Tresor</span></div>
                <small>Lokal</small>
              </article>
            </div>
            {syncStatus.result && (
              <p className="m365-sync-summary">
                Letzter Lauf: Kontakte {syncStatus.result.contacts.uploaded} hochgeladen, {syncStatus.result.contacts.downloaded} geladen, {syncStatus.result.contacts.updated} aktualisiert. Kalender {syncStatus.result.calendar.uploaded} hochgeladen, {syncStatus.result.calendar.downloaded} geladen, {syncStatus.result.calendar.updated} aktualisiert.
              </p>
            )}
          </section>
        </>
      )}
    </div>
  );
}
