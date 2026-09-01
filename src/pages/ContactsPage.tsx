import { writeText } from "@tauri-apps/plugin-clipboard-manager";
import { Ellipsis, Inbox, Mail, Minus, Pencil, Plus, Search, Settings2, Trash2, UserPlus, UsersRound, X } from "lucide-react";
import { type FormEvent, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ContactForm } from "../components/ContactForm";
import { ContactTable } from "../components/ContactTable";
import { ConfirmDialog } from "../components/ConfirmDialog";
import { StatusMessage } from "../components/StatusMessage";
import { t } from "../i18n";
import {
  clearContactGroups,
  deleteAllContacts,
  deleteContact,
  deleteContacts,
  deleteGroup,
  getAppSetting,
  listContacts,
  listGroups,
  moveContactToGroup,
  openNewOutlookBulkEmail,
  openNewOutlookEmail,
  openOutlookClassicBulkEmail,
  openOutlookClassicEmail,
  saveContact,
  saveGroup,
  setAppSetting
} from "../services/db";
import type { Contact, ContactInput, Group } from "../types/contact";
import { collectedAddressesDeletedAtSettingKey, collectedAddressesHiddenSettingKey, displayName, emptyContact, toContactInput } from "../utils/contact";
import { deletionConfirmationSettingKey } from "../utils/settings";
import { calendarChangedEventName, m365DataUpdatedEventName } from "../utils/automaticCalendarSync";

type ContactsTab = "all" | "groups";
type GroupSelection = "ungrouped" | number;
type EmailApp = "outlook-classic" | "outlook-new";
type EmailDraft = {
  kind: "single" | "group";
  recipients: string[];
  label: string;
  groupName?: string;
};
type DragPreview = {
  label: string;
  x: number;
  y: number;
};
type DeleteRequest =
  | { kind: "contact"; contact: Contact }
  | { kind: "group"; group: Group }
  | { kind: "ungrouped-group" }
  | { kind: "all-contacts" }
  | { kind: "selected-contacts"; contactIds: number[] };

const blankGroup: Group = { name: "", description: "", createdAt: "", updatedAt: "" };
const emailAppSettingKey = "default_email_app";
const contactsFontSizeStorageKey = "dmh.contacts.fontSize";
const contactsFontSizes = [14, 16, 18, 20] as const;
const ungroupedGroupName = "Gesammelte Adressen";
const emptySelection = new Set<number>();

function initialContactsFontSizeIndex(): number {
  const savedSize = Number(localStorage.getItem(contactsFontSizeStorageKey));
  const savedIndex = contactsFontSizes.findIndex((size) => size === savedSize);
  return savedIndex >= 0 ? savedIndex : 1;
}

function uniqueContactEmails(contactRows: Contact[]) {
  const seen = new Set<string>();
  const emails: string[] = [];
  for (const contact of contactRows) {
    const email = contact.email.trim();
    const key = email.toLowerCase();
    if (!email.includes("@") || seen.has(key)) continue;
    seen.add(key);
    emails.push(email);
  }
  return emails;
}

function contactInGroup(contact: Contact, groupId: number) {
  return contact.groups.some((group) => group.id === groupId);
}

export function ContactsPage() {
  const notifyLocalM365Change = () => window.dispatchEvent(new Event(calendarChangedEventName));
  const [tab, setTab] = useState<ContactsTab>("all");
  const [contacts, setContacts] = useState<Contact[]>([]);
  const [groups, setGroups] = useState<Group[]>([]);
  const [groupContactCounts, setGroupContactCounts] = useState<Record<number, number>>({});
  const [ungroupedContactCount, setUngroupedContactCount] = useState(0);
  const [ungroupedGroupHidden, setUngroupedGroupHidden] = useState(false);
  const [allSearch, setAllSearch] = useState("");
  const [groupSearch, setGroupSearch] = useState("");
  const [groupSelection, setGroupSelection] = useState<GroupSelection>("ungrouped");
  const [editing, setEditing] = useState<ContactInput | null>(null);
  const [groupForm, setGroupForm] = useState<Group>(blankGroup);
  const [groupCreateOpen, setGroupCreateOpen] = useState(false);
  const [groupCreateBusy, setGroupCreateBusy] = useState(false);
  const [groupCreateError, setGroupCreateError] = useState("");
  const [renamingGroup, setRenamingGroup] = useState<Group | null>(null);
  const [groupRenameError, setGroupRenameError] = useState("");
  const [testMenuOpen, setTestMenuOpen] = useState(false);
  const [message, setMessage] = useState("");
  const [messageType, setMessageType] = useState<"success" | "error" | "info">("info");
  const [confirmDeletions, setConfirmDeletions] = useState(true);
  const [deleteRequest, setDeleteRequest] = useState<DeleteRequest | null>(null);
  const [deleteBusy, setDeleteBusy] = useState(false);
  const [emailDraft, setEmailDraft] = useState<EmailDraft | null>(null);
  const [selectedEmailApp, setSelectedEmailApp] = useState<EmailApp>("outlook-classic");
  const [rememberEmailApp, setRememberEmailApp] = useState(false);
  const [selectionMode, setSelectionMode] = useState(false);
  const [selectedContactIds, setSelectedContactIds] = useState<Set<number>>(() => new Set());
  const [bulkDeleting, setBulkDeleting] = useState(false);
  const [draggedContactIds, setDraggedContactIds] = useState<number[]>([]);
  const [dragOverGroupKey, setDragOverGroupKey] = useState<GroupSelection | null>(null);
  const [dragPreview, setDragPreview] = useState<DragPreview | null>(null);
  const [bulkAddGroup, setBulkAddGroup] = useState<Group | null>(null);
  const [bulkAddSearch, setBulkAddSearch] = useState("");
  const [bulkAddContacts, setBulkAddContacts] = useState<Contact[]>([]);
  const [bulkAddSelectedIds, setBulkAddSelectedIds] = useState<Set<number>>(() => new Set());
  const [contactsFontSizeIndex, setContactsFontSizeIndex] = useState(initialContactsFontSizeIndex);
  const draggedContactIdsRef = useRef<number[]>([]);
  const groupsRef = useRef<Group[]>([]);

  const selectedGroup = useMemo(
    () => (typeof groupSelection === "number" ? groups.find((group) => group.id === groupSelection) : undefined),
    [groups, groupSelection]
  );

  const currentSearch = tab === "all" ? allSearch : groupSearch;
  const visibleContactIds = useMemo(
    () => contacts.map((contact) => contact.id).filter((id): id is number => Boolean(id)),
    [contacts]
  );
  const selectedVisibleContactIds = useMemo(
    () => visibleContactIds.filter((contactId) => selectedContactIds.has(contactId)),
    [selectedContactIds, visibleContactIds]
  );
  const allVisibleContactsSelected = visibleContactIds.length > 0 && selectedVisibleContactIds.length === visibleContactIds.length;
  const contactsFontSize = contactsFontSizes[contactsFontSizeIndex];

  const changeContactsFontSize = (direction: -1 | 1) => {
    setContactsFontSizeIndex((current) => {
      const next = Math.min(Math.max(current + direction, 0), contactsFontSizes.length - 1);
      localStorage.setItem(contactsFontSizeStorageKey, String(contactsFontSizes[next]));
      return next;
    });
  };

  const refresh = useCallback(async () => {
    const [groupRows, allContactRows] = await Promise.all([listGroups(), listContacts("")]);
    setGroups(groupRows);
    groupsRef.current = groupRows;

    const counts: Record<number, number> = {};
    let ungroupedCount = 0;
    for (const contact of allContactRows) {
      if (contact.groups.length === 0) ungroupedCount += 1;
      for (const group of contact.groups) {
        if (group.id) counts[group.id] = (counts[group.id] ?? 0) + 1;
      }
    }
    setGroupContactCounts(counts);
    setUngroupedContactCount(ungroupedCount);

    if (tab === "all") {
      setContacts(await listContacts(allSearch));
      return;
    }

    if (groupSelection === "ungrouped") {
      const allRows = await listContacts(groupSearch);
      setContacts(allRows.filter((contact) => contact.groups.length === 0));
      return;
    }

    setContacts(await listContacts(groupSearch, groupSelection));
  }, [allSearch, groupSearch, groupSelection, tab]);

  useEffect(() => {
    refresh().catch((error) => {
      setMessage(`Fehler beim Laden: ${error}`);
      setMessageType("error");
    });
  }, [refresh]);

  useEffect(() => {
    const reloadMicrosoft365Changes = () => {
      void refresh().catch((error) => {
        setMessage(`Microsoft-365-Änderungen konnten nicht angezeigt werden: ${error}`);
        setMessageType("error");
      });
    };
    window.addEventListener(m365DataUpdatedEventName, reloadMicrosoft365Changes);
    return () => window.removeEventListener(m365DataUpdatedEventName, reloadMicrosoft365Changes);
  }, [refresh]);

  useEffect(() => {
    getAppSetting(emailAppSettingKey)
      .then((value) => {
        if (value === "outlook-classic" || value === "outlook-new") {
          setSelectedEmailApp(value);
          setRememberEmailApp(true);
        }
      })
      .catch(() => undefined);
  }, []);

  useEffect(() => {
    getAppSetting(deletionConfirmationSettingKey)
      .then((value) => setConfirmDeletions(value !== "false"))
      .catch(() => setConfirmDeletions(true));
  }, []);

  useEffect(() => {
    getAppSetting(collectedAddressesHiddenSettingKey)
      .then((value) => setUngroupedGroupHidden(value === "true"))
      .catch(() => setUngroupedGroupHidden(false));
  }, []);

  useEffect(() => {
    if (!bulkAddGroup?.id) return;
    listContacts(bulkAddSearch)
      .then((rows) => setBulkAddContacts(rows.filter((contact) => contact.id && !contactInGroup(contact, bulkAddGroup.id!))))
      .catch((error) => {
        setMessage(`Kontakte konnten nicht geladen werden: ${error}`);
        setMessageType("error");
      });
  }, [bulkAddGroup, bulkAddSearch]);

  const startNew = () => setEditing({ ...emptyContact });

  const openGroupCreate = () => {
    setGroupForm(blankGroup);
    setGroupCreateError("");
    setGroupCreateOpen(true);
  };

  const closeGroupCreate = () => {
    if (groupCreateBusy) return;
    setGroupCreateOpen(false);
    setGroupForm(blankGroup);
    setGroupCreateError("");
  };

  const submitGroup = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const name = groupForm.name.trim();
    if (!name) {
      setGroupCreateError("Bitte geben Sie einen Gruppennamen ein.");
      return;
    }
    setGroupCreateBusy(true);
    setGroupCreateError("");
    try {
      const groupId = await saveGroup({ ...groupForm, name });
      setGroupForm(blankGroup);
      setGroupCreateOpen(false);
      setGroupSelection(groupId);
      setTab("groups");
      setMessage("Gruppe wurde erstellt.");
      setMessageType("success");
      await refresh();
      notifyLocalM365Change();
    } catch (error) {
      const detail = String(error);
      setGroupCreateError(
        detail.includes("UNIQUE constraint failed")
          ? "Eine Gruppe mit diesem Namen existiert bereits."
          : `Gruppe konnte nicht erstellt werden: ${detail}`
      );
    } finally {
      setGroupCreateBusy(false);
    }
  };

  const startGroupRename = (group: Group) => {
    setRenamingGroup({ ...group });
    setGroupRenameError("");
  };

  const submitGroupRename = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!renamingGroup) return;

    const name = renamingGroup.name.trim();
    if (!name) {
      setGroupRenameError("Bitte geben Sie einen Gruppennamen ein.");
      return;
    }

    try {
      await saveGroup({ ...renamingGroup, name });
      setRenamingGroup(null);
      setGroupRenameError("");
      setMessage(`Gruppe wurde in „${name}“ umbenannt.`);
      setMessageType("success");
      await refresh();
      notifyLocalM365Change();
    } catch (error) {
      const detail = String(error);
      setGroupRenameError(
        detail.includes("UNIQUE constraint failed")
          ? "Eine Gruppe mit diesem Namen existiert bereits."
          : `Gruppe konnte nicht umbenannt werden: ${detail}`
      );
    }
  };

  const submit = async () => {
    if (!editing) return;
    try {
      await saveContact(editing);
      setEditing(null);
      setMessage("Kontakt wurde lokal gespeichert.");
      setMessageType("success");
      await refresh();
      notifyLocalM365Change();
    } catch (error) {
      setMessage(`Kontakt konnte nicht gespeichert werden: ${error}`);
      setMessageType("error");
    }
  };

  const deleteContactNow = async (contact: Contact) => {
    if (!contact.id) return;
    try {
      await deleteContact(contact.id);
      setMessage("Kontakt wurde lokal in den Papierkorb verschoben.");
      setMessageType("success");
      await refresh();
      notifyLocalM365Change();
    } catch (error) {
      setMessage(`Kontakt konnte nicht gelöscht werden: ${error}`);
      setMessageType("error");
    }
  };

  const remove = (contact: Contact) => {
    if (!contact.id) return;
    if (confirmDeletions) setDeleteRequest({ kind: "contact", contact });
    else void deleteContactNow(contact);
  };

  const deleteGroupNow = async (group: Group) => {
    if (!group.id) return;
    try {
      await deleteGroup(group.id);
      if (groupSelection === group.id) setGroupSelection("ungrouped");
      setMessage("Gruppe wurde in den Papierkorb verschoben.");
      setMessageType("success");
      await refresh();
      notifyLocalM365Change();
    } catch (error) {
      setMessage(`Gruppe konnte nicht gelöscht werden: ${error}`);
      setMessageType("error");
    }
  };

  const removeGroup = (group: Group) => {
    if (!group.id) return;
    if (confirmDeletions) setDeleteRequest({ kind: "group", group });
    else void deleteGroupNow(group);
  };

  const deleteUngroupedGroupNow = async () => {
    try {
      await setAppSetting(collectedAddressesHiddenSettingKey, "true");
      await setAppSetting(collectedAddressesDeletedAtSettingKey, new Date().toISOString());
      setUngroupedGroupHidden(true);
      const nextGroupId = groups.find((group) => group.id)?.id;
      if (nextGroupId) setGroupSelection(nextGroupId);
      else setTab("all");
      setMessage(`„${ungroupedGroupName}“ wurde in den Papierkorb verschoben.`);
      setMessageType("success");
      await refresh();
      notifyLocalM365Change();
    } catch (error) {
      setMessage(`„${ungroupedGroupName}“ konnte nicht gelöscht werden: ${error}`);
      setMessageType("error");
    }
  };

  const removeUngroupedGroup = () => {
    if (confirmDeletions) setDeleteRequest({ kind: "ungrouped-group" });
    else void deleteUngroupedGroupNow();
  };

  const deleteAllContactsNow = async () => {
    try {
      const count = await deleteAllContacts();
      setTestMenuOpen(false);
      setMessage(`${count} Kontakte wurden lokal in den Papierkorb verschoben.`);
      setMessageType("success");
      await refresh();
      notifyLocalM365Change();
    } catch (error) {
      setMessage(`Kontakte konnten nicht gelöscht werden: ${error}`);
      setMessageType("error");
    }
  };

  const removeAllContacts = () => {
    if (confirmDeletions) setDeleteRequest({ kind: "all-contacts" });
    else void deleteAllContactsNow();
  };

  const deleteSelectedContactsNow = async (contactIds: number[]) => {
    setBulkDeleting(true);
    try {
      const deleted = await deleteContacts(contactIds);
      setSelectedContactIds(new Set());
      setSelectionMode(false);
      setMessage(
        deleted === 1
          ? "1 ausgewählter Kontakt wurde in den Papierkorb verschoben."
          : `${deleted} ausgewählte Kontakte wurden in den Papierkorb verschoben.`
      );
      setMessageType("success");
      await refresh();
      notifyLocalM365Change();
    } catch (error) {
      setMessage(`Ausgewählte Kontakte konnten nicht gelöscht werden: ${error}`);
      setMessageType("error");
    } finally {
      setBulkDeleting(false);
    }
  };

  const removeSelectedContacts = () => {
    const contactIds = selectedVisibleContactIds;
    if (contactIds.length === 0) return;
    if (confirmDeletions) setDeleteRequest({ kind: "selected-contacts", contactIds });
    else void deleteSelectedContactsNow(contactIds);
  };

  const confirmDeleteRequest = async () => {
    if (!deleteRequest) return;
    setDeleteBusy(true);
    try {
      if (deleteRequest.kind === "contact") await deleteContactNow(deleteRequest.contact);
      if (deleteRequest.kind === "group") await deleteGroupNow(deleteRequest.group);
      if (deleteRequest.kind === "ungrouped-group") await deleteUngroupedGroupNow();
      if (deleteRequest.kind === "all-contacts") await deleteAllContactsNow();
      if (deleteRequest.kind === "selected-contacts") await deleteSelectedContactsNow(deleteRequest.contactIds);
    } finally {
      setDeleteBusy(false);
      setDeleteRequest(null);
    }
  };

  const copyEmail = async (email: string) => {
    await writeText(email);
    setMessage("E-Mail-Adresse wurde kopiert.");
    setMessageType("success");
  };

  const toggleSelectionMode = () => {
    setSelectionMode((enabled) => {
      if (enabled) setSelectedContactIds(new Set());
      return !enabled;
    });
  };

  const startSelectionMode = () => {
    setSelectedContactIds(new Set());
    setSelectionMode(true);
    setTestMenuOpen(false);
  };

  const changeTab = (nextTab: ContactsTab) => {
    setTab(nextTab);
    setSelectionMode(false);
    setSelectedContactIds(new Set());
    setTestMenuOpen(false);
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

  const toggleSelectAllVisible = () => {
    setSelectedContactIds((current) => {
      const next = new Set(current);
      if (allVisibleContactsSelected) {
        for (const contactId of visibleContactIds) next.delete(contactId);
      } else {
        for (const contactId of visibleContactIds) next.add(contactId);
      }
      return next;
    });
  };

  const chooseEmailApp = (email: string) => {
    setEmailDraft({ kind: "single", recipients: [email], label: `Empfänger: ${email}` });
  };

  const chooseGroupEmailApp = async (group: Group | "ungrouped") => {
    try {
      const groupContacts = group === "ungrouped"
        ? (await listContacts("")).filter((contact) => contact.groups.length === 0)
        : await listContacts("", group.id);
      const recipients = uniqueContactEmails(groupContacts);
      const groupName = group === "ungrouped" ? ungroupedGroupName : group.name;
      if (recipients.length === 0) {
        setMessage(`"${groupName}" hat keine Kontakte mit E-Mail-Adresse.`);
        setMessageType("info");
        return;
      }
      setEmailDraft({
        kind: "group",
        recipients,
        groupName,
        label: `Cco: ${recipients.length} Empfänger aus "${groupName}"`
      });
    } catch (error) {
      setMessage(`E-Mail-Liste konnte nicht geladen werden: ${error}`);
      setMessageType("error");
    }
  };

  const sendEmail = async () => {
    if (!emailDraft || emailDraft.recipients.length === 0) return;
    try {
      await setAppSetting(emailAppSettingKey, rememberEmailApp ? selectedEmailApp : "");
      if (selectedEmailApp === "outlook-classic") {
        if (emailDraft.kind === "group") await openOutlookClassicBulkEmail(emailDraft.recipients, `Nachricht an ${emailDraft.groupName}`);
        else await openOutlookClassicEmail(emailDraft.recipients[0]);
      } else {
        if (emailDraft.kind === "group") await openNewOutlookBulkEmail(emailDraft.recipients, `Nachricht an ${emailDraft.groupName}`);
        else await openNewOutlookEmail(emailDraft.recipients[0]);
      }
      setEmailDraft(null);
    } catch (error) {
      await writeText(emailDraft.recipients.join("; "));
      setMessage(`E-Mail-Anwendung konnte nicht geöffnet werden: ${error}`);
      setMessageType("error");
    }
  };

  const startContactDrag = (contact: Contact, position: { x: number; y: number }) => {
    if (!contact.id) return;
    const contactIds = selectionMode && selectedContactIds.has(contact.id)
      ? selectedVisibleContactIds
      : [contact.id];
    draggedContactIdsRef.current = contactIds;
    setDraggedContactIds(contactIds);
    setDragPreview({
      label: contactIds.length > 1 ? `${contactIds.length} Kontakte` : displayName(contact),
      x: position.x,
      y: position.y
    });
  };

  const endContactDrag = () => {
    draggedContactIdsRef.current = [];
    setDraggedContactIds([]);
    setDragOverGroupKey(null);
    setDragPreview(null);
  };

  const moveContactsToSelection = async (contactIds: number[], target: GroupSelection) => {
    if (contactIds.length === 0) return;
    try {
      if (target === "ungrouped") {
        for (const contactId of contactIds) await clearContactGroups(contactId);
      } else {
        for (const contactId of contactIds) await moveContactToGroup(contactId, target);
      }
      const targetLabel = target === "ungrouped"
        ? ungroupedGroupName
        : groupsRef.current.find((group) => group.id === target)?.name ?? "Gruppe";
      setMessage(contactIds.length === 1 ? `Kontakt wurde nach "${targetLabel}" verschoben.` : `${contactIds.length} Kontakte wurden nach "${targetLabel}" verschoben.`);
      setMessageType("success");
      setSelectedContactIds(new Set());
      setSelectionMode(false);
      await refresh();
      notifyLocalM365Change();
    } catch (error) {
      setMessage(`Kontakte konnten nicht verschoben werden: ${error}`);
      setMessageType("error");
    } finally {
      endContactDrag();
    }
  };

  useEffect(() => {
    if (draggedContactIds.length === 0) return;
    const findGroupFromPoint = (event: PointerEvent): GroupSelection | undefined => {
      const target = document.elementFromPoint(event.clientX, event.clientY);
      const groupElement = target?.closest<HTMLElement>("[data-group-key]");
      const groupKey = groupElement?.dataset.groupKey;
      if (groupKey === "ungrouped") return "ungrouped";
      const groupId = Number(groupKey);
      return Number.isFinite(groupId) ? groupId : undefined;
    };
    const updatePointerTarget = (event: PointerEvent) => {
      const target = findGroupFromPoint(event);
      setDragOverGroupKey(target ?? null);
      setDragPreview((current) => current ? { ...current, x: event.clientX, y: event.clientY } : current);
    };
    const finishPointerDrag = (event: PointerEvent) => {
      const contactIds = draggedContactIdsRef.current;
      const target = findGroupFromPoint(event);
      if (contactIds.length > 0 && target !== undefined) void moveContactsToSelection(contactIds, target);
      else endContactDrag();
    };
    window.addEventListener("pointermove", updatePointerTarget);
    window.addEventListener("pointerup", finishPointerDrag);
    return () => {
      window.removeEventListener("pointermove", updatePointerTarget);
      window.removeEventListener("pointerup", finishPointerDrag);
    };
  }, [draggedContactIds]);

  const pointerOverGroup = (target: GroupSelection) => {
    if (draggedContactIdsRef.current.length === 0) return;
    setDragOverGroupKey(target);
  };

  const openBulkAdd = (group: Group) => {
    setBulkAddGroup(group);
    setBulkAddSearch("");
    setBulkAddSelectedIds(new Set());
  };

  const closeBulkAdd = () => {
    setBulkAddGroup(null);
    setBulkAddSearch("");
    setBulkAddSelectedIds(new Set());
  };

  const toggleBulkAddContact = (contact: Contact) => {
    if (!contact.id) return;
    setBulkAddSelectedIds((current) => {
      const next = new Set(current);
      if (next.has(contact.id!)) next.delete(contact.id!);
      else next.add(contact.id!);
      return next;
    });
  };

  const addBulkContacts = async () => {
    if (!bulkAddGroup?.id || bulkAddSelectedIds.size === 0) return;
    await moveContactsToSelection(Array.from(bulkAddSelectedIds), bulkAddGroup.id);
    closeBulkAdd();
  };

  return (
    <div className={`${draggedContactIds.length === 0 ? "page contacts-page" : "page contacts-page dragging-contact"} contacts-font-${contactsFontSize}`}>
      <div className="contacts-tabs" role="tablist" aria-label="Kontakte">
        <button className={tab === "all" ? "active" : ""} type="button" onClick={() => changeTab("all")}>
          Alle Kontakte
        </button>
        <button className={tab === "groups" ? "active" : ""} type="button" onClick={() => changeTab("groups")}>
          Gruppen verwalten
        </button>
      </div>

      <header className="contacts-commandbar">
        <div className="contacts-title">
          <h2>{tab === "all" ? "Alle Kontakte" : "Gruppen verwalten"}</h2>
        </div>
        <label className="search-field">
          <Search size={20} />
          <input
            value={currentSearch}
            onChange={(event) => tab === "all" ? setAllSearch(event.target.value) : setGroupSearch(event.target.value)}
            placeholder={t.search}
          />
        </label>
        <div className="button-row contacts-actions">
          {tab === "groups" && !selectionMode && (
              <button
                type="button"
                onClick={toggleSelectionMode}
                disabled={bulkDeleting}
              >
                Auswählen
              </button>
          )}
          {selectionMode && (
            <>
              <button className="primary" type="button" onClick={toggleSelectionMode} disabled={bulkDeleting}>Fertig</button>
              <button type="button" onClick={toggleSelectAllVisible} disabled={bulkDeleting || visibleContactIds.length === 0}>
                {allVisibleContactsSelected ? "Auswahl aufheben" : "Alle auswählen"}
              </button>
              <button
                className="danger-button"
                type="button"
                onClick={removeSelectedContacts}
                disabled={bulkDeleting || selectedVisibleContactIds.length === 0}
              >
                <Trash2 size={19} />
                {bulkDeleting
                  ? "Wird gelöscht …"
                  : `Ausgewählte löschen (${selectedVisibleContactIds.length})`}
              </button>
              <span className="selection-count">{selectedVisibleContactIds.length} ausgewählt</span>
            </>
          )}
          <button className="primary" type="button" onClick={startNew}>
            <Plus size={20} /> {t.newContact}
          </button>
          <div className="more-menu-wrap">
            <button className="icon-only" type="button" aria-label="Weitere Optionen" onClick={() => setTestMenuOpen((open) => !open)}>
              <Ellipsis size={20} />
            </button>
            {testMenuOpen && (
              <div className="more-menu">
                {tab === "all" && !selectionMode && <button type="button" onClick={startSelectionMode}>Auswählen</button>}
                <button type="button" onClick={removeAllContacts}>Alle Kontakte löschen</button>
              </div>
            )}
          </div>
        </div>
      </header>

      <StatusMessage message={message} type={messageType} />

      {dragPreview && (
        <div className="contact-drag-preview" style={{ left: dragPreview.x, top: dragPreview.y }}>
          {dragPreview.label}
        </div>
      )}

      {emailDraft && (
        <div className="modal-backdrop" role="dialog" aria-modal="true" aria-label="E-Mail-Anwendung auswählen">
          <div className="modal-card email-app-dialog">
            <section className="form-panel">
              <div className="panel-heading">
                <div>
                  <h3>E-Mail senden</h3>
                  <p className="email-recipient">{emailDraft.label}</p>
                </div>
                <button className="icon-only" type="button" aria-label="Schließen" onClick={() => setEmailDraft(null)}>
                  <X size={22} />
                </button>
              </div>
              <div className="email-app-options">
                <label className={selectedEmailApp === "outlook-classic" ? "email-app-option selected" : "email-app-option"}>
                  <input type="radio" name="email-app" checked={selectedEmailApp === "outlook-classic"} onChange={() => setSelectedEmailApp("outlook-classic")} />
                  <Mail size={26} />
                  <span><strong>Outlook Classic</strong><small>Desktop-Version von Microsoft Outlook</small></span>
                </label>
                <label className={selectedEmailApp === "outlook-new" ? "email-app-option selected" : "email-app-option"}>
                  <input type="radio" name="email-app" checked={selectedEmailApp === "outlook-new"} onChange={() => setSelectedEmailApp("outlook-new")} />
                  <Mail size={26} />
                  <span><strong>Neues Outlook</strong><small>Neue Outlook-App für Windows</small></span>
                </label>
              </div>
              <label className="checkbox-row email-default-option">
                <input type="checkbox" checked={rememberEmailApp} onChange={(event) => setRememberEmailApp(event.target.checked)} />
                Diese Anwendung als Standard für E-Mails in DMH Kontakte und Kalender verwenden
              </label>
              <div className="button-row">
                <button className="primary" type="button" onClick={sendEmail}>E-Mail öffnen</button>
                <button type="button" onClick={() => setEmailDraft(null)}>Abbrechen</button>
              </div>
            </section>
          </div>
        </div>
      )}

      {bulkAddGroup && (
        <div className="modal-backdrop" role="dialog" aria-modal="true" aria-label="Kontakte hinzufügen">
          <div className="modal-card bulk-add-dialog">
            <section className="form-panel">
              <div className="panel-heading">
                <div>
                  <h3>Kontakte hinzufügen</h3>
                  <p className="email-recipient">{bulkAddGroup.name}</p>
                </div>
                <button className="icon-only" type="button" aria-label="Schließen" onClick={closeBulkAdd}>
                  <X size={22} />
                </button>
              </div>
              <label className="search-field bulk-add-search">
                <Search size={20} />
                <input value={bulkAddSearch} onChange={(event) => setBulkAddSearch(event.target.value)} placeholder="Kontakte suchen" />
              </label>
              <div className="bulk-add-list">
                {bulkAddContacts.map((contact) => {
                  const selected = Boolean(contact.id && bulkAddSelectedIds.has(contact.id));
                  return (
                    <button className={selected ? "bulk-add-row selected" : "bulk-add-row"} key={contact.id} type="button" onClick={() => toggleBulkAddContact(contact)}>
                      <span className={selected ? "selection-dot checked" : "selection-dot"}>{selected ? "✓" : ""}</span>
                      <span>
                        <strong>{displayName(contact)}</strong>
                        <small>{contact.email || "-"}</small>
                      </span>
                    </button>
                  );
                })}
                {bulkAddContacts.length === 0 && <p className="empty-row">Keine passenden Kontakte gefunden.</p>}
              </div>
              <div className="button-row">
                <button className="primary" type="button" onClick={addBulkContacts} disabled={bulkAddSelectedIds.size === 0}>
                  Hinzufügen ({bulkAddSelectedIds.size})
                </button>
                <button type="button" onClick={closeBulkAdd}>Abbrechen</button>
              </div>
            </section>
          </div>
        </div>
      )}

      {editing && (
        <div className="modal-backdrop" role="dialog" aria-modal="true" aria-label={editing.id ? t.editContact : t.newContact}>
          <div className="modal-card">
            <ContactForm value={editing} groups={groups} onChange={setEditing} onSubmit={submit} onCancel={() => setEditing(null)} />
          </div>
        </div>
      )}

      {groupCreateOpen && (
        <div className="modal-backdrop" role="dialog" aria-modal="true" aria-labelledby="group-create-title">
          <form className="form-panel modal-card group-rename-dialog" onSubmit={submitGroup}>
            <div className="panel-heading">
              <h3 id="group-create-title">Neue Gruppe erstellen</h3>
              <button className="icon-only" type="button" aria-label="Schließen" onClick={closeGroupCreate} disabled={groupCreateBusy}>
                <X size={22} />
              </button>
            </div>
            <label className="field">
              <span>Gruppenname</span>
              <input
                autoFocus
                value={groupForm.name}
                onChange={(event) => {
                  setGroupForm({ ...groupForm, name: event.target.value });
                  setGroupCreateError("");
                }}
                placeholder="Name der Gruppe"
              />
            </label>
            {groupCreateError && <p className="field-error">{groupCreateError}</p>}
            <div className="button-row">
              <button className="primary" type="submit" disabled={groupCreateBusy}>
                {groupCreateBusy ? "Wird erstellt …" : "Erstellen"}
              </button>
              <button type="button" onClick={closeGroupCreate} disabled={groupCreateBusy}>Abbrechen</button>
            </div>
          </form>
        </div>
      )}

      {renamingGroup && (
        <div className="modal-backdrop" role="dialog" aria-modal="true" aria-labelledby="group-rename-title">
          <form className="form-panel modal-card group-rename-dialog" onSubmit={submitGroupRename}>
            <div className="panel-heading">
              <h3 id="group-rename-title">Gruppe umbenennen</h3>
              <button className="icon-only" type="button" aria-label="Schließen" onClick={() => setRenamingGroup(null)}>
                <X size={22} />
              </button>
            </div>
            <label className="field">
              <span>Gruppenname</span>
              <input
                autoFocus
                value={renamingGroup.name}
                onChange={(event) => {
                  setRenamingGroup({ ...renamingGroup, name: event.target.value });
                  setGroupRenameError("");
                }}
              />
            </label>
            {groupRenameError && <p className="field-error">{groupRenameError}</p>}
            <div className="button-row">
              <button className="primary" type="submit">Speichern</button>
              <button type="button" onClick={() => setRenamingGroup(null)}>Abbrechen</button>
            </div>
          </form>
        </div>
      )}

      {tab === "all" ? (
        <ContactTable
          contacts={contacts}
          onEdit={(contact) => setEditing(toContactInput(contact))}
          onDelete={remove}
          onCopyEmail={copyEmail}
          onEmail={chooseEmailApp}
          selectionMode={selectionMode}
          selectedContactIds={selectionMode ? selectedContactIds : emptySelection}
          onToggleSelection={toggleContactSelection}
          onPointerDragStart={startContactDrag}
          dragEnabled={false}
        />
      ) : (
        <section className="contacts-workspace">
          <aside className="groups-panel">
            <div className="groups-panel-heading">
              <div>
                <span className="groups-panel-kicker">Kontaktorganisation</span>
                <h3>Gruppen</h3>
              </div>
              <span className="group-summary" aria-label={`${groups.length + (ungroupedGroupHidden ? 0 : 1)} Gruppen`}><strong>{groups.length + (ungroupedGroupHidden ? 0 : 1)}</strong><small>Gruppen</small></span>
            </div>
            <button className="primary group-create-button" type="button" onClick={openGroupCreate}>
              <Plus size={20} /> Neue Gruppe erstellen
            </button>
            <div className="group-list" aria-label="Kontaktgruppen">
              {!ungroupedGroupHidden && <div
                className={["group-drop", groupSelection === "ungrouped" ? "active" : "", dragOverGroupKey === "ungrouped" ? "drag-over" : ""].filter(Boolean).join(" ")}
                data-group-key="ungrouped"
                onPointerEnter={() => pointerOverGroup("ungrouped")}
                onPointerLeave={() => setDragOverGroupKey((current) => current === "ungrouped" ? null : current)}
              >
                <div className="group-card-top">
                  <span className="group-card-icon"><Inbox size={22} aria-hidden="true" /></span>
                  <button type="button" className="group-card-name" title={ungroupedGroupName} onClick={() => setGroupSelection("ungrouped")}>
                    {ungroupedGroupName}
                  </button>
                  <span className="group-card-top-spacer" aria-hidden="true" />
                </div>
                <div className="group-card-bottom">
                  <strong>{ungroupedContactCount} {ungroupedContactCount === 1 ? "Kontakt" : "Kontakte"}</strong>
                  <div className="group-card-actions">
                    <button type="button" className={groupSelection === "ungrouped" ? "selected" : ""} aria-pressed={groupSelection === "ungrouped"} title="Gruppe verwalten" aria-label="Gesammelte Adressen verwalten" onClick={() => setGroupSelection("ungrouped")}><Settings2 size={20} /></button>
                    <button type="button" title="E-Mail an Gruppe" aria-label="E-Mail an Gesammelte Adressen" onClick={() => chooseGroupEmailApp("ungrouped")}><Mail size={20} /></button>
                    <button className="group-card-delete" type="button" title="Gruppe löschen" aria-label="Gesammelte Adressen löschen" onClick={removeUngroupedGroup}><Trash2 size={20} /></button>
                  </div>
                </div>
              </div>}
              {groups.map((group) => {
                const contactCount = group.id ? (groupContactCounts[group.id] ?? 0) : 0;
                return (
                  <div
                    className={["group-drop", groupSelection === group.id ? "active" : "", dragOverGroupKey === group.id ? "drag-over" : ""].filter(Boolean).join(" ")}
                    key={group.id}
                    data-group-key={group.id}
                    onPointerEnter={() => group.id && pointerOverGroup(group.id)}
                    onPointerLeave={() => setDragOverGroupKey((current) => current === group.id ? null : current)}
                  >
                    <div className="group-card-top">
                      <span className="group-card-icon"><UsersRound size={22} aria-hidden="true" /></span>
                      <button type="button" className="group-card-name" title={group.name} onClick={() => setGroupSelection(group.id ?? "ungrouped")}>
                        {group.name}
                      </button>
                      <button className="group-card-edit" type="button" title="Gruppennamen ändern" aria-label={`${group.name} umbenennen`} onClick={() => startGroupRename(group)}>
                        <Pencil size={19} />
                      </button>
                    </div>
                    <div className="group-card-bottom">
                      <strong>{contactCount} {contactCount === 1 ? "Kontakt" : "Kontakte"}</strong>
                      <div className="group-card-actions">
                        <button type="button" className={groupSelection === group.id ? "selected" : ""} aria-pressed={groupSelection === group.id} title="Gruppe verwalten" aria-label={`${group.name} verwalten`} onClick={() => setGroupSelection(group.id ?? "ungrouped")}><Settings2 size={20} /></button>
                        <button type="button" title="E-Mail an Gruppe" aria-label={`E-Mail an ${group.name}`} onClick={() => chooseGroupEmailApp(group)}><Mail size={20} /></button>
                        <button className="group-card-delete" type="button" title="Gruppe löschen" aria-label={`${group.name} löschen`} onClick={() => removeGroup(group)}><Trash2 size={20} /></button>
                      </div>
                    </div>
                  </div>
                );
              })}
            </div>
            <p className="drop-hint">Tipp: Ziehen Sie einen Kontakt auf eine Gruppe, um ihn dorthin zu verschieben.</p>
          </aside>

          <div className="contacts-main">
            <ContactTable
              contacts={contacts}
              onEdit={(contact) => setEditing(toContactInput(contact))}
              onDelete={remove}
              onCopyEmail={copyEmail}
              onEmail={chooseEmailApp}
              selectionMode={selectionMode}
              selectedContactIds={selectedContactIds}
              onToggleSelection={toggleContactSelection}
              onPointerDragStart={startContactDrag}
              dragEnabled
            />
          </div>
        </section>
      )}

      <ConfirmDialog
        open={deleteRequest !== null}
        title={deleteRequest?.kind === "group"
          ? "Gruppe löschen"
          : deleteRequest?.kind === "ungrouped-group"
            ? "Gruppe löschen"
          : deleteRequest?.kind === "all-contacts"
            ? "Alle Kontakte löschen"
            : deleteRequest?.kind === "selected-contacts"
              ? "Kontakte löschen"
              : "Kontakt löschen"}
        message={deleteRequest?.kind === "group"
          ? `Möchten Sie die Gruppe „${deleteRequest.group.name}“ wirklich in den Papierkorb verschieben?`
          : deleteRequest?.kind === "ungrouped-group"
            ? `Möchten Sie die Gruppe „${ungroupedGroupName}“ wirklich in den Papierkorb verschieben? Die Kontakte bleiben erhalten.`
          : deleteRequest?.kind === "all-contacts"
            ? "Alle Kontakte werden in den Papierkorb verschoben. Möchten Sie fortfahren?"
            : deleteRequest?.kind === "selected-contacts"
              ? `${deleteRequest.contactIds.length} ausgewählte Kontakte werden in den Papierkorb verschoben. Möchten Sie fortfahren?`
              : deleteRequest?.kind === "contact"
                ? `Möchten Sie den Kontakt „${displayName(deleteRequest.contact)}“ wirklich in den Papierkorb verschieben?`
                : "Möchten Sie diesen Eintrag wirklich löschen?"}
        confirmLabel="In Papierkorb verschieben"
        busy={deleteBusy}
        onCancel={() => setDeleteRequest(null)}
        onConfirm={() => void confirmDeleteRequest()}
      />

      <div className="contacts-font-control" role="group" aria-label="Schriftgröße der Kontakte">
        <button
          type="button"
          onClick={() => changeContactsFontSize(-1)}
          disabled={contactsFontSizeIndex === 0}
          aria-label="Schrift verkleinern"
          title="Schrift verkleinern"
        >
          <Minus size={22} aria-hidden="true" />
        </button>
        <button
          type="button"
          onClick={() => changeContactsFontSize(1)}
          disabled={contactsFontSizeIndex === contactsFontSizes.length - 1}
          aria-label="Schrift vergrößern"
          title="Schrift vergrößern"
        >
          <Plus size={22} aria-hidden="true" />
        </button>
      </div>
    </div>
  );
}
