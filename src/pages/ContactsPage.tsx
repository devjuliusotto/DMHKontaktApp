import { writeText } from "@tauri-apps/plugin-clipboard-manager";
import { Building2, Download, Ellipsis, Folder, FolderOpen, FolderPlus, Info, ListChecks, Mail, MapPin, Minus, Pencil, Phone, Plus, RefreshCw, Search, ShieldCheck, StickyNote, Trash2, Upload, UserPlus, UserRound, UsersRound, X } from "lucide-react";
import { type CSSProperties, type FormEvent, type MouseEvent as ReactMouseEvent, type PointerEvent as ReactPointerEvent, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ContactForm } from "../components/ContactForm";
import { ContactTable } from "../components/ContactTable";
import { ConfirmDialog } from "../components/ConfirmDialog";
import { ContactReconciliationDialog } from "../components/ContactReconciliationDialog";
import { EasyImportDialog } from "../components/EasyImportDialog";
import { EmptyImportState } from "../components/EmptyImportState";
import { ActionResultDialog, type ActionResult } from "../components/ActionResultDialog";
import { Microsoft365SyncDialog } from "../components/Microsoft365SyncDialog";
import { StatusMessage } from "../components/StatusMessage";
import type { Page } from "../components/Sidebar";
import { t } from "../i18n";
import {
  clearContactGroups,
  cleanupContactDuplicates,
  deleteAllContacts,
  deleteContact,
  deleteContacts,
  deleteGroup,
  getAppSetting,
  getContactOverviewCounts,
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
import { collectedAddressesDeletedAtSettingKey, collectedAddressesHiddenSettingKey, contactEmails, contactUsesAutomaticDisplayName, displayName, emptyContact, primaryContactEmail, saveAutomaticDisplayNamePreference, toContactInput } from "../utils/contact";
import { findContactDuplicateGroups, type ContactDuplicateGroup } from "../utils/contactDuplicates";
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
type GroupContextTarget =
  | { kind: "ungrouped" }
  | { kind: "group"; group: Group };
type GroupContextMenu = {
  x: number;
  y: number;
  target: GroupContextTarget | null;
};
type DeleteRequest =
  | { kind: "contact"; contact: Contact }
  | { kind: "group"; group: Group }
  | { kind: "ungrouped-group" }
  | { kind: "all-contacts" }
  | { kind: "selected-contacts"; contactIds: number[]; contacts: Contact[] };

const blankGroup: Group = { name: "", description: "", createdAt: "", updatedAt: "" };
const emailAppSettingKey = "default_email_app";
const contactsFontSizeStorageKey = "dmh.contacts.fontSize";
const contactPaneLayoutStorageKey = "dmh.contacts.paneLayout";
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
    for (const email of contactEmails(contact)) {
      const key = email.toLowerCase();
      if (!email.includes("@") || seen.has(key)) continue;
      seen.add(key);
      emails.push(email);
    }
  }
  return emails;
}

function contactInGroup(contact: Contact, groupId: number) {
  return contact.groups.some((group) => group.id === groupId);
}

type ContactPaneLayout = { groups: number; contacts: number };
type ContactPaneResize = {
  pane: "groups" | "contacts";
  width: number;
  left: number;
  layout: ContactPaneLayout;
  nextLayout: ContactPaneLayout;
};

function initialContactPaneLayout(): ContactPaneLayout {
  try {
    const saved = JSON.parse(localStorage.getItem(contactPaneLayoutStorageKey) ?? "null") as Partial<ContactPaneLayout> | null;
    if (saved && typeof saved.groups === "number" && typeof saved.contacts === "number") {
      const groups = Math.min(35, Math.max(18, saved.groups));
      const contacts = Math.min(52, Math.max(30, saved.contacts));
      if (groups + contacts <= 75) return { groups, contacts };
    }
  } catch {
    // Invalid local preference falls back to the balanced default.
  }
  return { groups: 25, contacts: 40 };
}

function formatGroupDate(value: string): string {
  if (!value) return "–";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return new Intl.DateTimeFormat("de-DE", { dateStyle: "medium", timeStyle: "short" }).format(date);
}

function contactInitials(contact: Contact): string {
  const source = displayName(contact).trim();
  if (!source) return "?";
  const parts = source.split(/\s+/).filter(Boolean);
  return (parts.length > 1 ? `${parts[0][0]}${parts[parts.length - 1][0]}` : source.slice(0, 2)).toUpperCase();
}

interface ContactsPageProps {
  onNavigate: (page: Page) => void;
}

export function ContactsPage({ onNavigate }: ContactsPageProps) {
  const notifyLocalM365Change = () => window.dispatchEvent(new Event(calendarChangedEventName));
  const [tab, setTab] = useState<ContactsTab>("all");
  const [contacts, setContacts] = useState<Contact[]>([]);
  const [totalContactCount, setTotalContactCount] = useState<number | null>(null);
  const [easyImportOpen, setEasyImportOpen] = useState(false);
  const [reconciliationOpen, setReconciliationOpen] = useState(false);
  const [groups, setGroups] = useState<Group[]>([]);
  const [groupContactCounts, setGroupContactCounts] = useState<Record<number, number>>({});
  const [ungroupedContactCount, setUngroupedContactCount] = useState(0);
  const [ungroupedGroupHidden, setUngroupedGroupHidden] = useState(false);
  const [allSearch, setAllSearch] = useState("");
  const [groupSearch, setGroupSearch] = useState("");
  const [groupListSearch, setGroupListSearch] = useState("");
  const [debouncedAllSearch, setDebouncedAllSearch] = useState("");
  const [debouncedGroupSearch, setDebouncedGroupSearch] = useState("");
  const [groupSelection, setGroupSelection] = useState<GroupSelection>("ungrouped");
  const [editing, setEditing] = useState<ContactInput | null>(null);
  const [automaticDisplayName, setAutomaticDisplayName] = useState(true);
  const [groupForm, setGroupForm] = useState<Group>(blankGroup);
  const [groupCreateOpen, setGroupCreateOpen] = useState(false);
  const [groupCreateBusy, setGroupCreateBusy] = useState(false);
  const [groupCreateError, setGroupCreateError] = useState("");
  const [renamingGroup, setRenamingGroup] = useState<Group | null>(null);
  const [groupRenameError, setGroupRenameError] = useState("");
  const [testMenuOpen, setTestMenuOpen] = useState(false);
  const [m365SyncDialogOpen, setM365SyncDialogOpen] = useState(false);
  const [duplicateReviewOpen, setDuplicateReviewOpen] = useState(false);
  const [duplicateCheckBusy, setDuplicateCheckBusy] = useState(false);
  const [duplicateGroups, setDuplicateGroups] = useState<ContactDuplicateGroup[]>([]);
  const [duplicateCleanupConfirmOpen, setDuplicateCleanupConfirmOpen] = useState(false);
  const [duplicateCleanupBusy, setDuplicateCleanupBusy] = useState(false);
  const [message, setMessage] = useState("");
  const [messageType, setMessageType] = useState<"success" | "error" | "info">("info");
  const [actionResult, setActionResult] = useState<ActionResult | null>(null);
  const [confirmDeletions, setConfirmDeletions] = useState(true);
  const [deleteRequest, setDeleteRequest] = useState<DeleteRequest | null>(null);
  const [deleteBusy, setDeleteBusy] = useState(false);
  const [emailDraft, setEmailDraft] = useState<EmailDraft | null>(null);
  const [contactInspectorMenuOpen, setContactInspectorMenuOpen] = useState(false);
  const [selectedEmailApp, setSelectedEmailApp] = useState<EmailApp>("outlook-classic");
  const [rememberEmailApp, setRememberEmailApp] = useState(false);
  const [selectionMode, setSelectionMode] = useState(false);
  const [selectedContactIds, setSelectedContactIds] = useState<Set<number>>(() => new Set());
  const [selectedGroupContactId, setSelectedGroupContactId] = useState<number | undefined>();
  const [bulkDeleting, setBulkDeleting] = useState(false);
  const [draggedContactIds, setDraggedContactIds] = useState<number[]>([]);
  const [dragOverGroupKey, setDragOverGroupKey] = useState<GroupSelection | null>(null);
  const [dragPreview, setDragPreview] = useState<DragPreview | null>(null);
  const [groupContextMenu, setGroupContextMenu] = useState<GroupContextMenu | null>(null);
  const [groupProperties, setGroupProperties] = useState<GroupContextTarget | null>(null);
  const [bulkAddGroup, setBulkAddGroup] = useState<Group | null>(null);
  const [bulkAddSearch, setBulkAddSearch] = useState("");
  const [debouncedBulkAddSearch, setDebouncedBulkAddSearch] = useState("");
  const [bulkAddContacts, setBulkAddContacts] = useState<Contact[]>([]);
  const [bulkAddSelectedIds, setBulkAddSelectedIds] = useState<Set<number>>(() => new Set());
  const [contactsFontSizeIndex, setContactsFontSizeIndex] = useState(initialContactsFontSizeIndex);
  const [contactPaneLayout, setContactPaneLayout] = useState<ContactPaneLayout>(initialContactPaneLayout);
  const draggedContactIdsRef = useRef<number[]>([]);
  const dragOverGroupKeyRef = useRef<GroupSelection | null>(null);
  const groupsRef = useRef<Group[]>([]);
  const contactsWorkspaceRef = useRef<HTMLElement>(null);
  const contactPaneResizeRef = useRef<ContactPaneResize | null>(null);

  const selectedGroup = useMemo(
    () => (typeof groupSelection === "number" ? groups.find((group) => group.id === groupSelection) : undefined),
    [groups, groupSelection]
  );

  const normalizedGroupListSearch = groupListSearch.trim().toLocaleLowerCase("de");
  const visibleGroups = useMemo(() => {
    if (!normalizedGroupListSearch) return groups;
    return groups.filter((group) => group.name.toLocaleLowerCase("de").includes(normalizedGroupListSearch));
  }, [groups, normalizedGroupListSearch]);
  const showUngroupedGroup = !ungroupedGroupHidden
    && (!normalizedGroupListSearch || ungroupedGroupName.toLocaleLowerCase("de").includes(normalizedGroupListSearch));
  const visibleContactIds = useMemo(
    () => contacts.map((contact) => contact.id).filter((id): id is number => Boolean(id)),
    [contacts]
  );
  const selectedVisibleContactIds = useMemo(
    () => visibleContactIds.filter((contactId) => selectedContactIds.has(contactId)),
    [selectedContactIds, visibleContactIds]
  );
  const allVisibleContactsSelected = visibleContactIds.length > 0 && selectedVisibleContactIds.length === visibleContactIds.length;
  const selectedGroupContact = useMemo(
    () => contacts.find((contact) => contact.id === selectedGroupContactId),
    [contacts, selectedGroupContactId]
  );
  const contactsFontSize = contactsFontSizes[contactsFontSizeIndex];
  const duplicateCandidateCount = useMemo(
    () => new Set(duplicateGroups.flatMap((group) => group.contacts.map((contact) => contact.id))).size,
    [duplicateGroups]
  );

  const changeContactsFontSize = (direction: -1 | 1) => {
    setContactsFontSizeIndex((current) => {
      const next = Math.min(Math.max(current + direction, 0), contactsFontSizes.length - 1);
      localStorage.setItem(contactsFontSizeStorageKey, String(contactsFontSizes[next]));
      return next;
    });
  };

  useEffect(() => {
    const timer = window.setTimeout(() => setDebouncedAllSearch(allSearch), 300);
    return () => window.clearTimeout(timer);
  }, [allSearch]);

  useEffect(() => {
    const timer = window.setTimeout(() => setDebouncedGroupSearch(groupSearch), 300);
    return () => window.clearTimeout(timer);
  }, [groupSearch]);

  useEffect(() => {
    if (tab !== "groups" || editing) return;
    setSelectedGroupContactId((current) => contacts.some((contact) => contact.id === current)
      ? current
      : contacts.find((contact) => contact.id)?.id);
  }, [contacts, editing, tab]);

  useEffect(() => {
    const timer = window.setTimeout(() => setDebouncedBulkAddSearch(bulkAddSearch), 300);
    return () => window.clearTimeout(timer);
  }, [bulkAddSearch]);

  useEffect(() => {
    if (!groupContextMenu) return;
    const closeMenu = () => setGroupContextMenu(null);
    const closeMenuWithKeyboard = (event: KeyboardEvent) => {
      if (event.key === "Escape") closeMenu();
    };
    window.addEventListener("pointerdown", closeMenu);
    window.addEventListener("blur", closeMenu);
    window.addEventListener("keydown", closeMenuWithKeyboard);
    return () => {
      window.removeEventListener("pointerdown", closeMenu);
      window.removeEventListener("blur", closeMenu);
      window.removeEventListener("keydown", closeMenuWithKeyboard);
    };
  }, [groupContextMenu]);

  useEffect(() => {
    if (!contactInspectorMenuOpen) return;
    const closeMenu = () => setContactInspectorMenuOpen(false);
    const closeMenuWithKeyboard = (event: KeyboardEvent) => {
      if (event.key === "Escape") closeMenu();
    };
    window.addEventListener("pointerdown", closeMenu);
    window.addEventListener("keydown", closeMenuWithKeyboard);
    return () => {
      window.removeEventListener("pointerdown", closeMenu);
      window.removeEventListener("keydown", closeMenuWithKeyboard);
    };
  }, [contactInspectorMenuOpen]);

  useEffect(() => () => {
    document.body.classList.remove("resizing-contact-panes");
  }, []);

  const refresh = useCallback(async () => {
    const rowsPromise = tab === "all"
      ? listContacts(debouncedAllSearch)
      : groupSelection === "ungrouped"
        ? listContacts(debouncedGroupSearch)
        : listContacts(debouncedGroupSearch, groupSelection);
    const [groupRows, overview, rows] = await Promise.all([listGroups(), getContactOverviewCounts(), rowsPromise]);
    setTotalContactCount(overview.total);
    setGroups(groupRows);
    groupsRef.current = groupRows;
    setGroupContactCounts(overview.groups);
    setUngroupedContactCount(overview.ungrouped);

    if (tab === "all") {
      setContacts(rows);
      return;
    }

    if (groupSelection === "ungrouped") {
      setContacts(rows.filter((contact) => contact.groups.length === 0));
      return;
    }

    setContacts(rows);
  }, [debouncedAllSearch, debouncedGroupSearch, groupSelection, tab]);

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
    listContacts(debouncedBulkAddSearch)
      .then((rows) => setBulkAddContacts(rows.filter((contact) => contact.id && !contactInGroup(contact, bulkAddGroup.id!))))
      .catch((error) => {
        setMessage(`Kontakte konnten nicht geladen werden: ${error}`);
        setMessageType("error");
      });
  }, [bulkAddGroup, debouncedBulkAddSearch]);

  const startNew = () => {
    setContactInspectorMenuOpen(false);
    setAutomaticDisplayName(true);
    setEditing({
      ...emptyContact,
      groupIds: tab === "groups" && typeof groupSelection === "number" ? [groupSelection] : []
    });
  };

  const startEditing = (contact: Contact) => {
    const contactInput = toContactInput(contact);
    setContactInspectorMenuOpen(false);
    setSelectedGroupContactId(contact.id);
    setAutomaticDisplayName(contactUsesAutomaticDisplayName(contactInput));
    setEditing(contactInput);
  };

  const reviewContactDuplicates = async () => {
    setTestMenuOpen(false);
    setDuplicateCheckBusy(true);
    try {
      const allContacts = await listContacts("");
      const matches = findContactDuplicateGroups(allContacts);
      setDuplicateGroups(matches);
      if (matches.length === 0) {
        setActionResult({
          title: "Duplikate geprüft",
          summary: "Es wurden keine möglichen Kontaktduplikate gefunden.",
          details: ["Ihre Kontakte wurden nicht verändert."],
          tone: "success"
        });
        return;
      }
      setDuplicateReviewOpen(true);
    } catch (error) {
      setActionResult({
        title: "Duplikate konnten nicht geprüft werden",
        summary: `Die Kontakte bleiben unverändert: ${error}`,
        tone: "error"
      });
    } finally {
      setDuplicateCheckBusy(false);
    }
  };

  const openDuplicateContact = (contact: Contact) => {
    setDuplicateReviewOpen(false);
    startEditing(contact);
  };

  const cleanContactDuplicates = async () => {
    setDuplicateCleanupBusy(true);
    try {
      const result = await cleanupContactDuplicates();
      const currentContacts = await listContacts("");
      const remainingGroups = findContactDuplicateGroups(currentContacts);
      setDuplicateGroups(remainingGroups);
      setDuplicateCleanupConfirmOpen(false);
      setDuplicateReviewOpen(false);
      await refresh();
      notifyLocalM365Change();

      const remainingText = remainingGroups.length > 0
        ? `${remainingGroups.length} unsichere Treffergruppen bleiben zur manuellen Prüfung erhalten.`
        : "Es sind keine weiteren möglichen Duplikate übrig.";
      setActionResult({
        title: result.removed > 0 ? "Kontaktduplikate bereinigt" : "Keine sicheren Duplikate entfernt",
        summary: result.removed > 0
          ? `${result.removed} ${result.removed === 1 ? "doppelte Kopie wurde" : "doppelte Kopien wurden"} in den Papierkorb verschoben. Jeweils ein vollständiger Kontakt bleibt erhalten.`
          : "Es wurden keine Kontakte gelöscht, weil die gefundenen Einträge nicht eindeutig genug zusammenpassen.",
        details: [
          "Ergänzende Angaben wie E-Mail-Adresse, Telefonnummer und Gruppenzuordnung wurden im erhaltenen Kontakt zusammengeführt.",
          remainingText,
          "Die entfernten Kopien können im Papierkorb wiederhergestellt werden."
        ],
        items: result.contacts.map((contact) => ({
          label: contact.displayName || "Kontakt ohne Namen",
          detail: contact.email || contact.phone || undefined
        })),
        itemsLabel: `${result.removed} entfernte ${result.removed === 1 ? "Kopie" : "Kopien"} anzeigen`,
        tone: result.removed > 0 ? "success" : "info"
      });
    } catch (error) {
      setDuplicateCleanupConfirmOpen(false);
      setActionResult({
        title: "Duplikate nicht bereinigt",
        summary: `Es wurden keine Kontakte verändert: ${error}`,
        tone: "error"
      });
    } finally {
      setDuplicateCleanupBusy(false);
    }
  };

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
      setActionResult({ title: "Gruppe erstellt", summary: `„${name}“ steht jetzt bereit.`, tone: "success" });
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
      setActionResult({ title: "Gruppe umbenannt", summary: `Die Gruppe heißt jetzt „${name}“.`, tone: "success" });
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
      const contactId = await saveContact(editing);
      saveAutomaticDisplayNamePreference(contactId, automaticDisplayName);
      setSelectedGroupContactId(contactId);
      setEditing(null);
      setActionResult({ title: "Kontakt gespeichert", summary: `„${displayName(editing)}“ wurde lokal gespeichert.`, tone: "success" });
      await refresh();
      setSelectedGroupContactId(contactId);
      notifyLocalM365Change();
    } catch (error) {
      setActionResult({ title: "Kontakt nicht gespeichert", summary: `Der Kontakt wurde nicht verändert: ${error}`, tone: "error" });
    }
  };

  const deleteContactNow = async (contact: Contact) => {
    if (!contact.id) return;
    try {
      await deleteContact(contact.id);
      setContacts((current) => current.filter((currentContact) => currentContact.id !== contact.id));
      setTotalContactCount((current) => current === null ? current : Math.max(0, current - 1));
      if (contact.groups.length === 0) {
        setUngroupedContactCount((current) => Math.max(0, current - 1));
      } else {
        const affectedGroupIds = new Set(contact.groups.map((group) => group.id).filter((id): id is number => Boolean(id)));
        setGroupContactCounts((current) => Object.fromEntries(
          Object.entries(current).map(([groupId, count]) => [
            groupId,
            affectedGroupIds.has(Number(groupId)) ? Math.max(0, count - 1) : count
          ])
        ));
      }
      setActionResult({ title: "Kontakt in den Papierkorb verschoben", summary: `„${displayName(contact)}“ kann im Papierkorb wiederhergestellt werden.`, tone: "success" });
      notifyLocalM365Change();
      void refresh().catch((error) => {
        setMessage(`Die Kontaktübersicht konnte nicht aktualisiert werden: ${error}`);
        setMessageType("error");
      });
    } catch (error) {
      setActionResult({ title: "Kontakt nicht gelöscht", summary: `Der Kontakt bleibt unverändert: ${error}`, tone: "error" });
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
      setActionResult({ title: "Gruppe in den Papierkorb verschoben", summary: `„${group.name}“ kann im Papierkorb wiederhergestellt werden.`, tone: "success" });
      await refresh();
      notifyLocalM365Change();
    } catch (error) {
      setActionResult({ title: "Gruppe nicht gelöscht", summary: `Die Gruppe bleibt unverändert: ${error}`, tone: "error" });
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
      setActionResult({ title: "Gruppe in den Papierkorb verschoben", summary: `„${ungroupedGroupName}“ kann im Papierkorb wiederhergestellt werden.`, tone: "success" });
      await refresh();
      notifyLocalM365Change();
    } catch (error) {
      setActionResult({ title: "Gruppe nicht gelöscht", summary: `„${ungroupedGroupName}“ bleibt unverändert: ${error}`, tone: "error" });
    }
  };

  const removeUngroupedGroup = () => {
    if (confirmDeletions) setDeleteRequest({ kind: "ungrouped-group" });
    else void deleteUngroupedGroupNow();
  };

  const deleteAllContactsNow = async () => {
    try {
      const affectedContacts = await listContacts("");
      const affectedGroups = [
        ...(!ungroupedGroupHidden ? [{ label: ungroupedGroupName, detail: "Gruppe" }] : []),
        ...groups.map((group) => ({ label: group.name, detail: "Gruppe" }))
      ];
      const result = await deleteAllContacts();
      setTestMenuOpen(false);
      setUngroupedGroupHidden(true);
      setGroupSelection("ungrouped");
      setTab("all");
      setActionResult({
        title: "Kontakte und Gruppen in den Papierkorb verschoben",
        summary: `${result.contacts} ${result.contacts === 1 ? "Kontakt" : "Kontakte"} und ${result.groups} ${result.groups === 1 ? "Gruppe wurden" : "Gruppen wurden"} nicht endgültig gelöscht und können wiederhergestellt werden.`,
        items: [
          ...affectedContacts.map((contact) => ({ label: displayName(contact), detail: primaryContactEmail(contact) || contact.phone || contact.privatePhone || undefined })),
          ...affectedGroups
        ],
        itemsLabel: `${result.contacts} Kontakte und ${result.groups} Gruppen anzeigen`,
        tone: "success"
      });
      await refresh();
      notifyLocalM365Change();
    } catch (error) {
      setActionResult({ title: "Kontakte und Gruppen nicht gelöscht", summary: `Kontakte und Gruppen bleiben unverändert: ${error}`, tone: "error" });
    }
  };

  const removeAllContacts = () => {
    if (confirmDeletions) setDeleteRequest({ kind: "all-contacts" });
    else void deleteAllContactsNow();
  };

  const deleteSelectedContactsNow = async (contactIds: number[], affectedContacts: Contact[]) => {
    setBulkDeleting(true);
    try {
      const deleted = await deleteContacts(contactIds);
      setSelectedContactIds(new Set());
      setSelectionMode(false);
      setActionResult({
        title: "Kontakte in den Papierkorb verschoben",
        summary: deleted === 1 ? "1 Kontakt kann im Papierkorb wiederhergestellt werden." : `${deleted} Kontakte können im Papierkorb wiederhergestellt werden.`,
        items: affectedContacts.map((contact) => ({ label: displayName(contact), detail: primaryContactEmail(contact) || contact.phone || contact.privatePhone || undefined })),
        itemsLabel: `${deleted} verschobene Kontakte anzeigen`,
        tone: "success"
      });
      await refresh();
      notifyLocalM365Change();
    } catch (error) {
      setActionResult({ title: "Kontakte nicht gelöscht", summary: `Die ausgewählten Kontakte bleiben unverändert: ${error}`, tone: "error" });
    } finally {
      setBulkDeleting(false);
    }
  };

  const removeSelectedContacts = () => {
    const contactIds = selectedVisibleContactIds;
    if (contactIds.length === 0) return;
    const affectedContacts = contacts.filter((contact) => contact.id && contactIds.includes(contact.id));
    if (confirmDeletions) setDeleteRequest({ kind: "selected-contacts", contactIds, contacts: affectedContacts });
    else void deleteSelectedContactsNow(contactIds, affectedContacts);
  };

  const confirmDeleteRequest = async () => {
    if (!deleteRequest) return;
    setDeleteBusy(true);
    try {
      if (deleteRequest.kind === "contact") await deleteContactNow(deleteRequest.contact);
      if (deleteRequest.kind === "group") await deleteGroupNow(deleteRequest.group);
      if (deleteRequest.kind === "ungrouped-group") await deleteUngroupedGroupNow();
      if (deleteRequest.kind === "all-contacts") await deleteAllContactsNow();
      if (deleteRequest.kind === "selected-contacts") await deleteSelectedContactsNow(deleteRequest.contactIds, deleteRequest.contacts);
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
    setEditing(null);
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
    dragOverGroupKeyRef.current = null;
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
      const affectedContacts = contacts.filter((contact) => contact.id && contactIds.includes(contact.id));
      setActionResult({
        title: "Kontakte verschoben",
        summary: contactIds.length === 1 ? `Der Kontakt ist jetzt in „${targetLabel}“.` : `${contactIds.length} Kontakte sind jetzt in „${targetLabel}“.`,
        items: affectedContacts.map((contact) => ({ label: displayName(contact), detail: primaryContactEmail(contact) || contact.phone || contact.privatePhone || undefined })),
        itemsLabel: `${contactIds.length} verschobene Kontakte anzeigen`,
        tone: "success"
      });
      setSelectedContactIds(new Set());
      setSelectionMode(false);
      await refresh();
      notifyLocalM365Change();
    } catch (error) {
      setActionResult({ title: "Kontakte nicht verschoben", summary: `Die Zuordnung wurde nicht geändert: ${error}`, tone: "error" });
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
      dragOverGroupKeyRef.current = target ?? null;
      setDragOverGroupKey(target ?? null);
      setDragPreview((current) => current ? { ...current, x: event.clientX, y: event.clientY } : current);
    };
    const finishPointerDrag = (event: PointerEvent) => {
      const contactIds = [...draggedContactIdsRef.current];
      const target = findGroupFromPoint(event) ?? dragOverGroupKeyRef.current ?? undefined;
      endContactDrag();
      if (contactIds.length > 0 && target !== undefined) void moveContactsToSelection(contactIds, target);
    };
    const cancelPointerDrag = () => endContactDrag();
    window.addEventListener("pointermove", updatePointerTarget);
    window.addEventListener("pointerup", finishPointerDrag);
    window.addEventListener("pointercancel", cancelPointerDrag);
    window.addEventListener("blur", cancelPointerDrag);
    return () => {
      window.removeEventListener("pointermove", updatePointerTarget);
      window.removeEventListener("pointerup", finishPointerDrag);
      window.removeEventListener("pointercancel", cancelPointerDrag);
      window.removeEventListener("blur", cancelPointerDrag);
    };
  }, [draggedContactIds]);

  const pointerOverGroup = (target: GroupSelection) => {
    if (draggedContactIdsRef.current.length === 0) return;
    dragOverGroupKeyRef.current = target;
    setDragOverGroupKey(target);
  };

  const selectContactForInspector = (contact: Contact) => {
    setSelectedGroupContactId(contact.id);
    setContactInspectorMenuOpen(false);
    setEditing(null);
  };

  const selectGroupForDirectory = (selection: GroupSelection) => {
    setEditing(null);
    setContactInspectorMenuOpen(false);
    setSelectedGroupContactId(undefined);
    setGroupSelection(selection);
  };

  const normalizePaneLayout = (layout: ContactPaneLayout): ContactPaneLayout => {
    const groups = Math.min(35, Math.max(18, layout.groups));
    const contacts = Math.min(52, Math.max(30, layout.contacts));
    return groups + contacts > 75 ? { groups, contacts: 75 - groups } : { groups, contacts };
  };

  const writePaneLayout = (layout: ContactPaneLayout) => {
    contactsWorkspaceRef.current?.style.setProperty("--groups-pane", `${layout.groups}%`);
    contactsWorkspaceRef.current?.style.setProperty("--contacts-pane", `${layout.contacts}%`);
  };

  const beginPaneResize = (pane: "groups" | "contacts", event: ReactPointerEvent<HTMLDivElement>) => {
    const workspace = contactsWorkspaceRef.current;
    if (!workspace) return;
    const bounds = workspace.getBoundingClientRect();
    event.currentTarget.setPointerCapture(event.pointerId);
    contactPaneResizeRef.current = {
      pane,
      width: bounds.width,
      left: bounds.left,
      layout: contactPaneLayout,
      nextLayout: contactPaneLayout
    };
    document.body.classList.add("resizing-contact-panes");
  };

  const resizeContactPanes = (event: ReactPointerEvent<HTMLDivElement>) => {
    const resize = contactPaneResizeRef.current;
    if (!resize) return;
    const pointerPercent = ((event.clientX - resize.left) / resize.width) * 100;
    const nextLayout = resize.pane === "groups"
      ? normalizePaneLayout({ groups: pointerPercent, contacts: resize.layout.contacts })
      : normalizePaneLayout({ groups: resize.layout.groups, contacts: pointerPercent - resize.layout.groups });
    resize.nextLayout = nextLayout;
    writePaneLayout(nextLayout);
  };

  const finishPaneResize = (event: ReactPointerEvent<HTMLDivElement>) => {
    const resize = contactPaneResizeRef.current;
    if (!resize) return;
    if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId);
    contactPaneResizeRef.current = null;
    document.body.classList.remove("resizing-contact-panes");
    setContactPaneLayout(resize.nextLayout);
    localStorage.setItem(contactPaneLayoutStorageKey, JSON.stringify(resize.nextLayout));
  };

  const adjustPaneWithKeyboard = (pane: "groups" | "contacts", delta: number) => {
    setContactPaneLayout((current) => {
      const next = normalizePaneLayout({
        groups: pane === "groups" ? current.groups + delta : current.groups,
        contacts: pane === "contacts" ? current.contacts + delta : current.contacts
      });
      writePaneLayout(next);
      localStorage.setItem(contactPaneLayoutStorageKey, JSON.stringify(next));
      return next;
    });
  };

  const openBulkAdd = (group: Group) => {
    setBulkAddGroup(group);
    setBulkAddSearch("");
    setBulkAddSelectedIds(new Set());
  };

  const openGroupContextMenu = (event: ReactMouseEvent, target: GroupContextTarget | null) => {
    event.preventDefault();
    event.stopPropagation();
    if (target?.kind === "ungrouped") selectGroupForDirectory("ungrouped");
    if (target?.kind === "group") selectGroupForDirectory(target.group.id ?? "ungrouped");
    setGroupContextMenu({ x: event.clientX, y: event.clientY, target });
  };

  const runGroupMenuAction = (action: () => void) => {
    setGroupContextMenu(null);
    action();
  };

  const groupPropertiesContactCount = groupProperties?.kind === "ungrouped"
    ? ungroupedContactCount
    : groupProperties?.kind === "group" && groupProperties.group.id
      ? (groupContactCounts[groupProperties.group.id] ?? 0)
      : 0;
  const contextMenuTarget = groupContextMenu?.target ?? null;
  const contextMenuGroup = contextMenuTarget?.kind === "group" ? contextMenuTarget.group : null;
  const inspectorEmails = selectedGroupContact ? [
    { label: "Geschäftlich", value: selectedGroupContact.email },
    { label: "Privat", value: selectedGroupContact.privateEmail },
    { label: "Privat 2", value: selectedGroupContact.secondPrivateEmail }
  ].filter((entry) => entry.value.trim()) : [];
  const inspectorPhones = selectedGroupContact ? [
    { label: "Geschäftlich", value: selectedGroupContact.phone },
    { label: "Mobil", value: selectedGroupContact.mobilePhone },
    { label: "Privat", value: selectedGroupContact.privatePhone },
    { label: "Privat 2", value: selectedGroupContact.secondPrivatePhone }
  ].filter((entry) => entry.value.trim()) : [];
  const inspectorAddress = selectedGroupContact
    ? [selectedGroupContact.street, [selectedGroupContact.postalCode, selectedGroupContact.city].filter(Boolean).join(" "), selectedGroupContact.country].filter(Boolean)
    : [];

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
    <div className={`${draggedContactIds.length === 0 ? "page contacts-page" : "page contacts-page dragging-contact"} contacts-font-${contactsFontSize}${tab === "groups" ? " groups-tab-active" : ""}`}>
      <header className="contacts-section-header">
        <strong>Kontakte</strong>
        <span aria-hidden="true">›</span>
        <div className="contacts-tabs" role="tablist" aria-label="Kontaktbereiche">
          <button className={tab === "all" ? "active" : ""} type="button" role="tab" aria-selected={tab === "all"} onClick={() => changeTab("all")}>
            Alle Kontakte
          </button>
          <button className={tab === "groups" ? "active" : ""} type="button" role="tab" aria-selected={tab === "groups"} onClick={() => changeTab("groups")}>
            Gruppen verwalten
          </button>
        </div>
      </header>

      {tab === "all" && <header className="contacts-commandbar">
        <div className="contacts-title">
          <h2>{tab === "all" ? "Alle Kontakte" : "Gruppen verwalten"}</h2>
        </div>
        <label className="search-field">
          <Search size={20} />
          <input
            value={allSearch}
            onChange={(event) => setAllSearch(event.target.value)}
            placeholder={t.search}
          />
        </label>
        <div className="button-row contacts-actions">
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
              <div className="more-menu" role="menu">
                <button type="button" onClick={() => { setTestMenuOpen(false); setM365SyncDialogOpen(true); }}><RefreshCw size={18} /> Microsoft 365 / Exchange verwalten</button>
                <span className="calendar-actions-separator" />
                <button type="button" onClick={() => { setTestMenuOpen(false); onNavigate("import"); }}><Upload size={18} /> Kontakte importieren</button>
                <button type="button" onClick={() => { setTestMenuOpen(false); onNavigate("export"); }}><Download size={18} /> Kontakte exportieren</button>
                <button type="button" onClick={() => { setTestMenuOpen(false); setReconciliationOpen(true); }}><RefreshCw size={18} /> Kontakte erneut abgleichen</button>
                <button type="button" onClick={() => void reviewContactDuplicates()} disabled={duplicateCheckBusy}>
                  <ListChecks size={18} /> {duplicateCheckBusy ? "Duplikate werden geprüft …" : "Duplikate prüfen"}
                </button>
                {!selectionMode && <button type="button" onClick={startSelectionMode}>Auswählen</button>}
                <span className="calendar-actions-separator" />
                <button className="danger" type="button" onClick={removeAllContacts}><Trash2 size={18} /> Alle Kontakte löschen</button>
              </div>
            )}
          </div>
        </div>
      </header>}

      <StatusMessage message={actionResult ? "" : message} type={messageType} />
      <ActionResultDialog result={actionResult} onClose={() => setActionResult(null)} />
      {m365SyncDialogOpen && <Microsoft365SyncDialog context="contacts" onClose={() => setM365SyncDialogOpen(false)} />}

      {duplicateReviewOpen && (
        <div className="modal-backdrop" role="dialog" aria-modal="true" aria-labelledby="contact-duplicate-title">
          <div className="modal-card contact-duplicate-dialog">
            <section className="form-panel">
              <div className="panel-heading">
                <div>
                  <h3 id="contact-duplicate-title">Mögliche Kontaktduplikate</h3>
                  <p>{duplicateCandidateCount} Kontakte in {duplicateGroups.length} {duplicateGroups.length === 1 ? "Treffergruppe" : "Treffergruppen"} gefunden.</p>
                </div>
                <button className="icon-only" type="button" aria-label="Schließen" onClick={() => { setDuplicateCleanupConfirmOpen(false); setDuplicateReviewOpen(false); }}>
                  <X size={22} />
                </button>
              </div>

              <div className="contact-duplicate-safety" role="note">
                <ShieldCheck size={21} aria-hidden="true" />
                <span><strong>Sicher bereinigen ist möglich.</strong> Die App behält automatisch den vollständigsten Kontakt, ergänzt fehlende Angaben und verschiebt nur passende Kopien in den Papierkorb. Widersprüchliche Kontakte bleiben erhalten.</span>
              </div>

              <div className="contact-duplicate-list">
                {duplicateGroups.map((group) => (
                  <article className="contact-duplicate-group" key={group.id}>
                    <header>
                      <span className={group.confidence === "high" ? "contact-duplicate-confidence high" : "contact-duplicate-confidence review"}>
                        {group.confidence === "high" ? "Starker Treffer" : "Bitte prüfen"}
                      </span>
                      <strong>{group.reason}</strong>
                      <small>{group.contacts.length} Kontakte</small>
                    </header>
                    <div>
                      {group.contacts.map((contact) => (
                        <button type="button" key={contact.id} onClick={() => openDuplicateContact(contact)}>
                          <span>
                            <strong>{displayName(contact)}</strong>
                            <small>{[primaryContactEmail(contact), contact.mobilePhone || contact.phone || contact.privatePhone].filter(Boolean).join(" · ") || "Keine E-Mail oder Telefonnummer"}</small>
                          </span>
                          <span className="contact-duplicate-open"><Pencil size={16} /> Öffnen</span>
                        </button>
                      ))}
                    </div>
                  </article>
                ))}
              </div>

              <div className="button-row contact-duplicate-actions">
                <button type="button" onClick={() => setDuplicateReviewOpen(false)} disabled={duplicateCleanupBusy}>Schließen</button>
                <button className="danger-button" type="button" onClick={() => setDuplicateCleanupConfirmOpen(true)} disabled={duplicateCleanupBusy}>
                  <Trash2 size={18} /> Alle Duplikate bereinigen
                </button>
              </div>
            </section>
          </div>
        </div>
      )}

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
                Diese Anwendung als Standard für E-Mails in DMH Backup verwenden
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
                        <small>{primaryContactEmail(contact) || "-"}</small>
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

      {editing && tab !== "groups" && (
        <div className="modal-backdrop" role="dialog" aria-modal="true" aria-label={editing.id ? t.editContact : t.newContact}>
          <div className="modal-card contact-editor-dialog">
            <ContactForm
              value={editing}
              groups={groups}
              automaticDisplayName={automaticDisplayName}
              onChange={setEditing}
              onAutomaticDisplayNameChange={setAutomaticDisplayName}
              onSubmit={submit}
              onCancel={() => setEditing(null)}
            />
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

      {tab === "all" && totalContactCount === 0 ? (
        <EmptyImportState kind="contacts" onEasyImport={() => setEasyImportOpen(true)} onManualImport={() => onNavigate("contact-import")} />
      ) : tab === "all" ? (
        <ContactTable
          contacts={contacts}
          paginationKey={`all:${allSearch}`}
          onEdit={startEditing}
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
        <section
          className="contacts-workspace"
          ref={contactsWorkspaceRef}
          style={{
            "--groups-pane": `${contactPaneLayout.groups}%`,
            "--contacts-pane": `${contactPaneLayout.contacts}%`
          } as CSSProperties}
        >
          <aside className="groups-panel group-folder-pane" onContextMenu={(event) => openGroupContextMenu(event, null)}>
            <div className="groups-panel-heading">
              <h3>Gruppen</h3>
              <button className="group-new-button" type="button" onClick={openGroupCreate}>
                <Plus size={17} /> Neue Gruppe
              </button>
            </div>
            <label className="group-list-search">
              <Search size={18} aria-hidden="true" />
              <input
                value={groupListSearch}
                onChange={(event) => setGroupListSearch(event.target.value)}
                placeholder="Gruppen suchen..."
                aria-label="Gruppen suchen"
              />
            </label>
            <div className="group-list" role="tree" aria-label="Kontaktgruppen" onContextMenu={(event) => openGroupContextMenu(event, null)}>
              {showUngroupedGroup && <div
                className={["group-folder-row", groupSelection === "ungrouped" ? "active" : "", dragOverGroupKey === "ungrouped" ? "drag-over" : ""].filter(Boolean).join(" ")}
                data-group-key="ungrouped"
                role="treeitem"
                tabIndex={0}
                aria-selected={groupSelection === "ungrouped"}
                onClick={() => selectGroupForDirectory("ungrouped")}
                onDoubleClick={() => setGroupProperties({ kind: "ungrouped" })}
                onContextMenu={(event) => openGroupContextMenu(event, { kind: "ungrouped" })}
                onKeyDown={(event) => {
                  if (event.key === "Enter" || event.key === " ") selectGroupForDirectory("ungrouped");
                }}
                onPointerEnter={() => pointerOverGroup("ungrouped")}
                onPointerLeave={() => setDragOverGroupKey((current) => current === "ungrouped" ? null : current)}
              >
                {groupSelection === "ungrouped" ? <FolderOpen size={18} aria-hidden="true" /> : <Folder size={18} aria-hidden="true" />}
                <span className="group-folder-name" title={ungroupedGroupName}>{ungroupedGroupName}</span>
                <span className="group-folder-count" aria-label={`${ungroupedContactCount} Kontakte`}>{ungroupedContactCount}</span>
                <button className="group-row-menu" type="button" title="Gruppenaktionen" aria-label={`Aktionen für ${ungroupedGroupName}`} onClick={(event) => openGroupContextMenu(event, { kind: "ungrouped" })}>
                  <Ellipsis size={18} />
                </button>
              </div>}
              {visibleGroups.map((group) => {
                const contactCount = group.id ? (groupContactCounts[group.id] ?? 0) : 0;
                return (
                  <div
                    className={["group-folder-row", groupSelection === group.id ? "active" : "", dragOverGroupKey === group.id ? "drag-over" : ""].filter(Boolean).join(" ")}
                    key={group.id}
                    data-group-key={group.id}
                    role="treeitem"
                    tabIndex={0}
                    aria-selected={groupSelection === group.id}
                    onClick={() => selectGroupForDirectory(group.id ?? "ungrouped")}
                    onDoubleClick={() => setGroupProperties({ kind: "group", group })}
                    onContextMenu={(event) => openGroupContextMenu(event, { kind: "group", group })}
                    onKeyDown={(event) => {
                      if (event.key === "Enter" || event.key === " ") selectGroupForDirectory(group.id ?? "ungrouped");
                    }}
                    onPointerEnter={() => group.id && pointerOverGroup(group.id)}
                    onPointerLeave={() => setDragOverGroupKey((current) => current === group.id ? null : current)}
                  >
                    {groupSelection === group.id ? <FolderOpen size={18} aria-hidden="true" /> : <Folder size={18} aria-hidden="true" />}
                    <span className="group-folder-name" title={group.name}>{group.name}</span>
                    <span className="group-folder-count" aria-label={`${contactCount} Kontakte`}>{contactCount}</span>
                    <button className="group-row-menu" type="button" title="Gruppenaktionen" aria-label={`Aktionen für ${group.name}`} onClick={(event) => openGroupContextMenu(event, { kind: "group", group })}>
                      <Ellipsis size={18} />
                    </button>
                  </div>
                );
              })}
              {!showUngroupedGroup && visibleGroups.length === 0 && (
                <p className="group-list-empty">Keine Gruppe gefunden.</p>
              )}
            </div>
          </aside>

          <div
            className="contact-pane-divider"
            role="separator"
            aria-label="Breite der Gruppenliste ändern"
            aria-orientation="vertical"
            aria-valuemin={18}
            aria-valuemax={35}
            aria-valuenow={Math.round(contactPaneLayout.groups)}
            tabIndex={0}
            onPointerDown={(event) => beginPaneResize("groups", event)}
            onPointerMove={resizeContactPanes}
            onPointerUp={finishPaneResize}
            onPointerCancel={finishPaneResize}
            onKeyDown={(event) => {
              if (event.key === "ArrowLeft" || event.key === "ArrowRight") {
                event.preventDefault();
                adjustPaneWithKeyboard("groups", event.key === "ArrowLeft" ? -1 : 1);
              }
            }}
          />

          <div className="contacts-main contacts-directory-pane">
            <header className="group-contacts-header">
              <div className="group-contacts-title">
                <div><h2>Kontakte</h2><span>{contacts.length} Kontakte</span></div>
                <p>{selectedGroup ? `Kontakte in „${selectedGroup.name}“ verwalten.` : `Kontakte in „${ungroupedGroupName}“ verwalten.`}</p>
              </div>
              <label className="search-field group-contact-search">
                <Search size={20} />
                <input value={groupSearch} onChange={(event) => setGroupSearch(event.target.value)} placeholder="Kontakte durchsuchen..." />
              </label>
              <div className="button-row group-contact-actions">
                {!selectionMode && <button type="button" onClick={toggleSelectionMode} disabled={bulkDeleting}>Auswählen</button>}
                <button className="primary" type="button" onClick={startNew}>
                  <Plus size={20} /> {t.newContact}
                </button>
                <div className="more-menu-wrap">
                  <button className="icon-only" type="button" aria-label="Weitere Optionen" onClick={() => setTestMenuOpen((open) => !open)}>
                    <Ellipsis size={20} />
                  </button>
                  {testMenuOpen && (
                    <div className="more-menu" role="menu">
                      <button type="button" onClick={() => { setTestMenuOpen(false); setM365SyncDialogOpen(true); }}><RefreshCw size={18} /> Microsoft 365 / Exchange verwalten</button>
                      <span className="calendar-actions-separator" />
                      <button type="button" onClick={() => { setTestMenuOpen(false); onNavigate("import"); }}><Upload size={18} /> Kontakte importieren</button>
                      <button type="button" onClick={() => { setTestMenuOpen(false); onNavigate("export"); }}><Download size={18} /> Kontakte exportieren</button>
                      <button type="button" onClick={() => { setTestMenuOpen(false); setReconciliationOpen(true); }}><RefreshCw size={18} /> Kontakte erneut abgleichen</button>
                      <button type="button" onClick={() => void reviewContactDuplicates()} disabled={duplicateCheckBusy}>
                        <ListChecks size={18} /> {duplicateCheckBusy ? "Duplikate werden geprüft …" : "Duplikate prüfen"}
                      </button>
                      <span className="calendar-actions-separator" />
                      <button className="danger" type="button" onClick={removeAllContacts}><Trash2 size={18} /> Alle Kontakte löschen</button>
                    </div>
                  )}
                </div>
              </div>
            </header>
            {selectionMode && (
              <div className="group-selection-toolbar">
                <strong>{selectedVisibleContactIds.length} Kontakte ausgewählt</strong>
                <button type="button" onClick={toggleSelectAllVisible} disabled={bulkDeleting || visibleContactIds.length === 0}>
                  {allVisibleContactsSelected ? "Auswahl aufheben" : "Alle auswählen"}
                </button>
                <button className="danger-button" type="button" onClick={removeSelectedContacts} disabled={bulkDeleting || selectedVisibleContactIds.length === 0}>
                  <Trash2 size={17} /> {bulkDeleting ? "Wird gelöscht …" : "Löschen"}
                </button>
                <button className="primary" type="button" onClick={toggleSelectionMode} disabled={bulkDeleting}>Fertig</button>
              </div>
            )}
            <ContactTable
              contacts={contacts}
              paginationKey={`groups:${groupSelection}:${groupSearch}`}
              onEdit={startEditing}
              onDelete={remove}
              onCopyEmail={copyEmail}
              onEmail={chooseEmailApp}
              selectionMode={selectionMode}
              selectedContactIds={selectedContactIds}
              onToggleSelection={toggleContactSelection}
              onPointerDragStart={startContactDrag}
              dragEnabled
              managementView
              activeContactId={selectedGroupContactId}
              onSelect={selectContactForInspector}
            />
          </div>

          <div
            className="contact-pane-divider"
            role="separator"
            aria-label="Breite der Kontaktliste ändern"
            aria-orientation="vertical"
            aria-valuemin={30}
            aria-valuemax={52}
            aria-valuenow={Math.round(contactPaneLayout.contacts)}
            tabIndex={0}
            onPointerDown={(event) => beginPaneResize("contacts", event)}
            onPointerMove={resizeContactPanes}
            onPointerUp={finishPaneResize}
            onPointerCancel={finishPaneResize}
            onKeyDown={(event) => {
              if (event.key === "ArrowLeft" || event.key === "ArrowRight") {
                event.preventDefault();
                adjustPaneWithKeyboard("contacts", event.key === "ArrowLeft" ? -1 : 1);
              }
            }}
          />

          <aside className={editing ? "contact-inspector editing" : selectedGroupContact ? "contact-inspector" : "contact-inspector empty"} aria-label="Kontaktdetails">
            {editing ? (
              <ContactForm
                value={editing}
                groups={groups}
                automaticDisplayName={automaticDisplayName}
                onChange={setEditing}
                onAutomaticDisplayNameChange={setAutomaticDisplayName}
                onSubmit={submit}
                onCancel={() => setEditing(null)}
              />
            ) : selectedGroupContact ? (
              <>
                <header className="contact-inspector-header">
                  <span className={`contact-inspector-avatar avatar-${(selectedGroupContact.id ?? 0) % 6}`} aria-hidden="true">
                    {contactInitials(selectedGroupContact)}
                  </span>
                  <div>
                    <h2>{displayName(selectedGroupContact)}</h2>
                    <p>{primaryContactEmail(selectedGroupContact) || selectedGroupContact.company || "Keine E-Mail-Adresse"}</p>
                  </div>
                  <div className="more-menu-wrap contact-inspector-more">
                    <button
                      className="icon-only"
                      type="button"
                      aria-label="Weitere Kontaktaktionen"
                      aria-expanded={contactInspectorMenuOpen}
                      onClick={() => setContactInspectorMenuOpen((open) => !open)}
                    >
                      <Ellipsis size={20} />
                    </button>
                    {contactInspectorMenuOpen && (
                      <div className="more-menu" role="menu" onPointerDown={(event) => event.stopPropagation()}>
                        {primaryContactEmail(selectedGroupContact) && (
                          <button type="button" role="menuitem" onClick={() => { setContactInspectorMenuOpen(false); void copyEmail(primaryContactEmail(selectedGroupContact)); }}>
                            E-Mail kopieren
                          </button>
                        )}
                        <button className="danger" type="button" role="menuitem" onClick={() => { setContactInspectorMenuOpen(false); remove(selectedGroupContact); }}>
                          <Trash2 size={17} /> Kontakt löschen
                        </button>
                      </div>
                    )}
                  </div>
                </header>
                <div className="contact-inspector-toolbar">
                  {primaryContactEmail(selectedGroupContact) && (
                    <button type="button" onClick={() => chooseEmailApp(primaryContactEmail(selectedGroupContact))}>
                      <Mail size={17} /> Nachricht
                    </button>
                  )}
                  <button className="primary" type="button" onClick={() => startEditing(selectedGroupContact)}>
                    <Pencil size={17} /> Bearbeiten
                  </button>
                </div>
                <div className="contact-inspector-body">
                  {(selectedGroupContact.company || selectedGroupContact.shortInfo) && (
                    <section className="contact-inspector-section">
                      <h3><Building2 size={17} />Allgemein</h3>
                      {selectedGroupContact.company && <div><span>Unternehmen</span><strong>{selectedGroupContact.company}</strong></div>}
                      {selectedGroupContact.shortInfo && <div><span>Kurzinfo</span><strong>{selectedGroupContact.shortInfo}</strong></div>}
                    </section>
                  )}
                  {inspectorEmails.length > 0 && (
                    <section className="contact-inspector-section">
                      <h3><Mail size={17} />E-Mail-Adressen</h3>
                      {inspectorEmails.map((entry) => (
                        <div key={`${entry.label}:${entry.value}`}>
                          <span>{entry.label}</span>
                          <button className="contact-inspector-link" type="button" onClick={() => chooseEmailApp(entry.value)}>{entry.value}</button>
                        </div>
                      ))}
                    </section>
                  )}
                  {inspectorPhones.length > 0 && (
                    <section className="contact-inspector-section">
                      <h3><Phone size={17} />Telefonnummern</h3>
                      {inspectorPhones.map((entry) => (
                        <div key={`${entry.label}:${entry.value}`}><span>{entry.label}</span><strong>{entry.value}</strong></div>
                      ))}
                    </section>
                  )}
                  {inspectorAddress.length > 0 && (
                    <section className="contact-inspector-section">
                      <h3><MapPin size={17} />Adresse</h3>
                      <address>{inspectorAddress.map((line) => <span key={line}>{line}</span>)}</address>
                    </section>
                  )}
                  {selectedGroupContact.groups.length > 0 && (
                    <section className="contact-inspector-section">
                      <h3><UsersRound size={17} />Gruppen</h3>
                      <div className="contact-inspector-tags">
                        {selectedGroupContact.groups.map((group) => <span key={group.id ?? group.name}>{group.name}</span>)}
                      </div>
                    </section>
                  )}
                  {selectedGroupContact.notes && (
                    <section className="contact-inspector-section">
                      <h3><StickyNote size={17} />Notizen</h3>
                      <p>{selectedGroupContact.notes}</p>
                    </section>
                  )}
                </div>
              </>
            ) : (
              <div className="contact-inspector-empty">
                <span><UserRound size={28} /></span>
                <h3>Kontakt auswählen</h3>
                <p>Wählen Sie links einen Kontakt aus, um seine Angaben hier anzuzeigen und zu bearbeiten.</p>
                <button className="primary" type="button" onClick={startNew}><Plus size={17} /> Neuer Kontakt</button>
              </div>
            )}
          </aside>
        </section>
      )}

      {groupContextMenu && (
        <div
          className="group-context-menu"
          role="menu"
          aria-label={groupContextMenu.target ? "Gruppenaktionen" : "Ordneraktionen"}
          style={{
            left: groupContextMenu.x,
            top: groupContextMenu.y,
            transform: `translate(${groupContextMenu.x > window.innerWidth / 2 ? "-100%" : "0"}, ${groupContextMenu.y > window.innerHeight / 2 ? "-100%" : "0"})`
          }}
          onPointerDown={(event) => event.stopPropagation()}
          onContextMenu={(event) => event.preventDefault()}
        >
          {contextMenuTarget && (
            <>
              <button type="button" role="menuitem" onClick={() => runGroupMenuAction(() => setGroupProperties(contextMenuTarget))}>
                <Info size={17} /> Eigenschaften
              </button>
              {contextMenuGroup && (
                <button type="button" role="menuitem" onClick={() => runGroupMenuAction(() => openBulkAdd(contextMenuGroup))}>
                  <UserPlus size={17} /> Kontakte hinzufügen
                </button>
              )}
              <button type="button" role="menuitem" onClick={() => runGroupMenuAction(() => chooseGroupEmailApp(contextMenuGroup ?? "ungrouped"))}>
                <Mail size={17} /> E-Mail an Gruppe
              </button>
              <span className="group-context-menu-separator" role="separator" />
              {contextMenuGroup && (
                <button type="button" role="menuitem" onClick={() => runGroupMenuAction(() => startGroupRename(contextMenuGroup))}>
                  <Pencil size={17} /> Umbenennen
                </button>
              )}
              <button className="danger" type="button" role="menuitem" onClick={() => runGroupMenuAction(() => contextMenuGroup ? removeGroup(contextMenuGroup) : removeUngroupedGroup())}>
                <Trash2 size={17} /> Löschen
              </button>
              <span className="group-context-menu-separator" role="separator" />
            </>
          )}
          <button type="button" role="menuitem" onClick={() => runGroupMenuAction(openGroupCreate)}>
            <FolderPlus size={17} /> Neue Gruppe
          </button>
        </div>
      )}

      {groupProperties && (
        <div className="modal-backdrop" role="dialog" aria-modal="true" aria-labelledby="group-properties-title">
          <section className="form-panel modal-card group-properties-dialog">
            <header className="group-properties-header">
              <span className="group-properties-icon"><FolderOpen size={23} /></span>
              <div>
                <h3 id="group-properties-title">Eigenschaften</h3>
                <p>{groupProperties.kind === "group" ? groupProperties.group.name : ungroupedGroupName}</p>
              </div>
              <button className="icon-only" type="button" onClick={() => setGroupProperties(null)} aria-label="Schließen"><X size={20} /></button>
            </header>
            <dl className="group-properties-list">
              <div><dt>Name</dt><dd>{groupProperties.kind === "group" ? groupProperties.group.name : ungroupedGroupName}</dd></div>
              <div><dt>Typ</dt><dd>{groupProperties.kind === "group" ? "Benutzerdefinierte Gruppe" : "Systemordner"}</dd></div>
              <div><dt>Kontakte</dt><dd>{groupPropertiesContactCount}</dd></div>
              <div className="wide"><dt>Beschreibung</dt><dd>{groupProperties.kind === "group" ? (groupProperties.group.description || "Keine Beschreibung") : "Kontakte, die keiner benutzerdefinierten Gruppe zugeordnet sind."}</dd></div>
              {groupProperties.kind === "group" && (
                <>
                  <div><dt>Erstellt</dt><dd>{formatGroupDate(groupProperties.group.createdAt)}</dd></div>
                  <div><dt>Zuletzt geändert</dt><dd>{formatGroupDate(groupProperties.group.updatedAt)}</dd></div>
                  <div><dt>Interne ID</dt><dd>{groupProperties.group.id ?? "–"}</dd></div>
                </>
              )}
            </dl>
            <footer className="group-properties-actions">
              {groupProperties.kind === "group" && (
                <button type="button" onClick={() => {
                  const group = groupProperties.group;
                  setGroupProperties(null);
                  startGroupRename(group);
                }}><Pencil size={17} /> Umbenennen</button>
              )}
              <button className="primary" type="button" onClick={() => setGroupProperties(null)}>Schließen</button>
            </footer>
          </section>
        </div>
      )}

      <ConfirmDialog
        open={duplicateCleanupConfirmOpen}
        title="Alle Kontaktduplikate bereinigen?"
        message="Die App führt ergänzende Daten zusammen, behält je Treffer einen Kontakt und verschiebt passende Kopien in den Papierkorb. Bei widersprüchlichen E-Mail-Adressen, Telefonnummern oder Adressen wird nichts gelöscht."
        confirmLabel="Duplikate bereinigen"
        notice="Vorher wird automatisch eine Wiederherstellungskopie angelegt."
        busy={duplicateCleanupBusy}
        busyLabel="Duplikate werden bereinigt …"
        onCancel={() => setDuplicateCleanupConfirmOpen(false)}
        onConfirm={() => void cleanContactDuplicates()}
      />

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
            ? "Alle Kontakte und alle vorhandenen Gruppen werden in den Papierkorb verschoben. Möchten Sie fortfahren?"
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

      <EasyImportDialog
        kind="contacts"
        open={easyImportOpen}
        onClose={() => setEasyImportOpen(false)}
        onImported={async (result) => {
          await refresh();
          setMessage(result.detail);
          setMessageType("success");
        }}
      />

      <ContactReconciliationDialog
        open={reconciliationOpen}
        onClose={() => setReconciliationOpen(false)}
        onChanged={async (nextMessage) => {
          await refresh();
          setMessage(nextMessage);
          setMessageType("success");
          notifyLocalM365Change();
        }}
      />

      {totalContactCount !== 0 && <div className="contacts-font-control" role="group" aria-label="Schriftgröße der Kontakte">
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
      </div>}
    </div>
  );
}
