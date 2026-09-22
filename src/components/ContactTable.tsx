import { ChevronDown, ChevronLeft, ChevronRight, ChevronUp, ChevronsUpDown, Copy, Edit, Ellipsis, Mail, Trash2 } from "lucide-react";
import type { PointerEvent } from "react";
import { useEffect, useMemo, useRef, useState } from "react";
import type { Contact } from "../types/contact";
import { displayName, primaryContactEmail } from "../utils/contact";
import { t } from "../i18n";

interface ContactTableProps {
  contacts: Contact[];
  paginationKey: string;
  onEdit: (contact: Contact) => void;
  onDelete: (contact: Contact) => void;
  onCopyEmail: (email: string) => void;
  onEmail: (email: string) => void;
  selectionMode: boolean;
  selectedContactIds: Set<number>;
  onToggleSelection: (contact: Contact) => void;
  onPointerDragStart: (contact: Contact, position: { x: number; y: number }) => void;
  dragEnabled?: boolean;
  managementView?: boolean;
  activeContactId?: number;
  onSelect?: (contact: Contact) => void;
}

type ContactSortKey = "name" | "email";
type SortDirection = "asc" | "desc";

const contactCollator = new Intl.Collator("de", { numeric: true, sensitivity: "base" });
const contactsPerPage = 100;

function contactInitials(contact: Contact): string {
  const source = displayName(contact).trim();
  if (!source) return "?";
  const parts = source.split(/\s+/).filter(Boolean);
  return (parts.length > 1 ? `${parts[0][0]}${parts[parts.length - 1][0]}` : source.slice(0, 2)).toUpperCase();
}

export function ContactTable({
  contacts,
  paginationKey,
  onEdit,
  onDelete,
  onCopyEmail,
  onEmail,
  selectionMode,
  selectedContactIds,
  onToggleSelection,
  onPointerDragStart,
  dragEnabled = true,
  managementView = false,
  activeContactId,
  onSelect
}: ContactTableProps) {
  const tableWrapRef = useRef<HTMLDivElement>(null);
  const [selectedContactId, setSelectedContactId] = useState<number | undefined>();
  const [openActionsContactId, setOpenActionsContactId] = useState<number | undefined>();
  const [sort, setSort] = useState<{ key: ContactSortKey; direction: SortDirection }>({
    key: "name",
    direction: "asc"
  });
  const [page, setPage] = useState(1);
  const currentSelectedContactId = activeContactId ?? selectedContactId;

  const sortedContacts = useMemo(() => {
    return contacts
      .map((contact, originalIndex) => ({ contact, originalIndex }))
      .sort((left, right) => {
        const leftValue = sort.key === "name" ? displayName(left.contact).trim() : primaryContactEmail(left.contact);
        const rightValue = sort.key === "name" ? displayName(right.contact).trim() : primaryContactEmail(right.contact);
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
  }, [paginationKey, sort]);

  useEffect(() => {
    if (page > totalPages) setPage(totalPages);
  }, [page, totalPages]);

  useEffect(() => {
    tableWrapRef.current?.scrollTo({ top: 0, left: 0, behavior: "auto" });
  }, [page]);

  useEffect(() => {
    if (openActionsContactId === undefined) return;
    const closeMenu = () => setOpenActionsContactId(undefined);
    const closeMenuWithKeyboard = (event: KeyboardEvent) => {
      if (event.key === "Escape") closeMenu();
    };
    window.addEventListener("pointerdown", closeMenu);
    window.addEventListener("keydown", closeMenuWithKeyboard);
    return () => {
      window.removeEventListener("pointerdown", closeMenu);
      window.removeEventListener("keydown", closeMenuWithKeyboard);
    };
  }, [openActionsContactId]);

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

  const startPointerDrag = (event: PointerEvent<HTMLElement>, contact: Contact) => {
    if (!dragEnabled || event.button !== 0 || !contact.id) return;
    const target = event.target as HTMLElement;
    if (target.closest("button")) return;
    if (selectionMode && !selectedContactIds.has(contact.id)) return;
    event.preventDefault();
    event.currentTarget.setPointerCapture(event.pointerId);
    setSelectedContactId(contact.id);
    onSelect?.(contact);
    onPointerDragStart(contact, { x: event.clientX, y: event.clientY });
  };

  const selectRow = (contact: Contact) => {
    if (selectionMode) {
      onToggleSelection(contact);
      return;
    }
    setSelectedContactId(contact.id);
    onSelect?.(contact);
  };

  const pagination = sortedContacts.length > contactsPerPage ? (
    <div className="contact-table-pagination" aria-label="Seitennavigation Kontakte">
      <button type="button" onClick={() => setPage((value) => Math.max(1, value - 1))} disabled={page === 1} aria-label="Vorherige Seite">
        <ChevronLeft size={18} />
      </button>
      <span>Seite {page} von {totalPages} · {sortedContacts.length} Kontakte</span>
      <button type="button" onClick={() => setPage((value) => Math.min(totalPages, value + 1))} disabled={page === totalPages} aria-label="Nächste Seite">
        <ChevronRight size={18} />
      </button>
    </div>
  ) : null;

  if (managementView) {
    return (
      <section className="contacts-list-panel management-contact-table">
        <div className="contact-compact-list" ref={tableWrapRef} role="listbox" aria-label="Kontakte">
          {visibleContacts.map((contact) => {
            const isMultiSelected = Boolean(contact.id && selectedContactIds.has(contact.id));
            const isActive = currentSelectedContactId === contact.id;
            const preferredEmail = primaryContactEmail(contact);
            const actionsOpen = openActionsContactId === contact.id;
            return (
              <div
                className={["contact-compact-row", isActive ? "selected" : "", isMultiSelected ? "multi-selected" : "", selectionMode ? "selection-mode" : ""].filter(Boolean).join(" ")}
                key={contact.id}
                role="option"
                aria-selected={isActive || isMultiSelected}
                tabIndex={0}
                onClick={() => selectRow(contact)}
                onDoubleClick={() => {
                  if (!selectionMode) onEdit(contact);
                }}
                onFocus={() => {
                  setSelectedContactId(contact.id);
                  onSelect?.(contact);
                }}
                onKeyDown={(event) => {
                  if (event.key === "Enter" || event.key === " ") {
                    event.preventDefault();
                    selectRow(contact);
                  }
                }}
                onPointerDown={(event) => startPointerDrag(event, contact)}
              >
                {selectionMode ? (
                  <span className={isMultiSelected ? "selection-dot checked" : "selection-dot"} aria-hidden="true">
                    {isMultiSelected ? "✓" : ""}
                  </span>
                ) : (
                  <span className={`contact-avatar avatar-${(contact.id ?? 0) % 6}`} aria-hidden="true">
                    {contactInitials(contact)}
                  </span>
                )}
                <span className="contact-compact-copy">
                  <strong title={displayName(contact)}>{displayName(contact)}</strong>
                  <small title={preferredEmail || contact.company}>{preferredEmail || contact.company || "Keine E-Mail-Adresse"}</small>
                </span>
                {!selectionMode && (
                  <span className="contact-row-actions">
                    <button
                      className="contact-row-menu-button"
                      type="button"
                      aria-label={`Aktionen für ${displayName(contact)}`}
                      aria-expanded={actionsOpen}
                      onClick={(event) => {
                        event.stopPropagation();
                        setOpenActionsContactId((current) => current === contact.id ? undefined : contact.id);
                      }}
                    >
                      <Ellipsis size={18} />
                    </button>
                    {actionsOpen && (
                      <span className="contact-row-menu" role="menu" onPointerDown={(event) => event.stopPropagation()} onClick={(event) => event.stopPropagation()}>
                        <button type="button" role="menuitem" onClick={() => { setOpenActionsContactId(undefined); onEdit(contact); }}><Edit size={16} /> Bearbeiten</button>
                        {preferredEmail && <button type="button" role="menuitem" onClick={() => { setOpenActionsContactId(undefined); onEmail(preferredEmail); }}><Mail size={16} /> Nachricht</button>}
                        {preferredEmail && <button type="button" role="menuitem" onClick={() => { setOpenActionsContactId(undefined); onCopyEmail(preferredEmail); }}><Copy size={16} /> E-Mail kopieren</button>}
                        <button className="danger" type="button" role="menuitem" onClick={() => { setOpenActionsContactId(undefined); onDelete(contact); }}><Trash2 size={16} /> Löschen</button>
                      </span>
                    )}
                  </span>
                )}
              </div>
            );
          })}
          {contacts.length === 0 && <p className="contact-compact-empty">Keine Kontakte gefunden.</p>}
        </div>
        {pagination}
      </section>
    );
  }

  return (
    <section className={managementView ? "table-panel contacts-list-panel management-contact-table" : "table-panel contacts-list-panel"}>
      {!managementView && <div className="panel-heading">
        <h2>{t.contacts} <span className="contact-count">{contacts.length}</span></h2>
      </div>}
      <div className="table-wrap" ref={tableWrapRef}>
        <table className={dragEnabled ? "contacts-table" : "contacts-table drag-disabled"}>
          <colgroup>
            <col className="contact-name-column" />
            <col className="contact-email-column" />
            {!managementView && <col className="contact-actions-column" />}
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
              {!managementView && <th>Aktionen</th>}
            </tr>
          </thead>
          <tbody>
            {visibleContacts.map((contact) => {
              const isMultiSelected = Boolean(contact.id && selectedContactIds.has(contact.id));
              const preferredEmail = primaryContactEmail(contact);
              return (
                <tr
                  key={contact.id}
                  className={[
                    currentSelectedContactId === contact.id ? "selected" : "",
                    isMultiSelected ? "multi-selected" : "",
                    selectionMode ? "selection-mode" : ""
                  ].filter(Boolean).join(" ")}
                  tabIndex={0}
                  onClick={() => selectRow(contact)}
                  onDoubleClick={() => {
                    if (!selectionMode) onEdit(contact);
                  }}
                  onFocus={() => {
                    setSelectedContactId(contact.id);
                    onSelect?.(contact);
                  }}
                  onPointerDown={(event) => startPointerDrag(event, contact)}
                >
                  <td className="contact-primary" title={displayName(contact)}>
                    <div className="contact-name-content">
                      {selectionMode && (
                        <span className={isMultiSelected ? "selection-dot checked" : "selection-dot"} aria-hidden="true">
                          {isMultiSelected ? "✓" : ""}
                        </span>
                      )}
                      {managementView && (
                        <span className={`contact-avatar avatar-${(contact.id ?? 0) % 6}`} aria-hidden="true">
                          {contactInitials(contact)}
                        </span>
                      )}
                      <span className="contact-name-text">
                        <strong>{displayName(contact)}</strong>
                        {contact.shortInfo && <small>{contact.shortInfo}</small>}
                      </span>
                    </div>
                  </td>
                  <td className="contact-value" title={preferredEmail}>
                    <div className="contact-email-content">
                      <span>{preferredEmail || "-"}</span>
                      {preferredEmail && (
                        <button title="E-Mail kopieren" type="button" onClick={() => onCopyEmail(preferredEmail)}>
                          <Copy size={16} />
                        </button>
                      )}
                    </div>
                  </td>
                  {!managementView && <td>
                    <div className="inline-actions">
                      <button title={t.editContact} type="button" onClick={() => onEdit(contact)} disabled={selectionMode}>
                        <Edit size={16} />
                      </button>
                      {preferredEmail && (
                        <button title="E-Mail-Anwendung auswählen" type="button" onClick={() => onEmail(preferredEmail)} disabled={selectionMode}>
                          <Mail size={16} />
                        </button>
                      )}
                      <button title={t.deleteContact} type="button" onClick={() => onDelete(contact)} disabled={selectionMode}>
                        <Trash2 size={16} />
                      </button>
                    </div>
                  </td>}
                </tr>
              );
            })}
            {contacts.length === 0 && (
              <tr>
                <td colSpan={managementView ? 2 : 3} className="empty-row">
                  Keine Kontakte gefunden.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
      {pagination}
    </section>
  );
}
