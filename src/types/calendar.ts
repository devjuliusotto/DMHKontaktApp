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

export interface CalendarEvent {
  id: string;
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
}

export interface OutlookOneTimeCalendarImportResult {
  found: number;
  skippedInvalid: number;
  events: CalendarEvent[];
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
