import type { LucideIcon } from "lucide-react";
import {
  ArrowLeft,
  ArrowRight,
  CalendarDays,
  Check,
  CheckCircle2,
  ContactRound,
  Files,
  FolderSearch,
  KeyRound,
  LoaderCircle,
  MonitorSmartphone,
  Settings,
  ShieldCheck,
  Sparkles,
  UserRound,
  Wrench
} from "lucide-react";
import { useMemo, useState } from "react";
import {
  getMicrosoft365ConnectionStatus,
  importOutlookClassicAppointmentsOnce,
  importSelectedOutlookClassicContacts,
  importThunderbirdCalendarsOnce,
  importThunderbirdContactsOnce,
  listMicrosoft365SyncSources,
  previewOutlookClassicAppointments,
  previewOutlookClassicContacts,
  previewThunderbirdData
} from "../services/db";
import type { OutlookCalendarPreview } from "../types/calendar";
import type { OutlookContactImportPreview, ThunderbirdDataPreview } from "../types/contact";
import type { Microsoft365ConnectionStatus } from "../types/m365";
import { calendarColorFromCategory, calendarStorageKey, mergeImportedCalendarCategories } from "../utils/calendar";
import { calendarChangedEventName } from "../utils/automaticCalendarSync";
import { mergeCalendarEventsExactly } from "../utils/calendarDuplicates";

type OnboardingStage = "welcome" | "tour" | "import" | "finished";
type ImportSelectionKey = "outlookContacts" | "outlookCalendars" | "thunderbirdContacts" | "thunderbirdCalendars";

interface OnboardingDialogProps {
  authenticatorEnabled: boolean;
  servicesEnabled: boolean;
  onComplete: () => Promise<void>;
}

interface TourItem {
  title: string;
  description: string;
  hint: string;
  icon: LucideIcon;
}

interface ScanResult {
  outlookContacts: OutlookContactImportPreview | null;
  outlookCalendars: OutlookCalendarPreview | null;
  thunderbird: ThunderbirdDataPreview | null;
  microsoft365: Microsoft365ConnectionStatus | null;
  microsoft365Contacts: number;
  microsoft365Calendars: number;
  notices: string[];
}

interface ImportChoiceCardProps {
  checked: boolean;
  count: number;
  description: string;
  disabled?: boolean;
  icon: LucideIcon;
  label: string;
  meta: string;
  onChange: (checked: boolean) => void;
}

const BASE_TOUR: TourItem[] = [
  { title: "Kontakte", description: "Personen, Telefonnummern, E-Mail-Adressen und Gruppen an einem Ort verwalten.", hint: "Mit „Neuer Kontakt“ können Sie jederzeit selbst jemanden hinzufügen.", icon: UserRound },
  { title: "Kalender", description: "Termine übersichtlich nach Tag, Woche oder Monat anzeigen und bearbeiten.", hint: "Ein Klick auf einen freien Zeitpunkt erstellt einen neuen Termin.", icon: CalendarDays },
  { title: "Passwörter", description: "Kennwörter geschützt auf diesem Computer speichern und schnell wiederfinden.", hint: "Vor dem ersten Kennwort richten Sie den persönlichen Schutz ein.", icon: KeyRound },
  { title: "Dokumente", description: "Dateien aus OneDrive und SharePoint ähnlich wie im Windows-Explorer öffnen.", hint: "Dokumente können auch für die Offline-Nutzung gespeichert werden.", icon: Files },
  { title: "Einstellungen", description: "Konten, Synchronisierungen, Darstellung, Sicherungen und Importe verwalten.", hint: "Die Einführung kann dort später jederzeit erneut geöffnet werden.", icon: Settings }
];

const EMPTY_SELECTION: Record<ImportSelectionKey, boolean> = {
  outlookContacts: false,
  outlookCalendars: false,
  thunderbirdContacts: false,
  thunderbirdCalendars: false
};

function ImportChoiceCard({ checked, count, description, disabled = false, icon: Icon, label, meta, onChange }: ImportChoiceCardProps) {
  return (
    <label className={`${checked ? "onboarding-import-choice selected" : "onboarding-import-choice"}${disabled ? " disabled" : ""}`}>
      <input type="checkbox" checked={checked} disabled={disabled} onChange={(event) => onChange(event.target.checked)} />
      <span className="onboarding-import-choice-icon"><Icon size={23} aria-hidden="true" /></span>
      <span className="onboarding-import-choice-copy"><strong>{label}</strong><small>{description}</small><em>{meta}</em></span>
      <span className="onboarding-import-choice-count">{count}</span>
    </label>
  );
}

export function OnboardingDialog({ authenticatorEnabled, servicesEnabled, onComplete }: OnboardingDialogProps) {
  const [stage, setStage] = useState<OnboardingStage>("welcome");
  const [tourIndex, setTourIndex] = useState(0);
  const [scanning, setScanning] = useState(false);
  const [importing, setImporting] = useState(false);
  const [scanResult, setScanResult] = useState<ScanResult | null>(null);
  const [selection, setSelection] = useState<Record<ImportSelectionKey, boolean>>(EMPTY_SELECTION);
  const [message, setMessage] = useState("");
  const [importSummary, setImportSummary] = useState<string[]>([]);

  const tourItems = useMemo(() => {
    const items = [...BASE_TOUR];
    if (authenticatorEnabled) items.splice(3, 0, { title: "2FA-Authenticator", description: "Einmalcodes direkt am PC erzeugen, ohne jedes Mal das Handy zu suchen.", hint: "Neue Konten werden über einen QR-Code oder einen geheimen Schlüssel hinzugefügt.", icon: ShieldCheck });
    if (servicesEnabled) items.splice(items.length - 1, 0, { title: "Dienstleistungen", description: "Buchungen, Serviceanfragen, Mahlzeiten und weitere interne Angebote öffnen.", hint: "Eigene Vorgänge stehen gesammelt in einer übersichtlichen Liste.", icon: Wrench });
    return items;
  }, [authenticatorEnabled, servicesEnabled]);

  const currentTourItem = tourItems[tourIndex] ?? tourItems[0];
  const CurrentTourIcon = currentTourItem?.icon ?? Sparkles;
  const selectableCount = Object.values(selection).filter(Boolean).length;

  const finish = async () => {
    setMessage("");
    try {
      await onComplete();
    } catch (error) {
      setMessage(`Die Einführung konnte nicht abgeschlossen werden: ${error}`);
    }
  };

  const scanComputer = async () => {
    if (!("__TAURI_INTERNALS__" in window)) {
      setMessage("Die automatische Suche funktioniert nur in der installierten Windows-App.");
      return;
    }
    setScanning(true);
    setMessage("");
    setScanResult(null);
    setSelection(EMPTY_SELECTION);

    const outlookScan = async () => {
      let contacts: OutlookContactImportPreview | null = null;
      let calendars: OutlookCalendarPreview | null = null;
      const notices: string[] = [];
      try { contacts = await previewOutlookClassicContacts(true); }
      catch { notices.push("Outlook Classic: keine lokal lesbaren Kontakte gefunden."); }
      try { calendars = await previewOutlookClassicAppointments(); }
      catch { notices.push("Outlook Classic: keine lokal lesbaren Kalender gefunden."); }
      return { contacts, calendars, notices };
    };

    const m365Scan = async () => {
      const status = await getMicrosoft365ConnectionStatus();
      if (!status.connected) return { status, contacts: 0, calendars: 0 };
      const sources = await listMicrosoft365SyncSources();
      return { status, contacts: sources.contacts.length, calendars: sources.calendars.length };
    };

    const [outlookOutcome, thunderbirdOutcome, m365Outcome] = await Promise.allSettled([
      outlookScan(),
      previewThunderbirdData(),
      m365Scan()
    ]);

    const outlook = outlookOutcome.status === "fulfilled" ? outlookOutcome.value : { contacts: null, calendars: null, notices: ["Outlook Classic konnte nicht geprüft werden."] };
    const thunderbird = thunderbirdOutcome.status === "fulfilled" ? thunderbirdOutcome.value : null;
    const m365 = m365Outcome.status === "fulfilled" ? m365Outcome.value : null;
    const nextResult: ScanResult = {
      outlookContacts: outlook.contacts,
      outlookCalendars: outlook.calendars,
      thunderbird,
      microsoft365: m365?.status ?? null,
      microsoft365Contacts: m365?.contacts ?? 0,
      microsoft365Calendars: m365?.calendars ?? 0,
      notices: [...outlook.notices, ...(thunderbird?.warnings ?? [])]
    };
    setScanResult(nextResult);
    setSelection({
      outlookContacts: (nextResult.outlookContacts?.found ?? 0) > 0,
      outlookCalendars: (nextResult.outlookCalendars?.totalEvents ?? 0) > 0,
      thunderbirdContacts: ((thunderbird?.contacts ?? 0) + (thunderbird?.autocompleteContacts ?? 0)) > 0,
      thunderbirdCalendars: (thunderbird?.events ?? 0) > 0
    });
    setScanning(false);
  };

  const toggleSelection = (key: ImportSelectionKey, checked: boolean) => {
    setSelection((current) => ({ ...current, [key]: checked }));
  };

  const importSelectedData = async () => {
    if (!scanResult || selectableCount === 0) {
      setMessage("Bitte wählen Sie mindestens einen Datenbereich aus.");
      return;
    }
    setImporting(true);
    setMessage("");
    const summary: string[] = [];
    const errors: string[] = [];
    let calendarChanged = false;

    if (selection.outlookContacts && scanResult.outlookContacts) {
      try {
        const result = await importSelectedOutlookClassicContacts({
          selectedSourceIds: scanResult.outlookContacts.sources.map((source) => source.id),
          createSourceGroups: true,
          cleanImportedNames: true
        });
        summary.push(`${result.imported} Outlook-Kontakte übernommen`);
      } catch (error) { errors.push(`Outlook-Kontakte: ${error}`); }
    }

    if (selection.outlookCalendars) {
      try {
        const result = await importOutlookClassicAppointmentsOnce();
        const stored = readStoredCalendarEvents();
        const incoming = result.events.map((event) => ({ ...event, color: calendarColorFromCategory(event.category, event.color) }));
        const merged = mergeCalendarEventsExactly(stored, incoming);
        localStorage.setItem(calendarStorageKey, JSON.stringify(merged.events));
        mergeImportedCalendarCategories(incoming);
        summary.push(`${merged.imported} Outlook-Termine übernommen`);
        calendarChanged = merged.imported > 0;
      } catch (error) { errors.push(`Outlook-Kalender: ${error}`); }
    }

    if (selection.thunderbirdContacts) {
      try {
        const result = await importThunderbirdContactsOnce(true, true);
        summary.push(`${result.imported} Thunderbird-Kontakte übernommen`);
      } catch (error) { errors.push(`Thunderbird-Kontakte: ${error}`); }
    }

    if (selection.thunderbirdCalendars) {
      try {
        const result = await importThunderbirdCalendarsOnce();
        const byId = new Map(readStoredCalendarEvents().map((event) => [event.id, event]));
        let imported = 0;
        for (const event of result.events) {
          if (!byId.has(event.id)) imported += 1;
          byId.set(event.id, { ...event, color: calendarColorFromCategory(event.category, event.color) });
        }
        localStorage.setItem(calendarStorageKey, JSON.stringify(Array.from(byId.values())));
        mergeImportedCalendarCategories(result.events);
        summary.push(`${imported} Thunderbird-Termine übernommen`);
        calendarChanged = calendarChanged || imported > 0;
      } catch (error) { errors.push(`Thunderbird-Kalender: ${error}`); }
    }

    if (calendarChanged) window.dispatchEvent(new Event(calendarChangedEventName));
    setImportSummary(summary);
    setImporting(false);
    if (errors.length > 0) setMessage(errors.join(" · "));
    setStage("finished");
  };

  return (
    <div className="onboarding-backdrop" role="presentation">
      <section className="onboarding-dialog" role="dialog" aria-modal="true" aria-labelledby="onboarding-title">
        <header className="onboarding-header">
          <span className="onboarding-logo"><img src="/dmh-kontakte-kalender.png" alt="" /></span>
          <div><strong>DMH Portal - Privat</strong><small>Einfach anfangen</small></div>
          <div className="onboarding-progress" aria-label="Fortschritt">
            {["welcome", "tour", "import", "finished"].map((item, index) => <span className={stage === item ? "active" : ""} key={item}>{index + 1}</span>)}
          </div>
        </header>

        {stage === "welcome" && (
          <div className="onboarding-welcome">
            <span className="onboarding-hero-icon"><Sparkles size={38} aria-hidden="true" /></span>
            <p className="onboarding-eyebrow">Herzlich willkommen</p>
            <h2 id="onboarding-title">Ihre wichtigsten Daten an einem Ort</h2>
            <p>Wir zeigen Ihnen kurz die App und helfen anschließend dabei, vorhandene Kontakte und Termine zu finden. Sie entscheiden immer selbst, was übernommen wird.</p>
            <div className="onboarding-benefits">
              <span><Check size={18} /> Kurze verständliche Einführung</span>
              <span><Check size={18} /> Automatische Suche auf diesem PC</span>
              <span><Check size={18} /> Nichts wird ohne Auswahl importiert</span>
            </div>
            {message && <p className="onboarding-message error" role="alert">{message}</p>}
            <div className="onboarding-footer centered">
              <button type="button" onClick={() => void finish()}>Später einrichten</button>
              <button className="primary" type="button" onClick={() => setStage("tour")}>Einführung starten <ArrowRight size={19} /></button>
            </div>
          </div>
        )}

        {stage === "tour" && currentTourItem && (
          <div className="onboarding-tour">
            <p className="onboarding-eyebrow">Die App kennenlernen · {tourIndex + 1} von {tourItems.length}</p>
            <div className="onboarding-tour-card">
              <span><CurrentTourIcon size={42} aria-hidden="true" /></span>
              <div><h2 id="onboarding-title">{currentTourItem.title}</h2><p>{currentTourItem.description}</p><small>{currentTourItem.hint}</small></div>
            </div>
            <div className="onboarding-tour-dots" aria-hidden="true">{tourItems.map((item, index) => <span className={index === tourIndex ? "active" : ""} key={item.title} />)}</div>
            <div className="onboarding-footer">
              <button type="button" disabled={tourIndex === 0} onClick={() => setTourIndex((current) => Math.max(0, current - 1))}><ArrowLeft size={18} /> Zurück</button>
              <button className="primary" type="button" onClick={() => {
                if (tourIndex < tourItems.length - 1) setTourIndex((current) => current + 1);
                else setStage("import");
              }}>{tourIndex < tourItems.length - 1 ? "Weiter" : "Daten übernehmen"} <ArrowRight size={18} /></button>
            </div>
          </div>
        )}

        {stage === "import" && (
          <div className="onboarding-import">
            <p className="onboarding-eyebrow">Vorhandene Daten übernehmen</p>
            <h2 id="onboarding-title">Was ist bereits auf diesem PC vorhanden?</h2>
            <p className="onboarding-lead">Ein Klick genügt. Die App prüft Outlook Classic, Thunderbird und eine bereits verbundene Microsoft-365-Anmeldung.</p>

            {!scanResult && (
              <div className="onboarding-scan-start">
                <span><FolderSearch size={36} aria-hidden="true" /></span>
                <div><strong>Kontakte und Kalender suchen</strong><small>Es wird noch nichts importiert oder verändert.</small></div>
                <button className="primary large" type="button" disabled={scanning} onClick={() => void scanComputer()}>
                  {scanning ? <LoaderCircle className="spin" size={21} /> : <FolderSearch size={21} />}
                  {scanning ? "Daten werden gesucht …" : "Jetzt automatisch suchen"}
                </button>
              </div>
            )}

            {scanResult && (
              <>
                <div className="onboarding-found-heading"><strong>Gefundene Daten</strong><span>Bitte gewünschte Bereiche auswählen</span></div>
                <div className="onboarding-import-grid">
                  <ImportChoiceCard icon={ContactRound} label="Outlook-Kontakte" description="Kontaktordner und Autovervollständigung" count={scanResult.outlookContacts?.found ?? 0} meta={`${scanResult.outlookContacts?.sources.length ?? 0} Quelle(n)`} checked={selection.outlookContacts} disabled={(scanResult.outlookContacts?.found ?? 0) === 0} onChange={(checked) => toggleSelection("outlookContacts", checked)} />
                  <ImportChoiceCard icon={CalendarDays} label="Outlook-Kalender" description="Kalender aus Outlook Classic" count={scanResult.outlookCalendars?.totalEvents ?? 0} meta={`${scanResult.outlookCalendars?.calendars.length ?? 0} Kalender`} checked={selection.outlookCalendars} disabled={(scanResult.outlookCalendars?.totalEvents ?? 0) === 0} onChange={(checked) => toggleSelection("outlookCalendars", checked)} />
                  <ImportChoiceCard icon={ContactRound} label="Thunderbird-Kontakte" description="Adressbücher und frühere Empfänger" count={(scanResult.thunderbird?.contacts ?? 0) + (scanResult.thunderbird?.autocompleteContacts ?? 0)} meta={`${scanResult.thunderbird?.addressBooks ?? 0} Adressbuch/Adressbücher`} checked={selection.thunderbirdContacts} disabled={((scanResult.thunderbird?.contacts ?? 0) + (scanResult.thunderbird?.autocompleteContacts ?? 0)) === 0} onChange={(checked) => toggleSelection("thunderbirdContacts", checked)} />
                  <ImportChoiceCard icon={CalendarDays} label="Thunderbird-Kalender" description="Termine, Serien, Kategorien und Farben" count={scanResult.thunderbird?.events ?? 0} meta={`${scanResult.thunderbird?.calendars ?? 0} Kalender`} checked={selection.thunderbirdCalendars} disabled={(scanResult.thunderbird?.events ?? 0) === 0} onChange={(checked) => toggleSelection("thunderbirdCalendars", checked)} />
                </div>
                <article className="onboarding-m365-card">
                  <span><MonitorSmartphone size={24} /></span>
                  <div><strong>Microsoft 365 · Neues Outlook · Teams</strong><small>{scanResult.microsoft365?.connected ? `${scanResult.microsoft365.account?.email ?? "Konto verbunden"} · ${scanResult.microsoft365Contacts} Kontaktquellen · ${scanResult.microsoft365Calendars} Kalender` : "Erfordert eine einmalige Anmeldung und wird später unter Synchronisierungen eingerichtet."}</small></div>
                  <em>{scanResult.microsoft365?.connected ? "Verbunden" : "Nicht verbunden"}</em>
                </article>
                {scanResult.notices.length > 0 && <details className="onboarding-scan-notices"><summary>Nicht gefundene Quellen</summary><ul>{scanResult.notices.map((notice) => <li key={notice}>{notice}</li>)}</ul></details>}
              </>
            )}

            {message && <p className="onboarding-message error" role="alert">{message}</p>}
            <div className="onboarding-footer">
              <button type="button" onClick={() => setStage("tour")}><ArrowLeft size={18} /> Zurück</button>
              {scanResult ? <button className="primary" type="button" disabled={importing || selectableCount === 0} onClick={() => void importSelectedData()}>{importing ? <LoaderCircle className="spin" size={19} /> : <CheckCircle2 size={19} />}{importing ? "Wird importiert …" : `${selectableCount} Bereich(e) importieren`}</button> : <button type="button" onClick={() => void finish()}>Ohne Import fortfahren</button>}
            </div>
          </div>
        )}

        {stage === "finished" && (
          <div className="onboarding-finished">
            <span className="onboarding-success-icon"><CheckCircle2 size={42} aria-hidden="true" /></span>
            <p className="onboarding-eyebrow">Einrichtung abgeschlossen</p>
            <h2 id="onboarding-title">Alles bereit</h2>
            {importSummary.length > 0 ? <ul>{importSummary.map((item) => <li key={item}><Check size={18} /> {item}</li>)}</ul> : <p>Es wurden keine neuen lokalen Daten ausgewählt.</p>}
            {message && <p className="onboarding-message error" role="alert">{message}</p>}
            <p className="onboarding-cloud-note"><MonitorSmartphone size={20} /> Microsoft 365 und die spätere persönliche Cloud-Synchronisierung können unter Einstellungen → Synchronisierungen eingerichtet werden.</p>
            <div className="onboarding-footer centered"><button className="primary large" type="button" onClick={() => void finish()}>App jetzt verwenden <ArrowRight size={19} /></button></div>
          </div>
        )}
      </section>
    </div>
  );
}

function readStoredCalendarEvents() {
  const value: unknown = JSON.parse(localStorage.getItem(calendarStorageKey) ?? "[]");
  if (!Array.isArray(value)) return [];
  return value as import("../types/calendar").CalendarEvent[];
}
