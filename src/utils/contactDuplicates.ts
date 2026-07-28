import type { Contact, ContactInput } from "../types/contact";

type ComparableContact = Pick<
  Contact | ContactInput,
  | "firstName"
  | "lastName"
  | "displayName"
  | "email"
  | "phone"
  | "mobilePhone"
  | "street"
  | "postalCode"
  | "city"
  | "country"
  | "shortInfo"
  | "notes"
>;

export function storedContactDisplayName(contact: ComparableContact): string {
  return contact.displayName.trim()
    || `${contact.firstName.trim()} ${contact.lastName.trim()}`.trim();
}

export function contactExactContentKey(contact: ComparableContact): string {
  return JSON.stringify([
    contact.firstName,
    contact.lastName,
    storedContactDisplayName(contact),
    contact.email.trim().toLocaleLowerCase("de"),
    contact.phone,
    contact.mobilePhone,
    contact.street,
    contact.postalCode,
    contact.city,
    contact.country,
    contact.shortInfo,
    contact.notes
  ]);
}
