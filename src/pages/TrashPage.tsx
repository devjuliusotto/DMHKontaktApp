import { RotateCcw } from "lucide-react";
import { useEffect, useState } from "react";
import { StatusMessage } from "../components/StatusMessage";
import { listDeletedContacts, listDeletedGroups, restoreContact, restoreGroup } from "../services/db";
import type { Contact, Group } from "../types/contact";
import { displayName } from "../utils/contact";

export function TrashPage() {
  const [deletedContacts, setDeletedContacts] = useState<Contact[]>([]);
  const [deletedGroups, setDeletedGroups] = useState<Group[]>([]);
  const [message, setMessage] = useState("");

  const refresh = async () => {
    const [contacts, groups] = await Promise.all([listDeletedContacts(), listDeletedGroups()]);
    setDeletedContacts(contacts);
    setDeletedGroups(groups);
  };

  useEffect(() => {
    refresh().catch((error) => setMessage(`Papierkorb konnte nicht geladen werden: ${error}`));
  }, []);

  const restoreDeletedContact = async (contact: Contact) => {
    if (!contact.id) return;
    await restoreContact(contact.id);
    setMessage("Kontakt wurde wiederhergestellt.");
    await refresh();
  };

  const restoreDeletedGroup = async (group: Group) => {
    if (!group.id) return;
    await restoreGroup(group.id);
    setMessage("Gruppe wurde wiederhergestellt.");
    await refresh();
  };

  return (
    <div className="page">
      <header className="page-header">
        <div>
          <h2>Papierkorb</h2>
          <p>Gelöschte Kontakte und Gruppen können hier wiederhergestellt werden.</p>
        </div>
      </header>
      <StatusMessage message={message} />
      <section className="trash-panel">
        <div className="trash-grid">
          <div>
            <h3>Gelöschte Kontakte</h3>
            {deletedContacts.length === 0 && <p>Keine gelöschten Kontakte.</p>}
            {deletedContacts.map((contact) => (
              <div className="trash-row" key={contact.id}>
                <span>{displayName(contact)}</span>
                <button type="button" onClick={() => restoreDeletedContact(contact)}>
                  <RotateCcw size={18} /> Wiederherstellen
                </button>
              </div>
            ))}
          </div>
          <div>
            <h3>Gelöschte Gruppen</h3>
            {deletedGroups.length === 0 && <p>Keine gelöschten Gruppen.</p>}
            {deletedGroups.map((group) => (
              <div className="trash-row" key={group.id}>
                <span>{group.name}</span>
                <button type="button" onClick={() => restoreDeletedGroup(group)}>
                  <RotateCcw size={18} /> Wiederherstellen
                </button>
              </div>
            ))}
          </div>
        </div>
      </section>
    </div>
  );
}
