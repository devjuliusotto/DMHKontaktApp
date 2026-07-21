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
}

export interface OutlookOneTimeCalendarImportResult {
  found: number;
  skippedInvalid: number;
  events: CalendarEvent[];
}
