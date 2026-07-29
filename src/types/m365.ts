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
