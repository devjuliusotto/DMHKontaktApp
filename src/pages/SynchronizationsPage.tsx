import { useEffect, useState } from "react";
import {
  ArrowLeftRight,
  CalendarDays,
  CheckCircle2,
  Cloud,
  ContactRound,
  KeyRound,
  LoaderCircle,
  MonitorSmartphone,
  Save,
  ShieldCheck,
  UploadCloud
} from "lucide-react";
import { StatusMessage } from "../components/StatusMessage";
import type { SettingsSection } from "../components/SettingsSubtabs";
import type { Page } from "../components/Sidebar";
import { getAppSetting, getBackupData, getMicrosoft365ConnectionStatus, listMicrosoft365SyncSources, previewMicrosoft365Sync, setAppSetting } from "../services/db";
import type { Microsoft365ConnectionStatus, Microsoft365SyncPreview, Microsoft365SyncSources } from "../types/m365";
import { defaultSyncConfig, parseSyncConfig, type SyncBase, type SyncConfig, type SyncDirection } from "../types/sync";
import { addBrowserDataToBackup } from "../utils/backup";

interface SynchronizationsPageProps {
  onNavigate: (page: Page, section?: SettingsSection) => void;
}

const syncConfigKey = "synchronization_config_v1";
const emptyStatus: Microsoft365ConnectionStatus = { configured: false, connected: false, account: null };

export function SynchronizationsPage({ onNavigate }: SynchronizationsPageProps) {
  const [config, setConfig] = useState<SyncConfig>(defaultSyncConfig);
  const [m365Status, setM365Status] = useState<Microsoft365ConnectionStatus | null>(null);
  const [m365Sources, setM365Sources] = useState<Microsoft365SyncSources | null>(null);
  const [preview, setPreview] = useState<Microsoft365SyncPreview | null>(null);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");
  const [messageType, setMessageType] = useState<"success" | "error" | "info">("info");

  useEffect(() => {
    getAppSetting(syncConfigKey).then((raw) => setConfig(parseSyncConfig(raw))).catch(() => setConfig(defaultSyncConfig));
    getMicrosoft365ConnectionStatus().then((status) => {
      setM365Status(status);
      if (status.connected) {
        listMicrosoft365SyncSources().then(setM365Sources).catch(() => setM365Sources(null));
      }
    }).catch(() => setM365Status(emptyStatus));
  }, []);

  const updateConfig = <K extends keyof SyncConfig>(key: K, value: SyncConfig[K]) => {
    setConfig((current) => ({ ...current, [key]: value }));
  };

  const saveConfig = async () => {
    setBusy(true);
    setMessage("");
    try {
      await setAppSetting(syncConfigKey, JSON.stringify(config));
      setMessageType("success");
      setMessage("Synchronisierungs-Einstellungen wurden gespeichert. Vor der ersten Ausführung wird eine klare Vorschau erstellt.");
    } catch (error) {
      setMessageType("error");
      setMessage(`Synchronisierungs-Einstellungen konnten nicht gespeichert werden: ${error}`);
    } finally {
      setBusy(false);
    }
  };

  const createPreview = async () => {
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
        backup
      });
      setPreview(nextPreview);
      setMessageType("info");
      setMessage("Vorschau erstellt. Es wurden noch keine Daten verändert.");
    } catch (error) {
      setMessageType("error");
      setMessage(`Synchronisierungsvorschau konnte nicht erstellt werden: ${error}`);
    } finally {
      setBusy(false);
    }
  };

  const directionLabel: Record<SyncDirection, string> = {
    bidirectional: "Bidirektional: beide Seiten dürfen Änderungen übertragen",
    export: "Nur exportieren: App → externe Apps",
    import: "Nur importieren: externe Apps → App"
  };
  const baseLabel: Record<SyncBase, string> = {
    app: "App als Basis",
    m365: "Microsoft 365 als Basis",
    "outlook-classic": "Outlook Classic als Basis",
    thunderbird: "Thunderbird als Basis"
  };

  return (
    <div className="page synchronizations-page">
      <header className="page-header">
        <div><h2>Synchronisierungen</h2><p>Bestimmen Sie genau, wer Daten an wen überträgt und welches System die Basis bildet.</p></div>
      </header>

      <StatusMessage message={message} type={messageType} />

      <section className="form-panel synchronization-intro-card">
        <span className="synchronization-icon"><ArrowLeftRight size={28} aria-hidden="true" /></span>
        <div>
          <h3>Sie behalten die Kontrolle</h3>
          <p>Die erste Synchronisierung verändert noch nichts automatisch. Zuerst zeigt die App eine verständliche Vorschau mit neuen, geänderten, gelöschten und widersprüchlichen Daten. Erst nach Ihrer Bestätigung werden Änderungen übertragen.</p>
        </div>
        <span className={config.enabled ? "synchronization-status enabled" : "synchronization-status planned"}>{config.enabled ? "Aktiviert" : "Noch nicht aktiviert"}</span>
      </section>

      <section className="form-panel synchronization-settings-card">
        <div className="synchronization-section-heading">
          <div><h3>Synchronisierungsrichtung und Basis</h3><p>Diese Auswahl wird vor jeder ersten Synchronisierung deutlich in der Vorschau angezeigt.</p></div>
          <label className="synchronization-toggle"><input type="checkbox" checked={config.enabled} onChange={(event) => updateConfig("enabled", event.target.checked)} /><span>Synchronisierung aktivieren</span></label>
        </div>
        <div className="synchronization-choice-grid">
          <label><span>Übertragungsrichtung</span><select value={config.direction} onChange={(event) => updateConfig("direction", event.target.value as SyncDirection)}><option value="bidirectional">Bidirektional</option><option value="export">Nur exportieren</option><option value="import">Nur importieren</option></select><small>{directionLabel[config.direction]}</small></label>
          <label><span>Basisdaten</span><select value={config.base} onChange={(event) => updateConfig("base", event.target.value as SyncBase)}><option value="app">App als Basis</option><option value="m365">Microsoft 365 als Basis</option><option value="outlook-classic">Outlook Classic als Basis</option><option value="thunderbird">Thunderbird als Basis</option></select><small>{baseLabel[config.base]}</small></label>
        </div>
        <div className="synchronization-flow-preview" aria-live="polite"><strong>{config.direction === "bidirectional" ? "↔" : config.direction === "export" ? "→" : "←"}</strong><span>{config.direction === "import" ? "Externe Apps" : "App"}</span><span>{config.direction === "export" ? "Externe Apps" : config.direction === "import" ? "App" : "Externe Apps"}</span><small>Basis: {baseLabel[config.base]}</small></div>
      </section>

      <section className="synchronization-section">
        <h3>Apps und Datenbereiche</h3>
        <div className="synchronization-provider-grid">
          <label className="form-panel synchronization-provider-card"><Cloud size={22} /><span><strong>Microsoft 365 / Exchange</strong><small>Online-Konto</small></span><input type="checkbox" checked={config.providers.m365} onChange={(event) => updateConfig("providers", { ...config.providers, m365: event.target.checked })} /></label>
          <label className="form-panel synchronization-provider-card"><MonitorSmartphone size={22} /><span><strong>Outlook Classic</strong><small>Lokales Outlook-Profil</small></span><input type="checkbox" checked={config.providers.outlookClassic} onChange={(event) => updateConfig("providers", { ...config.providers, outlookClassic: event.target.checked })} /></label>
          <label className="form-panel synchronization-provider-card"><UploadCloud size={22} /><span><strong>Thunderbird</strong><small>Lokales Thunderbird-Profil</small></span><input type="checkbox" checked={config.providers.thunderbird} onChange={(event) => updateConfig("providers", { ...config.providers, thunderbird: event.target.checked })} /></label>
        </div>
        <article className="form-panel synchronization-card">
          <span className="synchronization-icon microsoft"><Cloud size={28} aria-hidden="true" /></span>
          <div className="synchronization-card-copy"><h3>Microsoft 365 / Exchange</h3><p>Alle persönlichen Kontaktordner, Kalender und — sofern berechtigt — freigegebene Bereiche.</p>{m365Status === null && <span className="synchronization-state"><LoaderCircle className="spin" size={16} /> Verbindung wird geprüft …</span>}{m365Status && !m365Status.connected && <span className="synchronization-state"><MonitorSmartphone size={16} /> Noch nicht verbunden</span>}{m365Status?.connected && <span className="synchronization-state connected"><CheckCircle2 size={16} /> Verbunden{m365Status.account?.email ? ` · ${m365Status.account.email}` : ""}</span>}</div>
          <div className="synchronization-card-actions"><span className="synchronization-status planned">M365-Rechte erforderlich</span><button type="button" onClick={() => onNavigate("m365", "advanced")}>{m365Status?.connected ? "Verbindung verwalten" : "Verbinden"}</button>{m365Status?.connected && <button type="button" onClick={createPreview} disabled={busy}>Vorschau erstellen</button>}</div>
        </article>
        {m365Sources && (
          <div className="synchronization-source-summary">
            <strong>Gefundene M365-Quellen</strong>
            <span>{m365Sources.contacts.length} Kontaktordner</span>
            <span>{m365Sources.calendars.length} Kalender</span>
            <small>Die erste Übertragung wird daraus eine Vorschau mit Konflikten und Löschungen erstellen.</small>
          </div>
        )}
        {preview && <div className="synchronization-preview-card" aria-live="polite"><strong>Vorschau</strong><span>{preview.createInM365} nach M365</span><span>{preview.importToApp} in die App</span><span>{preview.conflicts} Konflikte</span><small>{preview.remoteContacts} M365-Kontakte und {preview.remoteEvents} M365-Termine erkannt. Keine Änderung wurde angewendet.</small>{preview.changes.length > 0 && <details><summary>Erste Änderungen anzeigen</summary><ul>{preview.changes.slice(0, 20).map((change, index) => <li key={`${change.kind}-${change.title}-${index}`}><strong>{change.action === "export" ? "→" : "←"} {change.kind}: {change.title}</strong><span>{change.detail}</span></li>)}</ul></details>}</div>}
        <div className="synchronization-capabilities">
          <label className="form-panel synchronization-capability-card"><ContactRound size={24} aria-hidden="true" /><span><strong>Kontakte</strong><small>inkl. Gruppen</small></span><input type="checkbox" checked={config.contacts} onChange={(event) => updateConfig("contacts", event.target.checked)} /></label>
          <label className="form-panel synchronization-capability-card"><CalendarDays size={24} aria-hidden="true" /><span><strong>Kalender</strong><small>inkl. Serien und Teams</small></span><input type="checkbox" checked={config.calendars} onChange={(event) => updateConfig("calendars", event.target.checked)} /></label>
          <label className="form-panel synchronization-capability-card"><KeyRound size={24} aria-hidden="true" /><span><strong>Passwörter</strong><small>Nur lokaler Tresor</small></span><input type="checkbox" checked={false} disabled aria-label="Passwörter werden nicht synchronisiert" /></label>
        </div>
      </section>

      <section className="form-panel synchronization-options-card"><h3>Umfang und Ausführung</h3><div className="synchronization-check-grid">
        <label><input type="checkbox" checked={config.contactGroups} onChange={(event) => updateConfig("contactGroups", event.target.checked)} /> Gruppen von Kontakten</label>
        <label><input type="checkbox" checked={config.recurringEvents} onChange={(event) => updateConfig("recurringEvents", event.target.checked)} /> Wiederkehrende Termine</label>
        <label><input type="checkbox" checked={config.attendeesAndTeamsLinks} onChange={(event) => updateConfig("attendeesAndTeamsLinks", event.target.checked)} /> Teilnehmer und Teams-Links</label>
        <label><input type="checkbox" checked={config.categoriesAndColors} onChange={(event) => updateConfig("categoriesAndColors", event.target.checked)} /> Kategorien und Farben</label>
        <label><input type="checkbox" checked={config.sharedCalendars} onChange={(event) => updateConfig("sharedCalendars", event.target.checked)} /> Freigegebene Kalender</label>
        <label><input type="checkbox" checked={config.sharedMailboxes} onChange={(event) => updateConfig("sharedMailboxes", event.target.checked)} /> Freigegebene Postfächer</label>
        <label><input type="checkbox" checked={config.runOnOpen} onChange={(event) => updateConfig("runOnOpen", event.target.checked)} /> Beim Öffnen im Hintergrund prüfen</label>
        <label><input type="checkbox" checked={config.runOnClose} onChange={(event) => updateConfig("runOnClose", event.target.checked)} /> Beim Schließen im Hintergrund ausführen</label>
      </div></section>

      <section className="form-panel synchronization-safety-card"><ShieldCheck size={24} aria-hidden="true" /><div><h3>Löschen und Backup</h3><p>Gelöschte Einträge werden vor der Übertragung im lokalen Backup mit „Gelöschtes Element“ erhalten. Die Synchronisierung kann sie danach auch im Zielsystem löschen.</p></div><button className="primary" type="button" onClick={saveConfig} disabled={busy}><Save size={18} /> Einstellungen speichern</button></section>
      <section className="form-panel synchronization-import-card"><UploadCloud size={24} aria-hidden="true" /><div><h3>Einmalige Übernahme</h3><p>Outlook Classic und Thunderbird werden als lokale Quellen vorbereitet. Die erste echte Übertragung läuft ebenfalls über eine Vorschau.</p></div><button type="button" onClick={() => onNavigate("simple-import", "import")}>Import öffnen</button></section>
    </div>
  );
}
