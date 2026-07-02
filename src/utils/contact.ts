import type { Contact, ContactInput } from "../types/contact";

export const emptyContact: ContactInput = {
  firstName: "",
  lastName: "",
  displayName: "",
  email: "",
  phone: "",
  mobilePhone: "",
  street: "",
  postalCode: "",
  city: "",
  country: "Deutschland",
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
    phone: contact.phone,
    mobilePhone: contact.mobilePhone,
    street: contact.street,
    postalCode: contact.postalCode,
    city: contact.city,
    country: contact.country,
    notes: contact.notes,
    groupIds: contact.groups.map((group) => group.id).filter((id): id is number => Boolean(id))
  };
}

export function displayName(contact: Pick<Contact, "displayName" | "firstName" | "lastName" | "email">): string {
  return contact.displayName || `${contact.firstName} ${contact.lastName}`.trim() || contact.email || "Ohne Namen";
}
