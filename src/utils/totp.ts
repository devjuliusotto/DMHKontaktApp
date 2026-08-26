export type TotpAlgorithm = "SHA1" | "SHA256" | "SHA512";

export interface TotpConfig {
  secret: string;
  issuer?: string;
  account?: string;
  algorithm: TotpAlgorithm;
  digits: number;
  period: number;
}

export interface ImportedTotp extends TotpConfig {
  issuer?: string;
  account?: string;
}

export function parseTotpInput(value: string): TotpConfig {
  const input = value.trim();
  if (!input) throw new Error("Bitte geben Sie einen geheimen Schlüssel ein.");

  if (input.toLowerCase().startsWith("otpauth://")) {
    const uri = new URL(input);
    if (uri.hostname.toLowerCase() !== "totp") {
      throw new Error("Nur TOTP-QR-Codes werden unterstützt.");
    }
    const params = uri.searchParams;
    const algorithm = (params.get("algorithm") ?? "SHA1").toUpperCase();
    if (algorithm !== "SHA1" && algorithm !== "SHA256" && algorithm !== "SHA512") {
      throw new Error("Dieser TOTP-Algorithmus wird nicht unterstützt.");
    }
    const digits = Number(params.get("digits") ?? "6");
    const period = Number(params.get("period") ?? "30");
    if (![6, 8].includes(digits) || !Number.isInteger(period) || period < 10 || period > 120) {
      throw new Error("Die TOTP-Einstellungen des QR-Codes sind ungültig.");
    }
    const secret = normalizeSecret(params.get("secret") ?? "");
    base32Decode(secret);
    const label = decodeURIComponent(uri.pathname.replace(/^\//, ""));
    const labelParts = label.split(":");
    return {
      secret,
      issuer: params.get("issuer") ?? (labelParts.length > 1 ? labelParts[0] : undefined),
      account: labelParts.length > 1 ? labelParts.slice(1).join(":") : label || undefined,
      algorithm,
      digits,
      period
    };
  }

  const secret = normalizeSecret(input);
  base32Decode(secret);
  return {
    secret,
    algorithm: "SHA1",
    digits: 6,
    period: 30
  };
}

export function parseAuthenticatorImport(value: string): ImportedTotp[] {
  const uris = value.match(/otpauth(?:-migration)?:\/\/[^\s"'<>]+/gi) ?? [];
  const imported: ImportedTotp[] = [];
  for (const uri of uris) {
    if (uri.toLowerCase().startsWith("otpauth-migration://")) {
      imported.push(...parseGoogleMigration(uri));
      continue;
    }
    const parsed = parseTotpInput(uri);
    imported.push(parsed);
  }
  if (imported.length === 0) {
    throw new Error("Keine unterstützte 2FA-Exportadresse gefunden. Fügen Sie eine otpauth://-Adresse oder einen Google-Export ein.");
  }
  return imported;
}

export async function generateTotpCode(config: TotpConfig, timestamp = Date.now()): Promise<string> {
  const secret = base32Decode(config.secret);
  const secretBuffer = new ArrayBuffer(secret.length);
  new Uint8Array(secretBuffer).set(secret);
  const counter = Math.floor(timestamp / 1000 / config.period);
  const counterBytes = new ArrayBuffer(8);
  new DataView(counterBytes).setUint32(0, Math.floor(counter / 0x100000000));
  new DataView(counterBytes).setUint32(4, counter >>> 0);
  const key = await crypto.subtle.importKey(
    "raw",
    secretBuffer,
    { name: "HMAC", hash: `SHA-${config.algorithm.slice(3)}` },
    false,
    ["sign"]
  );
  const digest = new Uint8Array(await crypto.subtle.sign("HMAC", key, counterBytes));
  const offset = digest[digest.length - 1] & 0x0f;
  const binary = ((digest[offset] & 0x7f) << 24)
    | ((digest[offset + 1] & 0xff) << 16)
    | ((digest[offset + 2] & 0xff) << 8)
    | (digest[offset + 3] & 0xff);
  return String(binary % (10 ** config.digits)).padStart(config.digits, "0");
}

export function normalizeSecret(value: string): string {
  return value.replace(/[\s-]/g, "").toUpperCase();
}

function base32Decode(value: string): Uint8Array {
  const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
  const normalized = normalizeSecret(value).replace(/=+$/, "");
  if (!normalized || /[^A-Z2-7]/.test(normalized)) {
    throw new Error("Der geheime Schlüssel muss ein gültiger Base32-Schlüssel sein.");
  }
  const bytes: number[] = [];
  let buffer = 0;
  let bits = 0;
  for (const character of normalized) {
    buffer = (buffer << 5) | alphabet.indexOf(character);
    bits += 5;
    if (bits >= 8) {
      bits -= 8;
      bytes.push((buffer >> bits) & 0xff);
    }
  }
  return new Uint8Array(bytes);
}

function parseGoogleMigration(uri: string): ImportedTotp[] {
  const data = new URL(uri).searchParams.get("data");
  if (!data) throw new Error("Der Google-Authenticator-Export enthält keine Daten.");
  const payload = decodeBase64Url(data);
  const accounts: ImportedTotp[] = [];
  let offset = 0;
  while (offset < payload.length) {
    const field = readField(payload, offset);
    offset = field.offset;
    if (field.number === 1 && field.wireType === 2) {
      const nested = payload.slice(field.valueOffset, field.valueOffset + field.length);
      const account = parseGoogleOtpParameters(nested);
      if (account && account.type !== 1) accounts.push(account.value);
      offset = field.valueOffset + field.length;
    } else {
      offset = field.nextOffset;
    }
  }
  if (accounts.length === 0) throw new Error("Der Google-Export enthält keine TOTP-Konten.");
  return accounts;
}

function parseGoogleOtpParameters(bytes: Uint8Array): { value: ImportedTotp; type: number } | null {
  let offset = 0;
  let secret = new Uint8Array();
  let name = "";
  let issuer = "";
  let algorithm = "SHA1" as TotpAlgorithm;
  let digits = 6;
  let type = 0;
  while (offset < bytes.length) {
    const field = readField(bytes, offset);
    offset = field.nextOffset;
    if (field.number === 1 && field.wireType === 2) secret = bytes.slice(field.valueOffset, field.valueOffset + field.length);
    else if (field.number === 2 && field.wireType === 2) name = new TextDecoder().decode(bytes.slice(field.valueOffset, field.valueOffset + field.length));
    else if (field.number === 3 && field.wireType === 2) issuer = new TextDecoder().decode(bytes.slice(field.valueOffset, field.valueOffset + field.length));
    else if (field.number === 4 && field.wireType === 0) algorithm = ({ 2: "SHA256", 3: "SHA512" } as Record<number, TotpAlgorithm>)[field.varint ?? 1] ?? "SHA1";
    else if (field.number === 5 && field.wireType === 0) digits = field.varint === 2 ? 8 : 6;
    else if (field.number === 6 && field.wireType === 0) type = field.varint ?? 0;
  }
  if (secret.length === 0) return null;
  return {
    type,
    value: {
      secret: bytesToBase32(secret),
      issuer: issuer || undefined,
      account: name || undefined,
      algorithm,
      digits,
      period: 30
    }
  };
}

function readField(bytes: Uint8Array, start: number) {
  const key = readVarint(bytes, start);
  const number = key.value >>> 3;
  const wireType = key.value & 7;
  if (wireType === 0) {
    const value = readVarint(bytes, key.offset);
    return { number, wireType, varint: value.value, offset: value.offset, nextOffset: value.offset, valueOffset: value.offset, length: 0 };
  }
  if (wireType === 2) {
    const length = readVarint(bytes, key.offset);
    return { number, wireType, offset: key.offset, nextOffset: length.offset + length.value, valueOffset: length.offset, length: length.value };
  }
  throw new Error("Der 2FA-Export enthält ein unbekanntes Datenformat.");
}

function readVarint(bytes: Uint8Array, start: number): { value: number; offset: number } {
  let value = 0;
  let shift = 0;
  let offset = start;
  while (offset < bytes.length && shift < 35) {
    const byte = bytes[offset++];
    value += (byte & 0x7f) * (2 ** shift);
    if ((byte & 0x80) === 0) return { value, offset };
    shift += 7;
  }
  throw new Error("Der 2FA-Export ist beschädigt.");
}

function decodeBase64Url(value: string): Uint8Array {
  const normalized = value.replace(/-/g, "+").replace(/_/g, "/").padEnd(Math.ceil(value.length / 4) * 4, "=");
  const binary = atob(normalized);
  return Uint8Array.from(binary, (character) => character.charCodeAt(0));
}

function bytesToBase32(bytes: Uint8Array): string {
  const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
  let result = "";
  let buffer = 0;
  let bits = 0;
  for (const byte of bytes) {
    buffer = (buffer << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      bits -= 5;
      result += alphabet[(buffer >> bits) & 31];
    }
  }
  if (bits > 0) result += alphabet[(buffer << (5 - bits)) & 31];
  return result;
}
