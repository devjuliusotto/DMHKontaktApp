import { CalendarDays, ChevronLeft, ChevronRight, Edit, List, Plus, Rows3, Trash2, X } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { CalendarEventForm } from "../components/CalendarEventForm";
import { StatusMessage } from "../components/StatusMessage";
import type { CalendarEvent } from "../types/calendar";
import { calendarColorOptions, calendarColorStyle, calendarColorValue, defaultCalendarColor, formatCalendarDate, parseCalendarDate } from "../utils/calendar";

const storageKey = "agendakontakte.calendarEvents";
const categoriesStorageKey = "agendakontakte.calendarCategories";
const weekdays = ["Mo", "Di", "Mi", "Do", "Fr", "Sa", "So"];
type CalendarView = "month" | "week" | "list";
type CalendarDateFilter = "all" | "year" | "month" | "day";
type CalendarCategory = {
  name: string;
  color: string;
};
const allCategoriesValue = "__all__";
const calendarMonths = [
  "Januar",
  "Februar",
  "März",
  "April",
  "Mai",
  "Juni",
  "Juli",
  "August",
  "September",
  "Oktober",
  "November",
  "Dezember"
];

function startOfDay(date: Date): Date {
  return new Date(date.getFullYear(), date.getMonth(), date.getDate());
}

function addDays(date: Date, days: number): Date {
  const result = new Date(date);
  result.setDate(result.getDate() + days);
  return result;
}

function startOfWeek(date: Date): Date {
  const day = date.getDay() || 7;
  return addDays(startOfDay(date), 1 - day);
}

function sameDay(left: Date, right: Date): boolean {
  return left.getFullYear() === right.getFullYear() && left.getMonth() === right.getMonth() && left.getDate() === right.getDate();
}

function daysInMonth(year: number, month: number): number {
  return new Date(year, month + 1, 0).getDate();
}

function clampDay(year: number, month: number, day: number): number {
  return Math.min(Math.max(day, 1), daysInMonth(year, month));
}

function eventDate(event: CalendarEvent): Date | null {
  return parseCalendarDate(event.startsAt);
}

function eventMatchesDateFilter(event: CalendarEvent, cursor: Date, filter: CalendarDateFilter): boolean {
  if (filter === "all") return true;
  const date = eventDate(event);
  if (!date) return false;
  if (date.getFullYear() !== cursor.getFullYear()) return false;
  if (filter === "year") return true;
  if (date.getMonth() !== cursor.getMonth()) return false;
  if (filter === "month") return true;
  return sameDay(date, cursor);
}

function eventTime(event: CalendarEvent): string {
  const date = eventDate(event);
  return date ? new Intl.DateTimeFormat("de-DE", { hour: "2-digit", minute: "2-digit" }).format(date) : "";
}

function toLocalDateTime(value: string): string {
  const date = parseCalendarDate(value);
  if (!date) return value.slice(0, 16);
  const local = new Date(date.getTime() - date.getTimezoneOffset() * 60_000);
  return local.toISOString().slice(0, 16);
}

function blankEvent(date = new Date()): CalendarEvent {
  const starts = new Date(date);
  starts.setMinutes(Math.ceil(starts.getMinutes() / 30) * 30, 0, 0);
  const ends = new Date(starts.getTime() + 60 * 60 * 1000);
  return {
    id: crypto.randomUUID(),
    title: "",
    startsAt: toLocalDateTime(starts.toISOString()),
    endsAt: toLocalDateTime(ends.toISOString()),
    location: "",
    description: "",
    color: defaultCalendarColor,
    category: "",
    source: "AgendaKontakte"
  };
}

function normalizeEvent(event: CalendarEvent): CalendarEvent {
  return {
    ...event,
    color: calendarColorValue(event.color),
    category: event.category ?? ""
  };
}

function normalizeCategory(category: CalendarCategory): CalendarCategory {
  return {
    name: category.name.trim(),
    color: calendarColorValue(category.color)
  };
}

export function CalendarPage() {
  const [events, setEvents] = useState<CalendarEvent[]>([]);
  const [categories, setCategories] = useState<CalendarCategory[]>([]);
  const [message, setMessage] = useState("");
  const [view, setView] = useState<CalendarView>("month");
  const [cursor, setCursor] = useState(() => startOfDay(new Date()));
  const [editingEvent, setEditingEvent] = useState<CalendarEvent | null>(null);
  const [editingIsNew, setEditingIsNew] = useState(false);
  const [categoryFilter, setCategoryFilter] = useState(allCategoriesValue);
  const [dateFilter, setDateFilter] = useState<CalendarDateFilter>("all");
  const [showCategoryDialog, setShowCategoryDialog] = useState(false);
  const [newCategoryName, setNewCategoryName] = useState("");
  const [newCategoryColor, setNewCategoryColor] = useState(defaultCalendarColor);

  useEffect(() => {
    const saved = localStorage.getItem(storageKey);
    if (saved) {
      const storedEvents = (JSON.parse(saved) as CalendarEvent[]).map(normalizeEvent);
      setEvents(storedEvents);
    }

    const savedCategories = localStorage.getItem(categoriesStorageKey);
    if (savedCategories) {
      const storedCategories = (JSON.parse(savedCategories) as CalendarCategory[]).map(normalizeCategory).filter((category) => category.name);
      setCategories(storedCategories);
    }
  }, []);

  const allSortedEvents = useMemo(
    () => [...events].sort((left, right) => left.startsAt.localeCompare(right.startsAt)),
    [events]
  );
  const categoryOptions = useMemo(
    () => {
      const names = new Set<string>();
      for (const category of categories) if (category.name.trim()) names.add(category.name.trim());
      for (const event of events) if (event.category.trim()) names.add(event.category.trim());
      return Array.from(names).sort((left, right) => left.localeCompare(right, "de"));
    },
    [categories, events]
  );
  const sortedEvents = useMemo(
    () => {
      const byCategory = categoryFilter === allCategoriesValue
        ? allSortedEvents
        : allSortedEvents.filter((event) => event.category.trim() === categoryFilter);
      return byCategory.filter((event) => eventMatchesDateFilter(event, cursor, dateFilter));
    },
    [allSortedEvents, categoryFilter, cursor, dateFilter]
  );

  const monthDays = useMemo(() => {
    const first = new Date(cursor.getFullYear(), cursor.getMonth(), 1);
    const gridStart = startOfWeek(first);
    return Array.from({ length: 42 }, (_, index) => addDays(gridStart, index));
  }, [cursor]);

  const weekDays = useMemo(() => {
    const first = startOfWeek(cursor);
    return Array.from({ length: 7 }, (_, index) => addDays(first, index));
  }, [cursor]);

  const eventsForDay = (day: Date) => sortedEvents.filter((event) => {
    const date = eventDate(event);
    return date ? sameDay(date, day) : false;
  });

  const title = view === "month"
    ? new Intl.DateTimeFormat("de-DE", { month: "long", year: "numeric" }).format(cursor)
    : view === "week"
      ? `${new Intl.DateTimeFormat("de-DE", { day: "2-digit", month: "2-digit" }).format(weekDays[0])} - ${new Intl.DateTimeFormat("de-DE", { day: "2-digit", month: "2-digit", year: "numeric" }).format(weekDays[6])}`
      : `${sortedEvents.length} Termine`;

  const setCalendarYear = (year: number) => {
    if (!Number.isFinite(year)) return;
    setCursor((current) => new Date(year, current.getMonth(), clampDay(year, current.getMonth(), current.getDate())));
    setDateFilter("year");
  };

  const setCalendarMonth = (month: number) => {
    if (!Number.isFinite(month)) return;
    setCursor((current) => new Date(current.getFullYear(), month, clampDay(current.getFullYear(), month, current.getDate())));
    setDateFilter("month");
  };

  const setCalendarDay = (day: number) => {
    if (!Number.isFinite(day)) return;
    setCursor((current) => new Date(current.getFullYear(), current.getMonth(), clampDay(current.getFullYear(), current.getMonth(), day)));
    setDateFilter("day");
  };

  const persist = (nextEvents: CalendarEvent[]) => {
    const sorted = nextEvents.map(normalizeEvent).sort((a, b) => a.startsAt.localeCompare(b.startsAt));
    setEvents(sorted);
    localStorage.setItem(storageKey, JSON.stringify(sorted));
  };

  const persistCategories = (nextCategories: CalendarCategory[]) => {
    const byName = new Map<string, CalendarCategory>();
    for (const category of nextCategories.map(normalizeCategory).filter((entry) => entry.name)) {
      byName.set(category.name.toLowerCase(), category);
    }
    const sorted = Array.from(byName.values()).sort((left, right) => left.name.localeCompare(right.name, "de"));
    setCategories(sorted);
    localStorage.setItem(categoriesStorageKey, JSON.stringify(sorted));
  };

  const createCategory = () => {
    const name = newCategoryName.trim();
    if (!name) {
      setMessage("Bitte geben Sie einen Kategorienamen ein.");
      return;
    }
    if (categories.some((category) => category.name.toLowerCase() === name.toLowerCase())) {
      setMessage("Diese Kategorie gibt es bereits.");
      return;
    }
    persistCategories([...categories, { name, color: newCategoryColor }]);
    setNewCategoryName("");
    setNewCategoryColor(defaultCalendarColor);
    setShowCategoryDialog(false);
    setMessage(`Kategorie "${name}" wurde erstellt.`);
  };

  const move = (direction: number) => {
    if (view === "month") setCursor(new Date(cursor.getFullYear(), cursor.getMonth() + direction, 1));
    if (view === "week") setCursor(addDays(cursor, direction * 7));
  };

  const openNewEvent = (date = cursor) => {
    const event = blankEvent(date);
    const firstCategory = categories[0];
    setEditingEvent(firstCategory ? { ...event, category: firstCategory.name, color: firstCategory.color } : event);
    setEditingIsNew(true);
  };

  const openEvent = (event: CalendarEvent) => {
    setEditingEvent({ ...normalizeEvent(event), startsAt: toLocalDateTime(event.startsAt), endsAt: toLocalDateTime(event.endsAt) });
    setEditingIsNew(false);
  };

  const saveEvent = () => {
    if (!editingEvent) return;
    const next = events.filter((event) => event.id !== editingEvent.id);
    const matchingCategory = categories.find((category) => category.name === editingEvent.category.trim());
    persist([...next, normalizeEvent({ ...editingEvent, color: matchingCategory?.color ?? editingEvent.color, source: editingEvent.source || "AgendaKontakte" })]);
    const date = eventDate(editingEvent);
    if (date) setCursor(startOfDay(date));
    setEditingEvent(null);
    setMessage(editingIsNew ? "Termin wurde erstellt." : "Termin wurde aktualisiert.");
  };

  const deleteEvent = (event = editingEvent) => {
    if (!event || !window.confirm(`Termin "${event.title}" wirklich löschen?`)) return;
    persist(events.filter((entry) => entry.id !== event.id));
    setEditingEvent(null);
    setMessage("Termin wurde gelöscht.");
  };

  return (
    <div className="page calendar-page">
      <header className="page-header">
        <div>
          <h2>Kalender</h2>
          <p>Monats-, Wochen- oder Listenansicht für importierte Termine.</p>
        </div>
        <div className="button-row">
          <button className="primary" type="button" onClick={() => openNewEvent(new Date())}>
            <Plus size={20} /> Neuer Termin
          </button>
          <button type="button" onClick={() => setShowCategoryDialog(true)}>
            <Plus size={20} /> Kategorie erstellen
          </button>
        </div>
      </header>
      <StatusMessage message={message} />

      {showCategoryDialog && (
        <div className="modal-backdrop" role="dialog" aria-modal="true" aria-label="Kategorie erstellen">
          <div className="modal-card calendar-category-dialog">
            <section className="form-panel">
              <div className="panel-heading">
                <h3>Kategorie erstellen</h3>
                <button className="icon-only" type="button" aria-label="Schließen" onClick={() => setShowCategoryDialog(false)}>
                  <X size={22} />
                </button>
              </div>
              <div className="form-grid">
                <label className="field">
                  <span>Name</span>
                  <input value={newCategoryName} onChange={(event) => setNewCategoryName(event.target.value)} placeholder="z. B. Sitzung" autoFocus />
                </label>
                <label className="field">
                  <span>Farbe</span>
                  <select value={newCategoryColor} onChange={(event) => setNewCategoryColor(event.target.value)}>
                    {calendarColorOptions.map((color) => <option value={color.value} key={color.value}>{color.label}</option>)}
                  </select>
                </label>
              </div>
              <div className="button-row">
                <button className="primary" type="button" onClick={createCategory}>Speichern</button>
                <button type="button" onClick={() => setShowCategoryDialog(false)}>Abbrechen</button>
              </div>
            </section>
          </div>
        </div>
      )}

      {editingEvent && (
        <div className="modal-backdrop" role="dialog" aria-modal="true" aria-label={editingIsNew ? "Neuer Termin" : "Termin bearbeiten"}>
          <div className="modal-card calendar-event-dialog">
            <CalendarEventForm
              value={editingEvent}
              isNew={editingIsNew}
              categories={categories}
              onChange={setEditingEvent}
              onSave={saveEvent}
              onDelete={() => deleteEvent()}
              onCancel={() => setEditingEvent(null)}
            />
          </div>
        </div>
      )}

      <section className="calendar-toolbar">
        <div className="calendar-navigation">
          {view !== "list" && (
            <>
              <button className="icon-only compact" type="button" aria-label="Vorheriger Zeitraum" onClick={() => move(-1)}><ChevronLeft size={20} /></button>
              <button type="button" onClick={() => setCursor(startOfDay(new Date()))}>Heute</button>
              <button className="icon-only compact" type="button" aria-label="Nächster Zeitraum" onClick={() => move(1)}><ChevronRight size={20} /></button>
            </>
          )}
          <h3>{title}</h3>
        </div>
        <div className="calendar-date-filter" aria-label="Kalenderzeitraum">
          <label>
            <span>Zeitraum</span>
            <select value={dateFilter} onChange={(event) => setDateFilter(event.target.value as CalendarDateFilter)}>
              <option value="all">Alle</option>
              <option value="year">Jahr</option>
              <option value="month">Monat</option>
              <option value="day">Tag</option>
            </select>
          </label>
          <label>
            <span>Jahr</span>
            <input
              type="number"
              min="1900"
              max="2100"
              value={cursor.getFullYear()}
              onChange={(event) => {
                if (event.target.value) setCalendarYear(Number(event.target.value));
              }}
            />
          </label>
          <label>
            <span>Monat</span>
            <select value={cursor.getMonth()} onChange={(event) => setCalendarMonth(Number(event.target.value))}>
              {calendarMonths.map((month, index) => <option value={index} key={month}>{month}</option>)}
            </select>
          </label>
          <label>
            <span>Tag</span>
            <input
              type="number"
              min="1"
              max={daysInMonth(cursor.getFullYear(), cursor.getMonth())}
              value={cursor.getDate()}
              onChange={(event) => {
                if (event.target.value) setCalendarDay(Number(event.target.value));
              }}
            />
          </label>
        </div>
        <div className="calendar-view-switch" aria-label="Kalenderansicht">
          <button className={view === "month" ? "active" : ""} type="button" onClick={() => setView("month")}><CalendarDays size={18} /> Monat</button>
          <button className={view === "week" ? "active" : ""} type="button" onClick={() => setView("week")}><Rows3 size={18} /> Woche</button>
          <button className={view === "list" ? "active" : ""} type="button" onClick={() => setView("list")}><List size={18} /> Liste</button>
        </div>
        <label className="calendar-category-filter">
          <span>Kategorie</span>
          <select value={categoryFilter} onChange={(event) => setCategoryFilter(event.target.value)}>
            <option value={allCategoriesValue}>Alle Kategorien</option>
            {categoryOptions.map((category) => <option value={category} key={category}>{category}</option>)}
          </select>
        </label>
      </section>

      {view === "month" && (
        <section className="calendar-grid month-view">
          {weekdays.map((day) => <div className="calendar-weekday" key={day}>{day}</div>)}
          {monthDays.map((day) => {
            const dayEvents = eventsForDay(day);
            const classes = ["calendar-day", day.getMonth() !== cursor.getMonth() ? "outside" : "", sameDay(day, new Date()) ? "today" : ""].filter(Boolean).join(" ");
            return (
              <div className={classes} key={day.toISOString()} onDoubleClick={() => openNewEvent(day)}>
                <span className="calendar-day-number">{day.getDate()}</span>
                <div className="calendar-day-events">
                  {dayEvents.slice(0, 3).map((event) => <button className="calendar-event-chip" style={calendarColorStyle(event.color)} type="button" title={`${event.title} - ${event.location}`} key={event.id} onClick={(click) => { click.stopPropagation(); openEvent(event); }}><time>{eventTime(event)}</time> {event.title}</button>)}
                  {dayEvents.length > 3 && <small>+ {dayEvents.length - 3} weitere</small>}
                </div>
              </div>
            );
          })}
        </section>
      )}

      {view === "week" && (
        <section className="calendar-grid week-view">
          {weekDays.map((day) => (
            <div className={sameDay(day, new Date()) ? "calendar-week-column today" : "calendar-week-column"} key={day.toISOString()}>
              <header><span>{weekdays[(day.getDay() || 7) - 1]}</span><strong>{day.getDate()}</strong></header>
              <div className="calendar-week-events">
                {eventsForDay(day).map((event) => (
                  <button className="calendar-week-event" style={calendarColorStyle(event.color)} type="button" key={event.id} onClick={() => openEvent(event)}>
                    <time>{eventTime(event)}</time>
                    <strong>{event.title}</strong>
                    {event.category && <small>{event.category}</small>}
                    {event.location && <small>{event.location}</small>}
                  </button>
                ))}
                {eventsForDay(day).length === 0 && <span className="calendar-empty-day">Keine Termine</span>}
              </div>
            </div>
          ))}
        </section>
      )}

      {view === "list" && (
        <section className="table-panel calendar-list-panel">
          <div className="table-wrap">
            <table className="calendar-list-table">
              <colgroup><col className="calendar-title-column" /><col className="calendar-date-column" /><col className="calendar-date-column" /><col className="calendar-category-column" /><col className="calendar-location-column" /><col className="calendar-actions-column" /></colgroup>
              <thead><tr><th>Termin</th><th>Beginn</th><th>Ende</th><th>Kategorie</th><th>Ort</th><th>Aktionen</th></tr></thead>
              <tbody>
                {sortedEvents.map((event) => (
                  <tr key={event.id} tabIndex={0} onDoubleClick={() => openEvent(event)}>
                    <td title={event.description}><span className="calendar-color-dot" style={calendarColorStyle(event.color)} /><strong>{event.title}</strong></td>
                    <td>{formatCalendarDate(event.startsAt)}</td>
                    <td>{formatCalendarDate(event.endsAt)}</td>
                    <td>{event.category}</td>
                    <td>{event.location}</td>
                    <td><div className="inline-actions"><button title="Termin bearbeiten" type="button" onClick={() => openEvent(event)}><Edit size={16} /></button><button title="Termin löschen" type="button" onClick={() => deleteEvent(event)}><Trash2 size={16} /></button></div></td>
                  </tr>
                ))}
                {sortedEvents.length === 0 && <tr><td colSpan={6} className="empty-row">Keine Termine importiert.</td></tr>}
              </tbody>
            </table>
          </div>
        </section>
      )}
    </div>
  );
}
