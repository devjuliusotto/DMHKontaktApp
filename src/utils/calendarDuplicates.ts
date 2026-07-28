import type { CalendarEvent } from "../types/calendar";

type CalendarEventContentField = Exclude<keyof CalendarEvent, "id">;

const exactContentFieldMap: Record<CalendarEventContentField, true> = {
  title: true,
  startsAt: true,
  endsAt: true,
  location: true,
  description: true,
  color: true,
  category: true,
  source: true,
  deletedAt: true,
  recurrence: true,
  excludedDates: true,
  recurrenceMasterId: true,
  recurrenceId: true
};

const exactContentFields = Object.keys(exactContentFieldMap) as CalendarEventContentField[];

function encodeExactValue(value: unknown): string {
  if (typeof value === "string") return `string:${value.length}:${value}`;
  if (value !== null && typeof value === "object") return `object:${JSON.stringify(value)}`;
  return `${typeof value}:${String(value)}`;
}

export function calendarEventExactContentKey(event: CalendarEvent): string {
  return exactContentFields
    .map((field) => `${field}=${encodeExactValue(event[field])}`)
    .join("\n");
}

export function calendarEventsAreExactlyEqual(left: CalendarEvent, right: CalendarEvent): boolean {
  return calendarEventExactContentKey(left) === calendarEventExactContentKey(right);
}

export interface CalendarEventMergeResult {
  events: CalendarEvent[];
  imported: number;
  skippedSameId: number;
  skippedExactDuplicates: number;
}

export function mergeCalendarEventsExactly(
  existing: CalendarEvent[],
  incoming: CalendarEvent[]
): CalendarEventMergeResult {
  const events = [...existing];
  const knownIds = new Set(existing.map((event) => event.id));
  const knownContent = new Set(existing.map(calendarEventExactContentKey));
  let imported = 0;
  let skippedSameId = 0;
  let skippedExactDuplicates = 0;

  for (const event of incoming) {
    if (knownIds.has(event.id)) {
      skippedSameId += 1;
      continue;
    }

    const contentKey = calendarEventExactContentKey(event);
    if (knownContent.has(contentKey)) {
      skippedExactDuplicates += 1;
      continue;
    }

    events.push(event);
    knownIds.add(event.id);
    knownContent.add(contentKey);
    imported += 1;
  }

  return { events, imported, skippedSameId, skippedExactDuplicates };
}

export interface ExactCalendarDuplicateGroup {
  event: CalendarEvent;
  copies: number;
}

export function findExactCalendarDuplicateGroups(events: CalendarEvent[]): ExactCalendarDuplicateGroup[] {
  const groups = new Map<string, CalendarEvent[]>();

  for (const event of events) {
    const key = calendarEventExactContentKey(event);
    const group = groups.get(key);
    if (group) group.push(event);
    else groups.set(key, [event]);
  }

  return Array.from(groups.values())
    .filter((group) => group.length > 1)
    .map((group) => ({ event: group[0], copies: group.length }))
    .sort((left, right) => left.event.startsAt.localeCompare(right.event.startsAt));
}

export interface ExactCalendarDuplicateRemoval {
  events: CalendarEvent[];
  removedEvents: CalendarEvent[];
}

export function removeExactCalendarDuplicates(events: CalendarEvent[]): ExactCalendarDuplicateRemoval {
  const knownContent = new Set<string>();
  const keptEvents: CalendarEvent[] = [];
  const removedEvents: CalendarEvent[] = [];

  for (const event of events) {
    const contentKey = calendarEventExactContentKey(event);
    if (knownContent.has(contentKey)) {
      removedEvents.push(event);
      continue;
    }
    knownContent.add(contentKey);
    keptEvents.push(event);
  }

  return { events: keptEvents, removedEvents };
}
