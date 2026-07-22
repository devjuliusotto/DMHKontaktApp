import { Check, Moon, Palette, Sun } from "lucide-react";
import { useState } from "react";
import { getThemePreferences, saveThemePreferences, type AccentTheme, type ColorMode, type ThemePreferences } from "../utils/theme";

export function AppearanceSettings() {
  const [preferences, setPreferences] = useState<ThemePreferences>(getThemePreferences);

  const updatePreference = (changes: Partial<ThemePreferences>) => {
    const next = { ...preferences, ...changes };
    setPreferences(next);
    saveThemePreferences(next);
  };

  const modeOption = (mode: ColorMode, label: string, description: string) => {
    const Icon = mode === "light" ? Sun : Moon;
    return (
      <button
        className={preferences.colorMode === mode ? "appearance-option selected" : "appearance-option"}
        onClick={() => updatePreference({ colorMode: mode })}
        type="button"
      >
        <Icon size={24} />
        <span><strong>{label}</strong><small>{description}</small></span>
        {preferences.colorMode === mode && <Check className="appearance-check" size={20} />}
      </button>
    );
  };

  const accentOption = (accent: AccentTheme, label: string, colors: string[]) => (
    <button
      className={preferences.accent === accent ? "appearance-option selected" : "appearance-option"}
      onClick={() => updatePreference({ accent })}
      type="button"
    >
      <span className="appearance-palette" aria-hidden="true">
        {colors.map((color) => <i style={{ backgroundColor: color }} key={color} />)}
      </span>
      <span><strong>{label}</strong><small>{accent === "pink" ? "Aktuelle DMH-Farbgebung" : "Grün nach der ausgewählten Farbpalette"}</small></span>
      {preferences.accent === accent && <Check className="appearance-check" size={20} />}
    </button>
  );

  return (
    <section className="form-panel appearance-settings">
      <div className="settings-task-heading">
        <Palette size={25} aria-hidden="true" />
        <div>
          <h3>Erscheinungsbild</h3>
          <p>Helligkeit und Hauptfarbe der App auswählen.</p>
        </div>
      </div>
      <div className="appearance-setting-group">
        <h4>Darstellung</h4>
        <div className="appearance-options">
          {modeOption("light", "Heller Modus", "Helle Flächen und dunkle Schrift")}
          {modeOption("dark", "Dunkler Modus", "Dunkle Flächen und helle Schrift")}
        </div>
      </div>
      <div className="appearance-setting-group">
        <h4>Akzentfarbe</h4>
        <div className="appearance-options">
          {accentOption("pink", "Rosa", ["#aa074f", "#d89ab5", "#f4d6e0"])}
          {accentOption("green", "Grün", ["#7fa552", "#a9c28c", "#d0dec0"])}
        </div>
      </div>
    </section>
  );
}
