import {
  importOutlookClassicAppointmentsOnce,
  importSelectedOutlookClassicContacts,
  importThunderbirdCalendarsOnce,
  importThunderbirdContactsOnce,
  previewOutlookClassicContacts
} from "../services/db";
import type { CalendarEvent } from "../types/calendar";
import { calendarColorFromCategory, calendarStorageKey, mergeImportedCalendarCategories } from "./calendar";
import { mergeCalendarEventsExactly } from "./calendarDuplicates";

export type EasyImportPlatform = "outlook" | "thunderbird";
export type EasyImportKind = "contacts" | "calendar";

export interface EasyImportResult {
  detail: string;
  imported: number;
}

function storedCalendarEvents(): CalendarEvent[] {
  const raw = localStorage.getItem(calendarStorageKey);
  if (!raw) return [];
  const value: unknown = JSON.parse(raw);
  if (!Array.isArray(value)) throw new Error("Die lokal gespeicherten Kalenderdaten sind beschädigt.");
  return value as CalendarEvent[];
}

export async function easyImportContacts(platform: EasyImportPlatform): Promise<EasyImportResult> {
  if (platform === "outlook") {
    const preview = await previewOutlookClassicContacts(true);
    if (preview.sources.length === 0) {
      return { imported: 0, detail: "Keine erreichbaren Outlook-Kontakte gefunden." };
    }
    const result = await importSelectedOutlookClassicContacts({
      selectedSourceIds: preview.sources.map((source) => source.id),
      createSourceGroups: true,
      cleanImportedNames: true
    });
    return {
      imported: result.imported,
      detail: `${result.imported} neu importiert · ${result.mergedDuplicates} Duplikate zusammengeführt · ${result.skippedExactDuplicates} bereits vorhanden`
    };
  }

  const result = await importThunderbirdContactsOnce(true, true);
  const imported = result.imported + result.autocompleteImported;
  return {
    imported,
    detail: `${imported} neu importiert · ${result.linkedExisting + result.autocompleteLinkedExisting} bereits vorhanden`
  };
}

export async function easyImportCalendar(platform: EasyImportPlatform): Promise<EasyImportResult> {
  if (platform === "outlook") {
    const result = await importOutlookClassicAppointmentsOnce();
    const normalized = result.events.map((event) => ({
      ...event,
      color: calendarColorFromCategory(event.category, event.color)
    }));
    const merged = mergeCalendarEventsExactly(storedCalendarEvents(), normalized);
    localStorage.setItem(calendarStorageKey, JSON.stringify(merged.events));
    mergeImportedCalendarCategories(normalized);
    const existing = merged.skippedSameId + merged.skippedExactDuplicates;
    return {
      imported: merged.imported,
      detail: `${merged.imported} neu importiert · ${existing} bereits vorhanden`
    };
  }

  const result = await importThunderbirdCalendarsOnce();
  const existing = storedCalendarEvents();
  const eventsById = new Map(existing.map((event) => [event.id, event]));
  let imported = 0;
  let updated = 0;
  for (const event of result.events) {
    if (eventsById.has(event.id)) updated += 1;
    else imported += 1;
    eventsById.set(event.id, { ...event, color: calendarColorFromCategory(event.category, event.color) });
  }
  localStorage.setItem(calendarStorageKey, JSON.stringify(Array.from(eventsById.values())));
  mergeImportedCalendarCategories(result.events);
  return {
    imported,
    detail: `${imported} neu importiert · ${updated} aktualisiert`
  };
}

export function easyImport(kind: EasyImportKind, platform: EasyImportPlatform): Promise<EasyImportResult> {
  return kind === "contacts" ? easyImportContacts(platform) : easyImportCalendar(platform);
}
