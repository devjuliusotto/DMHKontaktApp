import { save } from "@tauri-apps/plugin-dialog";
import { CalendarDays, CheckCircle2, ContactRound, Download, LoaderCircle, Send, UsersRound } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { StatusMessage } from "../components/StatusMessage";
import { t } from "../i18n";
import { listContacts, listGroups, listMailAccounts, pushProjectContactsToOutlook, writeExportFile } from "../services/db";
import type { CalendarEvent } from "../types/calendar";
import type { Contact, Group, OutlookContactExportResult } from "../types/contact";
import type { MailAccount } from "../types/mail";
import { calendarStorageKey, exportCalendarIcs } from "../utils/calendar";
import { exportGeneralCsv, exportNewOutlookCsv, exportOutlookClassicCsv } from "../utils/exporters";

type ContactExportKind = "classic" | "new" | "general";
type CalendarExportTarget = "apple" | "google" | "teams" | "universal";
type ExportChoice = "outlook" | "calendar" | "contacts";

const exportChoiceLabels: Record<ExportChoice, string> = {
  outlook: "Kontakte an Outlook übertragen",
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
  const [contactExportKind, setContactExportKind] = useState<ContactExportKind>("classic");
  const [calendarExportTarget, setCalendarExportTarget] = useState<CalendarExportTarget>("universal");
  const [mailAccounts, setMailAccounts] = useState<MailAccount[]>([]);
  const [selectedMailAccountId, setSelectedMailAccountId] = useState<number | null>(null);
  const [directOutlookBusy, setDirectOutlookBusy] = useState(false);
  const [directOutlookResult, setDirectOutlookResult] = useState<OutlookContactExportResult | null>(null);

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

  const exportScopeText = selectedGroups.length
    ? `Exportiert werden nur Kontakte aus: ${selectedGroups.map((group) => group.name).join(", ")}.`
    : "Ohne Gruppenauswahl werden alle Kontakte exportiert.";

  const toggleGroup = (groupId: number) => {
    setSelectedGroupIds((current) => current.includes(groupId) ? current.filter((id) => id !== groupId) : [...current, groupId]);
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

  const loadCalendarEvents = () => {
    const stored = JSON.parse(localStorage.getItem(calendarStorageKey) ?? "[]") as CalendarEvent[];
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
      const events = loadCalendarEvents();
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
      const result = await pushProjectContactsToOutlook(selectedMailAccount?.email);
      setDirectOutlookResult(result);
      if (result.total === 0) {
        setMessage("Es sind keine Kontakte zum Übertragen vorhanden.");
      } else if (result.errors > 0 || result.autocompleteErrors > 0) {
        setMessage(`${result.linked} von ${result.total} Kontakten wurden an Outlook übertragen. ${result.errors + result.autocompleteErrors} Einträge konnten nicht vollständig verarbeitet werden.`);
      } else {
        setMessage(`${result.total} Kontakte wurden in ${result.foldersUsed} Gruppenordner übertragen und für die Empfängersuche vorbereitet.`);
      }
    } catch (error) {
      setMessage(`Direkte Outlook-Übertragung fehlgeschlagen: ${error}`);
    } finally {
      setDirectOutlookBusy(false);
    }
  };

  const confirmExport = () => {
    if (!choice) return;
    if (choice === "outlook") void runDirectOutlookExport();
    if (choice === "calendar") void runCalendarExport(calendarExportTarget);
    if (choice === "contacts") void runContactExport(contactExportKind);
  };

  const resetChoice = () => {
    setChoice(null);
    setSelectedGroupIds([]);
    setContactExportKind("classic");
    setCalendarExportTarget("universal");
    setDirectOutlookResult(null);
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
          <section className="export-choice-grid" aria-label="Exportart auswählen">
            <button className="export-choice-card" type="button" onClick={() => setChoice("outlook")}>
              <Send size={34} />
              <span>
                <strong>Direkt an Outlook übertragen</strong>
                <small>Gruppen als Outlook-Ordner mit den zugehörigen Kontakten übernehmen</small>
              </span>
            </button>
            <button className="export-choice-card" type="button" onClick={() => setChoice("calendar")}>
              <CalendarDays size={34} />
              <span>
                <strong>Kalender exportieren</strong>
                <small>Alle Termine mit Uhrzeit, Ort, Beschreibung und Kategorie als ICS speichern</small>
              </span>
            </button>
            <button className="export-choice-card" type="button" onClick={() => setChoice("contacts")}>
              <UsersRound size={34} />
              <span>
                <strong>Kontaktlisten exportieren</strong>
                <small>Kontakte als CSV für Outlook oder Tabellenprogramme speichern</small>
              </span>
            </button>
          </section>
      )}

      {choice && (
        <section className="form-panel export-wizard-panel">
          <div className="panel-heading">
            <div>
              <h3>{exportChoiceLabels[choice]}</h3>
              <p className="export-step-text">
                {choice === "outlook" ? "1. Konto wählen · 2. Übertragen" : choice === "calendar" ? "1. Kalender prüfen · 2. Datei speichern" : "1. Format wählen · 2. Gruppen wählen · 3. Datei speichern"}
              </p>
            </div>
            <button type="button" onClick={resetChoice}>Andere Exportart</button>
          </div>

          <div className="export-wizard-grid">
            <section className="export-step-box">
              <span className="export-step-number">1</span>
              {choice === "outlook" ? (
                <>
                  <h4>Outlook-Konto wählen</h4>
                  <p>Jede Gruppe wird als eigener Kontaktordner übertragen.</p>
                  {mailAccounts.length > 0 ? (
                    <label className="outlook-direct-account">
                      <span>Outlook-Konto</span>
                      <select value={selectedMailAccountId ?? ""} onChange={(event) => setSelectedMailAccountId(Number(event.target.value))} disabled={directOutlookBusy}>
                        {mailAccounts.map((account) => <option key={account.id} value={account.id}>{account.accountName || account.email} · {account.email}</option>)}
                      </select>
                    </label>
                  ) : (
                    <p className="outlook-direct-default-note"><ContactRound size={18} /> Das Standardkonto von Outlook wird verwendet.</p>
                  )}
                  {directOutlookResult && directOutlookResult.total > 0 && (
                    <div className="outlook-direct-result" role="status">
                      <CheckCircle2 size={24} aria-hidden="true" />
                      <div>
                        <strong>{directOutlookResult.linked} Kontakte · {directOutlookResult.foldersUsed} Gruppenordner</strong>
                        <span>{directOutlookResult.contactCopies} Einträge · {directOutlookResult.created} neu · {directOutlookResult.updated} aktualisiert</span>
                        {directOutlookResult.folderPath && <small>Ziel: {directOutlookResult.folderPath}</small>}
                      </div>
                    </div>
                  )}
                </>
              ) : choice === "calendar" ? (
                <>
                  <h4>Zielkalender wählen</h4>
                  <p>Termine und vollständige Serien werden als ICS-Datei gespeichert. Die Darstellung von Kategorienfarben bestimmt anschließend der Zielkalender.</p>
                  <div className="export-radio-list">
                    {([
                      ["universal", "Universelle ICS-Datei", "Für beliebige Kalenderprogramme"],
                      ["apple", "Apple Kalender", "Einmaliger Import auf Mac oder in iCloud"],
                      ["google", "Google Kalender", "Einmaliger Import über die Google-Kalender-Webseite"],
                      ["teams", "Microsoft Teams / Outlook", "Import in Outlook; danach im Teams-Kalender sichtbar"]
                    ] as Array<[CalendarExportTarget, string, string]>).map(([target, label, description]) => (
                      <label className={calendarExportTarget === target ? "export-radio-option selected" : "export-radio-option"} key={target}>
                        <input type="radio" name="calendar-export-target" checked={calendarExportTarget === target} onChange={() => setCalendarExportTarget(target)} />
                        <span><strong>{label}</strong><small>{description}</small></span>
                      </label>
                    ))}
                  </div>
                </>
              ) : (
                <>
                  <h4>Format wählen</h4>
                  <p>Wählen Sie, wofür die Kontaktliste verwendet wird.</p>
                  <div className="export-radio-list">
                    <label className={contactExportKind === "classic" ? "export-radio-option selected" : "export-radio-option"}>
                      <input type="radio" name="contact-export-kind" checked={contactExportKind === "classic"} onChange={() => setContactExportKind("classic")} />
                      <span><strong>{t.outlookClassic}</strong><small>Für die klassische Desktop-Version</small></span>
                    </label>
                    <label className={contactExportKind === "new" ? "export-radio-option selected" : "export-radio-option"}>
                      <input type="radio" name="contact-export-kind" checked={contactExportKind === "new"} onChange={() => setContactExportKind("new")} />
                      <span><strong>{t.newOutlook}</strong><small>Für das neue Outlook für Windows</small></span>
                    </label>
                    <label className={contactExportKind === "general" ? "export-radio-option selected" : "export-radio-option"}>
                      <input type="radio" name="contact-export-kind" checked={contactExportKind === "general"} onChange={() => setContactExportKind("general")} />
                      <span><strong>Allgemeine CSV</strong><small>Für Excel, Tabellenprogramme oder andere Systeme</small></span>
                    </label>
                  </div>
                </>
              )}
            </section>

            {choice === "contacts" && (
              <section className="export-step-box">
                <span className="export-step-number">2</span>
                <h4>Gruppen wählen</h4>
                <p>{exportScopeText}</p>
                <div className="export-group-picker">
                  {groups.map((group) => {
                    if (!group.id) return null;
                    return (
                      <label className="checkbox-row" key={group.id}>
                        <input type="checkbox" checked={selectedGroupIds.includes(group.id)} onChange={() => toggleGroup(group.id!)} />
                        <span>{group.name}</span>
                      </label>
                    );
                  })}
                  {groups.length === 0 && <span className="empty-inline">Keine Gruppen angelegt.</span>}
                </div>
              </section>
            )}
          </div>
        </section>
      )}

      {choice && (
        <section className="export-confirm-panel">
          <button className="primary large" type="button" onClick={confirmExport} disabled={directOutlookBusy}>
            {choice === "outlook" ? (
              <>{directOutlookBusy ? <LoaderCircle className="spin" size={22} /> : <Send size={22} />}{directOutlookBusy ? "Kontakte werden übertragen …" : "Jetzt an Outlook übertragen"}</>
            ) : (
              <><Download size={22} /> Datei speichern</>
            )}
          </button>
          <button className="large" type="button" onClick={resetChoice} disabled={directOutlookBusy}>Abbrechen</button>
        </section>
      )}
    </div>
  );
}
