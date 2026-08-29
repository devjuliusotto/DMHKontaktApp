export interface PhoneTransferStatus {
  active: boolean;
  url: string;
  destination: string;
  expiresAt: string;
  receivedFiles: number;
}

export interface PhonePhotoReceived {
  name: string;
  receivedFiles: number;
}
