export type AppFeature = "authenticator" | "passwords" | "documents";

export interface AppFeatureAvailability {
  authenticator: boolean;
  passwords: boolean;
  documents: boolean;
}

interface StoredFeatureOverrides {
  version: 1;
  overrides: Partial<AppFeatureAvailability>;
}

const storageKey = "dmh-backup-feature-overrides-v1";

export const releaseFeatureDefaults: AppFeatureAvailability = {
  authenticator: false,
  passwords: false,
  documents: false
};

export function canManageDevelopmentFeatures(): boolean {
  return import.meta.env.DEV || import.meta.env.VITE_APP_CHANNEL === "admin-test";
}

function readOverrides(): Partial<AppFeatureAvailability> {
  try {
    const stored = window.localStorage.getItem(storageKey);
    if (!stored) return {};
    const parsed = JSON.parse(stored) as Partial<StoredFeatureOverrides>;
    if (parsed.version !== 1 || typeof parsed.overrides !== "object" || parsed.overrides === null) return {};
    const overrides: Partial<AppFeatureAvailability> = {};
    if (typeof parsed.overrides.authenticator === "boolean") overrides.authenticator = parsed.overrides.authenticator;
    if (typeof parsed.overrides.passwords === "boolean") overrides.passwords = parsed.overrides.passwords;
    if (typeof parsed.overrides.documents === "boolean") overrides.documents = parsed.overrides.documents;
    return overrides;
  } catch {
    return {};
  }
}

export function readFeatureAvailability(): AppFeatureAvailability {
  return { ...releaseFeatureDefaults, ...readOverrides() };
}

export function setFeatureOverride(feature: AppFeature, enabled: boolean): AppFeatureAvailability {
  const overrides = { ...readOverrides(), [feature]: enabled };
  const stored: StoredFeatureOverrides = { version: 1, overrides };
  try {
    window.localStorage.setItem(storageKey, JSON.stringify(stored));
  } catch {
    // The current session can still use the selection when local storage is unavailable.
  }
  return { ...releaseFeatureDefaults, ...overrides };
}

export function clearFeatureOverrides(): AppFeatureAvailability {
  try {
    window.localStorage.removeItem(storageKey);
  } catch {
    // The release defaults still apply to the current session.
  }
  return releaseFeatureDefaults;
}
