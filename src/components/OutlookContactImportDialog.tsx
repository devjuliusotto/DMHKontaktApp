import { open } from "@tauri-apps/plugin-dialog";
import { readFile } from "@tauri-apps/plugin-fs";
import {
  AlertTriangle,
  ArrowLeft,
  AtSign,
  Check,
  CheckCircle2,
  ChevronLeft,
  ChevronRight,
  FileSpreadsheet,
  FolderOpen,
  Laptop,
  LoaderCircle,
  Search,
  Timer,
  UsersRound,
  X
} from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import {
  importContacts,
  importSelectedOutlookClassicContacts,
  listContacts,
  listGroups,
  previewOutlookClassicContacts,
  saveGroup
} from "../services/db";
import type {
  Contact,
  ContactInput,
  OutlookContactImportPreview,
  OutlookContactImportResult,
  OutlookContactPreviewItem,
  OutlookContactPreviewStatus
} from "../types/contact";
import { contactExactContentKey } from "../utils/contactDuplicates";
import { cleanImportedContactName } from "../utils/contactImportCleanup";
import { parseCsvBytes } from "../utils/importers";

interface OutlookContactImportDialogProps {
  open: boolean;
  cleanImportedNames: boolean;
  onClose: () => void;
  onImported: (result: OutlookContactImportResult, source: "classic" | "csv") => void;
}

type ImportSource = "choose" | "classic" | "csv";
type ReviewFilter = "differences" | "all" | "new" | "duplicates" | "without-email";

const pageSize = 50;
const csvSourceId = "new-outlook-csv";
const csvGroupName = "Neues Outlook";

export function OutlookContactImportDialog({ open: isOpen, cleanImportedNames, onClose, onImported }: OutlookContactImportDialogProps) {
  const [source, setSource] = useState<ImportSource>("choose");
  const [preview, setPreview] = useState<OutlookContactImportPreview | null>(null);
  const [selectedSourceIds, setSelectedSourceIds] = useState<Set<string>>(new Set());
  const [createSourceGroups, setCreateSourceGroups] = useState(true);
  const [reviewFilter, setReviewFilter] = useState<ReviewFilter>("all");
  const [search, setSearch] = useState("");
  const [page, setPage] = useState(1);
  const [busy, setBusy] = useState<"scan" | "import" | null>(null);
  const [busyElapsedSeconds, setBusyElapsedSeconds] = useState(0);
  const [error, setError] = useState("");
  const [result, setResult] = useState<OutlookContactImportResult | null>(null);
  const [csvFileName, setCsvFileName] = useState("");
  const csvContacts = useRef(new Map<string, ContactInput>());

  const reset = () => {
    setSource("choose");
    setPreview(null);
    setSelectedSourceIds(new Set());
    setCreateSourceGroups(true);
    setReviewFilter("all");
    setSearch("");
    setPage(1);
    setBusy(null);
    setError("");
    setResult(null);
    setCsvFileName("");
    csvContacts.current = new Map();
  };

  useEffect(() => {
    if (isOpen) reset();
  }, [isOpen]);

  useEffect(() => {
    if (!isOpen) return;
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape" && !busy) onClose();
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [busy, isOpen, onClose]);

  useEffect(() => {
    if (!busy) {
      setBusyElapsedSeconds(0);
      return;
    }
    const startedAt = Date.now();
    setBusyElapsedSeconds(0);
    const interval = window.setInterval(
      () => setBusyElapsedSeconds(Math.floor((Date.now() - startedAt) / 1000)),
      1000
    );
    return () => window.clearInterval(interval);
  }, [busy]);

  const selectedContacts = useMemo(() => {
    if (!preview) return [];
    return preview.contacts.filter(
      (contact) =>
        selectedSourceIds.has(contact.sourceId)
        && (contact.status === "new" || contact.status === "different")
    );
  }, [preview, selectedSourceIds]);

  const selectedSourceContacts = useMemo(
    () => preview?.contacts.filter((contact) => selectedSourceIds.has(contact.sourceId)) ?? [],
    [preview, selectedSourceIds]
  );

  const filteredContacts = useMemo(() => {
    const needle = search.trim().toLocaleLowerCase("de");
    return selectedSourceContacts.filter((contact) => {
      const matchesFilter = reviewFilter === "all"
        || (reviewFilter === "differences" && contact.status === "different")
        || (reviewFilter === "new" && contact.status === "new")
        || (reviewFilter === "duplicates" && contact.status === "duplicate_exact")
        || (reviewFilter === "without-email" && !contact.email);
      if (!matchesFilter) return false;
      if (!needle) return true;
      return [contact.displayName, contact.email, contact.phone, contact.city, contact.reason]
        .some((value) => value.toLocaleLowerCase("de").includes(needle));
    });
  }, [reviewFilter, search, selectedSourceContacts]);

  const totalPages = Math.max(1, Math.ceil(filteredContacts.length / pageSize));
  const visibleContacts = filteredContacts.slice((page - 1) * pageSize, page * pageSize);

  useEffect(() => {
    setPage(1);
  }, [reviewFilter, search, selectedSourceIds]);

  useEffect(() => {
    if (page > totalPages) setPage(totalPages);
  }, [page, totalPages]);

  if (!isOpen) return null;

  const startClassicScan = async () => {
    setSource("classic");
    setBusy("scan");
    setError("");
    setPreview(null);
    try {
      await waitForNextPaint();
      const nextPreview = await previewOutlookClassicContacts(cleanImportedNames);
      setPreview(nextPreview);
      setSelectedSourceIds(new Set(nextPreview.sources.map((item) => item.id)));
    } catch (scanError) {
      setError(`Outlook Classic konnte nicht geprüft werden: ${scanError}`);
    } finally {
      setBusy(null);
    }
  };

  const chooseNewOutlookCsv = async () => {
    setSource("csv");
    setError("");
    try {
      const path = await open({
        multiple: false,
        filters: [{ name: "Outlook-Kontakte (CSV)", extensions: ["csv"] }]
      });
      if (!path || Array.isArray(path)) {
        setSource("choose");
        return;
      }

      setBusy("scan");
      await waitForNextPaint();
      const bytes = await readFile(path);
      const parsed = parseCsvBytes(bytes);
      const existing = await listContacts();
      const fileName = path.split(/[\\/]/).pop() || "Outlook-Kontakte.csv";
      const contacts = cleanImportedNames
        ? parsed.contacts.map(({ selected, ...contact }) => ({ ...cleanImportedContactName(contact), selected }))
        : parsed.contacts;
      const csvPreview = createCsvPreview(contacts, existing, fileName);
      csvContacts.current = csvPreview.contactMap;
      setCsvFileName(fileName);
      setPreview(csvPreview.preview);
      setSelectedSourceIds(new Set([csvSourceId]));
    } catch (scanError) {
      setError(`Die Outlook-CSV-Datei konnte nicht gelesen werden: ${scanError}`);
    } finally {
      setBusy(null);
    }
  };

  const toggleSource = (sourceId: string) => {
    setSelectedSourceIds((current) => {
      const next = new Set(current);
      if (next.has(sourceId)) next.delete(sourceId);
      else next.add(sourceId);
      return next;
    });
  };

  const submit = async () => {
    if (!preview || selectedSourceIds.size === 0 || selectedContacts.length === 0) {
      setError("Bitte wählen Sie mindestens eine Quelle mit importierbaren Kontakten aus.");
      return;
    }
    if (selectedContacts.length > 500) {
      const confirmed = window.confirm(
        `Es werden ${selectedContacts.length} Kontakte einmalig importiert. Bei sehr großen Kontaktbeständen kann dies bis zu 5 Minuten dauern. Möchten Sie fortfahren?`
      );
      if (!confirmed) return;
    }

    setBusy("import");
    setError("");
    try {
      await waitForNextPaint();
      let importResult: OutlookContactImportResult;
      if (source === "classic") {
        importResult = await importSelectedOutlookClassicContacts({
          selectedSourceIds: Array.from(selectedSourceIds),
          createSourceGroups,
          cleanImportedNames
        });
      } else {
        let groupIds: number[] = [];
        if (createSourceGroups) {
          const groups = await listGroups();
          const existingGroup = groups.find((group) => group.name.toLocaleLowerCase("de") === csvGroupName.toLocaleLowerCase("de"));
          const groupId = existingGroup?.id ?? await saveGroup({
            name: csvGroupName,
            description: "Einmaliger Kontaktimport aus dem neuen Outlook",
            createdAt: "",
            updatedAt: ""
          });
          groupIds = [groupId];
        }
        const rows = selectedContacts
          .map((contact) => csvContacts.current.get(contact.id))
          .filter((contact): contact is ContactInput => Boolean(contact))
          .map((contact) => ({ ...contact, groupIds }));
        const csvResult = await importContacts(`Outlook Kontaktimport (Neues Outlook CSV: ${csvFileName})`, rows);
        const duplicateCount = selectedSourceContacts.filter((contact) => contact.status === "duplicate_exact").length;
        importResult = {
          found: preview.found,
          imported: csvResult.imported,
          mergedDuplicates: 0,
          skippedExactDuplicates: duplicateCount + csvResult.skippedDuplicates,
          skippedConflicts: 0,
          skippedInvalid: preview.skippedInvalid,
          groupsUsed: groupIds.length,
          batchId: csvResult.batchId
        };
      }
      setResult(importResult);
      onImported(importResult, source === "classic" ? "classic" : "csv");
    } catch (importError) {
      setError(`Kontakte konnten nicht importiert werden: ${importError}`);
    } finally {
      setBusy(null);
    }
  };

  return (
    <div className="modal-backdrop outlook-import-backdrop" role="presentation" onMouseDown={() => !busy && onClose()}>
      <section
        className="form-panel modal-card outlook-import-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby="outlook-contact-import-title"
        onMouseDown={(event) => event.stopPropagation()}
      >
        <header className="outlook-import-heading">
          <div>
            <span className="outlook-import-icon"><UsersRound size={26} /></span>
            <div>
              <h3 id="outlook-contact-import-title">Outlook-Kontakte importieren</h3>
              <p>Erst prüfen, dann gezielt und einmalig übernehmen.</p>
            </div>
          </div>
          <button className="icon-button" type="button" onClick={onClose} disabled={Boolean(busy)} aria-label="Schließen">
            <X size={21} />
          </button>
        </header>

        {source === "choose" && (
          <div className="outlook-import-source-choice">
            <button type="button" onClick={startClassicScan}>
              <Laptop size={32} />
              <span>
                <strong>Outlook Classic</strong>
                <small>Kontaktordner und frühere Empfänger prüfen</small>
              </span>
            </button>
            <button type="button" onClick={chooseNewOutlookCsv}>
              <FileSpreadsheet size={32} />
              <span>
                <strong>Neues Outlook</strong>
                <small>Exportierte CSV-Datei auswählen</small>
              </span>
            </button>
          </div>
        )}

        {source !== "choose" && !result && (
          <button className="outlook-import-back" type="button" onClick={reset} disabled={Boolean(busy)}>
            <ArrowLeft size={17} /> Andere Outlook-Version wählen
          </button>
        )}

        {busy && (
          <div className="outlook-import-progress" role="status" aria-live="polite">
            <div className="outlook-import-progress-icon">
              <LoaderCircle className="spin" size={38} />
            </div>
            <strong>
              {busy === "import"
                ? "Kontakte werden sicher importiert …"
                : source === "classic"
                  ? "Outlook-Kontakte und frühere Empfänger werden eingelesen …"
                  : "CSV-Kontakte werden geprüft …"}
            </strong>
            <span>
              {source === "classic"
                ? "Kontaktordner und die lokal gespeicherte Outlook-Autovervollständigung werden gemeinsam geprüft."
                : "Die Kontakte werden vollständig geprüft. Das kann je nach Dateigröße etwas dauern."}
            </span>
            <div className="outlook-import-indeterminate" aria-hidden="true"><i /></div>
            <small className="outlook-import-elapsed">
              <Timer size={16} /> Laufzeit: {formatElapsedTime(busyElapsedSeconds)}
            </small>
            <small>Die App arbeitet weiter. Bitte dieses Fenster geöffnet lassen.</small>
          </div>
        )}

        {error && (
          <div className="outlook-import-error" role="alert">
            <AlertTriangle size={20} /> <span>{error}</span>
          </div>
        )}

        {preview && !result && !busy && (
          <>
            <div className="outlook-import-summary" aria-label="Zusammenfassung">
              <span><strong>{preview.found}</strong> gefunden</span>
              <span><strong>{preview.contacts.filter((item) => item.status === "new").length}</strong> neu</span>
              <span><strong>{preview.contacts.filter((item) => item.status === "duplicate_exact").length}</strong> 100 % identisch</span>
              <span><strong>{preview.contacts.filter((item) => item.status === "different").length}</strong> abweichend</span>
            </div>

            {preview.warnings.map((warning) => (
              <div className="outlook-import-warning" role="status" key={warning}>
                <AlertTriangle size={19} /> <span>{warning}</span>
              </div>
            ))}

            <section className="outlook-import-section">
              <div className="outlook-import-section-heading">
                <div>
                  <span className="step-number">1</span>
                  <div><h4>Quellen auswählen</h4><p>Kontaktordner und frühere Empfänger bleiben klar getrennt.</p></div>
                </div>
                <button type="button" onClick={() => setSelectedSourceIds(new Set(preview.sources.map((item) => item.id)))}>Alle auswählen</button>
              </div>
              <div className="outlook-source-list">
                {preview.sources.map((item) => (
                  <label className={`${selectedSourceIds.has(item.id) ? "outlook-source-card selected" : "outlook-source-card"}${item.kind === "autocomplete" ? " autocomplete-source" : ""}`} key={item.id}>
                    <input type="checkbox" checked={selectedSourceIds.has(item.id)} onChange={() => toggleSource(item.id)} />
                    {item.kind === "autocomplete" ? <AtSign size={21} /> : <FolderOpen size={21} />}
                    <span className="outlook-source-name">
                      <strong>{item.kind === "autocomplete" ? "Outlook-Autovervollständigung" : item.storeName}</strong>
                      <small>{item.kind === "autocomplete" ? "Frühere Empfänger, die nicht als Kontakt gespeichert sein müssen" : item.folderPath}</small>
                    </span>
                    <span className="outlook-source-counts">
                      <strong>{item.total}</strong>
                      <small>{item.newContacts} neu · {item.conflicts} abweichend · {item.exactDuplicates} exakt gleich</small>
                    </span>
                  </label>
                ))}
              </div>
            </section>

            <section className="outlook-import-section">
              <div className="outlook-import-section-heading">
                <div>
                  <span className="step-number">2</span>
                  <div><h4>Duplikate prüfen</h4><p>Bei früheren Empfängern genügt dieselbe E-Mail-Adresse zum Auslassen. Kontaktordner werden weiterhin vollständig verglichen.</p></div>
                </div>
              </div>
              <div className="outlook-review-toolbar">
                <label className="outlook-review-search">
                  <Search size={17} />
                  <input value={search} onChange={(event) => setSearch(event.target.value)} placeholder="Name, E-Mail oder Telefon suchen" />
                </label>
                <select value={reviewFilter} onChange={(event) => setReviewFilter(event.target.value as ReviewFilter)} aria-label="Kontakte filtern">
                  <option value="differences">Nur abweichende Kontakte</option>
                  <option value="all">Alle Kontakte</option>
                  <option value="new">Nur neue</option>
                  <option value="duplicates">Nur 100 % identische</option>
                  <option value="without-email">Ohne E-Mail</option>
                </select>
              </div>

              <div className="outlook-review-list">
                {visibleContacts.map((contact) => {
                  return (
                    <article className={`outlook-review-row status-${contact.status}`} key={contact.id}>
                      <span className="outlook-review-status" aria-hidden="true">
                        {contact.status === "duplicate_exact" ? <AlertTriangle size={17} /> : <Check size={17} />}
                      </span>
                      <div className="outlook-review-person">
                        <strong>{contact.displayName || "Ohne Namen"}</strong>
                        <span>{contact.email || contact.phone || "Keine E-Mail oder Telefonnummer"}</span>
                        <small>{contact.reason}{contact.existingName ? ` · Gefunden: ${contact.existingName}` : ""}</small>
                      </div>
                      {contact.status === "duplicate_exact" && <span className="outlook-skip-label">Wird ausgelassen</span>}
                      {contact.status === "new" && <span className="outlook-new-label">Wird importiert</span>}
                      {contact.status === "different" && <span className="outlook-new-label">Wird zusätzlich importiert</span>}
                    </article>
                  );
                })}
                {visibleContacts.length === 0 && <p className="outlook-review-empty">Für diesen Filter wurden keine Kontakte gefunden.</p>}
              </div>

              {filteredContacts.length > pageSize && (
                <div className="outlook-pagination">
                  <button type="button" onClick={() => setPage((value) => Math.max(1, value - 1))} disabled={page === 1} aria-label="Vorherige Seite"><ChevronLeft size={18} /></button>
                  <span>Seite {page} von {totalPages} · {filteredContacts.length} Kontakte</span>
                  <button type="button" onClick={() => setPage((value) => Math.min(totalPages, value + 1))} disabled={page === totalPages} aria-label="Nächste Seite"><ChevronRight size={18} /></button>
                </div>
              )}
            </section>

            <section className="outlook-import-section outlook-import-confirm">
              <div>
                <span className="step-number">3</span>
                <div>
                  <h4>{selectedContacts.length} Kontakte importieren</h4>
                  <label className="outlook-group-option">
                    <input type="checkbox" checked={createSourceGroups} onChange={(event) => setCreateSourceGroups(event.target.checked)} />
                    Automatisch nach Outlook-Ordner gruppieren
                  </label>
                </div>
              </div>
              <button className="primary large" type="button" onClick={submit} disabled={busy === "import" || selectedContacts.length === 0}>
                {busy === "import" ? <LoaderCircle className="spin" size={20} /> : <UsersRound size={20} />}
                {busy === "import" ? "Kontakte werden importiert …" : "Auswahl importieren"}
              </button>
            </section>
          </>
        )}

        {result && (
          <div className="outlook-import-success">
            <CheckCircle2 size={48} />
            <h4>Import abgeschlossen</h4>
            <p><strong>{result.imported}</strong> Kontakte wurden übernommen.</p>
            <span>{result.mergedDuplicates} Duplikate wurden zusammengeführt. {result.skippedExactDuplicates} zu 100 % identische Kontakte wurden ausgelassen.</span>
            <button className="primary" type="button" onClick={onClose}>Schließen</button>
          </div>
        )}
      </section>
    </div>
  );
}

function waitForNextPaint(): Promise<void> {
  return new Promise((resolve) => {
    window.requestAnimationFrame(() => window.setTimeout(resolve, 0));
  });
}

function formatElapsedTime(totalSeconds: number): string {
  const minutes = Math.floor(totalSeconds / 60).toString().padStart(2, "0");
  const seconds = (totalSeconds % 60).toString().padStart(2, "0");
  return `${minutes}:${seconds}`;
}

function normalizePhone(value: string) {
  let digits = value.replace(/\D/g, "");
  if (digits.startsWith("0049") && digits.length > 8) digits = `0${digits.slice(4)}`;
  else if (digits.startsWith("49") && digits.length > 8) digits = `0${digits.slice(2)}`;
  return digits.length >= 7 ? digits : "";
}

function contactName(contact: Pick<ContactInput, "displayName" | "firstName" | "lastName">) {
  return contact.displayName.trim()
    || `${contact.firstName.trim()} ${contact.lastName.trim()}`.trim();
}

interface CsvFingerprintIndex {
  exactContacts: Map<string, string>;
  names: Map<string, string>;
  emails: Map<string, string>;
  phones: Map<string, string>;
}

function addCsvFingerprint(index: CsvFingerprintIndex, contact: Contact | ContactInput) {
  const label = contactName(contact);
  const email = contact.email.trim().toLocaleLowerCase("de");
  index.exactContacts.set(contactExactContentKey(contact), label);
  if (email && !index.emails.has(email)) index.emails.set(email, label);
  const normalizedName = label.toLocaleLowerCase("de");
  if (normalizedName && !index.names.has(normalizedName)) index.names.set(normalizedName, label);
  for (const phone of [normalizePhone(contact.phone), normalizePhone(contact.mobilePhone)].filter(Boolean)) {
    if (!index.phones.has(phone)) index.phones.set(phone, label);
  }
}

function createCsvPreview(
  rows: Array<ContactInput & { selected: boolean }>,
  existing: Contact[],
  fileName: string
): { preview: OutlookContactImportPreview; contactMap: Map<string, ContactInput> } {
  const fingerprints: CsvFingerprintIndex = {
    exactContacts: new Map(),
    names: new Map(),
    emails: new Map(),
    phones: new Map()
  };
  for (const contact of existing) addCsvFingerprint(fingerprints, contact);
  const contacts: OutlookContactPreviewItem[] = [];
  const contactMap = new Map<string, ContactInput>();
  let skippedInvalid = 0;
  let newContacts = 0;
  let exactDuplicates = 0;
  let conflicts = 0;
  let withoutEmail = 0;

  rows.forEach(({ selected: _selected, ...contact }, index) => {
    const displayName = contactName(contact);
    const email = contact.email.trim().toLocaleLowerCase("de");
    const phones = [normalizePhone(contact.phone), normalizePhone(contact.mobilePhone)].filter(Boolean);
    const exactKey = contactExactContentKey({ ...contact, displayName, email });
    if (!displayName && !email && phones.length === 0) {
      skippedInvalid += 1;
      return;
    }
    const id = `csv-${index}`;
    let status: OutlookContactPreviewStatus = "new";
    let reason = "Neuer Kontakt";
    let existingName: string | null = null;
    const emailMatch = email ? fingerprints.emails.get(email) : undefined;
    const phoneMatch = phones.length ? phones.map((phone) => fingerprints.phones.get(phone)).find(Boolean) : undefined;
    const normalizedName = displayName.toLocaleLowerCase("de");
    const nameMatch = !email && normalizedName ? fingerprints.names.get(normalizedName) : undefined;
    const exactMatch = fingerprints.exactContacts.get(exactKey);

    if (exactMatch) {
      status = "duplicate_exact";
      reason = "Alle Kontaktfelder sind zu 100 % identisch.";
      existingName = exactMatch;
      exactDuplicates += 1;
    } else if (emailMatch) {
      status = "different";
      reason = "Gleiche E-Mail-Adresse, aber mindestens ein anderes Kontaktfeld. Beide Kontakte bleiben erhalten.";
      existingName = emailMatch;
      conflicts += 1;
    } else if (phoneMatch) {
      status = "different";
      reason = "Gleiche Telefonnummer, aber mindestens ein anderes Kontaktfeld. Beide Kontakte bleiben erhalten.";
      existingName = phoneMatch;
      conflicts += 1;
    } else if (nameMatch) {
      status = "different";
      reason = "Gleicher Name, aber mindestens ein anderes Kontaktfeld. Beide Kontakte bleiben erhalten.";
      existingName = nameMatch;
      conflicts += 1;
    } else {
      newContacts += 1;
    }
    if (!email) withoutEmail += 1;

    contacts.push({
      id,
      sourceId: csvSourceId,
      displayName,
      email,
      phone: contact.mobilePhone.trim() || contact.phone.trim(),
      city: contact.city.trim(),
      status,
      reason,
      existingName,
      defaultSelected: status !== "duplicate_exact"
    });
    contactMap.set(id, { ...contact, email });
    addCsvFingerprint(fingerprints, { ...contact, displayName, email });
  });

  return {
    preview: {
      found: rows.length,
      skippedInvalid,
      sources: [{
        id: csvSourceId,
        kind: "contacts",
        storeName: "Neues Outlook",
        folderPath: fileName,
        suggestedGroupName: csvGroupName,
        total: contacts.length,
        newContacts,
        exactDuplicates,
        conflicts,
        withoutEmail
      }],
      warnings: [],
      contacts
    },
    contactMap
  };
}
