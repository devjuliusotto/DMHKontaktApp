import { CalendarDays, Edit, Filter, ListChecks, MoreHorizontal, Plus, Rows3, Trash2, Undo2, X } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { CalendarEventForm } from "../components/CalendarEventForm";
import { StatusMessage } from "../components/StatusMessage";
import type { CalendarEvent } from "../types/calendar";
import { calendarCategoriesStorageKey, calendarColorOptions, calendarColorStyle, calendarColorValue, calendarStorageKey, calendarTrashStorageKey, defaultCalendarColor, expandCalendarEvents, formatCalendarDate, parseCalendarDate } from "../utils/calendar";
import { findExactCalendarDuplicateGroups, removeExactCalendarDuplicates } from "../utils/calendarDuplicates";
import {
  calendarAutomaticSyncStatusEventName,
  calendarChangedEventName,
  calendarStorageUpdatedEventName,
  type CalendarAutomaticSyncStatus
} from "../utils/automaticCalendarSync";

const duplicateCleanupBackupKey = "agendakontakte.calendarExactDuplicateCleanupBackup.v1";
const weekdays = ["Mo", "Di", "Mi", "Do", "Fr", "Sa", "So"];
type CalendarView = "day" | "week" | "month";
type CalendarCategory = {
  name: string;
  color: string;
};
const allCategoriesValue = "__all__";

interface CalendarDuplicateCleanupBackup {
  createdAt: string;
  removedEvents: CalendarEvent[];
}

function readDuplicateCleanupBackup(): CalendarDuplicateCleanupBackup | null {
  const raw = localStorage.getItem(duplicateCleanupBackupKey);
  if (!raw) return null;
  try {
    const value = JSON.parse(raw) as Partial<CalendarDuplicateCleanupBackup>;
    if (typeof value.createdAt !== "string" || !Array.isArray(value.removedEvents)) return null;
    return { createdAt: value.createdAt, removedEvents: value.removedEvents as CalendarEvent[] };
  } catch {
    return null;
  }
}

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

function dateInputValue(date: Date): string {
  const local = new Date(date.getTime() - date.getTimezoneOffset() * 60_000);
  return local.toISOString().slice(0, 10);
}

function dateFromInput(value: string): Date | null {
  const [year, month, day] = value.split("-").map(Number);
  if (!year || !month || !day) return null;
  return new Date(year, month - 1, day);
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
    source: "DMH Kontakte und Kalender"
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
  const [showCategoryDialog, setShowCategoryDialog] = useState(false);
  const [showDuplicateDialog, setShowDuplicateDialog] = useState(false);
  const [showActionsMenu, setShowActionsMenu] = useState(false);
  const [newCategoryName, setNewCategoryName] = useState("");
  const [newCategoryColor, setNewCategoryColor] = useState(defaultCalendarColor);
  const [duplicateCleanupBackup, setDuplicateCleanupBackup] = useState<CalendarDuplicateCleanupBackup | null>(
    () => readDuplicateCleanupBackup()
  );

  useEffect(() => {
    const saved = localStorage.getItem(calendarStorageKey);
    if (saved) {
      const storedEvents = (JSON.parse(saved) as CalendarEvent[]).map(normalizeEvent);
      setEvents(storedEvents);
    }

    const savedCategories = localStorage.getItem(calendarCategoriesStorageKey);
    if (savedCategories) {
      const storedCategories = (JSON.parse(savedCategories) as CalendarCategory[]).map(normalizeCategory).filter((category) => category.name);
      setCategories(storedCategories);
    }
  }, []);

  useEffect(() => {
    const reloadStoredEvents = () => {
      try {
        const storedEvents = JSON.parse(localStorage.getItem(calendarStorageKey) ?? "[]") as CalendarEvent[];
        setEvents(storedEvents.map(normalizeEvent));
      } catch {
        setMessage("Die von Microsoft 365 empfangenen Kalenderdaten konnten nicht angezeigt werden.");
      }
    };
    const showAutomaticSyncStatus = (event: Event) => {
      const detail = (event as CustomEvent<CalendarAutomaticSyncStatus>).detail;
      if (detail?.message) setMessage(detail.message);
    };
    window.addEventListener(calendarStorageUpdatedEventName, reloadStoredEvents);
    window.addEventListener(calendarAutomaticSyncStatusEventName, showAutomaticSyncStatus);
    return () => {
      window.removeEventListener(calendarStorageUpdatedEventName, reloadStoredEvents);
      window.removeEventListener(calendarAutomaticSyncStatusEventName, showAutomaticSyncStatus);
    };
  }, []);

  const displayRange = useMemo(() => {
    if (view === "month") {
      const first = startOfWeek(new Date(cursor.getFullYear(), cursor.getMonth(), 1));
      return { start: first, end: addDays(first, 42) };
    }
    if (view === "week") {
      const first = startOfWeek(cursor);
      return { start: first, end: addDays(first, 7) };
    }
    return { start: startOfDay(cursor), end: addDays(startOfDay(cursor), 1) };
  }, [cursor, view]);
  const allSortedEvents = useMemo(
    () => expandCalendarEvents(events, displayRange.start, displayRange.end)
      .sort((left, right) => left.startsAt.localeCompare(right.startsAt)),
    [displayRange, events]
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
    () => categoryFilter === allCategoriesValue
      ? allSortedEvents
      : allSortedEvents.filter((event) => event.category.trim() === categoryFilter),
    [allSortedEvents, categoryFilter]
  );
  const exactDuplicateGroups = useMemo(() => findExactCalendarDuplicateGroups(events), [events]);
  const exactDuplicateCopies = useMemo(
    () => exactDuplicateGroups.reduce((total, group) => total + group.copies - 1, 0),
    [exactDuplicateGroups]
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
      : new Intl.DateTimeFormat("de-DE", { weekday: "long", day: "2-digit", month: "long", year: "numeric" }).format(cursor);

  const persist = (nextEvents: CalendarEvent[]) => {
    const sorted = nextEvents.map(normalizeEvent).sort((a, b) => a.startsAt.localeCompare(b.startsAt));
    setEvents(sorted);
    localStorage.setItem(calendarStorageKey, JSON.stringify(sorted));
  };

  const persistCategories = (nextCategories: CalendarCategory[]) => {
    const byName = new Map<string, CalendarCategory>();
    for (const category of nextCategories.map(normalizeCategory).filter((entry) => entry.name)) {
      byName.set(category.name.toLowerCase(), category);
    }
    const sorted = Array.from(byName.values()).sort((left, right) => left.name.localeCompare(right.name, "de"));
    setCategories(sorted);
    localStorage.setItem(calendarCategoriesStorageKey, JSON.stringify(sorted));
  };

  const reviewExactDuplicates = () => {
    if (exactDuplicateCopies === 0) {
      setMessage("Keine in allen Kalenderfeldern exakt gleichen Duplikate gefunden.");
      return;
    }
    setShowDuplicateDialog(true);
  };

  const cleanupExactDuplicates = () => {
    const result = removeExactCalendarDuplicates(events);
    if (result.removedEvents.length === 0) {
      setShowDuplicateDialog(false);
      setMessage("Keine exakt gleichen Duplikate gefunden.");
      return;
    }

    const previousBackup = readDuplicateCleanupBackup();
    const backup: CalendarDuplicateCleanupBackup = {
      createdAt: previousBackup?.createdAt ?? new Date().toISOString(),
      removedEvents: [...(previousBackup?.removedEvents ?? []), ...result.removedEvents]
    };
    localStorage.setItem(duplicateCleanupBackupKey, JSON.stringify(backup));
    setDuplicateCleanupBackup(backup);
    persist(result.events);
    setShowDuplicateDialog(false);
    setMessage(
      `${result.removedEvents.length} exakt gleiche überzählige ${result.removedEvents.length === 1 ? "Kopie wurde" : "Kopien wurden"} entfernt und vollständig für „Rückgängig“ gesichert.`
    );
  };

  const undoDuplicateCleanup = () => {
    const backup = readDuplicateCleanupBackup();
    if (!backup?.removedEvents.length) {
      setDuplicateCleanupBackup(null);
      setMessage("Keine Sicherung einer Duplikatbereinigung gefunden.");
      return;
    }
    if (!window.confirm(`${backup.removedEvents.length} zuvor entfernte Kalenderkopien wiederherstellen? Bestehende oder inzwischen geänderte Termine werden nicht überschrieben.`)) return;

    const usedIds = new Set(events.map((event) => event.id));
    const restoredEvents = backup.removedEvents.map((event) => {
      const id = usedIds.has(event.id) ? crypto.randomUUID() : event.id;
      usedIds.add(id);
      return id === event.id ? event : { ...event, id };
    });
    persist([...events, ...restoredEvents]);
    localStorage.removeItem(duplicateCleanupBackupKey);
    setDuplicateCleanupBackup(null);
    setMessage(`${restoredEvents.length} Kalenderkopien wurden aus der Sicherung wiederhergestellt.`);
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

  const openNewEvent = (date = cursor) => {
    const event = blankEvent(date);
    const firstCategory = categories[0];
    setEditingEvent(firstCategory ? { ...event, category: firstCategory.name, color: firstCategory.color } : event);
    setEditingIsNew(true);
  };

  const openEvent = (event: CalendarEvent) => {
    const master = event.recurrenceMasterId ? events.find((entry) => entry.id === event.recurrenceMasterId) ?? event : event;
    setEditingEvent({ ...normalizeEvent(master), startsAt: toLocalDateTime(master.startsAt), endsAt: toLocalDateTime(master.endsAt) });
    setEditingIsNew(false);
  };

  const saveEvent = () => {
    if (!editingEvent) return;
    const next = events.filter((event) => event.id !== editingEvent.id);
    const matchingCategory = categories.find((category) => category.name === editingEvent.category.trim());
    persist([...next, normalizeEvent({ ...editingEvent, color: matchingCategory?.color ?? editingEvent.color, source: editingEvent.source || "DMH Kontakte und Kalender" })]);
    const date = eventDate(editingEvent);
    if (date) setCursor(startOfDay(date));
    setEditingEvent(null);
    setMessage(editingIsNew ? "Termin wurde erstellt." : "Termin wurde aktualisiert.");
    window.dispatchEvent(new Event(calendarChangedEventName));
  };

  const deleteEvent = (event = editingEvent) => {
    if (!event) return;
    const master = event.recurrenceMasterId ? events.find((entry) => entry.id === event.recurrenceMasterId) ?? event : event;
    const objectName = master.recurrence ? `Terminserie "${master.title}"` : `Termin "${master.title}"`;
    if (!window.confirm(`${objectName} wirklich löschen?`)) return;
    let deletedEvents: CalendarEvent[] = [];
    try {
      deletedEvents = JSON.parse(localStorage.getItem(calendarTrashStorageKey) ?? "[]") as CalendarEvent[];
      if (!Array.isArray(deletedEvents)) deletedEvents = [];
    } catch {
      deletedEvents = [];
    }
    const deletedEvent = { ...normalizeEvent(master), deletedAt: new Date().toISOString() };
    localStorage.setItem(
      calendarTrashStorageKey,
      JSON.stringify([deletedEvent, ...deletedEvents.filter((entry) => entry.id !== master.id)])
    );
    persist(events.filter((entry) => entry.id !== master.id));
    setEditingEvent(null);
    setMessage(master.recurrence ? "Terminserie wurde in den Papierkorb verschoben." : "Termin wurde in den Papierkorb verschoben.");
  };

  const deleteAllEvents = () => {
    if (events.length === 0 || !window.confirm(`Alle ${events.length} Termine und Terminserien in den Papierkorb verschieben?`)) return;
    let deletedEvents: CalendarEvent[] = [];
    try {
      deletedEvents = JSON.parse(localStorage.getItem(calendarTrashStorageKey) ?? "[]") as CalendarEvent[];
      if (!Array.isArray(deletedEvents)) deletedEvents = [];
    } catch {
      deletedEvents = [];
    }
    const deletedAt = new Date().toISOString();
    const activeIds = new Set(events.map((event) => event.id));
    const movedEvents = events.map((event) => ({ ...normalizeEvent(event), deletedAt }));
    localStorage.setItem(calendarTrashStorageKey, JSON.stringify([
      ...movedEvents,
      ...deletedEvents.filter((event) => !activeIds.has(event.id))
    ]));
    persist([]);
    setEditingEvent(null);
    setMessage(`${events.length} Termine und Terminserien wurden in den Papierkorb verschoben.`);
  };

  return (
    <div className="page calendar-page">
      <header className="page-header">
        <div>
          <h2>Kalender</h2>
          <p>Termine übersichtlich planen und verwalten.</p>
        </div>
        <div className="calendar-header-actions">
          <button className="primary" type="button" onClick={() => openNewEvent(cursor)}>
            <Plus size={20} /> Neuer Termin
          </button>
          <div className="calendar-actions-menu-wrap">
            <button className="icon-only" type="button" aria-label="Weitere Kalenderaktionen" title="Weitere Aktionen" aria-haspopup="menu" aria-expanded={showActionsMenu} onClick={() => setShowActionsMenu((open) => !open)}>
              <MoreHorizontal size={21} />
            </button>
            {showActionsMenu && <div className="calendar-actions-menu" role="menu">
              <button type="button" onClick={() => { setShowActionsMenu(false); setShowCategoryDialog(true); }}><Plus size={18} /> Kategorie erstellen</button>
              <button type="button" onClick={() => { setShowActionsMenu(false); reviewExactDuplicates(); }}><ListChecks size={18} /> Exakte Duplikate prüfen</button>
              {duplicateCleanupBackup && <button type="button" onClick={() => { setShowActionsMenu(false); undoDuplicateCleanup(); }}><Undo2 size={18} /> Bereinigung rückgängig</button>}
              <span className="calendar-actions-separator" />
              <button className="danger" type="button" onClick={() => { setShowActionsMenu(false); deleteAllEvents(); }} disabled={events.length === 0}><Trash2 size={18} /> Alle Termine löschen</button>
            </div>}
          </div>
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

      {showDuplicateDialog && (
        <div className="modal-backdrop" role="dialog" aria-modal="true" aria-labelledby="calendar-duplicate-title">
          <div className="modal-card calendar-duplicate-dialog">
            <section className="form-panel">
              <div className="panel-heading">
                <div>
                  <h3 id="calendar-duplicate-title">Exakte Kalenderduplikate</h3>
                  <p>{exactDuplicateCopies} überzählige {exactDuplicateCopies === 1 ? "Kopie" : "Kopien"} in {exactDuplicateGroups.length} {exactDuplicateGroups.length === 1 ? "Gruppe" : "Gruppen"} gefunden.</p>
                </div>
                <button className="icon-only" type="button" aria-label="Schließen" onClick={() => setShowDuplicateDialog(false)}>
                  <X size={22} />
                </button>
              </div>

              <div className="calendar-duplicate-safety" role="note">
                Entfernt wird nur eine überzählige Kopie, wenn Titel, Beginn, Ende, Ort, Beschreibung, Farbe, Kategorie und Quelle Zeichen für Zeichen gleich sind. Die technische ID darf verschieden sein. Schon eine Abweichung – auch bei Sekunden – erhält beide Termine.
              </div>

              <ul className="calendar-duplicate-list">
                {exactDuplicateGroups.slice(0, 10).map((group) => (
                  <li key={`${group.event.id}-${group.copies}`}>
                    <strong>{group.event.title}</strong>
                    <span>{formatCalendarDate(group.event.startsAt)} · {group.copies} identische Kopien</span>
                    {group.event.source && <small>{group.event.source}</small>}
                  </li>
                ))}
              </ul>
              {exactDuplicateGroups.length > 10 && <p>Weitere {exactDuplicateGroups.length - 10} Gruppen werden nach denselben strengen Regeln behandelt.</p>}

              <div className="button-row">
                <button type="button" onClick={() => setShowDuplicateDialog(false)}>Abbrechen</button>
                <button className="danger-button" type="button" onClick={cleanupExactDuplicates}>
                  <Trash2 size={18} /> {exactDuplicateCopies} überzählige {exactDuplicateCopies === 1 ? "Kopie" : "Kopien"} entfernen
                </button>
              </div>
              <p className="calendar-duplicate-backup-note">Vor dem Entfernen werden sämtliche Kopien vollständig lokal gesichert und können über „Bereinigung rückgängig“ wiederhergestellt werden.</p>
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

      <section className="calendar-shell">
        <section className="calendar-toolbar" aria-label="Kalendersteuerung">
          <h3>{title}</h3>
          <div className="calendar-toolbar-controls">
            <label className="calendar-toolbar-field">
              <CalendarDays size={18} aria-hidden="true" />
              <span className="sr-only">Datum</span>
              <input type="date" value={dateInputValue(cursor)} onChange={(event) => { const nextDate = dateFromInput(event.target.value); if (nextDate) setCursor(nextDate); }} />
            </label>
            <label className="calendar-toolbar-field">
              <Filter size={18} aria-hidden="true" />
              <span className="sr-only">Termine filtern</span>
              <select value={categoryFilter} onChange={(event) => setCategoryFilter(event.target.value)}>
                <option value={allCategoriesValue}>Alle Filter</option>
                {categoryOptions.map((category) => <option value={category} key={category}>{category}</option>)}
              </select>
            </label>
            <label className="calendar-toolbar-field view-field">
              <Rows3 size={18} aria-hidden="true" />
              <span className="sr-only">Kalenderansicht</span>
              <select value={view} onChange={(event) => setView(event.target.value as CalendarView)}>
                <option value="day">Tag</option>
                <option value="week">Woche</option>
                <option value="month">Monat</option>
              </select>
            </label>
          </div>
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

      {view === "day" && (
        <section className="calendar-day-view" onDoubleClick={() => openNewEvent(cursor)}>
          <header>
            <span>{new Intl.DateTimeFormat("de-DE", { weekday: "long" }).format(cursor)}</span>
            <strong>{cursor.getDate()}</strong>
          </header>
          <div className="calendar-day-agenda">
            {eventsForDay(cursor).map((event) => (
              <button className="calendar-day-event" style={calendarColorStyle(event.color)} type="button" key={event.id} onClick={(click) => { click.stopPropagation(); openEvent(event); }} onDoubleClick={(doubleClick) => doubleClick.stopPropagation()}>
                <time>{eventTime(event)}</time>
                <span><strong>{event.title}</strong>{event.category && <small>{event.category}</small>}{event.location && <small>{event.location}</small>}</span>
                <Edit size={17} aria-hidden="true" />
              </button>
            ))}
            {eventsForDay(cursor).length === 0 && <div className="calendar-day-empty"><CalendarDays size={28} /><strong>Keine Termine an diesem Tag</strong><span>Doppelklicken Sie hier, um einen Termin zu erstellen.</span></div>}
          </div>
        </section>
      )}
      </section>
    </div>
  );
}
