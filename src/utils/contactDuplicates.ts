import type { Contact, ContactInput } from "../types/contact";

export type ContactDuplicateConfidence = "high" | "review";

export interface ContactDuplicateGroup {
  id: string;
  reason: string;
  confidence: ContactDuplicateConfidence;
  contacts: Contact[];
}

function normalizedText(value: string): string {
  return value.normalize("NFKC").trim().replace(/\s+/g, " ").toLocaleLowerCase("de-DE");
}

export function contactExactContentKey(contact: Contact | ContactInput): string {
  const name = contact.displayName.trim() || `${contact.firstName.trim()} ${contact.lastName.trim()}`.trim();
  return JSON.stringify([
    contact.firstName.trim(),
    contact.lastName.trim(),
    name,
    contact.email.trim().toLocaleLowerCase("de-DE"),
    contact.phone.trim(),
    contact.mobilePhone.trim(),
    contact.street.trim(),
    contact.postalCode.trim(),
    contact.city.trim(),
    contact.country.trim(),
    contact.shortInfo.trim(),
    contact.notes.trim()
  ]);
}

function normalizedEmail(contact: Contact): string {
  return contact.email.trim().toLocaleLowerCase("de-DE");
}

function normalizedName(contact: Contact): string {
  const value = contact.displayName.trim() || `${contact.firstName} ${contact.lastName}`.trim();
  return normalizedText(value);
}

function normalizedPhone(value: string): string {
  let digits = value.replace(/\D/g, "");
  if (digits.startsWith("0049") && digits.length > 8) digits = `0${digits.slice(4)}`;
  else if (digits.startsWith("49") && digits.length > 8) digits = `0${digits.slice(2)}`;
  return digits.length >= 7 ? digits : "";
}

function contactPhones(contact: Contact): string[] {
  return Array.from(new Set([normalizedPhone(contact.phone), normalizedPhone(contact.mobilePhone)].filter(Boolean)));
}

function addToIndex(index: Map<string, Contact[]>, key: string, contact: Contact) {
  if (!key) return;
  const matches = index.get(key) ?? [];
  matches.push(contact);
  index.set(key, matches);
}

function groupSignature(contacts: Contact[]): string {
  return contacts
    .map((contact) => contact.id)
    .filter((id): id is number => typeof id === "number")
    .sort((left, right) => left - right)
    .join(":");
}

function uniqueContacts(contacts: Contact[]): Contact[] {
  const seen = new Set<number>();
  return contacts.filter((contact) => {
    if (typeof contact.id !== "number" || seen.has(contact.id)) return false;
    seen.add(contact.id);
    return true;
  });
}

export function findContactDuplicateGroups(contacts: Contact[]): ContactDuplicateGroup[] {
  const activeContacts = contacts.filter((contact) => typeof contact.id === "number" && !contact.deletedAt);
  const emailIndex = new Map<string, Contact[]>();
  const phoneIndex = new Map<string, Contact[]>();
  const nameIndex = new Map<string, Contact[]>();

  for (const contact of activeContacts) {
    addToIndex(emailIndex, normalizedEmail(contact), contact);
    for (const phone of contactPhones(contact)) addToIndex(phoneIndex, phone, contact);
    addToIndex(nameIndex, normalizedName(contact), contact);
  }

  const groups: ContactDuplicateGroup[] = [];
  const signatures = new Set<string>();
  const addGroup = (
    prefix: string,
    key: string,
    matches: Contact[],
    reason: string,
    confidence: ContactDuplicateConfidence
  ) => {
    const unique = uniqueContacts(matches);
    if (unique.length < 2) return;
    const signature = groupSignature(unique);
    if (!signature || signatures.has(signature)) return;
    signatures.add(signature);
    groups.push({ id: `${prefix}:${key}:${signature}`, reason, confidence, contacts: unique });
  };

  for (const [email, matches] of emailIndex) {
    addGroup("email", email, matches, "Gleiche E-Mail-Adresse", "high");
  }
  for (const [phone, matches] of phoneIndex) {
    addGroup("phone", phone, matches, "Gleiche Telefonnummer", "review");
  }
  for (const [name, matches] of nameIndex) {
    const distinctEmails = new Set(matches.map(normalizedEmail).filter(Boolean));
    if (distinctEmails.size <= 1) {
      addGroup("name", name, matches, "Gleicher vollständiger Name", "review");
    }
  }

  return groups.sort((left, right) => {
    if (left.confidence !== right.confidence) return left.confidence === "high" ? -1 : 1;
    return normalizedName(left.contacts[0]).localeCompare(normalizedName(right.contacts[0]), "de");
  });
}
