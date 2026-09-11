import { save } from "@tauri-apps/plugin-dialog";
import { AtSign, CalendarClock, CalendarDays, CheckCircle2, ContactRound, Download, FolderOpen, LoaderCircle, Send } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { StatusMessage } from "../components/StatusMessage";
import { t } from "../i18n";
import { listCalendarEvents, listContacts, listGroups, listMailAccounts, pushProjectAppointmentsToOutlook, pushProjectContactsToOutlook, writeExportFile } from "../services/db";
import type { OutlookCalendarExportResult } from "../types/calendar";
import type { Contact, Group, OutlookContactExportResult } from "../types/contact";
import type { MailAccount } from "../types/mail";
import { exportCalendarIcs } from "../utils/calendar";
import { exportGeneralCsv, exportNewOutlookCsv, exportOutlookClassicCsv } from "../utils/exporters";

type ContactExportKind = "classic" | "new" | "general";
type ContactExportStep = "account" | "folders" | "autocomplete" | "format" | "groups" | "confirm";
type OutlookFolderScope = "all" | "selected";
type CalendarExportTarget = "apple" | "google" | "teams" | "universal";
type ExportChoice = "outlook" | "outlook-calendar" | "calendar" | "contacts";

const exportChoiceLabels: Record<ExportChoice, string> = {
  outlook: "Kontakte an Outlook übertragen",
  "outlook-calendar": "Termine an Outlook übertragen",
  calendar: "Kalender exportieren",
  contacts: "Kontaktlisten exportieren"
};
const calendarTargetNames: Record<CalendarExportTarget, string> = {
  apple: "Apple Kalender",
  google: "Google Kalender",
  teams: "Microsoft Teams / Outlook",
  universal: "Universelle ICS-Datei"
};

interface ExportPageProps {
  embedded?: boolean;
}

export function ExportPage({ embedded = false }: ExportPageProps) {
  const [message, setMessage] = useState("");
  const [groups, setGroups] = useState<Group[]>([]);
  const [selectedGroupIds, setSelectedGroupIds] = useState<number[]>([]);
  const [choice, setChoice] = useState<ExportChoice | null>(null);
  const [contactExportStep, setContactExportStep] = useState<ContactExportStep>("format");
  const [contactExportKind, setContactExportKind] = useState<ContactExportKind>("classic");
  const [outlookFolderScope, setOutlookFolderScope] = useState<OutlookFolderScope>("all");
  const [selectedOutlookGroupIds, setSelectedOutlookGroupIds] = useState<number[]>([]);
  const [includeUngroupedOutlook, setIncludeUngroupedOutlook] = useState(true);
  const [seedOutlookAutocomplete, setSeedOutlookAutocomplete] = useState(true);
  const [calendarExportTarget, setCalendarExportTarget] = useState<CalendarExportTarget>("universal");
  const [mailAccounts, setMailAccounts] = useState<MailAccount[]>([]);
  const [selectedMailAccountId, setSelectedMailAccountId] = useState<number | null>(null);
  const [directOutlookBusy, setDirectOutlookBusy] = useState(false);
  const [directOutlookResult, setDirectOutlookResult] = useState<OutlookContactExportResult | null>(null);
  const [directOutlookCalendarBusy, setDirectOutlookCalendarBusy] = useState(false);
  const [directOutlookCalendarResult, setDirectOutlookCalendarResult] = useState<OutlookCalendarExportResult | null>(null);

  useEffect(() => {
    if (!("__TAURI_INTERNALS__" in window)) return;
    listGroups().then(setGroups).catch((error) => setMessage(`Gruppen konnten nicht geladen werden: ${error}`));
    listMailAccounts()
      .then((accounts) => {
        setMailAccounts(accounts);
        setSelectedMailAccountId((current) => current ?? accounts[0]?.id ?? null);
      })
      .catch((error) => setMessage(`Outlook-Konten konnten nicht geladen werden: ${error}`));
  }, []);

  const selectedMailAccount = mailAccounts.find((account) => account.id === selectedMailAccountId) ?? null;

  const selectedGroups = useMemo(
    () => groups.filter((group) => group.id && selectedGroupIds.includes(group.id)),
    [groups, selectedGroupIds]
  );
  const selectedOutlookGroups = useMemo(
    () => groups.filter((group) => group.id && selectedOutlookGroupIds.includes(group.id)),
    [groups, selectedOutlookGroupIds]
  );

  const exportScopeText = selectedGroups.length
    ? `Exportiert werden nur Kontakte aus: ${selectedGroups.map((group) => group.name).join(", ")}.`
    : "Ohne Gruppenauswahl werden alle Kontakte exportiert.";
  const outlookScopeText = outlookFolderScope === "all"
    ? "Alle Kontaktordner und Kontakte ohne Gruppe werden übertragen."
    : [
        ...selectedOutlookGroups.map((group) => group.name),
        ...(includeUngroupedOutlook ? ["Gesammelte Adressen"] : [])
      ].length > 0
      ? `Nur diese Ordner werden übertragen: ${[
          ...selectedOutlookGroups.map((group) => group.name),
          ...(includeUngroupedOutlook ? ["Gesammelte Adressen"] : [])
        ].join(", ")}.`
      : "Noch kein Ordner ausgewählt.";
  const contactStepNumber = choice === "outlook"
    ? contactExportStep === "account" ? "1" : contactExportStep === "folders" ? "2" : contactExportStep === "autocomplete" ? "3" : "4"
    : contactExportStep === "format" ? "1" : contactExportStep === "groups" ? "2" : "3";
  const directFolderSelectionValid = outlookFolderScope === "all" || selectedOutlookGroupIds.length > 0 || includeUngroupedOutlook;

  const toggleGroup = (groupId: number) => {
    setSelectedGroupIds((current) => current.includes(groupId) ? current.filter((id) => id !== groupId) : [...current, groupId]);
  };

  const toggleOutlookGroup = (groupId: number) => {
    setSelectedOutlookGroupIds((current) => current.includes(groupId) ? current.filter((id) => id !== groupId) : [...current, groupId]);
  };

  const startContactExport = (target: "outlook" | "contacts") => {
    setChoice(target);
    setContactExportStep(target === "outlook" ? "account" : "format");
    setMessage("");
  };

  const previousContactStep = () => {
    if (choice === "outlook") {
      if (contactExportStep === "confirm") setContactExportStep("autocomplete");
      else if (contactExportStep === "autocomplete") setContactExportStep("folders");
      else if (contactExportStep === "folders") setContactExportStep("account");
      return;
    }
    if (contactExportStep === "confirm") setContactExportStep("groups");
    else if (contactExportStep === "groups") setContactExportStep("format");
  };

  const nextContactStep = () => {
    if (choice === "outlook") {
      if (contactExportStep === "account") setContactExportStep("folders");
      else if (contactExportStep === "folders" && directFolderSelectionValid) setContactExportStep("autocomplete");
      else if (contactExportStep === "autocomplete") setContactExportStep("confirm");
      return;
    }
    if (choice === "contacts" && contactExportStep === "format") setContactExportStep("groups");
    else if (choice === "contacts" && contactExportStep === "groups") setContactExportStep("confirm");
  };

  const filterContactsByGroups = (contacts: Contact[]) => {
    if (!selectedGroupIds.length) return contacts;
    const selected = new Set(selectedGroupIds);
    const byId = new Map<number | string, Contact>();
    contacts
      .filter((contact) => contact.groups.some((group) => group.id && selected.has(group.id)))
      .forEach((contact, index) => byId.set(contact.id ?? `contact-${index}`, contact));
    return Array.from(byId.values());
  };

  const loadCalendarEvents = async () => {
    const stored = await listCalendarEvents();
    return stored.sort((left, right) => left.startsAt.localeCompare(right.startsAt));
  };

  const runContactExport = async (kind: ContactExportKind) => {
    try {
      const path = await save({
        defaultPath: `DMH-Kontakte-${kind}.csv`,
        filters: [{ name: "CSV", extensions: ["csv"] }]
      });
      if (!path) return;

      const contacts = filterContactsByGroups(await listContacts());
      const csv = kind === "classic" ? exportOutlookClassicCsv(contacts) : kind === "new" ? exportNewOutlookCsv(contacts) : exportGeneralCsv(contacts);
      await writeExportFile(path, csv);
      setMessage(
        `${selectedGroupIds.length ? `${contacts.length} Kontakte aus ausgewählten Gruppen exportiert.` : `${contacts.length} Kontakte exportiert.`} ${
          kind === "general"
            ? "CSV-Datei wurde erstellt."
            : "Öffnen Sie Outlook, gehen Sie zu Personen/Kontakte und wählen Sie Importieren."
        }`
      );
    } catch (error) {
      setMessage(`Export fehlgeschlagen: ${error}`);
    }
  };

  const runCalendarExport = async (target: CalendarExportTarget) => {
    try {
      const events = await loadCalendarEvents();
      if (!events.length) {
        setMessage("Es gibt keine Kalendertermine zum Exportieren.");
        return;
      }
      const path = await save({
        defaultPath: `DMH-Kalender-${target}.ics`,
        filters: [{ name: "ICS", extensions: ["ics"] }]
      });
      if (!path) return;
      await writeExportFile(path, exportCalendarIcs(events));
      const nextStep = target === "apple"
        ? "Importieren Sie die Datei in Apple Kalender. Dies ist eine einmalige Übertragung."
        : target === "google"
          ? "Importieren Sie die Datei am Computer unter Google Kalender → Einstellungen → Importieren & Exportieren."
          : target === "teams"
            ? "Importieren Sie die Datei in den Outlook-Kalender desselben Microsoft-365-Kontos; die Termine erscheinen danach auch im Teams-Kalender."
            : "Die ICS-Datei kann in gängigen Kalenderprogrammen importiert werden.";
      setMessage(`${events.length} Termine und Terminserien für ${calendarTargetNames[target]} exportiert. ${nextStep}`);
    } catch (error) {
      setMessage(`Kalenderexport fehlgeschlagen: ${error}`);
    }
  };

  const runDirectOutlookExport = async () => {
    if (!("__TAURI_INTERNALS__" in window)) {
      setMessage("Die direkte Outlook-Übertragung ist nur in der installierten Windows-App verfügbar.");
      return;
    }
    setDirectOutlookBusy(true);
    setDirectOutlookResult(null);
    setMessage("");
    try {
      const result = await pushProjectContactsToOutlook({
        targetEmail: selectedMailAccount?.email,
        selectedGroupIds: outlookFolderScope === "selected" ? selectedOutlookGroupIds : undefined,
        includeUngrouped: outlookFolderScope === "all" || includeUngroupedOutlook,
        seedAutocomplete: seedOutlookAutocomplete
      });
      setDirectOutlookResult(result);
      if (result.total === 0) {
        setMessage("Es sind keine Kontakte zum Übertragen vorhanden.");
      } else if (result.errors > 0 || result.autocompleteErrors > 0) {
        setMessage(`${result.linked} von ${result.total} Kontakten wurden an Outlook übertragen. ${result.errors + result.autocompleteErrors} Einträge konnten nicht vollständig verarbeitet werden.`);
      } else {
        setMessage(seedOutlookAutocomplete
          ? `${result.total} Kontakte wurden in ${result.foldersUsed} Outlook-Ordner übertragen; ${result.autocompleteResolved} Adressen wurden für die Empfängersuche vorbereitet.`
          : `${result.total} Kontakte wurden in ${result.foldersUsed} Outlook-Ordner übertragen.`);
      }
    } catch (error) {
      setMessage(`Direkte Outlook-Übertragung fehlgeschlagen: ${error}`);
    } finally {
      setDirectOutlookBusy(false);
    }
  };

  const runDirectOutlookCalendarExport = async () => {
    if (!("__TAURI_INTERNALS__" in window)) {
      setMessage("Die direkte Outlook-Übertragung ist nur in der installierten Windows-App verfügbar.");
      return;
    }
    const events = await loadCalendarEvents();
    if (!events.length) {
      setMessage("Es gibt keine Termine zum Übertragen.");
      return;
    }
    setDirectOutlookCalendarBusy(true);
    setDirectOutlookCalendarResult(null);
    setMessage("");
    try {
      const result = await pushProjectAppointmentsToOutlook(events, selectedMailAccount?.email);
      setDirectOutlookCalendarResult(result);
      if (result.errors > 0) {
        setMessage(`${result.created + result.updated} von ${result.total} Terminen wurden an Outlook übertragen. ${result.errors} konnten nicht vollständig verarbeitet werden.`);
      } else {
        setMessage(`${result.total} Termine wurden an Outlook Classic übertragen.`);
      }
    } catch (error) {
      setMessage(`Outlook-Kalenderübertragung fehlgeschlagen: ${error}`);
    } finally {
      setDirectOutlookCalendarBusy(false);
    }
  };

  const confirmExport = () => {
    if (!choice) return;
    if (choice === "outlook") void runDirectOutlookExport();
    if (choice === "outlook-calendar") void runDirectOutlookCalendarExport();
    if (choice === "calendar") void runCalendarExport(calendarExportTarget);
    if (choice === "contacts") void runContactExport(contactExportKind);
  };

  const resetChoice = () => {
    setChoice(null);
    setSelectedGroupIds([]);
    setContactExportKind("classic");
    setOutlookFolderScope("all");
    setSelectedOutlookGroupIds([]);
    setIncludeUngroupedOutlook(true);
    setSeedOutlookAutocomplete(true);
    setCalendarExportTarget("universal");
    setDirectOutlookResult(null);
    setDirectOutlookCalendarResult(null);
    setContactExportStep("format");
    setMessage("");
  };

  return (
    <div className="page export-page">
      {!embedded && (
        <header className="page-header">
          <div>
            <h2>{t.exportContacts}</h2>
            <p>Wählen Sie zuerst aus, was gespeichert werden soll.</p>
          </div>
        </header>
      )}
      <StatusMessage message={message} />

      {!choice && (
        <section className="export-choice-groups" aria-label="Exportart auswählen">
          <section className="export-choice-group" aria-labelledby="export-contacts-heading">
            <header>
              <span className="export-choice-group-icon"><ContactRound size={27} aria-hidden="true" /></span>
              <div><h3 id="export-contacts-heading">Kontakte exportieren</h3><p>Wohin sollen Ihre Kontakte?</p></div>
            </header>
            <div className="export-choice-grid">
              <button className="export-choice-card" type="button" onClick={() => startContactExport("outlook")}>
                <Send size={32} />
                <span>
                  <span className="export-target-badge outlook">OUTLOOK CLASSIC</span>
                  <strong>Kontakte direkt übertragen</strong>
                  <small>Kontaktordner und optionale Empfängervorschläge ohne CSV-Datei.</small>
                </span>
              </button>
              <button className="export-choice-card" type="button" onClick={() => startContactExport("contacts")}>
                <Download size={32} />
                <span>
                  <span className="export-target-badge file">CSV-DATEI</span>
                  <strong>Kontakte als Datei speichern</strong>
                  <small>CSV-Datei für Outlook oder ein Tabellenprogramm erstellen.</small>
                </span>
              </button>
            </div>
          </section>

          <section className="export-choice-group" aria-labelledby="export-calendar-heading">
            <header>
              <span className="export-choice-group-icon"><CalendarDays size={27} aria-hidden="true" /></span>
              <div><h3 id="export-calendar-heading">Kalender exportieren</h3><p>Wohin sollen Ihre Termine?</p></div>
            </header>
            <div className="export-choice-grid">
              <button className="export-choice-card" type="button" onClick={() => setChoice("outlook-calendar")}>
                <CalendarClock size={32} />
                <span>
                  <span className="export-target-badge outlook">DIREKT IN OUTLOOK</span>
                  <strong>Termine nach Outlook</strong>
                  <small>Keine Datei: Alle Termine und Serien werden sofort übertragen.</small>
                </span>
              </button>
              <button className="export-choice-card" type="button" onClick={() => setChoice("calendar")}>
                <Download size={32} />
                <span>
                  <span className="export-target-badge file">ICS-DATEI</span>
                  <strong>Kalender als Datei speichern</strong>
                  <small>ICS-Datei für Outlook, Teams, Google oder Apple erstellen.</small>
                </span>
              </button>
            </div>
          </section>
        </section>
      )}

      {choice && (choice === "outlook" || choice === "contacts") && (
        <section className="form-panel export-wizard-panel export-contact-wizard">
          <div className="panel-heading">
            <div>
              <h3>{exportChoiceLabels[choice]}</h3>
              <p className="export-step-text">Schritt {contactStepNumber} von {choice === "outlook" ? "4" : "3"}</p>
            </div>
            <button type="button" onClick={resetChoice}>Andere Exportart</button>
          </div>

          {choice === "outlook" && contactExportStep === "account" && <section className="export-single-step" aria-labelledby="contact-export-account-title">
            <span className="export-step-number">1</span>
            <h4 id="contact-export-account-title">Welches Outlook-Classic-Konto soll verwendet werden?</h4>
            <p>Die Kontakte werden über die installierte Outlook-Desktop-App übertragen. Es wird keine Datei erstellt.</p>
            {mailAccounts.length > 0 ? <label className="outlook-direct-account"><span>Outlook-Konto</span><select value={selectedMailAccountId ?? ""} onChange={(event) => setSelectedMailAccountId(Number(event.target.value))} disabled={directOutlookBusy}>{mailAccounts.map((account) => <option key={account.id} value={account.id}>{account.accountName || account.email} · {account.email}</option>)}</select></label> : <p className="outlook-direct-default-note"><ContactRound size={18} /> Das Standardkonto von Outlook wird verwendet.</p>}
          </section>}

          {choice === "outlook" && contactExportStep === "folders" && <section className="export-single-step" aria-labelledby="contact-export-folders-title">
            <span className="export-step-number">2</span>
            <h4 id="contact-export-folders-title">Welche Kontaktordner sollen übertragen werden?</h4>
            <p>Sie können alle Ordner oder nur bestimmte Gruppen an Outlook übergeben.</p>
            <div className="export-radio-list">
              <label className={outlookFolderScope === "all" ? "export-radio-option selected" : "export-radio-option"}>
                <input type="radio" name="outlook-folder-scope" checked={outlookFolderScope === "all"} onChange={() => setOutlookFolderScope("all")} />
                <span><strong>Alle Kontaktordner</strong><small>Alle Gruppen und Kontakte ohne Gruppe übertragen</small></span>
              </label>
              <label className={outlookFolderScope === "selected" ? "export-radio-option selected" : "export-radio-option"}>
                <input type="radio" name="outlook-folder-scope" checked={outlookFolderScope === "selected"} onChange={() => setOutlookFolderScope("selected")} />
                <span><strong>Nur ausgewählte Ordner</strong><small>Nur Kontakte aus den unten gewählten Gruppen übertragen</small></span>
              </label>
            </div>
            {outlookFolderScope === "selected" && <div className="export-group-picker outlook-folder-picker">
              <label className="checkbox-row"><input type="checkbox" checked={includeUngroupedOutlook} onChange={(event) => setIncludeUngroupedOutlook(event.target.checked)} /><span>Gesammelte Adressen <small>Kontakte ohne Gruppe</small></span></label>
              {groups.map((group) => group.id ? <label className="checkbox-row" key={group.id}><input type="checkbox" checked={selectedOutlookGroupIds.includes(group.id)} onChange={() => toggleOutlookGroup(group.id!)} /><span>{group.name}</span></label> : null)}
              {!directFolderSelectionValid && <span className="export-selection-warning">Bitte mindestens einen Ordner auswählen.</span>}
            </div>}
          </section>}

          {choice === "outlook" && contactExportStep === "autocomplete" && <section className="export-single-step" aria-labelledby="contact-export-autocomplete-title">
            <span className="export-step-number">3</span>
            <h4 id="contact-export-autocomplete-title">Soll Outlook die Kontakte beim Tippen vorschlagen?</h4>
            <p>Die ausgewählten Kontaktordner werden im Outlook-Classic-Adressbuch aktiviert. Zusätzlich bereitet Outlook jede E-Mail-Adresse für die Empfängersuche vor.</p>
            <div className="export-radio-list">
              <label className={seedOutlookAutocomplete ? "export-radio-option selected" : "export-radio-option"}>
                <input type="radio" name="outlook-autocomplete" checked={seedOutlookAutocomplete} onChange={() => setSeedOutlookAutocomplete(true)} />
                <span><strong>Ja, Vorschläge aktivieren</strong><small>Empfohlen: Namen und E-Mail-Adressen beim Schreiben schneller finden</small></span>
              </label>
              <label className={!seedOutlookAutocomplete ? "export-radio-option selected" : "export-radio-option"}>
                <input type="radio" name="outlook-autocomplete" checked={!seedOutlookAutocomplete} onChange={() => setSeedOutlookAutocomplete(false)} />
                <span><strong>Nein, nur Kontaktordner</strong><small>Keine Änderung an der Outlook-Autovervollständigung</small></span>
              </label>
            </div>
            {seedOutlookAutocomplete && <p className="outlook-autocomplete-note"><AtSign size={18} /> Outlook speichert neue Vorschläge endgültig, wenn es anschließend einmal normal geschlossen wird.</p>}
          </section>}

          {choice === "outlook" && contactExportStep === "confirm" && <section className="export-single-step" aria-labelledby="contact-export-direct-confirm-title">
            <span className="export-step-number">4</span>
            <h4 id="contact-export-direct-confirm-title">Bereit für die Übertragung?</h4>
            <p>Kontrollieren Sie Konto, Ordner und Empfängersuche, bevor Outlook aktualisiert wird.</p>
            {selectedMailAccount && <div className="export-summary-card"><ContactRound size={24} /><span><strong>{selectedMailAccount.accountName || selectedMailAccount.email}</strong><small>{selectedMailAccount.email}</small></span></div>}
            <div className="export-summary-card"><FolderOpen size={24} /><span><strong>{outlookFolderScope === "all" ? "Alle Kontaktordner" : "Ausgewählte Kontaktordner"}</strong><small>{outlookScopeText}</small></span></div>
            <div className="export-summary-card"><AtSign size={24} /><span><strong>{seedOutlookAutocomplete ? "Outlook-Vorschläge werden vorbereitet" : "Nur Kontaktordner"}</strong><small>{seedOutlookAutocomplete ? "Outlook nach der Übertragung einmal normal schließen." : "Die Autovervollständigung bleibt unverändert."}</small></span></div>
            {directOutlookResult && <div className="outlook-direct-result" role="status"><CheckCircle2 size={24} aria-hidden="true" /><div><strong>{directOutlookResult.linked} Kontakte · {directOutlookResult.foldersUsed} Gruppenordner</strong><span>{directOutlookResult.contactCopies} Einträge · {directOutlookResult.created} neu · {directOutlookResult.updated} aktualisiert{seedOutlookAutocomplete ? ` · ${directOutlookResult.autocompleteResolved} Vorschläge` : ""}</span>{directOutlookResult.folderPath && <small>Ziel: {directOutlookResult.folderPath}</small>}</div></div>}
          </section>}

          {choice === "contacts" && contactExportStep === "format" && <section className="export-single-step" aria-labelledby="contact-export-format-title">
            <span className="export-step-number">1</span>
            <h4 id="contact-export-format-title">Welches Dateiformat brauchen Sie?</h4>
            <p>Wählen Sie das Programm, in dem die Datei anschließend importiert werden soll.</p>
            <div className="export-radio-list">
              <label className={contactExportKind === "classic" ? "export-radio-option selected" : "export-radio-option"}><input type="radio" name="contact-export-kind" checked={contactExportKind === "classic"} onChange={() => setContactExportKind("classic")} /><span><strong>{t.outlookClassic}</strong><small>Für die klassische Desktop-Version</small></span></label>
              <label className={contactExportKind === "new" ? "export-radio-option selected" : "export-radio-option"}><input type="radio" name="contact-export-kind" checked={contactExportKind === "new"} onChange={() => setContactExportKind("new")} /><span><strong>{t.newOutlook}</strong><small>Für das neue Outlook für Windows</small></span></label>
              <label className={contactExportKind === "general" ? "export-radio-option selected" : "export-radio-option"}><input type="radio" name="contact-export-kind" checked={contactExportKind === "general"} onChange={() => setContactExportKind("general")} /><span><strong>Allgemeine CSV</strong><small>Für Excel, Tabellenprogramme oder andere Systeme</small></span></label>
            </div>
          </section>}

          {choice === "contacts" && contactExportStep === "groups" && <section className="export-single-step" aria-labelledby="contact-export-groups-title">
            <span className="export-step-number">2</span>
            <h4 id="contact-export-groups-title">Welche Kontakte sollen exportiert werden?</h4>
            <p>{exportScopeText}</p>
            <div className="export-group-picker">{groups.map((group) => group.id ? <label className="checkbox-row" key={group.id}><input type="checkbox" checked={selectedGroupIds.includes(group.id)} onChange={() => toggleGroup(group.id!)} /><span>{group.name}</span></label> : null)}{groups.length === 0 && <span className="empty-inline">Keine Gruppen angelegt. Es werden alle Kontakte exportiert.</span>}</div>
          </section>}

          {choice === "contacts" && contactExportStep === "confirm" && <section className="export-single-step" aria-labelledby="contact-export-file-confirm-title">
            <span className="export-step-number">3</span>
            <h4 id="contact-export-file-confirm-title">Datei ist bereit zum Speichern</h4>
            <p>Prüfen Sie die Auswahl. Danach wählen Sie nur noch den Speicherort.</p>
            <div className="export-summary-card"><Download size={24} /><span><strong>{contactExportKind === "classic" ? t.outlookClassic : contactExportKind === "new" ? t.newOutlook : "Allgemeine CSV"}</strong><small>{exportScopeText}</small></span></div>
          </section>}

          <div className="export-single-step-actions">
            <button type="button" onClick={previousContactStep} disabled={contactExportStep === "account" || contactExportStep === "format"}>Zurück</button>
            {contactExportStep !== "confirm" ? <button className="primary" type="button" onClick={nextContactStep} disabled={choice === "outlook" && contactExportStep === "folders" && !directFolderSelectionValid}>Weiter</button> : <button className="primary" type="button" onClick={confirmExport} disabled={directOutlookBusy}>{choice === "outlook" ? (directOutlookBusy ? "Kontakte werden übertragen …" : "Jetzt an Outlook übertragen") : "Datei speichern"}</button>}
          </div>
        </section>
      )}

      {choice && (choice === "outlook-calendar" || choice === "calendar") && (
        <section className="form-panel export-wizard-panel">
          <div className="panel-heading"><div><h3>{exportChoiceLabels[choice]}</h3><p className="export-step-text">{choice === "outlook-calendar" ? "1. Konto wählen · 2. Übertragen" : "1. Kalender prüfen · 2. Datei speichern"}</p></div><button type="button" onClick={resetChoice}>Andere Exportart</button></div>
          <div className="export-wizard-grid"><section className="export-step-box">
            <span className="export-step-number">1</span>
            {choice === "outlook-calendar" ? <><h4>Outlook-Konto wählen</h4><p>Alle Termine und Serien werden in den lokalen Kalender dieses IMAP-Kontos übertragen.</p>{mailAccounts.length > 0 ? <label className="outlook-direct-account"><span>Outlook-IMAP-Konto</span><select value={selectedMailAccountId ?? ""} onChange={(event) => setSelectedMailAccountId(Number(event.target.value))} disabled={directOutlookCalendarBusy}>{mailAccounts.map((account) => <option key={account.id} value={account.id}>{account.accountName || account.email} · {account.email}</option>)}</select></label> : <p className="outlook-direct-default-note"><ContactRound size={18} /> Das Standardkonto von Outlook wird verwendet.</p>}{directOutlookCalendarResult && directOutlookCalendarResult.total > 0 && <div className="outlook-direct-result" role="status"><CheckCircle2 size={24} aria-hidden="true" /><div><strong>{directOutlookCalendarResult.created + directOutlookCalendarResult.updated} Termine in {directOutlookCalendarResult.storeName || "Outlook"}</strong><span>{directOutlookCalendarResult.created} neu · {directOutlookCalendarResult.updated} aktualisiert</span>{directOutlookCalendarResult.folderPath && <small>Ziel: {directOutlookCalendarResult.folderPath}</small>}</div></div>}</> : <><h4>Zielkalender wählen</h4><p>Termine und vollständige Serien werden als ICS-Datei gespeichert.</p><div className="export-radio-list">{([["universal", "Universelle ICS-Datei", "Für beliebige Kalenderprogramme"], ["apple", "Apple Kalender", "Einmaliger Import auf Mac oder in iCloud"], ["google", "Google Kalender", "Einmaliger Import über die Google-Kalender-Webseite"], ["teams", "Microsoft Teams / Outlook", "Import in Outlook; danach im Teams-Kalender sichtbar"]] as Array<[CalendarExportTarget, string, string]>).map(([target, label, description]) => <label className={calendarExportTarget === target ? "export-radio-option selected" : "export-radio-option"} key={target}><input type="radio" name="calendar-export-target" checked={calendarExportTarget === target} onChange={() => setCalendarExportTarget(target)} /><span><strong>{label}</strong><small>{description}</small></span></label>)}</div></>}
          </section></div>
        </section>
      )}

      {choice && (choice === "outlook-calendar" || choice === "calendar") && (
        <section className="export-confirm-panel">
          <button className="primary large" type="button" onClick={confirmExport} disabled={directOutlookBusy || directOutlookCalendarBusy}>
            {choice === "outlook-calendar" ? (
              <>{directOutlookCalendarBusy ? <LoaderCircle className="spin" size={22} /> : <CalendarClock size={22} />}{directOutlookCalendarBusy ? "Termine werden übertragen …" : "Jetzt an Outlook übertragen"}</>
            ) : (
              <><Download size={22} /> Datei speichern</>
            )}
          </button>
          <button className="large" type="button" onClick={resetChoice} disabled={directOutlookBusy || directOutlookCalendarBusy}>Abbrechen</button>
        </section>
      )}
    </div>
  );
}
