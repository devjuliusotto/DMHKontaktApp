import { invoke } from "@tauri-apps/api/core";
import type { CalendarEvent } from "../types/calendar";
import type { BackupData, Contact, ContactInput, Group, ImportResult } from "../types/contact";
import type { MailAccount, OutlookAccountCandidate, RevealedMailPassword } from "../types/mail";

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

export function removeMailAccount(accountId: number): Promise<void> {
  return invoke("remove_mail_account", { accountId });
}
