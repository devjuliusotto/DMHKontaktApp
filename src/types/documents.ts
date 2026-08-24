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
