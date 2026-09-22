import { CircleAlert, Info, Mail, MapPin, Pencil, Phone, Plus, Save, Search, StickyNote, Trash2, UserRound, UsersRound, X } from "lucide-react";
import { useState } from "react";
import type { Dispatch, SetStateAction } from "react";
import type { ContactInput, Group } from "../types/contact";
import { t } from "../i18n";
import { isValidEmail } from "../utils/validation";

interface ContactFormProps {
  value: ContactInput;
  groups: Group[];
  automaticDisplayName: boolean;
  hasUnsavedChanges?: boolean;
  embedded?: boolean;
  onChange: Dispatch<SetStateAction<ContactInput | null>>;
  onAutomaticDisplayNameChange: (enabled: boolean) => void;
  onSubmit: () => void;
  onCancel: () => void;
}

type ContactValueKey = keyof Omit<ContactInput, "id" | "groupIds">;
type ContactChannel = { key: ContactValueKey; label: string };
type ChannelVisibilitySetter = Dispatch<SetStateAction<ContactValueKey[]>>;

const emailFields: ContactChannel[] = [
  { key: "email", label: "Geschäftlich" },
  { key: "privateEmail", label: "Privat" },
  { key: "secondPrivateEmail", label: "Privat 2" }
];

const phoneFields: ContactChannel[] = [
  { key: "phone", label: "Geschäftlich" },
  { key: "mobilePhone", label: "Mobil" },
  { key: "privatePhone", label: "Privat" },
  { key: "secondPrivatePhone", label: "Privat 2" }
];

function initiallyVisibleChannels(fields: ContactChannel[], value: ContactInput): ContactValueKey[] {
  return fields.filter((field, index) => index === 0 || String(value[field.key]).trim()).map((field) => field.key);
}

function composedContactName(firstName: string, lastName: string): string {
  return `${firstName} ${lastName}`.replace(/\s+/g, " ").trim();
}

function contactInitials(name: string): string {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0 || name === "Noch nicht festgelegt") return "?";
  return (parts.length > 1 ? `${parts[0][0]}${parts[parts.length - 1][0]}` : parts[0].slice(0, 2)).toUpperCase();
}

export function ContactForm({ value, groups, automaticDisplayName, hasUnsavedChanges = false, embedded = false, onChange, onAutomaticDisplayNameChange, onSubmit, onCancel }: ContactFormProps) {
  const [groupSearch, setGroupSearch] = useState("");
  const [visibleEmailKeys, setVisibleEmailKeys] = useState<ContactValueKey[]>(() => initiallyVisibleChannels(emailFields, value));
  const [visiblePhoneKeys, setVisiblePhoneKeys] = useState<ContactValueKey[]>(() => initiallyVisibleChannels(phoneFields, value));
  const invalidEmailFields = [value.email, value.privateEmail, value.secondPrivateEmail]
    .filter((email) => !isValidEmail(email));
  const emailOk = invalidEmailFields.length === 0;
  const shownDisplayName = value.displayName.trim()
    || [value.firstName, value.lastName].filter(Boolean).join(" ").trim()
    || value.company.trim()
    || "Noch nicht festgelegt";
  const headerDetail = value.email.trim()
    || value.privateEmail.trim()
    || value.secondPrivateEmail.trim()
    || value.company.trim()
    || "Kontaktdaten direkt bearbeiten";
  const normalizedGroupSearch = groupSearch.trim().toLocaleLowerCase("de-DE");
  const visibleGroups = normalizedGroupSearch
    ? groups.filter((group) => group.name.toLocaleLowerCase("de-DE").includes(normalizedGroupSearch))
    : groups;

  const update = (key: keyof ContactInput, fieldValue: string | number[]) => {
    onChange((current) => current ? { ...current, [key]: fieldValue } : current);
  };

  const updateNamePart = (key: "firstName" | "lastName", fieldValue: string) => {
    onChange((current) => {
      if (!current) return current;
      const next = { ...current, [key]: fieldValue };
      return automaticDisplayName
        ? { ...next, displayName: composedContactName(next.firstName, next.lastName) }
        : next;
    });
  };

  const toggleAutomaticDisplayName = (enabled: boolean) => {
    onAutomaticDisplayNameChange(enabled);
    if (!enabled) return;
    onChange((current) => current
      ? { ...current, displayName: composedContactName(current.firstName, current.lastName) }
      : current);
  };

  const toggleGroup = (id: number) => {
    const exists = value.groupIds.includes(id);
    update("groupIds", exists ? value.groupIds.filter((groupId) => groupId !== id) : [...value.groupIds, id]);
  };

  const revealNextChannel = (
    fields: ContactChannel[],
    setVisibleKeys: ChannelVisibilitySetter
  ) => {
    setVisibleKeys((currentKeys) => {
      const next = fields.find((field) => !currentKeys.includes(field.key));
      return next ? [...currentKeys, next.key] : currentKeys;
    });
  };

  const clearChannel = (
    key: ContactValueKey,
    setVisibleKeys: ChannelVisibilitySetter
  ) => {
    update(key, "");
    setVisibleKeys((currentKeys) => currentKeys.length > 1
      ? currentKeys.filter((visibleKey) => visibleKey !== key)
      : currentKeys);
  };

  const changeChannelCategory = (
    currentKey: ContactValueKey,
    nextKey: ContactValueKey,
    setVisibleKeys: ChannelVisibilitySetter
  ) => {
    if (currentKey === nextKey) return;
    onChange((current) => current ? {
      ...current,
      [currentKey]: current[nextKey],
      [nextKey]: current[currentKey]
    } : current);
    setVisibleKeys((currentKeys) => currentKeys.map((key) => {
      if (key === currentKey) return nextKey;
      if (key === nextKey) return currentKey;
      return key;
    }));
  };

  const renderChannels = (
    fields: ContactChannel[],
    visibleKeys: ContactValueKey[],
    setVisibleKeys: ChannelVisibilitySetter,
    type: "email" | "tel"
  ) => fields.filter((field) => visibleKeys.includes(field.key)).map((field) => (
    <div className="contact-form-channel-row" key={field.key}>
      <input
        aria-label={`${type === "email" ? "E-Mail" : "Telefon"} ${field.label}`}
        className={type === "email" && !isValidEmail(String(value[field.key])) ? "invalid" : ""}
        type={type}
        value={String(value[field.key])}
        onChange={(event) => update(field.key, event.target.value)}
      />
      <select
        className="contact-form-channel-kind"
        aria-label={`Kategorie für ${type === "email" ? "E-Mail-Adresse" : "Telefonnummer"}`}
        value={field.key}
        onChange={(event) => changeChannelCategory(field.key, event.target.value as ContactValueKey, setVisibleKeys)}
      >
        {fields.map((category) => <option key={category.key} value={category.key}>{category.label}</option>)}
      </select>
      <button
        className="contact-form-remove-channel"
        type="button"
        onClick={() => clearChannel(field.key, setVisibleKeys)}
        aria-label={`${field.label} entfernen`}
        title="Eintrag entfernen"
      >
        <Trash2 size={16} />
      </button>
    </div>
  ));

  return (
    <form
      className={embedded ? "form-panel contact-form embedded" : "form-panel contact-form"}
      onSubmit={(event) => {
        event.preventDefault();
        if (emailOk) onSubmit();
      }}
    >
      <header className="contact-form-header">
        <span className={`contact-form-avatar avatar-${(value.id ?? 0) % 6}`} aria-hidden="true">
          {embedded ? contactInitials(shownDisplayName) : <UserRound size={24} />}
        </span>
        <div>
          <h2>{embedded && value.id ? shownDisplayName : value.id ? t.editContact : t.newContact}</h2>
          <p>{embedded ? headerDetail : "Kontaktdaten bearbeiten und verwalten"}</p>
        </div>
        {!embedded && (
          <button className="icon-only contact-form-close" type="button" onClick={onCancel} aria-label={t.cancel} title={t.cancel}>
            <X size={22} />
          </button>
        )}
      </header>

      <div className="contact-form-body">
        <section className="contact-form-group contact-form-person">
          <h3>
            <span><UserRound size={17} aria-hidden="true" />{embedded ? "Kontaktdaten" : "Person"}</span>
            {embedded && <small className="contact-form-editable-badge"><Pencil size={14} aria-hidden="true" />Direkt bearbeitbar</small>}
          </h3>
          <div className="contact-form-person-grid">
            <label className="field">
              <span>Vorname</span>
              <input autoFocus={!embedded} value={value.firstName} onChange={(event) => updateNamePart("firstName", event.target.value)} />
            </label>
            <label className="field">
              <span>Nachname</span>
              <input value={value.lastName} onChange={(event) => updateNamePart("lastName", event.target.value)} />
            </label>
            <label className="field">
              <span>Unternehmen</span>
              <input value={value.company} onChange={(event) => update("company", event.target.value)} />
            </label>
            <div className="contact-form-display-name">
              <span>Anzeigename</span>
              {automaticDisplayName ? (
                <strong title={shownDisplayName}>{shownDisplayName}</strong>
              ) : (
                <input
                  aria-label="Anzeigename"
                  value={value.displayName}
                  onChange={(event) => update("displayName", event.target.value)}
                  placeholder={shownDisplayName}
                />
              )}
              <label className="contact-form-display-name-auto">
                <input
                  type="checkbox"
                  checked={automaticDisplayName}
                  onChange={(event) => toggleAutomaticDisplayName(event.target.checked)}
                />
                <span>Automatisch aus Vor- und Nachname</span>
              </label>
            </div>
          </div>
        </section>

        <div className="contact-form-contact-grid">
          <section className="contact-form-group contact-form-channels">
            <h3><Mail size={17} aria-hidden="true" />E-Mail-Adressen</h3>
            <div className="contact-form-channel-list">
              {renderChannels(emailFields, visibleEmailKeys, setVisibleEmailKeys, "email")}
            </div>
            {visibleEmailKeys.length < emailFields.length && (
              <button className="contact-form-add-channel" type="button" onClick={() => revealNextChannel(emailFields, setVisibleEmailKeys)}>
                <Plus size={16} />Weitere E-Mail-Adresse
              </button>
            )}
          </section>

          <section className="contact-form-group contact-form-channels">
            <h3><Phone size={17} aria-hidden="true" />Telefonnummern</h3>
            <div className="contact-form-channel-list">
              {renderChannels(phoneFields, visiblePhoneKeys, setVisiblePhoneKeys, "tel")}
            </div>
            {visiblePhoneKeys.length < phoneFields.length && (
              <button className="contact-form-add-channel" type="button" onClick={() => revealNextChannel(phoneFields, setVisiblePhoneKeys)}>
                <Plus size={16} />Weitere Telefonnummer
              </button>
            )}
          </section>
        </div>

        <div className="contact-form-detail-grid">
          <section className="contact-form-group contact-form-address">
            <h3><MapPin size={17} aria-hidden="true" />Adresse</h3>
            <label className="field wide">
              <span>Straße</span>
              <input value={value.street} onChange={(event) => update("street", event.target.value)} />
            </label>
            <label className="field">
              <span>PLZ</span>
              <input value={value.postalCode} onChange={(event) => update("postalCode", event.target.value)} />
            </label>
            <label className="field">
              <span>Stadt</span>
              <input value={value.city} onChange={(event) => update("city", event.target.value)} />
            </label>
            <label className="field wide">
              <span>Land</span>
              <input value={value.country} onChange={(event) => update("country", event.target.value)} />
            </label>
          </section>

          <fieldset className="group-picker contact-form-groups">
            <legend><UsersRound size={17} aria-hidden="true" />Gruppen</legend>
            <label className="contact-form-group-search">
              <Search size={18} aria-hidden="true" />
              <input
                type="search"
                value={groupSearch}
                onChange={(event) => setGroupSearch(event.target.value)}
                placeholder="Gruppe suchen …"
                aria-label="Gruppen suchen"
              />
            </label>
            <div className="contact-form-group-options">
              {groups.length === 0 && <p>Noch keine Gruppen angelegt.</p>}
              {groups.length > 0 && visibleGroups.length === 0 && <p>Keine passende Gruppe gefunden.</p>}
              {visibleGroups.map((group) => (
                <label key={group.id} className="checkbox-row">
                  <input
                    type="checkbox"
                    checked={Boolean(group.id && value.groupIds.includes(group.id))}
                    onChange={() => group.id && toggleGroup(group.id)}
                  />
                  <span>{group.name}</span>
                </label>
              ))}
            </div>
          </fieldset>
        </div>

        <section className="contact-form-group contact-form-notes">
          <h3><StickyNote size={17} aria-hidden="true" />Weitere Angaben</h3>
          <label className="field">
            <span>Kurzinfo</span>
            <input value={value.shortInfo} onChange={(event) => update("shortInfo", event.target.value)} placeholder="Kurze Beschreibung …" />
          </label>
          <label className="field">
            <span>Notizen</span>
            <textarea value={value.notes} onChange={(event) => update("notes", event.target.value)} rows={1} placeholder="Zusätzliche Notizen …" />
          </label>
        </section>

        {!emailOk && <p className="field-error">Bitte prüfen Sie die markierten E-Mail-Adressen.</p>}
      </div>

      <footer className="contact-form-footer">
        {embedded && hasUnsavedChanges ? (
          <span className="contact-form-unsaved"><CircleAlert size={17} aria-hidden="true" />Änderungen noch nicht gespeichert</span>
        ) : (
          <span><Info size={19} aria-hidden="true" />Alle Änderungen werden erst beim Speichern übernommen.</span>
        )}
        <div className="button-row">
          <button type="button" onClick={onCancel}>{embedded ? "Änderungen verwerfen" : t.cancel}</button>
          <button className="primary" type="submit" disabled={!emailOk}>
            <Save size={18} aria-hidden="true" />{t.save}
          </button>
        </div>
      </footer>
    </form>
  );
}
