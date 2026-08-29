import { FlaskConical } from "lucide-react";
import type { Page } from "./Sidebar";

type AdvancedPage = "feature-development";

const items: Array<{ page: AdvancedPage; label: string; icon: typeof FlaskConical; development?: boolean }> = [
  { page: "feature-development", label: "In Entwicklung · nicht aktiv", icon: FlaskConical, development: true }
];

interface AdvancedSubtabsProps {
  activePage: AdvancedPage;
  onNavigate: (page: Page) => void;
}

export function AdvancedSubtabs({ activePage, onNavigate }: AdvancedSubtabsProps) {
  return (
    <nav className="advanced-subtabs" aria-label="Unterseiten von Advanced">
      {items.map((item) => {
        const Icon = item.icon;
        return (
          <button
            className={`${activePage === item.page ? "advanced-subtab active" : "advanced-subtab"}${item.development ? " advanced-subtab-development" : ""}`}
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
