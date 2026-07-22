export type ColorMode = "light" | "dark";
export type AccentTheme = "pink" | "green";

export interface ThemePreferences {
  colorMode: ColorMode;
  accent: AccentTheme;
}

const colorModeStorageKey = "agendakontakte.theme.colorMode";
const accentStorageKey = "agendakontakte.theme.accent";

export function getThemePreferences(): ThemePreferences {
  const savedColorMode = localStorage.getItem(colorModeStorageKey);
  const savedAccent = localStorage.getItem(accentStorageKey);
  return {
    colorMode: savedColorMode === "dark" ? "dark" : "light",
    accent: savedAccent === "green" ? "green" : "pink"
  };
}

export function applyTheme(preferences: ThemePreferences): void {
  document.documentElement.dataset.colorMode = preferences.colorMode;
  document.documentElement.dataset.accent = preferences.accent;
}

export function saveThemePreferences(preferences: ThemePreferences): void {
  localStorage.setItem(colorModeStorageKey, preferences.colorMode);
  localStorage.setItem(accentStorageKey, preferences.accent);
  applyTheme(preferences);
}

export function initializeTheme(): void {
  applyTheme(getThemePreferences());
}
