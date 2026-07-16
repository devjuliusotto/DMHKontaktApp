import { ChevronDown, ChevronLeft, ChevronRight, ChevronUp, ChevronsUpDown, Copy, Edit, GripVertical, Mail, Printer, Trash2 } from "lucide-react";
import type { PointerEvent } from "react";
import { useEffect, useMemo, useState } from "react";
import type { Contact } from "../types/contact";
import { displayName } from "../utils/contact";
import { t } from "../i18n";

interface ContactTableProps {
  contacts: Contact[];
  onEdit: (contact: Contact) => void;
  onDelete: (contact: Contact) => void;
  onCopyEmail: (email: string) => void;
  onEmail: (email: string) => void;
  onPrint: () => void;
  selectionMode: boolean;
  selectedContactIds: Set<number>;
  onToggleSelection: (contact: Contact) => void;
  onPointerDragStart: (contact: Contact, position: { x: number; y: number }) => void;
  dragEnabled?: boolean;
}

type ContactSortKey = "name" | "email";
type SortDirection = "asc" | "desc";

const contactCollator = new Intl.Collator("de", { numeric: true, sensitivity: "base" });
const contactsPerPage = 100;

export function ContactTable({
  contacts,
  onEdit,
  onDelete,
  onCopyEmail,
  onEmail,
  onPrint,
  selectionMode,
  selectedContactIds,
  onToggleSelection,
  onPointerDragStart,
  dragEnabled = true
}: ContactTableProps) {
  const [selectedContactId, setSelectedContactId] = useState<number | undefined>();
  const [sort, setSort] = useState<{ key: ContactSortKey; direction: SortDirection }>({
    key: "name",
    direction: "asc"
  });
  const [page, setPage] = useState(1);

  const sortedContacts = useMemo(() => {
    return contacts
      .map((contact, originalIndex) => ({ contact, originalIndex }))
      .sort((left, right) => {
        const leftValue = sort.key === "name" ? displayName(left.contact).trim() : left.contact.email.trim();
        const rightValue = sort.key === "name" ? displayName(right.contact).trim() : right.contact.email.trim();
        const leftMissing = leftValue.length === 0;
        const rightMissing = rightValue.length === 0;

        if (leftMissing !== rightMissing) {
          if (sort.key === "email") return sort.direction === "asc" ? (leftMissing ? -1 : 1) : (leftMissing ? 1 : -1);
          return leftMissing ? 1 : -1;
        }

        const comparison = contactCollator.compare(leftValue, rightValue);
        if (comparison !== 0) return sort.direction === "asc" ? comparison : -comparison;

        const nameComparison = contactCollator.compare(displayName(left.contact), displayName(right.contact));
        return nameComparison || left.originalIndex - right.originalIndex;
      })
      .map(({ contact }) => contact);
  }, [contacts, sort]);
  const totalPages = Math.max(1, Math.ceil(sortedContacts.length / contactsPerPage));
  const visibleContacts = sortedContacts.slice((page - 1) * contactsPerPage, page * contactsPerPage);

  useEffect(() => {
    setPage(1);
  }, [contacts, sort]);

  useEffect(() => {
    if (page > totalPages) setPage(totalPages);
  }, [page, totalPages]);

  const toggleSort = (key: ContactSortKey) => {
    setSort((current) => ({
      key,
      direction: current.key === key && current.direction === "asc" ? "desc" : "asc"
    }));
  };

  const sortIcon = (key: ContactSortKey) => {
    if (sort.key !== key) return <ChevronsUpDown size={14} aria-hidden="true" />;
    return sort.direction === "asc"
      ? <ChevronUp size={15} aria-hidden="true" />
      : <ChevronDown size={15} aria-hidden="true" />;
  };

  const startPointerDrag = (event: PointerEvent<HTMLTableRowElement>, contact: Contact) => {
    if (!dragEnabled || event.button !== 0 || !contact.id) return;
    const target = event.target as HTMLElement;
    if (target.closest("button")) return;
    if (selectionMode && !selectedContactIds.has(contact.id)) return;
    event.preventDefault();
    setSelectedContactId(contact.id);
    onPointerDragStart(contact, { x: event.clientX, y: event.clientY });
  };

  const selectRow = (contact: Contact) => {
    if (selectionMode) {
      onToggleSelection(contact);
      return;
    }
    setSelectedContactId(contact.id);
  };

  return (
    <section className="table-panel contacts-list-panel">
      <div className="panel-heading">
        <h2>{t.contacts} <span className="contact-count">{contacts.length}</span></h2>
        <button type="button" onClick={onPrint}>
          <Printer size={22} /> Drucken
        </button>
      </div>
      <div className="table-wrap">
        <table className={dragEnabled ? "contacts-table" : "contacts-table drag-disabled"}>
          <colgroup>
            <col className="contact-name-column" />
            <col className="contact-email-column" />
            <col className="contact-actions-column" />
          </colgroup>
          <thead>
            <tr>
              <th aria-sort={sort.key === "name" ? (sort.direction === "asc" ? "ascending" : "descending") : "none"}>
                <button
                  className={sort.key === "name" ? "contact-sort-button active" : "contact-sort-button"}
                  type="button"
                  onClick={() => toggleSort("name")}
                  title="Nach Name sortieren"
                >
                  Name {sortIcon("name")}
                </button>
              </th>
              <th aria-sort={sort.key === "email" ? (sort.direction === "asc" ? "ascending" : "descending") : "none"}>
                <button
                  className={sort.key === "email" ? "contact-sort-button active" : "contact-sort-button"}
                  type="button"
                  onClick={() => toggleSort("email")}
                  title="Nach E-Mail sortieren; Kontakte ohne E-Mail zuerst"
                >
                  E-Mail {sortIcon("email")}
                </button>
              </th>
              <th>Aktionen</th>
            </tr>
          </thead>
          <tbody>
            {visibleContacts.map((contact) => {
              const isMultiSelected = Boolean(contact.id && selectedContactIds.has(contact.id));
              return (
                <tr
                  key={contact.id}
                  className={[
                    selectedContactId === contact.id ? "selected" : "",
                    isMultiSelected ? "multi-selected" : "",
                    selectionMode ? "selection-mode" : ""
                  ].filter(Boolean).join(" ")}
                  tabIndex={0}
                  onClick={() => selectRow(contact)}
                  onDoubleClick={() => {
                    if (!selectionMode) onEdit(contact);
                  }}
                  onFocus={() => setSelectedContactId(contact.id)}
                  onPointerDown={(event) => startPointerDrag(event, contact)}
                >
                  <td className="contact-primary" title={displayName(contact)}>
                    <div className="contact-name-content">
                      {selectionMode && (
                        <span className={isMultiSelected ? "selection-dot checked" : "selection-dot"} aria-hidden="true">
                          {isMultiSelected ? "✓" : ""}
                        </span>
                      )}
                      {dragEnabled && (
                        <span
                          aria-label="Kontakt verschieben"
                          className="drag-handle"
                          onMouseDown={() => setSelectedContactId(contact.id)}
                          role="button"
                          tabIndex={-1}
                          title="Kontakt in Gruppe ziehen"
                        >
                          <GripVertical size={16} />
                        </span>
                      )}
                      <span className="contact-name-text">
                        <strong>{displayName(contact)}</strong>
                        {contact.shortInfo && <small>{contact.shortInfo}</small>}
                      </span>
                    </div>
                  </td>
                  <td className="contact-value" title={contact.email}>
                    <div className="contact-email-content">
                      <span>{contact.email || "-"}</span>
                      {contact.email && (
                        <button title="E-Mail kopieren" type="button" onClick={() => onCopyEmail(contact.email)}>
                          <Copy size={16} />
                        </button>
                      )}
                    </div>
                  </td>
                  <td>
                    <div className="inline-actions">
                      <button title={t.editContact} type="button" onClick={() => onEdit(contact)} disabled={selectionMode}>
                        <Edit size={16} />
                      </button>
                      {contact.email && (
                        <button title="E-Mail-Anwendung auswählen" type="button" onClick={() => onEmail(contact.email)} disabled={selectionMode}>
                          <Mail size={16} />
                        </button>
                      )}
                      <button title={t.deleteContact} type="button" onClick={() => onDelete(contact)} disabled={selectionMode}>
                        <Trash2 size={16} />
                      </button>
                    </div>
                  </td>
                </tr>
              );
            })}
            {contacts.length === 0 && (
              <tr>
                <td colSpan={3} className="empty-row">
                  Keine Kontakte gefunden.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
      {sortedContacts.length > contactsPerPage && (
        <div className="contact-table-pagination" aria-label="Seitennavigation Kontakte">
          <button type="button" onClick={() => setPage((value) => Math.max(1, value - 1))} disabled={page === 1} aria-label="Vorherige Seite">
            <ChevronLeft size={18} />
          </button>
          <span>Seite {page} von {totalPages} · {sortedContacts.length} Kontakte</span>
          <button type="button" onClick={() => setPage((value) => Math.min(totalPages, value + 1))} disabled={page === totalPages} aria-label="Nächste Seite">
            <ChevronRight size={18} />
          </button>
        </div>
      )}
    </section>
  );
}
