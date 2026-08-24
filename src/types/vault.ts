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
  kind: "password" | "totp";
  totpAlgorithm?: "SHA1" | "SHA256" | "SHA512";
  totpDigits?: number;
  totpPeriod?: number;
  platform: string;
  username: string;
  password: string;
  url: string;
  description: string;
  createdAt: string;
  updatedAt: string;
  deletedAt?: string | null;
}

export interface VaultEntryInput {
  id?: number;
  kind: "password" | "totp";
  totpAlgorithm?: "SHA1" | "SHA256" | "SHA512";
  totpDigits?: number;
  totpPeriod?: number;
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
