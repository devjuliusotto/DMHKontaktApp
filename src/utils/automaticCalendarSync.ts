import {
  applyMicrosoft365Sync,
  flushMicrosoft365CalendarOutbox,
  getAppSetting,
  getSyncBackupData,
  getMicrosoft365ConnectionStatus,
  moveCalendarEventsToTrashFromMicrosoft365,
  saveCalendarEventsFromMicrosoft365,
  setAppSetting
} from "../services/db";
import type { CalendarEvent } from "../types/calendar";
import type { Microsoft365SyncHistoryEntry, Microsoft365SyncResult } from "../types/m365";
import { parseSyncConfig, type SyncConfig } from "../types/sync";
import { mergeImportedCalendarCategories } from "./calendar";

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

async function applyCalendarChanges(calendarUpserts: CalendarEvent[], calendarDeletes: string[]): Promise<void> {
  if (calendarUpserts.length === 0 && calendarDeletes.length === 0) return;
  if (calendarUpserts.length > 0) await saveCalendarEventsFromMicrosoft365(calendarUpserts);
  if (calendarDeletes.length > 0) await moveCalendarEventsToTrashFromMicrosoft365(calendarDeletes);
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

  // Local calendar changes use a durable SQLite outbox. They are sent first
  // and are only removed after Microsoft Graph confirms the write. This avoids
  // re-scanning a 50,000-item calendar before a newly saved appointment can
  // leave the app.
  const queued = await flushMicrosoft365CalendarOutbox({
    direction: config.direction,
    selectedCalendarSourceIds: config.selectedCalendarSourceIds,
    sourceDirections: config.sourceDirections,
    sharedCalendars: config.sharedCalendars,
    sharedMailboxAddresses: config.sharedMailboxAddresses
  });
  const queuedExchangeCount = queued.created + queued.updated + queued.deleted;
  if (queued.created > 0) window.dispatchEvent(new Event(calendarStorageUpdatedEventName));

  // Outbound calendar writes and inbound reconciliation are two independent
  // halves of the same cycle.  Finishing the cycle after flushing the outbox
  // meant that a busy local calendar could indefinitely starve changes made
  // in Exchange/Teams.  The full synchronizer now receives only calendar
  // sources that permit importing, and those sources are forced to import-only
  // here because outbound writes are already handled safely by the outbox.
  const inboundCalendarSourceIds = config.calendars
    ? config.selectedCalendarSourceIds.filter((sourceId) =>
        (config.sourceDirections[sourceId] ?? config.direction) !== "export")
    : [];
  const reconciliationSourceDirections = { ...config.sourceDirections };
  for (const sourceId of inboundCalendarSourceIds) reconciliationSourceDirections[sourceId] = "import";
  const shouldRunReconciliation = config.contacts || inboundCalendarSourceIds.length > 0;

  if (!shouldRunReconciliation) {
    if (queued.errors > 0) {
      const message = queued.errorMessages.join(" · ") || "Die ausstehenden Kalenderänderungen werden erneut versucht.";
      await recordMicrosoft365SynchronizationError(message);
      return { state: "error", message: `Exchange konnte ${queued.errors} Kalenderänderung(en) noch nicht übernehmen: ${message}` };
    }
    if (queued.processed > 0) window.dispatchEvent(new Event(m365DataUpdatedEventName));
    return queued.processed > 0
      ? {
          state: "success",
          message: queuedExchangeCount > 0
            ? `${queuedExchangeCount} Kalenderänderung(en) sicher an Exchange übertragen.`
            : "Lokale Kalenderänderung wurde abgeglichen."
        }
      : { state: "success", message: "Microsoft 365 ist bereits synchron." };
  }

  // Calendar records are read directly by the native synchronizer. This keeps
  // large calendars out of the WebView and avoids a second full backup on each
  // 30-second synchronization cycle.
  const backup = await getSyncBackupData();
  const result = await applyMicrosoft365Sync({
    direction: config.direction,
    base: config.base,
    contacts: config.contacts,
    contactGroups: config.contactGroups,
    calendars: inboundCalendarSourceIds.length > 0,
    sharedCalendars: config.sharedCalendars,
    sharedMailboxes: false,
    sharedMailboxAddresses: [],
    selectedContactSourceIds,
    selectedCalendarSourceIds: inboundCalendarSourceIds,
    sourceDirections: reconciliationSourceDirections,
    decisions: {},
    backup
  });

  await applyCalendarChanges(result.calendarUpserts, result.calendarDeletes);
  if (result.created + result.updated + result.deleted > 0) {
    window.dispatchEvent(new Event(m365DataUpdatedEventName));
  }
  const combinedResult: Microsoft365SyncResult = {
    ...result,
    created: result.created + queued.created,
    updated: result.updated + queued.updated,
    deleted: result.deleted + queued.deleted,
    errors: result.errors + queued.errors,
    errorMessages: [...queued.errorMessages, ...result.errorMessages]
  };
  const history = parseHistory(await getAppSetting(synchronizationHistoryKey));
  const entry: Microsoft365SyncHistoryEntry = {
    id: `${combinedResult.startedAt}-${Date.now()}`,
    startedAt: combinedResult.startedAt,
    finishedAt: combinedResult.finishedAt,
    created: combinedResult.created,
    updated: combinedResult.updated,
    deleted: combinedResult.deleted,
    ignored: combinedResult.ignored,
    conflicts: combinedResult.conflicts,
    errors: combinedResult.errors,
    errorMessages: combinedResult.errorMessages
  };
  await setAppSetting(synchronizationHistoryKey, JSON.stringify([entry, ...history].slice(0, 30)));

  const exchangeCount = combinedResult.created + combinedResult.updated + combinedResult.deleted;
  await recordMicrosoft365SynchronizationSuccess(config, combinedResult);

  if (combinedResult.errors > 0) {
    return { state: "error", message: `Microsoft-365-Synchronisierung mit ${combinedResult.errors} Fehler(n) abgeschlossen.` };
  }
  if (result.conflicts > 0) {
    return {
      state: "error",
      message: `${result.conflicts} bereits vorhandene Einträge wurden vorsichtshalber nicht geändert. Die EDV kann sie später prüfen.`
    };
  }
  if (exchangeCount === 0) {
    return { state: "success", message: "Microsoft 365 ist bereits synchron." };
  }
  return {
    state: "success",
    message: `${exchangeCount} Änderung(en) automatisch mit Microsoft 365 synchronisiert.`
  };
}
