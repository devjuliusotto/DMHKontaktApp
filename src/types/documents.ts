export interface DocumentSource {
  id: string;
  name: string;
  kind: "onedrive" | "sharepoint";
  webUrl: string;
  siteName: string;
}

export interface DocumentItem {
  id: string;
  driveId: string;
  name: string;
  isFolder: boolean;
  size: number;
  lastModifiedAt: string;
  modifiedBy: string;
  webUrl: string;
  eTag: string;
  offlineAvailable: boolean;
  offlineOutdated: boolean;
  offlineETag: string;
  localPath: string;
}

export interface DocumentMutationRequest {
  driveId: string;
  parentId?: string;
  itemId?: string;
  name?: string;
}

export interface DocumentTransferRequest {
  sourceDriveId: string;
  itemIds: string[];
  destinationDriveId: string;
  destinationParentId?: string;
}

export interface DocumentTransferResult {
  processed: number;
  queued: number;
  errors: string[];
}

export interface DocumentUploadResult {
  files: number;
  folders: number;
}

export interface SystemFileIcon {
  width: number;
  height: number;
  rgbaBase64: string;
}

export interface DocumentOfflineFolderResult {
  files: number;
  folders: number;
  skippedLocalChanges: number;
}

export interface DocumentVersion {
  id: string;
  lastModifiedAt: string;
  modifiedBy: string;
  size: number;
}

export interface DocumentSyncConflict {
  id: string;
  driveId: string;
  itemId: string;
  name: string;
  localPath: string;
  parentId: string;
  baseETag: string;
  remoteETag: string;
  remoteModifiedAt: string;
  remoteModifiedBy: string;
  kind: "bothModified" | "remoteDeleted";
  detectedAt: string;
}

export interface DocumentSyncSummary {
  checked: number;
  uploaded: number;
  downloaded: number;
  conflicts: number;
  errors: string[];
}

export type DocumentConflictDecision = "keepBoth" | "useLocal" | "useOnline" | "later";
