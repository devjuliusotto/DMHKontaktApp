const accountsStorageKey = "dmh_local_accounts_v1";
const rememberedSessionStorageKey = "dmh_remembered_session_v1";
const windowSessionStorageKey = "dmh_window_session_v1";
const rememberedSessionDurationMs = 7 * 24 * 60 * 60 * 1_000;
const passwordDerivationIterations = 210_000;

interface StoredAccount {
  email: string;
  passwordHash: string;
  salt: string;
  createdAt: string;
}

interface StoredSession {
  email: string;
  expiresAt: number | null;
}

export interface LocalAccountSession {
  email: string;
  rememberedUntil: number | null;
}

function normalizeEmail(email: string) {
  return email.trim().toLocaleLowerCase("de-DE");
}

function readAccounts(): StoredAccount[] {
  try {
    const value: unknown = JSON.parse(localStorage.getItem(accountsStorageKey) ?? "[]");
    if (!Array.isArray(value)) return [];
    return value.filter((account): account is StoredAccount => (
      typeof account === "object"
      && account !== null
      && typeof account.email === "string"
      && typeof account.passwordHash === "string"
      && typeof account.salt === "string"
      && typeof account.createdAt === "string"
    ));
  } catch {
    return [];
  }
}

function bytesToBase64(bytes: Uint8Array) {
  return btoa(Array.from(bytes, (byte) => String.fromCharCode(byte)).join(""));
}

function base64ToBytes(value: string) {
  const decoded = atob(value);
  return Uint8Array.from(decoded, (character) => character.charCodeAt(0));
}

async function derivePasswordHash(password: string, salt: Uint8Array) {
  const saltBuffer = new Uint8Array(salt).buffer;
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(password),
    "PBKDF2",
    false,
    ["deriveBits"]
  );
  const bits = await crypto.subtle.deriveBits(
    { name: "PBKDF2", hash: "SHA-256", salt: saltBuffer, iterations: passwordDerivationIterations },
    key,
    256
  );
  return bytesToBase64(new Uint8Array(bits));
}

function hashesMatch(left: string, right: string) {
  if (left.length !== right.length) return false;
  let difference = 0;
  for (let index = 0; index < left.length; index += 1) {
    difference |= left.charCodeAt(index) ^ right.charCodeAt(index);
  }
  return difference === 0;
}

function storeSession(email: string, rememberForOneWeek: boolean): LocalAccountSession {
  const normalizedEmail = normalizeEmail(email);
  if (rememberForOneWeek) {
    const expiresAt = Date.now() + rememberedSessionDurationMs;
    localStorage.setItem(rememberedSessionStorageKey, JSON.stringify({ email: normalizedEmail, expiresAt } satisfies StoredSession));
    sessionStorage.removeItem(windowSessionStorageKey);
    return { email: normalizedEmail, rememberedUntil: expiresAt };
  }

  localStorage.removeItem(rememberedSessionStorageKey);
  sessionStorage.setItem(windowSessionStorageKey, JSON.stringify({ email: normalizedEmail, expiresAt: null } satisfies StoredSession));
  return { email: normalizedEmail, rememberedUntil: null };
}

function readSession(storage: Storage, key: string): LocalAccountSession | null {
  try {
    const value = JSON.parse(storage.getItem(key) ?? "null") as Partial<StoredSession> | null;
    if (!value || typeof value.email !== "string") return null;
    if (value.expiresAt !== null && typeof value.expiresAt !== "number") return null;
    if (typeof value.expiresAt === "number" && value.expiresAt <= Date.now()) {
      storage.removeItem(key);
      return null;
    }
    const email = normalizeEmail(value.email);
    if (!readAccounts().some((account) => account.email === email)) {
      storage.removeItem(key);
      return null;
    }
    return { email, rememberedUntil: value.expiresAt ?? null };
  } catch {
    storage.removeItem(key);
    return null;
  }
}

export function localAccountExists(email: string) {
  const normalizedEmail = normalizeEmail(email);
  return readAccounts().some((account) => account.email === normalizedEmail);
}

export function readActiveLocalSession(): LocalAccountSession | null {
  return readSession(sessionStorage, windowSessionStorageKey)
    ?? readSession(localStorage, rememberedSessionStorageKey);
}

export async function createLocalAccount(email: string, password: string, rememberForOneWeek: boolean) {
  const normalizedEmail = normalizeEmail(email);
  const accounts = readAccounts();
  if (accounts.some((account) => account.email === normalizedEmail)) {
    throw new Error("Für diese E-Mail-Adresse besteht bereits ein Konto.");
  }

  const salt = crypto.getRandomValues(new Uint8Array(16));
  const passwordHash = await derivePasswordHash(password, salt);
  accounts.push({
    email: normalizedEmail,
    passwordHash,
    salt: bytesToBase64(salt),
    createdAt: new Date().toISOString()
  });
  localStorage.setItem(accountsStorageKey, JSON.stringify(accounts));
  return storeSession(normalizedEmail, rememberForOneWeek);
}

export async function signInToLocalAccount(email: string, password: string, rememberForOneWeek: boolean) {
  const normalizedEmail = normalizeEmail(email);
  const account = readAccounts().find((candidate) => candidate.email === normalizedEmail);
  if (!account) throw new Error("Zu dieser E-Mail-Adresse wurde kein Konto gefunden.");

  const passwordHash = await derivePasswordHash(password, base64ToBytes(account.salt));
  if (!hashesMatch(account.passwordHash, passwordHash)) {
    throw new Error("Das Kennwort ist nicht richtig. Bitte versuchen Sie es erneut.");
  }
  return storeSession(normalizedEmail, rememberForOneWeek);
}

export async function resetLocalAccountPassword(email: string, password: string, rememberForOneWeek: boolean) {
  const normalizedEmail = normalizeEmail(email);
  const accounts = readAccounts();
  const accountIndex = accounts.findIndex((account) => account.email === normalizedEmail);
  if (accountIndex < 0) {
    throw new Error("Zu dieser E-Mail-Adresse wurde kein Konto gefunden.");
  }
  if (password.length < 8) {
    throw new Error("Das Kennwort muss mindestens 8 Zeichen lang sein.");
  }

  const salt = crypto.getRandomValues(new Uint8Array(16));
  accounts[accountIndex] = {
    ...accounts[accountIndex],
    passwordHash: await derivePasswordHash(password, salt),
    salt: bytesToBase64(salt)
  };
  localStorage.setItem(accountsStorageKey, JSON.stringify(accounts));
  return storeSession(normalizedEmail, rememberForOneWeek);
}
