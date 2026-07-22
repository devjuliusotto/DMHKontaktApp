import type { CSSProperties } from "react";
import type { CalendarEvent, CalendarRecurrence } from "../types/calendar";

export const defaultCalendarColor = "blue";
export const calendarStorageKey = "agendakontakte.calendarEvents";
export const calendarTrashStorageKey = "agendakontakte.deletedCalendarEvents";

export const calendarColorOptions = [
  { value: "blue", label: "Blau", chip: "#dceafe", border: "#2563eb" },
  { value: "green", label: "Grün", chip: "#dff5e8", border: "#15803d" },
  { value: "yellow", label: "Gelb", chip: "#fff4c2", border: "#ca8a04" },
  { value: "red", label: "Rot", chip: "#ffe1e1", border: "#dc2626" },
  { value: "purple", label: "Lila", chip: "#eadcff", border: "#7c3aed" },
  { value: "gray", label: "Grau", chip: "#eceff3", border: "#64748b" }
];

const weekdayCodes = ["SU", "MO", "TU", "WE", "TH", "FR", "SA"];

export function calendarColorValue(value?: string): string {
  return value && calendarColorOptions.some((color) => color.value === value) ? value : defaultCalendarColor;
}

export function calendarColorFromCategory(category: string, fallback = defaultCalendarColor): string {
  const normalized = category.trim().toLocaleLowerCase("de");
  if (/(rot|red|rosa|pink)/.test(normalized)) return "red";
  if (/(grün|gruen|green|türkis|tuerkis|teal|olive)/.test(normalized)) return "green";
  if (/(gelb|yellow|orange|peach)/.test(normalized)) return "yellow";
  if (/(lila|violett|purple|maroon)/.test(normalized)) return "purple";
  if (/(grau|gray|grey|schwarz|black|steel)/.test(normalized)) return "gray";
  if (/(blau|blue)/.test(normalized)) return "blue";
  return calendarColorValue(fallback);
}

export function calendarColorStyle(value?: string) {
  const color = calendarColorOptions.find((option) => option.value === calendarColorValue(value)) ?? calendarColorOptions[0];
  return {
    "--event-bg": color.chip,
    "--event-border": color.border
  } as CSSProperties;
}

function unfoldIcs(text: string): string {
  return text.replace(/\r?\n[ \t]/g, "");
}

function decodeText(bytes: Uint8Array): string {
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    return new TextDecoder("windows-1252").decode(bytes);
  }
}

function propertyLines(lines: string[], key: string): string[] {
  const upperKey = key.toUpperCase();
  return lines.filter((line) => {
    const upper = line.toUpperCase();
    return upper.startsWith(`${upperKey}:`) || upper.startsWith(`${upperKey};`);
  });
}

function unescapeIcsText(raw: string): string {
  return raw
    .replace(/\\n/gi, "\n")
    .replace(/\\,/g, ",")
    .replace(/\\;/g, ";")
    .replace(/\\\\/g, "\\")
    .trim();
}

function propertyValue(line?: string): string {
  if (!line) return "";
  const separator = line.indexOf(":");
  return separator >= 0 ? unescapeIcsText(line.slice(separator + 1)) : "";
}

function value(lines: string[], key: string): string {
  return propertyValue(propertyLines(lines, key)[0]);
}

function parseIcsDate(raw: string): string {
  if (!raw) return "";
  const match = raw.trim().match(/^(\d{4})(\d{2})(\d{2})(?:T(\d{2})(\d{2})(\d{2}))?(Z)?/i);
  if (!match) return raw;
  const [, year, month, day, hour = "00", minute = "00", second = "00", utc] = match;
  return `${year}-${month}-${day}T${hour}:${minute}:${second}${utc ? "Z" : ""}`;
}

export function parseCalendarDate(value: string): Date | null {
  if (!value) return null;
  const normalized = value
    .trim()
    .replace(/(\.\d{3})\d+/, "$1")
    .replace(/([+-]\d{2})(\d{2})$/, "$1:$2");
  const date = new Date(normalized);
  return Number.isNaN(date.getTime()) ? null : date;
}

function escapeIcs(value: string): string {
  return value.replace(/\\/g, "\\\\").replace(/\r?\n/g, "\\n").replace(/,/g, "\\,").replace(/;/g, "\\;");
}

function toIcsDate(value: string): string {
  const date = parseCalendarDate(value);
  return date ? date.toISOString().replace(/[-:]/g, "").replace(/\.\d{3}Z$/, "Z") : "";
}

function recurrenceToRrule(recurrence?: CalendarRecurrence | null): string {
  if (!recurrence) return "";
  const parts = [`FREQ=${recurrence.frequency.toUpperCase()}`];
  if (recurrence.interval > 1) parts.push(`INTERVAL=${Math.max(1, Math.floor(recurrence.interval))}`);
  if (recurrence.daysOfWeek?.length) {
    const prefix = recurrence.weekOfMonth && recurrence.weekOfMonth !== 0 ? String(recurrence.weekOfMonth) : "";
    parts.push(`BYDAY=${recurrence.daysOfWeek.map((day) => `${prefix}${weekdayCodes[day]}`).join(",")}`);
  }
  if (recurrence.dayOfMonth) parts.push(`BYMONTHDAY=${recurrence.dayOfMonth}`);
  if (recurrence.monthOfYear) parts.push(`BYMONTH=${recurrence.monthOfYear}`);
  if (recurrence.count) parts.push(`COUNT=${Math.max(1, Math.floor(recurrence.count))}`);
  else if (recurrence.until) parts.push(`UNTIL=${recurrence.until.replace(/-/g, "")}T235959Z`);
  return `RRULE:${parts.join(";")}`;
}

function excludedDateTime(dateValue: string, startsAt: string): string {
  const start = parseCalendarDate(startsAt);
  const date = parseCalendarDate(dateValue.length === 10 ? `${dateValue}T00:00:00` : dateValue);
  if (!start || !date) return "";
  date.setHours(start.getHours(), start.getMinutes(), start.getSeconds(), 0);
  return toIcsDate(date.toISOString());
}

export function exportCalendarIcs(events: CalendarEvent[]): string {
  const entries = events.map((event) => {
    const recurrence = recurrenceToRrule(event.recurrence);
    const exclusions = (event.excludedDates ?? [])
      .map((date) => excludedDateTime(date, event.startsAt))
      .filter(Boolean);
    return [
      "BEGIN:VEVENT",
      `UID:${escapeIcs(event.recurrenceMasterId ?? event.id)}`,
      `DTSTAMP:${toIcsDate(new Date().toISOString())}`,
      `DTSTART:${toIcsDate(event.startsAt)}`,
      `DTEND:${toIcsDate(event.endsAt || event.startsAt)}`,
      `SUMMARY:${escapeIcs(event.title)}`,
      `LOCATION:${escapeIcs(event.location)}`,
      event.category ? `CATEGORIES:${escapeIcs(event.category)}` : "",
      `COLOR:${calendarColorOptions.find((color) => color.value === calendarColorValue(event.color))?.border ?? "#2563eb"}`,
      recurrence,
      exclusions.length ? `EXDATE:${exclusions.join(",")}` : "",
      event.recurrenceId ? `RECURRENCE-ID:${toIcsDate(event.recurrenceId)}` : "",
      `DESCRIPTION:${escapeIcs(event.description)}`,
      "END:VEVENT"
    ].filter(Boolean).join("\r\n");
  });
  return ["BEGIN:VCALENDAR", "VERSION:2.0", "PRODID:-//DMH//Kontakte und Kalender//DE", "CALSCALE:GREGORIAN", ...entries, "END:VCALENDAR", ""].join("\r\n");
}

function parseNumber(value: string | undefined): number | undefined {
  if (!value) return undefined;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function parseRecurrence(raw: string): CalendarRecurrence | null {
  if (!raw) return null;
  const fields = new Map(raw.split(";").map((part) => {
    const [key, ...rest] = part.split("=");
    return [key.toUpperCase(), rest.join("=")];
  }));
  const frequency = fields.get("FREQ")?.toLowerCase();
  if (frequency !== "daily" && frequency !== "weekly" && frequency !== "monthly" && frequency !== "yearly") return null;
  const byDay = fields.get("BYDAY")?.split(",").filter(Boolean) ?? [];
  const daysOfWeek = byDay
    .map((entry) => weekdayCodes.indexOf(entry.slice(-2).toUpperCase()))
    .filter((day) => day >= 0);
  const ordinal = byDay.length ? parseNumber(byDay[0].slice(0, -2)) : undefined;
  const untilRaw = fields.get("UNTIL");
  return {
    frequency,
    interval: Math.max(1, parseNumber(fields.get("INTERVAL")) ?? 1),
    daysOfWeek: daysOfWeek.length ? daysOfWeek : undefined,
    dayOfMonth: parseNumber(fields.get("BYMONTHDAY")),
    monthOfYear: parseNumber(fields.get("BYMONTH")),
    weekOfMonth: parseNumber(fields.get("BYSETPOS")) ?? ordinal,
    count: parseNumber(fields.get("COUNT")),
    until: untilRaw ? parseIcsDate(untilRaw).slice(0, 10) : undefined
  };
}

function colorFromHex(raw: string, category: string): string {
  const match = raw.trim().match(/^#?([0-9a-f]{6})/i);
  if (!match) return calendarColorFromCategory(category);
  const value = Number.parseInt(match[1], 16);
  const red = (value >> 16) & 255;
  const green = (value >> 8) & 255;
  const blue = value & 255;
  const closest = calendarColorOptions.reduce((best, option) => {
    const target = Number.parseInt(option.border.slice(1), 16);
    const distance = Math.pow(red - ((target >> 16) & 255), 2)
      + Math.pow(green - ((target >> 8) & 255), 2)
      + Math.pow(blue - (target & 255), 2);
    return distance < best.distance ? { value: option.value, distance } : best;
  }, { value: defaultCalendarColor, distance: Number.POSITIVE_INFINITY });
  return closest.value;
}

interface ParsedCalendarEvent extends CalendarEvent {
  uid: string;
  cancelled: boolean;
}

export function parseCalendarFile(bytes: Uint8Array, source: string): CalendarEvent[] {
  const rawText = decodeText(bytes);
  const icsStart = rawText.indexOf("BEGIN:VCALENDAR");
  const text = unfoldIcs(icsStart >= 0 ? rawText.slice(icsStart) : rawText);
  const globalColor = propertyValue(propertyLines(text.split(/\r?\n/), "X-APPLE-CALENDAR-COLOR")[0]);
  const blocks = text.match(/BEGIN:VEVENT[\s\S]*?END:VEVENT/g) ?? [];

  const parsed: ParsedCalendarEvent[] = blocks.map((block, index) => {
    const lines = block.split(/\r?\n/);
    const uid = value(lines, "UID") || `${source}-${index}`;
    const category = value(lines, "CATEGORIES");
    const explicitColor = value(lines, "COLOR") || globalColor;
    const recurrenceId = parseIcsDate(value(lines, "RECURRENCE-ID"));
    const excludedDates = propertyLines(lines, "EXDATE")
      .flatMap((line) => propertyValue(line).split(","))
      .map(parseIcsDate)
      .filter(Boolean)
      .map((date) => date.slice(0, 10));
    return {
      uid,
      id: recurrenceId ? `${uid}::${recurrenceId}` : uid,
      title: value(lines, "SUMMARY") || "Ohne Titel",
      startsAt: parseIcsDate(value(lines, "DTSTART")),
      endsAt: parseIcsDate(value(lines, "DTEND")),
      location: value(lines, "LOCATION"),
      description: value(lines, "DESCRIPTION"),
      color: colorFromHex(explicitColor, category),
      category,
      source,
      recurrence: parseRecurrence(value(lines, "RRULE")),
      excludedDates,
      recurrenceId: recurrenceId || undefined,
      recurrenceMasterId: recurrenceId ? uid : undefined,
      cancelled: value(lines, "STATUS").toUpperCase() === "CANCELLED"
    };
  });

  const masters = new Map(parsed.filter((event) => event.recurrence).map((event) => [event.uid, event]));
  for (const event of parsed) {
    if (!event.recurrenceId) continue;
    const master = masters.get(event.uid);
    if (!master) continue;
    const excluded = new Set(master.excludedDates ?? []);
    excluded.add(event.recurrenceId.slice(0, 10));
    master.excludedDates = Array.from(excluded);
  }

  return parsed
    .filter((event) => !event.cancelled && (!event.recurrenceId || masters.has(event.uid)))
    .map(({ uid: _uid, cancelled: _cancelled, ...event }) => event);
}

function localDateKey(date: Date): string {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

function localDateTime(date: Date): string {
  const hours = String(date.getHours()).padStart(2, "0");
  const minutes = String(date.getMinutes()).padStart(2, "0");
  const seconds = String(date.getSeconds()).padStart(2, "0");
  return `${localDateKey(date)}T${hours}:${minutes}:${seconds}`;
}

function startOfLocalDay(date: Date): Date {
  return new Date(date.getFullYear(), date.getMonth(), date.getDate());
}

function addLocalDays(date: Date, days: number): Date {
  return new Date(date.getFullYear(), date.getMonth(), date.getDate() + days);
}

function startOfLocalWeek(date: Date): Date {
  const day = date.getDay() || 7;
  return addLocalDays(startOfLocalDay(date), 1 - day);
}

function monthsBetween(start: Date, candidate: Date): number {
  return (candidate.getFullYear() - start.getFullYear()) * 12 + candidate.getMonth() - start.getMonth();
}

function isNthWeekday(date: Date, ordinal: number): boolean {
  if (ordinal === -1) return new Date(date.getFullYear(), date.getMonth(), date.getDate() + 7).getMonth() !== date.getMonth();
  return Math.ceil(date.getDate() / 7) === ordinal;
}

function matchesRecurrenceDate(date: Date, start: Date, recurrence: CalendarRecurrence): boolean {
  const interval = Math.max(1, recurrence.interval || 1);
  const days = recurrence.daysOfWeek?.length ? recurrence.daysOfWeek : [start.getDay()];
  if (recurrence.frequency === "daily") {
    const difference = Math.round((startOfLocalDay(date).getTime() - startOfLocalDay(start).getTime()) / 86_400_000);
    return difference >= 0 && difference % interval === 0;
  }
  if (recurrence.frequency === "weekly") {
    const difference = Math.round((startOfLocalWeek(date).getTime() - startOfLocalWeek(start).getTime()) / (7 * 86_400_000));
    return difference >= 0 && difference % interval === 0 && days.includes(date.getDay());
  }
  if (recurrence.frequency === "monthly") {
    const difference = monthsBetween(start, date);
    if (difference < 0 || difference % interval !== 0) return false;
    if (recurrence.weekOfMonth) return days.includes(date.getDay()) && isNthWeekday(date, recurrence.weekOfMonth);
    return date.getDate() === (recurrence.dayOfMonth ?? start.getDate());
  }
  const yearDifference = date.getFullYear() - start.getFullYear();
  if (yearDifference < 0 || yearDifference % interval !== 0 || date.getMonth() + 1 !== (recurrence.monthOfYear ?? start.getMonth() + 1)) return false;
  if (recurrence.weekOfMonth) return days.includes(date.getDay()) && isNthWeekday(date, recurrence.weekOfMonth);
  return date.getDate() === (recurrence.dayOfMonth ?? start.getDate());
}

export function expandCalendarEvents(events: CalendarEvent[], rangeStart: Date, rangeEnd: Date): CalendarEvent[] {
  const expanded: CalendarEvent[] = [];
  for (const event of events) {
    const start = parseCalendarDate(event.startsAt);
    const end = parseCalendarDate(event.endsAt || event.startsAt);
    if (!start || !end) continue;
    if (!event.recurrence) {
      if (end >= rangeStart && start < rangeEnd) expanded.push(event);
      continue;
    }

    const duration = Math.max(0, end.getTime() - start.getTime());
    const excluded = new Set(event.excludedDates ?? []);
    const until = event.recurrence.until ? parseCalendarDate(`${event.recurrence.until}T23:59:59`) : null;
    let cursor = startOfLocalDay(start);
    let occurrenceNumber = 0;
    let inspectedDays = 0;
    while (cursor < rangeEnd && inspectedDays < 200_000) {
      if (until && cursor > until) break;
      if (matchesRecurrenceDate(cursor, start, event.recurrence)) {
        occurrenceNumber += 1;
        if (event.recurrence.count && occurrenceNumber > event.recurrence.count) break;
        const occurrenceStart = new Date(cursor);
        occurrenceStart.setHours(start.getHours(), start.getMinutes(), start.getSeconds(), start.getMilliseconds());
        const occurrenceEnd = new Date(occurrenceStart.getTime() + duration);
        const dateKey = localDateKey(occurrenceStart);
        if (!excluded.has(dateKey) && occurrenceEnd >= rangeStart && occurrenceStart < rangeEnd) {
          expanded.push({
            ...event,
            id: `${event.id}::${localDateTime(occurrenceStart)}`,
            startsAt: localDateTime(occurrenceStart),
            endsAt: localDateTime(occurrenceEnd),
            recurrenceMasterId: event.id,
            recurrenceId: localDateTime(occurrenceStart),
            recurrence: null
          });
        }
      }
      cursor = addLocalDays(cursor, 1);
      inspectedDays += 1;
    }
  }
  return expanded.sort((left, right) => left.startsAt.localeCompare(right.startsAt));
}

export function formatCalendarDate(value: string): string {
  if (!value) return "";
  const date = parseCalendarDate(value);
  if (!date) return value;
  return new Intl.DateTimeFormat("de-DE", { dateStyle: "medium", timeStyle: "short" }).format(date);
}
