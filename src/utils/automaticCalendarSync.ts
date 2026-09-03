import {
  applyMicrosoft365Sync,
  getAppSetting,
  getBackupData,
  getMicrosoft365ConnectionStatus,
  setAppSetting
} from "../services/db";
import type { CalendarEvent } from "../types/calendar";
import type { Microsoft365SyncHistoryEntry, Microsoft365SyncResult } from "../types/m365";
import { parseSyncConfig, type SyncConfig } from "../types/sync";
import { addBrowserDataToBackup } from "./backup";
import { calendarStorageKey, calendarTrashStorageKey, mergeImportedCalendarCategories } from "./calendar";

export const synchronizationConfigKey = "synchronization_config_v1";
export const synchronizationHistoryKey = "synchronization_history_v1";
export const synchronizationRuntimeStatusKey = "synchronization_runtime_status_v1";
export const calendarChangedEventName = "dmh:calendar-changed";
export const calendarStorageUpdatedEventName = "dmh:calendar-storage-updated";
export const calendarAutomaticSyncStatusEventName = "dmh:calendar-automatic-sync-status";
export const m365DataUpdatedEventName = "dmh:m365-data-updated";

export interface CalendarAutomaticSyncStatus {
  state: "success" | "error";
  message: string;
}

export interface Microsoft365SynchronizationRuntimeStatus {
  lastAttemptAt: string | null;
  lastSuccessAt: string | null;
  lastExchangeAt: string | null;
  contactsLastCheckedAt: string | null;
  calendarsLastCheckedAt: string | null;
  lastError: string | null;
}

export const emptyMicrosoft365SynchronizationRuntimeStatus: Microsoft365SynchronizationRuntimeStatus = {
  lastAttemptAt: null,
  lastSuccessAt: null,
  lastExchangeAt: null,
  contactsLastCheckedAt: null,
  calendarsLastCheckedAt: null,
  lastError: null
};

export function parseSynchronizationRuntimeStatus(raw: string | null): Microsoft365SynchronizationRuntimeStatus {
  if (!raw) return emptyMicrosoft365SynchronizationRuntimeStatus;
  try {
    const parsed = JSON.parse(raw) as Partial<Microsoft365SynchronizationRuntimeStatus>;
    return { ...emptyMicrosoft365SynchronizationRuntimeStatus, ...parsed };
  } catch {
    return emptyMicrosoft365SynchronizationRuntimeStatus;
  }
}

async function saveRuntimeStatus(status: Microsoft365SynchronizationRuntimeStatus): Promise<void> {
  await setAppSetting(synchronizationRuntimeStatusKey, JSON.stringify(status));
}

export async function recordMicrosoft365SynchronizationError(error: unknown): Promise<void> {
  const previous = parseSynchronizationRuntimeStatus(await getAppSetting(synchronizationRuntimeStatusKey));
  await saveRuntimeStatus({
    ...previous,
    lastAttemptAt: new Date().toISOString(),
    lastError: error instanceof Error ? error.message : String(error)
  });
}

export async function recordMicrosoft365SynchronizationSuccess(config: SyncConfig, result: Microsoft365SyncResult): Promise<void> {
  const previous = parseSynchronizationRuntimeStatus(await getAppSetting(synchronizationRuntimeStatusKey));
  const exchangeCount = result.created + result.updated + result.deleted;
  const successful = result.errors === 0;
  await saveRuntimeStatus({
    ...previous,
    lastAttemptAt: result.finishedAt,
    lastSuccessAt: successful ? result.finishedAt : previous.lastSuccessAt,
    lastExchangeAt: successful && exchangeCount > 0 ? result.finishedAt : previous.lastExchangeAt,
    contactsLastCheckedAt: successful && config.contacts ? result.finishedAt : previous.contactsLastCheckedAt,
    calendarsLastCheckedAt: successful && config.calendars ? result.finishedAt : previous.calendarsLastCheckedAt,
    lastError: successful ? null : result.errorMessages.join(" · ") || `${result.errors} Fehler`
  });
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

function applyCalendarChanges(calendarUpserts: CalendarEvent[], calendarDeletes: string[]): void {
  if (calendarUpserts.length === 0 && calendarDeletes.length === 0) return;
  const current = JSON.parse(localStorage.getItem(calendarStorageKey) ?? "[]") as CalendarEvent[];
  const deletedIds = new Set(calendarDeletes);
  const removed = current
    .filter((event) => deletedIds.has(event.id))
    .map((event) => ({ ...event, deletedAt: new Date().toISOString() }));
  if (removed.length > 0) {
    const trash = JSON.parse(localStorage.getItem(calendarTrashStorageKey) ?? "[]") as CalendarEvent[];
    const removedIds = new Set(removed.map((event) => event.id));
    localStorage.setItem(calendarTrashStorageKey, JSON.stringify([
      ...removed,
      ...trash.filter((event) => !removedIds.has(event.id))
    ]));
  }
  const byId = new Map(current.filter((event) => !deletedIds.has(event.id)).map((event) => [event.id, event]));
  for (const event of calendarUpserts) byId.set(event.id, event);
  localStorage.setItem(calendarStorageKey, JSON.stringify(Array.from(byId.values())));
  mergeImportedCalendarCategories(calendarUpserts);
  window.dispatchEvent(new Event(calendarStorageUpdatedEventName));
}

export async function runAutomaticCalendarSync(trigger: "open" | "change" | "poll"): Promise<CalendarAutomaticSyncStatus | null> {
  if (!("__TAURI_INTERNALS__" in window)) return null;
  const config = parseSyncConfig(await getAppSetting(synchronizationConfigKey));
  if (!config.enabled || config.paused || !config.providers.m365 || (!config.calendars && !config.contacts)) return null;
  if (trigger === "open" && !config.runOnOpen) return null;
  if (config.calendars && config.selectedCalendarSourceIds.length === 0) {
    const message = "Automatische Synchronisierung ist aktiviert, aber es wurde kein Microsoft-365-Kalender ausgewählt.";
    await recordMicrosoft365SynchronizationError(message);
    return { state: "error", message };
  }
  const selectedContactSourceIds = config.contacts && config.selectedContactSourceIds.length === 0
    ? ["me:default-contacts"]
    : config.selectedContactSourceIds;

  const attemptedAt = new Date().toISOString();
  const connection = await getMicrosoft365ConnectionStatus();
  if (!connection.connected) {
    await saveRuntimeStatus({
      ...parseSynchronizationRuntimeStatus(await getAppSetting(synchronizationRuntimeStatusKey)),
      lastAttemptAt: attemptedAt,
      lastError: "Microsoft 365 ist momentan nicht verbunden."
    });
    return { state: "error", message: "Die Änderung wurde lokal gespeichert. Microsoft 365 ist momentan nicht verbunden." };
  }

  const backup = addBrowserDataToBackup(await getBackupData());
  const result = await applyMicrosoft365Sync({
    direction: config.direction,
    base: config.base,
    contacts: config.contacts,
    contactGroups: config.contactGroups,
    calendars: config.calendars,
    sharedCalendars: config.sharedCalendars,
    sharedMailboxes: false,
    sharedMailboxAddresses: [],
    selectedContactSourceIds,
    selectedCalendarSourceIds: config.selectedCalendarSourceIds,
    sourceDirections: config.sourceDirections,
    decisions: {},
    backup
  });

  applyCalendarChanges(result.calendarUpserts, result.calendarDeletes);
  if (result.created + result.updated + result.deleted > 0) {
    window.dispatchEvent(new Event(m365DataUpdatedEventName));
  }
  const history = parseHistory(await getAppSetting(synchronizationHistoryKey));
  const entry: Microsoft365SyncHistoryEntry = {
    id: `${result.startedAt}-${Date.now()}`,
    startedAt: result.startedAt,
    finishedAt: result.finishedAt,
    created: result.created,
    updated: result.updated,
    deleted: result.deleted,
    ignored: result.ignored,
    conflicts: result.conflicts,
    errors: result.errors,
    errorMessages: result.errorMessages
  };
  await setAppSetting(synchronizationHistoryKey, JSON.stringify([entry, ...history].slice(0, 30)));

  const exchangeCount = result.created + result.updated + result.deleted;
  await recordMicrosoft365SynchronizationSuccess(config, result);

  if (result.errors > 0) {
    return { state: "error", message: `Microsoft-365-Synchronisierung mit ${result.errors} Fehler(n) abgeschlossen.` };
  }
  if (exchangeCount === 0) {
    return { state: "success", message: "Microsoft 365 ist bereits synchron." };
  }
  return {
    state: "success",
    message: `${exchangeCount} Änderung(en) automatisch mit Microsoft 365 synchronisiert.`
  };
}
