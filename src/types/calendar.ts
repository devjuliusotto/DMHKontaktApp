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
