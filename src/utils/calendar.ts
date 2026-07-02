import type { CalendarEvent } from "../types/calendar";

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

function value(lines: string[], key: string): string {
  const line = lines.find((entry) => entry.toUpperCase().startsWith(key));
  return line ? line.slice(line.indexOf(":") + 1).replace(/\\n/g, "\n").replace(/\\,/g, ",").replace(/\\;/g, ";").trim() : "";
}

function parseIcsDate(raw: string): string {
  if (!raw) return "";
  const clean = raw.replace(/Z$/, "");
  const match = clean.match(/^(\d{4})(\d{2})(\d{2})(?:T(\d{2})(\d{2})(\d{2}))?/);
  if (!match) return raw;
  const [, year, month, day, hour = "00", minute = "00", second = "00"] = match;
  return `${year}-${month}-${day}T${hour}:${minute}:${second}`;
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

export function exportCalendarIcs(events: CalendarEvent[]): string {
  const entries = events.map((event) => [
    "BEGIN:VEVENT",
    `UID:${escapeIcs(event.id)}`,
    `DTSTAMP:${toIcsDate(new Date().toISOString())}`,
    `DTSTART:${toIcsDate(event.startsAt)}`,
    `DTEND:${toIcsDate(event.endsAt || event.startsAt)}`,
    `SUMMARY:${escapeIcs(event.title)}`,
    `LOCATION:${escapeIcs(event.location)}`,
    `DESCRIPTION:${escapeIcs(event.description)}`,
    "END:VEVENT"
  ].join("\r\n"));
  return ["BEGIN:VCALENDAR", "VERSION:2.0", "PRODID:-//DMH//AgendaKontakte//DE", "CALSCALE:GREGORIAN", ...entries, "END:VCALENDAR", ""].join("\r\n");
}

export function parseCalendarFile(bytes: Uint8Array, source: string): CalendarEvent[] {
  const rawText = decodeText(bytes);
  const icsStart = rawText.indexOf("BEGIN:VCALENDAR");
  const text = unfoldIcs(icsStart >= 0 ? rawText.slice(icsStart) : rawText);
  const blocks = text.match(/BEGIN:VEVENT[\s\S]*?END:VEVENT/g) ?? [];

  return blocks.map((block, index) => {
    const lines = block.split(/\r?\n/);
    const id = value(lines, "UID:") || `${source}-${index}`;
    return {
      id,
      title: value(lines, "SUMMARY:") || "Ohne Titel",
      startsAt: parseIcsDate(value(lines, "DTSTART")),
      endsAt: parseIcsDate(value(lines, "DTEND")),
      location: value(lines, "LOCATION:"),
      description: value(lines, "DESCRIPTION:"),
      source
    };
  });
}

export function formatCalendarDate(value: string): string {
  if (!value) return "";
  const date = parseCalendarDate(value);
  if (!date) return value;
  return new Intl.DateTimeFormat("de-DE", { dateStyle: "medium", timeStyle: "short" }).format(date);
}
