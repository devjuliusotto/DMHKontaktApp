import type { BackupData, Contact } from "../types/contact";

const csvCell = (value: unknown) => {
  const text = String(value ?? "");
  return `"${text.replace(/"/g, '""')}"`;
};

const toCsv = (headers: string[], rows: Array<Array<unknown>>) => {
  const body = rows.map((row) => row.map(csvCell).join(";")).join("\r\n");
  return `${headers.map(csvCell).join(";")}\r\n${body}`;
};

export function exportGeneralCsv(contacts: Contact[]): string {
  return toCsv(
    ["Vorname", "Nachname", "Anzeigename", "E-Mail geschäftlich", "E-Mail privat", "Zweite private E-Mail", "Telefon geschäftlich", "Mobiltelefon", "Telefon privat", "Weiteres privates Telefon", "Unternehmen", "Straße", "PLZ", "Stadt", "Land", "Kurz-info", "Notizen", "Gruppen"],
    contacts.map((contact) => [
      contact.firstName,
      contact.lastName,
      contact.displayName,
      contact.email,
      contact.privateEmail,
      contact.secondPrivateEmail,
      contact.phone,
      contact.mobilePhone,
      contact.privatePhone,
      contact.secondPrivatePhone,
      contact.company,
      contact.street,
      contact.postalCode,
      contact.city,
      contact.country,
      contact.shortInfo,
      contact.notes,
      contact.groups.map((group) => group.name).join(", ")
    ])
  );
}

export function exportOutlookClassicCsv(contacts: Contact[]): string {
  return toCsv(
    [
      "First Name",
      "Last Name",
      "Display Name",
      "E-mail Address",
      "E-mail 2 Address",
      "E-mail 3 Address",
      "Business Phone",
      "Mobile Phone",
      "Home Phone",
      "Home Phone 2",
      "Company",
      "Business Street",
      "Business Postal Code",
      "Business City",
      "Business Country/Region",
      "Notes"
    ],
    contacts.map((contact) => [
      contact.firstName,
      contact.lastName,
      contact.displayName,
      contact.email,
      contact.privateEmail,
      contact.secondPrivateEmail,
      contact.phone,
      contact.mobilePhone,
      contact.privatePhone,
      contact.secondPrivatePhone,
      contact.company,
      contact.street,
      contact.postalCode,
      contact.city,
      contact.country,
      contact.notes
    ])
  );
}

export function exportNewOutlookCsv(contacts: Contact[]): string {
  return toCsv(
    ["First Name", "Last Name", "Email Address", "Email Address 2", "Email Address 3", "Phone", "Mobile Phone", "Home Phone", "Home Phone 2", "Company", "Street", "Postal Code", "City", "Country", "Notes"],
    contacts.map((contact) => [
      contact.firstName,
      contact.lastName,
      contact.email,
      contact.privateEmail,
      contact.secondPrivateEmail,
      contact.phone,
      contact.mobilePhone,
      contact.privatePhone,
      contact.secondPrivatePhone,
      contact.company,
      contact.street,
      contact.postalCode,
      contact.city,
      contact.country,
      contact.notes
    ])
  );
}

export function exportBackupJson(backup: BackupData): string {
  return JSON.stringify(backup, null, 2);
}
