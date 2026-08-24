export type SyncDirection = "bidirectional" | "export" | "import";
export type SyncBase = "app" | "m365" | "outlook-classic" | "thunderbird";

export interface SyncProviders {
  m365: boolean;
  outlookClassic: boolean;
  thunderbird: boolean;
}

export interface SyncConfig {
  version: 3;
  enabled: boolean;
  paused: boolean;
  providers: SyncProviders;
  direction: SyncDirection;
  base: SyncBase;
  contacts: boolean;
  contactGroups: boolean;
  calendars: boolean;
  recurringEvents: boolean;
  attendeesAndTeamsLinks: boolean;
  categoriesAndColors: boolean;
  sharedCalendars: boolean;
  sharedMailboxes: boolean;
  sharedMailboxAddresses: string[];
  sourceSelectionInitialized: boolean;
  selectedContactSourceIds: string[];
  selectedCalendarSourceIds: string[];
  sourceDirections: Record<string, SyncDirection>;
  runOnOpen: boolean;
  runOnClose: boolean;
}

export const defaultSyncConfig: SyncConfig = {
  version: 3,
  enabled: false,
  paused: false,
  providers: {
    m365: true,
    outlookClassic: true,
    thunderbird: true
  },
  direction: "bidirectional",
  base: "app",
  contacts: true,
  contactGroups: true,
  calendars: true,
  recurringEvents: true,
  attendeesAndTeamsLinks: true,
  categoriesAndColors: true,
  sharedCalendars: true,
  sharedMailboxes: true,
  sharedMailboxAddresses: [],
  sourceSelectionInitialized: false,
  selectedContactSourceIds: [],
  selectedCalendarSourceIds: [],
  sourceDirections: {},
  runOnOpen: true,
  runOnClose: true
};

export function parseSyncConfig(raw: string | null): SyncConfig {
  if (!raw) return defaultSyncConfig;
  try {
    const parsed = JSON.parse(raw) as Partial<SyncConfig>;
    return {
      ...defaultSyncConfig,
      ...parsed,
      version: 3,
      enabled: Boolean(parsed.enabled),
      paused: Boolean(parsed.paused),
      providers: {
        ...defaultSyncConfig.providers,
        ...(parsed.providers ?? {})
      },
      contacts: parsed.contacts !== false,
      contactGroups: parsed.contactGroups !== false,
      calendars: parsed.calendars !== false,
      recurringEvents: parsed.recurringEvents !== false,
      attendeesAndTeamsLinks: parsed.attendeesAndTeamsLinks !== false,
      categoriesAndColors: parsed.categoriesAndColors !== false,
      sharedCalendars: parsed.sharedCalendars !== false,
      sharedMailboxes: parsed.sharedMailboxes !== false,
      sharedMailboxAddresses: Array.isArray(parsed.sharedMailboxAddresses)
        ? parsed.sharedMailboxAddresses.filter((value): value is string => typeof value === "string" && value.trim().length > 0)
        : [],
      sourceSelectionInitialized: Boolean(parsed.sourceSelectionInitialized),
      selectedContactSourceIds: Array.isArray(parsed.selectedContactSourceIds)
        ? parsed.selectedContactSourceIds.filter((value): value is string => typeof value === "string")
        : [],
      selectedCalendarSourceIds: Array.isArray(parsed.selectedCalendarSourceIds)
        ? parsed.selectedCalendarSourceIds.filter((value): value is string => typeof value === "string")
        : [],
      sourceDirections: parsed.sourceDirections && typeof parsed.sourceDirections === "object"
        ? parsed.sourceDirections as Record<string, SyncDirection>
        : {},
      runOnOpen: parsed.runOnOpen !== false,
      runOnClose: parsed.runOnClose !== false
    };
  } catch {
    return defaultSyncConfig;
  }
}
