import {
  importOutlookClassicAppointmentsToCalendar,
  importSelectedOutlookClassicContacts,
  importThunderbirdCalendarsToCalendar,
  importThunderbirdContactsOnce,
  mergeCalendarEvents,
  previewOutlookClassicContacts
} from "../services/db";
import type { CalendarEvent } from "../types/calendar";
import { calendarColorFromCategory, mergeImportedCalendarCategories } from "./calendar";

export type EasyImportPlatform = "outlook" | "thunderbird";
export type EasyImportKind = "contacts" | "calendar";

export interface EasyImportResult {
  detail: string;
  imported: number;
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
  const imported = result.imported;
  return {
    imported,
    detail: `${imported} neu importiert · ${result.mergedDuplicates} zusammengeführt · ${result.skippedExactDuplicates} bereits vorhanden`
  };
}

export async function easyImportCalendar(platform: EasyImportPlatform): Promise<EasyImportResult> {
  if (platform === "outlook") {
    const result = await importOutlookClassicAppointmentsToCalendar();
    const existing = result.skippedSameId + result.skippedExactDuplicates;
    return {
      imported: result.imported,
      detail: `${result.imported} neu importiert · ${existing} bereits vorhanden`
    };
  }

  const result = await importThunderbirdCalendarsToCalendar();
  const alreadyPresent = result.skippedSameId + result.skippedExactDuplicates;
  return {
    imported: result.imported,
    detail: `${result.imported} neu importiert · ${alreadyPresent} bereits vorhanden`
  };
}

export function easyImport(kind: EasyImportKind, platform: EasyImportPlatform): Promise<EasyImportResult> {
  return kind === "contacts" ? easyImportContacts(platform) : easyImportCalendar(platform);
}
