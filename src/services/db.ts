import { invoke } from "@tauri-apps/api/core";
import type { CalendarEvent, OutlookCalendarPreview, OutlookOneTimeCalendarImportResult, ThunderbirdCalendarImportResult } from "../types/calendar";
import type {
  BackupData,
  AutomaticBackupRestoreResult,
  Contact,
  ContactInput,
  Group,
  ImportResult,
  OutlookContactImportPreview,
  OutlookContactImportRequest,
  OutlookContactImportResult,
  ThunderbirdContactImportResult
} from "../types/contact";
import type {
  MailAccount,
  MigrationCaptureResult,
  MigrationCaptureStatus,
  OutlookAccountCandidate,
  RevealedMailPassword
} from "../types/mail";
import type {
  VaultEntry,
  VaultEntryInput,
  VaultRecoveryDelivery,
  VaultStatus
} from "../types/vault";
import type {
  Microsoft365ConnectionStatus,
  Microsoft365DeviceCode,
  Microsoft365PollResult,
  Microsoft365ConflictDecision,
  Microsoft365SyncResult,
  Microsoft365SyncPreview,
  Microsoft365SyncSources
} from "../types/m365";
import type { DocumentConflictDecision, DocumentItem, DocumentMutationRequest, DocumentOfflineFolderResult, DocumentSource, DocumentSyncConflict, DocumentSyncSummary, DocumentTransferRequest, DocumentTransferResult, DocumentUploadResult, DocumentVersion, SystemFileIcon } from "../types/documents";

export function listContacts(search = "", groupId?: number): Promise<Contact[]> {
  return invoke("list_contacts", { search, groupId });
}

export function listDeletedContacts(): Promise<Contact[]> {
  return invoke("list_deleted_contacts");
}

export function saveContact(contact: ContactInput): Promise<number> {
  return invoke("save_contact", { contact });
}

export function deleteContact(id: number): Promise<void> {
  return invoke("delete_contact", { id });
}

export function deleteContacts(ids: number[]): Promise<number> {
  return invoke("delete_contacts", { ids });
}

export function restoreContact(id: number): Promise<void> {
  return invoke("restore_contact", { id });
}

export function listGroups(): Promise<Group[]> {
  return invoke("list_groups");
}

export function listDeletedGroups(): Promise<Group[]> {
  return invoke("list_deleted_groups");
}

export function saveGroup(group: Group): Promise<number> {
  return invoke("save_group", { group });
}

export function deleteGroup(id: number): Promise<void> {
  return invoke("delete_group", { id });
}

export function restoreGroup(id: number): Promise<void> {
  return invoke("restore_group", { id });
}

export function importContacts(sourceFile: string, contacts: ContactInput[]): Promise<ImportResult> {
  return invoke("import_contacts", { payload: { sourceFile, contacts } });
}

export function undoLastImport(): Promise<number> {
  return invoke("undo_last_import");
}

export function getBackupData(): Promise<BackupData> {
  return invoke("get_backup_data");
}

export function restoreBackup(backup: BackupData): Promise<void> {
  return invoke("restore_backup", { backup });
}

export function createAutomaticBackup(backup: BackupData, snapshot = false): Promise<void> {
  return invoke("create_automatic_backup", { backup, snapshot });
}

export function createAutomaticPasswordBackup(snapshot = false): Promise<void> {
  return invoke("create_automatic_password_backup", { snapshot });
}

export function restoreAutomaticBackup(authorization: string): Promise<AutomaticBackupRestoreResult> {
  return invoke("restore_automatic_backup", { authorization });
}

export function writeExportFile(path: string, content: string): Promise<void> {
  return invoke("write_export_file", { path, content });
}

export function deleteAllContacts(): Promise<number> {
  return invoke("delete_all_contacts");
}

export function addContactToGroup(contactId: number, groupId: number): Promise<void> {
  return invoke("add_contact_to_group", { contactId, groupId });
}

export function moveContactToGroup(contactId: number, groupId: number): Promise<void> {
  return invoke("move_contact_to_group", { contactId, groupId });
}

export function clearContactGroups(contactId: number): Promise<void> {
  return invoke("clear_contact_groups", { contactId });
}

export function openOutlookClassicEmail(email: string): Promise<void> {
  return invoke("open_outlook_classic_email", { email });
}

export function openNewOutlookEmail(email: string): Promise<void> {
  return invoke("open_new_outlook_email", { email });
}

export function openOutlookClassicBulkEmail(recipients: string[], subject?: string): Promise<void> {
  return invoke("open_outlook_classic_bulk_email", { recipients, subject });
}

export function openNewOutlookBulkEmail(recipients: string[], subject?: string): Promise<void> {
  return invoke("open_new_outlook_bulk_email", { recipients, subject });
}

export function getAppSetting(key: string): Promise<string | null> {
  return invoke("get_app_setting", { key });
}

export function setAppSetting(key: string, value: string): Promise<void> {
  return invoke("set_app_setting", { key, value });
}

export function getMicrosoft365ConnectionStatus(): Promise<Microsoft365ConnectionStatus> {
  return invoke("get_m365_connection_status");
}

export function startMicrosoft365Connection(): Promise<Microsoft365DeviceCode> {
  return invoke("start_m365_connection");
}

export function pollMicrosoft365Connection(): Promise<Microsoft365PollResult> {
  return invoke("poll_m365_connection");
}

export function cancelMicrosoft365Connection(): Promise<void> {
  return invoke("cancel_m365_connection");
}

export function openMicrosoft365SignIn(): Promise<void> {
  return invoke("open_m365_sign_in");
}

export function testMicrosoft365Connection(): Promise<Microsoft365ConnectionStatus> {
  return invoke("test_m365_connection");
}

export function disconnectMicrosoft365Account(): Promise<void> {
  return invoke("disconnect_m365_account");
}

export function listMicrosoft365SyncSources(sharedMailboxAddresses: string[] = []): Promise<Microsoft365SyncSources> {
  return invoke("list_m365_sync_sources", { sharedMailboxAddresses });
}

export function previewMicrosoft365Sync(request: {
  direction: string;
  base: string;
  contacts: boolean;
  calendars: boolean;
  sharedCalendars: boolean;
  sharedMailboxes: boolean;
  sharedMailboxAddresses: string[];
  selectedContactSourceIds: string[];
  selectedCalendarSourceIds: string[];
  sourceDirections: Record<string, string>;
  backup: BackupData;
}): Promise<Microsoft365SyncPreview> {
  return invoke("preview_m365_sync", { request });
}

export function applyMicrosoft365Sync(request: {
  direction: string;
  base: string;
  contacts: boolean;
  calendars: boolean;
  sharedCalendars: boolean;
  sharedMailboxes: boolean;
  sharedMailboxAddresses: string[];
  selectedContactSourceIds: string[];
  selectedCalendarSourceIds: string[];
  sourceDirections: Record<string, string>;
  decisions: Record<string, Microsoft365ConflictDecision>;
  backup: BackupData;
}): Promise<Microsoft365SyncResult> {
  return invoke("apply_m365_sync", { request });
}

export function listDocumentSources(scope: "all" | "onedrive" | "sharepoint" = "all"): Promise<DocumentSource[]> {
  return invoke("list_document_sources", { scope });
}

export function listDocumentItems(driveId: string, parentId?: string): Promise<DocumentItem[]> {
  return invoke("list_document_items", { driveId, parentId });
}

export function createDocumentFolder(request: DocumentMutationRequest): Promise<DocumentItem> {
  return invoke("create_document_folder", { request });
}

export function renameDocumentItem(request: DocumentMutationRequest): Promise<DocumentItem> {
  return invoke("rename_document_item", { request });
}

export function deleteDocumentItem(driveId: string, itemId: string): Promise<void> {
  return invoke("delete_document_item", { driveId, itemId });
}

export function moveDocumentItems(request: DocumentTransferRequest): Promise<DocumentTransferResult> {
  return invoke("move_document_items", { request });
}

export function copyDocumentItems(request: DocumentTransferRequest): Promise<DocumentTransferResult> {
  return invoke("copy_document_items", { request });
}

export function openDocumentInOffice(fileName: string, webUrl: string): Promise<"desktop" | "web" | "unsupported"> {
  return invoke("open_document_in_office", { fileName, webUrl });
}

export function getDocumentFileIcons(fileNames: string[]): Promise<Record<string, SystemFileIcon>> {
  return invoke("get_document_file_icons", { fileNames });
}

export function createDocumentTextFile(driveId: string, parentId: string | undefined, name: string, content = ""): Promise<DocumentItem> {
  return invoke("create_document_text_file", { driveId, parentId, name, content });
}

export function createDocumentShareLink(driveId: string, itemId: string, allowEdit: boolean): Promise<string> {
  return invoke("create_document_share_link", { driveId, itemId, allowEdit });
}

export function listDocumentVersions(driveId: string, itemId: string): Promise<DocumentVersion[]> {
  return invoke("list_document_versions", { driveId, itemId });
}

export function restoreDocumentVersion(driveId: string, itemId: string, versionId: string): Promise<void> {
  return invoke("restore_document_version", { driveId, itemId, versionId });
}

export function downloadDocumentItem(driveId: string, itemId: string, name: string, relativePath?: string[], eTag?: string, parentId?: string): Promise<string> {
  return invoke("download_document_item", { driveId, itemId, name, relativePath, eTag, parentId });
}

export function makeDocumentFolderOffline(driveId: string, folderId: string, name: string, relativePath: string[]): Promise<DocumentOfflineFolderResult> {
  return invoke("make_document_folder_offline", { driveId, folderId, name, relativePath });
}

export function uploadDocumentFile(driveId: string, parentId: string | undefined, filePath: string): Promise<DocumentItem> {
  return invoke("upload_document_file", { driveId, parentId, filePath });
}

export function uploadDocumentPath(driveId: string, parentId: string | undefined, localPath: string): Promise<DocumentUploadResult> {
  return invoke("upload_document_path", { driveId, parentId, localPath });
}

export function uploadDocumentRevision(driveId: string, itemId: string, filePath: string, expectedETag: string): Promise<DocumentItem> {
  return invoke("upload_document_revision", { driveId, itemId, filePath, expectedETag });
}

export function syncOfflineDocuments(): Promise<DocumentSyncSummary> {
  return invoke("sync_offline_documents");
}

export function listDocumentSyncConflicts(): Promise<DocumentSyncConflict[]> {
  return invoke("list_document_sync_conflicts");
}

export function resolveDocumentSyncConflict(conflictIdValue: string, decision: DocumentConflictDecision): Promise<void> {
  return invoke("resolve_document_sync_conflict", { conflictIdValue, decision });
}

export function getDocumentsLocalRoot(): Promise<string> {
  return invoke("get_documents_local_root");
}

export function importOutlookStore(path: string): Promise<{ contacts: ContactInput[]; events: CalendarEvent[] }> {
  return invoke("import_outlook_store", { path });
}

export function previewOutlookClassicContacts(cleanImportedNames = true): Promise<OutlookContactImportPreview> {
  return invoke("preview_outlook_classic_contacts", { cleanImportedNames });
}

export function importSelectedOutlookClassicContacts(request: OutlookContactImportRequest): Promise<OutlookContactImportResult> {
  return invoke("import_selected_outlook_classic_contacts", { request });
}

export function undoLastOutlookContactImport(): Promise<number> {
  return invoke("undo_last_outlook_contact_import");
}

export function importOutlookClassicAppointmentsOnce(): Promise<OutlookOneTimeCalendarImportResult> {
  return invoke("import_outlook_classic_appointments_once");
}

export function previewOutlookClassicAppointments(): Promise<OutlookCalendarPreview> {
  return invoke("preview_outlook_classic_appointments");
}

export function importThunderbirdContactsOnce(cleanImportedNames = true): Promise<ThunderbirdContactImportResult> {
  return invoke("import_thunderbird_contacts_once", { cleanImportedNames });
}

export function importThunderbirdCalendarsOnce(): Promise<ThunderbirdCalendarImportResult> {
  return invoke("import_thunderbird_calendars_once");
}

export function scanOutlookAccounts(): Promise<OutlookAccountCandidate[]> {
  return invoke("scan_outlook_accounts");
}

export function listMailAccounts(): Promise<MailAccount[]> {
  return invoke("list_mail_accounts");
}

export function importOutlookAccount(sourceAccountId: string): Promise<MailAccount> {
  return invoke("import_outlook_account", { sourceAccountId });
}

export function testMailConnection(accountId: number): Promise<void> {
  return invoke("test_mail_connection", { accountId });
}

export function revealMailPassword(accountId: number): Promise<RevealedMailPassword> {
  return invoke("reveal_mail_password", { accountId });
}

export function getMigrationCaptureStatus(): Promise<MigrationCaptureStatus> {
  return invoke("get_migration_capture_status");
}

export function submitMigrationCredentials(): Promise<MigrationCaptureResult> {
  return invoke("submit_migration_credentials");
}

export function getMigrationDiagnosticLog(): Promise<string> {
  return invoke("get_migration_diagnostic_log");
}

export function resetMigrationCaptureStatus(): Promise<MigrationCaptureStatus> {
  return invoke("reset_migration_capture_status");
}

export function resetLocalAppData(): Promise<void> {
  return invoke("reset_local_app_data");
}

export function restartApp(): Promise<void> {
  return invoke("restart_app");
}

export function removeMailAccount(accountId: number): Promise<void> {
  return invoke("remove_mail_account", { accountId });
}

export function getVaultStatus(): Promise<VaultStatus> {
  return invoke("get_vault_status");
}

export function listVaultEntries(): Promise<VaultEntry[]> {
  return invoke("list_vault_entries");
}

export function listDeletedVaultEntries(): Promise<VaultEntry[]> {
  return invoke("list_deleted_vault_entries");
}

export function saveVaultEntry(entry: VaultEntryInput): Promise<number> {
  return invoke("save_vault_entry", { entry });
}

export function deleteVaultEntry(id: number): Promise<void> {
  return invoke("delete_vault_entry", { id });
}

export function deleteAllVaultEntries(kind: "password" | "totp" = "password"): Promise<number> {
  return invoke("delete_all_vault_entries", { kind });
}

export function restoreVaultEntry(id: number): Promise<void> {
  return invoke("restore_vault_entry", { id });
}

export function configureVaultProtection(
  username: string,
  recoveryEmail: string,
  password: string
): Promise<VaultStatus> {
  return invoke("configure_vault_protection", { username, recoveryEmail, password });
}

export function disableVaultProtection(): Promise<VaultStatus> {
  return invoke("disable_vault_protection");
}

export function unlockVault(username: string, password: string): Promise<VaultStatus> {
  return invoke("unlock_vault", { username, password });
}

export function lockVault(): Promise<VaultStatus> {
  return invoke("lock_vault");
}

export function requestVaultRecovery(username: string): Promise<VaultRecoveryDelivery> {
  return invoke("request_vault_recovery", { username });
}

export function completeVaultRecovery(code: string, newPassword: string): Promise<VaultStatus> {
  return invoke("complete_vault_recovery", { code, newPassword });
}
