import type { BackupData } from "../types/contact";

const browserStorageKeys = [
  "agendakontakte.calendarEvents",
  "agendakontakte.deletedCalendarEvents",
  "agendakontakte.calendarCategories",
  "agendakontakte.calendarExactDuplicateCleanupBackup.v1",
  "agendakontakte.theme.colorMode",
  "agendakontakte.theme.accent",
  "dmh.contacts.fontSize"
] as const;

const allowedStorageKeys = new Set<string>(browserStorageKeys);

export function addBrowserDataToBackup(backup: BackupData): BackupData {
  const browserStorage: Record<string, string> = {};
  for (const key of browserStorageKeys) {
    const value = localStorage.getItem(key);
    if (value !== null) browserStorage[key] = value;
  }
  return {
    ...backup,
    version: "2.0.0",
    browserStorage
  };
}

export function restoreBrowserDataFromBackup(backup: BackupData): void {
  if (!backup.browserStorage) return;
  for (const key of browserStorageKeys) localStorage.removeItem(key);
  for (const [key, value] of Object.entries(backup.browserStorage)) {
    if (allowedStorageKeys.has(key) && typeof value === "string") {
      localStorage.setItem(key, value);
    }
  }
}
