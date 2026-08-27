import { Download, Upload } from "lucide-react";
import type { Page } from "./Sidebar";

const items: Array<{ page: "import" | "export"; label: string; icon: typeof Upload }> = [
  { page: "import", label: "Importieren", icon: Upload },
  { page: "export", label: "Exportieren", icon: Download }
];

interface AdvancedSubtabsProps {
  activePage: "import" | "export";
  onNavigate: (page: Page) => void;
}

export function AdvancedSubtabs({ activePage, onNavigate }: AdvancedSubtabsProps) {
  return (
    <nav className="advanced-subtabs" aria-label="Unterseiten von Advanced">
      {items.map((item) => {
        const Icon = item.icon;
        return (
          <button
            className={activePage === item.page ? "advanced-subtab active" : "advanced-subtab"}
            key={item.page}
            onClick={() => onNavigate(item.page)}
            type="button"
          >
            <Icon size={18} />
            <span>{item.label}</span>
          </button>
        );
      })}
    </nav>
  );
}
