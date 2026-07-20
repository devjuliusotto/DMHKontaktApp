export interface VaultStatus {
  protectionEnabled: boolean;
  unlocked: boolean;
  username: string;
  recoveryEmail: string;
  recoveryEmailHint: string;
  recoveryAvailable: boolean;
  entryCount: number;
}

export interface VaultEntry {
  id: number;
  platform: string;
  username: string;
  password: string;
  url: string;
  description: string;
  createdAt: string;
  updatedAt: string;
}

export interface VaultEntryInput {
  id?: number;
  platform: string;
  username: string;
  password: string;
  url: string;
  description: string;
}

export interface VaultRecoveryDelivery {
  recoveryEmailHint: string;
  expiresInMinutes: number;
}
