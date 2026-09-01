import { CalendarDays, FolderClosed, KeyRound, RotateCcw, Trash2, Users } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { ConfirmDialog } from "../components/ConfirmDialog";
import { StatusMessage } from "../components/StatusMessage";
import {
  getAppSetting,
  listDeletedContacts,
  listDeletedGroups,
  listDeletedVaultEntries,
  purgeDeletedItems,
  restoreContact,
  restoreGroup,
  restoreVaultEntry,
  setAppSetting
} from "../services/db";
import type { CalendarEvent } from "../types/calendar";
import type { Contact, Group } from "../types/contact";
import type { VaultEntry } from "../types/vault";
import { calendarStorageKey, calendarTrashStorageKey, formatCalendarDate } from "../utils/calendar";
import { collectedAddressesDeletedAtSettingKey, collectedAddressesHiddenSettingKey, displayName } from "../utils/contact";
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
type TrashPurgePeriod = "all" | "year" | "six-months" | "month" | "week" | "day" | "hour";

const trashPurgePeriods: Array<{ value: TrashPurgePeriod; label: string; description: string }> = [
  { value: "all", label: "Gesamten Papierkorb", description: "alle gelöschten Elemente" },
  { value: "year", label: "Älter als 1 Jahr", description: "Elemente, die älter als 1 Jahr sind" },
  { value: "six-months", label: "Älter als 6 Monate", description: "Elemente, die älter als 6 Monate sind" },
  { value: "month", label: "Älter als 1 Monat", description: "Elemente, die älter als 1 Monat sind" },
  { value: "week", label: "Älter als 1 Woche", description: "Elemente, die älter als 1 Woche sind" },
  { value: "day", label: "Älter als 1 Tag", description: "Elemente, die älter als 1 Tag sind" },
  { value: "hour", label: "Älter als 1 Stunde", description: "Elemente, die älter als 1 Stunde sind" }
];

function cutoffForPeriod(period: TrashPurgePeriod): string | null {
  if (period === "all") return null;
  const cutoff = new Date();
  const calendarMonths = period === "year" ? 12 : period === "six-months" ? 6 : period === "month" ? 1 : 0;
  if (calendarMonths > 0) {
    const day = cutoff.getUTCDate();
    cutoff.setUTCDate(1);
    cutoff.setUTCMonth(cutoff.getUTCMonth() - calendarMonths);
    const lastDay = new Date(Date.UTC(cutoff.getUTCFullYear(), cutoff.getUTCMonth() + 1, 0)).getUTCDate();
    cutoff.setUTCDate(Math.min(day, lastDay));
  } else if (period === "week") cutoff.setTime(cutoff.getTime() - 7 * 24 * 60 * 60 * 1000);
  else if (period === "day") cutoff.setTime(cutoff.getTime() - 24 * 60 * 60 * 1000);
  else cutoff.setTime(cutoff.getTime() - 60 * 60 * 1000);
  return cutoff.toISOString();
}

function wasDeletedBefore(deletedAt: string | null | undefined, cutoff: string | null): boolean {
  if (cutoff === null) return true;
  if (!deletedAt) return false;
  const deletedTimestamp = Date.parse(deletedAt);
  return Number.isFinite(deletedTimestamp) && deletedTimestamp <= Date.parse(cutoff);
}

export function TrashPage() {
  const [deletedEvents, setDeletedEvents] = useState<CalendarEvent[]>([]);
  const [deletedContacts, setDeletedContacts] = useState<Contact[]>([]);
  const [deletedGroups, setDeletedGroups] = useState<Group[]>([]);
  const [deletedVaultEntries, setDeletedVaultEntries] = useState<VaultEntry[]>([]);
  const [deletedCollectedAddressesAt, setDeletedCollectedAddressesAt] = useState<string | null>(null);
  const [message, setMessage] = useState("");
  const [category, setCategory] = useState<TrashCategory>("calendar");
  const [contactSelectionMode, setContactSelectionMode] = useState(false);
  const [selectedContactIds, setSelectedContactIds] = useState<Set<number>>(() => new Set());
  const [showPurgeOptions, setShowPurgeOptions] = useState(false);
  const [purgePeriod, setPurgePeriod] = useState<TrashPurgePeriod>("all");
  const [confirmPurge, setConfirmPurge] = useState(false);
  const [purging, setPurging] = useState(false);

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

  const purgePreview = useMemo(() => {
    const cutoff = cutoffForPeriod(purgePeriod);
    const count = [
      ...deletedEvents,
      ...deletedContacts,
      ...deletedGroups,
      ...deletedVaultEntries,
      ...(deletedCollectedAddressesAt ? [{ deletedAt: deletedCollectedAddressesAt }] : [])
    ].filter((entry) => wasDeletedBefore(entry.deletedAt, cutoff)).length;
    const period = trashPurgePeriods.find((entry) => entry.value === purgePeriod) ?? trashPurgePeriods[0];
    return { cutoff, count, period };
  }, [deletedCollectedAddressesAt, deletedContacts, deletedEvents, deletedGroups, deletedVaultEntries, purgePeriod]);

  const refresh = async () => {
    const [contacts, groups, vaultEntries, collectedAddressesDeletedAt] = await Promise.all([
      listDeletedContacts(),
      listDeletedGroups(),
      listDeletedVaultEntries(),
      getAppSetting(collectedAddressesDeletedAtSettingKey)
    ]);
    setDeletedEvents(readCalendarEvents(calendarTrashStorageKey));
    setDeletedContacts(contacts);
    setDeletedGroups(groups);
    setDeletedVaultEntries(vaultEntries);
    setDeletedCollectedAddressesAt(collectedAddressesDeletedAt || null);
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

  const restoreCollectedAddresses = async () => {
    await setAppSetting(collectedAddressesHiddenSettingKey, "false");
    await setAppSetting(collectedAddressesDeletedAtSettingKey, "");
    setDeletedCollectedAddressesAt(null);
    setMessage("Gruppe wurde wiederhergestellt.");
    window.dispatchEvent(new Event(calendarChangedEventName));
  };

  const restoreDeletedPassword = async (entry: VaultEntry) => {
    await restoreVaultEntry(entry.id);
    setMessage(entry.kind === "totp" ? "2FA-Eintrag wurde wiederhergestellt." : "Passwort wurde wiederhergestellt.");
    await refresh();
  };

  const permanentlyDeleteTrash = async () => {
    if (purgePreview.count === 0) return;
    setPurging(true);
    try {
      const purgeCollectedAddresses = wasDeletedBefore(deletedCollectedAddressesAt, purgePreview.cutoff);
      const purgedEvents = deletedEvents.filter((event) =>
        wasDeletedBefore(event.deletedAt, purgePreview.cutoff)
      );
      const result = await purgeDeletedItems(
        purgePreview.cutoff ?? undefined,
        purgedEvents.map((event) => event.id),
        purgeCollectedAddresses && Boolean(deletedCollectedAddressesAt)
      );
      if (purgeCollectedAddresses && deletedCollectedAddressesAt) {
        await setAppSetting(collectedAddressesDeletedAtSettingKey, "");
      }
      const remainingEvents = deletedEvents.filter(
        (event) => !wasDeletedBefore(event.deletedAt, purgePreview.cutoff)
      );
      const removedEvents = deletedEvents.length - remainingEvents.length;
      writeCalendarEvents(calendarTrashStorageKey, remainingEvents);
      const removed = removedEvents + result.contacts + result.groups + result.vaultEntries + (purgeCollectedAddresses && deletedCollectedAddressesAt ? 1 : 0);
      setSelectedContactIds(new Set());
      setContactSelectionMode(false);
      setConfirmPurge(false);
      setShowPurgeOptions(false);
      setMessage(`${removed} ${removed === 1 ? "Element wurde" : "Elemente wurden"} endgültig gelöscht.`);
      await refresh();
      window.dispatchEvent(new Event(calendarChangedEventName));
    } catch (error) {
      setMessage(`Der Papierkorb konnte nicht geleert werden: ${error}`);
    } finally {
      setPurging(false);
    }
  };

  return (
    <div className="page trash-page-clean">
      <header className="page-header">
        <div>
          <h2>Papierkorb</h2>
          <p>Wählen Sie einen Bereich aus.</p>
        </div>
        <button
          className="danger-button"
          type="button"
          aria-expanded={showPurgeOptions}
          aria-controls="trash-purge-options"
          onClick={() => setShowPurgeOptions((visible) => !visible)}
        >
          <Trash2 size={19} /> Endgültig löschen
        </button>
      </header>
      <StatusMessage message={message} />
      {showPurgeOptions && (
        <section className="form-panel trash-purge-panel" id="trash-purge-options">
          <div>
            <h3>Papierkorb leeren</h3>
            <p>Zeitraum auswählen. Dies gilt für alle Bereiche.</p>
          </div>
          <label className="trash-purge-period" htmlFor="trash-purge-period">
            <span>Löschen</span>
            <select
              id="trash-purge-period"
              value={purgePeriod}
              onChange={(event) => setPurgePeriod(event.target.value as TrashPurgePeriod)}
            >
              {trashPurgePeriods.map((period) => (
                <option key={period.value} value={period.value}>{period.label}</option>
              ))}
            </select>
          </label>
          <strong>{purgePreview.count} {purgePreview.count === 1 ? "Element" : "Elemente"}</strong>
          <div className="button-row">
            <button type="button" onClick={() => setShowPurgeOptions(false)}>Abbrechen</button>
            <button className="danger-button" type="button" disabled={purgePreview.count === 0} onClick={() => setConfirmPurge(true)}>
              <Trash2 size={18} /> Löschen
            </button>
          </div>
        </section>
      )}
      <nav className="trash-category-grid" aria-label="Bereiche im Papierkorb">
        <button className={category === "calendar" ? "active" : ""} type="button" onClick={() => setCategory("calendar")}>
          <CalendarDays size={22} /><span><strong>Termine</strong><small>{deletedEvents.length}</small></span>
        </button>
        <button className={category === "contacts" ? "active" : ""} type="button" onClick={() => setCategory("contacts")}>
          <Users size={22} /><span><strong>Kontakte</strong><small>{deletedContacts.length}</small></span>
        </button>
        <button className={category === "groups" ? "active" : ""} type="button" onClick={() => setCategory("groups")}>
          <FolderClosed size={22} /><span><strong>Gruppen</strong><small>{deletedGroups.length + (deletedCollectedAddressesAt ? 1 : 0)}</small></span>
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
            {deletedGroups.length === 0 && !deletedCollectedAddressesAt && <p>Keine gelöschten Gruppen.</p>}
            {deletedCollectedAddressesAt && (
              <div className="trash-row">
                <span>Gesammelte Adressen</span>
                <button type="button" onClick={() => void restoreCollectedAddresses()}>
                  <RotateCcw size={18} /> Wiederherstellen
                </button>
              </div>
            )}
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
      <ConfirmDialog
        open={confirmPurge}
        title="Endgültig löschen?"
        message={`${purgePreview.count} ${purgePreview.count === 1 ? "Element" : "Elemente"} werden endgültig gelöscht (${purgePreview.period.description}). Dies kann nicht rückgängig gemacht werden.`}
        confirmLabel="Endgültig löschen"
        busy={purging}
        busyLabel="Wird gelöscht …"
        onConfirm={permanentlyDeleteTrash}
        onCancel={() => setConfirmPurge(false)}
      />
    </div>
  );
}
