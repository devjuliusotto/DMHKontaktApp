import { useEffect, useMemo, useState } from "react";
import {
  ArrowLeftRight,
  CalendarDays,
  CheckCircle2,
  CircleAlert,
  Cloud,
  ContactRound,
  KeyRound,
  LoaderCircle,
  MonitorSmartphone,
  PauseCircle,
  PlayCircle,
  Plus,
  Save,
  ShieldCheck,
  UploadCloud
} from "lucide-react";
import { StatusMessage } from "../components/StatusMessage";
import type { SettingsSection } from "../components/SettingsSubtabs";
import type { Page } from "../components/Sidebar";
import { applyMicrosoft365Sync, createAutomaticBackup, createAutomaticPasswordBackup, getAppSetting, getBackupData, getMicrosoft365ConnectionStatus, listMicrosoft365SyncSources, previewMicrosoft365Sync, setAppSetting } from "../services/db";
import type { Microsoft365ConflictDecision, Microsoft365ConnectionStatus, Microsoft365SyncHistoryEntry, Microsoft365SyncPreview, Microsoft365SyncSource, Microsoft365SyncSources } from "../types/m365";
import { defaultSyncConfig, parseSyncConfig, type SyncBase, type SyncConfig, type SyncDirection } from "../types/sync";
import { addBrowserDataToBackup } from "../utils/backup";
import { calendarStorageKey } from "../utils/calendar";
import type { CalendarEvent } from "../types/calendar";

interface SynchronizationsPageProps {
  onNavigate: (page: Page, section?: SettingsSection) => void;
}

const syncConfigKey = "synchronization_config_v1";
const syncHistoryKey = "synchronization_history_v1";
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
            setConfig(initializeSourceSelection(nextConfig, sources));
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
    setBusy(true);
    setMessage("");
    try {
      const safeConfig = { ...config, enabled: false, runOnOpen: false, runOnClose: false };
      setConfig(safeConfig);
      await setAppSetting(syncConfigKey, JSON.stringify(safeConfig));
      setMessageType("success");
      setMessage("Einstellungen gespeichert.");
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
      if (result.calendarUpserts.length > 0) {
        const current = JSON.parse(localStorage.getItem(calendarStorageKey) ?? "[]") as CalendarEvent[];
        const byId = new Map(current.map((event) => [event.id, event]));
        for (const event of result.calendarUpserts) byId.set(event.id, event);
        localStorage.setItem(calendarStorageKey, JSON.stringify(Array.from(byId.values())));
      }
      await persistHistory({ ...result, id: `${result.startedAt}-${Date.now()}` });
      setPreview(null);
      setConflictDecisions({});
      setMessageType(result.errors > 0 ? "error" : "success");
      setMessage(`${result.created} erstellt, ${result.updated} aktualisiert, ${result.ignored} ignoriert, ${result.errors} Fehler.`);
    } catch (error) {
      setMessageType("error");
      setMessage(`Synchronisierung konnte nicht abgeschlossen werden: ${error}`);
    } finally {
      setBusy(false);
    }
  };

  const directionLabel: Record<SyncDirection, string> = {
    bidirectional: "Beide Seiten dürfen Änderungen übertragen",
    export: "Nur von der App zu externen Apps",
    import: "Nur von externen Apps zur App"
  };
  const baseLabel: Record<SyncBase, string> = {
    app: "App als Basis",
    m365: "Microsoft 365 als Basis",
    "outlook-classic": "Outlook Classic als Basis",
    thunderbird: "Thunderbird als Basis"
  };

  const connectedLabel = m365Status?.connected
    ? `Verbunden${m365Status.account?.email ? ` · ${m365Status.account.email}` : ""}`
    : "Noch nicht verbunden";

  return (
    <div className="page synchronizations-page">
      <header className="page-header synchronization-page-header">
        <div>
          <h2>Synchronisierungen</h2>
          <p>Quellen auswählen, Vorschau prüfen und bewusst starten.</p>
        </div>
        <button className={config.paused ? "synchronization-resume-button" : "synchronization-pause-button"} type="button" onClick={togglePaused}>
          {config.paused ? <PlayCircle size={18} /> : <PauseCircle size={18} />}
          {config.paused ? "Fortsetzen" : "Pausieren"}
        </button>
      </header>

      <StatusMessage message={message} type={messageType} />

      <section className="synchronization-hero-card form-panel">
        <span className="synchronization-icon"><ArrowLeftRight size={26} aria-hidden="true" /></span>
        <div>
          <strong>{config.paused ? "Synchronisierung ist pausiert." : "Änderungen werden erst nach deiner Bestätigung ausgeführt."}</strong>
          <p>{config.paused ? "Alle Einstellungen bleiben erhalten." : "Zuerst Quellen wählen, dann Vorschau kontrollieren und Konflikte entscheiden."}</p>
        </div>
        <span className="synchronization-status planned">{config.paused ? "Pausiert" : "Manuell"}</span>
      </section>

      <section className="synchronization-overview-grid" aria-label="Übersicht">
        <article className="form-panel synchronization-overview-card">
          <Cloud size={21} aria-hidden="true" />
          <span><small>Verbindung</small><strong>Microsoft 365</strong><em className={m365Status?.connected ? "connected" : ""}>{m365Status === null ? "Prüfung läuft …" : connectedLabel}</em></span>
        </article>
        <article className="form-panel synchronization-overview-card">
          <ContactRound size={21} aria-hidden="true" />
          <span><small>Quellen</small><strong>{selectedSourceCount} ausgewählt</strong><em>Ordner und Kalender</em></span>
        </article>
        <article className="form-panel synchronization-overview-card">
          <ShieldCheck size={21} aria-hidden="true" />
          <span><small>Letzte Ausführung</small><strong>{history[0] ? new Date(history[0].finishedAt).toLocaleString("de-DE") : "Noch nie"}</strong><em>{history[0] ? `${history[0].created + history[0].updated} Änderungen` : "Kein Verlauf"}</em></span>
        </article>
      </section>

      <section className="synchronization-main-card form-panel">
        <div className="synchronization-main-card-header">
          <div className="synchronization-main-card-title">
            <span className="synchronization-icon microsoft"><Cloud size={25} aria-hidden="true" /></span>
            <div><h3>Microsoft 365 / Exchange</h3><span className={m365Status?.connected ? "synchronization-state connected" : "synchronization-state"}>{m365Status === null && <LoaderCircle className="spin" size={15} />}{m365Status?.connected && <CheckCircle2 size={15} />}{!m365Status?.connected && m365Status !== null && <MonitorSmartphone size={15} />}{connectedLabel}</span></div>
          </div>
          <div className="synchronization-main-actions">
            <button type="button" onClick={() => onNavigate("m365", "advanced")}>{m365Status?.connected ? "Verbindung verwalten" : "Verbinden"}</button>
            {m365Status?.connected && <button className="primary" type="button" onClick={createPreview} disabled={busy || config.paused || selectedSourceCount === 0}>Vorschau erstellen</button>}
          </div>
        </div>

        {m365Status?.connected && <div className="synchronization-source-line">
          <span>{m365Sources ? `${m365Sources.contacts.length} Kontaktordner · ${m365Sources.calendars.length} Kalender` : "Quellen noch nicht geladen"}</span>
          <button type="button" onClick={refreshM365Sources} disabled={busy}>Aktualisieren</button>
        </div>}

        {preview && <div className="synchronization-preview-card" aria-live="polite">
          <strong>Vorschau</strong>
          <span>{preview.createInM365} nach M365</span>
          <span>{preview.importToApp} in die App</span>
          <span>{preview.conflicts} Konflikte</span>
          <small>{preview.changes.length === 0 ? "Alles ist aktuell." : `${preview.changes.length} Änderung(en) warten auf Bestätigung.`}</small>

          {conflicts.length > 0 && <div className="synchronization-conflict-list">
            <h4>Konflikte entscheiden</h4>
            {conflicts.map((change) => <article key={change.id}>
              <div><strong>{change.kind}: {change.title}</strong><small>{change.sourceName}</small></div>
              <div className="synchronization-conflict-versions"><span><b>App</b>{change.localSummary}</span><span><b>M365</b>{change.remoteSummary}</span></div>
              <label><span>Entscheidung</span><select value={conflictDecisions[change.id] ?? ""} onChange={(event) => setConflictDecisions((current) => ({ ...current, [change.id]: event.target.value as Microsoft365ConflictDecision }))}><option value="">Bitte wählen</option><option value="keepApp">Version der App behalten</option><option value="keepM365">Version aus M365 behalten</option><option value="merge">Beide zusammenführen</option><option value="ignore">Diesmal ignorieren</option></select></label>
            </article>)}
          </div>}

          {preview.changes.length > 0 && <details><summary>Alle geplanten Änderungen anzeigen</summary><ul>{preview.changes.slice(0, 100).map((change) => <li key={change.id}><strong>{change.action === "createRemote" || change.action === "updateRemote" ? "→" : change.action === "conflict" ? "↔" : "←"} {change.kind}: {change.title}</strong><span>{change.detail}</span></li>)}</ul></details>}
          <div className="synchronization-apply-row"><span>{unresolvedConflicts > 0 ? `Noch ${unresolvedConflicts} Konflikt(e) entscheiden.` : "Bereit zur Ausführung."}</span><button className="primary" type="button" onClick={applySync} disabled={busy || preview.changes.length === 0 || unresolvedConflicts > 0}>Synchronisieren jetzt</button></div>
        </div>}
      </section>

      <details className="synchronization-details form-panel">
        <summary><span><strong>Was soll geprüft werden?</strong><small>Kontakte, Kalender und freigegebene Bereiche</small></span></summary>
        <div className="synchronization-data-grid">
          <label><ContactRound size={19} /><span><strong>Kontakte</strong><small>inkl. Kontaktgruppen</small></span><input type="checkbox" checked={config.contacts} onChange={(event) => updateConfig("contacts", event.target.checked)} /></label>
          <label><CalendarDays size={19} /><span><strong>Kalender</strong><small>inkl. Serien und Teams-Links</small></span><input type="checkbox" checked={config.calendars} onChange={(event) => updateConfig("calendars", event.target.checked)} /></label>
          <label><KeyRound size={19} /><span><strong>Passwörter</strong><small>Nur lokaler Tresor</small></span><input type="checkbox" checked={false} disabled aria-label="Passwörter werden nicht synchronisiert" /></label>
        </div>
        <div className="synchronization-option-row">
          <label><input type="checkbox" checked={config.sharedCalendars} onChange={(event) => updateConfig("sharedCalendars", event.target.checked)} /> Freigegebene Kalender</label>
          <label><input type="checkbox" checked={config.sharedMailboxes} onChange={(event) => updateConfig("sharedMailboxes", event.target.checked)} /> Freigegebene Postfächer</label>
        </div>
      </details>

      {m365Status?.connected && <details className="synchronization-details form-panel">
        <summary><span><strong>Quellen und Zuordnung</strong><small>{selectedSourceCount} von {(m365Sources?.contacts.length ?? 0) + (m365Sources?.calendars.length ?? 0)} Quellen ausgewählt</small></span></summary>
        <div className="synchronization-source-mapping-list">
          {!m365Sources && <p>Quellen werden geladen …</p>}
          {m365Sources && [...m365Sources.contacts, ...m365Sources.calendars].map((source) => {
            const selected = source.kind === "contactFolder" ? config.selectedContactSourceIds.includes(source.id) : config.selectedCalendarSourceIds.includes(source.id);
            const direction = config.sourceDirections[source.id] ?? config.direction;
            const mapping = direction === "export" ? `App → M365: ${source.name}` : direction === "import" ? `M365 → App: ${source.name}` : `App ↔ M365: ${source.name}`;
            return <article key={`${source.kind}-${source.id}`} className={selected ? "selected" : ""}>
              <label className="synchronization-source-choice"><input type="checkbox" checked={selected} onChange={(event) => toggleSource(source, event.target.checked)} /><span>{source.kind === "calendar" ? <CalendarDays size={18} /> : <ContactRound size={18} />}<strong>{source.name}</strong>{source.shared && <small>Freigegeben</small>}{isTechnicalSource(source) && <small className="technical">Technisch – standardmäßig ausgeschlossen</small>}</span></label>
              <div className="synchronization-source-map"><span>{selected ? mapping : "Ausgeschlossen"}</span><select value={direction} onChange={(event) => updateSourceDirection(source.id, event.target.value as SyncDirection)} disabled={!selected}><option value="bidirectional">Beide Richtungen</option><option value="export">App → M365</option><option value="import">M365 → App</option></select></div>
            </article>;
          })}
        </div>
      </details>}

      {m365Status?.connected && <details className="synchronization-details form-panel">
        <summary><span><strong>Freigegebene Postfächer</strong><small>{config.sharedMailboxAddresses.length === 0 ? "Noch keine Adresse hinzugefügt" : `${config.sharedMailboxAddresses.length} Adresse(n) hinterlegt`}</small></span></summary>
        <div className="synchronization-mailbox-content">
          <p>Trage hier nur Postfächer ein, für die der Benutzer bereits Exchange-Rechte besitzt. Die App prüft Kontakte und Kalender, keine E-Mails.</p>
          <div className="synchronization-mailbox-entry"><input type="email" value={sharedMailboxAddress} onChange={(event) => setSharedMailboxAddress(event.target.value)} placeholder="z. B. team@firma.de" onKeyDown={(event) => { if (event.key === "Enter") { event.preventDefault(); addSharedMailbox(); } }} /><button type="button" onClick={addSharedMailbox}><Plus size={16} /> Hinzufügen</button></div>
          {config.sharedMailboxAddresses.length > 0 && <ul>{config.sharedMailboxAddresses.map((address) => <li key={address}><span>{address}</span><button type="button" onClick={() => removeSharedMailbox(address)}>Entfernen</button></li>)}</ul>}
          {m365Sources?.sharedMailboxes.some((mailbox) => !mailbox.available) && <div className="synchronization-warning"><CircleAlert size={18} /><span>Mindestens ein Postfach ist nicht erreichbar. Bitte Berechtigung und Adresse prüfen.</span></div>}
        </div>
      </details>}

      <details className="synchronization-details form-panel">
        <summary><span><strong>Richtung und Basis</strong><small>{directionLabel[config.direction]} · {baseLabel[config.base]}</small></span></summary>
        <div className="synchronization-choice-grid">
          <label><span>Richtung</span><select value={config.direction} onChange={(event) => updateConfig("direction", event.target.value as SyncDirection)}><option value="bidirectional">Bidirektional</option><option value="export">Nur exportieren</option><option value="import">Nur importieren</option></select></label>
          <label><span>Basis</span><select value={config.base} onChange={(event) => updateConfig("base", event.target.value as SyncBase)}><option value="app">App</option><option value="m365">Microsoft 365</option><option value="outlook-classic">Outlook Classic</option><option value="thunderbird">Thunderbird</option></select></label>
        </div>
      </details>

      <details className="synchronization-details form-panel">
        <summary><span><strong>Weitere Einstellungen</strong><small>Serien, Kategorien und kommende Funktionen</small></span></summary>
        <div className="synchronization-option-grid">
          <label><input type="checkbox" checked={config.contactGroups} onChange={(event) => updateConfig("contactGroups", event.target.checked)} /> Kontaktgruppen</label>
          <label><input type="checkbox" checked={config.recurringEvents} onChange={(event) => updateConfig("recurringEvents", event.target.checked)} /> Wiederkehrende Termine</label>
          <label><input type="checkbox" checked={config.attendeesAndTeamsLinks} onChange={(event) => updateConfig("attendeesAndTeamsLinks", event.target.checked)} /> Teilnehmer und Teams-Links</label>
          <label><input type="checkbox" checked={config.categoriesAndColors} onChange={(event) => updateConfig("categoriesAndColors", event.target.checked)} /> Kategorien und Farben</label>
          <label className="is-disabled"><input type="checkbox" checked={false} disabled /> Beim Öffnen automatisch synchronisieren <small>(folgt)</small></label>
          <label className="is-disabled"><input type="checkbox" checked={false} disabled /> Beim Schließen automatisch synchronisieren <small>(folgt)</small></label>
        </div>
        <div className="synchronization-future-providers"><MonitorSmartphone size={17} /><span>Outlook Classic und Thunderbird sind derzeit nur als Einmalimport verfügbar.</span></div>
      </details>

      <details className="synchronization-details form-panel">
        <summary><span><strong>Synchronisierungsverlauf</strong><small>{history.length === 0 ? "Noch keine Ausführung" : `${history.length} gespeicherte Ausführung(en)`}</small></span></summary>
        <div className="synchronization-history-list">
          {history.length === 0 && <p>Noch keine Synchronisierung ausgeführt.</p>}
          {history.map((entry) => <article key={entry.id}>
            <div><strong>{new Date(entry.finishedAt).toLocaleString("de-DE")}</strong><small>{entry.errors > 0 ? "Mit Fehlern" : "Erfolgreich"}</small></div>
            <span>{entry.created} erstellt</span><span>{entry.updated} aktualisiert</span><span>{entry.ignored} ignoriert</span><span>{entry.conflicts} Konflikte</span><span className={entry.errors > 0 ? "has-errors" : ""}>{entry.errors} Fehler</span>
            {entry.errorMessages.length > 0 && <details><summary>Fehler anzeigen</summary><ul>{entry.errorMessages.map((error, index) => <li key={`${entry.id}-${index}`}>{error}</li>)}</ul></details>}
          </article>)}
        </div>
      </details>

      <section className="synchronization-footer-card form-panel">
        <div><ShieldCheck size={21} /><span><strong>Snapshot vor jeder Ausführung</strong><small>Die manuelle Synchronisierung sichert zuerst Kontakte, Kalender und Passwörter.</small></span></div>
        <button className="primary" type="button" onClick={saveConfig} disabled={busy}><Save size={17} /> Einstellungen speichern</button>
      </section>

      <section className="synchronization-import-link"><UploadCloud size={17} /><span>Nur einmalig aus Outlook oder Thunderbird übernehmen?</span><button type="button" onClick={() => onNavigate("simple-import", "import")}>Import öffnen</button></section>
    </div>
  );
}
