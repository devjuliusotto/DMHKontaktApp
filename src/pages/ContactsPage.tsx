import { writeText } from "@tauri-apps/plugin-clipboard-manager";
import { Ellipsis, Mail, Plus, Search, Trash2, UserPlus, X } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import { ContactForm } from "../components/ContactForm";
import { ContactTable } from "../components/ContactTable";
import { StatusMessage } from "../components/StatusMessage";
import { t } from "../i18n";
import {
  clearContactGroups,
  deleteAllContacts,
  deleteContact,
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
import { displayName, emptyContact, toContactInput } from "../utils/contact";

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

const blankGroup: Group = { name: "", description: "", createdAt: "", updatedAt: "" };
const emailAppSettingKey = "default_email_app";
const ungroupedGroupName = "Gesammelte Adressen";
const emptySelection = new Set<number>();
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
  const [tab, setTab] = useState<ContactsTab>("all");
  const [contacts, setContacts] = useState<Contact[]>([]);
  const [groups, setGroups] = useState<Group[]>([]);
  const [allSearch, setAllSearch] = useState("");
  const [groupSearch, setGroupSearch] = useState("");
  const [groupSelection, setGroupSelection] = useState<GroupSelection>("ungrouped");
  const [editing, setEditing] = useState<ContactInput | null>(null);
  const [groupForm, setGroupForm] = useState<Group>(blankGroup);
  const [testMenuOpen, setTestMenuOpen] = useState(false);
  const [message, setMessage] = useState("");
  const [messageType, setMessageType] = useState<"success" | "error" | "info">("info");
  const [emailDraft, setEmailDraft] = useState<EmailDraft | null>(null);
  const [selectedEmailApp, setSelectedEmailApp] = useState<EmailApp>("outlook-classic");
  const [rememberEmailApp, setRememberEmailApp] = useState(false);
  const [selectionMode, setSelectionMode] = useState(false);
  const [selectedContactIds, setSelectedContactIds] = useState<Set<number>>(() => new Set());
  const [draggedContactIds, setDraggedContactIds] = useState<number[]>([]);
  const [dragOverGroupKey, setDragOverGroupKey] = useState<GroupSelection | null>(null);
  const [dragPreview, setDragPreview] = useState<DragPreview | null>(null);
  const [bulkAddGroup, setBulkAddGroup] = useState<Group | null>(null);
  const [bulkAddSearch, setBulkAddSearch] = useState("");
  const [bulkAddContacts, setBulkAddContacts] = useState<Contact[]>([]);
  const [bulkAddSelectedIds, setBulkAddSelectedIds] = useState<Set<number>>(() => new Set());
  const draggedContactIdsRef = useRef<number[]>([]);
  const groupsRef = useRef<Group[]>([]);

  const selectedGroup = useMemo(
    () => (typeof groupSelection === "number" ? groups.find((group) => group.id === groupSelection) : undefined),
    [groups, groupSelection]
  );

  const selectedGroupLabel = groupSelection === "ungrouped" ? ungroupedGroupName : selectedGroup?.name ?? "";
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

  const refresh = async () => {
    const groupRows = await listGroups();
    setGroups(groupRows);
    groupsRef.current = groupRows;

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
  };

  useEffect(() => {
    refresh().catch((error) => {
      setMessage(`Fehler beim Laden: ${error}`);
      setMessageType("error");
    });
  }, [tab, allSearch, groupSearch, groupSelection]);

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
    if (!bulkAddGroup?.id) return;
    listContacts(bulkAddSearch)
      .then((rows) => setBulkAddContacts(rows.filter((contact) => contact.id && !contactInGroup(contact, bulkAddGroup.id!))))
      .catch((error) => {
        setMessage(`Kontakte konnten nicht geladen werden: ${error}`);
        setMessageType("error");
      });
  }, [bulkAddGroup, bulkAddSearch]);

  const startNew = () => setEditing({ ...emptyContact });

  const submitGroup = async () => {
    if (!groupForm.name.trim()) {
      setMessage("Bitte geben Sie einen Gruppennamen ein.");
      setMessageType("error");
      return;
    }
    const groupId = await saveGroup(groupForm);
    setGroupForm(blankGroup);
    setGroupSelection(groupId);
    setTab("groups");
    setMessage("Gruppe wurde erstellt.");
    setMessageType("success");
    await refresh();
  };

  const submit = async () => {
    if (!editing) return;
    try {
      await saveContact(editing);
      setEditing(null);
      setMessage("Kontakt wurde lokal gespeichert.");
      setMessageType("success");
      await refresh();
    } catch (error) {
      setMessage(`Kontakt konnte nicht gespeichert werden: ${error}`);
      setMessageType("error");
    }
  };

  const remove = async (contact: Contact) => {
    if (!contact.id) return;
    if (!window.confirm(`Kontakt "${displayName(contact)}" wirklich löschen?`)) return;
    try {
      await deleteContact(contact.id);
      setMessage("Kontakt wurde lokal in den Papierkorb verschoben.");
      setMessageType("success");
      await refresh();
    } catch (error) {
      setMessage(`Kontakt konnte nicht gelöscht werden: ${error}`);
      setMessageType("error");
    }
  };

  const removeGroup = async (group: Group) => {
    if (!group.id || !window.confirm(`Gruppe "${group.name}" wirklich in den Papierkorb verschieben?`)) return;
    await deleteGroup(group.id);
    if (groupSelection === group.id) setGroupSelection("ungrouped");
    setMessage("Gruppe wurde in den Papierkorb verschoben.");
    setMessageType("success");
    await refresh();
  };

  const removeAllContacts = async () => {
    const firstConfirmation = window.confirm("Alle Kontakte wirklich in den Papierkorb verschieben?");
    if (!firstConfirmation) return;

    const secondConfirmation = window.confirm(
      "Sind Sie wirklich sicher, dass Sie alle Kontakte löschen möchten? Alle Kontakte werden in den Papierkorb verschoben."
    );
    if (!secondConfirmation) return;

    const count = await deleteAllContacts();
    setTestMenuOpen(false);
    setMessage(`${count} Kontakte wurden lokal in den Papierkorb verschoben.`);
    setMessageType("success");
    await refresh();
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
    <div className={draggedContactIds.length === 0 ? "page contacts-page" : "page contacts-page dragging-contact"}>
      <div className="contacts-tabs" role="tablist" aria-label="Kontakte">
        <button className={tab === "all" ? "active" : ""} type="button" onClick={() => setTab("all")}>
          Alle Kontakte
        </button>
        <button className={tab === "groups" ? "active" : ""} type="button" onClick={() => setTab("groups")}>
          Gruppen verwalten
        </button>
      </div>

      <header className="contacts-commandbar">
        <div className="contacts-title">
          <h2>{tab === "all" ? "Alle Kontakte" : "Gruppen verwalten"}</h2>
          {tab === "groups" && <span>{selectedGroupLabel}</span>}
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
          {tab === "groups" && (
            <>
              <button className={selectionMode ? "primary" : ""} type="button" onClick={toggleSelectionMode}>
                {selectionMode ? "Fertig" : "Auswählen"}
              </button>
              {selectionMode && (
                <>
                  <button type="button" onClick={toggleSelectAllVisible} disabled={visibleContactIds.length === 0}>
                    {allVisibleContactsSelected ? "Auswahl aufheben" : "Alle auswählen"}
                  </button>
                  <span className="selection-count">{selectedVisibleContactIds.length} ausgewählt</span>
                </>
              )}
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
                Diese Anwendung als Standard für E-Mails in AgendaKontakte verwenden
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

      {tab === "all" ? (
        <ContactTable
          contacts={contacts}
          onEdit={(contact) => setEditing(toContactInput(contact))}
          onDelete={remove}
          onCopyEmail={copyEmail}
          onEmail={chooseEmailApp}
          onPrint={() => window.print()}
          selectionMode={false}
          selectedContactIds={emptySelection}
          onToggleSelection={() => undefined}
          onPointerDragStart={startContactDrag}
          dragEnabled={false}
        />
      ) : (
        <section className="contacts-workspace">
          <aside className="groups-panel">
            <h3>Gruppen</h3>
            <div className="group-create">
              <input value={groupForm.name} onChange={(event) => setGroupForm({ ...groupForm, name: event.target.value })} placeholder="Neue Gruppe" />
              <button className="primary" type="button" onClick={submitGroup}>
                <Plus size={20} /> Erstellen
              </button>
            </div>
            <div
              className={[
                "group-drop",
                groupSelection === "ungrouped" ? "active" : "",
                dragOverGroupKey === "ungrouped" ? "drag-over" : ""
              ].filter(Boolean).join(" ")}
              data-group-key="ungrouped"
              onPointerEnter={() => pointerOverGroup("ungrouped")}
              onPointerLeave={() => setDragOverGroupKey((current) => current === "ungrouped" ? null : current)}
            >
              <button type="button" className="group-filter" onClick={() => setGroupSelection("ungrouped")}>
                {ungroupedGroupName}
              </button>
              <button title="E-Mail an Gruppe" type="button" onClick={() => chooseGroupEmailApp("ungrouped")}>
                <Mail size={18} />
              </button>
            </div>
            {groups.map((group) => (
              <div
                className={[
                  "group-drop",
                  groupSelection === group.id ? "active" : "",
                  dragOverGroupKey === group.id ? "drag-over" : ""
                ].filter(Boolean).join(" ")}
                key={group.id}
                data-group-key={group.id}
                onPointerEnter={() => group.id && pointerOverGroup(group.id)}
                onPointerLeave={() => setDragOverGroupKey((current) => current === group.id ? null : current)}
              >
                <button type="button" className="group-filter" onClick={() => setGroupSelection(group.id ?? "ungrouped")}>
                  {group.name}
                </button>
                <button title="Kontakte hinzufügen" type="button" onClick={() => openBulkAdd(group)}>
                  <UserPlus size={18} />
                </button>
                <button title="E-Mail an Gruppe" type="button" onClick={() => chooseGroupEmailApp(group)}>
                  <Mail size={18} />
                </button>
                <button title="Gruppe löschen" type="button" onClick={() => removeGroup(group)}>
                  <Trash2 size={18} />
                </button>
              </div>
            ))}
          </aside>

          <div className="contacts-main">
            <ContactTable
              contacts={contacts}
              onEdit={(contact) => setEditing(toContactInput(contact))}
              onDelete={remove}
              onCopyEmail={copyEmail}
              onEmail={chooseEmailApp}
              onPrint={() => window.print()}
              selectionMode={selectionMode}
              selectedContactIds={selectedContactIds}
              onToggleSelection={toggleContactSelection}
              onPointerDragStart={startContactDrag}
              dragEnabled
            />
          </div>
        </section>
      )}
    </div>
  );
}
