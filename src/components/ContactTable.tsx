import { ChevronDown, ChevronLeft, ChevronRight, ChevronUp, ChevronsUpDown, Copy, Edit, Ellipsis, Mail, Trash2 } from "lucide-react";
import type { KeyboardEvent as ReactKeyboardEvent, MouseEvent, PointerEvent } from "react";
import { useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
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
  selectionActive: boolean;
  selectedContactIds: Set<number>;
  onSelectionChange: (contactIds: number[], operation: "replace" | "add" | "toggle") => void;
  onClearSelection: () => void;
  onPointerDragStart: (contact: Contact, position: { x: number; y: number }) => void;
  dragEnabled?: boolean;
  managementView?: boolean;
  activeContactId?: number;
  onSelect?: (contact: Contact) => void;
  sort?: ContactSort;
  onSortChange?: (sort: ContactSort) => void;
  nameDisplay?: ContactNameDisplay;
}

export type ContactSortKey = "name" | "email";
export type SortDirection = "asc" | "desc";
export type ContactNameDisplay = "first-last" | "last-first";
export type ContactSort = { key: ContactSortKey; direction: SortDirection };
type ContactRowMenuPosition = { left: number; top: number };

const contactCollator = new Intl.Collator("de", { numeric: true, sensitivity: "base" });
const contactsPerPage = 100;

function formattedContactName(contact: Contact, nameDisplay: ContactNameDisplay): string {
  const firstName = contact.firstName.trim();
  const lastName = contact.lastName.trim();
  if (nameDisplay === "last-first" && (firstName || lastName)) {
    return [lastName, firstName].filter(Boolean).join(", ");
  }
  if (firstName || lastName) return [firstName, lastName].filter(Boolean).join(" ");
  return displayName(contact);
}

function contactInitials(contact: Contact, nameDisplay: ContactNameDisplay): string {
  const source = formattedContactName(contact, nameDisplay).trim();
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
  selectionActive,
  selectedContactIds,
  onSelectionChange,
  onClearSelection,
  onPointerDragStart,
  dragEnabled = true,
  managementView = false,
  activeContactId,
  onSelect,
  sort: controlledSort,
  onSortChange,
  nameDisplay = "first-last"
}: ContactTableProps) {
  const tableWrapRef = useRef<HTMLDivElement>(null);
  const selectionAnchorIdRef = useRef<number | undefined>();
  const [selectedContactId, setSelectedContactId] = useState<number | undefined>();
  const [openActionsContactId, setOpenActionsContactId] = useState<number | undefined>();
  const [actionMenuPosition, setActionMenuPosition] = useState<ContactRowMenuPosition | null>(null);
  const [internalSort, setInternalSort] = useState<ContactSort>({
    key: "name",
    direction: "asc"
  });
  const sort = controlledSort ?? internalSort;
  const [page, setPage] = useState(1);
  const currentSelectedContactId = activeContactId ?? selectedContactId;

  const sortedContacts = useMemo(() => {
    return contacts
      .map((contact, originalIndex) => ({ contact, originalIndex }))
      .sort((left, right) => {
        const leftName = formattedContactName(left.contact, nameDisplay);
        const rightName = formattedContactName(right.contact, nameDisplay);
        const leftValue = sort.key === "name" ? leftName : primaryContactEmail(left.contact);
        const rightValue = sort.key === "name" ? rightName : primaryContactEmail(right.contact);
        const leftMissing = leftValue.length === 0;
        const rightMissing = rightValue.length === 0;

        if (leftMissing !== rightMissing) {
          return leftMissing ? 1 : -1;
        }

        const comparison = contactCollator.compare(leftValue, rightValue);
        if (comparison !== 0) return sort.direction === "asc" ? comparison : -comparison;

        const nameComparison = contactCollator.compare(leftName, rightName);
        return nameComparison || left.originalIndex - right.originalIndex;
      })
      .map(({ contact }) => contact);
  }, [contacts, nameDisplay, sort]);
  const totalPages = Math.max(1, Math.ceil(sortedContacts.length / contactsPerPage));
  const visibleContacts = sortedContacts.slice((page - 1) * contactsPerPage, page * contactsPerPage);

  useEffect(() => {
    setPage(1);
    selectionAnchorIdRef.current = undefined;
  }, [paginationKey, sort]);

  useEffect(() => {
    if (page > totalPages) setPage(totalPages);
  }, [page, totalPages]);

  useEffect(() => {
    tableWrapRef.current?.scrollTo({ top: 0, left: 0, behavior: "auto" });
  }, [page]);

  useEffect(() => {
    if (openActionsContactId === undefined) return;
    const closeMenu = () => {
      setOpenActionsContactId(undefined);
      setActionMenuPosition(null);
    };
    const closeMenuWithKeyboard = (event: KeyboardEvent) => {
      if (event.key === "Escape") closeMenu();
    };
    const contactList = tableWrapRef.current;
    window.addEventListener("pointerdown", closeMenu);
    window.addEventListener("keydown", closeMenuWithKeyboard);
    window.addEventListener("resize", closeMenu);
    contactList?.addEventListener("scroll", closeMenu, { passive: true });
    return () => {
      window.removeEventListener("pointerdown", closeMenu);
      window.removeEventListener("keydown", closeMenuWithKeyboard);
      window.removeEventListener("resize", closeMenu);
      contactList?.removeEventListener("scroll", closeMenu);
    };
  }, [openActionsContactId]);

  const toggleContactActions = (contactId: number, button: HTMLButtonElement, itemCount: number) => {
    if (openActionsContactId === contactId) {
      setOpenActionsContactId(undefined);
      setActionMenuPosition(null);
      return;
    }

    const buttonRect = button.getBoundingClientRect();
    const viewportMargin = 8;
    const menuGap = 4;
    const menuWidth = 190;
    const estimatedMenuHeight = itemCount * 40 + 12;
    const maxLeft = Math.max(viewportMargin, window.innerWidth - menuWidth - viewportMargin);
    const left = Math.min(
      maxLeft,
      Math.max(viewportMargin, buttonRect.right - menuWidth)
    );
    const belowTop = buttonRect.bottom + menuGap;
    const top = belowTop + estimatedMenuHeight <= window.innerHeight - viewportMargin
      ? belowTop
      : Math.max(viewportMargin, buttonRect.top - estimatedMenuHeight - menuGap);

    setActionMenuPosition({ left, top });
    setOpenActionsContactId(contactId);
  };

  const toggleSort = (key: ContactSortKey) => {
    const next: ContactSort = {
      key,
      direction: sort.key === key && sort.direction === "asc" ? "desc" : "asc"
    };
    if (onSortChange) onSortChange(next);
    else setInternalSort(next);
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
    if (event.ctrlKey || event.metaKey || event.shiftKey) return;
    if (selectionMode && !selectedContactIds.has(contact.id)) return;
    event.preventDefault();
    event.currentTarget.setPointerCapture(event.pointerId);
    onPointerDragStart(contact, { x: event.clientX, y: event.clientY });
  };

  const selectRow = (
    contact: Contact,
    modifiers: Pick<MouseEvent<HTMLElement> | ReactKeyboardEvent<HTMLElement>, "ctrlKey" | "metaKey" | "shiftKey">
  ) => {
    if (!contact.id) return;
    const additiveModifier = modifiers.ctrlKey || modifiers.metaKey;

    if (modifiers.shiftKey) {
      const anchorId = selectionAnchorIdRef.current ?? currentSelectedContactId ?? contact.id;
      const anchorIndex = sortedContacts.findIndex((entry) => entry.id === anchorId);
      const contactIndex = sortedContacts.findIndex((entry) => entry.id === contact.id);
      const rangeIds = anchorIndex >= 0 && contactIndex >= 0
        ? sortedContacts
          .slice(Math.min(anchorIndex, contactIndex), Math.max(anchorIndex, contactIndex) + 1)
          .flatMap((entry) => entry.id ? [entry.id] : [])
        : [contact.id];
      setSelectedContactId(contact.id);
      onSelectionChange(rangeIds, additiveModifier ? "add" : "replace");
      return;
    }

    selectionAnchorIdRef.current = contact.id;
    if (additiveModifier || selectionMode) {
      setSelectedContactId(contact.id);
      onSelectionChange([contact.id], "toggle");
      return;
    }

    onClearSelection();
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
            const shownName = formattedContactName(contact, nameDisplay);
            const isMultiSelected = Boolean(contact.id && selectedContactIds.has(contact.id));
            const isActive = currentSelectedContactId === contact.id;
            const preferredEmail = primaryContactEmail(contact);
            const preferredPhone = contact.phone || contact.mobilePhone || contact.privatePhone || contact.secondPrivatePhone;
            const actionsOpen = openActionsContactId === contact.id;
            return (
              <div
                className={["contact-compact-row", isActive ? "selected" : "", isMultiSelected ? "multi-selected" : "", selectionActive ? "selection-mode" : ""].filter(Boolean).join(" ")}
                key={contact.id}
                role="option"
                aria-selected={isActive || isMultiSelected}
                tabIndex={0}
                onClick={(event) => selectRow(contact, event)}
                onFocus={() => {
                  setSelectedContactId(contact.id);
                }}
                onKeyDown={(event) => {
                  if (event.key === "Enter" || event.key === " ") {
                    event.preventDefault();
                    selectRow(contact, event);
                  }
                }}
                onPointerDown={(event) => startPointerDrag(event, contact)}
              >
                {selectionActive ? (
                  <span className={isMultiSelected ? "selection-dot checked" : "selection-dot"} aria-hidden="true">
                    {isMultiSelected ? "✓" : ""}
                  </span>
                ) : (
                  <span className={`contact-avatar avatar-${(contact.id ?? 0) % 6}`} aria-hidden="true">
                    {contactInitials(contact, nameDisplay)}
                  </span>
                )}
                <span className="contact-compact-copy">
                  <strong title={shownName}>{shownName}</strong>
                  <small title={preferredEmail || contact.company}>{preferredEmail || contact.company || "Keine E-Mail-Adresse"}</small>
                </span>
                <span className="contact-compact-phone" title={preferredPhone}>{preferredPhone || "–"}</span>
                {!selectionActive && (
                  <span className="contact-row-actions">
                    <button
                      className="contact-row-menu-button"
                      type="button"
                      aria-label={`Aktionen für ${shownName}`}
                      aria-expanded={actionsOpen}
                      aria-haspopup="menu"
                      onPointerDown={(event) => event.stopPropagation()}
                      onClick={(event) => {
                        event.stopPropagation();
                        if (contact.id !== undefined) toggleContactActions(contact.id, event.currentTarget, preferredEmail ? 3 : 1);
                      }}
                    >
                      <Ellipsis size={18} />
                    </button>
                    {actionsOpen && actionMenuPosition && createPortal(
                      <span
                        className="contact-row-menu"
                        role="menu"
                        style={{ left: actionMenuPosition.left, top: actionMenuPosition.top }}
                        onPointerDown={(event) => event.stopPropagation()}
                        onClick={(event) => event.stopPropagation()}
                      >
                        {preferredEmail && <button type="button" role="menuitem" onClick={() => { setOpenActionsContactId(undefined); setActionMenuPosition(null); onEmail(preferredEmail); }}><Mail size={16} /> Nachricht</button>}
                        {preferredEmail && <button type="button" role="menuitem" onClick={() => { setOpenActionsContactId(undefined); setActionMenuPosition(null); onCopyEmail(preferredEmail); }}><Copy size={16} /> E-Mail kopieren</button>}
                        <button className="danger" type="button" role="menuitem" onClick={() => { setOpenActionsContactId(undefined); setActionMenuPosition(null); onDelete(contact); }}><Trash2 size={16} /> Löschen</button>
                      </span>,
                      document.body
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
              const shownName = formattedContactName(contact, nameDisplay);
              const isMultiSelected = Boolean(contact.id && selectedContactIds.has(contact.id));
              const preferredEmail = primaryContactEmail(contact);
              return (
                <tr
                  key={contact.id}
                  className={[
                    currentSelectedContactId === contact.id ? "selected" : "",
                    isMultiSelected ? "multi-selected" : "",
                    selectionActive ? "selection-mode" : ""
                  ].filter(Boolean).join(" ")}
                  tabIndex={0}
                  onClick={(event) => selectRow(contact, event)}
                  onDoubleClick={() => {
                    if (!selectionActive) onEdit(contact);
                  }}
                  onFocus={() => {
                    setSelectedContactId(contact.id);
                  }}
                  onPointerDown={(event) => startPointerDrag(event, contact)}
                >
                  <td className="contact-primary" title={shownName}>
                    <div className="contact-name-content">
                      {selectionActive && (
                        <span className={isMultiSelected ? "selection-dot checked" : "selection-dot"} aria-hidden="true">
                          {isMultiSelected ? "✓" : ""}
                        </span>
                      )}
                      {managementView && (
                          <span className={`contact-avatar avatar-${(contact.id ?? 0) % 6}`} aria-hidden="true">
                            {contactInitials(contact, nameDisplay)}
                        </span>
                      )}
                      <span className="contact-name-text">
                        <strong>{shownName}</strong>
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
                      <button title={t.editContact} type="button" onClick={() => onEdit(contact)} disabled={selectionActive}>
                        <Edit size={16} />
                      </button>
                      {preferredEmail && (
                        <button title="E-Mail-Anwendung auswählen" type="button" onClick={() => onEmail(preferredEmail)} disabled={selectionActive}>
                          <Mail size={16} />
                        </button>
                      )}
                      <button title={t.deleteContact} type="button" onClick={() => onDelete(contact)} disabled={selectionActive}>
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
