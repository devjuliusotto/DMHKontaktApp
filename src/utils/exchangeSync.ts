import type { CalendarEvent } from "../types/calendar";
import type { ExchangeSyncResult, ExchangeSyncStatus } from "../types/m365";
import { calendarStorageKey, calendarTrashStorageKey } from "./calendar";

export const exchangeSyncRequestedEvent = "dmh:exchange-sync-requested";
export const exchangeSyncCompletedEvent = "dmh:exchange-sync-completed";
export const exchangeSyncStatusEvent = "dmh:exchange-sync-status";

function readEvents(key: string): CalendarEvent[] {
  try {
    const value = JSON.parse(localStorage.getItem(key) ?? "[]") as CalendarEvent[];
    return Array.isArray(value) ? value : [];
  } catch {
    return [];
  }
}

export function readCalendarSyncData() {
  return {
    calendarEvents: readEvents(calendarStorageKey),
    deletedCalendarEvents: readEvents(calendarTrashStorageKey)
  };
}

export function applyExchangeSyncResult(result: ExchangeSyncResult) {
  localStorage.setItem(calendarStorageKey, JSON.stringify(result.calendarEvents));
  localStorage.setItem(calendarTrashStorageKey, JSON.stringify(result.deletedCalendarEvents));
  localStorage.setItem("agendakontakte.exchangeLastSync", result.syncedAt);
  window.dispatchEvent(new CustomEvent(exchangeSyncCompletedEvent, { detail: result }));
}

export function requestExchangeSync() {
  window.dispatchEvent(new Event(exchangeSyncRequestedEvent));
}

export function publishExchangeSyncStatus(status: ExchangeSyncStatus) {
  window.dispatchEvent(new CustomEvent(exchangeSyncStatusEvent, { detail: status }));
}
