import { useEffect, useMemo, useState } from "react";
import {
  CalendarDays,
  ChevronDown,
  CircleAlert,
  Cloud,
  ContactRound,
  MonitorSmartphone,
  PauseCircle,
  PlayCircle,
  Plus,
  Save
} from "lucide-react";
import { StatusMessage } from "../components/StatusMessage";
import type { SettingsSection } from "../components/SettingsSubtabs";
import type { Page } from "../components/Sidebar";
import { applyMicrosoft365Sync, createAutomaticBackup, createAutomaticPasswordBackup, getAppSetting, getBackupData, getMicrosoft365ConnectionStatus, listMicrosoft365SyncSources, previewMicrosoft365Sync, setAppSetting } from "../services/db";
import type { Microsoft365ConflictDecision, Microsoft365ConnectionStatus, Microsoft365SyncHistoryEntry, Microsoft365SyncPreview, Microsoft365SyncSource, Microsoft365SyncSources } from "../types/m365";
import { defaultSyncConfig, parseSyncConfig, type SyncConfig, type SyncDirection } from "../types/sync";
import { addBrowserDataToBackup } from "../utils/backup";
import { calendarStorageKey, calendarTrashStorageKey, mergeImportedCalendarCategories } from "../utils/calendar";
import { calendarChangedEventName, synchronizationConfigKey as syncConfigKey, synchronizationHistoryKey as syncHistoryKey } from "../utils/automaticCalendarSync";
import type { CalendarEvent } from "../types/calendar";

interface SynchronizationsPageProps {
  onNavigate: (page: Page, section?: SettingsSection) => void;
}

const emptyStatus: Microsoft365ConnectionStatus = { configured: false, connected: false, account: null };

function isTechnicalSource(source: Microsoft365SyncSource): boolean {
  return /(birthday|birthdays|geburtstag|geburtstage|holiday|holidays|feiertag|feiertage|weather|wetter|trash|papierkorb)/i.test(source.name);
}

function initializeSourceSelection(config: SyncConfig, sources: Microsoft365SyncSources): SyncConfig {
  const directions = { ...config.sourceDirections };
  const selectedContacts = new Set(config.selectedContactSourceIds);
  const selectedCalendars = new Set(config.selectedCalendarSourceIds);
  for (const source of [...sources.contacts, ...sources.calendars]) {
    if (directions[source.id]) continue;
    directions[source.id] = config.direction;
    if (!isTechnicalSource(source)) {
      if (source.kind === "contactFolder") selectedContacts.add(source.id);
      else selectedCalendars.add(source.id);
    }
  }
  return {
    ...config,
    sourceSelectionInitialized: true,
    selectedContactSourceIds: Array.from(selectedContacts),
    selectedCalendarSourceIds: Array.from(selectedCalendars),
    sourceDirections: directions
  };
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

export function SynchronizationsPage({ onNavigate }: SynchronizationsPageProps) {
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

  const selectedSourceCount = config.selectedContactSourceIds.length + config.selectedCalendarSourceIds.length;
  const conflicts = useMemo(() => preview?.changes.filter((change) => change.action === "conflict") ?? [], [preview]);
  const unresolvedConflicts = conflicts.filter((change) => !conflictDecisions[change.id]).length;

  const updateConfig = <K extends keyof SyncConfig>(key: K, value: SyncConfig[K]) => {
    setConfig((current) => ({ ...current, [key]: value }));
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
      const savedConfig = { ...config, runOnClose: false };
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
      const backup = addBrowserDataToBackup(await getBackupData());
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
      const backup = addBrowserDataToBackup(await getBackupData());
      await createAutomaticBackup(backup, true);
      await createAutomaticPasswordBackup(true);
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
        const current = JSON.parse(localStorage.getItem(calendarStorageKey) ?? "[]") as CalendarEvent[];
        const deletedIds = new Set(result.calendarDeletes);
        const removed = current.filter((event) => deletedIds.has(event.id)).map((event) => ({ ...event, deletedAt: new Date().toISOString() }));
        if (removed.length > 0) {
          const trash = JSON.parse(localStorage.getItem(calendarTrashStorageKey) ?? "[]") as CalendarEvent[];
          const removedIds = new Set(removed.map((event) => event.id));
          localStorage.setItem(calendarTrashStorageKey, JSON.stringify([...removed, ...trash.filter((event) => !removedIds.has(event.id))]));
        }
        const byId = new Map(current.filter((event) => !deletedIds.has(event.id)).map((event) => [event.id, event]));
        for (const event of result.calendarUpserts) byId.set(event.id, event);
        localStorage.setItem(calendarStorageKey, JSON.stringify(Array.from(byId.values())));
        mergeImportedCalendarCategories(result.calendarUpserts);
      }
      await persistHistory({ ...result, id: `${result.startedAt}-${Date.now()}` });
      setPreview(null);
      setConflictDecisions({});
      setMessageType(result.errors > 0 ? "error" : "success");
      setMessage(`${result.created} erstellt, ${result.updated} aktualisiert, ${result.deleted} gelöscht, ${result.ignored} ignoriert, ${result.errors} Fehler.`);
    } catch (error) {
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
    <div className="page synchronizations-page">
      <header className="page-header">
        <div>
          <h2>Microsoft-365-Synchronisierung</h2>
          <p>Kontakte und Termine mit Microsoft 365 abgleichen.</p>
        </div>
      </header>

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
              <div className="sync-provider-empty">
                <MonitorSmartphone size={23} aria-hidden="true" />
                <span>Microsoft 365 muss einmal verbunden werden.</span>
                <button className="primary" type="button" onClick={() => onNavigate("m365", "sync")}>Verbinden</button>
              </div>
            ) : (
              <>
                <section className="sync-quick-settings" aria-label="Grundlegende Einstellungen">
                  <label title="Lokale Änderungen werden direkt gesendet. Änderungen aus Microsoft 365 werden im Vordergrund spätestens nach etwa 30 Sekunden gelesen."><span><strong>Automatisch</strong><small>Lokal sofort · M365 alle 30 Sek.</small></span><input type="checkbox" checked={config.enabled} onChange={(event) => updateConfig("enabled", event.target.checked)} /></label>
                  <label title="Kontakte zwischen der App und Microsoft 365 berücksichtigen."><ContactRound size={19} /><span><strong>Kontakte</strong></span><input type="checkbox" checked={config.contacts} onChange={(event) => updateConfig("contacts", event.target.checked)} /></label>
                  <label title="Termine zwischen der App und Microsoft 365 berücksichtigen."><CalendarDays size={19} /><span><strong>Kalender</strong></span><input type="checkbox" checked={config.calendars} onChange={(event) => updateConfig("calendars", event.target.checked)} /></label>
                </section>

                <div className="sync-primary-controls">
                  <label><span>Richtung</span><select value={config.direction} onChange={(event) => updateConfig("direction", event.target.value as SyncDirection)}><option value="bidirectional">Beide Richtungen</option><option value="export">App → Microsoft 365</option><option value="import">Microsoft 365 → App</option></select></label>
                  <div className="button-row">
                    <button type="button" onClick={togglePaused} disabled={busy}>{config.paused ? <PlayCircle size={18} /> : <PauseCircle size={18} />}{config.paused ? "Fortsetzen" : "Pausieren"}</button>
                    <button type="button" onClick={() => onNavigate("m365", "sync")}>Konto</button>
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
                        <label className="synchronization-source-choice"><input type="checkbox" checked={selected} onChange={(event) => toggleSource(source, event.target.checked)} /><span>{source.kind === "calendar" ? <CalendarDays size={18} /> : <ContactRound size={18} />}<strong>{source.name}</strong>{source.shared && <small>Freigegeben</small>}{isTechnicalSource(source) && <small className="technical">Systemkalender</small>}</span></label>
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
