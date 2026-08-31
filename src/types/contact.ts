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
  phone: string;
  mobilePhone: string;
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
  phone: string;
  mobilePhone: string;
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
  skippedDuplicates: number;
  batchId: string;
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
