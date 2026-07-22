import type { CalendarEvent, CalendarRecurrence, CalendarRecurrenceFrequency } from "../types/calendar";
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
  const update = <Key extends keyof CalendarEvent>(key: Key, fieldValue: CalendarEvent[Key]) => onChange({ ...value, [key]: fieldValue });
  const categoryNames = categories.map((category) => category.name);
  const recurrence = value.recurrence ?? null;
  const recurrencePreset = !recurrence
    ? "none"
    : recurrence.frequency === "monthly" && recurrence.interval === 6
      ? "semiannual"
      : recurrence.frequency;

  const startDate = () => {
    const date = new Date(value.startsAt);
    return Number.isNaN(date.getTime()) ? new Date() : date;
  };

  const setRecurrencePreset = (preset: string) => {
    if (preset === "none") {
      update("recurrence", null);
      return;
    }
    const start = startDate();
    const frequency: CalendarRecurrenceFrequency = preset === "semiannual" ? "monthly" : preset as CalendarRecurrenceFrequency;
    const next: CalendarRecurrence = {
      frequency,
      interval: preset === "semiannual" ? 6 : 1
    };
    if (frequency === "weekly") next.daysOfWeek = [start.getDay()];
    if (frequency === "monthly") next.dayOfMonth = start.getDate();
    if (frequency === "yearly") {
      next.dayOfMonth = start.getDate();
      next.monthOfYear = start.getMonth() + 1;
    }
    update("recurrence", next);
  };

  const updateRecurrence = (changes: Partial<CalendarRecurrence>) => {
    if (!recurrence) return;
    update("recurrence", { ...recurrence, ...changes });
  };

  const toggleRecurrenceWeekday = (weekday: number) => {
    if (!recurrence) return;
    const current = new Set(recurrence.daysOfWeek ?? [startDate().getDay()]);
    if (current.has(weekday) && current.size > 1) current.delete(weekday);
    else current.add(weekday);
    updateRecurrence({ daysOfWeek: Array.from(current).sort() });
  };

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
        <label className="field">
          <span>Wiederholung</span>
          <select value={recurrencePreset} onChange={(event) => setRecurrencePreset(event.target.value)}>
            <option value="none">Keine Wiederholung</option>
            <option value="daily">Täglich</option>
            <option value="weekly">Wöchentlich</option>
            <option value="monthly">Monatlich</option>
            <option value="semiannual">Halbjährlich</option>
            <option value="yearly">Jährlich</option>
          </select>
        </label>
        {recurrence && (
          <>
            <label className="field">
              <span>Intervall</span>
              <span className="recurrence-interval-field">
                <span>Alle</span>
                <input
                  type="number"
                  min={1}
                  max={365}
                  value={recurrence.interval}
                  onChange={(event) => updateRecurrence({ interval: Math.max(1, Number(event.target.value) || 1) })}
                />
                <span>{recurrence.frequency === "daily" ? "Tag(e)" : recurrence.frequency === "weekly" ? "Woche(n)" : recurrence.frequency === "monthly" ? "Monat(e)" : "Jahr(e)"}</span>
              </span>
            </label>
            {recurrence.frequency === "weekly" && (
              <div className="field wide">
                <span>Wochentage</span>
                <div className="recurrence-weekdays">
                  {["So", "Mo", "Di", "Mi", "Do", "Fr", "Sa"].map((label, weekday) => (
                    <button
                      className={(recurrence.daysOfWeek ?? [startDate().getDay()]).includes(weekday) ? "active" : ""}
                      type="button"
                      onClick={() => toggleRecurrenceWeekday(weekday)}
                      key={label}
                    >
                      {label}
                    </button>
                  ))}
                </div>
              </div>
            )}
            <label className="field">
              <span>Serienende</span>
              <select
                value={recurrence.count ? "count" : recurrence.until ? "until" : "never"}
                onChange={(event) => {
                  if (event.target.value === "count") updateRecurrence({ count: 10, until: undefined });
                  else if (event.target.value === "until") updateRecurrence({ until: value.startsAt.slice(0, 4) + "-12-31", count: undefined });
                  else updateRecurrence({ count: undefined, until: undefined });
                }}
              >
                <option value="never">Kein Enddatum</option>
                <option value="until">Endet am</option>
                <option value="count">Nach Anzahl</option>
              </select>
            </label>
            {recurrence.until && (
              <label className="field">
                <span>Letzter Termin</span>
                <input type="date" value={recurrence.until} onChange={(event) => updateRecurrence({ until: event.target.value })} />
              </label>
            )}
            {recurrence.count && (
              <label className="field">
                <span>Anzahl Termine</span>
                <input type="number" min={1} max={10000} value={recurrence.count} onChange={(event) => updateRecurrence({ count: Math.max(1, Number(event.target.value) || 1) })} />
              </label>
            )}
          </>
        )}
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
            <select value={value.category} onChange={(event) => updateCategory(event.target.value)}>
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
