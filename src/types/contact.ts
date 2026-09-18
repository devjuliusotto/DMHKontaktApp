export interface Group {
  id?: number;
  name: string;
  description: string;
  createdAt: string;
  updatedAt: string;
  deletedAt?: string | null;
}

export interface Contact {
  id?: number;
  firstName: string;
  lastName: string;
  displayName: string;
  email: string;
  privateEmail: string;
  secondPrivateEmail: string;
  phone: string;
  mobilePhone: string;
  privatePhone: string;
  secondPrivatePhone: string;
  company: string;
  street: string;
  postalCode: string;
  city: string;
  country: string;
  shortInfo: string;
  notes: string;
  groups: Group[];
  createdAt: string;
  updatedAt: string;
  deletedAt?: string | null;
}

export interface ContactInput {
  id?: number;
  firstName: string;
  lastName: string;
  displayName: string;
  email: string;
  privateEmail: string;
  secondPrivateEmail: string;
  phone: string;
  mobilePhone: string;
  privatePhone: string;
  secondPrivatePhone: string;
  company: string;
  street: string;
  postalCode: string;
  city: string;
  country: string;
  shortInfo: string;
  notes: string;
  groupIds: number[];
}

export interface ImportResult {
  imported: number;
  mergedDuplicates: number;
  skippedDuplicates: number;
  batchId: string;
}

export interface TrashPurgeResult {
  contacts: number;
  groups: number;
  vaultEntries: number;
}

export interface OutlookOneTimeContactImportResult {
  found: number;
  imported: number;
  skippedDuplicates: number;
  skippedInvalid: number;
}

export type OutlookContactPreviewStatus = "new" | "different" | "duplicate_exact";

export interface OutlookContactSourcePreview {
  id: string;
  kind: "contacts" | "autocomplete";
  storeName: string;
  folderPath: string;
  suggestedGroupName: string;
  total: number;
  newContacts: number;
  exactDuplicates: number;
  conflicts: number;
  withoutEmail: number;
}

export interface OutlookContactPreviewItem {
  id: string;
  sourceId: string;
  displayName: string;
  email: string;
  phone: string;
  city: string;
  status: OutlookContactPreviewStatus;
  reason: string;
  existingName?: string | null;
  defaultSelected: boolean;
}

export interface OutlookContactImportPreview {
  found: number;
  skippedInvalid: number;
  warnings: string[];
  sources: OutlookContactSourcePreview[];
  contacts: OutlookContactPreviewItem[];
}

export interface OutlookContactImportRequest {
  selectedSourceIds: string[];
  createSourceGroups: boolean;
  cleanImportedNames: boolean;
}

export interface OutlookContactImportResult {
  found: number;
  imported: number;
  mergedDuplicates: number;
  skippedExactDuplicates: number;
  skippedConflicts: number;
  skippedInvalid: number;
  groupsUsed: number;
  batchId: string;
}

export interface OutlookContactExportResult {
  total: number;
  created: number;
  updated: number;
  linked: number;
  contactCopies: number;
  foldersCreated: number;
  foldersUsed: number;
  errors: number;
  autocompleteResolved: number;
  autocompleteErrors: number;
  folderPath: string;
  storeName: string;
}

export interface ThunderbirdContactImportResult {
  found: number;
  imported: number;
  linkedExisting: number;
  skippedInvalid: number;
  addressBooks: number;
  groupsUsed: number;
  autocompleteFound: number;
  autocompleteImported: number;
  autocompleteLinkedExisting: number;
  mergedDuplicates: number;
  skippedExactDuplicates: number;
}

export interface ThunderbirdContactReconciliationPreview {
  found: number;
  newContacts: number;
  mergedContacts: number;
  exactDuplicates: number;
  conflicts: number;
  skippedInvalid: number;
  addressBooks: number;
  groups: number;
}

export interface ThunderbirdDataPreview {
  available: boolean;
  addressBooks: number;
  contacts: number;
  autocompleteContacts: number;
  calendars: number;
  events: number;
  warnings: string[];
}

export interface BackupData {
  version: string;
  exportedAt: string;
  contacts: Contact[];
  groups: Group[];
  settings: Array<{ key: string; value: string }>;
  browserStorage?: Record<string, string>;
}

export interface AutomaticBackupRestoreResult {
  browserStorage: Record<string, string>;
  passwordsRestored: boolean;
}

export interface RecoveryArchiveStatus {
  available: boolean;
  latestAt: string | null;
  contacts: number;
  groups: number;
  calendarEvents: number;
  totalCheckpoints: number;
  totalSizeBytes: number;
  checkpoints: RecoveryCheckpointSummary[];
}

export interface DeleteAllContactsResult {
  contacts: number;
  groups: number;
}

export interface ContactOverviewCounts {
  total: number;
  ungrouped: number;
  groups: Record<number, number>;
}

export interface ContactDuplicateCleanupItem {
  id: number;
  displayName: string;
  email: string;
  phone: string;
}

export interface ContactDuplicateCleanupResult {
  removed: number;
  contacts: ContactDuplicateCleanupItem[];
}

export interface RecoveryCheckpointSummary {
  id: string;
  createdAt: string;
  contacts: number;
  groups: number;
  calendarEvents: number;
  sizeBytes: number;
}

export interface RecoveryRestoreResult {
  browserStorage: Record<string, string>;
  passwordsRestored: boolean;
  restoredAt: string;
  contacts: number;
  groups: number;
  calendarEvents: number;
}

export type RecoveryArchiveSource = "closing" | "background";

export interface RecoveryPreviewItem {
  kind: "contact" | "calendar";
  id: string;
  title: string;
  detail: string;
  destination: "contacts" | "calendar" | "trash";
  groups: string[];
}

export interface RecoveryGroupPreview {
  name: string;
  contacts: number;
  willBeCreated: boolean;
}

export interface RecoveryArchivePreview {
  source: RecoveryArchiveSource;
  sourceLabel: string;
  createdAt: string;
  activeContacts: number;
  trashContacts: number;
  activeCalendarEvents: number;
  trashCalendarEvents: number;
  groupsToCreate: number;
  totalItems: number;
  matchingItems: number;
  offset: number;
  hasMore: boolean;
  items: RecoveryPreviewItem[];
  groups: RecoveryGroupPreview[];
}

export interface RecoveryArchiveRestoreResult {
  source: RecoveryArchiveSource;
  restoredAt: string;
  activeContacts: number;
  trashContacts: number;
  activeCalendarEvents: number;
  trashCalendarEvents: number;
  groups: number;
}
