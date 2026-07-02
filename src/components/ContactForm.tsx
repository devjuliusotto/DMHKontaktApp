import type { ContactInput, Group } from "../types/contact";
import { t } from "../i18n";
import { isValidEmail } from "../utils/validation";

interface ContactFormProps {
  value: ContactInput;
  groups: Group[];
  onChange: (value: ContactInput) => void;
  onSubmit: () => void;
  onCancel: () => void;
}

const fields: Array<{ key: keyof Omit<ContactInput, "id" | "groupIds">; label: string; wide?: boolean }> = [
  { key: "firstName", label: "Vorname" },
  { key: "lastName", label: "Nachname" },
  { key: "displayName", label: "Anzeigename" },
  { key: "email", label: "E-Mail" },
  { key: "phone", label: "Telefon" },
  { key: "mobilePhone", label: "Mobiltelefon" },
  { key: "street", label: "Straße", wide: true },
  { key: "postalCode", label: "PLZ" },
  { key: "city", label: "Stadt" },
  { key: "country", label: "Land" }
];

export function ContactForm({ value, groups, onChange, onSubmit, onCancel }: ContactFormProps) {
  const emailOk = isValidEmail(value.email);

  const update = (key: keyof ContactInput, fieldValue: string | number[]) => {
    onChange({ ...value, [key]: fieldValue });
  };

  const toggleGroup = (id: number) => {
    const exists = value.groupIds.includes(id);
    update("groupIds", exists ? value.groupIds.filter((groupId) => groupId !== id) : [...value.groupIds, id]);
  };

  return (
    <section className="form-panel">
      <h2>{value.id ? t.editContact : t.newContact}</h2>
      <div className="form-grid">
        {fields.map((field) => (
          <label className={field.wide ? "field wide" : "field"} key={field.key}>
            <span>{field.label}</span>
            <input
              value={value[field.key]}
              onChange={(event) => update(field.key, event.target.value)}
              className={field.key === "email" && !emailOk ? "invalid" : ""}
            />
          </label>
        ))}
        <label className="field wide">
          <span>Notizen</span>
          <textarea value={value.notes} onChange={(event) => update("notes", event.target.value)} rows={4} />
        </label>
      </div>
      {!emailOk && <p className="field-error">Bitte geben Sie eine gültige E-Mail-Adresse ein.</p>}
      <fieldset className="group-picker">
        <legend>Gruppen</legend>
        {groups.length === 0 && <p>Noch keine Gruppen angelegt.</p>}
        {groups.map((group) => (
          <label key={group.id} className="checkbox-row">
            <input
              type="checkbox"
              checked={Boolean(group.id && value.groupIds.includes(group.id))}
              onChange={() => group.id && toggleGroup(group.id)}
            />
            <span>{group.name}</span>
          </label>
        ))}
      </fieldset>
      <div className="button-row">
        <button className="primary" type="button" onClick={onSubmit} disabled={!emailOk}>
          {t.save}
        </button>
        <button type="button" onClick={onCancel}>
          {t.cancel}
        </button>
      </div>
    </section>
  );
}
