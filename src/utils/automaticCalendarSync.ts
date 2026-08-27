import {
  applyMicrosoft365Sync,
  createAutomaticBackup,
  getAppSetting,
  getBackupData,
  getMicrosoft365ConnectionStatus,
  setAppSetting
} from "../services/db";
import type { CalendarEvent } from "../types/calendar";
import type { Microsoft365SyncHistoryEntry } from "../types/m365";
import { parseSyncConfig } from "../types/sync";
import { addBrowserDataToBackup } from "./backup";
import { calendarStorageKey, mergeImportedCalendarCategories } from "./calendar";

export const synchronizationConfigKey = "synchronization_config_v1";
export const synchronizationHistoryKey = "synchronization_history_v1";
export const calendarChangedEventName = "dmh:calendar-changed";
export const calendarStorageUpdatedEventName = "dmh:calendar-storage-updated";
export const calendarAutomaticSyncStatusEventName = "dmh:calendar-automatic-sync-status";

export interface CalendarAutomaticSyncStatus {
  state: "success" | "error";
  message: string;
}

function parseHistory(raw: string | null): Microsoft365SyncHistoryEntry[] {
  if (!raw) return [];
  try {
    const value: unknown = JSON.parse(raw);
    return Array.isArray(value) ? value.slice(0, 30) as Microsoft365SyncHistoryEntry[] : [];
  } catch {
    return [];
  }
}

function applyCalendarUpserts(calendarUpserts: CalendarEvent[]): void {
  if (calendarUpserts.length === 0) return;
  const current = JSON.parse(localStorage.getItem(calendarStorageKey) ?? "[]") as CalendarEvent[];
  const byId = new Map(current.map((event) => [event.id, event]));
  for (const event of calendarUpserts) byId.set(event.id, event);
  localStorage.setItem(calendarStorageKey, JSON.stringify(Array.from(byId.values())));
  mergeImportedCalendarCategories(calendarUpserts);
  window.dispatchEvent(new Event(calendarStorageUpdatedEventName));
}

export async function runAutomaticCalendarSync(trigger: "open" | "change"): Promise<CalendarAutomaticSyncStatus | null> {
  if (!("__TAURI_INTERNALS__" in window)) return null;
  const config = parseSyncConfig(await getAppSetting(synchronizationConfigKey));
  if (!config.enabled || config.paused || !config.providers.m365 || !config.calendars) return null;
  if (trigger === "open" && !config.runOnOpen) return null;
  if (config.selectedCalendarSourceIds.length === 0) {
    return { state: "error", message: "Automatische Synchronisierung ist aktiviert, aber es wurde kein Microsoft-365-Kalender ausgewählt." };
  }

  const connection = await getMicrosoft365ConnectionStatus();
  if (!connection.connected) {
    return { state: "error", message: "Der Termin wurde lokal gespeichert. Microsoft 365 ist momentan nicht verbunden." };
  }

  const backup = addBrowserDataToBackup(await getBackupData());
  await createAutomaticBackup(backup);
  const result = await applyMicrosoft365Sync({
    direction: config.direction,
    base: config.base,
    contacts: false,
    calendars: true,
    sharedCalendars: config.sharedCalendars,
    sharedMailboxes: false,
    sharedMailboxAddresses: [],
    selectedContactSourceIds: [],
    selectedCalendarSourceIds: config.selectedCalendarSourceIds,
    sourceDirections: config.sourceDirections,
    decisions: {},
    backup
  });

  applyCalendarUpserts(result.calendarUpserts);
  const history = parseHistory(await getAppSetting(synchronizationHistoryKey));
  const entry: Microsoft365SyncHistoryEntry = {
    id: `${result.startedAt}-${Date.now()}`,
    startedAt: result.startedAt,
    finishedAt: result.finishedAt,
    created: result.created,
    updated: result.updated,
    ignored: result.ignored,
    conflicts: result.conflicts,
    errors: result.errors,
    errorMessages: result.errorMessages
  };
  await setAppSetting(synchronizationHistoryKey, JSON.stringify([entry, ...history].slice(0, 30)));

  if (result.errors > 0) {
    return { state: "error", message: `Microsoft-365-Synchronisierung mit ${result.errors} Fehler(n) abgeschlossen.` };
  }
  if (result.created + result.updated === 0) {
    return { state: "success", message: "Kalender ist bereits mit Microsoft 365 synchron." };
  }
  return {
    state: "success",
    message: `${result.created + result.updated} Kalenderänderung(en) automatisch mit Microsoft 365 synchronisiert.`
  };
}
