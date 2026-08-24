export interface Microsoft365Account {
  id: string;
  displayName: string;
  email: string;
  userPrincipalName: string;
  connectedAt: string;
}

export interface Microsoft365ConnectionStatus {
  configured: boolean;
  connected: boolean;
  account: Microsoft365Account | null;
}

export interface Microsoft365DeviceCode {
  userCode: string;
  verificationUri: string;
  expiresAt: string;
  intervalSeconds: number;
}

export interface Microsoft365PollResult {
  state: "pending" | "connected";
  account: Microsoft365Account | null;
  intervalSeconds: number;
}

export interface Microsoft365SyncSource {
  id: string;
  name: string;
  kind: "contactFolder" | "calendar";
  editable: boolean;
  shared: boolean;
  resourcePath: string;
  mailbox: string | null;
}

export interface Microsoft365SharedMailbox {
  address: string;
  displayName: string;
  available: boolean;
  contactFolderCount: number;
  calendarCount: number;
  error: string | null;
}

export interface Microsoft365SyncSources {
  contacts: Microsoft365SyncSource[];
  calendars: Microsoft365SyncSource[];
  sharedMailboxes: Microsoft365SharedMailbox[];
  sharedAccessAvailable: boolean;
}

export interface Microsoft365SyncPreview {
  localContacts: number;
  remoteContacts: number;
  localEvents: number;
  remoteEvents: number;
  createInM365: number;
  importToApp: number;
  conflicts: number;
  sharedSourcesSkipped: number;
  changes: Array<{
    id: string;
    kind: string;
    action: "createRemote" | "createLocal" | "updateRemote" | "updateLocal" | "conflict";
    sourceId: string;
    sourceName: string;
    title: string;
    detail: string;
    localSummary: string | null;
    remoteSummary: string | null;
  }>;
}

export type Microsoft365ConflictDecision = "keepApp" | "keepM365" | "merge" | "ignore";

export interface Microsoft365SyncResult {
  startedAt: string;
  finishedAt: string;
  created: number;
  updated: number;
  ignored: number;
  conflicts: number;
  errors: number;
  errorMessages: string[];
  calendarUpserts: import("./calendar").CalendarEvent[];
}

export interface Microsoft365SyncHistoryEntry extends Omit<Microsoft365SyncResult, "calendarUpserts"> {
  id: string;
}
