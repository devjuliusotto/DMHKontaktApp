export interface Microsoft365Account {
  id: string;
  displayName: string;
  email: string;
  userPrincipalName: string;
  connectedAt: string;
  tenantId: string;
  groupIds: string[];
  lastValidatedAt: string;
}

export interface Microsoft365ConnectionStatus {
  configured: boolean;
  connected: boolean;
  account: Microsoft365Account | null;
  rememberSignIn: boolean;
}

export type PortalSessionState =
  | "signed_out"
  | "authenticated"
  | "offline"
  | "access_denied"
  | "configuration_required";

export interface PortalSession {
  configured: boolean;
  state: PortalSessionState;
  account: Microsoft365Account | null;
  rememberSignIn: boolean;
  authorizationConfigured: boolean;
  modules: string[];
  message: string;
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

export interface ExchangeEntitySyncSummary {
  uploaded: number;
  downloaded: number;
  updated: number;
  deleted: number;
  conflicts: number;
}

export interface ExchangeSyncResult {
  contacts: ExchangeEntitySyncSummary;
  calendar: ExchangeEntitySyncSummary;
  calendarEvents: import("./calendar").CalendarEvent[];
  deletedCalendarEvents: import("./calendar").CalendarEvent[];
  syncedAt: string;
}

export type ExchangeSyncStatus = {
  state: "idle" | "syncing" | "synced" | "error" | "offline";
  lastSyncedAt?: string;
  message?: string;
  result?: ExchangeSyncResult;
};
