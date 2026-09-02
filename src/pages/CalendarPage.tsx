import { CalendarDays, ChevronLeft, ChevronRight, Filter, ListChecks, MoreHorizontal, Plus, Rows3, Trash2, Undo2, X } from "lucide-react";
import { useEffect, useMemo, useRef, useState, type CSSProperties, type DragEvent as ReactDragEvent, type PointerEvent as ReactPointerEvent } from "react";
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
const calendarViewStorageKey = "agendakontakte.calendarView.v1";
const compactCalendarHourHeight = 60;
const weekdays = ["Mo", "Di", "Mi", "Do", "Fr", "Sa", "So"];
const calendarHours = Array.from({ length: 24 }, (_, hour) => hour);
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

function eventEndDate(event: CalendarEvent): Date | null {
  return parseCalendarDate(event.endsAt || event.startsAt);
}

function eventTime(event: CalendarEvent): string {
  const date = eventDate(event);
  return date ? new Intl.DateTimeFormat("de-DE", { hour: "2-digit", minute: "2-digit" }).format(date) : "";
}

function eventTimeRange(event: CalendarEvent): string {
  const starts = eventDate(event);
  const ends = eventEndDate(event);
  if (!starts) return "";
  const formatter = new Intl.DateTimeFormat("de-DE", { hour: "2-digit", minute: "2-digit" });
  return ends ? `${formatter.format(starts)}–${formatter.format(ends)}` : formatter.format(starts);
}

function toLocalDateTime(value: string): string {
  const date = parseCalendarDate(value);
  if (!date) return value.slice(0, 16);
  const local = new Date(date.getTime() - date.getTimezoneOffset() * 60_000);
  return local.toISOString().slice(0, 16);
}

function blankEvent(date = new Date()): CalendarEvent {
  const starts = new Date(date);
  starts.setSeconds(0, 0);
  const ends = new Date(starts.getTime() + 60 * 60 * 1000);
  return {
    id: crypto.randomUUID(),
    updatedAt: new Date().toISOString(),
    title: "",
    startsAt: toLocalDateTime(starts.toISOString()),
    endsAt: toLocalDateTime(ends.toISOString()),
    location: "",
    description: "",
    color: defaultCalendarColor,
    category: "",
    source: "DMH Portal - Privat"
  };
}

interface WeekEventLayout {
  event: CalendarEvent;
  startMinutes: number;
  endMinutes: number;
  lane: number;
  lanes: number;
}

interface CalendarTimeSelection {
  dayKey: string;
  anchorMinutes: number;
  currentMinutes: number;
}

interface CalendarMonthSelection {
  anchorIndex: number;
  currentIndex: number;
}

function storedCalendarView(): CalendarView {
  const stored = localStorage.getItem(calendarViewStorageKey);
  return stored === "day" || stored === "week" || stored === "month" ? stored : "month";
}

function isoWeekNumber(date: Date): number {
  const thursday = new Date(Date.UTC(date.getFullYear(), date.getMonth(), date.getDate()));
  thursday.setUTCDate(thursday.getUTCDate() + 4 - (thursday.getUTCDay() || 7));
  const yearStart = new Date(Date.UTC(thursday.getUTCFullYear(), 0, 1));
  return Math.ceil((((thursday.getTime() - yearStart.getTime()) / 86_400_000) + 1) / 7);
}

function weekEventLayouts(day: Date, dayEvents: CalendarEvent[]): WeekEventLayout[] {
  const dayStart = startOfDay(day);
  const dayEnd = addDays(dayStart, 1);
  const segments = dayEvents.flatMap((event) => {
    const starts = eventDate(event);
    const ends = eventEndDate(event);
    if (!starts || !ends || ends <= dayStart || starts >= dayEnd) return [];
    const clippedStart = starts < dayStart ? dayStart : starts;
    const clippedEnd = ends > dayEnd ? dayEnd : ends;
    const startMinutes = Math.max(0, (clippedStart.getTime() - dayStart.getTime()) / 60_000);
    return [{
      event,
      startMinutes,
      endMinutes: Math.min(1_440, Math.max((clippedEnd.getTime() - dayStart.getTime()) / 60_000, startMinutes + 15))
    }];
  }).sort((left, right) => left.startMinutes - right.startMinutes || right.endMinutes - left.endMinutes);

  const result: WeekEventLayout[] = [];
  let group: typeof segments = [];
  let groupEnd = -1;
  const flushGroup = () => {
    if (group.length === 0) return;
    const laneEnds: number[] = [];
    const assigned = group.map((segment) => {
      let lane = laneEnds.findIndex((end) => end <= segment.startMinutes);
      if (lane < 0) lane = laneEnds.length;
      laneEnds[lane] = segment.endMinutes;
      return { ...segment, lane };
    });
    const lanes = Math.max(1, laneEnds.length);
    result.push(...assigned.map((segment) => ({ ...segment, lanes })));
    group = [];
  };

  for (const segment of segments) {
    if (group.length > 0 && segment.startMinutes >= groupEnd) flushGroup();
    group.push(segment);
    groupEnd = Math.max(groupEnd, segment.endMinutes);
  }
  flushGroup();
  return result;
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
  const [view, setView] = useState<CalendarView>(storedCalendarView);
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
  const [draggedEventId, setDraggedEventId] = useState<string | null>(null);
  const [timeSelection, setTimeSelection] = useState<CalendarTimeSelection | null>(null);
  const [monthSelection, setMonthSelection] = useState<CalendarMonthSelection | null>(null);
  const draggedEventIdRef = useRef<string | null>(null);
  const timeGridScrollRef = useRef<HTMLDivElement | null>(null);

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
    localStorage.setItem(calendarViewStorageKey, view);
  }, [view]);

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

  const weekLayouts = useMemo(() => weekDays.map((day) => {
    const dayStart = startOfDay(day);
    const dayEnd = addDays(dayStart, 1);
    const dayEvents = sortedEvents.filter((event) => {
      const starts = eventDate(event);
      const ends = eventEndDate(event);
      return Boolean(starts && ends && starts < dayEnd && ends > dayStart);
    });
    return weekEventLayouts(day, dayEvents);
  }), [sortedEvents, weekDays]);

  const dayLayouts = useMemo(
    () => weekEventLayouts(cursor, sortedEvents),
    [cursor, sortedEvents]
  );

  useEffect(() => {
    if ((view !== "week" && view !== "day") || !timeGridScrollRef.current) return;
    const now = new Date();
    const rangeStart = view === "week" ? weekDays[0] : startOfDay(cursor);
    const rangeEnd = view === "week" ? addDays(weekDays[6], 1) : addDays(startOfDay(cursor), 1);
    const visibleHour = now >= rangeStart && now < rangeEnd ? Math.max(0, now.getHours() - 1) : 7;
    const scroll = timeGridScrollRef.current;
    const frame = window.requestAnimationFrame(() => {
      scroll.scrollTop = visibleHour * compactCalendarHourHeight;
    });
    return () => window.cancelAnimationFrame(frame);
  }, [cursor, view, weekDays]);

  const eventsForDay = (day: Date) => sortedEvents.filter((event) => {
    const date = eventDate(event);
    return date ? sameDay(date, day) : false;
  });

  const title = view === "month"
    ? new Intl.DateTimeFormat("de-DE", { month: "long", year: "numeric" }).format(cursor)
    : view === "week"
      ? `${new Intl.DateTimeFormat("de-DE", { day: "2-digit", month: "2-digit" }).format(weekDays[0])}–${new Intl.DateTimeFormat("de-DE", { day: "2-digit", month: "2-digit", year: "numeric" }).format(weekDays[6])} · Woche ${isoWeekNumber(weekDays[0])}`
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

  const openNewEvent = (date = new Date(), exactTime = false) => {
    const starts = new Date(date);
    if (!exactTime) {
      const now = new Date();
      starts.setHours(now.getHours(), now.getMinutes(), 0, 0);
    }
    const event = blankEvent(starts);
    const firstCategory = categories[0];
    setEditingEvent(firstCategory ? { ...event, category: firstCategory.name, color: firstCategory.color } : event);
    setEditingIsNew(true);
  };

  const openNewEventRange = (starts: Date, ends: Date) => {
    const event = { ...blankEvent(starts), endsAt: toLocalDateTime(ends.toISOString()) };
    const firstCategory = categories[0];
    setEditingEvent(firstCategory ? { ...event, category: firstCategory.name, color: firstCategory.color } : event);
    setEditingIsNew(true);
  };

  const navigateCalendar = (direction: -1 | 1) => {
    if (view === "month") {
      setCursor(new Date(cursor.getFullYear(), cursor.getMonth() + direction, 1));
      return;
    }
    setCursor(addDays(cursor, direction * (view === "week" ? 7 : 1)));
  };

  const minutesFromPointer = (element: HTMLElement, clientY: number) => {
    const rect = element.getBoundingClientRect();
    const rawMinutes = ((clientY - rect.top) / compactCalendarHourHeight) * 60;
    return Math.max(0, Math.min(23 * 60 + 45, Math.round(rawMinutes / 15) * 15));
  };

  const selectionBounds = (selection: CalendarTimeSelection) => {
    const startMinutes = Math.min(selection.anchorMinutes, selection.currentMinutes);
    const endMinutes = selection.anchorMinutes === selection.currentMinutes
      ? Math.min(1_440, startMinutes + 30)
      : Math.max(selection.anchorMinutes, selection.currentMinutes);
    return { startMinutes, endMinutes: Math.max(startMinutes + 15, endMinutes) };
  };

  const beginTimeSelection = (day: Date, event: ReactPointerEvent<HTMLDivElement>) => {
    if (event.button !== 0 || (event.target as HTMLElement).closest(".calendar-week-timed-event")) return;
    event.preventDefault();
    const minutes = minutesFromPointer(event.currentTarget, event.clientY);
    setTimeSelection({ dayKey: dateInputValue(day), anchorMinutes: minutes, currentMinutes: minutes });
    event.currentTarget.setPointerCapture(event.pointerId);
  };

  const updateTimeSelection = (day: Date, event: ReactPointerEvent<HTMLDivElement>) => {
    if (!timeSelection || timeSelection.dayKey !== dateInputValue(day)) return;
    setTimeSelection((current) => current ? {
      ...current,
      currentMinutes: minutesFromPointer(event.currentTarget, event.clientY)
    } : null);
  };

  const finishTimeSelection = (day: Date, event: ReactPointerEvent<HTMLDivElement>) => {
    if (!timeSelection || timeSelection.dayKey !== dateInputValue(day)) return;
    const completed = {
      ...timeSelection,
      currentMinutes: minutesFromPointer(event.currentTarget, event.clientY)
    };
    const { startMinutes, endMinutes } = selectionBounds(completed);
    const starts = startOfDay(day);
    const ends = startOfDay(day);
    starts.setMinutes(startMinutes);
    ends.setMinutes(endMinutes);
    setTimeSelection(null);
    if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId);
    openNewEventRange(starts, ends);
  };

  const beginEventDrag = (event: ReactDragEvent<HTMLElement>, id: string) => {
    draggedEventIdRef.current = id;
    setDraggedEventId(id);
    event.dataTransfer.effectAllowed = "move";
    event.dataTransfer.setData("text/plain", id);
    event.dataTransfer.setData("text/dmh-calendar-event", id);
  };

  const finishEventDrag = () => {
    draggedEventIdRef.current = null;
    setDraggedEventId(null);
  };

  const draggedIdFromEvent = (event: ReactDragEvent<HTMLElement>) => draggedEventIdRef.current
    || event.dataTransfer.getData("text/dmh-calendar-event")
    || event.dataTransfer.getData("text/plain");

  const persistMovedEvent = (id: string, nextStart: Date) => {
    const existing = events.find((entry) => entry.id === id);
    if (!existing || existing.recurrence) return;
    const oldStart = eventDate(existing);
    const oldEnd = eventEndDate(existing);
    if (!oldStart || !oldEnd) return;
    const duration = Math.max(15 * 60_000, oldEnd.getTime() - oldStart.getTime());
    const nextEnd = new Date(nextStart.getTime() + duration);
    persist(events.map((entry) => entry.id === id ? {
      ...entry,
      startsAt: toLocalDateTime(nextStart.toISOString()),
      endsAt: toLocalDateTime(nextEnd.toISOString()),
      updatedAt: new Date().toISOString()
    } : entry));
    setMessage(`Termin „${existing.title}“ wurde auf ${new Intl.DateTimeFormat("de-DE", { weekday: "short", hour: "2-digit", minute: "2-digit" }).format(nextStart)} verschoben.`);
    window.dispatchEvent(new Event(calendarChangedEventName));
  };

  const allowEventDrop = (event: ReactDragEvent<HTMLElement>) => {
    if (!draggedEventIdRef.current && !event.dataTransfer.types.includes("text/plain") && !event.dataTransfer.types.includes("text/dmh-calendar-event")) return;
    event.preventDefault();
    event.dataTransfer.dropEffect = "move";
  };

  const moveEventToPointer = (day: Date, event: ReactDragEvent<HTMLDivElement>) => {
    event.preventDefault();
    const id = draggedIdFromEvent(event);
    const nextStart = startOfDay(day);
    nextStart.setMinutes(minutesFromPointer(event.currentTarget, event.clientY));
    finishEventDrag();
    persistMovedEvent(id, nextStart);
  };

  const moveEventToDay = (day: Date, event: ReactDragEvent<HTMLDivElement>) => {
    event.preventDefault();
    const id = draggedIdFromEvent(event);
    const existing = events.find((entry) => entry.id === id);
    const oldStart = existing ? eventDate(existing) : null;
    if (!oldStart) {
      finishEventDrag();
      return;
    }
    const nextStart = startOfDay(day);
    nextStart.setHours(oldStart.getHours(), oldStart.getMinutes(), 0, 0);
    finishEventDrag();
    persistMovedEvent(id, nextStart);
  };

  const finishMonthSelection = (endIndex: number) => {
    if (!monthSelection) return;
    const firstIndex = Math.min(monthSelection.anchorIndex, endIndex);
    const lastIndex = Math.max(monthSelection.anchorIndex, endIndex);
    setMonthSelection(null);
    if (firstIndex === lastIndex) {
      openNewEvent(monthDays[firstIndex]);
      return;
    }
    openNewEventRange(startOfDay(monthDays[firstIndex]), startOfDay(addDays(monthDays[lastIndex], 1)));
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
    persist([...next, normalizeEvent({ ...editingEvent, updatedAt: new Date().toISOString(), color: matchingCategory?.color ?? editingEvent.color, source: editingEvent.source || "DMH Portal - Privat" })]);
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
    window.dispatchEvent(new Event(calendarChangedEventName));
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
    window.dispatchEvent(new Event(calendarChangedEventName));
  };

  return (
    <div className="page calendar-page">
      <header className="page-header">
        <div>
          <h2>Kalender</h2>
          <p>Termine übersichtlich planen und verwalten.</p>
        </div>
        <div className="calendar-header-actions">
          <button className="primary" type="button" onClick={() => openNewEvent()}>
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
          <div className="calendar-toolbar-navigation">
            <button type="button" onClick={() => setCursor(startOfDay(new Date()))}>Heute</button>
            <button className="icon-only" type="button" aria-label="Vorheriger Zeitraum" title="Zurück" onClick={() => navigateCalendar(-1)}><ChevronLeft size={20} /></button>
            <button className="icon-only" type="button" aria-label="Nächster Zeitraum" title="Weiter" onClick={() => navigateCalendar(1)}><ChevronRight size={20} /></button>
            <h3>{title}</h3>
          </div>
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
          {monthDays.map((day, dayIndex) => {
            const dayEvents = eventsForDay(day);
            const monthRangeStart = monthSelection ? Math.min(monthSelection.anchorIndex, monthSelection.currentIndex) : -1;
            const monthRangeEnd = monthSelection ? Math.max(monthSelection.anchorIndex, monthSelection.currentIndex) : -1;
            const classes = [
              "calendar-day",
              day.getMonth() !== cursor.getMonth() ? "outside" : "",
              sameDay(day, new Date()) ? "today" : "",
              dayIndex >= monthRangeStart && dayIndex <= monthRangeEnd ? "range-selected" : "",
              draggedEventId ? "drag-ready" : ""
            ].filter(Boolean).join(" ");
            return (
              <div
                className={classes}
                key={day.toISOString()}
                onPointerDown={(event) => {
                  if (event.button !== 0 || (event.target as HTMLElement).closest(".calendar-event-chip")) return;
                  event.preventDefault();
                  setMonthSelection({ anchorIndex: dayIndex, currentIndex: dayIndex });
                }}
                onPointerEnter={(event) => {
                  if (monthSelection && event.buttons === 1) setMonthSelection((current) => current ? { ...current, currentIndex: dayIndex } : null);
                }}
                onPointerUp={() => finishMonthSelection(dayIndex)}
                onDragOver={allowEventDrop}
                onDrop={(event) => moveEventToDay(day, event)}
              >
                <span className="calendar-day-number">{day.getDate()}</span>
                <div className="calendar-day-events">
                  {dayEvents.slice(0, 3).map((event) => {
                    const canDrag = !event.recurrenceMasterId && !event.recurrence;
                    return <button
                      className={draggedEventId === event.id ? "calendar-event-chip dragging" : "calendar-event-chip"}
                      style={calendarColorStyle(event.color)}
                      type="button"
                      title={`${event.title} - ${event.location}${canDrag ? "\nZum Verschieben ziehen" : ""}`}
                      key={event.id}
                      draggable={canDrag}
                      onClick={(click) => { click.stopPropagation(); openEvent(event); }}
                      onDragStart={(dragEvent) => canDrag && beginEventDrag(dragEvent, event.id)}
                      onDragEnd={finishEventDrag}
                    ><time>{eventTime(event)}</time> {event.title}</button>;
                  })}
                  {dayEvents.length > 3 && <small>+ {dayEvents.length - 3} weitere</small>}
                </div>
              </div>
            );
          })}
        </section>
      )}

      {view === "week" && (
        <section className="calendar-week-schedule" aria-label="Wochenkalender">
          <div className="calendar-week-scroll" ref={timeGridScrollRef}>
            <div className="calendar-week-head">
              <div className="calendar-week-timezone" title="Zeitzone">MEZ</div>
              {weekDays.map((day) => (
                <button className={sameDay(day, new Date()) ? "today" : ""} type="button" key={day.toISOString()} onClick={() => { setCursor(day); setView("day"); }}>
                  <span>{weekdays[(day.getDay() || 7) - 1]}</span>
                  <strong>{day.getDate()}</strong>
                </button>
              ))}
            </div>
            <div
              className="calendar-week-timeline"
              style={{ "--calendar-hour-height": `${compactCalendarHourHeight}px`, "--calendar-half-hour-height": `${compactCalendarHourHeight / 2}px`, height: `${compactCalendarHourHeight * 24}px` } as CSSProperties}
            >
              <div className="calendar-time-axis" aria-hidden="true">
                {calendarHours.map((hour) => <time key={hour} style={{ top: `${hour * compactCalendarHourHeight}px` }}>{String(hour).padStart(2, "0")}:00</time>)}
              </div>
              <div className="calendar-week-day-tracks">
                {weekDays.map((day, dayIndex) => {
                  const now = new Date();
                  const nowMinutes = now.getHours() * 60 + now.getMinutes();
                  return (
                    <div
                      className={sameDay(day, now) ? "calendar-week-day-track today" : "calendar-week-day-track"}
                      key={day.toISOString()}
                      role="gridcell"
                      aria-label={`${new Intl.DateTimeFormat("de-DE", { weekday: "long", day: "numeric", month: "long" }).format(day)}. Freien Zeitraum markieren, um einen Termin zu erstellen.`}
                      onPointerDown={(event) => beginTimeSelection(day, event)}
                      onPointerMove={(event) => updateTimeSelection(day, event)}
                      onPointerUp={(event) => finishTimeSelection(day, event)}
                      onPointerCancel={() => setTimeSelection(null)}
                      onDragOver={allowEventDrop}
                      onDrop={(event) => moveEventToPointer(day, event)}
                    >
                      {sameDay(day, now) && <span className="calendar-current-time-line" style={{ top: `${(nowMinutes / 60) * compactCalendarHourHeight}px` }}><i /></span>}
                      {timeSelection?.dayKey === dateInputValue(day) && (() => {
                        const bounds = selectionBounds(timeSelection);
                        return <span className="calendar-time-selection" style={{ top: `${(bounds.startMinutes / 60) * compactCalendarHourHeight}px`, height: `${((bounds.endMinutes - bounds.startMinutes) / 60) * compactCalendarHourHeight}px` }}><strong>{eventTimeRange({ ...blankEvent(new Date(day.getFullYear(), day.getMonth(), day.getDate(), 0, bounds.startMinutes)), endsAt: toLocalDateTime(new Date(day.getFullYear(), day.getMonth(), day.getDate(), 0, bounds.endMinutes).toISOString()) })}</strong></span>;
                      })()}
                      {weekLayouts[dayIndex].map((layout) => {
                        const durationHeight = ((layout.endMinutes - layout.startMinutes) / 60) * compactCalendarHourHeight;
                        const eventStyle = {
                          ...calendarColorStyle(layout.event.color),
                          top: `${(layout.startMinutes / 60) * compactCalendarHourHeight + 1}px`,
                          height: `${Math.max(28, durationHeight - 2)}px`,
                          "--event-lane": layout.lane,
                          "--event-lanes": layout.lanes
                        } as CSSProperties;
                        const canDrag = !layout.event.recurrenceMasterId && !layout.event.recurrence;
                        return (
                          <button
                            className={draggedEventId === layout.event.id ? "calendar-week-timed-event dragging" : "calendar-week-timed-event"}
                            style={eventStyle}
                            type="button"
                            key={layout.event.id}
                            draggable={canDrag}
                            title={`${layout.event.title}\n${eventTimeRange(layout.event)}${layout.event.location ? `\n${layout.event.location}` : ""}${canDrag ? "\nZum Verschieben ziehen" : ""}`}
                            onClick={(event) => { event.stopPropagation(); openEvent(layout.event); }}
                            onDragStart={(event) => canDrag && beginEventDrag(event, layout.event.id)}
                            onDragEnd={finishEventDrag}
                          >
                            <strong>{layout.event.title || "Ohne Titel"}</strong>
                            <time>{eventTimeRange(layout.event)}</time>
                            {layout.event.location && <small>{layout.event.location}</small>}
                          </button>
                        );
                      })}
                    </div>
                  );
                })}
              </div>
            </div>
          </div>
          <p className="calendar-week-help">Freien Zeitraum markieren: Termin erstellen · Termin ziehen: verschieben</p>
        </section>
      )}

      {view === "day" && (
        <section className="calendar-day-schedule" aria-label="Tageskalender">
          <div className="calendar-day-scroll" ref={timeGridScrollRef}>
            <div className="calendar-day-head">
              <div className="calendar-week-timezone" title="Zeitzone">MEZ</div>
              <div className={sameDay(cursor, new Date()) ? "today" : ""}>
                <span>{new Intl.DateTimeFormat("de-DE", { weekday: "long" }).format(cursor)}</span>
                <strong>{cursor.getDate()}</strong>
                <small>{new Intl.DateTimeFormat("de-DE", { month: "long", year: "numeric" }).format(cursor)}</small>
              </div>
            </div>
            <div
              className="calendar-day-timeline"
              style={{ "--calendar-hour-height": `${compactCalendarHourHeight}px`, "--calendar-half-hour-height": `${compactCalendarHourHeight / 2}px`, height: `${compactCalendarHourHeight * 24}px` } as CSSProperties}
            >
              <div className="calendar-time-axis" aria-hidden="true">
                {calendarHours.map((hour) => <time key={hour} style={{ top: `${hour * compactCalendarHourHeight}px` }}>{String(hour).padStart(2, "0")}:00</time>)}
              </div>
              <div
                className={sameDay(cursor, new Date()) ? "calendar-week-day-track calendar-day-track today" : "calendar-week-day-track calendar-day-track"}
                role="gridcell"
                aria-label={`${new Intl.DateTimeFormat("de-DE", { weekday: "long", day: "numeric", month: "long" }).format(cursor)}. Freien Zeitraum markieren, um einen Termin zu erstellen.`}
                onPointerDown={(event) => beginTimeSelection(cursor, event)}
                onPointerMove={(event) => updateTimeSelection(cursor, event)}
                onPointerUp={(event) => finishTimeSelection(cursor, event)}
                onPointerCancel={() => setTimeSelection(null)}
                onDragOver={allowEventDrop}
                onDrop={(event) => moveEventToPointer(cursor, event)}
              >
                {sameDay(cursor, new Date()) && (() => {
                  const now = new Date();
                  const nowMinutes = now.getHours() * 60 + now.getMinutes();
                  return <span className="calendar-current-time-line" style={{ top: `${(nowMinutes / 60) * compactCalendarHourHeight}px` }}><i /></span>;
                })()}
                {timeSelection?.dayKey === dateInputValue(cursor) && (() => {
                  const bounds = selectionBounds(timeSelection);
                  return <span className="calendar-time-selection" style={{ top: `${(bounds.startMinutes / 60) * compactCalendarHourHeight}px`, height: `${((bounds.endMinutes - bounds.startMinutes) / 60) * compactCalendarHourHeight}px` }}><strong>{eventTimeRange({ ...blankEvent(new Date(cursor.getFullYear(), cursor.getMonth(), cursor.getDate(), 0, bounds.startMinutes)), endsAt: toLocalDateTime(new Date(cursor.getFullYear(), cursor.getMonth(), cursor.getDate(), 0, bounds.endMinutes).toISOString()) })}</strong></span>;
                })()}
                {dayLayouts.map((layout) => {
                  const durationHeight = ((layout.endMinutes - layout.startMinutes) / 60) * compactCalendarHourHeight;
                  const eventStyle = {
                    ...calendarColorStyle(layout.event.color),
                    top: `${(layout.startMinutes / 60) * compactCalendarHourHeight + 1}px`,
                    height: `${Math.max(32, durationHeight - 2)}px`,
                    "--event-lane": layout.lane,
                    "--event-lanes": layout.lanes
                  } as CSSProperties;
                  const canDrag = !layout.event.recurrenceMasterId && !layout.event.recurrence;
                  return (
                    <button
                      className={draggedEventId === layout.event.id ? "calendar-week-timed-event calendar-day-timed-event dragging" : "calendar-week-timed-event calendar-day-timed-event"}
                      style={eventStyle}
                      type="button"
                      key={layout.event.id}
                      draggable={canDrag}
                      title={`${layout.event.title}\n${eventTimeRange(layout.event)}${layout.event.location ? `\n${layout.event.location}` : ""}${canDrag ? "\nZum Verschieben ziehen" : ""}`}
                      onClick={(event) => { event.stopPropagation(); openEvent(layout.event); }}
                      onDragStart={(event) => canDrag && beginEventDrag(event, layout.event.id)}
                      onDragEnd={finishEventDrag}
                    >
                      <strong>{layout.event.title || "Ohne Titel"}</strong>
                      <time>{eventTimeRange(layout.event)}</time>
                      {layout.event.category && <small>{layout.event.category}</small>}
                      {layout.event.location && <small>{layout.event.location}</small>}
                    </button>
                  );
                })}
              </div>
            </div>
          </div>
          <p className="calendar-week-help">Freien Zeitraum markieren: Termin erstellen · Termin ziehen: verschieben</p>
        </section>
      )}
      </section>
    </div>
  );
}
