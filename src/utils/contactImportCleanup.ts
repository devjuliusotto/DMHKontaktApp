import type { ContactInput } from "../types/contact";

const surroundingQuotes = /^[\s"'“”„‚‘’]+|[\s"'“”„‚‘’]+$/g;
const emailCandidate = /[^\s<>"'(),;:]+@[^\s<>"'(),;:]+/;

function extractImportedEmail(...values: string[]): string {
  for (const value of values) {
    const match = value.match(emailCandidate)?.[0]?.replace(/[.,;:!?]+$/, "").trim();
    if (!match) continue;
    const [localPart, domain, ...extra] = match.split("@");
    if (localPart && domain && extra.length === 0) return match;
  }
  return "";
}

function capitalizeNameWords(value: string): string {
  return value.replace(/(^|[\s\-'’])([\p{Ll}])/gu, (_match, separator: string, letter: string) =>
    `${separator}${letter.toLocaleUpperCase("de-DE")}`
  );
}

export function cleanImportedDisplayName(value: string, email: string): string {
  const normalizedEmail = email.trim();
  const emailLocalPart = normalizedEmail.split("@", 1)[0] ?? "";
  let cleaned = value.trim().replace(surroundingQuotes, "").trim();

  const angleAddress = cleaned.match(/^(.*?)\s*<([^<>]+)>\s*$/);
  if (angleAddress?.[2]?.trim().toLocaleLowerCase("de") === normalizedEmail.toLocaleLowerCase("de")) {
    cleaned = angleAddress[1].trim().replace(surroundingQuotes, "").trim();
  }

  const containsAddress = cleaned.includes("@");
  if (containsAddress) cleaned = cleaned.slice(0, cleaned.indexOf("@"));

  if (!cleaned && emailLocalPart) cleaned = emailLocalPart;
  cleaned = cleaned.replace(/[._@]+/g, " ");

  return capitalizeNameWords(cleaned
    .replace(surroundingQuotes, "")
    .replace(/\s+/g, " ")
    .trim());
}

export function cleanImportedContactName(contact: ContactInput): ContactInput {
  const fallbackName = `${contact.firstName.trim()} ${contact.lastName.trim()}`.trim();
  const originalEmail = contact.email.trim();
  const email = extractImportedEmail(originalEmail, contact.displayName, fallbackName);
  const sourceName = contact.displayName.trim() || fallbackName || originalEmail || email;
  return {
    ...contact,
    firstName: capitalizeNameWords(contact.firstName.trim()),
    lastName: capitalizeNameWords(contact.lastName.trim()),
    displayName: cleanImportedDisplayName(sourceName, email || originalEmail),
    email
  };
}
