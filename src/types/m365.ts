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

export interface PortalUserProfile {
  id: string;
  displayName: string;
  mail: string;
  userPrincipalName: string;
  jobTitle: string;
  department: string;
  businessPhones: string[];
  mobilePhone: string;
  officeLocation: string;
  streetAddress: string;
  postalCode: string;
  city: string;
  country: string;
}

export interface PortalUserProfileUpdate {
  businessPhone: string;
  mobilePhone: string;
  officeLocation: string;
  streetAddress: string;
  postalCode: string;
  city: string;
  country: string;
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

export type PortalModuleId = "privatschwestern" | "edv" | "kfz";

export interface PortalSession {
  configured: boolean;
  state: PortalSessionState;
  account: Microsoft365Account | null;
  rememberSignIn: boolean;
  authorizationConfigured: boolean;
  modules: PortalModuleId[];
  message: string;
}

export interface Microsoft365PollResult {
  state: "connected";
  account: Microsoft365Account | null;
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

export type EdvAccessLevel = "reader" | "operator" | "identity_admin";

export interface EdvAccessProfile {
  level: EdvAccessLevel;
  canManageTickets: boolean;
  canManageMembers: boolean;
  canManageIdentities: boolean;
  canManageSystems: boolean;
}

export interface EdvAdminSessionStatus {
  configured: boolean;
  connected: boolean;
  accountMatches: boolean;
  scopes: string[];
}

export interface EdvDirectoryUser {
  id: string;
  displayName: string;
  userPrincipalName: string;
  mail: string;
  accountEnabled: boolean | null;
  jobTitle: string;
  department: string;
  mobilePhone: string;
}

export interface EdvDirectoryGroup {
  id: string;
  displayName: string;
  description: string;
  mail: string;
  mailEnabled: boolean | null;
  securityEnabled: boolean | null;
  groupTypes: string[];
}

export interface PlannerPlan { id: string; title: string; owner: string }
export interface PlannerBucket { id: string; name: string; planId: string; orderHint: string; etag: string }
export interface PlannerTask {
  id: string;
  title: string;
  planId: string;
  bucketId: string;
  orderHint: string;
  priority: number;
  percentComplete: number;
  startDateTime: string | null;
  dueDateTime: string | null;
  assignments: Record<string, unknown>;
  etag: string;
}
export interface PlannerTaskDetails { id: string; description: string; previewType: string; etag: string }
export interface PlannerBoard { plan: PlannerPlan; buckets: PlannerBucket[]; tasks: PlannerTask[] }

export interface EdvSystemRecord {
  id: string;
  name: string;
  category: string;
  owner: string;
  status: string;
  provider: string;
  url: string;
  notes: string;
  createdAt: string;
  updatedAt: string;
}

export interface EdvAuditEntry {
  id: number;
  occurredAt: string;
  actorName: string;
  actorUpn: string;
  action: string;
  targetType: string;
  targetId: string;
  targetName: string;
  details: string;
  result: string;
}
