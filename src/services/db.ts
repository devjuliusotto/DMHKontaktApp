import { invoke } from "@tauri-apps/api/core";
import type { CalendarEvent, OutlookOneTimeCalendarImportResult, ThunderbirdCalendarImportResult } from "../types/calendar";
import type {
  BackupData,
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

export function importOutlookStore(path: string): Promise<{ contacts: ContactInput[]; events: CalendarEvent[] }> {
  return invoke("import_outlook_store", { path });
}

export function previewOutlookClassicContacts(): Promise<OutlookContactImportPreview> {
  return invoke("preview_outlook_classic_contacts");
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

export function importThunderbirdContactsOnce(): Promise<ThunderbirdContactImportResult> {
  return invoke("import_thunderbird_contacts_once");
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

export function deleteAllVaultEntries(): Promise<number> {
  return invoke("delete_all_vault_entries");
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
