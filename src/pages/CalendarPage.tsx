import { open, save } from "@tauri-apps/plugin-dialog";
import { readFile } from "@tauri-apps/plugin-fs";
import { CalendarDays, CalendarPlus, ChevronLeft, ChevronRight, Download, Edit, List, Plus, Rows3, Trash2 } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { CalendarEventForm } from "../components/CalendarEventForm";
import { StatusMessage } from "../components/StatusMessage";
import { importOutlookStore, writeExportFile } from "../services/db";
import type { CalendarEvent } from "../types/calendar";
import { calendarColorStyle, calendarColorValue, defaultCalendarColor, exportCalendarIcs, formatCalendarDate, parseCalendarDate, parseCalendarFile } from "../utils/calendar";

const storageKey = "agendakontakte.calendarEvents";
const weekdays = ["Mo", "Di", "Mi", "Do", "Fr", "Sa", "So"];
type CalendarView = "month" | "week" | "list";
const allCategoriesValue = "__all__";

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

function eventDate(event: CalendarEvent): Date | null {
  return parseCalendarDate(event.startsAt);
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

export function CalendarPage() {
  const [events, setEvents] = useState<CalendarEvent[]>([]);
  const [message, setMessage] = useState("");
  const [view, setView] = useState<CalendarView>("month");
  const [cursor, setCursor] = useState(() => startOfDay(new Date()));
  const [editingEvent, setEditingEvent] = useState<CalendarEvent | null>(null);
  const [editingIsNew, setEditingIsNew] = useState(false);
  const [categoryFilter, setCategoryFilter] = useState(allCategoriesValue);

  useEffect(() => {
    const saved = localStorage.getItem(storageKey);
    if (saved) {
      const storedEvents = (JSON.parse(saved) as CalendarEvent[]).map(normalizeEvent);
      setEvents(storedEvents);
      const datedEvents = storedEvents.map(eventDate).filter((date): date is Date => Boolean(date)).sort((a, b) => a.getTime() - b.getTime());
      const nextEvent = datedEvents.find((date) => date >= startOfDay(new Date())) ?? datedEvents[0];
      if (nextEvent) setCursor(startOfDay(nextEvent));
    }
  }, []);

  const allSortedEvents = useMemo(
    () => [...events].sort((left, right) => left.startsAt.localeCompare(right.startsAt)),
    [events]
  );
  const categoryOptions = useMemo(
    () => Array.from(new Set(events.map((event) => event.category.trim()).filter(Boolean))).sort((left, right) => left.localeCompare(right, "de")),
    [events]
  );
  const sortedEvents = useMemo(
    () => categoryFilter === allCategoriesValue ? allSortedEvents : allSortedEvents.filter((event) => event.category.trim() === categoryFilter),
    [allSortedEvents, categoryFilter]
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

  const persist = (nextEvents: CalendarEvent[]) => {
    const sorted = nextEvents.map(normalizeEvent).sort((a, b) => a.startsAt.localeCompare(b.startsAt));
    setEvents(sorted);
    localStorage.setItem(storageKey, JSON.stringify(sorted));
  };

  const importCalendar = async () => {
    try {
      const path = await open({
        multiple: false,
        filters: [{ name: "Kalenderdateien", extensions: ["ics", "eml", "pst", "ost"] }]
      });
      if (!path || Array.isArray(path)) return;
      const lower = path.toLowerCase();
      const imported = (lower.endsWith(".pst") || lower.endsWith(".ost") ? (await importOutlookStore(path)).events : parseCalendarFile(await readFile(path), path)).map(normalizeEvent);
      if (!imported.length) {
        setMessage("Keine Kalendertermine gefunden. Bitte exportieren Sie aus Thunderbird als .ics oder wählen Sie eine E-Mail mit iCalendar-Inhalt.");
        return;
      }
      const byId = new Map(events.map((event) => [event.id, event]));
      for (const event of imported) byId.set(event.id, event);
      persist(Array.from(byId.values()));
      const firstImportedDate = imported.map(eventDate).filter((date): date is Date => Boolean(date)).sort((a, b) => a.getTime() - b.getTime())[0];
      if (firstImportedDate) setCursor(startOfDay(firstImportedDate));
      setMessage(`${imported.length} Termine importiert.`);
    } catch (error) {
      setMessage(`Kalenderimport fehlgeschlagen: ${error}`);
    }
  };

  const exportCalendar = async () => {
    try {
      const path = await save({
        defaultPath: "AgendaKontakte-Kalender.ics",
        filters: [{ name: "iCalendar", extensions: ["ics"] }]
      });
      if (!path) return;
      await writeExportFile(path, exportCalendarIcs(allSortedEvents));
      setMessage(`${allSortedEvents.length} Termine als ICS exportiert.`);
    } catch (error) {
      setMessage(`Kalenderexport fehlgeschlagen: ${error}`);
    }
  };

  const move = (direction: number) => {
    if (view === "month") setCursor(new Date(cursor.getFullYear(), cursor.getMonth() + direction, 1));
    if (view === "week") setCursor(addDays(cursor, direction * 7));
  };

  const openNewEvent = (date = cursor) => {
    setEditingEvent(blankEvent(date));
    setEditingIsNew(true);
  };

  const openEvent = (event: CalendarEvent) => {
    setEditingEvent({ ...normalizeEvent(event), startsAt: toLocalDateTime(event.startsAt), endsAt: toLocalDateTime(event.endsAt) });
    setEditingIsNew(false);
  };

  const saveEvent = () => {
    if (!editingEvent) return;
    const next = events.filter((event) => event.id !== editingEvent.id);
    persist([...next, normalizeEvent({ ...editingEvent, source: editingEvent.source || "AgendaKontakte" })]);
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
          <button className="primary" type="button" onClick={importCalendar}>
            <CalendarPlus size={20} /> Kalender importieren
          </button>
          <button type="button" onClick={exportCalendar} disabled={!sortedEvents.length}>
            <Download size={20} /> Als ICS exportieren
          </button>
        </div>
      </header>
      <StatusMessage message={message} />

      {editingEvent && (
        <div className="modal-backdrop" role="dialog" aria-modal="true" aria-label={editingIsNew ? "Neuer Termin" : "Termin bearbeiten"}>
          <div className="modal-card calendar-event-dialog">
            <CalendarEventForm
              value={editingEvent}
              isNew={editingIsNew}
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
