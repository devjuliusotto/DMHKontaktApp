import type { Contact, ContactInput } from "../types/contact";

export const collectedAddressesHiddenSettingKey = "collected_addresses_hidden";
export const collectedAddressesDeletedAtSettingKey = "collected_addresses_deleted_at";
const automaticDisplayNameStorageKey = "dmh.contacts.automaticDisplayName.v1";

type AutomaticDisplayNamePreferences = Record<string, boolean>;

function composedContactName(firstName: string, lastName: string): string {
  return `${firstName} ${lastName}`.replace(/\s+/g, " ").trim();
}

function readAutomaticDisplayNamePreferences(): AutomaticDisplayNamePreferences {
  try {
    return JSON.parse(localStorage.getItem(automaticDisplayNameStorageKey) ?? "{}") as AutomaticDisplayNamePreferences;
  } catch {
    return {};
  }
}

export const emptyContact: ContactInput = {
  firstName: "",
  lastName: "",
  displayName: "",
  email: "",
  privateEmail: "",
  secondPrivateEmail: "",
  phone: "",
  mobilePhone: "",
  privatePhone: "",
  secondPrivatePhone: "",
  company: "",
  street: "",
  postalCode: "",
  city: "",
  country: "Deutschland",
  shortInfo: "",
  notes: "",
  groupIds: []
};

export function toContactInput(contact: Contact): ContactInput {
  return {
    id: contact.id,
    firstName: contact.firstName,
    lastName: contact.lastName,
    displayName: contact.displayName,
    email: contact.email,
    privateEmail: contact.privateEmail ?? "",
    secondPrivateEmail: contact.secondPrivateEmail ?? "",
    phone: contact.phone,
    mobilePhone: contact.mobilePhone,
    privatePhone: contact.privatePhone ?? "",
    secondPrivatePhone: contact.secondPrivatePhone ?? "",
    company: contact.company ?? "",
    street: contact.street,
    postalCode: contact.postalCode,
    city: contact.city,
    country: contact.country,
    shortInfo: contact.shortInfo ?? "",
    notes: contact.notes,
    groupIds: contact.groups.map((group) => group.id).filter((id): id is number => Boolean(id))
  };
}

export function contactUsesAutomaticDisplayName(
  contact: Pick<ContactInput, "id" | "firstName" | "lastName" | "displayName">
): boolean {
  if (contact.id) {
    const savedPreference = readAutomaticDisplayNamePreferences()[String(contact.id)];
    if (typeof savedPreference === "boolean") return savedPreference;
  }

  const composedName = composedContactName(contact.firstName, contact.lastName);
  return !contact.displayName.trim() || contact.displayName.trim() === composedName;
}

export function saveAutomaticDisplayNamePreference(contactId: number, enabled: boolean): void {
  try {
    const preferences = readAutomaticDisplayNamePreferences();
    preferences[String(contactId)] = enabled;
    localStorage.setItem(automaticDisplayNameStorageKey, JSON.stringify(preferences));
  } catch {
    // The contact itself is still saved if local browser storage is unavailable.
  }
}

export function displayName(
  contact: Pick<Contact, "displayName" | "firstName" | "lastName" | "email" | "privateEmail" | "secondPrivateEmail">
): string {
  return contact.displayName || `${contact.firstName} ${contact.lastName}`.trim() || primaryContactEmail(contact) || "Ohne Namen";
}

export function contactEmails(contact: Pick<Contact, "email" | "privateEmail" | "secondPrivateEmail">): string[] {
  return Array.from(new Set([contact.email, contact.privateEmail, contact.secondPrivateEmail]
    .map((email) => email.trim()).filter(Boolean)));
}

export function primaryContactEmail(contact: Pick<Contact, "email" | "privateEmail" | "secondPrivateEmail">): string {
  return contactEmails(contact)[0] ?? "";
}
