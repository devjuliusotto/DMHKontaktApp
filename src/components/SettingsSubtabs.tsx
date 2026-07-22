import { Download, Palette, Settings, SlidersHorizontal, Trash2 } from "lucide-react";
import type { Page } from "./Sidebar";

const items: Array<{ page: Page; label: string; icon: typeof Settings; activePages?: Page[] }> = [
  { page: "settings", label: "Allgemein", icon: Settings },
  { page: "appearance", label: "Erscheinungsbild", icon: Palette },
  { page: "simple-import", label: "Einfach importieren", icon: Download },
  { page: "import", label: "Advanced", icon: SlidersHorizontal, activePages: ["import", "export"] },
  { page: "trash", label: "Papierkorb", icon: Trash2 }
];

interface SettingsSubtabsProps {
  activePage: Page;
  onNavigate: (page: Page) => void;
}

export function SettingsSubtabs({ activePage, onNavigate }: SettingsSubtabsProps) {
  return (
    <nav className="settings-subtabs" aria-label="Unterseiten der Einstellungen">
      {items.map((item) => {
        const Icon = item.icon;
        const active = item.activePages?.includes(activePage) ?? activePage === item.page;
        return (
          <button
            className={active ? "settings-subtab active" : "settings-subtab"}
            key={item.page}
            onClick={() => onNavigate(item.page)}
            type="button"
          >
            <Icon size={19} />
            <span>{item.label}</span>
          </button>
        );
      })}
    </nav>
  );
}
