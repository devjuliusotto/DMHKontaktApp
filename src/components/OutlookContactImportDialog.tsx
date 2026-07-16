import { open } from "@tauri-apps/plugin-dialog";
import { readFile } from "@tauri-apps/plugin-fs";
import {
  AlertTriangle,
  ArrowLeft,
  Check,
  CheckCircle2,
  ChevronLeft,
  ChevronRight,
  FileSpreadsheet,
  FolderOpen,
  Laptop,
  LoaderCircle,
  Search,
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
import { parseCsvBytes } from "../utils/importers";

interface OutlookContactImportDialogProps {
  open: boolean;
  onClose: () => void;
  onImported: (result: OutlookContactImportResult, source: "classic" | "csv") => void;
}

type ImportSource = "choose" | "classic" | "csv";
type ReviewFilter = "conflicts" | "all" | "new" | "duplicates" | "without-email";

const pageSize = 50;
const csvSourceId = "new-outlook-csv";
const csvGroupName = "Outlook · Neues Outlook";

export function OutlookContactImportDialog({ open: isOpen, onClose, onImported }: OutlookContactImportDialogProps) {
  const [source, setSource] = useState<ImportSource>("choose");
  const [preview, setPreview] = useState<OutlookContactImportPreview | null>(null);
  const [selectedSourceIds, setSelectedSourceIds] = useState<Set<string>>(new Set());
  const [includedConflictIds, setIncludedConflictIds] = useState<Set<string>>(new Set());
  const [createSourceGroups, setCreateSourceGroups] = useState(true);
  const [reviewFilter, setReviewFilter] = useState<ReviewFilter>("conflicts");
  const [search, setSearch] = useState("");
  const [page, setPage] = useState(1);
  const [busy, setBusy] = useState<"scan" | "import" | null>(null);
  const [error, setError] = useState("");
  const [result, setResult] = useState<OutlookContactImportResult | null>(null);
  const [csvFileName, setCsvFileName] = useState("");
  const csvContacts = useRef(new Map<string, ContactInput>());

  const reset = () => {
    setSource("choose");
    setPreview(null);
    setSelectedSourceIds(new Set());
    setIncludedConflictIds(new Set());
    setCreateSourceGroups(true);
    setReviewFilter("conflicts");
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

  const selectedContacts = useMemo(() => {
    if (!preview) return [];
    return preview.contacts.filter((contact) => {
      if (!selectedSourceIds.has(contact.sourceId)) return false;
      if (contact.status === "new") return true;
      return isReviewableConflict(contact.status) && includedConflictIds.has(contact.id);
    });
  }, [includedConflictIds, preview, selectedSourceIds]);

  const selectedSourceContacts = useMemo(
    () => preview?.contacts.filter((contact) => selectedSourceIds.has(contact.sourceId)) ?? [],
    [preview, selectedSourceIds]
  );

  const filteredContacts = useMemo(() => {
    const needle = search.trim().toLocaleLowerCase("de");
    return selectedSourceContacts.filter((contact) => {
      const matchesFilter = reviewFilter === "all"
        || (reviewFilter === "conflicts" && isReviewableConflict(contact.status))
        || (reviewFilter === "new" && contact.status === "new")
        || (reviewFilter === "duplicates" && contact.status === "duplicate_email")
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
      const nextPreview = await previewOutlookClassicContacts();
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
      const bytes = await readFile(path);
      const parsed = parseCsvBytes(bytes);
      const existing = await listContacts();
      const fileName = path.split(/[\\/]/).pop() || "Outlook-Kontakte.csv";
      const csvPreview = createCsvPreview(parsed.contacts, existing, fileName);
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

  const toggleConflict = (contactId: string) => {
    setIncludedConflictIds((current) => {
      const next = new Set(current);
      if (next.has(contactId)) next.delete(contactId);
      else next.add(contactId);
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
        `Es werden ${selectedContacts.length} Kontakte einmalig importiert. Bei großen Kontaktbeständen kann dies einige Minuten dauern. Möchten Sie fortfahren?`
      );
      if (!confirmed) return;
    }

    setBusy("import");
    setError("");
    try {
      let importResult: OutlookContactImportResult;
      if (source === "classic") {
        const backendResult = await importSelectedOutlookClassicContacts({
          selectedSourceIds: Array.from(selectedSourceIds),
          includedConflictIds: Array.from(includedConflictIds),
          createSourceGroups
        });
        importResult = {
          ...backendResult,
          skippedExactDuplicates: backendResult.skippedExactDuplicates
            + selectedSourceContacts.filter((contact) => contact.status === "duplicate_email").length,
          skippedConflicts: backendResult.skippedConflicts
            + selectedSourceContacts.filter(
              (contact) => isReviewableConflict(contact.status) && !includedConflictIds.has(contact.id)
            ).length
        };
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
        const duplicateCount = selectedSourceContacts.filter((contact) => contact.status === "duplicate_email").length;
        const omittedConflictCount = selectedSourceContacts.filter(
          (contact) => isReviewableConflict(contact.status) && !includedConflictIds.has(contact.id)
        ).length;
        importResult = {
          found: preview.found,
          imported: csvResult.imported,
          skippedExactDuplicates: duplicateCount,
          skippedConflicts: omittedConflictCount,
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
                <small>Konten und Kontaktordner direkt prüfen</small>
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

        {busy === "scan" && (
          <div className="outlook-import-progress" role="status">
            <LoaderCircle className="spin" size={34} />
            <strong>{source === "classic" ? "Outlook-Kontaktordner werden geprüft …" : "CSV-Kontakte werden geprüft …"}</strong>
            <span>Bei großen Kontaktbeständen kann dies einige Minuten dauern.</span>
          </div>
        )}

        {error && (
          <div className="outlook-import-error" role="alert">
            <AlertTriangle size={20} /> <span>{error}</span>
          </div>
        )}

        {preview && !result && busy !== "scan" && (
          <>
            <div className="outlook-import-summary" aria-label="Zusammenfassung">
              <span><strong>{preview.found}</strong> gefunden</span>
              <span><strong>{preview.contacts.filter((item) => item.status === "new").length}</strong> neu</span>
              <span><strong>{preview.contacts.filter((item) => item.status === "duplicate_email").length}</strong> vorhanden</span>
              <span><strong>{preview.contacts.filter((item) => isReviewableConflict(item.status)).length}</strong> zu prüfen</span>
            </div>

            <section className="outlook-import-section">
              <div className="outlook-import-section-heading">
                <div>
                  <span className="step-number">1</span>
                  <div><h4>Quellen auswählen</h4><p>Nur markierte Konten und Ordner werden berücksichtigt.</p></div>
                </div>
                <button type="button" onClick={() => setSelectedSourceIds(new Set(preview.sources.map((item) => item.id)))}>Alle auswählen</button>
              </div>
              <div className="outlook-source-list">
                {preview.sources.map((item) => (
                  <label className={selectedSourceIds.has(item.id) ? "outlook-source-card selected" : "outlook-source-card"} key={item.id}>
                    <input type="checkbox" checked={selectedSourceIds.has(item.id)} onChange={() => toggleSource(item.id)} />
                    <FolderOpen size={21} />
                    <span className="outlook-source-name">
                      <strong>{item.storeName}</strong>
                      <small>{item.folderPath}</small>
                    </span>
                    <span className="outlook-source-counts">
                      <strong>{item.total}</strong>
                      <small>{item.newContacts} neu · {item.conflicts} prüfen · {item.exactDuplicates} vorhanden</small>
                    </span>
                  </label>
                ))}
              </div>
            </section>

            <section className="outlook-import-section">
              <div className="outlook-import-section-heading">
                <div>
                  <span className="step-number">2</span>
                  <div><h4>Konflikte prüfen</h4><p>Gleiche E-Mail-Adressen werden nie doppelt importiert.</p></div>
                </div>
              </div>
              <div className="outlook-review-toolbar">
                <label className="outlook-review-search">
                  <Search size={17} />
                  <input value={search} onChange={(event) => setSearch(event.target.value)} placeholder="Name, E-Mail oder Telefon suchen" />
                </label>
                <select value={reviewFilter} onChange={(event) => setReviewFilter(event.target.value as ReviewFilter)} aria-label="Kontakte filtern">
                  <option value="conflicts">Nur Konflikte</option>
                  <option value="all">Alle Kontakte</option>
                  <option value="new">Nur neue</option>
                  <option value="duplicates">Bereits vorhanden</option>
                  <option value="without-email">Ohne E-Mail</option>
                </select>
              </div>

              <div className="outlook-review-list">
                {visibleContacts.map((contact) => {
                  const reviewable = isReviewableConflict(contact.status);
                  const included = includedConflictIds.has(contact.id);
                  return (
                    <article className={`outlook-review-row status-${contact.status}`} key={contact.id}>
                      <span className="outlook-review-status" aria-hidden="true">
                        {contact.status === "new" ? <Check size={17} /> : <AlertTriangle size={17} />}
                      </span>
                      <div className="outlook-review-person">
                        <strong>{contact.displayName || "Ohne Namen"}</strong>
                        <span>{contact.email || contact.phone || "Keine E-Mail oder Telefonnummer"}</span>
                        <small>{contact.reason}{contact.existingName ? ` · Gefunden: ${contact.existingName}` : ""}</small>
                      </div>
                      {reviewable && (
                        <label className="outlook-conflict-decision">
                          <input type="checkbox" checked={included} onChange={() => toggleConflict(contact.id)} />
                          Trotzdem importieren
                        </label>
                      )}
                      {contact.status === "duplicate_email" && <span className="outlook-skip-label">Wird ausgelassen</span>}
                      {contact.status === "new" && <span className="outlook-new-label">Wird importiert</span>}
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
                    Automatisch nach Outlook-Konto gruppieren
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
            <span>{result.skippedExactDuplicates} vorhandene und {result.skippedConflicts} nicht ausgewählte Konflikte wurden ausgelassen.</span>
            <button className="primary" type="button" onClick={onClose}>Schließen</button>
          </div>
        )}
      </section>
    </div>
  );
}

function isReviewableConflict(status: OutlookContactPreviewStatus) {
  return status === "possible_phone" || status === "possible_name";
}

function normalizePhone(value: string) {
  let digits = value.replace(/\D/g, "");
  if (digits.startsWith("0049") && digits.length > 8) digits = `0${digits.slice(4)}`;
  else if (digits.startsWith("49") && digits.length > 8) digits = `0${digits.slice(2)}`;
  return digits.length >= 7 ? digits : "";
}

function contactName(contact: Pick<ContactInput, "displayName" | "firstName" | "lastName">) {
  return contact.displayName.trim() || `${contact.firstName} ${contact.lastName}`.trim();
}

interface CsvFingerprint {
  name: string;
  label: string;
  email: string;
  phones: string[];
}

function createCsvPreview(
  rows: Array<ContactInput & { selected: boolean }>,
  existing: Contact[],
  fileName: string
): { preview: OutlookContactImportPreview; contactMap: Map<string, ContactInput> } {
  const fingerprints: CsvFingerprint[] = existing.map((contact) => ({
    name: contactName(contact).toLocaleLowerCase("de"),
    label: contactName(contact),
    email: contact.email.trim().toLocaleLowerCase("de"),
    phones: [normalizePhone(contact.phone), normalizePhone(contact.mobilePhone)].filter(Boolean)
  }));
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
    if (!displayName && !email && phones.length === 0) {
      skippedInvalid += 1;
      return;
    }
    const id = `csv-${index}`;
    let status: OutlookContactPreviewStatus = "new";
    let reason = "Neuer Kontakt";
    let existingName: string | null = null;
    const emailMatch = email ? fingerprints.find((item) => item.email === email) : undefined;
    const phoneMatch = phones.length ? fingerprints.find((item) => phones.some((phone) => item.phones.includes(phone))) : undefined;
    const normalizedName = displayName.toLocaleLowerCase("de");
    const nameMatch = !email && normalizedName ? fingerprints.find((item) => item.name === normalizedName) : undefined;

    if (emailMatch) {
      status = "duplicate_email";
      reason = "Diese E-Mail-Adresse ist bereits vorhanden.";
      existingName = emailMatch.label;
      exactDuplicates += 1;
    } else if (phoneMatch) {
      status = "possible_phone";
      reason = "Möglicherweise bereits mit derselben Telefonnummer vorhanden.";
      existingName = phoneMatch.label;
      conflicts += 1;
    } else if (nameMatch) {
      status = "possible_name";
      reason = "Kontakt ohne E-Mail mit demselben Namen gefunden.";
      existingName = nameMatch.label;
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
      defaultSelected: status === "new"
    });
    contactMap.set(id, { ...contact, email });
    fingerprints.push({ name: normalizedName, label: displayName, email, phones });
  });

  return {
    preview: {
      found: rows.length,
      skippedInvalid,
      sources: [{
        id: csvSourceId,
        storeName: "Neues Outlook",
        folderPath: fileName,
        suggestedGroupName: csvGroupName,
        total: contacts.length,
        newContacts,
        exactDuplicates,
        conflicts,
        withoutEmail
      }],
      contacts
    },
    contactMap
  };
}
