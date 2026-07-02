import type { CalendarEvent } from "../types/calendar";
import { calendarColorOptions, calendarColorValue } from "../utils/calendar";

interface CalendarEventFormProps {
  value: CalendarEvent;
  isNew: boolean;
  onChange: (value: CalendarEvent) => void;
  onSave: () => void;
  onDelete: () => void;
  onCancel: () => void;
}

export function CalendarEventForm({ value, isNew, onChange, onSave, onDelete, onCancel }: CalendarEventFormProps) {
  const update = (key: keyof CalendarEvent, fieldValue: string) => onChange({ ...value, [key]: fieldValue });

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
          <input value={value.category} onChange={(event) => update("category", event.target.value)} placeholder="z. B. Sitzung" />
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
