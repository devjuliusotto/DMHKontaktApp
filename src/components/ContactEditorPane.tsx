import { Plus, UserRound } from "lucide-react";
import type { Dispatch, SetStateAction } from "react";
import type { ContactInput, Group } from "../types/contact";
import { ContactForm } from "./ContactForm";

interface ContactEditorPaneProps {
  editing: ContactInput | null;
  groups: Group[];
  automaticDisplayName: boolean;
  hasUnsavedChanges: boolean;
  onChange: Dispatch<SetStateAction<ContactInput | null>>;
  onAutomaticDisplayNameChange: (enabled: boolean) => void;
  onSubmit: () => void;
  onReset: () => void;
  onNew: () => void;
}

export function ContactEditorPane({
  editing,
  groups,
  automaticDisplayName,
  hasUnsavedChanges,
  onChange,
  onAutomaticDisplayNameChange,
  onSubmit,
  onReset,
  onNew
}: ContactEditorPaneProps) {
  return (
    <aside className={editing ? "contact-inspector editing" : "contact-inspector empty"} aria-label="Kontaktdaten bearbeiten">
      {editing ? (
        <ContactForm
          key={editing.id ?? "new-contact"}
          value={editing}
          groups={groups}
          automaticDisplayName={automaticDisplayName}
          hasUnsavedChanges={hasUnsavedChanges}
          embedded
          onChange={onChange}
          onAutomaticDisplayNameChange={onAutomaticDisplayNameChange}
          onSubmit={onSubmit}
          onCancel={onReset}
        />
      ) : (
        <div className="contact-inspector-empty">
          <span><UserRound size={28} /></span>
          <h3>Kontakt auswählen</h3>
          <p>Ein Klick auf einen Kontakt öffnet seine Angaben hier direkt als bearbeitbare Felder.</p>
          <button className="primary" type="button" onClick={onNew}><Plus size={17} /> Neuer Kontakt</button>
        </div>
      )}
    </aside>
  );
}
