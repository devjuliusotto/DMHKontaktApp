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
}

export interface Microsoft365SyncSources {
  contacts: Microsoft365SyncSource[];
  calendars: Microsoft365SyncSource[];
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
    kind: string;
    action: string;
    title: string;
    detail: string;
  }>;
}
