export const sqliteSchema = `
contacts(id, first_name, last_name, display_name, email, phone, mobile_phone, street, postal_code, city, country, short_info, notes, import_batch_id, created_at, updated_at)
groups(id, name, description, created_at, updated_at)
contact_groups(contact_id, group_id)
import_history(id, batch_id, source_file, imported_count, skipped_count, created_at)
app_settings(key, value, updated_at)
`;
