import { ArchiveRestore, ArrowLeftRight, ArrowUpDown, Home, Mail, Palette, Settings, SlidersHorizontal, Trash2 } from "lucide-react";
import type { Page } from "./Sidebar";

export type SettingsSection = "general" | "mail" | "appearance" | "import" | "backup" | "sync" | "advanced" | "trash";

const items: Array<{ page: Page; section: SettingsSection; label: string; icon: typeof Settings; activePages?: Page[] }> = [
  { page: "settings", section: "general", label: "Allgemein", icon: Settings },
  { page: "settings", section: "mail", label: "E-Mail & Konten", icon: Mail },
  { page: "appearance", section: "appearance", label: "Erscheinungsbild", icon: Palette },
  { page: "simple-import", section: "import", label: "Import & Export", icon: ArrowUpDown },
  { page: "backup", section: "backup", label: "Sicherung", icon: ArchiveRestore },
  { page: "synchronizations", section: "sync", label: "Synchronisierungen", icon: ArrowLeftRight, activePages: ["synchronizations", "m365"] },
  { page: "feature-development", section: "advanced", label: "Erweitert", icon: SlidersHorizontal },
  { page: "trash", section: "trash", label: "Papierkorb", icon: Trash2 }
];

interface SettingsSubtabsProps {
  activePage: Page;
  activeSection: SettingsSection;
  onNavigate: (page: Page, section?: SettingsSection) => void;
}

export function SettingsSubtabs({ activePage, activeSection, onNavigate }: SettingsSubtabsProps) {
  return (
    <nav className="settings-subtabs" aria-label="Unterseiten der Einstellungen">
      {items.map((item) => {
        const Icon = item.icon;
        const active = item.activePages?.includes(activePage) ?? (activePage === item.page && activeSection === item.section);
        return (
          <button
            className={active ? "settings-subtab active" : "settings-subtab"}
            key={item.page}
            onClick={() => onNavigate(item.page, item.section)}
            type="button"
          >
            <Icon size={19} />
            <span>{item.label}</span>
          </button>
        );
      })}
      <button className="settings-subtab settings-subtab-home" onClick={() => onNavigate("contacts")} type="button">
        <Home size={19} />
        <span>Zur Startseite</span>
      </button>
    </nav>
  );
}
