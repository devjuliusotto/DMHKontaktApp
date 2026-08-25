import type { BackupData } from "../types/contact";

const browserStorageKeys = [
  "agendakontakte.calendarEvents",
  "agendakontakte.deletedCalendarEvents",
  "agendakontakte.calendarCategories",
  "agendakontakte.calendarExactDuplicateCleanupBackup.v1",
  "agendakontakte.theme.colorMode",
  "agendakontakte.theme.accent",
  "dmh.contacts.fontSize",
  "dmh-dienstleistungen-bookings-v1",
  "dmh-dienstleistungen-outdoor-bookings-v1",
  "dmh-dienstleistungen-tickets-v1",
  "dmh-dienstleistungen-checkins-v1"
] as const;

const allowedStorageKeys = new Set<string>(browserStorageKeys);

export function captureBrowserStorage(): Record<string, string> {
  const browserStorage: Record<string, string> = {};
  for (const key of browserStorageKeys) {
    const value = localStorage.getItem(key);
    if (value !== null) browserStorage[key] = value;
  }

  // Presence matters for the automatic archive: an explicit empty calendar
  // means that the user really has no current events, while a missing key can
  // mean that the frontend has not initialized yet.
  if (!Object.prototype.hasOwnProperty.call(browserStorage, "agendakontakte.calendarEvents")) {
    browserStorage["agendakontakte.calendarEvents"] = "[]";
  }
  if (!Object.prototype.hasOwnProperty.call(browserStorage, "agendakontakte.deletedCalendarEvents")) {
    browserStorage["agendakontakte.deletedCalendarEvents"] = "[]";
  }

  return browserStorage;
}

export function addBrowserDataToBackup(backup: BackupData): BackupData {
  const browserStorage = captureBrowserStorage();
  return {
    ...backup,
    version: "2.0.0",
    browserStorage
  };
}

export function restoreBrowserDataFromBackup(backup: Pick<BackupData, "browserStorage">): void {
  if (!backup.browserStorage) return;
  for (const key of browserStorageKeys) localStorage.removeItem(key);
  for (const [key, value] of Object.entries(backup.browserStorage)) {
    if (allowedStorageKeys.has(key) && typeof value === "string") {
      localStorage.setItem(key, value);
    }
  }
}
