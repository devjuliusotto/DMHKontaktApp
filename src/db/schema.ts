export const sqliteSchema = `
contacts(id, first_name, last_name, display_name, email, phone, mobile_phone, street, postal_code, city, country, short_info, notes, import_batch_id, created_at, updated_at)
groups(id, name, description, created_at, updated_at)
contact_groups(contact_id, group_id)
import_history(id, batch_id, source_file, imported_count, skipped_count, created_at)
app_settings(key, value, updated_at)
mail_accounts(id, source, source_account_id, account_name, email, account_type, incoming_server, incoming_user, incoming_port, incoming_security, outgoing_server, outgoing_user, outgoing_port, outgoing_security, credential_reference, created_at, updated_at)
`;
