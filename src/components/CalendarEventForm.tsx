import type { CalendarEvent } from "../types/calendar";
import { calendarColorOptions, calendarColorValue } from "../utils/calendar";

interface CalendarEventFormProps {
  value: CalendarEvent;
  isNew: boolean;
  categories: Array<{ name: string; color: string }>;
  onChange: (value: CalendarEvent) => void;
  onSave: () => void;
  onDelete: () => void;
  onCancel: () => void;
}

export function CalendarEventForm({ value, isNew, categories, onChange, onSave, onDelete, onCancel }: CalendarEventFormProps) {
  const update = (key: keyof CalendarEvent, fieldValue: string) => onChange({ ...value, [key]: fieldValue });
  const categoryNames = categories.map((category) => category.name);
  const categoryValue = value.category && !categoryNames.includes(value.category) ? value.category : value.category;

  const updateCategory = (categoryName: string) => {
    const category = categories.find((entry) => entry.name === categoryName);
    onChange({ ...value, category: categoryName, color: category?.color ?? value.color });
  };

  return (
    <section className="form-panel calendar-event-form">
      <h2>{isNew ? "Neuer Termin" : "Termin bearbeiten"}</h2>
      <div className="form-grid">
        <label className="field wide">
          <span>Titel</span>
          <input value={value.title} onChange={(event) => update("title", event.target.value)} autoFocus />
        </label>
        <label className="field">
          <span>Beginn</span>
          <input type="datetime-local" value={value.startsAt} onChange={(event) => update("startsAt", event.target.value)} />
        </label>
        <label className="field">
          <span>Ende</span>
          <input type="datetime-local" value={value.endsAt} onChange={(event) => update("endsAt", event.target.value)} />
        </label>
        <label className="field wide">
          <span>Ort</span>
          <input value={value.location} onChange={(event) => update("location", event.target.value)} />
        </label>
        <label className="field">
          <span>Farbe</span>
          <select value={calendarColorValue(value.color)} onChange={(event) => update("color", event.target.value)}>
            {calendarColorOptions.map((color) => (
              <option value={color.value} key={color.value}>{color.label}</option>
            ))}
          </select>
        </label>
        <label className="field">
          <span>Kategorie</span>
          {categories.length > 0 ? (
            <select value={categoryValue} onChange={(event) => updateCategory(event.target.value)}>
              <option value="">Keine Kategorie</option>
              {value.category && !categoryNames.includes(value.category) && <option value={value.category}>{value.category}</option>}
              {categories.map((category) => <option value={category.name} key={category.name}>{category.name}</option>)}
            </select>
          ) : (
            <input value={value.category} onChange={(event) => update("category", event.target.value)} placeholder="z. B. Sitzung" />
          )}
        </label>
        <label className="field wide">
          <span>Beschreibung</span>
          <textarea rows={5} value={value.description} onChange={(event) => update("description", event.target.value)} />
        </label>
      </div>
      <div className="button-row calendar-form-actions">
        <button className="primary" type="button" onClick={onSave} disabled={!value.title.trim() || !value.startsAt}>Speichern</button>
        <button type="button" onClick={onCancel}>Abbrechen</button>
        {!isNew && <button className="danger-button" type="button" onClick={onDelete}>Termin löschen</button>}
      </div>
    </section>
  );
}
