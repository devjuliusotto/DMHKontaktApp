import { CalendarDays, FolderClosed, KeyRound, RotateCcw, Trash2, Users } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { ConfirmDialog } from "../components/ConfirmDialog";
import { ActionResultDialog, type ActionResult } from "../components/ActionResultDialog";
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
  { value: "all", label: "Alles in dieser Ansicht", description: "alle Elemente in dieser Ansicht" },
  { value: "year", label: "Älter als 1 Jahr", description: "Elemente, die älter als 1 Jahr sind" },
  { value: "six-months", label: "Älter als 6 Monate", description: "Elemente, die älter als 6 Monate sind" },
  { value: "month", label: "Älter als 1 Monat", description: "Elemente, die älter als 1 Monat sind" },
  { value: "week", label: "Älter als 1 Woche", description: "Elemente, die älter als 1 Woche sind" },
  { value: "day", label: "Älter als 1 Tag", description: "Elemente, die älter als 1 Tag sind" },
  { value: "hour", label: "Älter als 1 Stunde", description: "Elemente, die älter als 1 Stunde sind" }
];

const trashCategoryLabels: Record<TrashCategory, string> = {
  calendar: "Termine",
  contacts: "Kontakte",
  groups: "Gruppen",
  passwords: "Passwörter",
  totp: "2FA-Codes"
};

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
  const [actionResult, setActionResult] = useState<ActionResult | null>(null);
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
    const candidates = category === "calendar"
      ? deletedEvents
      : category === "contacts"
        ? deletedContacts
        : category === "groups"
          ? [...deletedGroups, ...(deletedCollectedAddressesAt ? [{ deletedAt: deletedCollectedAddressesAt }] : [])]
          : category === "passwords"
            ? deletedPasswords
            : deletedTotpEntries;
    const eligible = candidates.filter((entry) => wasDeletedBefore(entry.deletedAt, cutoff));
    const vaultEntryIds = (category === "passwords" || category === "totp")
      ? (eligible as VaultEntry[]).map((entry) => entry.id)
      : [];
    const period = trashPurgePeriods.find((entry) => entry.value === purgePeriod) ?? trashPurgePeriods[0];
    return { cutoff, count: eligible.length, period, vaultEntryIds };
  }, [category, deletedCollectedAddressesAt, deletedContacts, deletedEvents, deletedGroups, deletedPasswords, deletedTotpEntries, purgePeriod]);

  const refresh = async () => {
    setDeletedEvents(readCalendarEvents(calendarTrashStorageKey));
    if (!("__TAURI_INTERNALS__" in window)) {
      setDeletedContacts([]);
      setDeletedGroups([]);
      setDeletedVaultEntries([]);
      setDeletedCollectedAddressesAt(null);
      return;
    }
    const [contacts, groups, vaultEntries, collectedAddressesDeletedAt] = await Promise.all([
      listDeletedContacts(),
      listDeletedGroups(),
      listDeletedVaultEntries(),
      getAppSetting(collectedAddressesDeletedAtSettingKey)
    ]);
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
    setActionResult({ title: "Termin wiederhergestellt", summary: `„${event.title || "Ohne Titel"}“ ist wieder im Kalender.`, items: [{ label: event.title || "Ohne Titel", detail: formatCalendarDate(event.startsAt) }], itemsLabel: "Wiederhergestellten Termin anzeigen", tone: "success" });
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
    setActionResult({ title: "Kontakt wiederhergestellt", summary: `„${displayName(contact)}“ ist wieder bei Ihren Kontakten.`, items: [{ label: displayName(contact), detail: contact.email || contact.phone || undefined }], itemsLabel: "Wiederhergestellten Kontakt anzeigen", tone: "success" });
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
    const restoredContacts = deletedContacts.filter((contact) => contact.id && selectedDeletedContactIds.includes(contact.id));
    await Promise.all(selectedDeletedContactIds.map((contactId) => restoreContact(contactId)));
    setActionResult({ title: "Kontakte wiederhergestellt", summary: `${selectedDeletedContactIds.length} Kontakte sind wieder verfügbar.`, items: restoredContacts.map((contact) => ({ label: displayName(contact), detail: contact.email || contact.phone || undefined })), itemsLabel: `${selectedDeletedContactIds.length} wiederhergestellte Kontakte anzeigen`, tone: "success" });
    setSelectedContactIds(new Set());
    setContactSelectionMode(false);
    await refresh();
    window.dispatchEvent(new Event(calendarChangedEventName));
  };

  const restoreAllDeletedContacts = async () => {
    if (deletedContactIds.length === 0) return;
    await Promise.all(deletedContactIds.map((contactId) => restoreContact(contactId)));
    setActionResult({ title: "Kontakte wiederhergestellt", summary: `${deletedContactIds.length} Kontakte sind wieder verfügbar.`, items: deletedContacts.map((contact) => ({ label: displayName(contact), detail: contact.email || contact.phone || undefined })), itemsLabel: `${deletedContactIds.length} wiederhergestellte Kontakte anzeigen`, tone: "success" });
    setSelectedContactIds(new Set());
    setContactSelectionMode(false);
    await refresh();
    window.dispatchEvent(new Event(calendarChangedEventName));
  };

  const restoreDeletedGroup = async (group: Group) => {
    if (!group.id) return;
    await restoreGroup(group.id);
    setActionResult({ title: "Gruppe wiederhergestellt", summary: `„${group.name}“ ist wieder verfügbar.`, tone: "success" });
    await refresh();
    window.dispatchEvent(new Event(calendarChangedEventName));
  };

  const restoreCollectedAddresses = async () => {
    await setAppSetting(collectedAddressesHiddenSettingKey, "false");
    await setAppSetting(collectedAddressesDeletedAtSettingKey, "");
    setDeletedCollectedAddressesAt(null);
    setActionResult({ title: "Gruppe wiederhergestellt", summary: "„Gesammelte Adressen“ ist wieder verfügbar.", tone: "success" });
    window.dispatchEvent(new Event(calendarChangedEventName));
  };

  const restoreDeletedPassword = async (entry: VaultEntry) => {
    await restoreVaultEntry(entry.id);
    setActionResult({ title: entry.kind === "totp" ? "2FA-Code wiederhergestellt" : "Passwort wiederhergestellt", summary: `„${entry.platform || entry.username || "Eintrag"}“ ist wieder verfügbar.`, tone: "success" });
    await refresh();
  };

  const permanentlyDeleteTrash = async () => {
    if (purgePreview.count === 0) return;
    setPurging(true);
    try {
      const purgeCollectedAddresses = category === "groups"
        && Boolean(deletedCollectedAddressesAt)
        && wasDeletedBefore(deletedCollectedAddressesAt, purgePreview.cutoff);
      const purgedEvents = category === "calendar"
        ? deletedEvents.filter((event) => wasDeletedBefore(event.deletedAt, purgePreview.cutoff))
        : [];
      const result = "__TAURI_INTERNALS__" in window
        ? await purgeDeletedItems(
          purgePreview.cutoff ?? undefined,
          purgedEvents.map((event) => event.id),
          purgeCollectedAddresses,
          category,
          purgePreview.vaultEntryIds
        )
        : { contacts: 0, groups: 0, vaultEntries: 0 };
      if (purgeCollectedAddresses && deletedCollectedAddressesAt && "__TAURI_INTERNALS__" in window) {
        await setAppSetting(collectedAddressesDeletedAtSettingKey, "");
      }
      const remainingEvents = category === "calendar"
        ? deletedEvents.filter((event) => !wasDeletedBefore(event.deletedAt, purgePreview.cutoff))
        : deletedEvents;
      const removedEvents = deletedEvents.length - remainingEvents.length;
      if (category === "calendar") writeCalendarEvents(calendarTrashStorageKey, remainingEvents);
      const removed = removedEvents + result.contacts + result.groups + result.vaultEntries + (purgeCollectedAddresses && deletedCollectedAddressesAt ? 1 : 0);
      setSelectedContactIds(new Set());
      setContactSelectionMode(false);
      setConfirmPurge(false);
      setShowPurgeOptions(false);
      const affected = category === "calendar"
        ? purgedEvents.map((event) => ({ label: event.title || "Ohne Titel", detail: formatCalendarDate(event.startsAt) }))
        : category === "contacts"
          ? deletedContacts.filter((contact) => wasDeletedBefore(contact.deletedAt, purgePreview.cutoff)).map((contact) => ({ label: displayName(contact), detail: contact.email || contact.phone || undefined }))
          : category === "groups"
            ? deletedGroups.filter((group) => wasDeletedBefore(group.deletedAt, purgePreview.cutoff)).map((group) => ({ label: group.name }))
            : (category === "passwords" ? deletedPasswords : deletedTotpEntries).filter((entry) => wasDeletedBefore(entry.deletedAt, purgePreview.cutoff)).map((entry) => ({ label: entry.platform || entry.username || "Eintrag", detail: entry.username || undefined }));
      if (purgeCollectedAddresses) affected.push({ label: "Gesammelte Adressen" });
      setActionResult({
        title: "Papierkorb endgültig geleert",
        summary: `${removed} ${removed === 1 ? "Eintrag wurde" : "Einträge wurden"} endgültig gelöscht und können nicht wiederhergestellt werden.`,
        items: affected,
        itemsLabel: `${removed} endgültig gelöschte Einträge anzeigen`,
        tone: "success"
      });
      await refresh();
      window.dispatchEvent(new Event(calendarChangedEventName));
    } catch (error) {
      setActionResult({ title: "Papierkorb nicht geleert", summary: `${trashCategoryLabels[category]} wurden nicht endgültig gelöscht: ${error}`, tone: "error" });
    } finally {
      setPurging(false);
    }
  };

  const selectCategory = (nextCategory: TrashCategory) => {
    setCategory(nextCategory);
    setShowPurgeOptions(false);
    setConfirmPurge(false);
    setPurgePeriod("all");
  };

  const categoryCount = category === "calendar"
    ? deletedEvents.length
    : category === "contacts"
      ? deletedContacts.length
      : category === "groups"
        ? deletedGroups.length + (deletedCollectedAddressesAt ? 1 : 0)
        : category === "passwords"
          ? deletedPasswords.length
          : deletedTotpEntries.length;

  const purgeControls = showPurgeOptions && (
    <div className="trash-purge-panel" id="trash-purge-options">
      <div>
        <h4>{trashCategoryLabels[category]} endgültig löschen</h4>
        <p>Nur diese Ansicht wird gelöscht. Andere Bereiche bleiben unverändert.</p>
      </div>
      <label className="trash-purge-period" htmlFor="trash-purge-period">
        <span>Welche löschen?</span>
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
    </div>
  );

  const purgeButton = (
    <button
      className="danger-button trash-category-delete"
      type="button"
      disabled={categoryCount === 0}
      aria-expanded={showPurgeOptions}
      aria-controls="trash-purge-options"
      onClick={() => setShowPurgeOptions((visible) => !visible)}
    >
      <Trash2 size={18} /> {trashCategoryLabels[category]} löschen
    </button>
  );

  return (
    <div className="page trash-page-clean">
      <header className="page-header">
        <div>
          <h2>Papierkorb</h2>
          <p>Gelöschte Elemente wiederherstellen oder endgültig entfernen.</p>
        </div>
      </header>
      <StatusMessage message={message} />
      <ActionResultDialog result={actionResult} onClose={() => setActionResult(null)} />
      <nav className="trash-category-grid" aria-label="Bereiche im Papierkorb">
        <button className={category === "calendar" ? "active" : ""} type="button" onClick={() => selectCategory("calendar")}>
          <CalendarDays size={22} /><span><strong>Termine</strong><small>{deletedEvents.length}</small></span>
        </button>
        <button className={category === "contacts" ? "active" : ""} type="button" onClick={() => selectCategory("contacts")}>
          <Users size={22} /><span><strong>Kontakte</strong><small>{deletedContacts.length}</small></span>
        </button>
        <button className={category === "groups" ? "active" : ""} type="button" onClick={() => selectCategory("groups")}>
          <FolderClosed size={22} /><span><strong>Gruppen</strong><small>{deletedGroups.length + (deletedCollectedAddressesAt ? 1 : 0)}</small></span>
        </button>
        <button className={category === "passwords" ? "active" : ""} type="button" onClick={() => selectCategory("passwords")}>
          <KeyRound size={22} /><span><strong>Passwörter</strong><small>{deletedPasswords.length}</small></span>
        </button>
        <button className={category === "totp" ? "active" : ""} type="button" onClick={() => selectCategory("totp")}>
          <KeyRound size={22} /><span><strong>2FA-Codes</strong><small>{deletedTotpEntries.length}</small></span>
        </button>
      </nav>

      <section className="trash-panel trash-content-panel">
          {category === "calendar" && <section className="trash-section">
            <div className="trash-section-heading">
              <div className="trash-section-title"><CalendarDays size={21} /><h3>Gelöschte Termine</h3></div>
              {purgeButton}
            </div>
            {purgeControls}
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
                {purgeButton}
              </div>
            </div>
            {purgeControls}
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
            <div className="trash-section-heading">
              <div className="trash-section-title"><FolderClosed size={21} /><h3>Gelöschte Gruppen</h3></div>
              {purgeButton}
            </div>
            {purgeControls}
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
            <div className="trash-section-heading">
              <div className="trash-section-title"><KeyRound size={21} /><h3>{category === "totp" ? "Gelöschte 2FA-Codes" : "Gelöschte Passwörter"}</h3></div>
              {purgeButton}
            </div>
            {purgeControls}
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
        title={`${trashCategoryLabels[category]} endgültig löschen?`}
        message={`${purgePreview.count} ${purgePreview.count === 1 ? "Element" : "Elemente"} aus „${trashCategoryLabels[category]}“ werden endgültig gelöscht (${purgePreview.period.description}). Andere Bereiche bleiben unverändert. Dies kann nicht rückgängig gemacht werden.`}
        confirmLabel="Endgültig löschen"
        busy={purging}
        busyLabel="Wird gelöscht …"
        onConfirm={permanentlyDeleteTrash}
        onCancel={() => setConfirmPurge(false)}
      />
    </div>
  );
}
