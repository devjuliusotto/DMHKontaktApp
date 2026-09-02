import { CalendarDays, Sparkles, Upload, UsersRound } from "lucide-react";

interface EmptyImportStateProps {
  kind: "contacts" | "calendar";
  onEasyImport: () => void;
  onManualImport: () => void;
}

export function EmptyImportState({ kind, onEasyImport, onManualImport }: EmptyImportStateProps) {
  const contacts = kind === "contacts";
  const MainIcon = contacts ? UsersRound : CalendarDays;

  return (
    <section className="first-import" aria-labelledby={`${kind}-first-import-title`}>
      <div className="first-import-heading">
        <span className="first-import-icon"><MainIcon size={30} aria-hidden="true" /></span>
        <div>
          <h3 id={`${kind}-first-import-title`}>{contacts ? "Noch keine Kontakte" : "Noch keine Termine"}</h3>
          <p>{contacts ? "Wie möchten Sie Ihre Kontakte übernehmen?" : "Wie möchten Sie Ihre Termine übernehmen?"}</p>
        </div>
      </div>
      <div className="first-import-options">
        <button className="first-import-option recommended" type="button" onClick={onEasyImport}>
          <span className="first-import-option-icon"><Sparkles size={26} aria-hidden="true" /></span>
          <span><strong>Einfach importieren</strong><small>Outlook Classic und Thunderbird automatisch durchsuchen.</small></span>
        </button>
        <button className="first-import-option" type="button" onClick={onManualImport}>
          <span className="first-import-option-icon"><Upload size={26} aria-hidden="true" /></span>
          <span>
            <strong>Manuell importieren</strong>
            <small>{contacts ? "Kontakte aus einer CSV- oder Excel-Datei auswählen." : "Termine aus ICS, EML, PST oder OST auswählen."}</small>
          </span>
        </button>
      </div>
    </section>
  );
}
