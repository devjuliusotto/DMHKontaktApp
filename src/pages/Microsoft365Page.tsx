import { useEffect, useRef, useState } from "react";
import {
  CalendarDays,
  CheckCircle2,
  CircleAlert,
  Clock3,
  Cloud,
  ContactRound,
  Copy,
  ExternalLink,
  KeyRound,
  LoaderCircle,
  LogOut,
  MonitorCheck,
  RefreshCw,
  ShieldCheck,
  X
} from "lucide-react";
import { writeText } from "@tauri-apps/plugin-clipboard-manager";
import { StatusMessage } from "../components/StatusMessage";
import {
  cancelMicrosoft365Connection,
  connectMicrosoft365Interactively,
  disconnectMicrosoft365Account,
  getAppSetting,
  getMicrosoft365ConnectionStatus,
  openMicrosoft365SignIn,
  pollMicrosoft365Connection,
  startMicrosoft365Connection,
  testMicrosoft365Connection
} from "../services/db";
import type {
  Microsoft365ConnectionStatus,
  Microsoft365DeviceCode
} from "../types/m365";
import { defaultSyncConfig, parseSyncConfig, type SyncConfig } from "../types/sync";
import {
  calendarAutomaticSyncStatusEventName,
  calendarChangedEventName,
  emptyMicrosoft365SynchronizationRuntimeStatus,
  parseSynchronizationRuntimeStatus,
  synchronizationConfigKey,
  synchronizationRuntimeStatusKey,
  type CalendarAutomaticSyncStatus,
  type Microsoft365SynchronizationRuntimeStatus
} from "../utils/automaticCalendarSync";
import { enableCompleteAutomaticMicrosoft365Sync } from "../utils/microsoft365SyncConfig";

const emptyStatus: Microsoft365ConnectionStatus = {
  configured: false,
  connected: false,
  account: null
};

function formatSyncTime(value: string | null, emptyLabel = "Noch nicht geprüft"): string {
  if (!value) return emptyLabel;
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return emptyLabel;
  return date.toLocaleString("de-DE", { dateStyle: "short", timeStyle: "short" });
}

export function Microsoft365Page() {
  const [status, setStatus] = useState<Microsoft365ConnectionStatus | null>(null);
  const [deviceCode, setDeviceCode] = useState<Microsoft365DeviceCode | null>(null);
  const [busyAction, setBusyAction] = useState<string | null>(null);
  const [showCodeFallback, setShowCodeFallback] = useState(false);
  const [message, setMessage] = useState("");
  const [messageType, setMessageType] = useState<"success" | "error" | "info">("info");
  const [syncConfig, setSyncConfig] = useState<SyncConfig>(defaultSyncConfig);
  const [syncRuntimeStatus, setSyncRuntimeStatus] = useState<Microsoft365SynchronizationRuntimeStatus>(emptyMicrosoft365SynchronizationRuntimeStatus);
  const [syncPreparing, setSyncPreparing] = useState(false);
  const pollingRef = useRef(false);

  const loadSynchronizationOverview = async () => {
    const [rawConfig, rawRuntimeStatus] = await Promise.all([
      getAppSetting(synchronizationConfigKey),
      getAppSetting(synchronizationRuntimeStatusKey)
    ]);
    setSyncConfig(parseSyncConfig(rawConfig));
    setSyncRuntimeStatus(parseSynchronizationRuntimeStatus(rawRuntimeStatus));
  };

  const prepareCompleteSynchronization = async (force = false): Promise<boolean> => {
    setSyncPreparing(true);
    try {
      const configured = await enableCompleteAutomaticMicrosoft365Sync(force);
      setSyncConfig(configured);
      window.dispatchEvent(new Event(calendarChangedEventName));
      return true;
    } catch (error) {
      setMessageType("error");
      setMessage(`Die automatische Synchronisierung konnte nicht eingerichtet werden: ${error}`);
      return false;
    } finally {
      setSyncPreparing(false);
    }
  };

  const loadStatus = async () => {
    try {
      const nextStatus = await getMicrosoft365ConnectionStatus();
      setStatus(nextStatus);
      try {
        await loadSynchronizationOverview();
      } catch {
        // The account remains connected even if the local status card cannot be read yet.
      }
      if (nextStatus.connected) void prepareCompleteSynchronization(false);
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
    const handleAutomaticSync = (event: Event) => {
      const detail = (event as CustomEvent<CalendarAutomaticSyncStatus>).detail;
      if (detail) {
        setMessageType(detail.state);
        setMessage(detail.message);
      }
      void loadSynchronizationOverview();
    };
    window.addEventListener(calendarAutomaticSyncStatusEventName, handleAutomaticSync);
    return () => window.removeEventListener(calendarAutomaticSyncStatusEventName, handleAutomaticSync);
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
          setStatus({ configured: true, connected: true, account: result.account });
          if (await prepareCompleteSynchronization(true)) {
            setMessageType("success");
            setMessage("Microsoft 365 wurde verbunden. Kontakte und Kalender werden jetzt automatisch synchronisiert.");
          }
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
      const account = await connectMicrosoft365Interactively();
      setStatus({ configured: true, connected: true, account });
      const synchronizationReady = await prepareCompleteSynchronization(true);
      setShowCodeFallback(false);
      if (synchronizationReady) {
        setMessageType("success");
        setMessage("Microsoft 365 wurde verbunden. Kontakte und Kalender werden jetzt automatisch synchronisiert.");
      }
    } catch (error) {
      setShowCodeFallback(true);
      setMessageType("error");
      setMessage(`Microsoft-365-Anmeldung wurde nicht abgeschlossen: ${error}`);
    } finally {
      setBusyAction(null);
    }
  };

  const connectWithCode = async () => {
    setBusyAction("device-code");
    setMessage("");
    try {
      const code = await startMicrosoft365Connection();
      setDeviceCode(code);
      setMessageType("info");
      setMessage("Alternative Anmeldung: Geben Sie den angezeigten Code bei Microsoft ein.");
      await openMicrosoft365SignIn();
    } catch (error) {
      setBusyAction(null);
      setMessageType("error");
      setMessage(`Alternative Microsoft-Anmeldung konnte nicht gestartet werden: ${error}`);
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
      setStatus({ configured: status?.configured ?? true, connected: false, account: null });
      setMessageType("success");
      setMessage("Microsoft-365-Konto wurde von dieser App getrennt.");
    } catch (error) {
      setMessageType("error");
      setMessage(`Microsoft-365-Konto konnte nicht getrennt werden: ${error}`);
    } finally {
      setBusyAction(null);
    }
  };

  const synchronizeEverythingNow = async () => {
    if (!automaticSyncActive) {
      if (await prepareCompleteSynchronization(true)) {
        setMessageType("success");
        setMessage("Die automatische Synchronisierung für Kontakte und Kalender ist jetzt aktiv.");
      }
      return;
    }
    setMessageType("info");
    setMessage("Kontakte und Kalender werden jetzt geprüft …");
    window.dispatchEvent(new Event(calendarChangedEventName));
  };

  const automaticSyncActive = syncConfig.enabled && !syncConfig.paused;
  const contactsSyncActive = automaticSyncActive && syncConfig.contacts;
  const calendarsSyncActive = automaticSyncActive && syncConfig.calendars;

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
          <p>Geschäftskonto für Kontakte, Kalender, OneDrive und SharePoint sicher verbinden.</p>
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
              einmalig Mandanten-ID und Anwendungs-ID für DMH Backup eintragen.
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
                Melden Sie sich mit Ihrem dienstlichen Microsoft-Konto an. Microsoft zeigt vor
                der Freigabe genau, auf welche Daten die App zugreifen darf.
              </p>
            </div>
          </div>
          <div className="m365-privacy-note">
            <ShieldCheck size={21} />
            <p>
              Die App verwendet Kontakte, Kalender und Dokumente nur im Rahmen Ihrer bestehenden
              Berechtigungen. Ihr Microsoft-Kennwort wird niemals gelesen oder gespeichert.
            </p>
          </div>
          <button className="primary large m365-connect-button" type="button" onClick={connect} disabled={busyAction !== null}>
            {busyAction === "connect" ? <LoaderCircle className="spin" size={22} /> : <Cloud size={22} />}
            {busyAction === "connect" ? "Microsoft-Anmeldung läuft …" : "Mit Microsoft 365 verbinden"}
          </button>
          {showCodeFallback && busyAction === null && (
            <button className="m365-code-fallback" type="button" onClick={connectWithCode}>
              Anmeldung mit Code verwenden
            </button>
          )}
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
                <p>{status.account.email || status.account.userPrincipalName}</p>
              </div>
            </div>
            <div className="inline-actions">
              <button type="button" onClick={testConnection} disabled={busyAction !== null}>
                <RefreshCw className={busyAction === "test" ? "spin" : ""} size={19} /> Verbindung prüfen
              </button>
              <button className="danger-button" type="button" onClick={disconnect} disabled={busyAction !== null}>
                <LogOut size={19} /> Konto trennen
              </button>
            </div>
          </section>

          <section className="form-panel m365-sync-overview">
            <div className="m365-sync-heading">
              <div>
                <h3>Automatische Synchronisierung</h3>
                <p>Kontakte und Kalender werden jede Minute geprüft.</p>
              </div>
              <span className={syncRuntimeStatus.lastError ? "m365-auto-badge error" : automaticSyncActive ? "m365-auto-badge active" : "m365-auto-badge"}>
                {syncPreparing ? "Wird eingerichtet …" : syncRuntimeStatus.lastError ? "Prüfung fehlgeschlagen" : automaticSyncActive ? "Im Hintergrund aktiv" : "Nicht aktiv"}
              </span>
            </div>

            {syncRuntimeStatus.lastError && (
              <div className="m365-sync-error" role="alert">
                <CircleAlert size={19} />
                <span><strong>Letzte Prüfung nicht erfolgreich</strong><small>{syncRuntimeStatus.lastError}</small></span>
              </div>
            )}

            <div className="m365-sync-areas">
              <article className={contactsSyncActive ? "active" : ""}>
                <span className="m365-sync-area-icon"><ContactRound size={24} /></span>
                <div>
                  <strong>Kontakte</strong>
                  <span>{contactsSyncActive ? "Wird automatisch synchronisiert" : "Synchronisierung ist aus"}</span>
                </div>
                <div className="m365-sync-area-time">
                  <small>Zuletzt geprüft</small>
                  <strong>{formatSyncTime(syncRuntimeStatus.contactsLastCheckedAt)}</strong>
                </div>
              </article>
              <article className={calendarsSyncActive ? "active" : ""}>
                <span className="m365-sync-area-icon"><CalendarDays size={24} /></span>
                <div>
                  <strong>Kalender & Teams</strong>
                  <span>{calendarsSyncActive ? "Wird automatisch synchronisiert" : "Synchronisierung ist aus"}</span>
                </div>
                <div className="m365-sync-area-time">
                  <small>Zuletzt geprüft</small>
                  <strong>{formatSyncTime(syncRuntimeStatus.calendarsLastCheckedAt)}</strong>
                </div>
              </article>
            </div>

            <div className="m365-sync-footer">
              <span><Clock3 size={19} /><span><small>Letzter Datenaustausch</small><strong>{formatSyncTime(syncRuntimeStatus.lastExchangeAt, "Noch kein Datenaustausch")}</strong></span></span>
              <span><MonitorCheck size={19} /><span><small>Hintergrundbetrieb</small><strong>Aktiv nach dem Schließen</strong></span></span>
              <button className="primary" type="button" onClick={() => void synchronizeEverythingNow()} disabled={syncPreparing}>
                <RefreshCw size={18} /> {automaticSyncActive ? "Jetzt alles synchronisieren" : "Automatik einschalten"}
              </button>
            </div>
          </section>
        </>
      )}
    </div>
  );
}
