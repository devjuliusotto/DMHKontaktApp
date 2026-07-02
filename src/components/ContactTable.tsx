import { Copy, Edit, Mail, Printer, Trash2 } from "lucide-react";
import { useState } from "react";
import type { Contact } from "../types/contact";
import { displayName } from "../utils/contact";
import { t } from "../i18n";

interface ContactTableProps {
  contacts: Contact[];
  onEdit: (contact: Contact) => void;
  onDelete: (contact: Contact) => void;
  onCopyEmail: (email: string) => void;
  onEmail: (email: string) => void;
  onPrint: () => void;
}

export function ContactTable({ contacts, onEdit, onDelete, onCopyEmail, onEmail, onPrint }: ContactTableProps) {
  const [selectedContactId, setSelectedContactId] = useState<number | undefined>();

  return (
    <section className="table-panel contacts-list-panel">
      <div className="panel-heading">
        <h2>{t.contacts} <span className="contact-count">{contacts.length}</span></h2>
        <button type="button" onClick={onPrint}>
          <Printer size={22} /> Drucken
        </button>
      </div>
      <div className="table-wrap">
        <table className="contacts-table">
          <colgroup>
            <col className="contact-name-column" />
            <col className="contact-email-column" />
            <col className="contact-actions-column" />
          </colgroup>
          <thead>
            <tr>
              <th>Name</th>
              <th>E-Mail</th>
              <th>Aktionen</th>
            </tr>
          </thead>
          <tbody>
            {contacts.map((contact) => (
              <tr
                key={contact.id}
                className={selectedContactId === contact.id ? "selected" : ""}
                tabIndex={0}
                onClick={() => setSelectedContactId(contact.id)}
                onDoubleClick={() => onEdit(contact)}
                onFocus={() => setSelectedContactId(contact.id)}
              >
                <td className="contact-primary" title={displayName(contact)}>
                  <strong>{displayName(contact)}</strong>
                </td>
                <td className="contact-value" title={contact.email}>
                  <div className="contact-email-content">
                    <span>{contact.email || "-"}</span>
                    {contact.email && (
                      <button title="E-Mail kopieren" type="button" onClick={() => onCopyEmail(contact.email)}>
                        <Copy size={16} />
                      </button>
                    )}
                  </div>
                </td>
                <td>
                  <div className="inline-actions">
                    <button title={t.editContact} type="button" onClick={() => onEdit(contact)}>
                      <Edit size={16} />
                    </button>
                    {contact.email && (
                      <button title="E-Mail-Anwendung auswählen" type="button" onClick={() => onEmail(contact.email)}>
                        <Mail size={16} />
                      </button>
                    )}
                    <button title={t.deleteContact} type="button" onClick={() => onDelete(contact)}>
                      <Trash2 size={16} />
                    </button>
                  </div>
                </td>
              </tr>
            ))}
            {contacts.length === 0 && (
              <tr>
                <td colSpan={3} className="empty-row">
                  Keine Kontakte gefunden.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </section>
  );
}
