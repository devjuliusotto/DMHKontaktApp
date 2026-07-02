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
  notes: string;
  groupIds: number[];
}

export interface ImportResult {
  imported: number;
  skippedDuplicates: number;
  batchId: string;
}

export interface BackupData {
  version: string;
  exportedAt: string;
  contacts: Contact[];
  groups: Group[];
  settings: Array<{ key: string; value: string }>;
}
