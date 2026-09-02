import { ArchiveRestore, Home, Mail, Palette, Printer, Settings, SlidersHorizontal } from "lucide-react";
import type { Page } from "./Sidebar";

export type SettingsSection = "general" | "mail" | "printer" | "appearance" | "import" | "backup" | "sync" | "advanced" | "trash";

const items: Array<{ page: Page; section: SettingsSection; label: string; icon: typeof Settings; activePages?: Page[] }> = [
  { page: "settings", section: "general", label: "Allgemein", icon: Settings },
  { page: "settings", section: "mail", label: "E-Mail & Konten", icon: Mail },
  { page: "settings", section: "printer", label: "Drucker", icon: Printer },
  { page: "appearance", section: "appearance", label: "Erscheinungsbild", icon: Palette },
  { page: "backup", section: "backup", label: "Sicherung", icon: ArchiveRestore },
  { page: "feature-development", section: "advanced", label: "Erweitert", icon: SlidersHorizontal }
];

interface SettingsSubtabsProps {
  activePage: Page;
  activeSection: SettingsSection;
  onNavigate: (page: Page, section?: SettingsSection) => void;
}

export function SettingsSubtabs({ activePage, activeSection, onNavigate }: SettingsSubtabsProps) {
  return (
    <nav className="settings-subtabs" aria-label="Unterseiten der EDV Tools">
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
