import { Download, Settings, Trash2, Upload } from "lucide-react";
import type { Page } from "./Sidebar";

const items: Array<{ page: Page; label: string; icon: typeof Settings }> = [
  { page: "settings", label: "Einstellungen", icon: Settings },
  { page: "import", label: "Importieren", icon: Upload },
  { page: "export", label: "Exportieren", icon: Download },
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
        return (
          <button
            className={activePage === item.page ? "settings-subtab active" : "settings-subtab"}
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
