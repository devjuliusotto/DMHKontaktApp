import { AlertCircle, CheckCircle2, Info, X } from "lucide-react";

export type ActionResultTone = "success" | "info" | "error";

export interface ActionResult {
  title: string;
  summary: string;
  details?: string[];
  /** Affected entries for batch actions. Kept behind a disclosure so the result stays easy to read. */
  items?: Array<{ label: string; detail?: string }>;
  itemsLabel?: string;
  tone?: ActionResultTone;
}

interface ActionResultDialogProps {
  result: ActionResult | null;
  onClose: () => void;
}

export function ActionResultDialog({ result, onClose }: ActionResultDialogProps) {
  if (!result) return null;

  const tone = result.tone ?? "info";
  const Icon = tone === "success" ? CheckCircle2 : tone === "error" ? AlertCircle : Info;

  return (
    <div className="modal-backdrop" role="dialog" aria-modal="true" aria-labelledby="action-result-title">
      <section className={`form-panel modal-card action-result-dialog ${tone}`}>
        <div className="action-result-heading">
          <span className="action-result-icon" aria-hidden="true"><Icon size={28} /></span>
          <div>
            <p className="action-result-kicker">Ergebnis</p>
            <h3 id="action-result-title">{result.title}</h3>
          </div>
          <button className="icon-only" type="button" aria-label="Schließen" onClick={onClose} autoFocus>
            <X size={22} />
          </button>
        </div>

        <p className="action-result-summary">{result.summary}</p>
        {result.details && result.details.length > 0 && (
          <ul className="action-result-details">
            {result.details.map((detail, index) => <li key={`${detail}-${index}`}>{detail}</li>)}
          </ul>
        )}
        {result.items && result.items.length > 0 && (
          <details className="action-result-items">
            <summary>{result.itemsLabel ?? `${result.items.length} betroffene Einträge anzeigen`}</summary>
            <ul>
              {result.items.map((item, index) => (
                <li key={`${item.label}-${index}`}>
                  <strong>{item.label}</strong>
                  {item.detail && <span>{item.detail}</span>}
                </li>
              ))}
            </ul>
          </details>
        )}
        <div className="button-row action-result-actions">
          <button className="primary" type="button" onClick={onClose}>Verstanden</button>
        </div>
      </section>
    </div>
  );
}
