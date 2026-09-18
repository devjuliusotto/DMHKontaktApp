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

type ContactField = {
  key: keyof Omit<ContactInput, "id" | "groupIds">;
  label: string;
  wide?: boolean;
  type?: string;
};

const fieldGroups: Array<{ title: string; fields: ContactField[] }> = [
  {
    title: "Person und Unternehmen",
    fields: [
      { key: "firstName", label: "Vorname" },
      { key: "lastName", label: "Nachname" },
      { key: "displayName", label: "Anzeigename" },
      { key: "company", label: "Unternehmen" }
    ]
  },
  {
    title: "E-Mail-Adressen",
    fields: [
      { key: "email", label: "Geschäftlich", type: "email" },
      { key: "privateEmail", label: "Privat", type: "email" },
      { key: "secondPrivateEmail", label: "Privat 2", type: "email" }
    ]
  },
  {
    title: "Telefonnummern",
    fields: [
      { key: "phone", label: "Geschäftlich", type: "tel" },
      { key: "mobilePhone", label: "Mobil", type: "tel" },
      { key: "privatePhone", label: "Privat", type: "tel" },
      { key: "secondPrivatePhone", label: "Privat 2", type: "tel" }
    ]
  },
  {
    title: "Anschrift",
    fields: [
      { key: "street", label: "Straße", wide: true },
      { key: "postalCode", label: "PLZ" },
      { key: "city", label: "Stadt" },
      { key: "country", label: "Land" }
    ]
  }
];

export function ContactForm({ value, groups, onChange, onSubmit, onCancel }: ContactFormProps) {
  const invalidEmailFields = [value.email, value.privateEmail, value.secondPrivateEmail]
    .filter((email) => !isValidEmail(email));
  const emailOk = invalidEmailFields.length === 0;

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
        {fieldGroups.map((group) => (
          <div className="contact-form-group" key={group.title}>
            <h3>{group.title}</h3>
            <div className="contact-form-group-fields">
              {group.fields.map((field) => (
                <label className={field.wide ? "field wide" : "field"} key={field.key}>
                  <span>{field.label}</span>
                  <input
                    value={value[field.key]}
                    onChange={(event) => update(field.key, event.target.value)}
                    type={field.type}
                    className={field.type === "email" && !isValidEmail(String(value[field.key])) ? "invalid" : ""}
                  />
                </label>
              ))}
            </div>
          </div>
        ))}
        <label className="field wide">
          <span>Kurz-info</span>
          <input value={value.shortInfo} onChange={(event) => update("shortInfo", event.target.value)} />
        </label>
        <label className="field wide">
          <span>Notizen</span>
          <textarea value={value.notes} onChange={(event) => update("notes", event.target.value)} rows={4} />
        </label>
      </div>
      {!emailOk && <p className="field-error">Bitte prüfen Sie die markierten E-Mail-Adressen.</p>}
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
