export type CalendarRecurrenceFrequency = "daily" | "weekly" | "monthly" | "yearly";

export interface CalendarRecurrence {
  frequency: CalendarRecurrenceFrequency;
  interval: number;
  daysOfWeek?: number[];
  dayOfMonth?: number;
  monthOfYear?: number;
  weekOfMonth?: number;
  until?: string;
  count?: number;
}

export type CalendarAvailability = "free" | "tentative" | "busy" | "oof" | "workingElsewhere";

export interface CalendarMeetingOptions {
  requiredAttendees: string[];
  optionalAttendees: string[];
  showAs: CalendarAvailability;
  reminderMinutes: number | null;
  isPrivate: boolean;
  isOnlineMeeting: boolean;
  onlineMeetingUrl?: string;
}

export interface CalendarEvent {
  id: string;
  updatedAt?: string;
  title: string;
  startsAt: string;
  endsAt: string;
  isAllDay?: boolean;
  location: string;
  description: string;
  color: string;
  category: string;
  source: string;
  deletedAt?: string | null;
  recurrence?: CalendarRecurrence | null;
  excludedDates?: string[];
  recurrenceMasterId?: string;
  recurrenceId?: string;
  meeting?: CalendarMeetingOptions;
}

export interface CalendarEventMergeResult {
  imported: number;
  skippedSameId: number;
  skippedExactDuplicates: number;
  total: number;
}

export type CalendarFileImportJobState = "prepared" | "running" | "paused" | "failed" | "completed";

export interface CalendarFileImportStatus {
  jobId: string;
  filePath: string;
  fileName: string;
  fileSize: number;
  byteOffset: number;
  processed: number;
  imported: number;
  skippedSameId: number;
  skippedExactDuplicates: number;
  skippedInvalid: number;
  status: CalendarFileImportJobState;
  progressPercent: number;
  fallbackCategory: string;
  fallbackColor: string;
  resumable: boolean;
  lastError: string | null;
}

export interface CalendarImportCategory {
  name: string;
  color: string;
}

export interface CalendarFileImportResult extends CalendarFileImportStatus {
  categories: CalendarImportCategory[];
}

export interface CalendarOverview {
  total: number;
  sources: string[];
}

export interface CalendarDirectImportResult {
  found: number;
  skippedInvalid: number;
  imported: number;
  skippedSameId: number;
  skippedExactDuplicates: number;
}

export interface OutlookOneTimeCalendarImportResult {
  found: number;
  skippedInvalid: number;
  events: CalendarEvent[];
}

export interface OutlookCalendarExportResult {
  total: number;
  created: number;
  updated: number;
  errors: number;
  folderPath: string;
  storeName: string;
}

export interface OutlookCalendarPreviewCalendar {
  id: string;
  name: string;
  storeName: string;
  folderPath: string;
  eventCount: number;
}

export interface OutlookCalendarDuplicateGroup {
  title: string;
  startsAt: string;
  endsAt: string;
  location: string;
  occurrenceCount: number;
  calendars: string[];
}

export interface OutlookCalendarPreview {
  calendars: OutlookCalendarPreviewCalendar[];
  totalEvents: number;
  skippedInvalid: number;
  duplicateGroups: OutlookCalendarDuplicateGroup[];
}

export interface ThunderbirdCalendarImportResult {
  found: number;
  skippedInvalid: number;
  calendars: number;
  events: CalendarEvent[];
}

export type DetectedCalendarProvider = "microsoft365" | "google" | "apple" | "churchtools" | "caldav" | "ical" | "local" | "other";
export type DetectedCalendarConnectionMode = "bidirectional" | "readOnly" | "local";

export interface DetectedCalendarSource {
  id: string;
  client: "outlook" | "thunderbird";
  provider: DetectedCalendarProvider;
  providerLabel: string;
  name: string;
  account: string;
  location: string;
  connectionMode: DetectedCalendarConnectionMode;
  canImportNow: boolean;
  requiresReconnect: boolean;
}

export interface DetectedCalendarSourcesResult {
  sources: DetectedCalendarSource[];
  warnings: string[];
}
