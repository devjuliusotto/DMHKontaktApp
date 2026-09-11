import { useEffect, useMemo, useRef, useState } from "react";
import {
  CalendarDays,
  ChevronDown,
  CircleAlert,
  Cloud,
  ContactRound,
  Copy,
  ExternalLink,
  KeyRound,
  LoaderCircle,
  LogOut,
  MonitorSmartphone,
  PauseCircle,
  PlayCircle,
  Plus,
  RefreshCw,
  Save
} from "lucide-react";
import { writeText } from "@tauri-apps/plugin-clipboard-manager";
import { StatusMessage } from "../components/StatusMessage";
import type { SettingsSection } from "../components/SettingsSubtabs";
import type { Page } from "../components/Sidebar";
import { applyMicrosoft365Sync, cancelMicrosoft365Connection, connectMicrosoft365Interactively, createAutomaticBackup, createAutomaticPasswordBackup, disconnectMicrosoft365Account, getAppSetting, getBackupData, getMicrosoft365ConnectionStatus, getSyncBackupData, listMicrosoft365SyncSources, moveCalendarEventsToTrash, openMicrosoft365SignIn, pollMicrosoft365Connection, previewMicrosoft365Sync, saveCalendarEvents, setAppSetting, startMicrosoft365Connection, testMicrosoft365Connection } from "../services/db";
import type { Microsoft365ConflictDecision, Microsoft365ConnectionStatus, Microsoft365DeviceCode, Microsoft365PollResult, Microsoft365SyncHistoryEntry, Microsoft365SyncPreview, Microsoft365SyncSource, Microsoft365SyncSources } from "../types/m365";
import { defaultSyncConfig, parseSyncConfig, type SyncConfig, type SyncDirection } from "../types/sync";
import { addBrowserDataToBackup } from "../utils/backup";
import { mergeImportedCalendarCategories } from "../utils/calendar";
import { calendarChangedEventName, recordMicrosoft365SynchronizationError, recordMicrosoft365SynchronizationSuccess, synchronizationConfigKey as syncConfigKey, synchronizationHistoryKey as syncHistoryKey } from "../utils/automaticCalendarSync";
import { initializeMicrosoft365SourceSelection, isTechnicalMicrosoft365Source } from "../utils/microsoft365SyncConfig";

interface SynchronizationsPageProps {
  onNavigate?: (page: Page, section?: SettingsSection) => void;
  embedded?: boolean;
  onClose?: () => void;
}

const emptyStatus: Microsoft365ConnectionStatus = { configured: false, connected: false, account: null };

function initializeSourceSelection(config: SyncConfig, sources: Microsoft365SyncSources): SyncConfig {
  return initializeMicrosoft365SourceSelection(config, sources);
}

function parseHistory(raw: string | null): Microsoft365SyncHistoryEntry[] {
  if (!raw) return [];
  try {
    const value = JSON.parse(raw);
    return Array.isArray(value) ? value.slice(0, 30) : [];
  } catch {
    return [];
  }
}

export function SynchronizationsPage({ onNavigate, embedded = false, onClose }: SynchronizationsPageProps) {
  const [config, setConfig] = useState<SyncConfig>(defaultSyncConfig);
  const [m365Status, setM365Status] = useState<Microsoft365ConnectionStatus | null>(null);
  const [m365Sources, setM365Sources] = useState<Microsoft365SyncSources | null>(null);
  const [preview, setPreview] = useState<Microsoft365SyncPreview | null>(null);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");
  const [messageType, setMessageType] = useState<"success" | "error" | "info">("info");
  const [sharedMailboxAddress, setSharedMailboxAddress] = useState("");
  const [conflictDecisions, setConflictDecisions] = useState<Record<string, Microsoft365ConflictDecision>>({});
  const [history, setHistory] = useState<Microsoft365SyncHistoryEntry[]>([]);
  const [openProvider, setOpenProvider] = useState<"m365" | null>("m365");
  const [deviceCode, setDeviceCode] = useState<Microsoft365DeviceCode | null>(null);
  const [showCodeFallback, setShowCodeFallback] = useState(false);
  const pollingRef = useRef(false);

  useEffect(() => {
    void getAppSetting(syncHistoryKey).then((raw) => setHistory(parseHistory(raw))).catch(() => setHistory([]));
    getAppSetting(syncConfigKey).then((raw) => {
      const nextConfig = parseSyncConfig(raw);
      setConfig(nextConfig);
      return getMicrosoft365ConnectionStatus().then((status) => {
        setM365Status(status);
        if (status.connected) {
          return listMicrosoft365SyncSources(nextConfig.sharedMailboxAddresses).then((sources) => {
            setM365Sources(sources);
            const initialized = initializeSourceSelection(nextConfig, sources);
            setConfig(initialized);
            if (JSON.stringify(initialized) !== JSON.stringify(nextConfig)) {
              void setAppSetting(syncConfigKey, JSON.stringify(initialized));
            }
          }).catch(() => setM365Sources(null));
        }
        return undefined;
      });
    }).catch(() => {
      setConfig(defaultSyncConfig);
      setM365Status(emptyStatus);
    });
  }, []);

  useEffect(() => {
    if (!deviceCode) return;
    pollingRef.current = true;
    let timeout: number | undefined;

    const poll = async () => {
      if (!pollingRef.current) return;
      try {
        const result: Microsoft365PollResult = await pollMicrosoft365Connection();
        if (result.state === "connected" && result.account) {
          pollingRef.current = false;
          setDeviceCode(null);
          setShowCodeFallback(false);
          setBusy(false);
          setM365Status({ configured: true, connected: true, account: result.account });
          await refreshM365SourcesForAccount();
          setMessageType("success");
          setMessage("Microsoft 365 wurde verbunden. Jetzt können Sie die Synchronisierung hier konfigurieren.");
          return;
        }
        timeout = window.setTimeout(poll, Math.max(3, result.intervalSeconds || deviceCode.intervalSeconds) * 1000);
      } catch (error) {
        pollingRef.current = false;
        setDeviceCode(null);
        setBusy(false);
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

  const selectedSourceCount = config.selectedContactSourceIds.length + config.selectedCalendarSourceIds.length;
  const conflicts = useMemo(() => preview?.changes.filter((change) => change.action === "conflict") ?? [], [preview]);
  const unresolvedConflicts = conflicts.filter((change) => !conflictDecisions[change.id]).length;

  const updateConfig = <K extends keyof SyncConfig>(key: K, value: SyncConfig[K]) => {
    setConfig((current) => ({ ...current, [key]: value }));
  };

  const updateGlobalDirection = (direction: SyncDirection) => {
    setConfig((current) => {
      const selectedSourceIds = [
        ...current.selectedContactSourceIds,
        ...current.selectedCalendarSourceIds
      ];
      const sourceDirections = { ...current.sourceDirections };
      for (const sourceId of selectedSourceIds) sourceDirections[sourceId] = direction;
      return { ...current, direction, sourceDirections };
    });
    setPreview(null);
  };

  const saveConfig = async () => {
    if (config.enabled && config.calendars && config.selectedCalendarSourceIds.length === 0) {
      setMessageType("error");
      setMessage("Bitte mindestens einen Microsoft-365-Kalender für die automatische Synchronisierung auswählen.");
      return;
    }
    setBusy(true);
    setMessage("");
    try {
      const savedConfig = { ...config, runOnClose: true };
      setConfig(savedConfig);
      await setAppSetting(syncConfigKey, JSON.stringify(savedConfig));
      if (savedConfig.enabled && savedConfig.calendars) window.dispatchEvent(new Event(calendarChangedEventName));
      setMessageType("success");
      setMessage(savedConfig.enabled
        ? "Einstellungen gespeichert. Neue Kalenderänderungen werden automatisch synchronisiert."
        : "Einstellungen gespeichert. Die Synchronisierung bleibt manuell.");
    } catch (error) {
      setMessageType("error");
      setMessage(`Einstellungen konnten nicht gespeichert werden: ${error}`);
    } finally {
      setBusy(false);
    }
  };

  const createPreview = async () => {
    if (config.paused) {
      setMessageType("info");
      setMessage("Die Synchronisierung ist pausiert.");
      return;
    }
    if (selectedSourceCount === 0) {
      setMessageType("error");
      setMessage("Bitte mindestens eine Quelle auswählen.");
      return;
    }
    setBusy(true);
    setMessage("");
    try {
      const backup = await getSyncBackupData();
      const nextPreview = await previewMicrosoft365Sync({
        direction: config.direction,
        base: config.base,
        contacts: config.contacts,
        contactGroups: config.contactGroups,
        calendars: config.calendars,
        sharedCalendars: config.sharedCalendars,
        sharedMailboxes: config.sharedMailboxes,
        sharedMailboxAddresses: config.sharedMailboxAddresses,
        selectedContactSourceIds: config.selectedContactSourceIds,
        selectedCalendarSourceIds: config.selectedCalendarSourceIds,
        sourceDirections: config.sourceDirections,
        backup
      });
      setPreview(nextPreview);
      setConflictDecisions({});
      setMessageType("info");
      setMessage("Vorschau erstellt. Es wurden keine Daten verändert.");
    } catch (error) {
      setMessageType("error");
      setMessage(`Vorschau konnte nicht erstellt werden: ${error}`);
    } finally {
      setBusy(false);
    }
  };

  const addSharedMailbox = () => {
    const address = sharedMailboxAddress.trim().toLowerCase();
    if (!address || !address.includes("@") || config.sharedMailboxAddresses.includes(address)) return;
    updateConfig("sharedMailboxAddresses", [...config.sharedMailboxAddresses, address]);
    setSharedMailboxAddress("");
  };

  const removeSharedMailbox = (address: string) => {
    updateConfig("sharedMailboxAddresses", config.sharedMailboxAddresses.filter((item) => item !== address));
  };

  const refreshM365Sources = async () => {
    if (!m365Status?.connected) return;
    setBusy(true);
    try {
      const sources = await listMicrosoft365SyncSources(config.sharedMailboxAddresses);
      setM365Sources(sources);
      setConfig((current) => initializeSourceSelection(current, sources));
      setMessageType("info");
      setMessage("Quellen aktualisiert. Es wurden keine Daten verändert.");
    } catch (error) {
      setMessageType("error");
      setMessage(`Quellen konnten nicht gelesen werden: ${error}`);
    } finally {
      setBusy(false);
    }
  };

  const connectAccount = async () => {
    setBusy(true);
    setMessage("");
    try {
      const account = await connectMicrosoft365Interactively();
      setM365Status({ configured: true, connected: true, account });
      setShowCodeFallback(false);
      setMessageType("success");
      setMessage("Microsoft 365 wurde verbunden. Jetzt können Sie die Synchronisierung hier konfigurieren.");
      await refreshM365SourcesForAccount();
    } catch (error) {
      setShowCodeFallback(true);
      setMessageType("error");
      setMessage(`Microsoft-Anmeldung wurde nicht abgeschlossen: ${error}`);
    } finally {
      setBusy(false);
    }
  };

  const refreshM365SourcesForAccount = async () => {
    try {
      const sources = await listMicrosoft365SyncSources(config.sharedMailboxAddresses);
      setM365Sources(sources);
      const initialized = initializeSourceSelection(config, sources);
      setConfig(initialized);
      if (JSON.stringify(initialized) !== JSON.stringify(config)) await setAppSetting(syncConfigKey, JSON.stringify(initialized));
    } catch (error) {
      setMessageType("error");
      setMessage(`Microsoft-365-Quellen konnten nicht geladen werden: ${error}`);
    }
  };

  const connectWithCode = async () => {
    setBusy(true);
    setMessage("");
    try {
      const code = await startMicrosoft365Connection();
      setDeviceCode(code);
      setMessageType("info");
      setMessage("Geben Sie den angezeigten Code im Microsoft-Anmeldefenster ein.");
      await openMicrosoft365SignIn();
    } catch (error) {
      setBusy(false);
      setMessageType("error");
      setMessage(`Alternative Microsoft-Anmeldung konnte nicht gestartet werden: ${error}`);
    }
  };

  const cancelAccountConnection = async () => {
    pollingRef.current = false;
    setDeviceCode(null);
    setBusy(false);
    await cancelMicrosoft365Connection().catch(() => undefined);
    setMessageType("info");
    setMessage("Anmeldung wurde abgebrochen.");
  };

  const copyDeviceCode = async () => {
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

  const checkAccount = async () => {
    setBusy(true);
    setMessage("");
    try {
      const status = await testMicrosoft365Connection();
      setM365Status(status);
      setMessageType("success");
      setMessage("Verbindung zu Microsoft 365 wurde erfolgreich geprüft.");
      if (status.connected) await refreshM365SourcesForAccount();
    } catch (error) {
      setMessageType("error");
      setMessage(`Microsoft-365-Verbindung konnte nicht bestätigt werden: ${error}`);
    } finally {
      setBusy(false);
    }
  };

  const disconnectAccount = async () => {
    if (!window.confirm("Microsoft-365-Konto von dieser App trennen?\n\nKontakte, Kalender und Daten in Microsoft 365 werden dadurch nicht gelöscht.")) return;
    setBusy(true);
    try {
      await disconnectMicrosoft365Account();
      setM365Status({ configured: m365Status?.configured ?? true, connected: false, account: null });
      setM365Sources(null);
      setPreview(null);
      setMessageType("success");
      setMessage("Microsoft-365-Konto wurde von dieser App getrennt.");
    } catch (error) {
      setMessageType("error");
      setMessage(`Microsoft-365-Konto konnte nicht getrennt werden: ${error}`);
    } finally {
      setBusy(false);
    }
  };

  const toggleSource = (source: Microsoft365SyncSource, selected: boolean) => {
    const key = source.kind === "contactFolder" ? "selectedContactSourceIds" : "selectedCalendarSourceIds";
    const current = config[key];
    updateConfig(key, (selected ? [...current, source.id] : current.filter((id) => id !== source.id)) as SyncConfig[typeof key]);
    setPreview(null);
  };

  const updateSourceDirection = (sourceId: string, direction: SyncDirection) => {
    updateConfig("sourceDirections", { ...config.sourceDirections, [sourceId]: direction });
    setPreview(null);
  };

  const togglePaused = async () => {
    const next = { ...config, paused: !config.paused };
    setConfig(next);
    setPreview(null);
    try {
      await setAppSetting(syncConfigKey, JSON.stringify(next));
      setMessageType("info");
      setMessage(next.paused ? "Synchronisierung pausiert. Einstellungen bleiben erhalten." : "Synchronisierung fortgesetzt.");
    } catch (error) {
      setConfig(config);
      setMessageType("error");
      setMessage(error instanceof Error ? error.message : String(error));
    }
  };

  const persistHistory = async (entry: Microsoft365SyncHistoryEntry) => {
    const next = [entry, ...history].slice(0, 30);
    setHistory(next);
    await setAppSetting(syncHistoryKey, JSON.stringify(next));
  };

  const applySync = async () => {
    if (!preview || config.paused || unresolvedConflicts > 0) return;
    const total = preview.changes.length;
    if (!window.confirm(`${total} Änderung(en) jetzt ausführen? Vorher wird automatisch ein Snapshot erstellt.`)) return;
    setBusy(true);
    setMessage("");
    try {
      const snapshot = addBrowserDataToBackup(await getBackupData());
      await createAutomaticBackup(snapshot, true);
      await createAutomaticPasswordBackup(true);
      const backup = await getSyncBackupData();
      const result = await applyMicrosoft365Sync({
        direction: config.direction,
        base: config.base,
        contacts: config.contacts,
        contactGroups: config.contactGroups,
        calendars: config.calendars,
        sharedCalendars: config.sharedCalendars,
        sharedMailboxes: config.sharedMailboxes,
        sharedMailboxAddresses: config.sharedMailboxAddresses,
        selectedContactSourceIds: config.selectedContactSourceIds,
        selectedCalendarSourceIds: config.selectedCalendarSourceIds,
        sourceDirections: config.sourceDirections,
        decisions: conflictDecisions,
        backup
      });
      if (result.calendarUpserts.length > 0 || result.calendarDeletes.length > 0) {
        if (result.calendarUpserts.length > 0) await saveCalendarEvents(result.calendarUpserts);
        if (result.calendarDeletes.length > 0) await moveCalendarEventsToTrash(result.calendarDeletes);
        mergeImportedCalendarCategories(result.calendarUpserts);
      }
      await persistHistory({ ...result, id: `${result.startedAt}-${Date.now()}` });
      await recordMicrosoft365SynchronizationSuccess(config, result);
      setPreview(null);
      setConflictDecisions({});
      setMessageType(result.errors > 0 ? "error" : "success");
      setMessage(`${result.created} erstellt, ${result.updated} aktualisiert, ${result.deleted} gelöscht, ${result.ignored} ignoriert, ${result.errors} Fehler.`);
    } catch (error) {
      await recordMicrosoft365SynchronizationError(error).catch(() => undefined);
      setMessageType("error");
      setMessage(`Synchronisierung konnte nicht abgeschlossen werden: ${error}`);
    } finally {
      setBusy(false);
    }
  };

  const connectedLabel = m365Status?.connected
    ? `Verbunden${m365Status.account?.email ? ` · ${m365Status.account.email}` : ""}`
    : "Noch nicht verbunden";

  const toggleProvider = (provider: "m365") => {
    setOpenProvider((current) => current === provider ? null : provider);
  };

  return (
    <div className={`page synchronizations-page${embedded ? " synchronizations-page-embedded" : ""}`}>
      {!embedded && <header className="page-header">
        <div>
          <h2>Microsoft-365-Synchronisierung</h2>
          <p>Kontakte und Termine mit Microsoft 365 abgleichen.</p>
        </div>
      </header>}

      <StatusMessage message={message} type={messageType} />

      <section className="sync-provider-list" aria-label="Verfügbare Synchronisierungen">
        <article className={openProvider === "m365" ? "sync-provider-card open" : "sync-provider-card"}>
          <button className="sync-provider-summary" type="button" onClick={() => toggleProvider("m365")} aria-expanded={openProvider === "m365"}>
            <span className="synchronization-icon microsoft"><Cloud size={24} aria-hidden="true" /></span>
            <span className="sync-provider-name"><strong>Microsoft 365 / Exchange</strong><small>{m365Status === null ? "Verbindung wird geprüft …" : connectedLabel}</small></span>
            <span className={`synchronization-status ${m365Status?.connected ? "connected" : "local"}`}>{m365Status?.connected ? (config.paused ? "Pausiert" : config.enabled ? "Automatisch" : "Manuell") : "Nicht verbunden"}</span>
            <ChevronDown className="sync-provider-chevron" size={20} aria-hidden="true" />
          </button>

          {openProvider === "m365" && <div className="sync-provider-content">
            {!m365Status?.connected ? (
              <>
                {!m365Status?.configured ? (
                  <div className="sync-provider-empty">
                    <span className="sync-provider-connect-icon"><MonitorSmartphone size={25} aria-hidden="true" /></span>
                    <span className="sync-provider-connect-copy">
                      <strong>Microsoft 365 ist noch nicht eingerichtet</strong>
                      <small>Die Microsoft-Anwendung muss einmalig durch die Systemadministration hinterlegt werden.</small>
                    </span>
                  </div>
                ) : deviceCode ? (
                  <div className="m365-device-inline" aria-live="polite">
                    <span className="sync-provider-connect-icon"><KeyRound size={25} aria-hidden="true" /></span>
                    <div className="sync-provider-connect-copy"><strong>Anmeldung abschließen</strong><small>Geben Sie diesen Code im Microsoft-Anmeldefenster ein.</small></div>
                    <strong className="m365-device-code-inline">{deviceCode.userCode}</strong>
                    <div className="button-row">
                      <button type="button" onClick={() => void copyDeviceCode()}><Copy size={17} /> Code kopieren</button>
                      <button className="primary" type="button" onClick={() => void openMicrosoft365SignIn()}><ExternalLink size={17} /> Microsoft öffnen</button>
                      <button type="button" onClick={() => void cancelAccountConnection()}>Abbrechen</button>
                    </div>
                  </div>
                ) : (
                  <div className="sync-provider-empty">
                    <span className="sync-provider-connect-icon"><MonitorSmartphone size={25} aria-hidden="true" /></span>
                    <span className="sync-provider-connect-copy">
                      <strong>Microsoft 365 verbinden</strong>
                      <small>Einmal anmelden, danach können Kontakte und Termine hier synchronisiert werden.</small>
                    </span>
                    <div className="button-row sync-provider-connect-actions">
                      <button className="primary sync-provider-connect-button" type="button" onClick={() => void connectAccount()} disabled={busy}>
                        {busy ? <LoaderCircle className="spin" size={19} aria-hidden="true" /> : <Cloud size={19} aria-hidden="true" />} {busy ? "Anmeldung läuft …" : "Jetzt anmelden"}
                      </button>
                      {showCodeFallback && <button type="button" onClick={() => void connectWithCode()} disabled={busy}>Anmeldung mit Code</button>}
                    </div>
                  </div>
                )}
              </>
            ) : (
              <>
                {m365Status.account && <section className="sync-account-card" aria-label="Microsoft-365-Konto">
                  <div className="sync-account-summary">
                    <span className="sync-account-avatar">{m365Status.account.displayName.trim().slice(0, 1).toUpperCase() || "M"}</span>
                    <span><strong>{m365Status.account.displayName}</strong><small>{m365Status.account.email || m365Status.account.userPrincipalName}</small></span>
                  </div>
                  <div className="button-row">
                    <button type="button" onClick={() => void checkAccount()} disabled={busy}><RefreshCw className={busy ? "spin" : ""} size={17} /> Verbindung prüfen</button>
                    <button className="danger-button" type="button" onClick={() => void disconnectAccount()} disabled={busy}><LogOut size={17} /> Abmelden</button>
                  </div>
                </section>}
                <section className="sync-quick-settings" aria-label="Grundlegende Einstellungen">
                  <label title="Kontakte und Kalender werden alle 30 Sekunden geprüft – auch wenn das Fenster geschlossen ist."><span><strong>Automatisch</strong><small>Alle 30 Sekunden · auch im Hintergrund</small></span><input type="checkbox" checked={config.enabled} onChange={(event) => updateConfig("enabled", event.target.checked)} /></label>
                  <label title="Kontakte zwischen der App und Microsoft 365 berücksichtigen."><ContactRound size={19} /><span><strong>Kontakte</strong></span><input type="checkbox" checked={config.contacts} onChange={(event) => updateConfig("contacts", event.target.checked)} /></label>
                  <label title="Termine zwischen der App und Microsoft 365 berücksichtigen."><CalendarDays size={19} /><span><strong>Kalender</strong></span><input type="checkbox" checked={config.calendars} onChange={(event) => updateConfig("calendars", event.target.checked)} /></label>
                </section>

                <div className="sync-primary-controls">
                  <label><span>Richtung</span><select value={config.direction} onChange={(event) => updateGlobalDirection(event.target.value as SyncDirection)}><option value="bidirectional">Beide Richtungen</option><option value="export">Nur App → Exchange</option><option value="import">Nur Exchange → App</option></select></label>
                  <div className="button-row">
                    <button type="button" onClick={togglePaused} disabled={busy}>{config.paused ? <PlayCircle size={18} /> : <PauseCircle size={18} />}{config.paused ? "Fortsetzen" : "Pausieren"}</button>
                     <button type="button" onClick={() => void checkAccount()} disabled={busy}>Konto prüfen</button>
                    <button type="button" onClick={createPreview} disabled={busy || config.paused || selectedSourceCount === 0}>Vorschau</button>
                    <button className="primary" type="button" onClick={saveConfig} disabled={busy}><Save size={17} /> Speichern</button>
                  </div>
                </div>

                <div className="sync-source-compact">
                  <span><strong>{selectedSourceCount}</strong> Quellen ausgewählt</span>
                  <span>{history[0] ? `Zuletzt ${new Date(history[0].finishedAt).toLocaleString("de-DE")}` : "Noch nicht synchronisiert"}</span>
                  <button type="button" onClick={refreshM365Sources} disabled={busy}>Aktualisieren</button>
                </div>

                {preview && <div className="synchronization-preview-card" aria-live="polite">
                  <strong>Vorschau</strong><span>{preview.createInM365} nach M365</span><span>{preview.importToApp} in die App</span><span>{preview.conflicts} Konflikte</span>
                  <small>{preview.changes.length === 0 ? "Alles ist aktuell." : `${preview.changes.length} Änderung(en) warten auf Bestätigung.`}</small>
                  {conflicts.length > 0 && <div className="synchronization-conflict-list">
                    <h4>Konflikte entscheiden</h4>
                    {conflicts.map((change) => <article key={change.id}>
                      <div><strong>{change.kind}: {change.title}</strong><small>{change.sourceName}</small></div>
                      <div className="synchronization-conflict-versions"><span><b>App</b>{change.localSummary}</span><span><b>M365</b>{change.remoteSummary}</span></div>
                      <label><span>Entscheidung</span><select value={conflictDecisions[change.id] ?? ""} onChange={(event) => setConflictDecisions((current) => ({ ...current, [change.id]: event.target.value as Microsoft365ConflictDecision }))}><option value="">Bitte wählen</option><option value="keepApp">Version der App behalten</option><option value="keepM365">Version aus M365 behalten</option><option value="merge">Beide zusammenführen</option><option value="ignore">Diesmal ignorieren</option></select></label>
                    </article>)}
                  </div>}
                  {preview.changes.length > 0 && <details><summary>Änderungen anzeigen</summary><ul>{preview.changes.slice(0, 100).map((change) => <li key={change.id}><strong>{change.action === "createRemote" || change.action === "updateRemote" ? "→" : change.action === "conflict" ? "↔" : "←"} {change.kind}: {change.title}</strong><span>{change.detail}</span></li>)}</ul></details>}
                  <div className="synchronization-apply-row"><span>{unresolvedConflicts > 0 ? `Noch ${unresolvedConflicts} Konflikt(e) entscheiden.` : "Bereit."}</span><button className="primary" type="button" onClick={applySync} disabled={busy || preview.changes.length === 0 || unresolvedConflicts > 0}>Jetzt synchronisieren</button></div>
                </div>}

                <details className="sync-card-details">
                  <summary>Quellen auswählen <small>{selectedSourceCount} aktiv</small></summary>
                  <div className="synchronization-source-mapping-list">
                    {!m365Sources && <p>Quellen werden geladen …</p>}
                    {m365Sources && [...m365Sources.contacts, ...m365Sources.calendars].map((source) => {
                      const selected = source.kind === "contactFolder" ? config.selectedContactSourceIds.includes(source.id) : config.selectedCalendarSourceIds.includes(source.id);
                      const direction = config.sourceDirections[source.id] ?? config.direction;
                      return <article key={`${source.kind}-${source.id}`} className={selected ? "selected" : ""}>
                        <label className="synchronization-source-choice"><input type="checkbox" checked={selected} onChange={(event) => toggleSource(source, event.target.checked)} /><span>{source.kind === "calendar" ? <CalendarDays size={18} /> : <ContactRound size={18} />}<strong>{source.name}</strong>{source.shared && <small>Freigegeben</small>}{isTechnicalMicrosoft365Source(source) && <small className="technical">Systemkalender</small>}</span></label>
                        <div className="synchronization-source-map"><select aria-label={`Richtung für ${source.name}`} value={direction} onChange={(event) => updateSourceDirection(source.id, event.target.value as SyncDirection)} disabled={!selected}><option value="bidirectional">Beide Richtungen</option><option value="export">App → M365</option><option value="import">M365 → App</option></select></div>
                      </article>;
                    })}
                  </div>
                </details>

                <details className="sync-card-details">
                  <summary>Weitere Optionen</summary>
                  <div className="synchronization-option-grid">
                    <label><input type="checkbox" checked={config.contactGroups} onChange={(event) => updateConfig("contactGroups", event.target.checked)} /> Kontaktgruppen</label>
                    <label><input type="checkbox" checked={config.recurringEvents} onChange={(event) => updateConfig("recurringEvents", event.target.checked)} /> Terminserien</label>
                    <label><input type="checkbox" checked={config.attendeesAndTeamsLinks} onChange={(event) => updateConfig("attendeesAndTeamsLinks", event.target.checked)} /> Teilnehmer und Teams-Links</label>
                    <label><input type="checkbox" checked={config.categoriesAndColors} onChange={(event) => updateConfig("categoriesAndColors", event.target.checked)} /> Kategorien und Farben</label>
                    <label><input type="checkbox" checked={config.sharedCalendars} onChange={(event) => updateConfig("sharedCalendars", event.target.checked)} /> Freigegebene Kalender</label>
                    <label><input type="checkbox" checked={config.runOnOpen} disabled={!config.enabled} onChange={(event) => updateConfig("runOnOpen", event.target.checked)} /> Beim Öffnen synchronisieren</label>
                  </div>
                </details>

                <details className="sync-card-details">
                  <summary>Freigegebene Postfächer <small>{config.sharedMailboxAddresses.length}</small></summary>
                  <div className="synchronization-mailbox-content">
                    <div className="synchronization-mailbox-entry"><input type="email" value={sharedMailboxAddress} onChange={(event) => setSharedMailboxAddress(event.target.value)} placeholder="team@firma.de" onKeyDown={(event) => { if (event.key === "Enter") { event.preventDefault(); addSharedMailbox(); } }} /><button type="button" onClick={addSharedMailbox}><Plus size={16} /> Hinzufügen</button></div>
                    {config.sharedMailboxAddresses.length > 0 && <ul>{config.sharedMailboxAddresses.map((address) => <li key={address}><span>{address}</span><button type="button" onClick={() => removeSharedMailbox(address)}>Entfernen</button></li>)}</ul>}
                    {m365Sources?.sharedMailboxes.some((mailbox) => !mailbox.available) && <div className="synchronization-warning"><CircleAlert size={18} /><span>Mindestens ein Postfach ist nicht erreichbar.</span></div>}
                  </div>
                </details>

                <details className="sync-card-details">
                  <summary>Verlauf <small>{history.length}</small></summary>
                  <div className="synchronization-history-list">
                    {history.length === 0 && <p>Noch keine Synchronisierung ausgeführt.</p>}
                    {history.map((entry) => <article key={entry.id}><div><strong>{new Date(entry.finishedAt).toLocaleString("de-DE")}</strong><small>{entry.errors > 0 ? "Mit Fehlern" : "Erfolgreich"}</small></div><span>{entry.created} erstellt</span><span>{entry.updated} aktualisiert</span><span>{entry.deleted ?? 0} gelöscht</span><span>{entry.conflicts} Konflikte</span><span className={entry.errors > 0 ? "has-errors" : ""}>{entry.errors} Fehler</span></article>)}
                  </div>
                </details>
              </>
            )}
          </div>}
        </article>
      </section>
    </div>
  );
}
