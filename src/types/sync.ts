export type SyncDirection = "bidirectional" | "export" | "import";
export type SyncBase = "app" | "m365" | "outlook-classic" | "thunderbird";

export interface SyncProviders {
  m365: boolean;
  outlookClassic: boolean;
  thunderbird: boolean;
}

export interface SyncConfig {
  version: 1;
  enabled: boolean;
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
  runOnOpen: boolean;
  runOnClose: boolean;
}

export const defaultSyncConfig: SyncConfig = {
  version: 1,
  enabled: false,
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
      version: 1,
      enabled: Boolean(parsed.enabled),
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
      runOnOpen: parsed.runOnOpen !== false,
      runOnClose: parsed.runOnClose !== false
    };
  } catch {
    return defaultSyncConfig;
  }
}
