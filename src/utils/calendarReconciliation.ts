import type { CalendarEvent } from "../types/calendar";
import { parseCalendarDate } from "./calendar";

export const calendarReconciliationBaselineKey = "agendakontakte.calendarReconciliationBaseline.v1";

export type CalendarReconciliationStatus = "new" | "update" | "exact" | "local" | "conflict";

export interface CalendarReconciliationItem {
  key: string;
  status: CalendarReconciliationStatus;
  incoming: CalendarEvent;
  existing?: CalendarEvent;
}

export interface CalendarReconciliationPreview {
  items: CalendarReconciliationItem[];
  newEvents: number;
  updates: number;
  exact: number;
  localChanges: number;
  conflicts: number;
  localOnly: number;
}

type CalendarBaseline = Record<string, Record<string, string>>;

function normalizedText(value?: string): string {
  return (value ?? "").trim().replace(/\s+/g, " ").toLocaleLowerCase("de-DE");
}

function normalizedDate(value?: string): string {
  const parsed = value ? parseCalendarDate(value) : null;
  return parsed ? parsed.toISOString() : (value ?? "").trim();
}

function stableObject(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableObject).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, entry]) => `${JSON.stringify(key)}:${stableObject(entry)}`)
      .join(",")}}`;
  }
  return JSON.stringify(value ?? null);
}

export function calendarReconciliationFingerprint(event: CalendarEvent): string {
  return stableObject({
    title: normalizedText(event.title),
    startsAt: normalizedDate(event.startsAt),
    endsAt: normalizedDate(event.endsAt || event.startsAt),
    location: normalizedText(event.location),
    description: normalizedText(event.description),
    color: event.color ?? "",
    category: normalizedText(event.category),
    recurrence: event.recurrence ?? null,
    excludedDates: [...(event.excludedDates ?? [])].sort(),
    recurrenceMasterId: event.recurrenceMasterId ?? "",
    recurrenceId: event.recurrenceId ?? ""
  });
}

function semanticKey(event: CalendarEvent): string {
  return stableObject({
    title: normalizedText(event.title),
    startsAt: normalizedDate(event.startsAt),
    endsAt: normalizedDate(event.endsAt || event.startsAt),
    location: normalizedText(event.location),
    description: normalizedText(event.description),
    recurrence: event.recurrence ?? null,
    excludedDates: [...(event.excludedDates ?? [])].sort()
  });
}

function likelySameEventKey(event: CalendarEvent): string {
  return `${normalizedText(event.title)}\n${normalizedDate(event.startsAt)}`;
}

export function readCalendarReconciliationBaseline(platform: string): Record<string, string> {
  try {
    const parsed = JSON.parse(localStorage.getItem(calendarReconciliationBaselineKey) ?? "{}") as CalendarBaseline;
    return parsed && typeof parsed === "object" ? parsed[platform] ?? {} : {};
  } catch {
    return {};
  }
}

export function writeCalendarReconciliationBaseline(platform: string, incoming: CalendarEvent[]): void {
  let baselines: CalendarBaseline = {};
  try {
    const parsed = JSON.parse(localStorage.getItem(calendarReconciliationBaselineKey) ?? "{}") as CalendarBaseline;
    if (parsed && typeof parsed === "object") baselines = parsed;
  } catch {
    baselines = {};
  }
  baselines[platform] = Object.fromEntries(
    incoming.filter((event) => event.id).map((event) => [event.id, calendarReconciliationFingerprint(event)])
  );
  localStorage.setItem(calendarReconciliationBaselineKey, JSON.stringify(baselines));
}

export function compareCalendars(
  existing: CalendarEvent[],
  incoming: CalendarEvent[],
  baseline: Record<string, string>
): CalendarReconciliationPreview {
  const byId = new Map(existing.map((event) => [event.id, event]));
  const bySemantic = new Map<string, CalendarEvent[]>();
  const byLikelyMatch = new Map<string, CalendarEvent[]>();
  for (const event of existing) {
    const semantic = semanticKey(event);
    bySemantic.set(semantic, [...(bySemantic.get(semantic) ?? []), event]);
    const likely = likelySameEventKey(event);
    byLikelyMatch.set(likely, [...(byLikelyMatch.get(likely) ?? []), event]);
  }

  const matchedLocalIds = new Set<string>();
  const seenIncomingIds = new Set<string>();
  const seenIncomingContent = new Set<string>();
  const items: CalendarReconciliationItem[] = [];

  for (const incomingEvent of incoming) {
    const fingerprint = calendarReconciliationFingerprint(incomingEvent);
    const incomingSemantic = semanticKey(incomingEvent);
    if ((incomingEvent.id && seenIncomingIds.has(incomingEvent.id)) || seenIncomingContent.has(incomingSemantic)) {
      items.push({ key: `${incomingEvent.id}-duplicate-${items.length}`, status: "exact", incoming: incomingEvent });
      continue;
    }
    if (incomingEvent.id) seenIncomingIds.add(incomingEvent.id);
    seenIncomingContent.add(incomingSemantic);

    const sameId = byId.get(incomingEvent.id);
    if (sameId) {
      matchedLocalIds.add(sameId.id);
      const localFingerprint = calendarReconciliationFingerprint(sameId);
      if (localFingerprint === fingerprint) {
        items.push({ key: incomingEvent.id, status: "exact", incoming: incomingEvent, existing: sameId });
        continue;
      }
      const previous = baseline[incomingEvent.id];
      if (previous) {
        const localChanged = localFingerprint !== previous;
        const externalChanged = fingerprint !== previous;
        if (externalChanged && !localChanged) {
          items.push({ key: incomingEvent.id, status: "update", incoming: incomingEvent, existing: sameId });
          continue;
        }
        if (localChanged && !externalChanged) {
          items.push({ key: incomingEvent.id, status: "local", incoming: incomingEvent, existing: sameId });
          continue;
        }
      }
      items.push({ key: incomingEvent.id, status: "conflict", incoming: incomingEvent, existing: sameId });
      continue;
    }

    const exactMatch = (bySemantic.get(incomingSemantic) ?? []).find((event) => !matchedLocalIds.has(event.id));
    if (exactMatch) {
      matchedLocalIds.add(exactMatch.id);
      items.push({ key: incomingEvent.id, status: "exact", incoming: incomingEvent, existing: exactMatch });
      continue;
    }

    const likelyMatch = (byLikelyMatch.get(likelySameEventKey(incomingEvent)) ?? [])
      .find((event) => !matchedLocalIds.has(event.id));
    if (likelyMatch && normalizedText(incomingEvent.title)) {
      matchedLocalIds.add(likelyMatch.id);
      items.push({ key: incomingEvent.id, status: "conflict", incoming: incomingEvent, existing: likelyMatch });
      continue;
    }

    items.push({ key: incomingEvent.id, status: "new", incoming: incomingEvent });
  }

  const count = (status: CalendarReconciliationStatus) => items.filter((item) => item.status === status).length;
  return {
    items,
    newEvents: count("new"),
    updates: count("update"),
    exact: count("exact"),
    localChanges: count("local"),
    conflicts: count("conflict"),
    localOnly: existing.filter((event) => !matchedLocalIds.has(event.id)).length
  };
}

export function applyCalendarReconciliation(
  existing: CalendarEvent[],
  preview: CalendarReconciliationPreview,
  conflictChoices: Record<string, "local" | "external">
): CalendarEvent[] {
  const next = new Map(existing.map((event) => [event.id, event]));
  for (const item of preview.items) {
    const useExternal = item.status === "new"
      || item.status === "update"
      || (item.status === "conflict" && conflictChoices[item.key] === "external");
    if (!useExternal) continue;
    if (item.existing && item.existing.id !== item.incoming.id) next.delete(item.existing.id);
    next.set(item.incoming.id, item.incoming);
  }
  return Array.from(next.values()).sort((left, right) => left.startsAt.localeCompare(right.startsAt));
}
