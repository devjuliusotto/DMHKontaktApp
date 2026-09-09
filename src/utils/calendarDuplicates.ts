import type { CalendarEvent } from "../types/calendar";
import { parseCalendarDate } from "./calendar";

function normalizedTitle(value: string): string {
  return value.trim().replace(/\s+/g, " ").toLocaleLowerCase("de-DE");
}

function normalizedStart(value: string): string {
  const parsed = parseCalendarDate(value);
  return parsed ? parsed.toISOString() : value.trim();
}

/**
 * A calendar duplicate is defined only by title and its starting date/time.
 * End time, location, description, category, source and technical IDs do not
 * participate in the decision.
 */
export function calendarEventDuplicateKey(event: CalendarEvent): string {
  return `${normalizedTitle(event.title)}\n${normalizedStart(event.startsAt)}`;
}

export function calendarEventsAreDuplicates(left: CalendarEvent, right: CalendarEvent): boolean {
  return calendarEventDuplicateKey(left) === calendarEventDuplicateKey(right);
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
  const knownDuplicates = new Set(existing.map(calendarEventDuplicateKey));
  let imported = 0;
  let skippedSameId = 0;
  let skippedExactDuplicates = 0;

  for (const event of incoming) {
    if (knownIds.has(event.id)) {
      skippedSameId += 1;
      continue;
    }

    const duplicateKey = calendarEventDuplicateKey(event);
    if (knownDuplicates.has(duplicateKey)) {
      skippedExactDuplicates += 1;
      continue;
    }

    events.push(event);
    knownIds.add(event.id);
    knownDuplicates.add(duplicateKey);
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
    const key = calendarEventDuplicateKey(event);
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
  const knownDuplicates = new Set<string>();
  const keptEvents: CalendarEvent[] = [];
  const removedEvents: CalendarEvent[] = [];

  for (const event of events) {
    const duplicateKey = calendarEventDuplicateKey(event);
    if (knownDuplicates.has(duplicateKey)) {
      removedEvents.push(event);
      continue;
    }
    knownDuplicates.add(duplicateKey);
    keptEvents.push(event);
  }

  return { events: keptEvents, removedEvents };
}
