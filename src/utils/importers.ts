import Papa from "papaparse";
import * as XLSX from "xlsx";
import type { ContactInput } from "../types/contact";
import { emptyContact } from "./contact";

export interface PreviewContact extends ContactInput {
  selected: boolean;
}

export type ImportField = keyof Omit<ContactInput, "id" | "groupIds">;

export type ImportMapping = Partial<Record<ImportField, string>>;

export interface ImportPreview {
  headers: string[];
  mapping: ImportMapping;
  rows: Record<string, unknown>[];
  contacts: PreviewContact[];
  logs: string[];
  emailColumnMissing: boolean;
}

const aliases: Record<ImportField, string[]> = {
  firstName: ["vorname", "first name", "firstname", "given name"],
  lastName: ["nachname", "last name", "lastname", "surname", "family name"],
  displayName: ["anzeigename", "display name", "name", "voller name", "full name"],
  email: [
    "e-mail-adresse",
    "e-mail-adresse 1",
    "e-mail-adresse 2",
    "e-mail-adresse 3",
    "e-mail 1",
    "e-mail 2",
    "e-mail 3",
    "e-mail",
    "e-mail-adresse geschaeftlich",
    "e-mail-adresse geschäftlich",
    "primaer email adresse",
    "primar email adresse",
    "primär email adresse",
    "primaere email adresse",
    "primäre email adresse",
    "primaer e-mail adresse",
    "primar e-mail adresse",
    "primär e-mail adresse",
    "primaere e-mail-adresse",
    "primäre e-mail-adresse",
    "primary email address",
    "email",
    "e-mail",
    "e-mail address",
    "email address",
    "mail",
    "e mail",
    "emailaddress"
  ],
  phone: [
    "telefon",
    "telefon geschaeftlich",
    "telefon geschäftlich",
    "telefon privat",
    "phone",
    "business phone",
    "home phone",
    "festnetz"
  ],
  mobilePhone: ["mobiltelefon", "mobile", "mobile phone", "handy", "mobil", "cell phone", "cellular"],
  street: ["straße", "strasse", "straße geschaeftlich", "straße geschäftlich", "straße privat", "street", "business street", "home street"],
  postalCode: ["plz", "plz geschaeftlich", "plz geschäftlich", "plz privat", "postal code", "zip", "postleitzahl", "business postal code"],
  city: ["stadt", "ort", "ort geschaeftlich", "ort geschäftlich", "ort privat", "city", "business city", "home city"],
  country: ["land", "land/region", "country", "country/region", "business country/region"],
  notes: ["notizen", "notes", "bemerkungen"]
};

const importFields = Object.keys(aliases) as ImportField[];

export const mappingFields: Array<{ field: ImportField; label: string }> = [
  { field: "firstName", label: "Vorname" },
  { field: "lastName", label: "Nachname" },
  { field: "email", label: "E-Mail" },
  { field: "phone", label: "Telefon" },
  { field: "mobilePhone", label: "Mobiltelefon" }
];

const normalize = (value: string) =>
  value
    .replace(/^\uFEFF/, "")
    .trim()
    .replace(/[‐‑‒–—―]/g, "-")
    .replace(/\s+/g, " ")
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/ß/g, "ss");

const emailPattern = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function valueLooksLikeEmail(value: unknown): boolean {
  return String(value ?? "")
    .split(/[;,]/)
    .map((part) => part.trim())
    .some((part) => emailPattern.test(part));
}

function findEmailColumn(headers: string[], rows: Record<string, unknown>[]): string | undefined {
  const headerMap = new Map(headers.map((header) => [normalize(header), header]));
  const explicit = aliases.email.map(normalize).map((key) => headerMap.get(key)).find(Boolean);
  if (explicit) return explicit;

  const byHeader = headers.find((header) => {
    const key = normalize(header).replace(/[^a-z0-9]/g, "");
    return key.includes("email") || key.includes("mail") || key.includes("kontakt") || key.includes("contact");
  });
  if (byHeader && rows.some((row) => valueLooksLikeEmail(row[byHeader]))) return byHeader;

  return headers.find((header) => rows.some((row) => valueLooksLikeEmail(row[header])));
}

function detectMapping(headers: string[], rows: Record<string, unknown>[]): ImportMapping {
  const headerMap = new Map(headers.map((header) => [normalize(header), header]));
  const mapping: ImportMapping = {};

  for (const field of importFields) {
    if (field === "email") continue;
    const header = aliases[field].map(normalize).map((key) => headerMap.get(key)).find(Boolean);
    if (header) {
      mapping[field] = header;
    }
  }

  mapping.email = findEmailColumn(headers, rows);

  return mapping;
}

export function mapRows(rows: Record<string, unknown>[], mapping: ImportMapping): PreviewContact[] {
  return rows
    .map((row) => {
      const contact: ContactInput = { ...emptyContact, groupIds: [] };
      for (const field of importFields) {
        const header = mapping[field];
        if (header) {
          contact[field] = String(row[header] ?? "").trim();
        }
      }

      if (!contact.displayName) {
        contact.displayName = `${contact.firstName} ${contact.lastName}`.trim();
      }

      return { ...contact, selected: Boolean(contact.displayName || contact.email || contact.phone || contact.mobilePhone) };
    })
    .filter((contact) => contact.selected);
}

function createLogs(mapping: ImportMapping, contacts: PreviewContact[]): string[] {
  const withEmail = contacts.filter((contact) => Boolean(contact.email.trim())).length;
  return [
    mapping.email ? `E-Mail-Spalte erkannt: ${mapping.email}` : "Keine E-Mail-Spalte gefunden",
    `${withEmail} Kontakte mit E-Mail erkannt`,
    `${contacts.length - withEmail} Kontakte ohne E-Mail erkannt`
  ];
}

function createPreview(rows: Record<string, unknown>[]): ImportPreview {
  const headers = Object.keys(rows[0] ?? {}).map((header) => header.replace(/^\uFEFF/, "").trim());
  const normalizedRows = rows.map((row) => {
    const normalizedRow: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(row)) {
      normalizedRow[key.replace(/^\uFEFF/, "").trim()] = value;
    }
    return normalizedRow;
  });
  const mapping = detectMapping(headers, normalizedRows);
  const contacts = mapRows(normalizedRows, mapping);

  return {
    headers,
    mapping,
    rows: normalizedRows,
    contacts,
    logs: createLogs(mapping, contacts),
    emailColumnMissing: !mapping.email
  };
}

export function updatePreviewMapping(preview: ImportPreview, mapping: ImportMapping): ImportPreview {
  const contacts = mapRows(preview.rows, mapping);
  return {
    ...preview,
    mapping,
    contacts,
    logs: createLogs(mapping, contacts),
    emailColumnMissing: !mapping.email
  };
}

function decodeText(bytes: Uint8Array): string {
  if (bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf) {
    return new TextDecoder("utf-8").decode(bytes.subarray(3));
  }
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    return new TextDecoder("windows-1252").decode(bytes);
  }
}

export function parseCsvBytes(bytes: Uint8Array): ImportPreview {
  return parseCsv(decodeText(bytes));
}

export function parseCsv(text: string): ImportPreview {
  const cleanText = text.replace(/^\uFEFF/, "");
  const result = Papa.parse<Record<string, unknown>>(cleanText, {
    header: true,
    skipEmptyLines: true,
    delimitersToGuess: [",", ";", "\t", "|"]
  });
  const headers = result.meta.fields ?? [];
  const likelyWrongDelimiter = headers.length === 1 && /[;,]/.test(headers[0] ?? "");
  const fallback = result.data.length && !likelyWrongDelimiter ? result.data : Papa.parse<Record<string, unknown>>(cleanText, {
    header: true,
    skipEmptyLines: true,
    delimiter: cleanText.includes(";") ? ";" : ","
  }).data;
  return createPreview(fallback);
}

export function parseXlsx(bytes: Uint8Array): ImportPreview {
  const workbook = XLSX.read(bytes, { type: "array" });
  const firstSheetName = workbook.SheetNames[0];
  if (!firstSheetName) return createPreview([]);
  const rows = XLSX.utils.sheet_to_json<Record<string, unknown>>(workbook.Sheets[firstSheetName], { defval: "" });
  return createPreview(rows);
}
