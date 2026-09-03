import { getAppSetting, listMicrosoft365SyncSources, setAppSetting } from "../services/db";
import type { Microsoft365SyncSource, Microsoft365SyncSources } from "../types/m365";
import { parseSyncConfig, type SyncConfig } from "../types/sync";
import { synchronizationConfigKey } from "./automaticCalendarSync";

export const completeAutomaticSyncInitializedKey = "m365_complete_automatic_sync_initialized_v1";

export function isTechnicalMicrosoft365Source(source: Microsoft365SyncSource): boolean {
  return /(birthday|birthdays|geburtstag|geburtstage|holiday|holidays|feiertag|feiertage|weather|wetter|trash|papierkorb)/i.test(source.name);
}

export function initializeMicrosoft365SourceSelection(config: SyncConfig, sources: Microsoft365SyncSources): SyncConfig {
  const sourceDirections = { ...config.sourceDirections };
  const selectedContactSourceIds = new Set(config.selectedContactSourceIds);
  const selectedCalendarSourceIds = new Set(config.selectedCalendarSourceIds);

  for (const source of [...sources.contacts, ...sources.calendars]) {
    if (sourceDirections[source.id]) continue;
    sourceDirections[source.id] = config.direction;
    if (isTechnicalMicrosoft365Source(source)) continue;
    if (source.kind === "contactFolder") selectedContactSourceIds.add(source.id);
    else selectedCalendarSourceIds.add(source.id);
  }

  return {
    ...config,
    sourceSelectionInitialized: true,
    selectedContactSourceIds: Array.from(selectedContactSourceIds),
    selectedCalendarSourceIds: Array.from(selectedCalendarSourceIds),
    sourceDirections
  };
}

export function selectAllMicrosoft365Sources(config: SyncConfig, sources: Microsoft365SyncSources): SyncConfig {
  const sourceDirections = { ...config.sourceDirections };
  const selectedContactSourceIds = new Set(config.selectedContactSourceIds);
  const selectedCalendarSourceIds = new Set(config.selectedCalendarSourceIds);

  for (const source of [...sources.contacts, ...sources.calendars]) {
    if (isTechnicalMicrosoft365Source(source)) continue;
    sourceDirections[source.id] = "bidirectional";
    if (source.kind === "contactFolder") selectedContactSourceIds.add(source.id);
    else selectedCalendarSourceIds.add(source.id);
  }

  return {
    ...config,
    enabled: true,
    paused: false,
    providers: { ...config.providers, m365: true },
    direction: "bidirectional",
    contacts: true,
    contactGroups: true,
    calendars: true,
    recurringEvents: true,
    attendeesAndTeamsLinks: true,
    categoriesAndColors: true,
    sourceSelectionInitialized: true,
    selectedContactSourceIds: Array.from(selectedContactSourceIds),
    selectedCalendarSourceIds: Array.from(selectedCalendarSourceIds),
    sourceDirections,
    runOnOpen: true,
    runOnClose: true
  };
}

export async function enableCompleteAutomaticMicrosoft365Sync(force = false): Promise<SyncConfig> {
  const [rawConfig, initialized] = await Promise.all([
    getAppSetting(synchronizationConfigKey),
    getAppSetting(completeAutomaticSyncInitializedKey)
  ]);
  const current = parseSyncConfig(rawConfig);
  if (!force && initialized === "true") return current;

  const sources = await listMicrosoft365SyncSources(current.sharedMailboxAddresses);
  const next = selectAllMicrosoft365Sources(current, sources);
  await Promise.all([
    setAppSetting(synchronizationConfigKey, JSON.stringify(next)),
    setAppSetting(completeAutomaticSyncInitializedKey, "true")
  ]);
  return next;
}
