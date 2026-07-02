import { writeText } from "@tauri-apps/plugin-clipboard-manager";
import { Download, Ellipsis, Mail, Plus, Search, Trash2, Upload, X } from "lucide-react";
import type { DragEvent } from "react";
import { useEffect, useMemo, useState } from "react";
import { ContactForm } from "../components/ContactForm";
import { ContactTable } from "../components/ContactTable";
import { StatusMessage } from "../components/StatusMessage";
import { t } from "../i18n";
import {
  deleteContact,
  deleteGroup,
  deleteAllContacts,
  listContacts,
  listGroups,
  getAppSetting,
  openNewOutlookEmail,
  openOutlookClassicEmail,
  moveContactToGroup,
  saveContact,
  saveGroup,
  setAppSetting
} from "../services/db";
import type { Contact, ContactInput, Group } from "../types/contact";
import { displayName, emptyContact, toContactInput } from "../utils/contact";
import type { Page } from "../components/Sidebar";

interface ContactsPageProps {
  onNavigate: (page: Page) => void;
}

const blankGroup: Group = { name: "", description: "", createdAt: "", updatedAt: "" };
const emailAppSettingKey = "default_email_app";
type EmailApp = "outlook-classic" | "outlook-new";

export function ContactsPage({ onNavigate }: ContactsPageProps) {
  const [contacts, setContacts] = useState<Contact[]>([]);
  const [groups, setGroups] = useState<Group[]>([]);
  const [search, setSearch] = useState("");
  const [selectedGroupId, setSelectedGroupId] = useState<number | undefined>();
  const [editing, setEditing] = useState<ContactInput | null>(null);
  const [groupForm, setGroupForm] = useState<Group>(blankGroup);
  const [testMenuOpen, setTestMenuOpen] = useState(false);
  const [message, setMessage] = useState("");
  const [messageType, setMessageType] = useState<"success" | "error" | "info">("info");
  const [emailRecipient, setEmailRecipient] = useState("");
  const [selectedEmailApp, setSelectedEmailApp] = useState<EmailApp>("outlook-classic");
  const [rememberEmailApp, setRememberEmailApp] = useState(false);
  const [draggedContactId, setDraggedContactId] = useState<number | null>(null);
  const [dragOverGroupId, setDragOverGroupId] = useState<number | null>(null);

  const selectedGroup = useMemo(() => groups.find((group) => group.id === selectedGroupId), [groups, selectedGroupId]);

  const refresh = async () => {
    const [contactRows, groupRows] = await Promise.all([listContacts(search, selectedGroupId), listGroups()]);
    setContacts(contactRows);
    setGroups(groupRows);
  };

  useEffect(() => {
    refresh().catch((error) => {
      setMessage(`Fehler beim Laden: ${error}`);
      setMessageType("error");
    });
  }, [search, selectedGroupId]);

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

  const startNew = () => {
    setEditing({ ...emptyContact });
  };

  const submitGroup = async () => {
    if (!groupForm.name.trim()) {
      setMessage("Bitte geben Sie einen Gruppennamen ein.");
      setMessageType("error");
      return;
    }
    await saveGroup(groupForm);
    setGroupForm(blankGroup);
    setMessage("Gruppe wurde erstellt.");
    setMessageType("success");
    await refresh();
  };

  const submit = async () => {
    if (!editing) return;
    try {
      await saveContact(editing);
      setEditing(null);
      setMessage("Kontakt wurde gespeichert.");
      setMessageType("success");
      await refresh();
    } catch (error) {
      setMessage(`Kontakt konnte nicht gespeichert werden: ${error}`);
      setMessageType("error");
    }
  };

  const remove = async (contact: Contact) => {
    if (!contact.id) return;
    const confirmed = window.confirm(`Kontakt "${displayName(contact)}" wirklich löschen?`);
    if (!confirmed) return;
    await deleteContact(contact.id);
    setMessage("Kontakt wurde in den Papierkorb verschoben.");
    setMessageType("success");
    await refresh();
  };

  const removeGroup = async (group: Group) => {
    if (!group.id || !window.confirm(`Gruppe "${group.name}" wirklich in den Papierkorb verschieben?`)) return;
    await deleteGroup(group.id);
    if (selectedGroupId === group.id) setSelectedGroupId(undefined);
    setMessage("Gruppe wurde in den Papierkorb verschoben.");
    setMessageType("success");
    await refresh();
  };

  const removeAllContacts = async () => {
    if (!window.confirm("Alle Kontakte wirklich in den Papierkorb verschieben? Diese Funktion ist nur zum Testen gedacht.")) return;
    const count = await deleteAllContacts();
    setTestMenuOpen(false);
    setMessage(`${count} Kontakte wurden in den Papierkorb verschoben.`);
    setMessageType("success");
    await refresh();
  };

  const copyEmail = async (email: string) => {
    await writeText(email);
    setMessage("E-Mail-Adresse wurde kopiert.");
    setMessageType("success");
  };

  const chooseEmailApp = (email: string) => {
    setEmailRecipient(email);
  };

  const sendEmail = async () => {
    if (!emailRecipient) return;
    try {
      await setAppSetting(emailAppSettingKey, rememberEmailApp ? selectedEmailApp : "");
      if (selectedEmailApp === "outlook-classic") {
        await openOutlookClassicEmail(emailRecipient);
      } else {
        await openNewOutlookEmail(emailRecipient);
      }
      setEmailRecipient("");
    } catch (error) {
      setMessage(`E-Mail-Anwendung konnte nicht geöffnet werden: ${error}`);
      setMessageType("error");
    }
  };

  const moveDraggedContact = async (event: DragEvent, group: Group) => {
    event.preventDefault();
    setDragOverGroupId(null);
    const contactId = Number(event.dataTransfer.getData("application/x-agendakontakte-contact-id") || event.dataTransfer.getData("text/plain") || draggedContactId);
    if (!contactId || !group.id) return;
    try {
      await moveContactToGroup(contactId, group.id);
      setMessage("Kontakt wurde in die Gruppe verschoben.");
      setMessageType("success");
      await refresh();
    } catch (error) {
      setMessage(`Kontakt konnte nicht verschoben werden: ${error}`);
      setMessageType("error");
    } finally {
      setDraggedContactId(null);
    }
  };

  const dragOverGroup = (event: DragEvent, groupId?: number) => {
    if (!groupId || !draggedContactId) return;
    event.preventDefault();
    event.dataTransfer.dropEffect = "move";
    setDragOverGroupId(groupId);
  };

  return (
    <div className="page contacts-page">
      <header className="contacts-commandbar">
        <div className="contacts-title">
          <h2>{t.contacts}</h2>
          {selectedGroup && <span>{selectedGroup.name}</span>}
        </div>
        <label className="search-field">
          <Search size={20} />
          <input value={search} onChange={(event) => setSearch(event.target.value)} placeholder={t.search} />
        </label>
        <div className="button-row contacts-actions">
        <button className="primary" type="button" onClick={startNew}>
          <Plus size={20} /> {t.newContact}
        </button>
        <div className="more-menu-wrap">
          <button className="icon-only" type="button" aria-label="Weitere Optionen" onClick={() => setTestMenuOpen((open) => !open)}>
            <Ellipsis size={20} />
          </button>
          {testMenuOpen && (
            <div className="more-menu">
              <button type="button" onClick={removeAllContacts}>
                Alle Kontakte löschen
              </button>
            </div>
          )}
        </div>
        <button type="button" onClick={() => onNavigate("import")}>
          <Upload size={20} /> Agenda importieren
        </button>
        <button type="button" onClick={() => onNavigate("export")}>
          <Download size={20} /> Für Outlook exportieren
        </button>
        </div>
      </header>

      <StatusMessage message={message} type={messageType} />

      {emailRecipient && (
        <div className="modal-backdrop" role="dialog" aria-modal="true" aria-label="E-Mail-Anwendung auswählen">
          <div className="modal-card email-app-dialog">
            <section className="form-panel">
              <div className="panel-heading">
                <div>
                  <h3>E-Mail senden</h3>
                  <p className="email-recipient">Empfänger: {emailRecipient}</p>
                </div>
                <button className="icon-only" type="button" aria-label="Schließen" onClick={() => setEmailRecipient("")}>
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
                <button type="button" onClick={() => setEmailRecipient("")}>Abbrechen</button>
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

      <section className="contacts-workspace">
        <aside className="groups-panel">
          <h3>Gruppen</h3>
          <div className="group-create">
            <input value={groupForm.name} onChange={(event) => setGroupForm({ ...groupForm, name: event.target.value })} placeholder="Neue Gruppe" />
            <button className="primary" type="button" onClick={submitGroup}>
              <Plus size={20} /> Erstellen
            </button>
          </div>
          <button className={!selectedGroupId ? "group-filter active" : "group-filter"} type="button" onClick={() => setSelectedGroupId(undefined)}>
            Alle Kontakte
          </button>
          {groups.map((group) => (
            <div
              className={[
                "group-drop",
                selectedGroupId === group.id ? "active" : "",
                dragOverGroupId === group.id ? "drag-over" : ""
              ].filter(Boolean).join(" ")}
              key={group.id}
              onDragOver={(event) => dragOverGroup(event, group.id)}
              onDragLeave={() => setDragOverGroupId((current) => current === group.id ? null : current)}
              onDrop={(event) => moveDraggedContact(event, group)}
            >
              <button type="button" className="group-filter" onClick={() => setSelectedGroupId(group.id)}>
                {group.name}
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
            onDragStart={setDraggedContactId}
            onDragEnd={() => {
              setDraggedContactId(null);
              setDragOverGroupId(null);
            }}
          />
        </div>
      </section>
    </div>
  );
}
