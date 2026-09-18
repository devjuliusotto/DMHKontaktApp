import type { Contact, ContactInput } from "../types/contact";

export const collectedAddressesHiddenSettingKey = "collected_addresses_hidden";
export const collectedAddressesDeletedAtSettingKey = "collected_addresses_deleted_at";

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
