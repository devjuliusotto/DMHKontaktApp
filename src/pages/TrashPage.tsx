import { CalendarDays, FolderClosed, KeyRound, RotateCcw, Users } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { StatusMessage } from "../components/StatusMessage";
import {
  listDeletedContacts,
  listDeletedGroups,
  listDeletedVaultEntries,
  restoreContact,
  restoreGroup,
  restoreVaultEntry
} from "../services/db";
import type { CalendarEvent } from "../types/calendar";
import type { Contact, Group } from "../types/contact";
import type { VaultEntry } from "../types/vault";
import { calendarStorageKey, calendarTrashStorageKey, formatCalendarDate } from "../utils/calendar";
import { displayName } from "../utils/contact";
import { calendarChangedEventName } from "../utils/automaticCalendarSync";

function readCalendarEvents(key: string): CalendarEvent[] {
  try {
    const value = JSON.parse(localStorage.getItem(key) ?? "[]") as CalendarEvent[];
    return Array.isArray(value) ? value : [];
  } catch {
    return [];
  }
}

function writeCalendarEvents(key: string, events: CalendarEvent[]) {
  localStorage.setItem(key, JSON.stringify(events));
}

type TrashCategory = "calendar" | "contacts" | "groups" | "passwords" | "totp";

export function TrashPage() {
  const [deletedEvents, setDeletedEvents] = useState<CalendarEvent[]>([]);
  const [deletedContacts, setDeletedContacts] = useState<Contact[]>([]);
  const [deletedGroups, setDeletedGroups] = useState<Group[]>([]);
  const [deletedVaultEntries, setDeletedVaultEntries] = useState<VaultEntry[]>([]);
  const [message, setMessage] = useState("");
  const [category, setCategory] = useState<TrashCategory>("calendar");
  const [contactSelectionMode, setContactSelectionMode] = useState(false);
  const [selectedContactIds, setSelectedContactIds] = useState<Set<number>>(() => new Set());

  const deletedContactIds = useMemo(
    () => deletedContacts.map((contact) => contact.id).filter((id): id is number => Boolean(id)),
    [deletedContacts]
  );

  const selectedDeletedContactIds = useMemo(
    () => deletedContactIds.filter((contactId) => selectedContactIds.has(contactId)),
    [deletedContactIds, selectedContactIds]
  );

  const deletedPasswords = useMemo(
    () => deletedVaultEntries.filter((entry) => entry.kind !== "totp"),
    [deletedVaultEntries]
  );

  const deletedTotpEntries = useMemo(
    () => deletedVaultEntries.filter((entry) => entry.kind === "totp"),
    [deletedVaultEntries]
  );

  const allDeletedContactsSelected = deletedContactIds.length > 0 && selectedDeletedContactIds.length === deletedContactIds.length;

  const refresh = async () => {
    const [contacts, groups, vaultEntries] = await Promise.all([
      listDeletedContacts(),
      listDeletedGroups(),
      listDeletedVaultEntries()
    ]);
    setDeletedEvents(readCalendarEvents(calendarTrashStorageKey));
    setDeletedContacts(contacts);
    setDeletedGroups(groups);
    setDeletedVaultEntries(vaultEntries);
  };

  useEffect(() => {
    refresh().catch((error) => setMessage(`Papierkorb konnte nicht geladen werden: ${error}`));
  }, []);

  const restoreDeletedEvent = (event: CalendarEvent) => {
    const activeEvents = readCalendarEvents(calendarStorageKey).filter((entry) => entry.id !== event.id);
    const restored = { ...event, deletedAt: null };
    writeCalendarEvents(
      calendarStorageKey,
      [...activeEvents, restored].sort((left, right) => left.startsAt.localeCompare(right.startsAt))
    );
    const remaining = deletedEvents.filter((entry) => entry.id !== event.id);
    writeCalendarEvents(calendarTrashStorageKey, remaining);
    setDeletedEvents(remaining);
    setMessage("Termin wurde wiederhergestellt.");
    window.dispatchEvent(new Event(calendarChangedEventName));
  };

  const restoreDeletedContact = async (contact: Contact) => {
    if (!contact.id) return;
    await restoreContact(contact.id);
    setSelectedContactIds((current) => {
      const next = new Set(current);
      next.delete(contact.id!);
      return next;
    });
    setMessage("Kontakt wurde wiederhergestellt.");
    await refresh();
    window.dispatchEvent(new Event(calendarChangedEventName));
  };

  const toggleContactSelectionMode = () => {
    setContactSelectionMode((enabled) => {
      if (enabled) setSelectedContactIds(new Set());
      return !enabled;
    });
  };

  const toggleContactSelection = (contact: Contact) => {
    if (!contact.id) return;
    setSelectedContactIds((current) => {
      const next = new Set(current);
      if (next.has(contact.id!)) next.delete(contact.id!);
      else next.add(contact.id!);
      return next;
    });
  };

  const toggleSelectAllDeletedContacts = () => {
    setSelectedContactIds((current) => {
      const next = new Set(current);
      if (allDeletedContactsSelected) {
        for (const contactId of deletedContactIds) next.delete(contactId);
      } else {
        for (const contactId of deletedContactIds) next.add(contactId);
      }
      return next;
    });
  };

  const restoreSelectedContacts = async () => {
    if (selectedDeletedContactIds.length === 0) return;
    await Promise.all(selectedDeletedContactIds.map((contactId) => restoreContact(contactId)));
    setMessage(`${selectedDeletedContactIds.length} Kontakte wurden wiederhergestellt.`);
    setSelectedContactIds(new Set());
    setContactSelectionMode(false);
    await refresh();
    window.dispatchEvent(new Event(calendarChangedEventName));
  };

  const restoreAllDeletedContacts = async () => {
    if (deletedContactIds.length === 0) return;
    await Promise.all(deletedContactIds.map((contactId) => restoreContact(contactId)));
    setMessage(`${deletedContactIds.length} Kontakte wurden wiederhergestellt.`);
    setSelectedContactIds(new Set());
    setContactSelectionMode(false);
    await refresh();
    window.dispatchEvent(new Event(calendarChangedEventName));
  };

  const restoreDeletedGroup = async (group: Group) => {
    if (!group.id) return;
    await restoreGroup(group.id);
    setMessage("Gruppe wurde wiederhergestellt.");
    await refresh();
    window.dispatchEvent(new Event(calendarChangedEventName));
  };

  const restoreDeletedPassword = async (entry: VaultEntry) => {
    await restoreVaultEntry(entry.id);
    setMessage(entry.kind === "totp" ? "2FA-Eintrag wurde wiederhergestellt." : "Passwort wurde wiederhergestellt.");
    await refresh();
  };

  return (
    <div className="page trash-page-clean">
      <header className="page-header">
        <div>
          <h2>Papierkorb</h2>
          <p>Wählen Sie einen Bereich aus.</p>
        </div>
      </header>
      <StatusMessage message={message} />
      <nav className="trash-category-grid" aria-label="Bereiche im Papierkorb">
        <button className={category === "calendar" ? "active" : ""} type="button" onClick={() => setCategory("calendar")}>
          <CalendarDays size={22} /><span><strong>Termine</strong><small>{deletedEvents.length}</small></span>
        </button>
        <button className={category === "contacts" ? "active" : ""} type="button" onClick={() => setCategory("contacts")}>
          <Users size={22} /><span><strong>Kontakte</strong><small>{deletedContacts.length}</small></span>
        </button>
        <button className={category === "groups" ? "active" : ""} type="button" onClick={() => setCategory("groups")}>
          <FolderClosed size={22} /><span><strong>Gruppen</strong><small>{deletedGroups.length}</small></span>
        </button>
        <button className={category === "passwords" ? "active" : ""} type="button" onClick={() => setCategory("passwords")}>
          <KeyRound size={22} /><span><strong>Passwörter</strong><small>{deletedPasswords.length}</small></span>
        </button>
        <button className={category === "totp" ? "active" : ""} type="button" onClick={() => setCategory("totp")}>
          <KeyRound size={22} /><span><strong>2FA-Codes</strong><small>{deletedTotpEntries.length}</small></span>
        </button>
      </nav>

      <section className="trash-panel trash-content-panel">
          {category === "calendar" && <section className="trash-section">
            <div className="trash-section-title"><CalendarDays size={21} /><h3>Gelöschte Termine</h3></div>
            {deletedEvents.length === 0 && <p>Keine gelöschten Termine.</p>}
            {deletedEvents.map((event) => (
              <div className="trash-row" key={event.id}>
                <span><strong>{event.title}</strong><small>{formatCalendarDate(event.startsAt)}</small></span>
                <button type="button" onClick={() => restoreDeletedEvent(event)}>
                  <RotateCcw size={18} /> Wiederherstellen
                </button>
              </div>
            ))}
          </section>}

          {category === "contacts" && <section className="trash-section">
            <div className="trash-section-heading">
              <div className="trash-section-title"><Users size={21} /><h3>Gelöschte Kontakte</h3></div>
              <div className="button-row">
                <button type="button" onClick={toggleContactSelectionMode} disabled={deletedContacts.length === 0}>
                  {contactSelectionMode ? "Fertig" : "Auswählen"}
                </button>
                <button type="button" onClick={restoreAllDeletedContacts} disabled={deletedContactIds.length === 0}>
                  Alle wiederherstellen
                </button>
              </div>
            </div>
            {contactSelectionMode && (
              <div className="trash-selection-toolbar">
                <button type="button" onClick={toggleSelectAllDeletedContacts} disabled={deletedContactIds.length === 0}>
                  {allDeletedContactsSelected ? "Auswahl aufheben" : "Alle auswählen"}
                </button>
                <button className="primary" type="button" onClick={restoreSelectedContacts} disabled={selectedDeletedContactIds.length === 0}>
                  Ausgewählte wiederherstellen
                </button>
                <span className="selection-count">{selectedDeletedContactIds.length} ausgewählt</span>
              </div>
            )}
            {deletedContacts.length === 0 && <p>Keine gelöschten Kontakte.</p>}
            {deletedContacts.map((contact) => (
              <div className={contact.id && selectedContactIds.has(contact.id) ? "trash-row selected" : "trash-row"} key={contact.id}>
                <span className="trash-contact-name">
                  {contactSelectionMode && (
                    <input
                      aria-label={`${displayName(contact)} auswählen`}
                      checked={Boolean(contact.id && selectedContactIds.has(contact.id))}
                      onChange={() => toggleContactSelection(contact)}
                      type="checkbox"
                    />
                  )}
                  {displayName(contact)}
                </span>
                <button type="button" onClick={() => restoreDeletedContact(contact)}>
                  <RotateCcw size={18} /> Wiederherstellen
                </button>
              </div>
            ))}
          </section>}

          {category === "groups" && <section className="trash-section">
            <div className="trash-section-title"><FolderClosed size={21} /><h3>Gelöschte Gruppen</h3></div>
            {deletedGroups.length === 0 && <p>Keine gelöschten Gruppen.</p>}
            {deletedGroups.map((group) => (
              <div className="trash-row" key={group.id}>
                <span>{group.name}</span>
                <button type="button" onClick={() => restoreDeletedGroup(group)}>
                  <RotateCcw size={18} /> Wiederherstellen
                </button>
              </div>
            ))}
          </section>}

          {(category === "passwords" || category === "totp") && <section className="trash-section">
            <div className="trash-section-title"><KeyRound size={21} /><h3>{category === "totp" ? "Gelöschte 2FA-Codes" : "Gelöschte Passwörter"}</h3></div>
            {(category === "totp" ? deletedTotpEntries : deletedPasswords).length === 0 && <p>{category === "totp" ? "Keine gelöschten 2FA-Codes." : "Keine gelöschten Passwörter."}</p>}
            {(category === "totp" ? deletedTotpEntries : deletedPasswords).map((entry) => (
              <div className="trash-row" key={entry.id}>
                <span><strong>{entry.platform}</strong><small>{entry.kind === "totp" ? "2FA-Authenticator" : entry.username || "Kein Benutzer"}</small></span>
                <button type="button" onClick={() => restoreDeletedPassword(entry)}>
                  <RotateCcw size={18} /> Wiederherstellen
                </button>
              </div>
            ))}
          </section>}
      </section>
    </div>
  );
}
