export interface OutlookAccountCandidate {
  sourceAccountId: string;
  accountName: string;
  email: string;
  accountType: "imap";
  incomingServer: string;
  incomingUser: string;
  incomingPort: number;
  incomingSecurity: "ssl" | "none";
  incomingUseSpa: boolean;
  outgoingServer: string;
  outgoingUser: string;
  outgoingPort: number;
  outgoingSecurity: "ssl" | "starttls" | "auto" | "none";
  outgoingUseAuth: boolean;
  outgoingAuthMethod: number;
  passwordAvailable: boolean;
  smtpPasswordAvailable: boolean;
}

export interface MailAccount {
  id: number;
  source: "outlook-classic";
  sourceAccountId: string;
  accountName: string;
  email: string;
  accountType: "imap";
  incomingServer: string;
  incomingUser: string;
  incomingPort: number;
  incomingSecurity: "ssl" | "none";
  incomingUseSpa: boolean;
  outgoingServer: string;
  outgoingUser: string;
  outgoingPort: number;
  outgoingSecurity: "ssl" | "starttls" | "auto" | "none";
  outgoingUseAuth: boolean;
  outgoingAuthMethod: number;
  createdAt: string;
  updatedAt: string;
}

export interface RevealedMailPassword {
  password: string;
}
