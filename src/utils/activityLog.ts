import { readActivityCenterEnabled } from "./settings";

export type ActivityTone = "success" | "info" | "error";

export interface ActivityEntry {
  id: string;
  title: string;
  summary: string;
  tone: ActivityTone;
  createdAt: string;
  read: boolean;
  details?: string[];
  items?: Array<{ label: string; detail?: string }>;
}

export interface NewActivity {
  title: string;
  summary: string;
  tone?: ActivityTone;
  details?: string[];
  items?: Array<{ label: string; detail?: string }>;
}

export const activityChangedEventName = "dmh:activity-changed";
const activityStorageKey = "dmh.activity-log.v1";
const maximumActivityEntries = 50;
const duplicateWindowMs = 15_000;
const maximumStoredDetails = 20;
const maximumStoredItems = 100;

function boundedText(value: string, maximumLength: number): string {
  const normalized = value.trim();
  return normalized.length <= maximumLength ? normalized : `${normalized.slice(0, maximumLength - 1)}…`;
}

function createActivityId(): string {
  if (typeof crypto !== "undefined" && "randomUUID" in crypto) return crypto.randomUUID();
  return `${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

export function readActivities(): ActivityEntry[] {
  try {
    const parsed = JSON.parse(localStorage.getItem(activityStorageKey) ?? "[]") as unknown;
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((entry): entry is ActivityEntry => {
      if (!entry || typeof entry !== "object") return false;
      const candidate = entry as Partial<ActivityEntry>;
      return typeof candidate.id === "string"
        && typeof candidate.title === "string"
        && typeof candidate.summary === "string"
        && typeof candidate.createdAt === "string"
        && (candidate.tone === "success" || candidate.tone === "info" || candidate.tone === "error");
    }).slice(0, maximumActivityEntries);
  } catch {
    return [];
  }
}

function persistActivities(entries: ActivityEntry[]): void {
  try {
    localStorage.setItem(activityStorageKey, JSON.stringify(entries.slice(0, maximumActivityEntries)));
  } catch {
    // A full or unavailable WebView storage must never interrupt the user's work.
  }
  window.dispatchEvent(new Event(activityChangedEventName));
}

export function recordActivity(activity: NewActivity): void {
  if (!readActivityCenterEnabled()) return;
  const summary = boundedText(activity.summary, 1_000);
  if (!summary) return;
  const entries = readActivities();
  const newest = entries[0];
  const duplicate = newest
    && newest.title === activity.title
    && newest.summary === summary
    && Date.now() - new Date(newest.createdAt).getTime() < duplicateWindowMs;
  if (duplicate) return;

  const storedDetails = activity.details
    ?.slice(0, maximumStoredDetails)
    .map((detail) => boundedText(detail, 500));
  if (activity.details && activity.details.length > maximumStoredDetails) {
    storedDetails?.push(`${activity.details.length - maximumStoredDetails} weitere Hinweise wurden in dieser kompakten Verlaufsansicht ausgelassen.`);
  }
  const storedItems = activity.items
    ?.slice(0, maximumStoredItems)
    .map((item) => ({
      label: boundedText(item.label, 250),
      detail: item.detail ? boundedText(item.detail, 350) : undefined
    }));
  if (activity.items && activity.items.length > maximumStoredItems) {
    storedItems?.push({ label: `${activity.items.length - maximumStoredItems} weitere Einträge`, detail: "Die vollständige Liste wurde aus Speichergründen nicht dauerhaft im Verlauf abgelegt." });
  }

  persistActivities([{
    id: createActivityId(),
    title: boundedText(activity.title, 160),
    summary,
    tone: activity.tone ?? "info",
    createdAt: new Date().toISOString(),
    read: false,
    details: storedDetails,
    items: storedItems
  }, ...entries]);
}

export function markAllActivitiesRead(): void {
  persistActivities(readActivities().map((entry) => ({ ...entry, read: true })));
}

export function clearActivities(): void {
  try {
    localStorage.removeItem(activityStorageKey);
  } catch {
    // The in-memory UI still refreshes even if storage is unavailable.
  }
  window.dispatchEvent(new Event(activityChangedEventName));
}
